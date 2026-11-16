import { describe, expect, it, vi } from 'vitest';
import type { ActorRef } from '../company/types.js';
import { AutopilotService, type AutopilotDeps } from './autopilot.js';
import { FakeConfig } from './test-helpers.js';

/** R6 MCP-1 BE2 (MC-C1): no project-tool or tree-tool row can offer an mcp_ name, whatever the repo returns. */
const R = 'mcp_r_ab_x';
const W = 'mcp_w_ab_y';
const HEAD: ActorRef = { kind: 'head', dept: 'software' };

function svc(rows: { tools?: string[]; task?: string[]; tree?: string[] }, over: Partial<AutopilotDeps> = {}) {
  const grantTool = vi.fn(async () => ({ ok: true as const }));
  const grantTreeTool = vi.fn(async () => ({ ok: true as const, rootId: 'r' }));
  const d: AutopilotDeps = {
    cfg: new FakeConfig({ 'autopilot.scope': 'company' } as never), halted: () => false, secrets: [], exhausted: async () => true, log: { error: () => undefined },
    repo: {
      projectOf: async () => ({ id: 4, rootTaskId: 'r', deadline: '2026-12-31' }), claimApproval: vi.fn(), toolsFor: async () => rows.tools ?? [], toolsForTask: async () => rows.task ?? [],
      grantTool, companyRoot: async () => 'r', claimCompany: vi.fn(), grantTreeTool, treeToolsFor: async () => rows.tree ?? [],
    },
    org: { persona: () => null }, describe: () => ({ kind: 'read' }), ...over,
  };
  return { s: new AutopilotService(d), grantTool, grantTreeTool };
}

describe('MC-C1: AutopilotService drops mcp_ from the project and tree tool lists', () => {
  it('toolsFor, toolsForTask and treeToolsFor never return an mcp_ name, other names stay', async () => {
    const { s } = svc({ tools: ['web_search', R], task: [W, 'fetch_page'], tree: [R, W, 'read_file'] });
    expect(await s.toolsFor(4, HEAD)).toEqual(['web_search']);
    expect(await s.treeToolsFor('t1', HEAD)).toEqual(['read_file']);
    expect((await s.toolsForTask('t1', HEAD)).sort()).toEqual(['fetch_page', 'read_file']);
  });
  it('projectGrant never reaches the repo insert for an mcp_ name, in a project and in a company tree', async () => {
    const a = svc({});
    expect(await a.s.projectGrant({ dept: 'software', taskId: 't1', tool: R })).toEqual({ kind: 'not_project' });
    expect(a.grantTool).not.toHaveBeenCalled();
    const c = svc({});
    const noProject = new AutopilotService({
      cfg: new FakeConfig({ 'autopilot.scope': 'company' } as never), halted: () => false, secrets: [], exhausted: async () => true, log: { error: () => undefined }, org: { persona: () => null }, describe: () => ({ kind: 'read' }),
      repo: { projectOf: async () => null, claimApproval: vi.fn(), toolsFor: async () => [], toolsForTask: async () => [], grantTool: c.grantTool, companyRoot: async () => 'r', claimCompany: vi.fn(), grantTreeTool: c.grantTreeTool, treeToolsFor: async () => [] },
    });
    expect(await noProject.projectGrant({ dept: 'software', taskId: 't1', tool: W })).toEqual({ kind: 'not_project' });
    expect(c.grantTreeTool).not.toHaveBeenCalled();
  });
});
