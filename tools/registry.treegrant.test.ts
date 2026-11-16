import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CTO, MemNotes, MemTasks, SA, auditSpy, newBus, seededOrg, runCtxBase } from '../agents/test-helpers.js';
import { FakeConfig } from '../governance/test-helpers.js';
import { Limits } from '../governance/limits.js';
import type { TaskConsumeResult } from '../db/repos/task-grants.js';
import { DOC_KINDS, isDraftKind } from './plugins/docs/kinds.js';
import { ToolRegistry } from './registry.js';
import type { ToolKind } from './policy-approval.js';
import type { TaskGrantPort, ToolContext, ToolPlugin } from './types.js';

/** A port as a class using `this` (no unbound method reads). */
class FakePort implements TaskGrantPort {
  calls: { rootId: string; tool: string; tainted: boolean }[] = [];
  n = 0;
  constructor(private readonly answer: (this: FakePort) => TaskConsumeResult | Promise<TaskConsumeResult> = function () { return { ok: true, grantId: 7, used: ++this.n, max: 40 }; }) {}
  async consume(r: { rootId: string; tool: string; tainted: boolean }): Promise<TaskConsumeResult> {
    this.calls.push(r);
    return this.answer.call(this);
  }
}

async function rig(o: { name?: string; kind?: ToolKind; own?: ToolPlugin<never>['requiresApproval']; treeGrants?: boolean; halted?: () => boolean; actor?: ToolContext['actor'] } = {}) {
  const tasks = new MemTasks();
  const spy = auditSpy();
  const approvals = { needsApproval: () => false, request: vi.fn(async () => ({ id: 5 }) as never) };
  const run = vi.fn(async () => ({ content: 'ran' }));
  const tool = {
    name: o.name ?? 'forum_post', description: 'probe', kind: o.kind ?? 'write', inputSchema: z.object({ kind: z.string().optional(), overwrite: z.boolean().optional(), dept: z.string().optional() }),
    requiresApproval: o.own ?? (() => false), run,
  } as unknown as ToolPlugin<unknown>;
  const reg = new ToolRegistry({ halt: { isHalted: o.halted ?? (() => false) }, treeGrants: o.treeGrants ?? true });
  reg.register(tool);
  const c: ToolContext = {
    actor: o.actor ?? CTO, task: null, ...runCtxBase(), org: Object.assign(Object.create(await seededOrg()) as object, { toolsFor: () => [o.name ?? 'forum_post'] }) as never, tasks, approvals,
    limits: new Limits(new FakeConfig(), tasks), bus: newBus(), notes: new MemNotes(), audit: spy.audit,
  };
  const task = await tasks.create({ title: 'x', deptId: 'software', owner: CTO, requester: { kind: 'human', userId: '1' }, origin: 'chat' });
  return { reg, c: { ...c, task } as ToolContext, spy, approvals, run, task, tasks };
}
const withPort = (c: ToolContext, port: TaskGrantPort): ToolContext => ({ ...c, treeGrants: port });

describe('TREEGRANT-1 registry consume (TG-C5)', () => {
  it('a covered call of the task owner runs inline on a live grant: one consume with the root, the tool and the taint; audit task_grant.use; no card', async () => {
    const r = await rig();
    const port = new FakePort();
    const res = await r.reg.run('forum_post', {}, withPort(r.c, port));
    expect(res).toEqual({ content: 'ran' });
    expect(r.run).toHaveBeenCalledTimes(1);
    expect(r.approvals.request).not.toHaveBeenCalled();
    expect(port.calls).toEqual([{ rootId: r.task.rootId, tool: 'forum_post', tainted: false }]);
    expect(r.spy.entries).toEqual([
      expect.objectContaining({ action: 'task_grant.use', tool: 'forum_post', taskId: r.task.id, outcome: 'ok #7 1/40' }),
      expect.objectContaining({ action: 'tool', tool: 'forum_post', outcome: 'ok' }),
    ]);
  });

  it('a miss gives the normal card with a suffix from the closed enum, and writes the miss reason to the audit', async () => {
    const r = await rig();
    const port = new FakePort(() => ({ ok: false, why: 'cap_calls' }));
    const res = await r.reg.run('forum_post', {}, withPort(r.c, port));
    expect(res.content).toMatch(/^NOT DONE YET/);
    expect(r.run).not.toHaveBeenCalled();
    expect(r.approvals.request).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringMatching(/\(task grant not applied: cap_calls\)$/) }));
    expect(r.spy.entries[0]).toMatchObject({ action: 'task_grant.use', outcome: 'cap_calls' });
  });

  it('without a port, or without the registry flag, nothing is consumed and the call asks', async () => {
    const a = await rig();
    expect((await a.reg.run('forum_post', {}, a.c)).content).toMatch(/^NOT DONE YET/);
    const b = await rig({ treeGrants: false }); // TG-C6 second line: the admin registry
    const port = new FakePort();
    expect((await b.reg.run('forum_post', {}, withPort(b.c, port))).content).toMatch(/^NOT DONE YET/);
    expect(port.calls).toHaveLength(0);
  });

  it('a port that throws gives a card and never throws out of run', async () => {
    const r = await rig();
    const port = new FakePort(() => { throw new Error('db down'); });
    const res = await r.reg.run('forum_post', {}, withPort(r.c, port));
    expect(res.content).toMatch(/^NOT DONE YET/);
    expect(r.approvals.request).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringContaining('task grant not applied: error') }));
  });

  it('no task: nothing is consumed and ensureConversationTask is not used for a consume (the card path is today\'s)', async () => {
    const r = await rig();
    const port = new FakePort();
    const ensure = vi.fn(async () => r.task);
    const res = await r.reg.run('forum_post', {}, { ...withPort(r.c, port), task: null, ensureConversationTask: ensure });
    expect(port.calls).toHaveLength(0);
    expect(ensure).toHaveBeenCalledTimes(1); // only the existing card path
    expect(res.content).toMatch(/^NOT DONE YET/);
  });

  it('a non-owner keeps the I1 refusal and consumes nothing', async () => {
    const r = await rig({ actor: SA });
    const port = new FakePort();
    const res = await r.reg.run('forum_post', {}, withPort({ ...r.c, actor: SA, org: { ...r.c.org, toolsFor: () => ['forum_post'] } }, port));
    expect(res).toMatchObject({ isError: true });
    expect(res.content).toMatch(/only be requested by the task owner/);
    expect(port.calls).toHaveLength(0);
    expect(r.spy.entries.at(-1)).toMatchObject({ outcome: 'approval_not_owner' });
  });

  it('a tainted run passes the taint to the port (allowTainted lives in its gate); a refused slot is a card and nothing ran', async () => {
    const r = await rig();
    r.c.run.markTainted();
    const port = new FakePort(function () { return { ok: false, why: 'tainted' }; });
    const res = await r.reg.run('forum_post', {}, withPort(r.c, port));
    expect(port.calls[0]?.tainted).toBe(true);
    expect(res.content).toMatch(/^NOT DONE YET/);
    expect(r.run).not.toHaveBeenCalled();
  });

  it('the task\'s own taint counts as tainted too', async () => {
    const r = await rig();
    const port = new FakePort();
    await r.reg.run('forum_post', {}, withPort({ ...r.c, task: { ...r.task, tainted: true } }, port));
    expect(port.calls[0]?.tainted).toBe(true);
  });

  it('a halt that lands after the consume: a plain error, nothing runs, no notRun (TG-C5 step 10)', async () => {
    let halted = false;
    const r = await rig({ halted: () => halted });
    const port = new FakePort(function () { halted = true; return { ok: true, grantId: 1, used: 1, max: 40 }; });
    const res = await r.reg.run('forum_post', {}, withPort(r.c, port));
    expect(res.isError).toBe(true);
    expect(res).not.toHaveProperty('notRun');
    expect(r.run).not.toHaveBeenCalled();
    expect(r.spy.entries.at(-1)).toMatchObject({ action: 'tool', outcome: 'halted' });
  });
});

describe('TG-C2: own is computed separately and only a strict false is waived', () => {
  it.each([
    ['true', () => true],
    ['a reason', () => ({ reason: 'own rule' })],
  ])('own %s keeps the card and consumes nothing', async (_n, own) => {
    const r = await rig({ own: own as never });
    const port = new FakePort();
    const res = await r.reg.run('forum_post', {}, withPort(r.c, port));
    expect(res.content).toMatch(/^NOT DONE YET/);
    expect(port.calls).toHaveLength(0);
    expect(r.run).not.toHaveBeenCalled();
  });

  it('an own that throws under a central approval is a card, never covered', async () => {
    const r = await rig({ own: () => { throw new Error('boom'); } });
    const port = new FakePort();
    const res = await r.reg.run('forum_post', {}, withPort(r.c, port));
    expect(res.content).toMatch(/^NOT DONE YET/);
    expect(port.calls).toHaveLength(0);
  });

  it('the card reason stays central || own (central wins)', async () => {
    const r = await rig({ own: () => ({ reason: 'own rule' }) });
    await r.reg.run('forum_post', {}, r.c);
    expect(r.approvals.request).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringContaining('tool forum_post') }));
  });

  it('doc_create: every DRAFT kind stays carded under a live grant, every other kind runs on it', async () => {
    for (const k of DOC_KINDS) {
      const r = await rig({ name: 'doc_create', own: (i: { kind?: string }) => (isDraftKind(i.kind as never) ? { reason: 'DRAFT' } : false) as never });
      const port = new FakePort();
      const res = await r.reg.run('doc_create', { kind: k }, withPort(r.c, port));
      if (isDraftKind(k)) { expect(res.content, k).toMatch(/^NOT DONE YET/); expect(port.calls).toHaveLength(0); }
      else { expect(res.content, k).toBe('ran'); expect(port.calls).toHaveLength(1); }
    }
  });

  it('approved path: requiresApproval is not asked again and the port is stripped (TG-C6, S1)', async () => {
    const own = vi.fn(() => false);
    const r = await rig({ own: own as never });
    const port = new FakePort();
    const ctx = withPort(r.c, port);
    const res = await r.reg.runApproved('forum_post', {}, ctx);
    expect(res).toEqual({ content: 'ran' });
    expect(own).not.toHaveBeenCalled();
    expect(port.calls).toHaveLength(0);
    expect(ctx.treeGrants).toBe(port); // the caller's own context object is untouched
  });
});

describe('TG-C3 / TG-C4: scope on the run path', () => {
  it('an unlisted write tool, a destructive tool and a read tool never consume', async () => {
    for (const [name, kind] of [['save_lesson', 'write'], ['forum_post', 'destructive'], ['music_queue', 'read']] as const) {
      const r = await rig({ name, kind });
      const port = new FakePort();
      await r.reg.run(name, {}, withPort(r.c, port));
      expect(port.calls, `${name}/${kind}`).toHaveLength(0);
    }
  });

  it('write_file: overwrite true and a tainted run are carded without a consume; a new file in a clean run is covered', async () => {
    const clean = await rig({ name: 'write_file' });
    const p1 = new FakePort();
    expect((await clean.reg.run('write_file', {}, withPort(clean.c, p1))).content).toBe('ran');
    const ow = await rig({ name: 'write_file' });
    const p2 = new FakePort();
    const res = await ow.reg.run('write_file', { overwrite: true }, withPort(ow.c, p2));
    expect(res.content).toMatch(/^NOT DONE YET/);
    expect(p2.calls).toHaveLength(0);
    const tainted = await rig({ name: 'write_file' });
    tainted.c.run.markTainted();
    const p3 = new FakePort();
    expect((await tainted.reg.run('write_file', {}, withPort(tainted.c, p3))).content).toMatch(/^NOT DONE YET/);
    expect(p3.calls).toHaveLength(0); // whatever allowTainted says
    expect(tainted.approvals.request).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringContaining('not_covered') }));
  });

  it('forward_to: a wider audience keeps its card under a live grant; a not-wider audience runs on it', async () => {
    const mk = async (pub: boolean, direct: boolean) => {
      const r = await rig({ name: 'forward_to' });
      const port = new FakePort();
      const ctx = { ...withPort(r.c, port), source: { ...r.c.source, channelId: 'c1' }, channelIsPublic: async () => pub, direct } as ToolContext;
      return { res: await r.reg.run('forward_to', { dept: 'software' }, ctx), port };
    };
    const wide = await mk(false, false);
    expect(wide.res.content).toMatch(/^NOT DONE YET/);
    expect(wide.port.calls).toHaveLength(0);
    const narrow = await mk(true, false);
    expect(narrow.res.content).toBe('ran');
    expect(narrow.port.calls).toHaveLength(1);
  });
});
