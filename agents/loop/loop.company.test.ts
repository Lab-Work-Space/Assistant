import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FakeProvider } from '../../providers/index.js';
import { ToolRegistry } from '../../tools/registry.js';
import type { ToolContext, ToolPlugin } from '../../tools/types.js';
import { CTO, humanMsg } from '../test-helpers.js';
import { COMPANY_AUTOPILOT_NOTE, autopilotNote } from '../context.js';
import { runAgent, type AgentDeps } from './loop.js';
import { owned, respond, route, setup } from './loop-fixture.js';

/** AUTO-2 (SA-1 3.4, 3.7, 5.4; AC-C3, AC-C5, AC-C8): the company note, the tree tools and the port spread. */
const PROJECT = { id: 7, rootTaskId: 'r', deadline: '2026-12-31' };
const base = { budgetHit: async () => undefined };
const probe = (name: string, seen: { ctx?: ToolContext }): ToolPlugin<unknown> => ({
  name, description: name, kind: 'read', inputSchema: z.object({}), requiresApproval: () => false,
  run: async (_i, ctx) => { seen.ctx = ctx; return { content: 'ran' }; },
}) as ToolPlugin<unknown>;

async function rig(ap: AgentDeps['autopilot'], seen: { ctx?: ToolContext } = {}) {
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
const co = (o: Partial<NonNullable<AgentDeps['autopilot']>> = {}): NonNullable<AgentDeps['autopilot']> => ({
  ...base, projectOf: async () => null, toolsFor: async () => [], decide: async () => ({ kind: 'card' }), companyOn: () => true, inCompany: async () => true, treeToolsFor: async () => [], ...o,
});

describe('COMPANY_AUTOPILOT_NOTE (AC-C3)', () => {
  it('is a fixed constant: no template placeholder, the exact opening and closing, and never the project note', () => {
    expect(COMPANY_AUTOPILOT_NOTE).not.toContain('${');
    expect(COMPANY_AUTOPILOT_NOTE.startsWith("AUTOPILOT (code note, company scope): You work under the owner's standing approval for all company work.")).toBe(true);
    expect(COMPANY_AUTOPILOT_NOTE.endsWith('never end with a request for the owner to choose.')).toBe(true);
    expect(COMPANY_AUTOPILOT_NOTE).not.toContain('After warroom_say'); // C6: the warroom wait stays project-only
    expect(COMPANY_AUTOPILOT_NOTE).not.toBe(autopilotNote(PROJECT));
  });
});

describe('AUTO-2 loop: the company note', () => {
  it('a task run outside a project, in company scope, gets the company note and not the project note', async () => {
    const { s, task } = await rig(co());
    await runAgent({ route: route(CTO), task, history: [] }, s.deps);
    expect(first(s).system).toContain(COMPANY_AUTOPILOT_NOTE);
    expect(first(s).system).not.toContain('AUTOPILOT (code note, project');
  });

  it('a chat run with no task gets the note when companyOn is true', async () => {
    const s = await setup({ script: [{ toolUses: [respond('hi')] }] });
    s.deps.autopilot = co();
    s.deps.conversation = { open: async () => owned(s.tasks, CTO) } as never;
    await runAgent({ route: route(CTO), msg: humanMsg('hello'), task: null, history: [] }, s.deps);
    expect((s.provider as FakeProvider).calls[0]!.system).toContain(COMPANY_AUTOPILOT_NOTE);
  });

  it('G2-01: a taskless run without the conversation hook gets no note; with the hook it does; a task in the company tree does', async () => {
    const s = await setup({ script: [{ toolUses: [respond('hi')] }] });
    s.deps.autopilot = co();
    await runAgent({ route: route(CTO), msg: humanMsg('hello'), task: null, history: [] }, s.deps); // no deps.conversation: no hook
    expect((s.provider as FakeProvider).calls[0]!.system).not.toContain(COMPANY_AUTOPILOT_NOTE);
    const h = await setup({ script: [{ toolUses: [respond('hi')] }] });
    h.deps.autopilot = co();
    h.deps.conversation = { open: async () => owned(h.tasks, CTO) } as never;
    await runAgent({ route: route(CTO), msg: humanMsg('hello'), task: null, history: [] }, h.deps);
    expect((h.provider as FakeProvider).calls[0]!.system).toContain(COMPANY_AUTOPILOT_NOTE);
    const { s: t, task } = await rig(co());
    await runAgent({ route: route(CTO), task, history: [] }, t.deps);
    expect(first(t).system).toContain(COMPANY_AUTOPILOT_NOTE);
  });

  it('the project note wins when a live project is found', async () => {
    const { s, task } = await rig(co({ projectOf: async () => PROJECT }));
    await runAgent({ route: route(CTO), task, history: [] }, s.deps);
    expect(first(s).system).toContain('AUTOPILOT (code note, project #7');
    expect(first(s).system).not.toContain(COMPANY_AUTOPILOT_NOTE);
  });

  it('no note: companyOn false or throwing, inCompany false / rejecting / absent for a task run, no port, a post-only run, or an admin run', async () => {
    const cases: [string, AgentDeps['autopilot']][] = [
      ['off', co({ companyOn: () => false })],
      ['companyOn throws', co({ companyOn: () => { throw new Error('x'); } })],
      ['not in company', co({ inCompany: async () => false })],
      ['inCompany rejects', co({ inCompany: async () => { throw new Error('x'); } })],
      ['no inCompany', (() => { const { inCompany: _i, ...rest } = co(); return rest; })()],
      ['no port', undefined],
      ['project-only wiring', { ...base, projectOf: async () => null, toolsFor: async () => [], decide: async () => ({ kind: 'card' }) }],
    ];
    for (const [name, ap] of cases) {
      const { s, task } = await rig(ap);
      await runAgent({ route: route(CTO), task, history: [] }, s.deps);
      expect(first(s).system, name).not.toContain('AUTOPILOT (code note');
    }
  });

  it('a post-only run and an admin console run get no company note and no port', async () => {
    const seen: { ctx?: ToolContext } = {};
    const s = await setup({ script: [{ toolUses: [{ name: 'config_get', input: {} }] }, { toolUses: [respond('ok')] }] });
    const admin = new ToolRegistry({ halt: s.deps.halt });
    admin.register({ ...probe('config_get', seen) });
    s.deps.adminTools = admin;
    s.deps.autopilot = co();
    await runAgent({ route: route(CTO), msg: humanMsg('config?', { isAdmin: true }), task: null, history: [], admin: true }, s.deps);
    expect(seen.ctx!.autopilot).toBeUndefined();
    expect((s.provider as FakeProvider).calls[0]!.system).not.toContain('AUTOPILOT (code note');
    const p = await rig(co());
    await runAgent({ route: route(CTO), task: p.task, history: [], postOnly: true }, p.s.deps);
    expect(first(p.s).system).not.toContain('AUTOPILOT (code note');
  });
});

describe('AUTO-2 loop: tree tools and the port', () => {
  it('the task-tree grants join the offer AND the dispatch list in a company tree', async () => {
    const { s, task } = await rig(co({ treeToolsFor: async (id, a) => (id.length > 0 && a.kind === 'head' ? ['probe_read'] : []) }));
    await runAgent({ route: route(CTO), task, history: [] }, s.deps);
    expect(first(s).tools?.map((t) => t.name)).toContain('probe_read');
    expect(toolResult(s)).toMatchObject({ content: 'ran' });
  });

  it('treeToolsFor throwing, companyOn false or a project run gives no extra tools (and the call is refused as not allowed)', async () => {
    for (const ap of [co({ treeToolsFor: async () => { throw new Error('x'); } }), co({ companyOn: () => false, treeToolsFor: async () => ['probe_read'] }), co({ projectOf: async () => PROJECT, toolsFor: async () => [], treeToolsFor: async () => ['probe_read'] })]) {
      const { s, task } = await rig(ap);
      await runAgent({ route: route(CTO), task, history: [] }, s.deps);
      expect(first(s).tools?.map((t) => t.name)).not.toContain('probe_read');
      expect(toolResult(s).isError).toBe(true);
    }
  });

  it('the port spread: companyOn and inCompany are handed to the tools only when present; the project-only rig keeps exactly decide and projectOf', async () => {
    const a: { ctx?: ToolContext } = {};
    const both = await rig(co({ treeToolsFor: async () => ['probe_read'] }), a);
    await runAgent({ route: route(CTO), task: both.task, history: [] }, both.s.deps);
    expect(Object.keys(a.ctx!.autopilot!).sort()).toEqual(['companyOn', 'decide', 'inCompany', 'projectOf']);
    const b: { ctx?: ToolContext } = {};
    const none = await rig({ ...base, projectOf: async () => PROJECT, toolsFor: async () => ['probe_read'], decide: async () => ({ kind: 'card' }) }, b);
    await runAgent({ route: route(CTO), task: none.task, history: [] }, none.s.deps);
    expect(Object.keys(b.ctx!.autopilot!).sort()).toEqual(['decide', 'projectOf']);
  });
});
