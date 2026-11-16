import { describe, expect, it, vi } from 'vitest';
import type { ActorRef } from '../../company/types.js';
import type { Task } from '../../db/repos/tasks.js';
import type { ToolClaim, ToolDelivery } from '../../governance/approval/approvals.js';
import { Limits } from '../../governance/limits.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { FakeDiscordPort } from '../../tests/fakes/discordPort.js';
import type { ToolResult } from '../../tools/types.js';
import { BOT_LOG_CHANNEL_ID } from '../../discord/index.js';
import type { ApprovedTools } from './approved-tools.js';
import { firstTurn } from '../context.js';
import type { AgentDeps, AgentOutcome, AgentTrigger } from './loop.js';
import { runAgent } from './loop.js';
import { owned, respond, route, setup } from './loop-fixture.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { CTO, MemTasks, newBus, noApprovedTools, quiet, seededOrg } from '../test-helpers.js';
import { RESULT_MAX, resultText, safeSlice } from './approved-tools.js';

const chat = (body: string): AgentOutcome => ({ payload: { type: 'chat', body }, costUsd: 0, turns: 1 });
const runClaim = (approvalId: number, input: unknown, name = 'stub_write'): ToolClaim => ({ kind: 'run', approvalId, name, input, claimedAt: `c${approvalId}` });
const refused = (approvalId: number, why: 'rejected' | 'expired' | 'digest_mismatch', name = 'stub_write'): ToolClaim => ({ kind: 'refused', approvalId, name, why, claimedAt: `c${approvalId}` });

/**
 * A fake ApprovedTools port over an in-memory approvals table: claim() hands out the scripted batches once each (like the
 * atomic executed_at claim), store()/pending()/delivered() keep each outcome until the owner's model turn starts.
 */
function fakeTools(batches: ToolClaim[][], result: (c: { name: string; input: unknown }) => Promise<ToolResult> = async () => ({ content: 'wrote it' })) {
  const order: string[] = [];
  const claimed: ToolClaim[] = [];
  const stored = new Map<number, string>();
  const seen = new Set<number>();
  let i = 0;
  const port = {
    claim: vi.fn(async (_taskId: string) => {
      order.push('claim');
      const b = batches[i++] ?? [];
      claimed.push(...b);
      return b;
    }),
    run: vi.fn(async (_actor: ActorRef, _task: Task, c: { name: string; input: unknown }) => (order.push('run'), result(c))),
    store: vi.fn(async (c: ToolClaim, text: string) => void stored.set(c.approvalId, text)),
    unclaim: vi.fn(async (c: ToolClaim) => void claimed.splice(claimed.indexOf(c), 1)),
    pending: vi.fn(async (_taskId: string): Promise<ToolDelivery[]> =>
      claimed.filter((c) => !seen.has(c.approvalId)).map((c) => ({
        approvalId: c.approvalId, name: c.name,
        ...(c.kind === 'refused' ? { state: c.why, text: null } : stored.has(c.approvalId) ? { state: 'result' as const, text: stored.get(c.approvalId)! } : { state: 'interrupted' as const, text: null }),
      }))),
    delivered: vi.fn(async (ids: number[]) => void ids.forEach((x) => seen.add(x))),
  } satisfies ApprovedTools;
  return { port, order, stored };
}

/** `start(n)`: whether the n-th owner run (0-based) reaches its first provider call (default: every run does). */
async function mk(o: { approvedTools?: ApprovedTools; halted?: () => boolean; order?: string[]; start?: (n: number) => boolean } = {}) {
  const cfg = new FakeConfig();
  const tasks = new MemTasks() as MemTasks & { findByThread(id: string): Promise<Task | null> };
  tasks.findByThread = async (id) => [...tasks.rows.values()].find((t) => t.threadId === id) ?? null;
  const port = new FakeDiscordPort();
  const runs: AgentTrigger[] = [];
  const run = vi.fn(async (t: AgentTrigger) => {
    o.order?.push('model');
    if (o.start?.(runs.length) ?? true) await t.onModelStart?.();
    runs.push(t);
    return chat('ok');
  });
  const s = new Scheduler({
    agent: {} as AgentDeps, run, port, org: await seededOrg(), tasks, limits: new Limits(cfg, tasks),
    halt: { isHalted: o.halted ?? (() => false) }, cfg, bus: newBus(), log: quiet, approvedTools: o.approvedTools ?? noApprovedTools,
  });
  s.attach();
  const task = await tasks.create({ title: 'Write it', deptId: 'software', owner: CTO, requester: { kind: 'human', userId: '42' }, origin: 'schedule', threadId: 'th-1' });
  return { s, port, tasks, runs, run, task };
}

describe('resume (R4)', () => {
  it('resume › approved tool call executes once from the stored input, result reaches the owner run as untrusted context', async () => {
    const f = fakeTools([[runClaim(7, { title: 'Stored' })]]);
    const t = await mk({ approvedTools: f.port, order: f.order });
    await t.s.onTaskReady(t.task.id);
    await t.s.idle();
    expect(f.port.claim).toHaveBeenCalledWith(t.task.id);
    expect(f.port.run).toHaveBeenCalledTimes(1);
    expect(f.port.run.mock.calls[0]![2]).toEqual({ name: 'stub_write', input: { title: 'Stored' } });
    const trig = t.runs[0]!;
    expect(trig.approvedResults).toHaveLength(1);
    expect(trig.approvedResults![0]).toContain('wrote it');
    const text = JSON.stringify(firstTurn({ context: '', history: [], approvedResults: trig.approvedResults! }));
    expect(text).toContain('Approved tool results:');
    expect(text).toMatch(/<untrusted-[0-9a-f]+ source=\\"approved-tool\\"/);
  });

  it('contract (b): the claim and the stored call run before the owner model turn', async () => {
    const f = fakeTools([[runClaim(1, { title: 'A' }), runClaim(2, { title: 'B' })]]);
    const t = await mk({ approvedTools: f.port, order: f.order });
    await t.s.onTaskReady(t.task.id);
    await t.s.idle();
    expect(f.order).toEqual(['claim', 'run', 'run', 'model']);
    expect(f.port.run.mock.calls.map((c) => c[2].input)).toEqual([{ title: 'A' }, { title: 'B' }]); // approval order
    expect(f.port.run.mock.calls[0]![1].id).toBe(t.task.id);
    expect(f.port.run.mock.calls[0]![0]).toEqual(CTO); // runs as the task owner
  });

  it('contract (b): approved results taint the owner run (an unknown url afterwards still needs approval)', async () => {
    let seen: boolean | undefined;
    const s = await setup({ script: [{ toolUses: [{ name: 'probe_taint', input: {} }] }, { toolUses: [respond('done')] }] });
    s.deps.tools.register({ name: 'probe_taint', description: 'p', inputSchema: (await import('zod')).z.object({}), requiresApproval: () => false, run: async (_i, c) => ((seen = c.tainted()), { content: 'x' }) });
    s.deps.org.toolsFor = () => ['probe_taint', 'respond'];
    const task = await owned(s.tasks, CTO);
    await runAgent({ route: route(CTO), task, history: [], approvedResults: ['Approval #1 fetch_page ran:\npage'] }, s.deps);
    expect(seen).toBe(true);
  });

  it('resume › halted → nothing executes (D9): no claim while the scheduler cannot run', async () => {
    const f = fakeTools([[runClaim(1, { title: 'A' })]]);
    const t = await mk({ approvedTools: f.port, halted: () => true });
    await t.s.onTaskReady(t.task.id);
    await t.s.idle();
    expect(f.port.claim).not.toHaveBeenCalled();
    expect(f.port.run).not.toHaveBeenCalled();
  });

  it('contract (a): a halt that lands after the claim un-claims the refused call and every later one; no owner run', async () => {
    const f = fakeTools([[runClaim(1, { title: 'A' }), runClaim(2, { title: 'B' }), runClaim(3, { title: 'C' })]], async (c) =>
      (c.input as { title: string }).title === 'A' ? { content: 'wrote A' } : { content: 'halted', isError: true, notRun: 'halted' });
    const t = await mk({ approvedTools: f.port });
    await t.s.onTaskReady(t.task.id);
    await t.s.idle();
    expect(f.port.run).toHaveBeenCalledTimes(2); // A ran, B refused halted, C never tried
    expect(f.port.unclaim.mock.calls.map((c) => c[0].approvalId)).toEqual([2, 3]);
    expect(t.run).not.toHaveBeenCalled();
    expect((await t.tasks.get(t.task.id))!.status).toBe('todo'); // /resume schedules every todo task again
  });

  it('contract (d): rejected and expired approvals execute nothing and the owner run is told, one line each', async () => {
    const f = fakeTools([[refused(1, 'rejected'), refused(2, 'expired')]]);
    const t = await mk({ approvedTools: f.port });
    await t.s.onTaskReady(t.task.id);
    await t.s.idle();
    expect(f.port.run).not.toHaveBeenCalled();
    const notes = t.runs[0]!.approvalNotices!;
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatch(/#1.*stub_write.*rejected.*did not run/);
    expect(notes[1]).toMatch(/#2.*stub_write.*expired.*did not run/);
    expect(JSON.stringify(firstTurn({ context: '', history: [], approvalNotices: notes }))).toContain('Approval notices:');
  });

  it('contract (c): a digest mismatch posts a governance alert and the owner run is told it could not run', async () => {
    const f = fakeTools([[refused(4, 'digest_mismatch', 'delete_item')]]);
    const t = await mk({ approvedTools: f.port });
    await t.s.onTaskReady(t.task.id);
    await t.s.idle();
    expect(f.port.run).not.toHaveBeenCalled();
    const alert = t.port.posts.find((p) => p.target.channelId === BOT_LOG_CHANNEL_ID && p.payload.type === 'alert');
    expect(alert).toMatchObject({ actor: { kind: 'head', dept: 'hq' }, payload: { origin: 'governance', title: 'Approval integrity check failed' } });
    expect(alert!.payload.body).toContain('#4');
    expect(alert!.payload.body).toContain(t.task.id);
    expect(t.runs[0]!.approvalNotices![0]).toMatch(/#4.*delete_item.*could not run/);
  });

  it('exceptions never block the owner run: a failing claim or a throwing call still runs the owner', async () => {
    const throwing = { ...noApprovedTools, claim: vi.fn(async () => Promise.reject(new Error('db down'))), pending: vi.fn(async () => Promise.reject(new Error('db down'))) };
    const a = await mk({ approvedTools: throwing });
    await a.s.onTaskReady(a.task.id);
    await a.s.idle();
    expect(a.run).toHaveBeenCalledTimes(1);

    const f = fakeTools([[runClaim(9, { title: 'A' })]], async () => Promise.reject(new Error('boom')));
    const b = await mk({ approvedTools: f.port });
    await b.s.onTaskReady(b.task.id);
    await b.s.idle();
    expect(b.run).toHaveBeenCalledTimes(1);
    expect(f.port.unclaim).not.toHaveBeenCalled(); // it may have run: stays consumed (fail closed)
    expect(b.runs[0]!.approvedResults![0]).toMatch(/#9.*could not run.*not run again/);
  });

  it('a human message in the thread right after approval also runs the claimed call first (owner only)', async () => {
    const f = fakeTools([[runClaim(5, { title: 'A' })]]);
    const t = await mk({ approvedTools: f.port });
    const { humanMsg } = await import('../test-helpers.js');
    await t.s.onMessage(humanMsg('go on', { channelId: 'th-1', threadId: 'th-1', parentChannelId: '1565682159375749161' }));
    await t.s.idle();
    expect(f.port.run).toHaveBeenCalledTimes(1);
    expect(t.runs[0]!.approvedResults).toHaveLength(1);
  });

  it('results stay pending when the owner run stops before its first model call, then reach a model turn exactly once', async () => {
    const f = fakeTools([[runClaim(3, { title: 'A' }), refused(4, 'rejected')]]);
    const t = await mk({ approvedTools: f.port, start: (n) => n > 0 }); // run 0: e.g. budget refused before any provider call
    for (let n = 0; n < 3; n++) {
      await t.s.onTaskReady(t.task.id);
      await t.s.idle();
    }
    expect(f.port.run).toHaveBeenCalledTimes(1); // executed once, never again
    expect(t.runs.map((r) => r.approvedResults?.length ?? 0)).toEqual([1, 1, 0]);
    expect(t.runs.map((r) => r.approvalNotices?.length ?? 0)).toEqual([1, 1, 0]);
    expect(t.runs[1]!.approvedResults![0]).toContain('wrote it');
  });

  it('halt mid-batch: the executed call is not re-run and its result is delivered with the rest after resume', async () => {
    let halted = true;
    const writes: string[] = [];
    const a = runClaim(1, { title: 'A' });
    const b = runClaim(2, { title: 'B' });
    const f = fakeTools([[a, b], [b]], async (c) => {
      const title = (c.input as { title: string }).title;
      if (title === 'B' && halted) return { content: 'halted', isError: true, notRun: 'halted' };
      writes.push(title);
      return { content: `wrote ${title}` };
    });
    const t = await mk({ approvedTools: f.port });
    await t.s.onTaskReady(t.task.id);
    await t.s.idle();
    expect(writes).toEqual(['A']);
    expect(f.port.unclaim.mock.calls.map((c) => c[0].approvalId)).toEqual([2]);
    expect(t.run).not.toHaveBeenCalled();
    halted = false; // /resume
    await t.s.onTaskReady(t.task.id);
    await t.s.idle();
    expect(writes).toEqual(['A', 'B']);
    expect(t.runs[0]!.approvedResults).toEqual([expect.stringContaining('wrote A'), expect.stringContaining('wrote B')]);
  });

  it('M5: stored results are redacted and capped without splitting a surrogate pair', () => {
    expect(safeSlice('ab\u{1F600}cd', 3)).toBe('ab');
    expect(safeSlice('abcd', 3)).toBe('abc');
    const long = resultText({ content: `${'x'.repeat(RESULT_MAX - 1)}\u{1F600}tail key sk-ant-abcdefghijkl1234` });
    expect(long.startsWith('ran:\n')).toBe(true);
    expect(long).toContain('[truncated]');
    expect(long).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(resultText({ content: 'use sk-ant-abcdefghijkl1234', isError: true })).not.toContain('sk-ant-abcdefghijkl1234');
    expect(resultText({ content: 'nope', isError: true })).toBe('failed:\nnope');
  });
});

describe('runAgent onModelStart (R4 delivery)', () => {
  it('fires once, only when a provider call is actually made (not on a budget refusal)', async () => {
    const refusedRun = await setup({ script: [{ toolUses: [respond('never')] }] });
    refusedRun.budget.next = async () => ({ ok: false, scope: 'company' }) as never;
    const no = vi.fn(async () => undefined);
    await runAgent({ route: route(CTO), task: await owned(refusedRun.tasks, CTO), history: [], approvedResults: ['r'], onModelStart: no }, refusedRun.deps);
    expect(no).not.toHaveBeenCalled();

    const s = await setup({ script: [{ toolUses: [{ name: 'update_task', input: { taskId: 'x', status: 'doing' } }] }, { toolUses: [respond('done')] }] });
    const yes = vi.fn(async () => undefined);
    await runAgent({ route: route(CTO), task: await owned(s.tasks, CTO), history: [], approvedResults: ['r'], onModelStart: yes }, s.deps);
    expect(yes).toHaveBeenCalledTimes(1);
  });
});
