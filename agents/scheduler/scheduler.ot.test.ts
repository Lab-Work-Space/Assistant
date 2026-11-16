import { describe, expect, it, vi } from 'vitest';
import type { ActorRef } from '../../company/types.js';
import type { Task } from '../../db/repos/tasks.js';
import type { HeldSummary, OtHook } from '../../governance/spend/ot.js';
import { Limits } from '../../governance/limits.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { FakeDiscordPort } from '../../tests/fakes/discordPort.js';
import type { AgentDeps, AgentOutcome, AgentTrigger } from '../loop/loop.js';
import { Scheduler } from './scheduler.js';
import { CTO, MemTasks, humanMsg, newBus, noApprovedTools, seededOrg } from '../test-helpers.js';

const HQ: ActorRef = { kind: 'head', dept: 'hq' };
const SA: ActorRef = { kind: 'persona', personaId: 'system-analyst' };
const PRAW: ActorRef = { kind: 'head', dept: 'praw' };
const SOFTWARE_WORK = '1565682159375749161';
const human = { kind: 'human', userId: '42' } as const;
const chat = (body: string): AgentOutcome => ({ payload: { type: 'chat', body }, costUsd: 0, turns: 1 });

type Tasks = MemTasks & { findByThread(id: string): Promise<Task | null> };
const memTasks = (): Tasks => {
  const tasks = new MemTasks() as Tasks;
  tasks.findByThread = async (id) => [...tasks.rows.values()].find((t) => t.threadId === id) ?? null;
  return tasks;
};

/**
 * An in-memory stand-in for the OtService with its observable semantics: one grant per tree (a new approval supersedes the old one), `usable` = unrevoked
 * and runs left, `consume` = one run, `raise` = one pending request per tree (a new one only after the grant is used up).
 */
class FakeOt implements OtHook {
  grants = new Map<string, { max: number; used: number; revoked: boolean; seq: number }>();
  consumed: string[] = [];
  raised: { rootId: string; held: HeldSummary }[] = [];
  pending = new Set<string>();
  throwOn = { usable: false, consume: false, raise: false };
  usableCalls = 0;
  async raise(root: Task, held: () => Promise<HeldSummary>): Promise<boolean> {
    if (this.throwOn.raise) throw new Error('raise boom');
    if (this.pending.has(root.id)) return true;
    const g = this.grants.get(root.id);
    if (g && !g.revoked && g.used < g.max) return false;
    this.pending.add(root.id);
    this.raised.push({ rootId: root.id, held: await held() });
    return true;
  }
  async usable(rootId: string): Promise<boolean> {
    this.usableCalls++;
    if (this.throwOn.usable) throw Object.assign(new Error('db secret text'), { code: '08006' });
    const g = this.grants.get(rootId);
    return !!g && !g.revoked && g.used < g.max;
  }
  async consume(rootId: string): Promise<boolean> {
    if (this.throwOn.consume) throw new Error('consume boom');
    const g = this.grants.get(rootId); // check and increment with no await between them: the real thing is one conditional UPDATE
    if (!g || g.revoked || g.used >= g.max) return false;
    g.used++;
    this.consumed.push(rootId);
    return true;
  }
  /** The approve click: supersedes, then the scheduler is told. */
  approve(rootId: string, max = 30): void {
    const old = this.grants.get(rootId);
    if (old) old.revoked = true;
    this.pending.delete(rootId);
    this.grants.set(rootId, { max, used: 0, revoked: false, seq: (old?.seq ?? 0) + 1 });
  }
}

async function mk(o: { tasks?: Tasks; ot?: FakeOt | null; halt?: { on: boolean }; approvedTools?: typeof noApprovedTools; run?: (t: AgentTrigger) => Promise<AgentOutcome> } = {}) {
  const cfg = new FakeConfig();
  const tasks = o.tasks ?? memTasks();
  const port = new FakeDiscordPort();
  const bus = newBus();
  const day = { off: true };
  const runs: AgentTrigger[] = [];
  const incidents: { source: string; stage: string; err: unknown }[] = [];
  const ot = o.ot === null ? undefined : o.ot ?? new FakeOt();
  // a real run moves its todo task on; the stand-in does the same so a finished task is not run again
  const run = vi.fn(o.run ?? (async (t: AgentTrigger) => {
    runs.push(t);
    if (t.task?.status === 'todo') await tasks.update(t.task.id, { status: 'done' }, 'todo');
    return chat('ok');
  }));
  const agent = {} as AgentDeps;
  const s = new Scheduler({
    agent, approvedTools: o.approvedTools ?? noApprovedTools, run, port, org: await seededOrg(), tasks, limits: new Limits(cfg, tasks),
    halt: { isHalted: () => o.halt?.on ?? false }, cfg, bus, log: { error: () => undefined }, now: () => 1_000_000,
    calendar: { isOffDay: () => (day.off ? { off: true, reason: 'weekday' } : { off: false }) },
    incidents: { report: (i) => (incidents.push(i), '') },
    ...(ot ? { ot } : {}),
  });
  s.attach();
  return { s, port, tasks, bus, runs, run, day, ot: ot as FakeOt, incidents, agent };
}
type Rig = Awaited<ReturnType<typeof mk>>;

const root = (t: Tasks, title = 'Root', thread = 'th-root') =>
  t.create({ title, deptId: 'hq', owner: HQ, requester: human, origin: 'chat', threadId: thread, channelId: 'ch-hq', status: 'doing' });
const kid = (t: Tasks, parentId: string, title = 'Kid') => t.create({ title, deptId: 'software', owner: SA, requester: HQ, origin: 'delegated', parentId, threadId: null });
const approve = async (r: Rig, rootId: string, max?: number) => {
  r.ot.approve(rootId, max);
  await r.bus.emit('ot.approved', { rootId });
  await r.s.idle();
};
const notices = (p: FakeDiscordPort) => p.posts.filter((x) => x.payload.type === 'chat' && x.payload.body.startsWith('⏸️'));

describe('OT-1 scheduler: releasing held work', () => {
  it('with no overtime nothing changes: a delegated task waits and one notice is posted', async () => {
    const r = await mk();
    const a = await root(r.tasks);
    await r.bus.emit('task.created', { task: await kid(r.tasks, a.id) });
    await r.s.idle();
    expect(r.run).not.toHaveBeenCalled();
    expect(r.ot.consumed).toEqual([]);
    expect(notices(r.port)).toHaveLength(1);
  });

  it('a grant releases only that tree: the second tree stays held (todo) and is not consumed for', async () => {
    const r = await mk();
    const a = await root(r.tasks, 'A', 'th-a');
    const b = await root(r.tasks, 'B', 'th-b');
    const ka = await kid(r.tasks, a.id, 'ka');
    const kb = await kid(r.tasks, b.id, 'kb');
    for (const k of [ka, kb]) await r.bus.emit('task.created', { task: k });
    await r.s.idle();
    expect(r.run).not.toHaveBeenCalled();
    await approve(r, a.id);
    expect(r.runs.map((x) => x.route.taskId)).toEqual([ka.id]);
    expect(r.ot.consumed).toEqual([a.id]);
    expect((await r.tasks.get(kb.id))!.status).toBe('todo');
    expect(r.ot.grants.has(b.id)).toBe(false);
  });

  it('OT-C8: five todo tasks and max_runs 3 start exactly 3 and leave 2 held', async () => {
    const r = await mk();
    const a = await root(r.tasks);
    const ks = await Promise.all([1, 2, 3, 4, 5].map((i) => kid(r.tasks, a.id, `k${i}`)));
    for (const k of ks) await r.bus.emit('task.created', { task: k });
    await r.s.idle();
    await approve(r, a.id, 3);
    expect(r.runs).toHaveLength(3);
    expect(r.ot.consumed).toHaveLength(3);
    const todo = (await r.tasks.listByStatus('todo')).map((t) => t.id);
    expect(todo).toHaveLength(2);
    expect(r.ot.grants.get(a.id)!.used).toBe(3);
  });

  it('OT-C12: an exhausted grant re-holds the next task and a new request is raised (once for several held tasks); approving it supersedes the first grant', async () => {
    const r = await mk();
    const a = await root(r.tasks);
    const ks = await Promise.all([1, 2, 3].map((i) => kid(r.tasks, a.id, `k${i}`)));
    for (const k of ks) await r.bus.emit('task.created', { task: k });
    await r.s.idle();
    expect(r.ot.raised).toHaveLength(1); // seq 1, once for three held tasks
    await approve(r, a.id, 1);
    expect(r.runs).toHaveLength(1);
    expect(r.ot.raised).toHaveLength(2); // the exhausted grant raised seq 2 (the other held tasks found it pending)
    expect(r.ot.pending.has(a.id)).toBe(true);
    await approve(r, a.id, 5); // seq 2 supersedes seq 1
    expect(r.ot.grants.get(a.id)).toMatchObject({ seq: 2, max: 5 });
    expect(r.runs).toHaveLength(3);
  });

  it('a held roll-up is tagged with its tree and released by that tree\'s grant only (consuming one run)', async () => {
    const r = await mk();
    const a = await root(r.tasks, 'A', 'th-a');
    const b = await root(r.tasks, 'B', 'th-b');
    for (const p of [a, b]) {
      const c = await r.tasks.create({ title: 'C', deptId: 'software', owner: SA, requester: HQ, origin: 'delegated', parentId: p.id, status: 'done' });
      await r.bus.emit('task.changed', { task: c, from: 'doing', to: 'done', summary: 'ok' });
    }
    await r.s.idle();
    expect(r.run).not.toHaveBeenCalled();
    expect(r.ot.raised.map((x) => x.rootId).sort()).toEqual([a.id, b.id].sort());
    expect(r.ot.raised[0]!.held.rollups).toBe(1);
    await approve(r, a.id);
    expect(r.runs.map((x) => x.route.taskId)).toEqual([a.id]);
    expect(r.ot.consumed).toEqual([a.id]);
  });

  it('with a live grant a roll-up starts at once (one run consumed, no hold) and an exhausted grant holds it again', async () => {
    const r = await mk();
    const a = await root(r.tasks);
    r.ot.approve(a.id, 1);
    const c1 = await r.tasks.create({ title: 'C1', deptId: 'software', owner: SA, requester: HQ, origin: 'delegated', parentId: a.id, status: 'done' });
    await r.bus.emit('task.changed', { task: c1, from: 'doing', to: 'done', summary: 'ok' });
    await r.s.idle();
    expect(r.runs.map((x) => x.route.taskId)).toEqual([a.id]);
    expect(r.ot.consumed).toEqual([a.id]);
    const c2 = await r.tasks.create({ title: 'C2', deptId: 'software', owner: SA, requester: HQ, origin: 'delegated', parentId: a.id, status: 'done' });
    await r.bus.emit('task.changed', { task: c2, from: 'doing', to: 'done', summary: 'ok' });
    await r.s.idle();
    expect(r.run).toHaveBeenCalledTimes(1); // exhausted: held, not started
    expect(r.ot.raised).toHaveLength(1); // and asked again
  });

  it('a stray ot.approved with no grant starts nothing (every start is consume-gated)', async () => {
    const r = await mk();
    const a = await root(r.tasks);
    await r.bus.emit('task.created', { task: await kid(r.tasks, a.id) });
    await r.s.idle();
    await r.bus.emit('ot.approved', { rootId: a.id });
    await r.s.idle();
    expect(r.run).not.toHaveBeenCalled();
    expect(r.ot.consumed).toEqual([]);
  });

  it('a release on a workday (or while halted) does nothing', async () => {
    const halt = { on: false };
    const r = await mk({ halt });
    const a = await root(r.tasks);
    await r.bus.emit('task.created', { task: await kid(r.tasks, a.id) });
    await r.s.idle();
    halt.on = true;
    await approve(r, a.id);
    expect(r.run).not.toHaveBeenCalled();
    expect(r.ot.consumed).toEqual([]);
  });
});

describe('OT-1 OT-C3: consume before anything with an effect', () => {
  const claimSpy = () => {
    const claim = vi.fn(async () => [] as never[]);
    return { claim, tools: { ...noApprovedTools, claim } as typeof noApprovedTools };
  };

  it('an exhausted grant never reaches the approved tool calls: claim is not called and the task stays todo', async () => {
    const { claim, tools } = claimSpy();
    const r = await mk({ approvedTools: tools });
    const a = await root(r.tasks);
    const k = await kid(r.tasks, a.id);
    r.ot.approve(a.id, 1);
    r.ot.grants.get(a.id)!.used = 1;
    await r.s.onTaskReady(k.id);
    await r.s.idle();
    expect(claim).not.toHaveBeenCalled();
    expect(r.run).not.toHaveBeenCalled();
    expect((await r.tasks.get(k.id))!.status).toBe('todo');
  });

  it('a live grant: claim called once and one run consumed', async () => {
    const { claim, tools } = claimSpy();
    const r = await mk({ approvedTools: tools });
    const a = await root(r.tasks);
    const k = await kid(r.tasks, a.id);
    r.ot.approve(a.id, 3);
    await r.s.onTaskReady(k.id);
    await r.s.idle();
    expect(claim).toHaveBeenCalledTimes(1);
    expect(r.ot.grants.get(a.id)!.used).toBe(1);
    expect(r.runs).toHaveLength(1);
  });

  it('the gate is read only and the run is taken at the start: repeated recovery passes on a held task consume nothing, and a task that already ran is not consumed for again', async () => {
    const r = await mk();
    const a = await root(r.tasks);
    const k = await kid(r.tasks, a.id);
    for (let i = 0; i < 3; i++) { await r.s.onTaskReady(k.id); await r.s.idle(); }
    expect(r.ot.consumed).toEqual([]);
    r.ot.approve(a.id, 5);
    await r.s.onTaskReady(k.id);
    await r.s.idle();
    expect(r.ot.consumed).toHaveLength(1);
    await r.s.onTaskReady(k.id); // the task is no longer todo
    await r.s.idle();
    expect(r.ot.consumed).toHaveLength(1);
    expect(r.run).toHaveBeenCalledTimes(1);
  });

  it('a human-origin task on an off day runs without touching the grant', async () => {
    const r = await mk();
    const h = await r.tasks.create({ title: 'H', deptId: 'software', owner: CTO, requester: human, origin: 'chat', threadId: 'th-h' });
    r.ot.approve(h.rootId, 1);
    await r.s.onTaskReady(h.id);
    await r.s.idle();
    expect(r.run).toHaveBeenCalledTimes(1);
    expect(r.ot.consumed).toEqual([]);
  });
});

describe('OT-1 OT-C2: roll-ups from settleReview and the sweeps consume too', () => {
  const reviewRoot = async (t: Tasks) => {
    const parent = await t.create({ title: 'Chat', deptId: 'praw', owner: PRAW, requester: human, origin: 'chat', threadId: 'th-c', channelId: 'c-praw', status: 'review' });
    await t.create({ title: 'Child', deptId: 'software', owner: CTO, requester: PRAW, origin: 'delegated', parentId: parent.id, status: 'done' });
    return parent;
  };

  it('(i) a live grant and a review task whose last child is done: one roll-up and one run consumed; (iii) a second sweep consumes nothing more', async () => {
    const r = await mk();
    const parent = await reviewRoot(r.tasks);
    r.ot.approve(parent.rootId, 5);
    await r.s.sweepReview();
    await r.s.idle();
    expect(r.runs.map((x) => x.route.taskId)).toEqual([parent.id]);
    expect(r.ot.consumed).toEqual([parent.rootId]);
    await r.s.sweepReview();
    await r.s.idle();
    expect(r.ot.consumed).toHaveLength(1);
    expect(r.run).toHaveBeenCalledTimes(1);
  });

  it('(ii) an exhausted grant: no roll-up, no run, the task stays in review', async () => {
    const r = await mk();
    const parent = await reviewRoot(r.tasks);
    r.ot.approve(parent.rootId, 1);
    r.ot.grants.get(parent.rootId)!.used = 1;
    await r.s.sweepReview();
    await r.s.idle();
    expect(r.run).not.toHaveBeenCalled();
    expect((await r.tasks.get(parent.id))!.status).toBe('review');
  });

  it('with no grant the sweep leaves the review task alone, as before OT', async () => {
    const r = await mk();
    const parent = await reviewRoot(r.tasks);
    await r.s.sweepReview();
    await r.s.idle();
    expect(r.run).not.toHaveBeenCalled();
    expect((await r.tasks.get(parent.id))!.status).toBe('review');
  });

  it('a restart with a live grant: the recovery pass runs the todo task and recovers the roll-up, each consuming one run', async () => {
    const tasks = memTasks();
    const ot = new FakeOt();
    const first = await mk({ tasks, ot });
    const a = await root(tasks, 'A', 'th-a');
    const k = await kid(tasks, a.id);
    const parent = await tasks.create({ title: 'Chat', deptId: 'praw', owner: PRAW, requester: human, origin: 'chat', threadId: 'th-c', channelId: 'c-praw', status: 'review' });
    await tasks.create({ title: 'Child', deptId: 'software', owner: CTO, requester: PRAW, origin: 'delegated', parentId: parent.id, status: 'done' });
    ot.approve(a.id, 5);
    ot.approve(parent.rootId, 5);
    first.s.stop(); // the process stops: in-memory held items are lost, the grants persist
    const t = await mk({ tasks, ot });
    for (const x of await tasks.listByStatus('todo')) void t.s.onTaskReady(x.id);
    await t.s.sweepReview();
    await t.s.idle();
    expect(t.runs.map((x) => x.route.taskId).sort()).toEqual([k.id, parent.id].sort());
    expect(ot.consumed.sort()).toEqual([a.id, parent.rootId].sort());
  });
});

describe('OT-1 OT-C5: bot talk held by the guard', () => {
  const botIn = (thread: string, from: ActorRef) =>
    humanMsg('<@111> over to you', { mentionedHeads: ['software'], channelId: thread, threadId: thread, parentChannelId: SOFTWARE_WORK, author: { id: 'bot-x', name: 'x', kind: from.kind, actor: from } as never });

  it('a bot message from tree A into tree B\'s task thread is held and tagged B: the grant of A does not start it, the grant of B does (one run)', async () => {
    const r = await mk();
    const a = await root(r.tasks, 'A', 'th-a');
    const b = await root(r.tasks, 'B', 'th-b');
    await r.tasks.create({ title: 'kb', deptId: 'software', owner: CTO, requester: HQ, origin: 'delegated', parentId: b.id, threadId: 'th-kb', status: 'doing' });
    await r.s.onMessage(botIn('th-kb', HQ)); // sender context is irrelevant: the tag is the target task's root
    await r.s.idle();
    expect(r.run).not.toHaveBeenCalled();
    await approve(r, a.id);
    expect(r.run).not.toHaveBeenCalled();
    expect(r.ot.consumed).toEqual([]);
    await approve(r, b.id);
    expect(r.runs).toHaveLength(1);
    expect(r.ot.consumed).toEqual([b.id]);
  });

  it('with a live grant a bot message into a delegated task thread starts at once through a consumed run', async () => {
    const r = await mk();
    const b = await root(r.tasks, 'B', 'th-b');
    await r.tasks.create({ title: 'kb', deptId: 'software', owner: CTO, requester: HQ, origin: 'delegated', parentId: b.id, threadId: 'th-kb', status: 'doing' });
    r.ot.approve(b.id, 2);
    await r.s.onMessage(botIn('th-kb', HQ));
    await r.s.idle();
    expect(r.runs).toHaveLength(1);
    expect(r.ot.consumed).toEqual([b.id]);
  });

  it('bot talk with no task is never tagged and never released by a grant', async () => {
    const r = await mk();
    const a = await root(r.tasks);
    await r.s.onMessage(botIn('th-none', HQ));
    await r.s.idle();
    await approve(r, a.id);
    expect(r.run).not.toHaveBeenCalled();
    const guard = (r.s as unknown as { guard: { heldCount(): number } }).guard;
    expect(guard.heldCount()).toBe(1);
  });

  it('warroom_say is still refused on an off day, even with a live grant', async () => {
    const r = await mk();
    const a = await root(r.tasks);
    r.ot.approve(a.id, 5);
    const res = await r.agent.warroomSay!.say({ actor: CTO, text: 'hello', task: a, tainted: false });
    expect(res).toMatchObject({ ok: false, reason: expect.stringMatching(/off day/) });
  });

  it('rhythm and meetings keep the raw off-day answer, grant or not', async () => {
    const r = await mk();
    const a = await root(r.tasks);
    r.ot.approve(a.id, 5);
    const priv = r.s as unknown as { rhythmHost(): { offDay(): boolean }; meetingHost(): { offDay(): boolean } };
    expect(priv.rhythmHost().offDay()).toBe(true);
    expect(priv.meetingHost().offDay()).toBe(true);
  });
});

describe('OT-1 OT-C14 / OT-C15: faults and the notice', () => {
  it('OT-C14: a raise that throws still posts the one off-day notice (no OT line)', async () => {
    const r = await mk();
    r.ot.throwOn.raise = true;
    const a = await root(r.tasks);
    await r.bus.emit('task.created', { task: await kid(r.tasks, a.id) });
    await r.s.idle();
    const n = notices(r.port);
    expect(n).toHaveLength(1);
    expect((n[0]!.payload as { body: string }).body).not.toContain('OT');
  });

  it('a pending request adds the line to the notice; still once per root per day', async () => {
    const r = await mk();
    const a = await root(r.tasks);
    await r.bus.emit('task.created', { task: await kid(r.tasks, a.id) });
    await r.bus.emit('task.created', { task: await kid(r.tasks, a.id, 'k2') });
    await r.s.idle();
    const n = notices(r.port);
    expect(n).toHaveLength(1);
    expect((n[0]!.payload as { body: string }).body).toContain('ส่งคำขอ OT ให้ Bot Admin แล้ว');
    expect((n[0]!.payload as { body: string }).body).toContain('⏸️');
  });

  it('the raise is handed what is held (counts and department names)', async () => {
    const r = await mk();
    const a = await root(r.tasks);
    await kid(r.tasks, a.id);
    await r.tasks.create({ title: 'k2', deptId: 'hq', owner: CTO, requester: HQ, origin: 'delegated', parentId: a.id });
    await r.s.onTaskReady((await r.tasks.listByStatus('todo'))[0]!.id);
    await r.s.idle();
    expect(r.ot.raised[0]!.held.tasks).toBe(2);
    expect(r.ot.raised[0]!.held.depts).toHaveLength(2);
  });

  it('OT-C15: a fault in the usable check keeps the work held (nothing runs, nothing consumed) and reports a fixed text with the SQLSTATE only', async () => {
    const r = await mk();
    const a = await root(r.tasks);
    const k = await kid(r.tasks, a.id);
    r.ot.approve(a.id, 5);
    r.ot.throwOn.usable = true;
    await r.s.onTaskReady(k.id);
    await r.s.idle();
    expect(r.run).not.toHaveBeenCalled();
    expect(r.ot.consumed).toEqual([]);
    expect((await r.tasks.get(k.id))!.status).toBe('todo');
    expect(r.incidents.length).toBeGreaterThan(0);
    const msg = String((r.incidents[0]!.err as Error).message);
    expect(msg).toContain('08006');
    expect(msg).not.toContain('db secret text');
  });

  it('OT-C15: a fault in consume starts nothing and is reported', async () => {
    const r = await mk();
    const a = await root(r.tasks);
    const k = await kid(r.tasks, a.id);
    r.ot.approve(a.id, 5);
    r.ot.throwOn.consume = true;
    await r.s.onTaskReady(k.id);
    await r.s.idle();
    expect(r.run).not.toHaveBeenCalled();
    expect((await r.tasks.get(k.id))!.status).toBe('todo');
    expect(r.incidents.some((i) => i.stage === 'consume')).toBe(true);
  });

  it('a scheduler without the overtime dependency behaves exactly as before (held, no throw)', async () => {
    const r = await mk({ ot: null });
    const a = await root(r.tasks);
    await r.bus.emit('task.created', { task: await kid(r.tasks, a.id) });
    await r.bus.emit('ot.approved', { rootId: a.id });
    await r.s.idle();
    expect(r.run).not.toHaveBeenCalled();
    expect(notices(r.port)).toHaveLength(1);
  });

  it('the workday still releases everything as before (dayTurned unchanged)', async () => {
    const r = await mk();
    const a = await root(r.tasks);
    const c = await r.tasks.create({ title: 'C', deptId: 'software', owner: SA, requester: HQ, origin: 'delegated', parentId: a.id, status: 'done' });
    await r.bus.emit('task.changed', { task: c, from: 'doing', to: 'done', summary: 'ok' });
    await r.s.idle();
    r.day.off = false;
    r.s.dayTurned();
    await r.s.idle();
    expect(r.runs.map((x) => x.route.taskId)).toEqual([a.id]);
    expect(r.ot.consumed).toEqual([]);
  });
});

describe('Gate 2 G2OT-02: a re-hold after a failed consume never overwrites a newer start', () => {
  it('a newer bot start held on the same thread while the consume ran stays; the released one is dropped', async () => {
    const r = await mk();
    const b = await root(r.tasks, 'B', 'th-b');
    const guard = (r.s as unknown as { guard: { hold(k: string, s: () => void, root?: string): boolean; heldCountFor(root: string): number; releaseHeldFor(root: string): { key: string }[] } }).guard;
    const older = vi.fn();
    const newer = vi.fn();
    guard.hold('thread-1', older, b.id);
    r.ot.approve(b.id, 1);
    r.ot.consume = async () => { guard.hold('thread-1', newer, b.id); return false; }; // consume fails; a newer start lands meanwhile
    await r.bus.emit('ot.approved', { rootId: b.id });
    await r.s.idle();
    const left = guard.releaseHeldFor(b.id);
    expect(left).toHaveLength(1);
    (left[0] as unknown as { start(): void }).start();
    expect(newer).toHaveBeenCalledOnce();
    expect(older).not.toHaveBeenCalled();
  });
});
