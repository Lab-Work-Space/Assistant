import { describe, expect, it, vi } from 'vitest';
import type { ActorRef } from '../../company/types.js';
import { Limits } from '../../governance/limits.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { FallbackGate } from '../../providers/fallback-gate.js';
import { FakeProvider, ProviderRegistry } from '../../providers/index.js';
import { FakeDiscordPort } from '../../tests/fakes/discordPort.js';
import type { AgentDeps, AgentOutcome, AgentTrigger } from '../loop/loop.js';
import { Scheduler } from './scheduler.js';
import { CTO, MemTasks, newBus, noApprovedTools, prompts, seededOrg } from '../test-helpers.js';

// R8 PROV-FALLBACK, BE2: the scheduler asks the one route function (isHeld, providerOk, mayRunAs) and re-offers a requeued task once.
const PRAW: ActorRef = { kind: 'head', dept: 'praw' };
const chat = (body: string): AgentOutcome => ({ payload: { type: 'chat', body }, costUsd: 0, turns: 1 });
const requeued = (): AgentOutcome => ({ ...chat('waits'), requeued: 'quota' });

async function mk(o: { enabled?: boolean; claude?: boolean; script?: AgentOutcome[] } = {}) {
  const cfg = new FakeConfig();
  await cfg.set('provider.default', { provider: 'claude-code-local', model: 'local/claude-sonnet-5-5' }, 'test');
  if (o.enabled !== false) await cfg.set('provider.fallback.enabled', true, 'test');
  const providers = new ProviderRegistry();
  providers.register(new FakeProvider([], 'gemini'));
  providers.register(new FakeProvider([], 'claude-code-local'));
  if (o.claude !== false) providers.register(new FakeProvider([], 'claude'));
  const tasks = new MemTasks();
  const port = new FakeDiscordPort();
  const bus = newBus();
  const runs: AgentTrigger[] = [];
  const script = [...(o.script ?? [])];
  const run = vi.fn(async (t: AgentTrigger) => { runs.push(t); return script.shift() ?? chat('ok'); });
  const org = await seededOrg({ editDept: (d) => (d.id === 'praw' ? { ...d, provider: 'gemini', model: 'gemini-3.8-flash' } : d) });
  const agent = { org, prompts, overrides: { getActive: async () => null }, providers, cfg } as unknown as AgentDeps;
  const hold = { until: 2_000_000 as number | null };
  const gate = new FallbackGate({ heldUntil: () => hold.until, now: () => 1_000_000 });
  const s = new Scheduler({
    agent, approvedTools: noApprovedTools, run, port, org, tasks, limits: new Limits(cfg, tasks), halt: { isHalted: () => false }, cfg, bus,
    log: { error: () => undefined }, now: () => 1_000_000, paused: () => false, providerReady: () => true, quotaHold: { heldUntil: () => hold.until }, fallback: gate,
  });
  s.attach();
  return { s, tasks, runs, run, hold, gate, cfg, bus };
}
const owners = (runs: AgentTrigger[]) => runs.map((r) => r.route.actor);

describe('R8 scheduler: isHeld asks the route function', () => {
  it('an eligible actor is not held during the hold when the switch is on and the key is registered; praw never is', async () => {
    const t = await mk();
    expect(await t.s.isHeld(CTO)).toBe(false);
    expect(await t.s.isHeld(PRAW)).toBe(false);
    t.hold.until = null;
    expect(await t.s.isHeld(CTO)).toBe(false);
  });
  it('held when the switch is off, the key is missing, or the gate blocks', async () => {
    expect(await (await mk({ enabled: false })).s.isHeld(CTO)).toBe(true);
    expect(await (await mk({ claude: false })).s.isHeld(CTO)).toBe(true);
    const t = await mk();
    t.gate.mark({ kind: 'api_off', status: 401 });
    expect(await t.s.isHeld(CTO)).toBe(true);
    expect(await t.s.isHeld(PRAW)).toBe(false);
  });
  it('without a fallback state the behaviour is today\'s: held while the hold is on', async () => {
    const t = await mk();
    const s2 = new Scheduler({ ...(t.s as unknown as { d: ConstructorParameters<typeof Scheduler>[0] }).d, fallback: undefined as never });
    expect(await s2.isHeld(CTO)).toBe(true);
  });
});

describe('R8 scheduler: runs during the hold', () => {
  it('an eligible owner\'s todo task runs during the hold; with the switch off it waits', async () => {
    const on = await mk();
    const task = await on.tasks.create({ title: 'Build it', deptId: 'software', owner: CTO, requester: PRAW, origin: 'delegated' });
    await on.s.onTaskReady(task.id);
    await on.s.idle();
    expect(owners(on.runs)).toEqual([CTO]);
    const off = await mk({ enabled: false });
    const t2 = await off.tasks.create({ title: 'Build it', deptId: 'software', owner: CTO, requester: PRAW, origin: 'delegated' });
    await off.s.onTaskReady(t2.id);
    await off.s.idle();
    expect(off.runs).toEqual([]);
    expect((await off.tasks.get(t2.id))?.status).toBe('todo');
  });
});

describe('R8 scheduler: the re-offer after a quota requeue (PV-C03)', () => {
  const owned = (t: Awaited<ReturnType<typeof mk>>) => t.tasks.create({ title: 'Build it', deptId: 'software', owner: CTO, requester: PRAW, origin: 'delegated' });

  it('re-offered once when the owner now resolves to the fallback route, and at most once per task per episode', async () => {
    const t = await mk({ script: [requeued(), requeued(), requeued()] });
    const task = await owned(t);
    await t.s.onTaskReady(task.id);
    await t.s.idle();
    expect(t.runs).toHaveLength(2); // the run and exactly one re-offer
  });

  it('a new episode (gate cleared) allows one more re-offer', async () => {
    const t = await mk({ script: [requeued(), requeued(), requeued(), requeued()] });
    const task = await owned(t);
    await t.s.onTaskReady(task.id);
    await t.s.idle();
    t.gate.clear();
    await t.s.onTaskReady(task.id);
    await t.s.idle();
    expect(t.runs).toHaveLength(4);
  });

  it('no re-offer when the route is not the fallback: switch off, no hold (a stale rejection), or a gate mark', async () => {
    const off = await mk({ enabled: false, script: [requeued()] });
    // the run itself is not started while held, so drive the outcome through a primary-route run
    off.hold.until = null;
    const t1 = await owned(off);
    await off.s.onTaskReady(t1.id);
    await off.s.idle();
    expect(off.runs).toHaveLength(1);

    const stale = await mk({ script: [requeued()] });
    stale.hold.until = null; // eventRejected true but heldUntil null: no hold
    const t2 = await owned(stale);
    await stale.s.onTaskReady(t2.id);
    await stale.s.idle();
    expect(stale.runs).toHaveLength(1);

    const marked = await mk({ script: [requeued()] });
    const t3 = await owned(marked);
    marked.run.mockImplementationOnce(async (tr: AgentTrigger) => { marked.runs.push(tr); marked.gate.mark({ kind: 'api_off', status: 401 }); return requeued(); });
    await marked.s.onTaskReady(t3.id);
    await marked.s.idle();
    expect(marked.runs).toHaveLength(1);
  });

  it('a run that was not requeued is never re-offered', async () => {
    const t = await mk({ script: [chat('done')] });
    const task = await owned(t);
    await t.s.onTaskReady(task.id);
    await t.s.idle();
    expect(t.runs).toHaveLength(1);
  });
});

describe('G2-PV-04: a task held by a per-task 400 is not re-offered', () => {
  it('resumeHeld and onTaskReady start no run for a taskOut task, and nothing is posted', async () => {
    const t = await mk();
    const task = await t.tasks.create({ title: 'Bad input', deptId: 'software', owner: CTO, requester: PRAW, origin: 'delegated' });
    t.gate.mark({ kind: 'task_400', taskId: task.id });
    await t.s.resumeHeld();
    await t.s.idle();
    await t.s.onTaskReady(task.id);
    await t.s.idle();
    expect(t.runs).toEqual([]);
    expect((await t.tasks.get(task.id))?.status).toBe('todo');
    const other = await t.tasks.create({ title: 'Fine', deptId: 'software', owner: CTO, requester: PRAW, origin: 'delegated' });
    await t.s.onTaskReady(other.id);
    await t.s.idle();
    expect(owners(t.runs)).toEqual([CTO]); // an unmarked task still runs
  });
});
