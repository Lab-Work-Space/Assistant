import { describe, expect, it, vi } from 'vitest';
import { FakeConfig } from '../governance/test-helpers.js';
import { REQUEST_TEXT, ToolRequestService, type ToolRequestDeps } from './tool-requests.js';
import { planBotTools, type PlanDeps } from '../discord/commands/plans.js';

/** R6 MCP-1 BE2 (spec 5.8, MC-C14): `tool_request` and the grant plan refuse mcp_ names with one fixed text. */
const R = 'mcp_r_ab_x';
const TEXT = 'MCP tools are granted with /mcp depts.';
const HEAD = { kind: 'head', dept: 'rnd' } as const;

describe('tool_request refuses an mcp_ name before anything else', () => {
  it('even when a (hypothetical) registry lists it: fixed text, no row, no card, the project grant port is never asked', async () => {
    const create = vi.fn();
    const projectGrant = vi.fn();
    const audits: { outcome?: string | null }[] = [];
    const deps = {
      repo: { create }, cfg: new FakeConfig({ 'tools.byDept': {} } as never), org: { dept: () => ({}) as never, toolsFor: () => ['respond'] },
      grant: { registered: () => ['web_search', R], builtins: () => ['respond'], kindOf: () => 'read' }, plugins: () => ['web_search', R], halted: () => false,
      audit: async (e: never) => void audits.push(e), secrets: [], configChannelId: '1', postCard: vi.fn(), closeCard: vi.fn(), notifyHead: vi.fn(), log: { error: () => undefined }, projectGrant,
    } as unknown as ToolRequestDeps;
    const r = await new ToolRequestService(deps).request(HEAD, { tainted: false, task: { id: 't1', tainted: false }, ownsTask: true }, { tool: R, reason: 'need it' });
    expect(r).toEqual({ ok: false, code: 'mcp', error: TEXT });
    expect(REQUEST_TEXT.mcp).toBe(TEXT);
    expect(create).not.toHaveBeenCalled();
    expect(projectGrant).not.toHaveBeenCalled();
    expect(audits.at(-1)?.outcome).toBe('refused:mcp');
  });
});

describe('the grant plan (/bot tools, /tool cards, admin_op bot_tools) refuses mcp_ names', () => {
  const deps = { org: { dept: () => ({}) as never }, cfg: new FakeConfig({ 'tools.byDept': { software: [R] } } as never), tools: { plugins: () => ['web_search', R] } } as unknown as PlanDeps;
  it('add and remove both give the fixed text and no write', () => {
    for (const action of ['add', 'remove']) {
      const p = planBotTools('software', action, R, deps);
      expect(p, action).toEqual({ error: TEXT });
    }
    expect('error' in planBotTools('software', 'add', 'web_search', deps)).toBe(false);
  });
});
