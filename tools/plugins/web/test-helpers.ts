import { vi } from 'vitest';
import { CTO, MemNotes, MemTasks, auditSpy, newBus, runCtxBase, seededOrg } from '../../../agents/test-helpers.js';
import { FakeConfig } from '../../../governance/test-helpers.js';
import { Limits } from '../../../governance/limits.js';
import { ToolRegistry } from '../../registry.js';
import type { ToolContext, ToolPlugin } from '../../types.js';

/** A registry holding `tools` plus a plain delegated ToolContext whose actor may call them; the actor owns the task (I1). */
export async function webRig(tools: ToolPlugin<any>[], over: Partial<ToolContext> = {}) {
  const reg = new ToolRegistry({ halt: { isHalted: () => false } });
  for (const t of tools) reg.register(t);
  const tasks = new MemTasks();
  const task = await tasks.create({ title: 't', description: 'd', deptId: 'software', owner: over.actor ?? CTO, requester: { kind: 'human', userId: '42' }, origin: 'chat' });
  const approvals = { needsApproval: () => false, request: vi.fn(async () => ({}) as never) };
  const org = Object.assign(await seededOrg(), { toolsFor: () => tools.map((t) => t.name) });
  const c: ToolContext = {
    actor: CTO, task, ...runCtxBase(), org, tasks, approvals, limits: new Limits(new FakeConfig(), tasks), bus: newBus(),
    notes: new MemNotes(), audit: auditSpy().audit, ...over,
  };
  return { reg, c, approvals };
}
