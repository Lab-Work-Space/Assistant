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
describe('registry re-checks the skill grant on every exec, including runApproved (spec: runtime)', () => {
  const attached: SkillSnapshot = {
    skills: [{ id: 'crm', title: 'CRM', status: 'active', activeVersion: 1, ownerDept: null, instructions: 'Use the CRM tool for lookups.', templates: [], tools: ['music_queue'], bodyBytes: 10, bodySha256: 'a'.repeat(64) }],
    attachments: [{ skillId: 'crm', targetKind: 'dept', targetId: 'software', priority: 100 }],
  };
  async function setup() {
    let snap = attached;
    const depts = SEED_DEPARTMENTS.map((d) => ({ ...d, model: null, provider: null, enabled: true }));
    const personas = Object.entries(SEED_PERSONAS).map(([id, p]) => ({ id, deptId: p.dept, name: id, avatarUrl: null, promptRef: `members/${id}`, model: null, provider: null, tools: [], directChannelId: p.directChannelId, enabled: true }));
    const org = await Org.load({ departments: { list: async () => depts }, personas: { list: async () => personas }, channelMap: { list: async () => [] }, skills: { loadAll: async () => snap } } as unknown as OrgRepos, prompts);
    const reg = new ToolRegistry({ halt: { isHalted: () => false } });
    const run = vi.fn(async () => ({ content: 'ran' }));
    const crm: ToolPlugin<{ n: number }> = { name: 'music_queue', description: 'x', inputSchema: z.object({ n: z.number() }), kind: 'read', requiresApproval: () => false, run };
    reg.register(crm);
    org.setToolPolicy(createToolPolicy(new FakeConfig(), () => reg.names(), () => [], (n) => reg.kindOf(n)));
    const tasks = new MemTasks();
    const spy = auditSpy();
    const c: ToolContext = { actor: CTO, task: null, ...runCtxBase(), org, tasks, approvals: { needsApproval: () => false, request: vi.fn(async () => ({}) as never) }, limits: new Limits(new FakeConfig(), tasks), bus: newBus(), notes: new MemNotes(), audit: spy.audit };
    return { org, reg, run, c, detach: async () => { snap = { ...snap, attachments: [] }; await org.reload(); } };
  }

  it('allowed while attached; denied by run and by runApproved after the detach; the tool never ran the second time', async () => {
    const { reg, run, c, detach } = await setup();
    expect((await reg.run('music_queue', { n: 1 }, c)).content).toBe('ran');
    await detach();
    expect(await reg.run('music_queue', { n: 1 }, c)).toMatchObject({ isError: true, content: expect.stringContaining('not allowed for you') });
    expect(await reg.runApproved('music_queue', { n: 1 }, c)).toMatchObject({ isError: true, content: expect.stringContaining('not allowed for you') });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a disabled skill removes the tool the same way', async () => {
    const { org, reg, c } = await setup();
    expect(org.toolsFor(CTO)).toContain('music_queue');
    const snap = attached;
    (org as unknown as { skills: Map<string, unknown> }).skills.set('crm', { ...snap.skills[0], status: 'disabled' });
    expect(org.toolsFor(CTO)).not.toContain('music_queue');
    expect(await reg.run('music_queue', { n: 1 }, c)).toMatchObject({ isError: true });
  });
});
