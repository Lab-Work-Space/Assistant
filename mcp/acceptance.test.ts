import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CTO, MemNotes, MemTasks, auditSpy, newBus, runCtxBase, seededOrg } from '../agents/test-helpers.js';
import { isNonSensitiveTool } from '../discord/approval/approval-rooms.js';
import { precheckCall } from '../governance/ai-approver.js';
import { AutopilotService } from '../governance/autopilot.js';
import { Limits } from '../governance/limits.js';
import { FakeConfig } from '../governance/test-helpers.js';
import { classOf } from '../tools/manifest/catalog.js';
import { ToolRegistry } from '../tools/registry.js';
import { skillToolAllowed } from '../tools/skill-grant.js';
import { treeGrantEligible } from '../tools/tree-grant-scope.js';
import type { ToolContext, ToolPlugin } from '../tools/types.js';
import { StuckLatch } from './sandbox.js';
import { Slots } from './slots.js';
import type { HostServer, HostTool } from './host.js';
import { createMcpToolFactory, type McpToolDeps } from './tool.js';

/** R6 MCP-1 BE2 (MCP-AC15, MC-C10 approval part): the class decides approval, end to end through the real registry and the real autopilot service. */
const HASH = 'a'.repeat(64);
const server = (cls: 'read' | 'write'): HostServer => ({ id: 1, slug: 'ab', cls, imageId: `sha256:${'c'.repeat(64)}`, command: [], env: {}, timeoutMs: 5000, maxCallsPerDay: 50, hash: HASH, depts: ['software'] });
const toolOf = (cls: 'read' | 'write'): HostTool => ({ name: `mcp_${cls === 'read' ? 'r' : 'w'}_ab_x`, orig: 'x', description: 'd', schema: z.object({ q: z.string() }).strict() as never });

function plugin(cls: 'read' | 'write'): { plugin: ToolPlugin<Record<string, unknown>>; ran: ReturnType<typeof vi.fn> } {
  const d = {
    host: { entry: () => ({ server: server(cls) }), refresh: async () => undefined }, repo: { claim: async () => 'ok', quarantine: async () => ({ ok: false }) }, sandbox: { docker: { exec: async () => ({ code: 1, stdout: '', timedOut: false, missing: false }) }, spawn: () => { throw new Error('no'); }, isHalted: () => false, latch: new StuckLatch() },
    slots: new Slots(), enabled: () => true, halted: () => false, tz: () => 'UTC', caps: () => ({ tree: 40, day: 200 }), audit: async () => undefined, secrets: () => [], notify: async () => undefined, log: { error: () => undefined },
  } as unknown as McpToolDeps;
  const p = createMcpToolFactory(d)(server(cls), toolOf(cls));
  const ran = vi.fn(async () => ({ content: 'out' }));
  return { plugin: { ...p, precheck: undefined, run: ran } as ToolPlugin<Record<string, unknown>>, ran };
}

async function rig(cls: 'read' | 'write', o: { direct?: boolean; autopilot?: 'project' | 'company' | null; tainted?: boolean } = {}) {
  const { plugin: p, ran } = plugin(cls);
  const reg = new ToolRegistry({ halt: { isHalted: () => false }, autopilot: true, external: { get: (n) => (n === p.name ? p : undefined), names: () => [p.name] } });
  const tasks = new MemTasks();
  const spy = auditSpy();
  const approvals = { needsApproval: () => false, request: vi.fn(async () => ({ id: 9 }) as never) };
  const org = Object.assign(Object.create(await seededOrg()) as object, { toolsFor: () => [p.name] }) as never;
  const task = await tasks.create({ title: 'x', deptId: 'software', owner: CTO, requester: { kind: 'human', userId: '1' }, origin: 'chat' });
  const claim = vi.fn(async () => ({ kind: 'run' as const, used: 1, max: 500 }));
  const svc = new AutopilotService({
    cfg: new FakeConfig({ 'autopilot.scope': o.autopilot === 'company' ? 'company' : 'project' } as never), halted: () => false, secrets: [], exhausted: async () => true, log: { error: () => undefined },
    repo: {
      projectOf: async () => (o.autopilot === 'project' ? { id: 4, rootTaskId: task.id, deadline: '2026-12-31' } : null), claimApproval: claim, toolsFor: async () => [], toolsForTask: async () => [], grantTool: vi.fn(),
      companyRoot: async () => task.id, claimCompany: vi.fn(async () => ({ kind: 'run', used: 1, max: 5 }) as never), grantTreeTool: vi.fn(), treeToolsFor: async () => [],
    },
    org: { persona: () => null }, describe: (n) => reg.describe(n),
  });
  const base: ToolContext = {
    actor: CTO, task, ...runCtxBase(), direct: o.direct ?? false, org, tasks, approvals, limits: new Limits(new FakeConfig(), tasks), bus: newBus(), notes: new MemNotes(), audit: spy.audit,
    ...(o.autopilot ? { autopilot: svc } : {}),
  };
  const c = base;
  if (o.tainted) c.run.markTainted();
  const res = await reg.run(p.name, { q: 'hello' }, c);
  return { res, ran, approvals, claim, spy, name: p.name };
}

describe('MCP-AC15: a read call has no card in direct, project and company contexts', () => {
  for (const [label, o] of [['direct', { direct: true }], ['chat', {}], ['project autopilot', { autopilot: 'project' as const }], ['company autopilot', { autopilot: 'company' as const }], ['tainted run', { tainted: true }]] as const) {
    it(label, async () => {
      const r = await rig('read', o);
      expect(r.approvals.request, label).not.toHaveBeenCalled();
      expect(r.ran, label).toHaveBeenCalledTimes(1);
      expect(r.res.isError).not.toBe(true);
      expect(r.res.content).toContain('out');
    });
  }
});

describe('MCP-AC15: a write call always gets a card, autopilot never waives it', () => {
  for (const [label, o] of [['direct untainted chat', { direct: true }], ['task chat', {}], ['project autopilot', { autopilot: 'project' as const }], ['company autopilot', { autopilot: 'company' as const }], ['direct under company autopilot', { direct: true, autopilot: 'company' as const }]] as const) {
    it(label, async () => {
      const r = await rig('write', o);
      expect(r.approvals.request, label).toHaveBeenCalledTimes(1);
      expect(r.ran, label).not.toHaveBeenCalled();
      expect(r.res.content).toMatch(/^NOT DONE YET/);
      expect(r.claim, label).not.toHaveBeenCalled();
    });
  }
});

describe('MCP-AC15: the sensitive class keeps the card in #setting, out of batches, grants and the AI approver', () => {
  const NAMES = ['mcp_r_ab_x', 'mcp_w_ab_x'];
  it('both profiles are sensitive', () => {
    for (const n of NAMES) {
      expect(classOf(n)).toMatchObject({ group: 'mcp', sensitive: true });
      expect(isNonSensitiveTool(n), n).toBe(false);
    }
    expect(classOf('mcp_w_ab_x').autopilot).toBe('always_card');
  });
  it('the AI approver hard-denies both before any judge call', () => {
    for (const n of NAMES) expect(precheckCall(n, { q: 'x' }, () => ({ kind: n === 'mcp_r_ab_x' ? 'read' : 'write' })), n).toBe('hard_deny:sensitive');
  });
  it('the tree grant and the skill grant refuse both', () => {
    for (const n of NAMES) {
      const kind = n === 'mcp_r_ab_x' ? 'read' : 'write';
      expect(treeGrantEligible({ kind: 'tool', toolName: n, toolInput: { q: 'x' }, inputSha256: 'a'.repeat(64) }, () => kind), n).toBe(false);
      expect(skillToolAllowed(n, { registered: () => [n], builtins: () => [], kindOf: () => kind }), n).toBe(false);
    }
  });
});
