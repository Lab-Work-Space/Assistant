import { describe, expect, it, vi } from 'vitest';
import { AI_WARROOM_CHANNEL_ID } from '../company/channels.js';
import { isExcludedChannel } from '../company/exclusion.js';
import { route as routeMessage, type RouterCtx } from '../company/router.js';
import type { ActorRef, IncomingMessage } from '../company/types.js';
import { ConfigSchema } from '../config/schema.js';
import type { ConfigKey, ConfigValue } from '../config/schema.js';
import { LIFTED_CAPS, liftsCap } from '../governance/budget.js';
import { Limits } from '../governance/limits.js';
import { FakeConfig } from '../governance/test-helpers.js';
import type { Task } from '../db/repos/tasks.js';
import { FakeProvider, ProviderRegistry, type FakeTurn } from '../providers/index.js';
import { Slots } from '../providers/claude-code-local/index.js';
import { FakeDiscordPort } from '../tests/fakes/discordPort.js';
import { isDirectHumanRun } from '../tools/direct.js';
import { createConversation } from './conversation.js';
import { owned, route as mentionRoute, setup } from './loop/loop-fixture.js';
import { runAgent, type AgentDeps, type AgentOutcome, type AgentTrigger } from './loop/loop.js';
import { STALL_INSTRUCTION } from './scheduler/notices.js';
import { Scheduler } from './scheduler/scheduler.js';
import { MemTasks, humanMsg, newBus, noApprovedTools, prompts, seededOrg } from './test-helpers.js';
import { Meetings, type MeetingHost } from './team/meetings.js';
import { configRisk } from '../admin/keys.js';
import { CONFIG_DEFAULTS } from '../config/defaults.js';
import type { GuardRow, GuardStore } from './team/warroom.js';

const WR = AI_WARROOM_CHANNEL_ID;
const SW_WORK = '1565682159375749161';
const HQ_WORK = '1565652605290414160';
const MOD_ROOM = '1570000000000000555';
const CAT = '1570000000000000100';
const A = (dept: string): ActorRef => ({ kind: 'head', dept } as ActorRef);
const HQ = A('hq');
const CTO = A('software');
const SALES = A('sales');
const LOCAL = 'claude-code-local';
const localDefault = { provider: LOCAL, model: 'claude-sonnet-5-5' };
const deptOf = (a: ActorRef) => (a.kind === 'head' ? a.dept : a.personaId);
const reply = (body = 'ok'): AgentOutcome => ({ payload: { type: 'chat', body }, costUsd: 0, turns: 1 });
const noReply = (): AgentOutcome => reply('NO_REPLY');
let seq = 0;

type Cfg = Partial<{ [K in ConfigKey]: ConfigValue<K> }>;
type Mem = MemTasks;

/** A message from a head, in channel `ch` (a thread when `th` is given, under `parent`). */
const bot = (from: ActorRef, mentioned: string[], where: { ch?: string; th?: string; parent?: string } = {}): IncomingMessage => ({
  id: `m-${++seq}`, channelId: where.th ?? where.ch ?? SW_WORK, parentChannelId: where.th ? where.parent ?? SW_WORK : null, threadId: where.th ?? null,
  author: { id: `bot-${deptOf(from)}`, name: deptOf(from), kind: 'head', actor: from },
  content: `${mentioned.map((d) => `@${d}`).join(' ')} please look`, mentionedHeads: mentioned as never, isAdmin: false, attachments: [], origin: 'chat',
});

async function mk(o: { cfg?: Cfg; run?: (t: AgentTrigger, d: AgentDeps, s: () => Scheduler) => Promise<AgentOutcome>; agent?: Partial<AgentDeps>; conversation?: boolean; guardStore?: GuardStore; categories?: Record<string, string>; org?: Awaited<ReturnType<typeof seededOrg>> } = {}) {
  const cfg = new FakeConfig({ 'warroom.stallTurns': 1000, 'warroom.turnsPerThreadPerHour': 1000, 'warroom.turnsPerHour': 1000, ...o.cfg });
  const tasks = new MemTasks() as Mem;
  const port = new FakeDiscordPort();
  for (const [c, cat] of Object.entries(o.categories ?? {})) port.categories.set(c, cat);
  const bus = newBus();
  const limits = new Limits(cfg, tasks);
  const runs: AgentTrigger[] = [];
  const errors: object[] = [];
  let cur = 0;
  let max = 0;
  let sched!: Scheduler;
  const run = vi.fn(async (t: AgentTrigger, d: AgentDeps) => {
    runs.push(t);
    cur++;
    max = Math.max(max, cur);
    try {
      await new Promise((r) => setImmediate(r));
      return o.run ? await o.run(t, d, () => sched) : reply();
    } finally {
      cur--;
    }
  });
  const org = o.org ?? await seededOrg();
  const conversation = o.conversation ? createConversation({ tasks, port, limits, bus }) : undefined;
  sched = new Scheduler({
    agent: { org, ...(o.agent ?? {}) } as AgentDeps, approvedTools: noApprovedTools, run, port, org, tasks, limits,
    halt: { isHalted: () => false }, cfg, bus, log: { error: (e: object) => void errors.push(e) }, now: () => 5_000_000,
    calendar: { isOffDay: () => ({ off: false }) }, ...(conversation ? { conversation } : {}), ...(o.guardStore ? { guardStore: o.guardStore } : {}),
  });
  sched.attach();
  return { s: sched, port, bus, runs, run, errors, tasks, cfg, org, maxInFlight: () => max };
}
const who = (runs: AgentTrigger[]) => runs.map((r) => deptOf(r.route.actor));

/** A scheduler agent whose heads resolve to the local provider (or to a metered one), for the checks the scheduler makes before the loop. */
function agentOn(providerId: string, cfg: FakeConfig, org: Awaited<ReturnType<typeof seededOrg>>): Partial<AgentDeps> {
  const providers = new ProviderRegistry();
  providers.register(new FakeProvider([], providerId));
  cfg.values.set('provider.default', { provider: providerId, model: 'claude-sonnet-5-5' });
  return { org, prompts, overrides: { getActive: async () => null }, providers, cfg };
}

describe('WS1 the lift is an explicit list, decided per call from the resolved provider', () => {
  const STAY = [
    'limits.localConcurrency', 'limits.concurrency', 'limits.prawConcurrency', 'provider.localTimeoutMs', 'limits.depth', 'limits.childrenPerTask',
    'limits.openTasks', 'limits.humanRunsPer10Min', 'limits.prawPerUser10Min', 'limits.visionPerUserDay', 'limits.voiceMinPerUserDay',
    'limits.remindersPerUser', 'limits.schedulesPerUser', 'limits.watchesPerUser', 'forum.postsPerHeadPerDay', 'warroom.heldMax', 'warroom.stallTurns',
    'budget.companyDailyUsd', 'budget.botDailyUsd', 'budget.taskUsd', 'warroom.dailyUsd', 'warroom.botDailyUsd',
  ];

  it.each([
    [true, LOCAL, true], [true, 'claude', false], [true, 'gemini', false], [true, undefined, false],
    [false, LOCAL, false], [false, 'claude', false],
  ])('table: with limits.localUnlimited=%s and a %s call, every listed cap is lifted=%s and no other cap ever is', (flag, provider, lifted) => {
    const cfg = new FakeConfig({ 'limits.localUnlimited': flag });
    for (const key of LIFTED_CAPS) expect(liftsCap(key, cfg, provider)).toBe(lifted);
    for (const key of STAY) expect(liftsCap(key, cfg, provider)).toBe(false);
    for (const key of Object.keys(ConfigSchema)) if (!(LIFTED_CAPS as readonly string[]).includes(key)) expect(liftsCap(key, cfg, provider)).toBe(false);
  });

  it('the schema keys of the list exist (a renamed cap cannot silently drop out of it)', () => {
    for (const key of LIFTED_CAPS) expect(Object.keys(ConfigSchema)).toContain(key);
  });

  it('limits.turnsPerTask: a local call runs on a task with all its turns used; a metered call, or the flag off, stops', async () => {
    const check = async (provider: string, flag: boolean) => {
      const s = await setup({ provider: new FakeProvider([{ text: 'fine' }], provider) });
      s.cfg.values.set('provider.default', { provider, model: 'claude-sonnet-5-5' });
      s.cfg.values.set('limits.localUnlimited', flag);
      const task = await owned(s.tasks, CTO, { turnsUsed: 20 });
      return runAgent({ route: mentionRoute(CTO), msg: humanMsg('go', { channelId: 'th-1', threadId: 'th-1', parentChannelId: SW_WORK }), task, history: [] }, s.deps);
    };
    expect((await check(LOCAL, true)).stopped).toBeUndefined();
    expect((await check(LOCAL, false)).stopped).toBe('turns');
    expect((await check('claude', true)).stopped).toBe('turns');
  });

  it('warroom.rootTasksPerDay: a bot-origin root task from a local run is not counted against the cap; a metered run still is', async () => {
    const create = { name: 'create_task', input: { title: 'Look at X', description: 'd', estCostUsd: 0.1, assignee: { kind: 'head', dept: 'software' } } };
    const turns: FakeTurn[] = [{ toolUses: [create] }, { text: 'done' }];
    const check = async (provider: string) => {
      const copy = new Map(prompts);
      const d = copy.get('heads/hq')!;
      copy.set('heads/hq', { ...d, meta: { ...d.meta, tools: [...new Set([...d.meta.tools, 'create_task'])] } });
      const s = await setup({ provider: new FakeProvider(turns, provider), prompts: copy });
      s.cfg.values.set('provider.default', { provider, model: 'claude-sonnet-5-5' });
      s.deps.botRoots = { acquire: async () => null }; // the cap is used up
      await runAgent({ route: { actor: HQ, reason: 'warroom' }, msg: bot(CTO, ['hq']), task: null, history: [], pool: 'warroom' }, s.deps);
      return s.tasks.rows.size;
    };
    expect(await check(LOCAL)).toBe(1);
    expect(await check('claude')).toBe(0);
  });

  it('meetings.adHocPerDay: a lifted (local) start is not capped, an ordinary one is; the structure checks stay', async () => {
    const claimed = new Set<string>();
    const host: MeetingHost = {
      canRun: () => true, offDay: () => false, online: () => true, openThread: async () => 'thread-1', post: async () => 'id',
      turn: async () => undefined, openWork: async () => ({ blocked: [], overdue: [] }), spawn: (_w, fn) => void fn(),
    };
    const m = new Meetings({ cfg: new FakeConfig({ 'meetings.adHocPerDay': 1 }), now: () => Date.UTC(2026, 10, 3, 3), claim: async (k) => (claimed.has(k) ? false : (claimed.add(k), true)), heads: () => ['hq', 'software'], log: { error: () => undefined } });
    m.bind(host);
    const req = { topic: 't', agenda: ['x'], invitees: ['software' as const], actor: { kind: 'head', dept: 'hq' } as const };
    expect(await m.start(req)).toMatchObject({ ok: true });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(await m.start(req)).toMatchObject({ ok: false });
    expect(await m.start({ ...req, lifted: true })).toMatchObject({ ok: true });
    expect(m.refusal({ threadId: 'thread-1' }, true)).toBe('a meeting cannot be started from inside a meeting thread');
  });

  it('warroom.turnsPerThreadPerHour / turnsPerHour: skipped when the head resolves to the local provider with the flag on, enforced otherwise', async () => {
    const loopRun = async (trig: AgentTrigger, _d: AgentDeps, s: () => Scheduler) => {
      void s().onMessage(bot(trig.route.actor, [deptOf(trig.route.actor) === 'hq' ? 'software' : 'hq'], { ch: SW_WORK }));
      return reply();
    };
    const cfgFor = (flag: boolean): Cfg => ({ 'warroom.turnsPerThreadPerHour': 3, 'warroom.stallTurns': 12, 'limits.localUnlimited': flag });
    const org = await seededOrg();
    const cfgLocal = new FakeConfig(cfgFor(true));
    const t1 = await mkWith(cfgLocal, loopRun, agentOn(LOCAL, cfgLocal, org), org);
    await t1.s.onMessage(bot(HQ, ['software'], { ch: SW_WORK }));
    for (let i = 0; i < 40; i++) await t1.s.idle();
    expect(t1.runs.filter((r) => r.instruction !== STALL_INSTRUCTION).length).toBe(12);
    const cfgMetered = new FakeConfig(cfgFor(true));
    const t2 = await mkWith(cfgMetered, loopRun, agentOn('claude', cfgMetered, org), org);
    await t2.s.onMessage(bot(HQ, ['software'], { ch: SW_WORK }));
    for (let i = 0; i < 40; i++) await t2.s.idle();
    expect(t2.runs.length).toBe(3);
    const cfgOff = new FakeConfig(cfgFor(false));
    const t3 = await mkWith(cfgOff, loopRun, agentOn(LOCAL, cfgOff, org), org);
    await t3.s.onMessage(bot(HQ, ['software'], { ch: SW_WORK }));
    for (let i = 0; i < 40; i++) await t3.s.idle();
    expect(t3.runs.length).toBe(3);
  });

  it('limits.humanRunsPer10Min still refuses with the flag on (a person flood is not "talk")', async () => {
    const t = await mk({ cfg: { 'limits.localUnlimited': true } });
    for (let i = 0; i < 7; i++) await t.s.onMessage(humanMsg(`<@111> m${i}`, { mentionedHeads: ['software'] }));
    await t.s.idle();
    expect(t.run).toHaveBeenCalledTimes(5);
  });

  it('limits.localConcurrency still holds a third parallel local call back with the flag on (the slot queue does not read the flag)', async () => {
    const slots = new Slots(2, 20);
    const ac = new AbortController();
    expect(await slots.acquire(ac.signal)).toBe(true);
    expect(await slots.acquire(ac.signal)).toBe(true);
    let third = false;
    void slots.acquire(ac.signal).then(() => (third = true));
    await new Promise((r) => setImmediate(r));
    expect(third).toBe(false);
    slots.release();
    await new Promise((r) => setImmediate(r));
    expect(third).toBe(true);
  });
});

/** mk() with a config object the caller also hands to the agent (so the local/metered resolution reads the same values). */
async function mkWith(cfg: FakeConfig, run: NonNullable<Parameters<typeof mk>[0]>['run'], agent: Partial<AgentDeps>, org: Awaited<ReturnType<typeof seededOrg>>) {
  const tasks = new MemTasks() as Mem;
  const port = new FakeDiscordPort();
  const bus = newBus();
  const runs: AgentTrigger[] = [];
  let sched!: Scheduler;
  const runFn = vi.fn(async (t: AgentTrigger, d: AgentDeps) => {
    runs.push(t);
    await new Promise((r) => setImmediate(r));
    return run ? run(t, d, () => sched) : reply();
  });
  sched = new Scheduler({
    agent: agent as AgentDeps, approvedTools: noApprovedTools, run: runFn, port, org, tasks, limits: new Limits(cfg, tasks),
    halt: { isHalted: () => false }, cfg, bus, log: { error: () => undefined }, now: () => 5_000_000, calendar: { isOffDay: () => ({ off: false }) },
  });
  sched.attach();
  return { s: sched, runs, port, tasks };
}

describe('WS2 the TW1/TW2/TW3 guard applies to every route a bot can start, keyed by thread or channel', () => {
  const cycle = (where: { ch?: string; th?: string; parent?: string }) => async (trig: AgentTrigger, _d: AgentDeps, s: () => Scheduler) => {
    const other = deptOf(trig.route.actor) === 'hq' ? 'software' : 'hq';
    void s().onMessage(bot(trig.route.actor, [other], where));
    return reply();
  };

  it('a bot mention loop in a department room stops at stallTurns (one CEO stall turn, then quiet)', async () => {
    const t = await mk({ cfg: { 'warroom.stallTurns': 4 }, run: cycle({ ch: SW_WORK }) });
    await t.s.onMessage(bot(HQ, ['software'], { ch: SW_WORK }));
    for (let i = 0; i < 40; i++) await t.s.idle();
    expect(t.runs.filter((r) => r.instruction !== STALL_INSTRUCTION)).toHaveLength(4);
    expect(t.runs.filter((r) => r.instruction === STALL_INSTRUCTION)).toHaveLength(1);
    expect(t.maxInFlight()).toBe(1);
    expect(t.runs.every((r) => r.pool === 'warroom')).toBe(true);
  });

  it('the same in a delegation thread (a task thread) with limits.localUnlimited on', async () => {
    const t = await mk({ cfg: { 'warroom.stallTurns': 4, 'limits.localUnlimited': true }, run: cycle({ th: 'th-d', parent: SW_WORK }) });
    await t.tasks.create({ title: 'T', deptId: 'software', owner: CTO, requester: HQ, origin: 'delegated', threadId: 'th-d', channelId: SW_WORK });
    await t.s.onMessage(bot(HQ, ['software'], { th: 'th-d', parent: SW_WORK }));
    for (let i = 0; i < 40; i++) await t.s.idle();
    expect(t.runs.filter((r) => r.instruction !== STALL_INSTRUCTION).length).toBeLessThanOrEqual(5);
    expect(t.runs.filter((r) => r.instruction === STALL_INSTRUCTION)).toHaveLength(1);
    expect(t.maxInFlight()).toBe(1);
  });

  it('two channels do not serialise against each other', async () => {
    const t = await mk();
    await t.s.onMessage(bot(HQ, ['software'], { ch: SW_WORK }));
    await t.s.onMessage(bot(HQ, ['software'], { ch: HQ_WORK }));
    await t.s.idle();
    expect(t.maxInFlight()).toBe(2);
  });

  it('a person\'s message in channel A does not lift a stall in channel B, and one in B does', async () => {
    const t = await mk({ cfg: { 'warroom.stallTurns': 2 }, run: async (trig, _d, s) => {
      if (trig.msg?.author.kind === 'human') return reply();
      const other = deptOf(trig.route.actor) === 'hq' ? 'software' : 'hq';
      void s().onMessage(bot(trig.route.actor, [other], { ch: SW_WORK }));
      return reply();
    } });
    await t.s.onMessage(bot(HQ, ['software'], { ch: SW_WORK }));
    for (let i = 0; i < 30; i++) await t.s.idle();
    const n = t.runs.length;
    await t.s.onMessage(humanMsg('hello there', { channelId: HQ_WORK })); // channel A: another channel
    await t.s.idle();
    await t.s.onMessage(bot(HQ, ['software'], { ch: SW_WORK }));
    for (let i = 0; i < 10; i++) await t.s.idle();
    expect(t.runs.filter((r) => r.msg?.author.kind !== 'human').length).toBe(n); // still stalled in B
    await t.s.onMessage(humanMsg('go on', { channelId: SW_WORK })); // channel B itself
    await t.s.onMessage(bot(HQ, ['software'], { ch: SW_WORK }));
    for (let i = 0; i < 10; i++) await t.s.idle();
    expect(t.runs.filter((r) => r.msg?.author.kind !== 'human').length).toBeGreaterThan(n);
  });

  it('the mention cap (3, CEO 5, after de-duplication) applies to bot authors in task threads too', async () => {
    const org = await seededOrg();
    const task = { id: 't1', rootId: 't1', requester: { kind: 'human', userId: '42' }, owner: CTO } as Task;
    const ctx: RouterCtx = { org, taskByThread: async () => task };
    const m = (from: ActorRef, list: string[]) => ({ ...bot(from, list, { th: 'th-1', parent: SW_WORK }) });
    const heads = ['rnd', 'it', 'sales', 'hr', 'ops', 'finance'];
    expect(await routeMessage(m(CTO, heads), ctx)).toHaveLength(3);
    expect(await routeMessage(m(HQ, heads), ctx)).toHaveLength(5);
  });

  it('a person\'s handle never resolves as a bot mention source (TW8 inbound stays): a human message needs a real mention to route', async () => {
    const t = await mk();
    await t.s.onMessage(humanMsg('@CTO please look', { channelId: HQ_WORK, mentionedHeads: [] }));
    await t.s.idle();
    expect(who(t.runs)).toEqual(['hq']); // the department channel's head, not @CTO
  });
});

describe('WS5 people\'s work is never starved by bot talk', () => {
  it('local slots: with every slot busy, a waiting person\'s call is granted before any waiting bot call', async () => {
    const slots = new Slots(2, 20);
    const ac = new AbortController();
    await slots.acquire(ac.signal, 'bot');
    await slots.acquire(ac.signal, 'bot');
    const order: string[] = [];
    const wait = (name: string, p: 'human' | 'bot') => void slots.acquire(ac.signal, p).then(() => order.push(name));
    wait('bot-1', 'bot');
    wait('bot-2', 'bot');
    wait('person', 'human'); // arrives last
    await new Promise((r) => setImmediate(r));
    slots.release();
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(['person']);
    slots.release();
    slots.release();
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(['person', 'bot-1', 'bot-2']);
  });

  it('a waiting call that is aborted leaves its queue', async () => {
    const slots = new Slots(1, 20);
    const ac = new AbortController();
    await slots.acquire(ac.signal);
    const gone = new AbortController();
    const p = slots.acquire(gone.signal, 'bot');
    gone.abort();
    expect(await p).toBe(false);
  });

  it('a run for a person\'s message carries no bot priority; bot talk is marked bot (the loop sets it from the trigger)', async () => {
    const make = async (msg: IncomingMessage, task: Task | null = null) => {
      const s = await setup({ provider: new FakeProvider([{ text: 'x' }], LOCAL) });
      s.cfg.values.set('provider.default', localDefault);
      await runAgent({ route: mentionRoute(HQ), msg, task, history: [], ...(msg.author.kind === 'human' ? {} : { pool: 'warroom' as const }) }, s.deps);
      return (s.provider as FakeProvider).calls[0]!.priority;
    };
    expect(await make(humanMsg('hi'))).toBeUndefined();
    expect(await make(bot(CTO, ['hq']))).toBe('bot');
  });

  it('a bot-triggered run in a department room (a local head mentioning Praw, who runs on Gemini) draws from the warroom pool', async () => {
    const t = await mk();
    await t.s.onMessage(bot(HQ, ['praw'], { ch: SW_WORK }));
    await t.s.idle();
    expect(who(t.runs)).toEqual(['praw']);
    expect(t.runs[0]!.pool).toBe('warroom');
    await t.s.onMessage(humanMsg('<@113> hi', { mentionedHeads: ['praw'] }));
    await t.s.idle();
    expect(t.runs.at(-1)!.pool).toBeUndefined(); // a person's message to Praw is not on the bot pool
  });
});

describe('WS6 one exclusion set (read live), and the origin category fails closed', () => {
  const ctxWith = async (live: () => { modRoomId: string | null }): Promise<RouterCtx> => ({ org: await seededOrg(), taskByThread: async () => null, live });

  it('a mention in the mod room is not routed after roles.modRoomId changes at runtime', async () => {
    let room: string | null = null;
    const ctx = await ctxWith(() => ({ modRoomId: room }));
    const m = bot(HQ, ['software'], { ch: MOD_ROOM });
    expect(await routeMessage(m, ctx)).toHaveLength(1); // not yet the mod room: a bot's handle routes in any readable channel
    room = MOD_ROOM;
    expect(await routeMessage(m, ctx)).toEqual([]);
    expect(await routeMessage({ ...m, channelId: 'th-8', threadId: 'th-8', parentChannelId: MOD_ROOM }, ctx)).toEqual([]);
    room = null;
    const inDept = { ...bot(HQ, ['software'], { ch: SW_WORK }) };
    expect(await routeMessage(inDept, ctx)).toHaveLength(1);
    room = SW_WORK; // the owner moves the mod room to this channel
    expect(await routeMessage(inDept, ctx)).toEqual([]);
    expect(await routeMessage({ ...inDept, channelId: 'th-9', threadId: 'th-9', parentChannelId: SW_WORK }, ctx)).toEqual([]);
    expect(isExcludedChannel(SW_WORK, null, { modRoomId: room })).toBe(true);
    room = null;
    expect(await routeMessage(inDept, ctx)).toHaveLength(1);
  });

  it('denied, system and log channels are never routed, for a bot mention or a person', async () => {
    const ctx = await ctxWith(() => ({ modRoomId: null }));
    for (const ch of ['1565715069969502310', '1565649677280485457', '1565667791938387969', '1565671253803794494', '1566454343820124352']) {
      expect(await routeMessage(bot(HQ, ['software'], { ch }), ctx)).toEqual([]);
      expect(await routeMessage({ ...bot(HQ, ['software'], { ch: 'th-9', th: 'th-9', parent: ch }) }, ctx)).toEqual([]);
    }
  });

  it('personas can be mentioned only in their own rooms: elsewhere the department head answers', async () => {
    const ctx = await ctxWith(() => ({ modRoomId: null }));
    const m = { ...bot(HQ, ['software'], { ch: SW_WORK }), content: '<@111> system-analyst please look' };
    expect((await routeMessage(m, ctx)).map((r) => r.actor)).toEqual([CTO]);
  });

  it('a partial thread (no parent) is not routed and gives no origin category', async () => {
    const ctx = await ctxWith(() => ({ modRoomId: null }));
    expect(await routeMessage({ ...bot(HQ, ['software']), channelId: 'th-9', threadId: 'th-9', parentChannelId: null }, ctx)).toEqual([]);
    const port = new FakeDiscordPort();
    port.categories.set(HQ_WORK, CAT);
    const tasks = new MemTasks() as Mem;
    const conv = createConversation({ tasks, port, limits: { checkOpenTasks: async () => true }, bus: newBus() });
    const partial = humanMsg('hi', { channelId: 'th-9', threadId: 'th-9', parentChannelId: null });
    const task = await conv.open({ actor: HQ, msg: partial, reason: 'dept_channel' });
    expect(task.originCategoryId ?? null).toBeNull();
  });

  it('a head without view rights in the origin channel falls back to #ai-warroom; with them the delegation thread opens in the origin channel', async () => {
    const make = async (blocked: boolean) => {
      const t = await mk({ categories: { [HQ_WORK]: CAT } });
      t.port.channels = [{ id: HQ_WORK, name: 'lounge', parentId: CAT, type: 0 }];
      if (blocked) t.port.noStart.add(HQ_WORK);
      const root = await t.tasks.create({ title: 'ask', deptId: 'hq', owner: HQ, requester: { kind: 'human', userId: '42' }, origin: 'chat', status: 'doing', threadId: HQ_WORK, channelId: HQ_WORK, conversation: true, originCategoryId: CAT });
      const child = await t.tasks.create({ title: 'CTO?', deptId: 'software', owner: CTO, requester: HQ, origin: 'delegated', parentId: root.id, channelId: WR });
      await t.s.onTaskCreated(child);
      await t.s.idle();
      return { t, child };
    };
    const ok = await make(false);
    expect(ok.t.port.threads[0]).toMatchObject({ dept: 'software', channelId: HQ_WORK });
    expect((await ok.t.tasks.get(ok.child.id))!.channelId).toBe(HQ_WORK);
    const no = await make(true);
    expect(no.t.port.threads[0]).toMatchObject({ dept: 'software', channelId: WR });
    expect((await no.t.tasks.get(no.child.id))!.channelId).toBe(WR);
  });

  it('a task with no origin category keeps its #ai-warroom delegation thread', async () => {
    const t = await mk();
    const root = await t.tasks.create({ title: 'bot root', deptId: 'hq', owner: HQ, requester: HQ, origin: 'delegated', status: 'doing' });
    const child = await t.tasks.create({ title: 'CTO?', deptId: 'software', owner: CTO, requester: HQ, origin: 'delegated', parentId: root.id, channelId: WR });
    await t.s.onTaskCreated(child);
    await t.s.idle();
    expect(t.port.threads[0]).toMatchObject({ channelId: WR });
  });
});

describe('WS13 / 1b head conversation tasks', () => {
  const U1 = { id: '42', name: 'Ann', kind: 'human' as const };
  const U2 = { id: '77', name: 'Bob', kind: 'human' as const };
  const at = (id: string, author: typeof U1, content = 'ask CTO and Sales about pricing and summarise here'): IncomingMessage =>
    humanMsg(content, { id, channelId: HQ_WORK, author });

  /** The CEO's first run opens the conversation and delegates twice; children report; the CEO's roll-up runs summarise what they were given. */
  function ceoScript(t: { tasks: Mem; bus: ReturnType<typeof newBus> }, o: { taint?: boolean; gate?: boolean; salesEnds?: 'done' | 'cancelled' } = {}) {
    const gate = o.gate ?? true;
    const afterFirstRollup = (() => { let r!: () => void; const p = new Promise<void>((x) => (r = x)); return { p, r }; })();
    return async (trig: AgentTrigger, d: AgentDeps): Promise<AgentOutcome> => {
      const a = trig.route.actor;
      if (a.kind === 'head' && a.dept === 'hq' && !trig.task && trig.msg?.author.kind === 'human') {
        const conv = await d.conversation!.open({ actor: a, msg: trig.msg, reason: trig.route.reason });
        for (const [dept, owner] of [['software', CTO], ['sales', SALES]] as const) {
          const kid = await t.tasks.create({ title: `${dept}?`, deptId: dept, owner, requester: HQ, origin: 'delegated', parentId: conv.id, channelId: WR, status: 'todo' });
          await t.bus.emit('task.created', { task: kid });
        }
        return reply('I asked them.');
      }
      if (trig.route.reason === 'task_owner' && trig.task && trig.task.parentId) {
        if (gate && trig.task.deptId === 'sales') await afterFirstRollup.p; // the second child ends after the first roll-up ran
        const to = trig.task.deptId === 'sales' ? o.salesEnds ?? 'done' : 'done';
        const patch = { status: to, ...(o.taint && trig.task.deptId === 'software' ? { tainted: true } : {}) } as const;
        const ended = (await t.tasks.update(trig.task.id, patch, 'doing')) ?? (await t.tasks.update(trig.task.id, patch));
        await t.bus.emit('task.changed', { task: ended!, from: 'doing', to, ...(to === 'done' ? { summary: `${trig.task.deptId} says 100` } : {}) });
        return reply('finished');
      }
      if (trig.task?.conversation) {
        if (trig.instruction) {
          afterFirstRollup.r();
          return noReply();
        }
        return reply(`Summary:\n${trig.msg?.content ?? ''}`);
      }
      return reply();
    };
  }

  const rigConv = async (o: { taint?: boolean; gate?: boolean; salesEnds?: 'done' | 'cancelled' } = {}) => {
    const tasksHolder = {} as { tasks: Mem; bus: ReturnType<typeof newBus> };
    const script = ceoScript(tasksHolder, o);
    const t = await mk({ conversation: true, categories: { [HQ_WORK]: CAT }, run: (trig, d) => script(trig, d) });
    tasksHolder.tasks = t.tasks;
    tasksHolder.bus = t.bus;
    t.port.channels = [{ id: HQ_WORK, name: 'lounge', parentId: CAT, type: 0 }];
    return t;
  };
  const summaries = (t: Awaited<ReturnType<typeof rigConv>>) => t.port.posts.filter((p) => 'body' in p.payload && p.payload.body.startsWith('Summary:'));

  it('the live-finding repro: the CEO asked in the lounge to ask @CTO and @Sales posts ONE summary in the lounge, as a reply to the asking message', async () => {
    const t = await rigConv();
    await t.s.onMessage(at('1570000000000009001', U1));
    for (let i = 0; i < 40; i++) await t.s.idle();
    const rows = [...t.tasks.rows.values()];
    const conv = rows.find((r) => r.conversation)!;
    expect(conv).toMatchObject({ deptId: 'hq', requester: { kind: 'human', userId: '42' }, threadId: HQ_WORK, channelId: HQ_WORK, originCategoryId: CAT, originMessageId: '1570000000000009001', status: 'done', parentId: null });
    const kids = rows.filter((r) => r.parentId === conv.id);
    expect(kids).toHaveLength(2);
    expect(kids.every((k) => k.originCategoryId === CAT && k.status === 'done')).toBe(true);
    // delegation threads opened in the lounge (the category), not in #ai-warroom
    expect(t.port.threads.map((x) => x.channelId)).toEqual([HQ_WORK, HQ_WORK]);
    const sums = summaries(t);
    expect(sums).toHaveLength(1);
    expect(sums[0]).toMatchObject({ actor: HQ, target: { channelId: HQ_WORK }, opts: { replyToId: '1570000000000009001' } });
    expect(sums[0]!.target).not.toHaveProperty('threadId');
    // the final roll-up was GIVEN both answers (it is what the summary above is made of), not only the last child's
    const body = (sums[0]!.payload as { body: string }).body;
    expect(body).toContain('software says 100');
    expect(body).toContain('sales says 100');
    // no per-child "Subtask done" cards in the person's channel, and the silent first roll-up posted nothing
    expect(t.port.posts.filter((p) => p.payload.title === 'Subtask done')).toHaveLength(0);
    expect(t.port.posts.filter((p) => 'body' in p.payload && p.payload.body === 'NO_REPLY')).toHaveLength(0);
  });

  it('a tainted child makes the roll-up run tainted (the conversation task is marked before the roll-up starts)', async () => {
    const t = await rigConv({ taint: true });
    await t.s.onMessage(at('1570000000000009002', U1));
    for (let i = 0; i < 40; i++) await t.s.idle();
    const rollups = t.runs.filter((r) => r.task?.conversation && r.msg?.author.kind !== 'human');
    expect(rollups.length).toBeGreaterThan(0);
    expect(rollups.every((r) => r.task!.tainted)).toBe(true);
  });

  it('both children finishing before the first roll-up runs still yields exactly one summary, holding both answers', async () => {
    const t = await rigConv({ gate: false });
    await t.s.onMessage(at('1570000000000009020', U1));
    for (let i = 0; i < 40; i++) await t.s.idle();
    const sums = summaries(t);
    expect(sums).toHaveLength(1);
    const body = (sums[0]!.payload as { body: string }).body;
    expect(body).toContain('software says 100');
    expect(body).toContain('sales says 100');
    expect([...t.tasks.rows.values()].find((r) => r.conversation)!.status).toBe('done');
  });

  it('the first child done, the last one cancelled: the person still gets one summary with the answer and the cancellation', async () => {
    const t = await rigConv({ salesEnds: 'cancelled' });
    await t.s.onMessage(at('1570000000000009021', U1));
    for (let i = 0; i < 40; i++) await t.s.idle();
    const sums = summaries(t);
    expect(sums).toHaveLength(1);
    const body = (sums[0]!.payload as { body: string }).body;
    expect(body).toContain('software says 100');
    expect(body).toContain('was cancelled');
    expect([...t.tasks.rows.values()].find((r) => r.conversation)!.status).toBe('done');
  });

  it('two people asking the CEO in one channel get two separate conversations and two summaries, each replying to the right message', async () => {
    const t = await rigConv();
    await t.s.onMessage(at('1570000000000009003', U1));
    for (let i = 0; i < 40; i++) await t.s.idle();
    await t.s.onMessage(at('1570000000000009004', U2));
    for (let i = 0; i < 40; i++) await t.s.idle();
    const convs = [...t.tasks.rows.values()].filter((r) => r.conversation);
    expect(convs.map((c) => c.requester)).toEqual([{ kind: 'human', userId: '42' }, { kind: 'human', userId: '77' }]);
    const replies = summaries(t).map((p) => p.opts?.replyToId);
    expect(replies).toEqual(['1570000000000009003', '1570000000000009004']);
  });

  it('at most one open conversation per (head, person, place): the same person asking again continues it', async () => {
    const t = await mk({ conversation: true });
    const tasks = t.tasks;
    const conv = createConversation({ tasks, port: t.port, limits: { checkOpenTasks: async () => true }, bus: t.bus });
    const a = await conv.open({ actor: HQ, msg: at('1570000000000009005', U1), reason: 'dept_channel' });
    const b = await conv.open({ actor: HQ, msg: at('1570000000000009006', U1), reason: 'mention' });
    expect(b.id).toBe(a.id);
    expect((await tasks.get(a.id))!.originMessageId).toBe('1570000000000009006');
    const c = await conv.open({ actor: HQ, msg: at('1570000000000009007', U2), reason: 'dept_channel' });
    expect(c.id).not.toBe(a.id);
    const d = await conv.open({ actor: CTO, msg: at('1570000000000009008', U1), reason: 'dept_channel' });
    expect(d.id).not.toBe(a.id);
  });

  it('only a person\'s message that routed by mention, dept_channel or goal_channel opens one: never a warroom, task_owner or persona route, a bot author or a voice message', async () => {
    const t = await mk();
    const conv = createConversation({ tasks: t.tasks, port: t.port, limits: { checkOpenTasks: async () => true }, bus: t.bus });
    for (const reason of ['warroom', 'task_owner', 'persona_mention', 'direct_channel', 'admin_console', undefined]) {
      await expect(conv.open({ actor: HQ, msg: at('1570000000000009010', U1), ...(reason ? { reason } : {}) })).rejects.toThrow();
    }
    await expect(conv.open({ actor: HQ, msg: { ...at('1570000000000009011', U1), author: { id: 'b', name: 'b', kind: 'head', actor: CTO } }, reason: 'mention' })).rejects.toThrow();
    await expect(conv.open({ actor: HQ, msg: { ...at('1570000000000009012', U1), origin: 'voice' }, reason: 'mention' })).rejects.toThrow();
    expect(t.tasks.rows.size).toBe(0);
  });

  it('a head\'s conversation run is not direct (isDirectHumanRun stays Praw-only), even with origin chat and its own requester', async () => {
    const t = await mk();
    const conv = createConversation({ tasks: t.tasks, port: t.port, limits: { checkOpenTasks: async () => true }, bus: t.bus });
    const task = await conv.open({ actor: HQ, msg: at('1570000000000009013', U1), reason: 'dept_channel' });
    expect(task.origin).toBe('chat');
    expect(isDirectHumanRun({ origin: 'chat', actor: HQ, task, trigger: { kind: 'human_message', userId: '42', origin: 'chat' } })).toBe(false);
    expect(isDirectHumanRun({ origin: 'chat', actor: A('praw'), task: { ...task, deptId: 'praw', owner: A('praw') }, trigger: { kind: 'human_message', userId: '42', origin: 'chat' } })).toBe(true);
  });

  it('a /goal task (hq-owned, human-requested, depth 0) is never taken for a conversation', async () => {
    const t = await mk();
    const goal = await t.tasks.create({ title: 'goal', deptId: 'hq', owner: HQ, requester: { kind: 'human', userId: '42' }, origin: 'slash', status: 'doing' });
    const { isConversationTask } = await import('./conversation.js');
    expect(isConversationTask(goal)).toBe(false);
  });

  it('a second member\'s post in the delegation thread does not route to the owner; the root requester and a Bot Admin do', async () => {
    const org = await seededOrg();
    const root = await mkTask({ id: 'root', rootId: 'root', requester: { kind: 'human', userId: '42' }, conversation: true });
    const child = await mkTask({ id: 'kid', rootId: 'root', parentId: 'root', depth: 1, owner: CTO, requester: HQ, threadId: 'th-d', origin: 'delegated' });
    const ctx: RouterCtx = { org, taskByThread: async () => child, taskById: async (id) => (id === 'root' ? root : child) };
    const post = (author: typeof U1, isAdmin = false) => humanMsg('do it differently', { id: `p-${++seq}`, channelId: 'th-d', threadId: 'th-d', parentChannelId: HQ_WORK, author, isAdmin });
    expect(await routeMessage(post(U2), ctx)).toEqual([]);
    expect((await routeMessage(post(U1), ctx)).map((r) => r.reason)).toEqual(['task_owner']);
    expect((await routeMessage(post(U2, true), ctx)).map((r) => r.reason)).toEqual(['task_owner']);
    // no way to look the root up: fail closed (only a Bot Admin steers)
    expect(await routeMessage(post(U1), { org, taskByThread: async () => child })).toEqual([]);
  });
});

async function mkTask(o: Partial<Task>): Promise<Task> {
  return {
    id: 't', title: 't', description: '', deptId: 'hq', owner: HQ, requester: HQ, parentId: null, rootId: 't', depth: 0, status: 'doing', threadId: null, turnsUsed: 0,
    costUsd: 0, estCostUsd: null, blockedReason: null, origin: 'chat', channelId: null, sourceUserId: null, tainted: false, ...o,
  };
}

describe('WS3 / WS4 the stall guard cannot be disabled, and its state survives a restart', () => {
  it('warroom.stallTurns keeps min 1 (0 is refused, it does not mean "off"), defaults to 20, and raising it is a risk card', () => {
    expect(ConfigSchema['warroom.stallTurns'].safeParse(0).success).toBe(false);
    expect(ConfigSchema['warroom.stallTurns'].safeParse(1).success).toBe(true);
    expect(CONFIG_DEFAULTS['warroom.stallTurns']).toBe(20);
    expect(configRisk('warroom.stallTurns', 20, 50)).toBe(true);
    expect(configRisk('warroom.stallTurns', 20, 10)).toBe(false);
  });

  it('limits.localUnlimited defaults on, and turning it on again after it was off is a risk card', () => {
    expect(CONFIG_DEFAULTS['limits.localUnlimited']).toBe(true);
    expect(configRisk('limits.localUnlimited', false, true)).toBe(true);
    expect(configRisk('limits.localUnlimited', true, false)).toBe(false);
  });

  class MemStore implements GuardStore {
    rows = new Map<string, GuardRow>();
    puts: string[] = [];
    delay = 0;
    async get(key: string) { return this.rows.get(key) ?? null; }
    async put(key: string, row: GuardRow) {
      await new Promise((r) => setTimeout(r, this.delay));
      this.rows.set(key, { ...row });
      this.puts.push(key);
    }
    async prune() { /* not needed here */ }
  }
  const loop = async (trig: AgentTrigger, _d: AgentDeps, s: () => Scheduler) => {
    const other = deptOf(trig.route.actor) === 'hq' ? 'software' : 'hq';
    void s().onMessage(bot(trig.route.actor, [other], { ch: SW_WORK }));
    return reply();
  };

  it('a stalled channel is still stalled after the scheduler is rebuilt on the same store; a person\'s message there lifts it', async () => {
    const store = new MemStore();
    const t1 = await mk({ cfg: { 'warroom.stallTurns': 3 }, run: loop, guardStore: store });
    await t1.s.onMessage(bot(HQ, ['software'], { ch: SW_WORK }));
    for (let i = 0; i < 40; i++) await t1.s.idle();
    expect(store.rows.get(SW_WORK)).toMatchObject({ stalled: true, count: 3 });
    // restart: a new scheduler, the same store
    const t2 = await mk({ cfg: { 'warroom.stallTurns': 3 }, run: async (trig, d, sc) => (trig.msg?.author.kind === 'human' ? reply() : loop(trig, d, sc)), guardStore: store });
    await t2.s.onMessage(bot(HQ, ['software'], { ch: SW_WORK }));
    for (let i = 0; i < 10; i++) await t2.s.idle();
    expect(t2.runs).toHaveLength(0);
    await t2.s.onMessage(humanMsg('go on', { channelId: SW_WORK }));
    await t2.s.idle();
    await new Promise((r) => setTimeout(r, 10)); // the write-through of the lift lands
    expect(store.rows.get(SW_WORK)).toMatchObject({ stalled: false, count: 0 });
  });

  it('the stored counter is written before the run it counts starts', async () => {
    const store = new MemStore();
    store.delay = 20;
    const seen: number[] = [];
    const t = await mk({ guardStore: store, run: async () => { seen.push(store.rows.get(SW_WORK)?.count ?? -1); return reply(); } });
    await t.s.onMessage(bot(HQ, ['software'], { ch: SW_WORK }));
    await t.s.idle();
    expect(seen).toEqual([1]);
  });

  it('a store that fails does not stop bot talk (memory still holds the state) and logs the error', async () => {
    const store = new MemStore();
    store.put = async () => { throw new Error('db down'); };
    const t = await mk({ guardStore: store, cfg: { 'warroom.stallTurns': 2 }, run: loop });
    await t.s.onMessage(bot(HQ, ['software'], { ch: SW_WORK }));
    for (let i = 0; i < 40; i++) await t.s.idle();
    expect(t.runs.filter((r) => r.instruction !== STALL_INSTRUCTION)).toHaveLength(2);
    expect(t.errors.length).toBeGreaterThan(0);
  });
});

describe('WS5 bot-rooted trees draw from the warroom pool, people\'s trees do not', () => {
  it('the owner run of a task in a bot-made tree carries pool warroom; a task in a person\'s tree does not', async () => {
    const t = await mk();
    const botRoot = await t.tasks.create({ title: 'bot root', deptId: 'software', owner: CTO, requester: HQ, origin: 'delegated' });
    const botKid = await t.tasks.create({ title: 'bot kid', deptId: 'sales', owner: SALES, requester: CTO, origin: 'delegated', parentId: botRoot.id });
    const conv = await t.tasks.create({ title: 'ask', deptId: 'hq', owner: HQ, requester: { kind: 'human', userId: '42' }, origin: 'chat', conversation: true, status: 'doing' });
    const humanKid = await t.tasks.create({ title: 'kid', deptId: 'software', owner: CTO, requester: HQ, origin: 'delegated', parentId: conv.id });
    for (const k of [botRoot, botKid, humanKid]) await t.s.onTaskReady(k.id);
    await t.s.idle();
    const pool = (id: string) => t.runs.find((r) => r.task?.id === id)?.pool;
    expect(pool(botRoot.id)).toBe('warroom');
    expect(pool(botKid.id)).toBe('warroom');
    expect(pool(humanKid.id)).toBeUndefined();
  });
});

describe('WS5 a person\'s Praw mention starts next when the global slots are busy with bot runs', () => {
  it('with every slot held by bot-triggered runs and more bot runs queued, the person\'s mention is the next run to start', async () => {
    const started: string[] = [];
    const gates = new Map<string, () => void>();
    let open = false;
    const t = await mk({
      cfg: { 'limits.concurrency': 2 },
      run: async (trig) => {
        const id = trig.msg!.id;
        started.push(trig.msg!.author.kind === 'human' ? 'person:praw' : `bot:${deptOf(trig.route.actor)}`);
        if (trig.msg!.author.kind === 'human' || open) return reply();
        await new Promise<void>((r) => gates.set(id, r));
        return reply();
      },
    });
    const ids = new Map<string, string>();
    for (const [ch, dept] of [['c1', 'software'], ['c2', 'rnd'], ['c3', 'it'], ['c4', 'sales']] as const) {
      const m = bot(HQ, [dept], { ch });
      ids.set(dept, m.id);
      await t.s.onMessage(m);
    }
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
    expect(started).toEqual(['bot:software', 'bot:rnd']); // both slots busy; it and sales wait in the bot queue
    await t.s.onMessage(humanMsg('<@113> hello', { channelId: SW_WORK, mentionedHeads: ['praw'] }));
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
    gates.get(ids.get('software')!)!();
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
    expect(started[2]).toBe('person:praw');
    open = true;
    for (const g of gates.values()) g();
    for (let i = 0; i < 20; i++) await t.s.idle();
  });
});

describe('Teamwork D / W2 a bot\'s @handle routes in a forum post', () => {
  const FORUM = '1570000000000000777';
  it('router: in a mapped forum post a bot mention reaches the mentioned head; no mention routes nowhere', async () => {
    const org = await seededOrg({ mapped: { [FORUM]: 'software' } });
    const ctx: RouterCtx = { org, taskByThread: async () => null };
    const post = (mentioned: string[]) => bot(HQ, mentioned, { th: 'post-9', parent: FORUM });
    expect((await routeMessage(post(['rnd']), ctx)).map((r) => r.actor)).toEqual([A('rnd')]);
    expect(await routeMessage(post([]), ctx)).toEqual([]);
  });

  it('scheduler: the mentioned head runs in the forum post, under the guard (a loop there stops at stallTurns)', async () => {
    const org = await seededOrg({ mapped: { [FORUM]: 'software' } });
    const t = await mk({
      org, cfg: { 'warroom.stallTurns': 3 },
      run: async (trig, _d, s) => {
        const other = deptOf(trig.route.actor) === 'hq' ? 'rnd' : 'hq';
        void s().onMessage(bot(trig.route.actor, [other], { th: 'post-9', parent: FORUM }));
        return reply();
      },
    });
    await t.s.onMessage(bot(HQ, ['rnd'], { th: 'post-9', parent: FORUM }));
    for (let i = 0; i < 40; i++) await t.s.idle();
    expect(t.runs.filter((r) => r.instruction !== STALL_INSTRUCTION)).toHaveLength(3);
    expect(t.runs.filter((r) => r.instruction === STALL_INSTRUCTION)).toHaveLength(1);
  });
});

describe('WS3 the gate\'s exact case', () => {
  it('a two-head loop that writes a task every stallTurns - 1 turns still stalls within 2 x stallTurns', async () => {
    const stallTurns = 4;
    let n = 0;
    const t = await mk({
      cfg: { 'warroom.stallTurns': stallTurns },
      run: async (trig, _d, s) => {
        if (trig.instruction === STALL_INSTRUCTION) return reply();
        n++;
        if (n % (stallTurns - 1) === 0) trig.onTaskWrite?.();
        const other = deptOf(trig.route.actor) === 'hq' ? 'software' : 'hq';
        void s().onMessage(bot(trig.route.actor, [other], { ch: SW_WORK }));
        return reply();
      },
    });
    await t.s.onMessage(bot(HQ, ['software'], { ch: SW_WORK }));
    for (let i = 0; i < 80; i++) await t.s.idle();
    const normal = t.runs.filter((r) => r.instruction !== STALL_INSTRUCTION).length;
    expect(normal).toBeLessThanOrEqual(2 * stallTurns);
    expect(t.runs.filter((r) => r.instruction === STALL_INSTRUCTION)).toHaveLength(1);
  });
});
