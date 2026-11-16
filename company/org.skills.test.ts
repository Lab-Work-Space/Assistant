import { describe, expect, it } from 'vitest';
import { Org, SEED_DEPARTMENTS, SEED_PERSONAS, type OrgRepos } from './index.js';
import { prompts } from '../agents/test-helpers.js';
import { createToolPolicy } from '../tools/policy.js';
import { FakeConfig } from '../governance/test-helpers.js';
import { fitSkills, renderSkillsSection } from '../skills/render.js';
import type { AttachmentRow, SkillRow, SkillSnapshot } from '../skills/types.js';

const row = (id: string, o: Partial<SkillRow> = {}): SkillRow => ({ id, title: `Title ${id}`, status: 'active', activeVersion: 1, ownerDept: null, instructions: `Instructions for ${id}, long enough.`, templates: [], tools: [], bodyBytes: 100, bodySha256: 'a'.repeat(64), ...o });
const att = (skillId: string, targetKind: 'dept' | 'persona', targetId: string, priority = 100): AttachmentRow => ({ skillId, targetKind, targetId, priority });

async function orgWith(snap: () => Promise<SkillSnapshot>, edit?: (p: { enabled: boolean; id: string }) => void) {
  const depts = SEED_DEPARTMENTS.map((d) => ({ ...d, model: null, provider: null, enabled: true }));
  const personas = Object.entries(SEED_PERSONAS).map(([id, p]) => ({ id, deptId: p.dept, name: id, avatarUrl: null, promptRef: `members/${id}`, model: null, provider: null, tools: prompts.get(`members/${id}`)!.meta.tools, directChannelId: p.directChannelId, enabled: true }));
  if (edit) for (const p of personas) edit(p);
  const repos = { departments: { list: async () => depts }, personas: { list: async () => personas }, channelMap: { list: async () => [] }, skills: { loadAll: snap } } as unknown as OrgRepos;
  return Org.load(repos, prompts);
}
const head = { kind: 'head', dept: 'software' } as const;
const sa = { kind: 'persona', personaId: 'system-analyst' } as const;

describe('Org skills cache (SK11)', () => {
  const snap: SkillSnapshot = {
    skills: [row('zeta'), row('alpha'), row('beta', { status: 'disabled' }), row('gone', { status: 'archived' }), row('mine'), row('also', { tools: ['clickup_create_task'] })],
    attachments: [att('zeta', 'dept', 'software', 50), att('alpha', 'dept', 'software', 50), att('beta', 'dept', 'software'), att('gone', 'dept', 'software'), att('mine', 'persona', 'system-analyst', 1), att('also', 'persona', 'system-analyst', 5), att('zeta', 'persona', 'system-analyst', 1)],
  };

  it('order: department skills first, then persona skills; priority ascending, then id; disabled and archived excluded; a skill at both levels appears once', async () => {
    const org = await orgWith(async () => snap);
    expect(org.skillsFor(sa).map((s) => `${s.scope}:${s.id}`)).toEqual(['dept:alpha', 'dept:zeta', 'persona:mine', 'persona:also']);
  });

  it('a head sees department skills only; another department sees none', async () => {
    const org = await orgWith(async () => snap);
    expect(org.skillsFor(head).map((s) => s.id)).toEqual(['alpha', 'zeta']);
    expect(org.skillsFor({ kind: 'head', dept: 'hr' })).toEqual([]);
    expect(org.skillsFor({ kind: 'persona', personaId: 'research-scientist' })).toEqual([]);
  });

  it('a skill attached to a disabled persona is not injected, and an unknown persona gets none', async () => {
    const org = await orgWith(async () => snap, (p) => { if (p.id === 'system-analyst') p.enabled = false; });
    expect(org.skillsFor(sa)).toEqual([]);
    expect(org.skillsFor({ kind: 'persona', personaId: 'nobody' })).toEqual([]);
  });

  it('toolsFor adds skill tools through the policy (dept and persona skills), only for the actor they apply to', async () => {
    const org = await orgWith(async () => snap);
    const reg = ['create_task', 'update_task', 'respond', 'clickup_create_task'];
    org.setToolPolicy(createToolPolicy(new FakeConfig(), () => reg, () => ['create_task', 'update_task', 'respond'], (n) => (n === 'clickup_create_task' ? 'write' : 'read')));
    expect(org.toolsFor(sa)).toContain('clickup_create_task');
    expect(org.toolsFor({ kind: 'persona', personaId: 'project-manager' })).not.toContain('clickup_create_task');
    expect(org.toolsFor(head)).not.toContain('clickup_create_task');
  });

  it('a failed skills query leaves the earlier cache and tools unchanged and reports the fault; first boot fails closed', async () => {
    let fail = false;
    const faults: unknown[] = [];
    const org = await orgWith(async () => { if (fail) throw new Error('db down'); return snap; });
    org.setSkillsFaultSink((e) => faults.push(e));
    const before = org.skillsFor(sa);
    fail = true;
    await expect(org.reload()).rejects.toThrow(/skills reload failed/);
    expect(org.skillsFor(sa)).toEqual(before);
    expect(faults).toHaveLength(1);
    const first = await orgWith(async () => { throw new Error('db down at boot'); });
    expect(first.skillsFor(sa)).toEqual([]);
    expect(first.dept('software')).not.toBeNull();
  });

  it('identical input gives a byte-identical rendered block', async () => {
    const a = renderSkillsSection((await orgWith(async () => snap)).skillsFor(sa));
    const b = renderSkillsSection((await orgWith(async () => JSON.parse(JSON.stringify(snap)))).skillsFor(sa));
    expect(a).toBe(b);
    expect(a.startsWith('Team skills (approved by a Bot Admin)')).toBe(true);
  });

  it('overflow keeps the order and drops each skill that does not fit whole', () => {
    const big = (id: string, n: number) => ({ id, version: 1, title: id, instructions: 'x'.repeat(n), templates: [] });
    const { kept, dropped } = fitSkills([big('a', 2500), big('b', 2500), big('c', 2500), big('d', 2500), big('e', 2500), big('f', 100)], 8000);
    expect(kept.map((s) => s.id)).toEqual(['a', 'b', 'c', 'f']);
    expect(dropped).toEqual(['d', 'e']);
  });
});
