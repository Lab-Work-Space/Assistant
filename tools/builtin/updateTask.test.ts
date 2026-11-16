import { describe, expect, it } from 'vitest';
import type { ActorRef } from '../../company/types.js';
import type { AppEvents } from '../../core/events.js';
import { CTO, MemNotes, MemTasks, auditSpy, newBus, runCtxBase, seededOrg } from '../../agents/test-helpers.js';
import { Limits } from '../../governance/limits.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import type { ToolContext } from '../types.js';
import { updateTask, updateTaskInput } from './updateTask.js';

const SA: ActorRef = { kind: 'persona', personaId: 'system-analyst' };

async function setup(owner: ActorRef, tainted = false) {
  const tasks = new MemTasks();
  const bus = newBus();
  const events: AppEvents['task.changed'][] = [];
  bus.on('task.changed', (e) => void events.push(e));
  const base = runCtxBase();
  if (tainted) base.run.markTainted();
  const c: ToolContext = {
    actor: owner, task: null, ...base, org: await seededOrg(), tasks,
    approvals: { needsApproval: () => false, request: async () => ({}) as never },
    limits: new Limits(new FakeConfig(), tasks), bus, notes: new MemNotes(), audit: auditSpy().audit,
  };
  const t = await tasks.create({ title: 'x', deptId: 'software', owner, requester: CTO, origin: 'delegated', status: 'doing', tainted: false });
  return { c, t, events };
}
const parse = (o: Record<string, unknown>) => updateTaskInput.parse({ status: 'done', summary: 's', taskId: 't', ...o });

describe('TEAMTALK update_task ideas and decisions (T12)', () => {
  it('the schema allows at most 3 ideas and 3 decisions of at most 200 characters each', () => {
    expect(() => parse({ ideas: ['a', 'b', 'c', 'd'] })).toThrow();
    expect(() => parse({ decisions: ['a', 'b', 'c', 'd'] })).toThrow();
    expect(() => parse({ ideas: ['x'.repeat(201)] })).toThrow();
    expect(() => parse({ ideas: [''] })).toThrow();
    expect(parse({ ideas: [' a '], decisions: ['b'] })).toMatchObject({ ideas: ['a'], decisions: ['b'] });
  });

  it('a persona-owned task: the change event carries the ideas, the decisions and the taint of the run that wrote them', async () => {
    for (const tainted of [false, true]) {
      const { c, t, events } = await setup(SA, tainted);
      const res = await updateTask.run({ ...parse({ taskId: t.id, ideas: ['use a queue'], decisions: ['ship Friday'] }) }, c);
      expect(res.isError).toBeFalsy();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ to: 'done', ideas: ['use a queue'], decisions: ['ship Friday'], runTainted: tainted });
    }
  });

  it('a head-owned task: ideas and decisions are dropped with a fixed message and never reach the event', async () => {
    const { c, t, events } = await setup(CTO);
    const res = await updateTask.run(parse({ taskId: t.id, ideas: ['secret plan @CFO'], decisions: ['d'] }), c);
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('ideas and decisions are recorded only for tasks owned by a team member');
    expect(res.content).not.toContain('secret plan');
    expect(events[0]!.ideas).toBeUndefined();
    expect(events[0]!.decisions).toBeUndefined();
  });

  it('without ideas or decisions nothing changes for the event or the message', async () => {
    const { c, t, events } = await setup(SA);
    const res = await updateTask.run(parse({ taskId: t.id }), c);
    expect(res.content).toBe(`task ${t.id} is now done`);
    expect(Object.keys(events[0]!).sort()).toEqual(['from', 'summary', 'task', 'to']);
  });
});

describe('TASKADMIN-1 blocked needs a reason (TA-C15)', () => {
  const blocked = (o: Record<string, unknown> = {}) => updateTaskInput.safeParse({ taskId: 't', status: 'blocked', ...o });

  it('the schema refuses blocked without a summary of at least 5 characters after trim; other statuses are unchanged', () => {
    expect(blocked().success).toBe(false);
    expect(blocked({ summary: '  ab  ' }).success).toBe(false);
    expect(blocked({ summary: '    need it   ' }).success).toBe(true);
    expect(updateTaskInput.safeParse({ taskId: 't', status: 'review' }).success).toBe(true);
    expect(updateTaskInput.safeParse({ taskId: 't', status: 'doing', summary: 'ok' }).success).toBe(true);
    const err = blocked({ summary: 'ab' });
    expect(JSON.stringify(err.error?.issues)).toContain('blocked needs a short reason in summary');
  });

  it('the schema still converts to a JSON schema for the model', async () => {
    const { z } = await import('zod');
    const js = z.toJSONSchema(updateTaskInput, { io: 'input' }) as { properties?: Record<string, unknown> };
    expect(Object.keys(js.properties ?? {})).toEqual(expect.arrayContaining(['taskId', 'status', 'summary']));
  });

  it('blocked stores reason owner and the note beside the row (never on Task); the event summary is masked, one line and at most 300 characters', async () => {
    const { c, t, events } = await setup(CTO);
    const tasks = c.tasks as unknown as MemTasks;
    const res = await updateTask.run({ taskId: t.id, status: 'blocked', summary: `need the key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789\nplease ${'z'.repeat(400)}` }, c);
    expect(res.isError).toBeFalsy();
    const row = await tasks.get(t.id);
    expect(row).toMatchObject({ status: 'blocked', blockedReason: 'owner' });
    expect(row).not.toHaveProperty('blockedNote');
    expect(tasks.notes.get(t.id)).toContain('need the key');
    expect(tasks.notes.get(t.id)).not.toMatch(/sk-ant/);
    expect(events[0]).toMatchObject({ to: 'blocked' });
    const ev = events[0]!.summary!;
    expect(ev).not.toMatch(/sk-ant|\n/);
  });

  it('G2-02: the tool layer does not cut the reason; the cut to 300 happens after the literal-secret mask in the store (and in the consumers), so a cut cannot split a literal secret', async () => {
    const { c, t, events } = await setup(CTO);
    const seen: Array<string | undefined> = [];
    const real = c.tasks.update.bind(c.tasks);
    c.tasks.update = (async (id: string, patch: Parameters<typeof real>[1], exp?: Parameters<typeof real>[2]) => { seen.push(patch.blockedNote); return real(id, patch, exp); }) as typeof c.tasks.update;
    const reason = `${'a'.repeat(290)} LITERALSECRET-0123456789 tail`;
    await updateTask.run({ taskId: t.id, status: 'blocked', summary: reason }, c);
    expect(seen[0]).toBe(reason); // whole: the store masks with the literal list first, then cuts
    expect(events[0]!.summary).toBe(reason);
  });

  it('a later status change clears the note', async () => {
    const { c, t } = await setup(CTO);
    const tasks = c.tasks as unknown as MemTasks;
    await updateTask.run({ taskId: t.id, status: 'blocked', summary: 'waiting for input' }, c);
    expect(tasks.notes.get(t.id)).toBe('waiting for input');
    await updateTask.run({ taskId: t.id, status: 'doing' }, c);
    expect(tasks.notes.has(t.id)).toBe(false);
    expect((await tasks.get(t.id))!.blockedReason).toBeNull();
  });

  it('run() itself refuses a blocked call with a short summary even if the schema was bypassed', async () => {
    const { c, t } = await setup(CTO);
    const res = await updateTask.run({ taskId: t.id, status: 'blocked', summary: 'no' }, c);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('blocked needs a short reason in summary');
    expect((await c.tasks.get(t.id))!.status).toBe('doing');
  });
});

describe('LEARN-1 LL-C1 update_task copies the run taint onto the target task', () => {
  it('a tainted run writes tainted:true on the target in the same update, before task.changed; a clean run does not', async () => {
    for (const how of ['clean', 'run', 'ctxTask'] as const) {
      const { c, t, events } = await setup(CTO, how === 'run');
      if (how === 'ctxTask') c.task = { ...t, tainted: true };
      const res = await updateTask.run(parse({ taskId: t.id, summary: 'steered text' }), c);
      expect(res.isError).toBeFalsy();
      const want = how !== 'clean';
      expect((await c.tasks.get(t.id))!.tainted, how).toBe(want);
      expect(events[0]!.task.tainted, how).toBe(want);
    }
  });
  it('blocked and the same-task case are covered too', async () => {
    const { c, t } = await setup(CTO, true);
    c.task = t; // the target IS the run's task
    await updateTask.run(parse({ taskId: t.id, status: 'blocked', summary: 'steered reason' }), c);
    expect((await c.tasks.get(t.id))!.tainted).toBe(true);
  });
});
