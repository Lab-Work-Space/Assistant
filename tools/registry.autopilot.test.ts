import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CTO, MemNotes, MemTasks, SA, auditSpy, newBus, seededOrg, runCtxBase } from '../agents/test-helpers.js';
import { FakeConfig } from '../governance/test-helpers.js';
import { Limits } from '../governance/limits.js';
import { AUTOPILOT_OWN_WAIVE, AUTOPILOT_REFUSAL } from './autopilot.js';
import type { ToolKind } from './policy-approval.js';
import { ToolRegistry } from './registry.js';
import { CLICKUP_WORKSPACE_WRITE_NAMES } from './plugins/clickup/workspace-write.js';
import type { AutopilotDecision, AutopilotPort, ToolContext, ToolPlugin } from './types.js';

class Port implements AutopilotPort {
  decides: { taskId: string; tool: string; input: unknown }[] = [];
  constructor(private readonly answer: () => AutopilotDecision | Promise<AutopilotDecision> = () => ({ kind: 'run' })) {}
  async projectOf() { return { id: 1, rootTaskId: 'r', deadline: '2026-12-31' }; }
  async decide(r: { taskId: string; tool: string; input: unknown }): Promise<AutopilotDecision> {
    this.decides.push(r);
    return this.answer();
  }
}

async function rig(o: { name?: string; kind?: ToolKind; own?: ToolPlugin<never>['requiresApproval']; autopilot?: boolean; halted?: () => boolean; actor?: ToolContext['actor'] } = {}) {
  const name = o.name ?? 'forum_post';
  const tasks = new MemTasks();
  const spy = auditSpy();
  const approvals = { needsApproval: () => false, request: vi.fn(async () => ({ id: 5 }) as never) };
  const run = vi.fn(async () => ({ content: 'ran' }));
  const hook = vi.fn();
  const tool = {
    name, description: 'probe', kind: o.kind ?? 'write', inputSchema: z.object({ kind: z.string().optional(), overwrite: z.boolean().optional(), dept: z.string().optional(), url: z.string().optional(), query: z.string().optional() }),
    requiresApproval: o.own ?? (() => false), onApprovalTask: hook, run,
  } as unknown as ToolPlugin<unknown>;
  const reg = new ToolRegistry({ halt: { isHalted: o.halted ?? (() => false) }, autopilot: o.autopilot ?? true });
  reg.register(tool);
  const org = await seededOrg();
  const c: ToolContext = {
    actor: o.actor ?? CTO, task: null, ...runCtxBase(), org: Object.assign(Object.create(org) as object, { toolsFor: () => [name] }) as never, tasks, approvals,
    limits: new Limits(new FakeConfig(), tasks), bus: newBus(), notes: new MemNotes(), audit: spy.audit,
  };
  const task = await tasks.create({ title: 'x', deptId: 'software', owner: CTO, requester: { kind: 'human', userId: '1' }, origin: 'chat' });
  return { reg, c: { ...c, task } as ToolContext, spy, approvals, run, hook, task, tasks, org };
}
const withPort = (c: ToolContext, port: AutopilotPort): ToolContext => ({ ...c, autopilot: port });
const CARD = /^NOT DONE YET/;

describe('AUTO-1 registry branch (SA-1 3.3)', () => {
  it('run: the call runs in the same run, no card, onApprovalTask counted once, decide got the validated input', async () => {
    const r = await rig();
    const port = new Port();
    const res = await r.reg.run('forum_post', { kind: 'x' }, withPort(r.c, port));
    expect(res).toEqual({ content: 'ran' });
    expect(r.run).toHaveBeenCalledTimes(1);
    expect(r.approvals.request).not.toHaveBeenCalled();
    expect(r.hook).toHaveBeenCalledTimes(1);
    expect(port.decides).toEqual([{ taskId: r.task.id, tool: 'forum_post', input: { kind: 'x' } }]);
    expect(r.spy.entries.at(-1)).toMatchObject({ action: 'tool', tool: 'forum_post', outcome: 'ok' });
  });

  it('refuse: a fixed text, an audit with the code, no card and nothing ran', async () => {
    const r = await rig();
    const res = await r.reg.run('forum_post', {}, withPort(r.c, new Port(() => ({ kind: 'refuse', code: 'query_heuristic' }))));
    expect(res).toEqual({ content: AUTOPILOT_REFUSAL.query_heuristic, isError: true });
    expect(r.run).not.toHaveBeenCalled();
    expect(r.approvals.request).not.toHaveBeenCalled();
    expect(r.spy.entries.at(-1)).toMatchObject({ action: 'tool', outcome: 'autopilot_refused:query_heuristic' });
  });

  it('the input_cut text names the real limit (4000), not 1500', () => {
    expect(AUTOPILOT_REFUSAL.input_cut).toContain('over 4000 characters');
    expect(AUTOPILOT_REFUSAL.input_cut).not.toContain('1500');
  });

  it('card: today\'s card, nothing ran, no hook from the branch (the card path calls it once)', async () => {
    const r = await rig();
    const res = await r.reg.run('forum_post', {}, withPort(r.c, new Port(() => ({ kind: 'card' }))));
    expect(res.content).toMatch(CARD);
    expect(r.run).not.toHaveBeenCalled();
    expect(r.approvals.request).toHaveBeenCalledTimes(1);
    expect(r.hook).toHaveBeenCalledTimes(1);
  });

  it('AP-C10: a decide that throws is a card, never a run, never a throw out of run()', async () => {
    const r = await rig();
    const res = await r.reg.run('forum_post', {}, withPort(r.c, new Port(() => { throw new Error('db down MARKER'); })));
    expect(res.content).toMatch(CARD);
    expect(r.run).not.toHaveBeenCalled();
    expect(JSON.stringify(r.spy.entries)).not.toContain('MARKER');
  });

  it('halt landing after the claim: a plain error, nothing runs, no notRun, the hook is not called', async () => {
    let halted = false;
    const r = await rig({ halted: () => halted });
    const res = await r.reg.run('forum_post', {}, withPort(r.c, new Port(() => { halted = true; return { kind: 'run' }; })));
    expect(res.isError).toBe(true);
    expect(res).not.toHaveProperty('notRun');
    expect(r.run).not.toHaveBeenCalled();
    expect(r.hook).not.toHaveBeenCalled();
    expect(r.spy.entries.at(-1)).toMatchObject({ outcome: 'halted' });
  });

  it('a non-owner keeps the I1 refusal and decide is never called', async () => {
    const r = await rig({ actor: SA });
    const port = new Port();
    const res = await r.reg.run('forum_post', {}, withPort({ ...r.c, actor: SA, org: { ...r.c.org, toolsFor: () => ['forum_post'] } }, port));
    expect(res.content).toMatch(/only be requested by the task owner/);
    expect(port.decides).toHaveLength(0);
  });

  it('no task: decide is never called (today\'s card path)', async () => {
    const r = await rig();
    const port = new Port();
    await r.reg.run('forum_post', {}, { ...withPort(r.c, port), task: null, ensureConversationTask: async () => r.task });
    expect(port.decides).toHaveLength(0);
  });

  it('AP-C3: the approved path never calls decide (the port is stripped), whatever the context carries', async () => {
    const r = await rig();
    const port = new Port();
    const spy = vi.spyOn(port, 'decide');
    const res = await r.reg.runApproved('forum_post', {}, withPort(r.c, port));
    expect(res).toEqual({ content: 'ran' });
    expect(spy).not.toHaveBeenCalled();
    expect(r.approvals.request).not.toHaveBeenCalled();
  });

  it('AP-C3: a registry built without the autopilot flag (the admin registry) drops the port: decide is never called', async () => {
    const r = await rig({ autopilot: false });
    const port = new Port();
    const res = await r.reg.run('forum_post', {}, withPort(r.c, port));
    expect(res.content).toMatch(CARD);
    expect(port.decides).toHaveLength(0);
  });

  it('a tool that needs no approval at all never reaches decide', async () => {
    const r = await rig({ kind: 'read' });
    const port = new Port();
    expect(await r.reg.run('forum_post', {}, withPort(r.c, port))).toEqual({ content: 'ran' });
    expect(port.decides).toHaveLength(0);
  });
});

describe('AP-C1: the own-reason allowlist', () => {
  it('a fixture write tool with its own reason that is not on the list gets a card and decide is not called', async () => {
    for (const own of [() => ({ reason: 'own safety rule' }), () => true, () => { throw new Error('boom'); }]) {
      const r = await rig({ name: 'fixture_write', own: own as never });
      const port = new Port();
      const res = await r.reg.run('fixture_write', {}, withPort(r.c, port));
      expect(res.content).toMatch(CARD);
      expect(r.run).not.toHaveBeenCalled();
      expect(port.decides).toHaveLength(0);
    }
  });

  it('a tool ON the list with its own reason is decided: a run ends the reason (web_search and a ClickUp write)', async () => {
    for (const name of ['web_search', 'clickup_create_task']) {
      const r = await rig({ name, own: () => ({ reason: 'own reason' }) });
      const port = new Port();
      expect(await r.reg.run(name, {}, withPort(r.c, port))).toEqual({ content: 'ran' });
      expect(port.decides).toHaveLength(1);
      expect(r.approvals.request).not.toHaveBeenCalled();
    }
  });

  it('G2-02: a listed tool whose requiresApproval throws under a central approval gets a card, never decide', async () => {
    const r = await rig({ name: 'web_search', own: () => { throw new Error('boom'); } });
    const port = new Port();
    const res = await r.reg.run('web_search', {}, withPort(r.c, port));
    expect(res.content).toMatch(CARD);
    expect(port.decides).toHaveLength(0);
    expect(r.run).not.toHaveBeenCalled();
  });

  it('the list is frozen, holds exactly web_search, fetch_page and the imported ClickUp names, and clickup_add_comment is not on it', () => {
    expect(Object.isFrozen(AUTOPILOT_OWN_WAIVE)).toBe(true);
    expect([...AUTOPILOT_OWN_WAIVE]).toEqual(['clickup_assign_task', 'clickup_create_folder', 'clickup_create_list', 'clickup_create_space', 'clickup_create_task', 'clickup_update_status', 'clickup_update_task', 'fetch_page', 'web_search']);
    expect(AUTOPILOT_OWN_WAIVE).toEqual(expect.arrayContaining([...CLICKUP_WORKSPACE_WRITE_NAMES])); // PM-C7: the ClickUp names stay tied to the file that builds those tools
    expect(AUTOPILOT_OWN_WAIVE).not.toContain('clickup_add_comment');
    expect(AUTOPILOT_OWN_WAIVE).not.toContain('clickup_delete_task');
  });
});

describe('AP-C2: the run-time predicates of the tree grant still apply', () => {
  it('a tainted write_file gets a card (Praw\'s workspace is the site source); an untainted one is decided', async () => {
    const t = await rig({ name: 'write_file' });
    t.c.run.markTainted();
    const port = new Port();
    expect((await t.reg.run('write_file', {}, withPort(t.c, port))).content).toMatch(CARD);
    expect(port.decides).toHaveLength(0);
    const u = await rig({ name: 'write_file' });
    const p2 = new Port();
    expect(await u.reg.run('write_file', {}, withPort(u.c, p2))).toEqual({ content: 'ran' });
    expect(p2.decides).toHaveLength(1);
  });

  it('a write_file whose task is tainted gets a card too', async () => {
    const t = await rig({ name: 'write_file' });
    const port = new Port();
    expect((await t.reg.run('write_file', {}, withPort({ ...t.c, task: { ...t.task, tainted: true } }, port))).content).toMatch(CARD);
    expect(port.decides).toHaveLength(0);
  });

  it('forward_to to a wider audience gets a card; to a narrower one it is decided', async () => {
    const wide = await rig({ name: 'forward_to' });
    const port = new Port();
    const wideCtx = withPort({ ...wide.c, source: { ...wide.c.source, channelId: '111', threadId: null }, channelIsPublic: async () => false }, port);
    // the source channel is not the target's work channel and is not public: the audience may be wider than the target's room -> wider = true
    const org = await seededOrg();
    const target = org.dept('rnd')?.workChannelId ?? null;
    expect(target).toBeTruthy();
    expect((await wide.reg.run('forward_to', { dept: 'rnd' }, wideCtx)).content).toMatch(CARD);
    expect(port.decides).toHaveLength(0);
    const narrow = await rig({ name: 'forward_to' });
    const p2 = new Port();
    const narrowCtx = withPort({ ...narrow.c, org: Object.assign(Object.create(narrow.org) as object, { toolsFor: () => ['forward_to'] }) as never, source: { ...narrow.c.source, channelId: target!, threadId: null } }, p2);
    expect(await narrow.reg.run('forward_to', { dept: 'rnd' }, narrowCtx)).toEqual({ content: 'ran' });
    expect(p2.decides).toHaveLength(1);
  });

  it('write_file with overwrite true is a card (storedInputOk) and is never decided', async () => {
    const t = await rig({ name: 'write_file' });
    const port = new Port();
    expect((await t.reg.run('write_file', { overwrite: true }, withPort(t.c, port))).content).toMatch(CARD);
    expect(port.decides).toHaveLength(0);
  });
});
