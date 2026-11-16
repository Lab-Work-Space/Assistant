import { describe, expect, it, vi } from 'vitest';
import { AI_WARROOM_CHANNEL_ID } from '../../company/channels.js';
import type { ActorRef, IncomingMessage } from '../../company/types.js';
import type { ConfigKey, ConfigValue } from '../../config/schema.js';
import type { Task } from '../../db/repos/tasks.js';
import { Limits } from '../../governance/limits.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { FakeDiscordPort } from '../../tests/fakes/discordPort.js';
import type { AgentDeps, AgentOutcome, AgentTrigger } from '../loop/loop.js';
import { STALL_INSTRUCTION } from '../scheduler/notices.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { MemTasks, humanMsg, newBus, noApprovedTools, seededOrg } from '../test-helpers.js';

const WR = AI_WARROOM_CHANNEL_ID;
const BOT_LOG = '1566454343820124352';
const A = (dept: string): ActorRef => ({ kind: 'head', dept } as ActorRef);
const HQ = A('hq');
const CTO = A('software');
const FIN = A('finance');
const ORDER = [HQ, CTO, FIN];
const deptOf = (a: ActorRef) => (a.kind === 'head' ? a.dept : a.personaId);
let seq = 0;
const reply = (payload: Partial<AgentOutcome['payload']> = {}): AgentOutcome => ({ payload: { type: 'chat', body: 'ok', ...payload }, costUsd: 0, turns: 1 });

type Tasks = MemTasks & { findByThread(id: string): Promise<Task | null> };
const memTasks = (): Tasks => {
  const tasks = new MemTasks() as Tasks;
  tasks.findByThread = async (id) => [...tasks.rows.values()].find((t) => t.threadId === id) ?? null;
  return tasks;
};

/** A message from a head in the warroom (top level, or inside thread `th`). */
const bot = (from: ActorRef, mentioned: string[], th: string | null = null, over: Partial<IncomingMessage> = {}): IncomingMessage => ({
  id: `m-${++seq}`, channelId: th ?? WR, parentChannelId: th ? WR : null, threadId: th,
  author: { id: `bot-${deptOf(from)}`, name: deptOf(from), kind: 'head', actor: from },
  content: mentioned.map((d) => `<@${d}>`).join(' ') + ' go', mentionedHeads: mentioned as never, isAdmin: false, attachments: [], origin: 'chat', ...over,
});

type Cfg = Partial<{ [K in ConfigKey]: ConfigValue<K> }>;
async function mk(o: { cfg?: Cfg; run?: (t: AgentTrigger, s: () => Scheduler) => Promise<AgentOutcome>; day?: { off: boolean }; tasks?: Tasks } = {}) {
  const cfg = new FakeConfig({ 'warroom.stallTurns': 1000, 'warroom.turnsPerThreadPerHour': 1000, 'warroom.turnsPerHour': 1000, ...o.cfg });
  const tasks = o.tasks ?? memTasks();
  const port = new FakeDiscordPort();
  const bus = newBus();
  const day = o.day ?? { off: false };
  const runs: AgentTrigger[] = [];
  const errors: object[] = [];
  let cur = 0;
  let max = 0;
  let sched: Scheduler;
  const run = vi.fn(async (t: AgentTrigger) => {
    runs.push(t);
    cur++;
    max = Math.max(max, cur);
    try {
      await new Promise((r) => setImmediate(r));
      return o.run ? await o.run(t, () => sched) : reply();
    } finally {
      cur--;
    }
  });
  sched = new Scheduler({
    agent: {} as AgentDeps, approvedTools: noApprovedTools, run, port, org: await seededOrg(), tasks, limits: new Limits(cfg, tasks),
    halt: { isHalted: () => false }, cfg, bus, log: { error: (e: object) => void errors.push(e) }, now: () => 5_000_000,
    calendar: { isOffDay: () => (day.off ? { off: true, reason: 'weekday' } : { off: false }) },
  });
  sched.attach();
  return { s: sched, port, bus, runs, run, errors, tasks, day, maxInFlight: () => max, cfg };
}
const who = (runs: AgentTrigger[]) => runs.map((r) => deptOf(r.route.actor));

describe('TW1 one bot-triggered run in flight per warroom thread, coalesced, rate guarded', () => {
  it('a post mentioning 3 heads runs them one at a time; a newer trigger for the same head replaces the pending one', async () => {
    const t = await mk();
    await t.s.onMessage(bot(HQ, ['software', 'rnd', 'it']));
    await t.s.onMessage(bot(HQ, ['it'], null)); // arrives while the first run is in flight: coalesces with the pending `it`
    await t.s.idle();
    expect(t.maxInFlight()).toBe(1);
    expect(who(t.runs).sort()).toEqual(['it', 'rnd', 'software']);
    expect(t.runs.every((r) => r.pool === 'warroom')).toBe(true);
  });

  it('two threads run side by side (the bound is per thread)', async () => {
    const t = await mk();
    await t.s.onMessage(bot(HQ, ['software'], 'th-1'));
    await t.s.onMessage(bot(HQ, ['rnd'], 'th-2'));
    await t.s.idle();
    expect(t.maxInFlight()).toBe(2);
  });

  it('a fan-out of 3 mentions per reply, 3 levels deep, stays at one run in flight and at most N runs per hour, with one notice', async () => {
    const heads = ['software', 'rnd', 'it', 'sales', 'hr'];
    const t = await mk({
      cfg: { 'warroom.turnsPerThreadPerHour': 6 },
      run: async (trig, s) => {
        const me = trig.route.actor;
        void s().onMessage(bot(me, heads.filter((h) => h !== deptOf(me)).slice(0, 3), 'th-1'));
        return reply();
      },
    });
    await t.s.onMessage(bot(HQ, ['software', 'rnd', 'it'], 'th-1'));
    for (let i = 0; i < 40; i++) await t.s.idle();
    expect(t.maxInFlight()).toBe(1);
    expect(t.runs.length).toBe(6);
    const notices = t.port.posts.filter((p) => p.target.channelId === BOT_LOG);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.payload.title).toBe('Warroom routing paused');
  });

  it('the per-warroom hourly rate stops routing across threads', async () => {
    const t = await mk({ cfg: { 'warroom.turnsPerHour': 2 } });
    for (const th of ['a', 'b', 'c', 'd']) await t.s.onMessage(bot(HQ, ['software'], th));
    await t.s.idle();
    expect(t.runs).toHaveLength(2);
    expect(t.port.posts.filter((p) => p.target.channelId === BOT_LOG)).toHaveLength(1);
  });
});

describe('TW2 continuation routing', () => {
  it('three heads in one thread with no mentions give a linear chain, one run per post', async () => {
    const t = await mk();
    await t.s.onMessage(bot(HQ, [], 'th-1'));
    await t.s.idle();
    expect(t.runs).toHaveLength(0); // nobody spoke before
    await t.s.onMessage(bot(CTO, [], 'th-1'));
    await t.s.idle();
    expect(who(t.runs)).toEqual(['hq']);
    await t.s.onMessage(bot(FIN, [], 'th-1'));
    await t.s.idle();
    expect(who(t.runs)).toEqual(['hq', 'software']); // one new run, the previous speaker, never two
  });

  it('a reply-to points the continuation at the author of the replied message', async () => {
    const t = await mk();
    const first = bot(HQ, [], 'th-1');
    await t.s.onMessage(first);
    await t.s.onMessage(bot(CTO, [], 'th-1'));
    await t.s.idle();
    t.runs.length = 0;
    await t.s.onMessage(bot(FIN, [], 'th-1', { replyToId: first.id }));
    await t.s.idle();
    expect(who(t.runs)).toEqual(['hq']);
  });

  it('a top-level post with no mention runs no one', async () => {
    const t = await mk();
    await t.s.onMessage(bot(HQ, []));
    await t.s.onMessage(bot(CTO, []));
    await t.s.idle();
    expect(t.runs).toHaveLength(0);
  });
});

describe('TW3 the consecutive-turn guard keys on code-observed facts', () => {
  /** A cycle through three heads, each reply mentioning the next; every reply claims to be a `report`. */
  const cycle = (th: string | null) => async (trig: AgentTrigger, s: () => Scheduler): Promise<AgentOutcome> => {
    const i = ORDER.findIndex((a) => deptOf(a) === deptOf(trig.route.actor));
    if (deptOf(trig.route.actor) !== 'hq' || trig.instruction !== STALL_INSTRUCTION) void s().onMessage(bot(trig.route.actor, [deptOf(ORDER[(i + 1) % 3]!)], th));
    return reply({ type: 'report', body: 'report: done' });
  };

  it('a 3-head cycle is caught; a report payload resets nothing; one CEO stalled turn, then routing stops', async () => {
    const t = await mk({ cfg: { 'warroom.stallTurns': 6 }, run: cycle('th-1') });
    await t.s.onMessage(bot(HQ, ['software'], 'th-1'));
    for (let i = 0; i < 40; i++) await t.s.idle();
    const stall = t.runs.filter((r) => r.instruction === STALL_INSTRUCTION);
    expect(stall).toHaveLength(1);
    expect(stall.every((r) => r.noWarroomSay === true)).toBe(true); // G2LF-02: the stall turn is not offered warroom_say
    expect(deptOf(stall[0]!.route.actor)).toBe('hq');
    expect(t.runs.length).toBe(6 + 1);
    // more bot traffic does nothing while stalled
    await t.s.onMessage(bot(CTO, ['finance'], 'th-1'));
    await t.s.idle();
    expect(t.runs.length).toBe(7);
  });

  it('a person posting in the thread lifts the stall', async () => {
    const t = await mk({ cfg: { 'warroom.stallTurns': 3 }, run: cycle('th-1') });
    await t.s.onMessage(bot(HQ, ['software'], 'th-1'));
    for (let i = 0; i < 30; i++) await t.s.idle();
    const before = t.runs.length;
    await t.s.onMessage(humanMsg('carry on', { channelId: 'th-1', threadId: 'th-1', parentChannelId: WR }));
    await t.s.onMessage(bot(HQ, ['rnd'], 'th-1'));
    await t.s.idle();
    expect(t.runs.length).toBeGreaterThan(before);
  });

  it('a stall where the CEO is in the cycle: the CEO posting again does not lift it, and the stall turn\'s own post does not either', async () => {
    const t = await mk({ cfg: { 'warroom.stallTurns': 3 }, run: cycle('th-1') });
    await t.s.onMessage(bot(HQ, ['software'], 'th-1'));
    for (let i = 0; i < 30; i++) await t.s.idle();
    expect(t.runs.filter((r) => r.instruction === STALL_INSTRUCTION)).toHaveLength(1);
    expect(t.runs.length).toBe(3 + 1);
    const n = t.runs.length;
    const stallPost = t.port.posts.filter((p) => p.target.threadId === 'th-1' && p.actor.kind === 'head' && p.actor.dept === 'hq').at(-1)!;
    await t.s.onMessage(bot(HQ, ['rnd'], 'th-1', { id: stallPost.id }));
    await t.s.onMessage(bot(HQ, ['rnd'], 'th-1'));
    await t.s.idle();
    expect(t.runs.length).toBe(n);
  });

  it('G2TW-01: no CEO post lifts a stall: the stall turn\'s split reply (chunks echoing after the turn ended) and a later CEO post both leave it stalled', async () => {
    const outside: ActorRef[] = [CTO, FIN, A('it')];
    const t = await mk({
      cfg: { 'warroom.stallTurns': 3 },
      run: async (trig, s) => {
        if (trig.instruction === STALL_INSTRUCTION) return reply();
        const i = outside.findIndex((a) => deptOf(a) === deptOf(trig.route.actor));
        void s().onMessage(bot(trig.route.actor, [deptOf(outside[(i + 1) % 3]!)], 'th-2'));
        return reply({ type: 'report' });
      },
    });
    await t.s.onMessage(bot(CTO, ['finance'], 'th-2'));
    for (let i = 0; i < 30; i++) await t.s.idle();
    expect(t.runs.filter((r) => r.instruction === STALL_INSTRUCTION)).toHaveLength(1);
    const n = t.runs.length;
    // the turn is over; three chunks of its reply echo afterwards, each with an id nobody recorded, each mentioning a head
    for (const d of ['rnd', 'it', 'sales']) await t.s.onMessage(bot(HQ, [d], 'th-2'));
    await t.s.idle();
    expect(t.runs.length).toBe(n);
  });

  it('a person\'s message is what lifts a stall', async () => {
    const t = await mk({ cfg: { 'warroom.stallTurns': 2 }, run: cycle('th-5') });
    await t.s.onMessage(bot(HQ, ['software'], 'th-5'));
    for (let i = 0; i < 30; i++) await t.s.idle();
    const n = t.runs.length;
    await t.s.onMessage(humanMsg('go on', { channelId: 'th-5', threadId: 'th-5', parentChannelId: WR }));
    await t.s.onMessage(bot(HQ, ['rnd'], 'th-5'));
    await t.s.idle();
    expect(t.runs.length).toBeGreaterThan(n);
  });

  it('WS3: a task row written by a run (seen by code) resets the count at most once per stall window; a loop that writes one every time still stalls', async () => {
    const t = await mk({
      cfg: { 'warroom.stallTurns': 3, 'warroom.turnsPerThreadPerHour': 12 },
      run: async (trig, s) => {
        trig.onTaskWrite?.();
        const i = ORDER.findIndex((a) => deptOf(a) === deptOf(trig.route.actor));
        if (s) void s().onMessage(bot(trig.route.actor, [deptOf(ORDER[(i + 1) % 3]!)], 'th-3'));
        return reply();
      },
    });
    await t.s.onMessage(bot(HQ, ['software'], 'th-3'));
    for (let i = 0; i < 12; i++) await t.s.idle();
    // the one allowed reset lets it run 3 more turns, then the stall turn; it ends within 2 x stallTurns normal turns
    expect(t.runs.filter((r) => r.instruction === STALL_INSTRUCTION)).toHaveLength(1);
    expect(t.runs.filter((r) => r.instruction !== STALL_INSTRUCTION).length).toBeLessThanOrEqual(2 * 3);
  });

  it('top-level warroom posts are guarded too', async () => {
    const t = await mk({ cfg: { 'warroom.stallTurns': 4 }, run: cycle(null) });
    await t.s.onMessage(bot(HQ, ['software']));
    for (let i = 0; i < 40; i++) await t.s.idle();
    expect(t.runs.length).toBe(4 + 1);
  });
});

describe('TW19 NO_REPLY', () => {
  it('a bot-triggered turn answering exactly NO_REPLY posts nothing, but is still counted; alerts and cards are always posted', async () => {
    const t = await mk({ run: async (trig) => (trig.msg?.content.includes('card') ? reply({ type: 'alert', title: 'Heads up', body: 'NO_REPLY' }) : reply({ body: ' NO_REPLY \n' })) });
    await t.s.onMessage(bot(HQ, ['software']));
    await t.s.idle();
    expect(t.runs).toHaveLength(1);
    expect(t.port.posts).toHaveLength(0);
    await t.s.onMessage(bot(HQ, ['software'], null, { content: 'card please' }));
    await t.s.idle();
    expect(t.port.posts).toHaveLength(1);
    expect(t.port.posts[0]!.payload.type).toBe('alert');
  });

  it('is not an exact match -> posted; a person is always answered', async () => {
    const t = await mk({ run: async (trig) => reply({ body: trig.msg?.author.kind === 'human' ? 'NO_REPLY' : 'NO_REPLY thanks' }) });
    await t.s.onMessage(bot(HQ, ['software']));
    await t.s.onMessage(humanMsg('<@1> hello', { mentionedHeads: ['software'] }));
    await t.s.idle();
    expect(t.port.posts.map((p) => p.payload.body).sort()).toEqual(['NO_REPLY', 'NO_REPLY thanks']);
  });
});

describe('TW4 the warroom pool', () => {
  it('when the warroom pool is used up bot-to-bot routing stops for the day; a human mention to Praw still runs', async () => {
    const t = await mk();
    t.bus.on('governance.paused', () => undefined);
    await t.bus.emit('governance.paused', { scope: 'warroom', day: '2026-11-03' });
    await t.s.idle();
    expect(t.port.posts.some((p) => p.target.channelId === BOT_LOG && p.payload.title === 'Warroom quota used up')).toBe(true);
    await t.s.onMessage(bot(HQ, ['software']));
    await t.s.idle();
    expect(t.runs).toHaveLength(0);
    await t.s.onMessage(humanMsg('<@9> hi', { mentionedHeads: ['praw'] }));
    await t.s.idle();
    expect(t.runs).toHaveLength(1);
    expect(t.runs[0]!.pool).toBeUndefined();
  });
});

describe('TW14 off-day holding', () => {
  it('200 held bot turns coalesce per thread and stay within their own limit, leaving the roll-up hold alone; they start on the workday', async () => {
    const day = { off: true };
    const t = await mk({ day, cfg: { 'warroom.heldMax': 5 } });
    for (let i = 0; i < 200; i++) await t.s.onMessage(bot(HQ, ['software'], `th-${i % 20}`));
    await t.s.idle();
    expect(t.runs).toHaveLength(0);
    expect(t.errors.length).toBeGreaterThan(0); // the dropped ones are logged
    day.off = false;
    t.s.dayTurned();
    await t.s.idle();
    expect(t.runs).toHaveLength(5);
  });

  it('a roll-up held on the off day is still there after the warroom hold overflowed, and runs after dayTurned', async () => {
    const day = { off: true };
    const t = await mk({ day, cfg: { 'warroom.heldMax': 2 } });
    for (let i = 0; i < 50; i++) await t.s.onMessage(bot(HQ, ['software'], `th-${i}`));
    const parent = await t.tasks.create({ title: 'Parent', deptId: 'software', owner: CTO, requester: { kind: 'human', userId: '42' }, origin: 'chat', threadId: 'th-p', status: 'doing' });
    const child = await t.tasks.create({ title: 'Child', deptId: 'software', owner: A('rnd'), requester: CTO, origin: 'delegated', parentId: parent.id, status: 'done' });
    await t.bus.emit('task.changed', { task: child, from: 'doing', to: 'done', summary: 'all good' });
    await t.s.idle();
    expect(t.runs).toHaveLength(0);
    day.off = false;
    t.s.dayTurned();
    await t.s.idle();
    expect(t.runs.filter((r) => r.route.taskId === parent.id)).toHaveLength(1); // the roll-up
    expect(t.runs.filter((r) => !r.route.taskId)).toHaveLength(2); // and only the 2 held warroom starts
  });
});

describe('TW5 task threads under the warroom keep checkTurn and NO_ROLLUP', () => {
  it('a delegation thread in the warroom stops at turnsPerTask: no run reaches the provider, the task is blocked', async () => {
    const { setup } = await import('../loop/loop-fixture.js');
    const f = await setup({ turnsPerTask: 2, script: [{ toolUses: [{ name: 'respond', input: { type: 'chat', body: 'x' } }] }] });
    const org = f.deps.org;
    const task = await f.tasks.create({ title: 'Delegated', deptId: 'software', owner: CTO, requester: HQ, origin: 'delegated', threadId: 'th-d', channelId: WR, status: 'doing' });
    await f.tasks.update(task.id, { turnsUsed: 2 });
    const tasks = f.tasks as unknown as Tasks;
    tasks.findByThread = async (id) => [...f.tasks.rows.values()].find((r) => r.threadId === id) ?? null;
    const port = new FakeDiscordPort();
    const s = new Scheduler({
      agent: f.deps, approvedTools: noApprovedTools, port, org, tasks, limits: f.deps.limits as Limits, halt: { isHalted: () => false }, cfg: f.cfg, bus: f.bus,
      log: { error: () => undefined }, now: () => 5_000_000,
    });
    s.attach();
    await s.onMessage(bot(HQ, ['software'], 'th-d'));
    await s.idle();
    expect(f.budget.reserves).toHaveLength(0);
    expect((await f.tasks.get(task.id))!.status).toBe('blocked');
    expect(port.posts.at(-1)!.payload.title).toBe('Turn limit');
  });

  it('a done task thread in the warroom is not worked on from its thread', async () => {
    const t = await mk();
    await t.tasks.create({ title: 'Done', deptId: 'software', owner: CTO, requester: HQ, origin: 'delegated', threadId: 'th-x', channelId: WR, status: 'done' });
    await t.s.onMessage(bot(HQ, ['software'], 'th-x'));
    await t.s.idle();
    expect(t.runs).toHaveLength(0);
  });
});

describe('RF2 / G2RF-03: always-reply does not extend a bot exchange', () => {
  /** Each bot answers the previous message as a Discord reply (replyToId set to it), mentioning the next head, like the real always-reply path. */
  const chain = (th: string) => {
    let last = '';
    return async (trig: AgentTrigger, s: () => Scheduler): Promise<AgentOutcome> => {
      const i = ORDER.findIndex((a) => deptOf(a) === deptOf(trig.route.actor));
      if (deptOf(trig.route.actor) !== 'hq' || trig.instruction !== STALL_INSTRUCTION) {
        const m = bot(trig.route.actor, [deptOf(ORDER[(i + 1) % 3]!)], th, last ? { replyToId: last } : {});
        last = m.id;
        void s().onMessage(m);
      }
      return reply({ type: 'report', body: 'report: done' });
    };
  };

  it('replies between bots (replyToId set, repliedUser not counted) still end at the TW3 stall: one CEO turn, then routing stops', async () => {
    const t = await mk({ cfg: { 'warroom.stallTurns': 6 }, run: chain('th-r') });
    await t.s.onMessage(bot(HQ, ['software'], 'th-r'));
    for (let i = 0; i < 40; i++) await t.s.idle();
    expect(t.runs.filter((r) => r.instruction === STALL_INSTRUCTION)).toHaveLength(1);
    expect(t.runs.length).toBe(7);
    await t.s.onMessage(bot(CTO, ['finance'], 'th-r', { replyToId: 'm-0' }));
    await t.s.idle();
    expect(t.runs.length).toBe(7);
  });

  it('a reply to a bot message with no mention routes by TW2 continuation only in the warroom, never by the human reply route, and still ends at the TW1 thread cap', async () => {
    const t = await mk({ cfg: { 'warroom.turnsPerThreadPerHour': 3 }, run: chain('th-c') });
    await t.s.onMessage(bot(HQ, ['software'], 'th-c'));
    for (let i = 0; i < 40; i++) await t.s.idle();
    expect(t.runs.length).toBe(3);
    expect(t.runs.every((r) => r.route.reason !== 'reply')).toBe(true);
    expect(t.port.posts.filter((p) => p.target.channelId === BOT_LOG)).toHaveLength(1);
  });
});
