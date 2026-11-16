import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CTO, MemNotes, MemTasks, auditSpy, newBus, seededOrg, runCtxBase } from '../agents/test-helpers.js';
import { FakeConfig } from '../governance/test-helpers.js';
import { Limits } from '../governance/limits.js';
import { AUTOPILOT_REFUSAL, AUTOPILOT_REFUSAL_COMPANY } from './autopilot.js';
import type { ToolKind } from './policy-approval.js';
import { ToolRegistry } from './registry.js';
import type { AutopilotDecision, AutopilotPort, ToolContext, ToolPlugin } from './types.js';

/** AUTO-2 (SA-1 3.3, AC-C6, AC-C7, AC-C8, AC-C11): the chat-run block of the registry. */
class Port implements AutopilotPort {
  decides: { taskId: string; tool: string; input: unknown }[] = [];
  on = true;
  constructor(private readonly answer: () => AutopilotDecision | Promise<AutopilotDecision> = () => ({ kind: 'run' })) {}
  async projectOf() { return null; }
  companyOn = vi.fn(() => this.on);
  async decide(r: { taskId: string; tool: string; input: unknown }): Promise<AutopilotDecision> {
    this.decides.push(r);
    return this.answer();
  }
}

async function rig(o: { name?: string; kind?: ToolKind; own?: ToolPlugin<never>['requiresApproval']; autopilot?: boolean; untrusted?: boolean; halted?: () => boolean } = {}) {
  const name = o.name ?? 'clickup_create_task';
  const tasks = new MemTasks();
  const spy = auditSpy();
  const approvals = { needsApproval: () => false, request: vi.fn(async () => ({ id: 5 }) as never) };
  const seen: ToolContext[] = [];
  const run = vi.fn(async (_i: unknown, c: ToolContext) => { seen.push(c); return { content: 'ran' }; });
  const hook = vi.fn();
  const tool = {
    name, description: 'probe', kind: o.kind ?? 'write', inputSchema: z.object({ overwrite: z.boolean().optional(), url: z.string().optional() }),
    requiresApproval: o.own ?? (() => ({ reason: 'own reason' })), onApprovalTask: hook, run, ...(o.untrusted ? { untrustedOutput: true } : {}),
  } as unknown as ToolPlugin<unknown>;
  const reg = new ToolRegistry({ halt: { isHalted: o.halted ?? (() => false) }, autopilot: o.autopilot ?? true });
  reg.register(tool);
  const org = await seededOrg();
  const conv = await tasks.create({ title: 'chat', deptId: 'software', owner: CTO, requester: { kind: 'human', userId: '1' }, origin: 'chat' });
  const ensure = vi.fn(async () => conv);
  const c: ToolContext = {
    actor: CTO, task: null, ...runCtxBase({ origin: 'chat' }), org: Object.assign(Object.create(org) as object, { toolsFor: () => [name] }) as never, tasks, approvals,
    limits: new Limits(new FakeConfig(), tasks), bus: newBus(), notes: new MemNotes(), audit: spy.audit, ensureConversationTask: ensure,
  };
  return { reg, c, spy, approvals, run, hook, conv, tasks, ensure, seen, name };
}
const withPort = (c: ToolContext, port: AutopilotPort): ToolContext => ({ ...c, autopilot: port });
const CARD = /^NOT DONE YET/;

describe('AUTO-2 registry: chat run in company scope', () => {
  it('opens the conversation task, decides on it, runs with that task in the context, no card (Praw ClickUp from chat)', async () => {
    const r = await rig();
    const port = new Port();
    expect(await r.reg.run(r.name, {}, withPort(r.c, port))).toEqual({ content: 'ran' });
    expect(r.ensure).toHaveBeenCalledTimes(1);
    expect(port.decides).toEqual([{ taskId: r.conv.id, tool: r.name, input: {} }]);
    expect(r.approvals.request).not.toHaveBeenCalled();
    expect(r.seen[0]!.task?.id).toBe(r.conv.id);
    expect(r.hook).toHaveBeenCalledTimes(1);
    expect((r.hook.mock.calls[0] as unknown[])[2]).toEqual({ id: r.conv.id, rootId: r.conv.rootId });
  });

  it('project scope (companyOn false): no ensure before the card path, decide never called, the card path opens the task once', async () => {
    const r = await rig();
    const port = new Port();
    port.on = false;
    const res = await r.reg.run(r.name, {}, withPort(r.c, port));
    expect(res.content).toMatch(CARD);
    expect(port.decides).toHaveLength(0);
    expect(r.ensure).toHaveBeenCalledTimes(1); // the card path's own call, as before AUTO-2
  });

  it('a port without companyOn (project-only wiring) behaves as today', async () => {
    const r = await rig();
    const port = new Port();
    const { companyOn: _c, ...bare } = port as unknown as Record<string, unknown>;
    const res = await r.reg.run(r.name, {}, withPort(r.c, { projectOf: port.projectOf, decide: (x) => port.decide(x) } as AutopilotPort));
    expect(res.content).toMatch(CARD);
    expect(port.decides).toHaveLength(0);
    void bare;
  });

  it('taint carry: a tainted run taints the conversation task before decide, and write_file then gets a card (AC-C11)', async () => {
    const r = await rig({ name: 'write_file', own: () => false });
    r.c.run.markTainted();
    const port = new Port();
    const res = await r.reg.run('write_file', {}, withPort(r.c, port));
    expect(res.content).toMatch(CARD);
    expect(port.decides).toHaveLength(0);
    expect((await r.tasks.get(r.conv.id))!.tainted).toBe(true);
  });

  it('a tainted run still runs a web read in company scope; the opened task ends tainted through the post-run taint write', async () => {
    const r = await rig({ name: 'web_search', untrusted: true });
    r.c.run.markTainted();
    const port = new Port();
    expect((await r.reg.run('web_search', {}, withPort(r.c, port))).content).toContain('ran');
    expect(port.decides).toHaveLength(1);
    expect((await r.tasks.get(r.conv.id))!.tainted).toBe(true);
  });

  it('an untainted run: the post-run taint write of an untrusted tool lands on the conversation task (runCtx.task)', async () => {
    const r = await rig({ name: 'web_search', untrusted: true });
    const port = new Port();
    await r.reg.run('web_search', {}, withPort(r.c, port));
    expect(r.c.run.tainted()).toBe(true);
    expect((await r.tasks.get(r.conv.id))!.tainted).toBe(true);
  });

  it('refuse: the company text, the audit outcome stays autopilot_refused:<code>', async () => {
    const r = await rig();
    const res = await r.reg.run(r.name, {}, withPort(r.c, new Port(() => ({ kind: 'refuse', code: 'url_heuristic', company: true }))));
    expect(res).toEqual({ content: AUTOPILOT_REFUSAL_COMPANY.url_heuristic, isError: true });
    expect(res.content).toContain('Refused under company autopilot:');
    expect(AUTOPILOT_REFUSAL.url_heuristic).toContain('Refused in this project:');
    expect(r.spy.entries.at(-1)).toMatchObject({ outcome: 'autopilot_refused:url_heuristic' });
    expect(r.run).not.toHaveBeenCalled();
  });

  it('card from decide (hard-deny, cap): exactly one card, ensure memoised once per call path', async () => {
    const r = await rig();
    const res = await r.reg.run(r.name, {}, withPort(r.c, new Port(() => ({ kind: 'card' }))));
    expect(res.content).toMatch(CARD);
    expect(r.approvals.request).toHaveBeenCalledTimes(1);
    expect((r.approvals.request.mock.calls[0] as unknown[])[0]).toMatchObject({ taskId: r.conv.id });
  });

  it('own reason not on the waive list, or a throwing requiresApproval: no ensure for autopilot and no decide (AC-C7)', async () => {
    for (const own of [() => ({ reason: 'x' }), () => { throw new Error('boom'); }]) {
      const r = await rig({ name: 'fixture_write', own: own as never });
      const port = new Port();
      expect((await r.reg.run('fixture_write', {}, withPort(r.c, port))).content).toMatch(CARD);
      expect(port.decides).toHaveLength(0);
      expect(port.companyOn).not.toHaveBeenCalled();
      expect(r.ensure).toHaveBeenCalledTimes(1);
    }
  });

  it('a listed tool whose requiresApproval throws is a card, never decide', async () => {
    const r = await rig({ name: 'web_search', own: () => { throw new Error('boom'); } });
    const port = new Port();
    expect((await r.reg.run('web_search', {}, withPort(r.c, port))).content).toMatch(CARD);
    expect(port.decides).toHaveLength(0);
  });

  it('no hook (taskless run): approval_needs_task, decide never called (AC-C7 no-hook row)', async () => {
    const r = await rig();
    const { ensureConversationTask: _e, ...noHook } = r.c;
    const port = new Port();
    const res = await r.reg.run(r.name, {}, withPort(noHook as ToolContext, port));
    expect(res.content).toContain('can only run inside a task');
    expect(port.decides).toHaveLength(0);
    expect(r.spy.entries.at(-1)).toMatchObject({ outcome: 'approval_needs_task' });
  });

  it('AC-C8: companyOn throwing is not reached as a run: the call is carded (read fault = project rules)', async () => {
    const r = await rig();
    const port = new Port();
    port.companyOn = vi.fn(() => { throw new Error('x'); });
    const res = await r.reg.run(r.name, {}, withPort(r.c, port));
    expect(res.content).toMatch(CARD);
    expect(r.run).not.toHaveBeenCalled();
    expect(port.decides).toHaveLength(0);
    expect(r.approvals.request).toHaveBeenCalledTimes(1);
  });

  it('AC-C11: treeGrantRunOk gets the conversation task (apCtx): an untainted run whose conversation task is already tainted gets a card for write_file, decide never called', async () => {
    const r = await rig({ name: 'write_file', own: () => false });
    r.ensure.mockResolvedValue({ ...r.conv, tainted: true });
    const port = new Port();
    expect(r.c.run.tainted()).toBe(false);
    expect((await r.reg.run('write_file', {}, withPort(r.c, port))).content).toMatch(CARD);
    expect(port.decides).toHaveLength(0);
    // the same call with an untainted conversation task is decided and runs
    const u = await rig({ name: 'write_file', own: () => false });
    const p2 = new Port();
    expect(await u.reg.run('write_file', {}, withPort(u.c, p2))).toEqual({ content: 'ran' });
    expect(p2.decides).toHaveLength(1);
  });

  it('AC-C8: ensure throwing gives today\'s fault (tool failed), nothing runs', async () => {
    const r = await rig();
    r.ensure.mockRejectedValue(new Error('db'));
    const res = await r.reg.run(r.name, {}, withPort(r.c, new Port()));
    expect(res).toEqual({ content: `tool ${r.name} failed`, isError: true });
    expect(r.run).not.toHaveBeenCalled();
  });

  it('AC-C8: the taint-carry update throwing gives tool failed and nothing runs', async () => {
    const r = await rig();
    r.c.run.markTainted();
    vi.spyOn(r.tasks, 'update').mockRejectedValue(new Error('db'));
    const port = new Port();
    const res = await r.reg.run(r.name, {}, withPort(r.c, port));
    expect(res).toEqual({ content: `tool ${r.name} failed`, isError: true });
    expect(r.run).not.toHaveBeenCalled();
    expect(port.decides).toHaveLength(0);
  });

  it('decide throwing is a card (AP-C10), and a halt after the claim runs nothing', async () => {
    const r = await rig();
    expect((await r.reg.run(r.name, {}, withPort(r.c, new Port(() => { throw new Error('x'); })))).content).toMatch(CARD);
    let halted = false;
    const h = await rig({ halted: () => halted });
    const res = await h.reg.run(h.name, {}, withPort(h.c, new Port(() => { halted = true; return { kind: 'run' }; })));
    expect(res.isError).toBe(true);
    expect(h.run).not.toHaveBeenCalled();
  });

  it('the conversation task owner is checked: a head that does not own it gets a card, decide never called', async () => {
    const r = await rig();
    r.ensure.mockResolvedValue({ ...r.conv, owner: { kind: 'head', dept: 'rnd' } } as never);
    const port = new Port();
    const res = await r.reg.run(r.name, {}, withPort(r.c, port));
    expect(port.decides).toHaveLength(0);
    expect(res.content).toMatch(/owner|NOT DONE/);
  });
});

describe('AUTO-2 AC-C6: the admin registry and the approved path never see the port', () => {
  it('admin registry (built without the flag): no decide, no companyOn read, the call is carded as today', async () => {
    const r = await rig({ autopilot: false });
    const port = new Port();
    const res = await r.reg.run(r.name, {}, withPort(r.c, port));
    expect(res.content).toMatch(CARD);
    expect(port.decides).toHaveLength(0);
    expect(port.companyOn).not.toHaveBeenCalled();
    // the same call with no port at all: the same ensure count (the admin run's card path is untouched by AUTO-2)
    const bare = await rig({ autopilot: false });
    expect((await bare.reg.run(bare.name, {}, bare.c)).content).toMatch(CARD);
    expect(r.ensure).toHaveBeenCalledTimes(bare.ensure.mock.calls.length);
    expect(r.ensure).toHaveBeenCalledTimes(1);
  });

  it('approved replay: no decide, no companyOn read, no ensure, no card', async () => {
    const r = await rig();
    const port = new Port();
    const res = await r.reg.runApproved(r.name, {}, withPort({ ...r.c, task: r.conv }, port));
    expect(res).toEqual({ content: 'ran' });
    expect(port.decides).toHaveLength(0);
    expect(port.companyOn).not.toHaveBeenCalled();
    expect(r.ensure).not.toHaveBeenCalled();
    expect(r.approvals.request).not.toHaveBeenCalled();
  });
});
