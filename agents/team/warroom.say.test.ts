import { describe, expect, it } from 'vitest';
import { AI_WARROOM_CHANNEL_ID as WR } from '../../company/channels.js';
import type { ActorRef, IncomingMessage } from '../../company/types.js';
import type { Task } from '../../db/repos/tasks.js';
import { Limits } from '../../governance/limits.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { FakeDiscordPort } from '../../tests/fakes/discordPort.js';
import { createConversation } from '../conversation.js';
import { runStartsTainted } from '../context.js';
import type { AgentDeps, AgentOutcome, AgentTrigger } from '../loop/loop.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { MemTasks, humanMsg, newBus, noApprovedTools, quiet, seededOrg } from '../test-helpers.js';

const A = (dept: string): ActorRef => ({ kind: 'head', dept } as ActorRef);
const HQ = A('software'); // the caller (a CEO mention is a goal, not a conversation, so the caller here is the CTO)
const FIN = A('finance');
const chat = (body = 'ok'): AgentOutcome => ({ payload: { type: 'chat', body }, costUsd: 0, turns: 1 });
const HUMAN_CHAN = '1565682159375749161';

type Rig = {
  scheduler: Scheduler; tasks: MemTasks & { findByThread(id: string): Promise<Task | null> }; port: FakeDiscordPort; bus: ReturnType<typeof newBus>; calls: AgentTrigger[]; agent: AgentDeps;
  recorded: [string, string, boolean, string | null][]; day: { off: boolean }; tick(ms: number): void; cfg: FakeConfig;
};
type Runner = (t: AgentTrigger, d: AgentDeps, r: Rig) => Promise<AgentOutcome>;

async function mk(o: { run?: Runner; sayWaitMs?: number; day?: { off: boolean }; provenance?: boolean } = {}): Promise<Rig> {
  const cfg = new FakeConfig({ 'warroom.stallTurns': 1000, 'warroom.turnsPerThreadPerHour': 1000, 'warroom.turnsPerHour': 1000 });
  const tasks = Object.assign(new MemTasks(), { findByThread: async (id: string): Promise<Task | null> => [...new MemTasks().rows.values()].find((t) => t.threadId === id) ?? null });
  tasks.findByThread = async (id) => [...tasks.rows.values()].find((t) => t.threadId === id) ?? null;
  const port = new FakeDiscordPort();
  port.snowflakes = true;
  const bus = newBus();
  const limits = new Limits(cfg, tasks);
  const conversation = createConversation({ tasks, port, limits, bus });
  const calls: AgentTrigger[] = [];
  const agent = {} as AgentDeps;
  const recorded: [string, string, boolean, string | null][] = [];
  const day = o.day ?? { off: false };
  let clock = 5_000_000;
  const self = {} as Rig;
  const scheduler = new Scheduler({
    agent, run: async (t, d) => (calls.push(t), o.run ? o.run(t, d, self) : chat()), port, org: await seededOrg(), tasks, limits, halt: { isHalted: () => false },
    cfg, bus, log: quiet, conversation, approvedTools: noApprovedTools, now: () => clock, ...(o.sayWaitMs ? { sayWaitMs: o.sayWaitMs } : {}),
    calendar: { isOffDay: () => (day.off ? { off: true, reason: 'weekday' } : { off: false }) },
    ...(o.provenance ? { provenance: { record: async (id: string, ch: string, tainted: boolean, user: string | null) => void recorded.push([id, ch, tainted, user]) } } : {}),
  });
  scheduler.attach();
  Object.assign(self, { scheduler, tasks, port, bus, calls, agent, recorded, day, tick: (ms: number) => void (clock += ms), cfg });
  return self;
}

/** The CEO's run on a person's message: opens its conversation and asks the CFO in the warroom. */
const ask = (text = 'Hi @CFO what is the Q3 budget?', over: { tainted?: boolean } = {}): Runner => async (t, d) => {
  if (t.msg?.author.kind === 'human') {
    const task = await d.conversation!.open({ actor: HQ, msg: t.msg, reason: 'mention' });
    const r = await d.warroomSay!.say({ actor: HQ, text, task, tainted: over.tainted ?? false });
    return chat(r.ok ? 'asked' : `refused: ${r.reason}`);
  }
  return chat('ok');
};
const person = (over: Partial<IncomingMessage> = {}) => humanMsg('CEO, ask the CFO about the budget', { channelId: HUMAN_CHAN, mentionedHeads: ['software'], ...over });
/** The echo of the warroom post, as the gateway delivers it to the CFO. */
const echo = (id: string, from: ActorRef = HQ, mentioned: string[] = ['finance']): IncomingMessage => ({
  id, channelId: WR, parentChannelId: null, threadId: null, author: { id: `bot-${from.kind === 'head' ? from.dept : 'x'}`, name: 'bot', kind: 'head', actor: from },
  content: '@CFO budget?', mentionedHeads: mentioned as never, isAdmin: false, attachments: [], origin: 'chat',
});
const postedSay = (r: Rig) => r.port.posts.find((p) => p.target.channelId === WR)!;
const conv = (r: Rig) => [...r.tasks.rows.values()].find((t) => t.conversation)!;

describe('LF1 warroom_say has a fixed, private destination', () => {
  it('posts in #ai-warroom as the caller, with no pinged users and the handle as written', async () => {
    const r = await mk({ run: ask() });
    await r.scheduler.onMessage(person());
    await r.scheduler.idle();
    const p = postedSay(r);
    expect(p).toMatchObject({ actor: HQ, target: { channelId: WR }, payload: { type: 'chat', body: 'Hi @CFO what is the Q3 budget?' } });
    expect(p.target.threadId).toBeUndefined();
    expect(p.opts?.mentionUserIds).toBeUndefined();
  });

  it('is refused (fail closed) when the warroom does not read as hidden from @everyone, and when the check throws', async () => {
    const r = await mk({ run: ask() });
    r.port.privateChannel.set(WR, false);
    await r.scheduler.onMessage(person());
    await r.scheduler.idle();
    expect(r.port.posts.some((p) => p.target.channelId === WR)).toBe(false);
    expect(r.port.posts.find((p) => p.payload.body.startsWith('refused:'))!.payload.body).toMatch(/not a private channel/);
    const t = await mk({ run: ask() });
    t.port.channelIsPrivate = async () => { throw new Error('boom'); };
    await t.scheduler.onMessage(person());
    await t.scheduler.idle();
    expect(t.port.posts.some((p) => p.target.channelId === WR)).toBe(false);
  });
});

describe('LF4 the warroom post carries the caller\'s taint', () => {
  it('is recorded with the run\'s taint and no person, and the receiving head\'s run starts tainted', async () => {
    const r = await mk({ run: ask('@CFO hi', { tainted: true }), provenance: true });
    await r.scheduler.onMessage(person());
    await r.scheduler.idle();
    const id = postedSay(r).id;
    expect(r.recorded.find((x) => x[0] === id)).toEqual([id, WR, true, null]);
    // a run triggered by a bot post with no task starts tainted; with a task, an unknown/tainted/other-person bot post in its history taints it
    expect(await runStartsTainted({ msg: echo(id), task: null, history: [] })).toBe(true);
    const clean = await runStartsTainted({ msg: humanMsg('x'), task: null, history: [echo(id)] }, async () => new Map([[id, { tainted: true, userId: null }]]));
    expect(clean).toBe(true);
  });
});

describe('LF5 guards are enforced in code at call time', () => {
  const refused = (r: Rig) => r.port.posts.find((p) => p.payload.body.startsWith('refused:'))?.payload.body ?? '';

  it('refused when the warroom pool is used up today', async () => {
    const r = await mk({ run: ask() });
    await r.bus.emit('governance.paused', { scope: 'warroom', day: '2026-11-03' });
    await r.scheduler.onMessage(person());
    await r.scheduler.idle();
    expect(refused(r)).toMatch(/quota for today is used up/);
    expect(r.port.posts.some((p) => p.target.channelId === WR)).toBe(false);
  });

  it('refused when the warroom conversation is stalled', async () => {
    const r = await mk({ run: ask() });
    r.cfg.set('warroom.stallTurns', 1, 'test');
    const g = (r.scheduler as unknown as { guard: { start(k: string, d: string): unknown } }).guard;
    g.start(WR, 'finance');
    g.start(WR, 'finance'); // the second consecutive bot turn stalls the room
    await r.scheduler.onMessage(person());
    await r.scheduler.idle();
    expect(refused(r)).toMatch(/stalled/);
  });

  it('refused on an off day', async () => {
    const r = await mk({ run: ask(), day: { off: true } });
    await r.scheduler.onMessage(person());
    await r.scheduler.idle();
    expect(refused(r)).toMatch(/off day/);
  });

  it('at most 10 posts per head per hour; the window moves on', async () => {
    const r = await mk();
    const say = () => r.agent.warroomSay!.say({ actor: HQ, text: '@CFO hi', task: null, tainted: false });
    for (let i = 0; i < 10; i++) expect((await say()).ok, `#${i}`).toBe(true);
    expect(await say()).toEqual({ ok: false, reason: 'warroom_say is limited to 10 calls per hour for each head' });
    expect((await r.agent.warroomSay!.say({ actor: FIN, text: '@CTO hi', task: null, tainted: false })).ok).toBe(true); // another head has its own window
    r.tick(3_600_001);
    expect((await say()).ok).toBe(true);
  });

  it('a persona cannot use it; the post counts in the warroom hourly total', async () => {
    const r = await mk();
    const persona: ActorRef = { kind: 'persona', personaId: 'system-analyst' };
    expect((await r.agent.warroomSay!.say({ actor: persona, text: '@CFO hi', task: null, tainted: false })).ok).toBe(false);
    const g = (r.scheduler as unknown as { guard: { all: number[] } }).guard;
    const before = g.all.length;
    await r.agent.warroomSay!.say({ actor: HQ, text: '@CFO hi', task: null, tainted: false });
    expect(g.all.length).toBe(before + 1);
  });

  it('LF6: the text is redacted before posting, and a post without a conversation says no summary follows', async () => {
    const r = await mk();
    const res = await r.agent.warroomSay!.say({ actor: HQ, text: '@CFO key sk-ant-abcdefgh12345678 ok', task: null, tainted: false });
    expect(res).toEqual({ ok: true, rollup: false });
    expect(postedSay(r).payload.body).not.toContain('sk-ant-abcdefgh12345678');
    expect(postedSay(r).payload.body).toContain('[REDACTED]');
  });
});

describe('LF7 one bounded roll-up per warroom message', () => {
  const rolled = (r: Rig) => r.calls.filter((c) => c.noWarroomSay);

  it('the CFO answers in the warroom, then the CEO summarises once in the person\'s channel as a reply to the person\'s message', async () => {
    const r = await mk({ run: async (t, d, rig) => (t.noWarroomSay ? chat('The CFO says 1M.') : t.route.actor.kind === 'head' && t.route.actor.dept === 'finance' ? chat('Budget is 1M') : ask()(t, d, rig)) });
    const m = person();
    await r.scheduler.onMessage(m);
    await r.scheduler.idle();
    const id = postedSay(r).id;
    const task = conv(r);
    expect(task.warroomSayId).toBe(id); // LF7: stored on the task
    expect(task.status).toBe('review'); // held open for the summary
    await r.scheduler.onMessage(echo(id));
    await r.scheduler.idle();
    expect(rolled(r)).toHaveLength(1);
    const run = rolled(r)[0]!;
    expect(run.route.actor).toEqual(HQ);
    expect(run.msg!.content).toContain('@CFO replied in #ai-warroom: Budget is 1M');
    expect(run.instruction).toMatch(/Do not start another warroom message/);
    expect(r.port.historyReaders.at(-1)).toEqual({ channelId: HUMAN_CHAN, reader: HQ }); // HIST-1: the say roll-up reads as the owner that summarises
    // LF3: the run and the task carry the taint of the bot text
    expect(r.tasks.rows.get(task.id)!.tainted).toBe(true);
    const summary = r.port.posts.find((p) => p.payload.body === 'The CFO says 1M.')!;
    expect(summary.target).toEqual({ channelId: HUMAN_CHAN });
    expect(summary.opts?.replyToId).toBe(m.id);
    expect(summary.opts?.mentionUserIds).toBeUndefined(); // LF6: no ping relay
    expect(r.tasks.rows.get(task.id)).toMatchObject({ status: 'done', warroomSayId: null });
  });

  it('the CFO\'s reply in the warroom is still posted there as usual', async () => {
    const r = await mk({ run: async (t, d, rig) => (t.route.actor.kind === 'head' && t.route.actor.dept === 'finance' ? chat('Budget is 1M') : ask()(t, d, rig)) });
    await r.scheduler.onMessage(person());
    await r.scheduler.idle();
    await r.scheduler.onMessage(echo(postedSay(r).id));
    await r.scheduler.idle();
    expect(r.port.posts.find((p) => p.payload.body === 'Budget is 1M')!.target).toEqual({ channelId: WR });
  });

  it('only the mentioned heads, answering that very message, count: another message and an unmentioned head are ignored; one summary carries both replies', async () => {
    const r = await mk({ sayWaitMs: 60_000, run: async (t, d, rig) => (t.msg?.author.kind === 'human' ? ask('@CFO and @R&D, budget?')(t, d, rig) : chat(`from ${t.route.actor.kind === 'head' ? t.route.actor.dept : 'x'}`)) });
    await r.scheduler.onMessage(person());
    await r.scheduler.idle();
    const id = postedSay(r).id;
    await r.scheduler.onMessage(echo('1570000000000009999')); // another warroom message to the CFO
    const note = (r.scheduler as unknown as { noteSayReply(m: IncomingMessage, a: ActorRef, o: AgentOutcome): void }).noteSayReply.bind(r.scheduler);
    note(echo(id), A('software'), chat('not awaited')); // the caller itself is not awaited
    note({ ...echo(id), id: '1570000000000008888' }, FIN, chat('wrong message'));
    await r.scheduler.idle();
    expect(rolled(r)).toHaveLength(0);
    await r.scheduler.onMessage(echo(id, HQ, ['finance', 'rnd']));
    await r.scheduler.idle();
    expect(rolled(r)).toHaveLength(1);
    expect(rolled(r)[0]!.msg!.content).toBe('@CFO replied in #ai-warroom: from finance\n@R&D replied in #ai-warroom: from rnd');
    note(echo(id), FIN, chat('again')); // a later reply never rolls up again
    await r.scheduler.idle();
    expect(rolled(r)).toHaveLength(1);
    r.scheduler.stop();
  });

  it('the wait ends after the timeout even when no head answers; a late answer changes nothing', async () => {
    const r = await mk({ sayWaitMs: 15, run: async (t, d, rig) => (t.noWarroomSay ? chat('nobody answered') : ask()(t, d, rig)) });
    await r.scheduler.onMessage(person());
    await r.scheduler.idle();
    await new Promise((res) => setTimeout(res, 60));
    await r.scheduler.idle();
    expect(rolled(r)).toHaveLength(1);
    expect(rolled(r)[0]!.msg!.content).toBe('(no head replied in #ai-warroom in time)');
    expect(r.port.posts.some((p) => p.payload.body === 'nobody answered')).toBe(true);
    await r.scheduler.onMessage(echo(postedSay(r).id));
    await r.scheduler.idle();
    expect(rolled(r)).toHaveLength(1);
    expect(conv(r).status).toBe('done');
  });

  it('after a restart the stored id is cleared and the conversation closes without a second summary', async () => {
    const r = await mk({ sayWaitMs: 60_000, run: ask() });
    await r.scheduler.onMessage(person());
    await r.scheduler.idle();
    expect(conv(r)).toMatchObject({ status: 'review' });
    r.scheduler.stop(); // the process ends: timers and replies in memory are gone
    const s2 = new Scheduler({
      agent: {} as AgentDeps, run: async (t) => (r.calls.push(t), chat()), port: r.port, org: await seededOrg(), tasks: r.tasks, limits: new Limits(r.cfg, r.tasks),
      halt: { isHalted: () => false }, cfg: r.cfg, bus: newBus(), log: quiet, approvedTools: noApprovedTools,
    });
    const before = r.calls.length;
    await s2.sweepReview();
    await s2.idle();
    expect(r.calls.length).toBe(before);
    expect(conv(r)).toMatchObject({ status: 'done', warroomSayId: null });
  });

  it('claim-once: the stored id can be taken by one caller only', async () => {
    const t = new MemTasks();
    const k = await t.create({ title: 'x', deptId: 'hq', owner: HQ, requester: { kind: 'human', userId: '1' }, origin: 'chat' });
    expect(await t.setWarroomSay(k.id, '1570000000000000001')).toBe(true);
    expect(await t.setWarroomSay(k.id, '1570000000000000002')).toBe(false);
    expect(await Promise.all([t.claimWarroomSay(k.id), t.claimWarroomSay(k.id)])).toEqual([true, false]);
  });
});

describe('F2 summary route', () => {
  it('a head asking from a task thread (not a conversation) just posts; the result says so', async () => {
    const r = await mk();
    const task = await r.tasks.create({ title: 't', deptId: 'hq', owner: HQ, requester: FIN, origin: 'delegated', threadId: 'th', channelId: HUMAN_CHAN });
    expect(await r.agent.warroomSay!.say({ actor: HQ, text: '@CFO hi', task, tainted: true })).toEqual({ ok: true, rollup: false });
  });
});
