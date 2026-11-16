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

/** The race: `usable` (read only) says yes, then the grant is gone by the time `consume` (the conditional UPDATE) runs. */
class RacyOt implements OtHook {
  consumeCalls = 0;
  raised = 0;
  async raise(_root: Task, _held: () => Promise<HeldSummary>): Promise<boolean> { this.raised++; return true; }
  async usable(): Promise<boolean> { return true; }
  async consume(): Promise<boolean> { this.consumeCalls++; return false; }
}
type FakeOt = RacyOt;

async function mk(o: { tasks?: Tasks; ot?: RacyOt | null; halt?: { on: boolean }; approvedTools?: typeof noApprovedTools; run?: (t: AgentTrigger) => Promise<AgentOutcome> } = {}) {
  const cfg = new FakeConfig();
  const tasks = o.tasks ?? memTasks();
  const port = new FakeDiscordPort();
  const bus = newBus();
  const day = { off: true };
  const runs: AgentTrigger[] = [];
  const incidents: { source: string; stage: string; err: unknown }[] = [];
  const ot = o.ot === null ? undefined : o.ot ?? new RacyOt();
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
  return { s, port, tasks, bus, runs, run, day, ot: ot as RacyOt, incidents, agent };
}
type Rig = Awaited<ReturnType<typeof mk>>;

const root = (t: Tasks, title = 'Root', thread = 'th-root') =>
  t.create({ title, deptId: 'hq', owner: HQ, requester: human, origin: 'chat', threadId: thread, channelId: 'ch-hq', status: 'doing' });
const kid = (t: Tasks, parentId: string, title = 'Kid') => t.create({ title, deptId: 'software', owner: SA, requester: HQ, origin: 'delegated', parentId, threadId: null });
const notices = (p: FakeDiscordPort) => p.posts.filter((x) => x.payload.type === 'chat' && x.payload.body.startsWith('⏸️'));

describe('OT-1 tester: usable says yes, consume says no (the race between the read-only gate and the run)', () => {
  it('a roll-up whose consume fails is not started and stays held (OT-C2: consume first, start only on success)', async () => {
    const r = await mk();
    const a = await root(r.tasks);
    const c1 = await r.tasks.create({ title: 'C1', deptId: 'software', owner: SA, requester: HQ, origin: 'delegated', parentId: a.id, status: 'done' });
    await r.bus.emit('task.changed', { task: c1, from: 'doing', to: 'done', summary: 'ok' });
    await r.s.idle();
    expect(r.ot.consumeCalls).toBeGreaterThan(0);
    expect(r.run).not.toHaveBeenCalled();
  });

  it('a todo delegated task whose consume fails does not run and stays todo', async () => {
    const r = await mk();
    const a = await root(r.tasks);
    const k = await kid(r.tasks, a.id);
    await r.s.onTaskReady(k.id);
    await r.s.idle();
    expect(r.ot.consumeCalls).toBeGreaterThan(0);
    expect(r.run).not.toHaveBeenCalled();
    expect((await r.tasks.get(k.id))!.status).toBe('todo');
  });
});
