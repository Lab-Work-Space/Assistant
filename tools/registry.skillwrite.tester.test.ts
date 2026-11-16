import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Org, SEED_DEPARTMENTS, SEED_PERSONAS, type OrgRepos } from '../company/index.js';
import { CTO, MemNotes, MemTasks, auditSpy, newBus, prompts, runCtxBase } from '../agents/test-helpers.js';
import { Limits } from '../governance/limits.js';
import { FakeConfig } from '../governance/test-helpers.js';
import type { SkillSnapshot } from '../skills/types.js';
import { createToolPolicy } from './policy.js';
import { ToolRegistry } from './registry.js';
import type { ToolContext, ToolPlugin } from './types.js';

/** A skill grants a plugin tool to the software head; after a detach the very same call (also an approved one) is denied. */

/** SKILLS-1 tester (d): a skill-granted WRITE plugin tool still goes through the normal approval, and does not run. */
describe('skill-granted write tool keeps its normal approval', () => {
  it('request is filed (tool not run) while attached; denied after detach', async () => {
    let snap: SkillSnapshot = {
      skills: [{ id: 'crm', title: 'CRM', status: 'active', activeVersion: 1, ownerDept: null, instructions: 'Use the CRM tool for notes.', templates: [], tools: ['clickup_update_task'], bodyBytes: 10, bodySha256: 'a'.repeat(64) }],
      attachments: [{ skillId: 'crm', targetKind: 'dept', targetId: 'software', priority: 100 }],
    };
    const depts = SEED_DEPARTMENTS.map((d) => ({ ...d, model: null, provider: null, enabled: true }));
    const personas = Object.entries(SEED_PERSONAS).map(([id, p]) => ({ id, deptId: p.dept, name: id, avatarUrl: null, promptRef: `members/${id}`, model: null, provider: null, tools: [], directChannelId: p.directChannelId, enabled: true }));
    const org = await Org.load({ departments: { list: async () => depts }, personas: { list: async () => personas }, channelMap: { list: async () => [] }, skills: { loadAll: async () => snap } } as unknown as OrgRepos, prompts);
    const reg = new ToolRegistry({ halt: { isHalted: () => false } });
    const run = vi.fn(async () => ({ content: 'ran' }));
    // requiresApproval false on purpose: the central gate (kind write) must still ask
    const t: ToolPlugin<{ n: number }> = { name: 'clickup_update_task', description: 'x', inputSchema: z.object({ n: z.number() }), kind: 'write', requiresApproval: () => false, run };
    reg.register(t);
    org.setToolPolicy(createToolPolicy(new FakeConfig(), () => reg.names(), () => [], (n) => reg.kindOf(n)));
    const tasks = new MemTasks();
    const task = await tasks.create({ title: 't', description: 'd', owner: CTO, creator: CTO } as never).catch(() => null);
    const request = vi.fn(async () => ({ id: 7 }) as never);
    const spy = auditSpy();
    const c: ToolContext = { actor: CTO, task: task as never, ensureConversationTask: async () => ({ id: 'conv-1', rootId: 'conv-1', owner: CTO } as never), ...runCtxBase(), org, tasks, approvals: { needsApproval: () => false, request }, limits: new Limits(new FakeConfig(), tasks), bus: newBus(), notes: new MemNotes(), audit: spy.audit };
    const out = await reg.run('clickup_update_task', { n: 1 }, c);
    expect(run).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
    expect(out.content).toContain('NOT DONE YET');
    snap = { ...snap, attachments: [] };
    await org.reload();
    expect(await reg.runApproved('clickup_update_task', { n: 1 }, c)).toMatchObject({ isError: true, content: expect.stringContaining('not allowed for you') });
    expect(run).not.toHaveBeenCalled();
  });
});
