import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FakeProvider } from '../../providers/index.js';
import { ToolRegistry } from '../../tools/registry.js';
import type { ToolContext, ToolPlugin } from '../../tools/types.js';
import { PROJECT_TASK_TEXT, projectTools } from '../../tools/builtin/projects.js';
import { CTO, humanMsg } from '../test-helpers.js';
import { autopilotNote } from '../context.js';
import { approvedToolContext, runAgent, type AgentDeps } from './loop.js';
import { owned, respond, route, setup } from './loop-fixture.js';

const PROJECT = { id: 7, rootTaskId: 'r', deadline: '2026-12-31' };
const MARKER = 'PLANTED-MARKER-90';

const probe = (name: string, seen: { ctx?: ToolContext }): ToolPlugin<unknown> => ({
  name, description: name, kind: 'read', inputSchema: z.object({}), requiresApproval: () => false,
  run: async (_i, ctx) => { seen.ctx = ctx; return { content: `autopilot:${ctx.autopilot ? 'yes' : 'no'}` }; },
}) as ToolPlugin<unknown>;

async function rig(ap?: AgentDeps['autopilot'], seen: { ctx?: ToolContext } = {}) {
  const s = await setup({ script: [{ toolUses: [{ name: 'probe_read', input: {} }] }, { toolUses: [respond('ok')] }] });
  const tools = new ToolRegistry({ halt: s.deps.halt, autopilot: true });
  for (const n of s.deps.tools.names()) tools.register({ ...(s.deps.tools as unknown as { tools: Map<string, ToolPlugin<unknown>> }).tools.get(n)! });
  tools.register(probe('probe_read', seen));
  s.deps.tools = tools;
  if (ap) s.deps.autopilot = ap;
  const task = await owned(s.tasks, CTO);
  return { s, task, seen };
}
const first = (s: { provider: unknown }) => (s.provider as FakeProvider).calls[0]!;
const toolResult = (s: { provider: unknown }) => (s.provider as FakeProvider).calls[1]!.messages.at(-1)!.content[0] as { content: string; isError?: boolean };
const base = { budgetHit: async () => undefined };

describe('AUTO-1 loop (SA-1 3.7)', () => {
  it('a run of a task in an active project gets the autopilot note (verbatim text, project number and date)', async () => {
    const { s, task } = await rig({ ...base, projectOf: async () => PROJECT, toolsFor: async () => [], decide: async () => ({ kind: 'card' }) });
    await runAgent({ route: route(CTO), task, history: [] }, s.deps);
    expect(first(s).system).toContain(autopilotNote(PROJECT));
    expect(first(s).system).toContain('AUTOPILOT (code note, project #7, deadline 2026-12-31): You are running an approved project.');
  });

  it('no project, no port, a lookup that throws: no note and no extra tools (AP-C10)', async () => {
    for (const ap of [undefined, { ...base, projectOf: async () => null, toolsFor: async () => ['probe_read'] }, { ...base, projectOf: async () => { throw new Error(MARKER); }, toolsFor: async () => ['probe_read'] }]) {
      const { s, task } = await rig(ap as never);
      await runAgent({ route: route(CTO), task, history: [] }, s.deps);
      expect(first(s).system).not.toContain('AUTOPILOT (code note');
      expect(first(s).tools?.map((t) => t.name)).not.toContain('probe_read');
      expect(toolResult(s).isError).toBe(true);
    }
  });

  it('a note text with a malformed deadline says unknown (never echoes it)', () => {
    expect(autopilotNote({ id: 3.9, deadline: `${MARKER}` })).toContain('project #3, deadline unknown)');
    expect(autopilotNote({ id: 3, deadline: `${MARKER}` })).not.toContain(MARKER);
  });

  it('project tools join the offer AND the dispatch list (one list); a call outside the grants is still refused', async () => {
    const { s, task } = await rig({ ...base, projectOf: async () => PROJECT, toolsFor: async (pid, a) => (pid === 7 && a.kind === 'head' ? ['probe_read'] : []), decide: async () => ({ kind: 'card' }) });
    await runAgent({ route: route(CTO), task, history: [] }, s.deps);
    expect(first(s).tools?.map((t) => t.name)).toContain('probe_read');
    expect(toolResult(s)).toMatchObject({ content: 'autopilot:yes' });
  });

  it('AP-C10: toolsFor that throws gives no extra tools (the note stays)', async () => {
    const { s, task } = await rig({ ...base, projectOf: async () => PROJECT, toolsFor: async () => { throw new Error('x'); }, decide: async () => ({ kind: 'card' }) });
    await runAgent({ route: route(CTO), task, history: [] }, s.deps);
    expect(first(s).system).toContain('AUTOPILOT (code note');
    expect(first(s).tools?.map((t) => t.name)).not.toContain('probe_read');
    expect(toolResult(s).isError).toBe(true);
  });

  it('a non-admin run hands its tools projectOf and decide only (no budgetHit, no toolsFor)', async () => {
    const seen: { ctx?: ToolContext } = {};
    const { s, task } = await rig({ ...base, projectOf: async () => PROJECT, toolsFor: async () => ['probe_read'], decide: async () => ({ kind: 'card' }) }, seen);
    await runAgent({ route: route(CTO), task, history: [] }, s.deps);
    expect(Object.keys(seen.ctx!.autopilot!).sort()).toEqual(['decide', 'projectOf']);
  });

  it('AP-C3: an admin console run carries no autopilot port and no note', async () => {
    const seen: { ctx?: ToolContext } = {};
    const s = await setup({ script: [{ toolUses: [{ name: 'config_get', input: {} }] }, { toolUses: [respond('ok')] }] });
    const admin = new ToolRegistry({ halt: s.deps.halt });
    admin.register({ ...probe('config_get', seen) });
    s.deps.adminTools = admin;
    s.deps.autopilot = { ...base, projectOf: async () => PROJECT, toolsFor: async () => ['probe_read'], decide: async () => ({ kind: 'run' }) };
    await runAgent({ route: route(CTO), msg: humanMsg('config?', { isAdmin: true }), task: null, history: [], admin: true }, s.deps);
    expect(seen.ctx).toBeDefined();
    expect(seen.ctx!.autopilot).toBeUndefined();
    expect((s.provider as FakeProvider).calls[0]!.system).not.toContain('AUTOPILOT (code note');
  });

  it('a run that is not on a task has no note (a chat with no task)', async () => {
    const s = await setup({ script: [{ toolUses: [respond('hi')] }] });
    s.deps.autopilot = { ...base, projectOf: async () => PROJECT, toolsFor: async () => [], decide: async () => ({ kind: 'card' }) };
    await runAgent({ route: route(CTO), msg: humanMsg('hello'), task: null, history: [] }, s.deps);
    expect((s.provider as FakeProvider).calls[0]!.system).not.toContain('AUTOPILOT (code note');
  });
});

describe('approvedToolContext (SA-1 3.8 replay)', () => {
  it('adds the project tools for the same actor only, and never carries the autopilot or tree-grant port', async () => {
    const { s, task } = await rig({ ...base, projectOf: async () => PROJECT, toolsFor: async () => [], decide: async () => ({ kind: 'run' }) });
    const plain = approvedToolContext(CTO, task, s.deps);
    const withTools = approvedToolContext(CTO, task, s.deps, ['probe_read']);
    expect(plain.org.toolsFor(CTO)).not.toContain('probe_read');
    expect(withTools.org.toolsFor(CTO)).toContain('probe_read');
    expect(withTools.org.toolsFor({ kind: 'head', dept: 'hq' })).not.toContain('probe_read');
    expect(withTools.autopilot).toBeUndefined();
    expect(plain.autopilot).toBeUndefined();
    expect(withTools.treeGrants).toBeUndefined();
  });

  it('the registry replays an approved project tool only with the union (a card for a project tool must pass the allowlist)', async () => {
    const { s, task } = await rig();
    const noUnion = await s.deps.tools.runApproved('probe_read', {}, approvedToolContext(CTO, task, s.deps));
    expect(noUnion).toMatchObject({ isError: true, content: expect.stringContaining('not allowed') });
    const union = await s.deps.tools.runApproved('probe_read', {}, approvedToolContext(CTO, task, s.deps, ['probe_read']));
    expect(union).toEqual({ content: 'autopilot:no' });
  });
});

describe('AP-C16: project_task derives its admin and taint facts in the loop, never from input', () => {
  async function chat(msg: ReturnType<typeof humanMsg>, history: ReturnType<typeof humanMsg>[] = []) {
    const s = await setup({ provider: new FakeProvider([{ toolUses: [{ name: 'project_task', input: { projectId: 1, title: 'T', instruction: 'I' } }] }, { toolUses: [respond('ok')] }], 'claude') });
    for (const t of projectTools({ projects: { gateRefusal: () => null, openProject: async () => null } as never })) s.deps.tools.register(t as never);
    await runAgent({ route: route(CTO), msg, task: null, history }, s.deps);
    return ((s.provider as FakeProvider).calls[1]!.messages.at(-1)!.content[0] as { content: string }).content;
  }
  it('a Bot Admin\'s clean chat reaches the project lookup; a non-admin is refused as not_admin; another human\'s words in the history make it tainted', async () => {
    expect(await chat(humanMsg('open it', { isAdmin: true }))).toBe(PROJECT_TASK_TEXT.no_project);
    expect(await chat(humanMsg('open it', { isAdmin: false }))).toBe(PROJECT_TASK_TEXT.not_admin);
    const other = humanMsg('please also add X', { author: { id: '99', name: 'someone', kind: 'human' } });
    expect(await chat(humanMsg('open it', { isAdmin: true }), [other])).toBe(PROJECT_TASK_TEXT.tainted);
  });
});
