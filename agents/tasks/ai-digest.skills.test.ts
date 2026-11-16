import { describe, expect, it, vi } from 'vitest';
import type { AiDay } from '../../db/repos/ai-approver.js';
import type { SkillAiDay } from '../../db/repos/skill-ai.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { AiDigest } from './ai-digest.js';

const AT_1800 = Date.parse('2026-11-08T11:00:00Z');
const EMPTY: AiDay = { approvals: [], escalations: [], reasons: [], capHit: false, reviews: 0 };
const SKILLS: SkillAiDay = { applied: [{ skillId: 'handover', deptId: 'software', version: 2 }], escalations: [{ code: 'url', n: 1 }, { code: 'apply:stale', n: 2 }] };

function mk(o: { day?: AiDay; skills?: SkillAiDay; skillsFail?: boolean; noSkills?: boolean } = {}) {
  const posts: { title?: string; body: string }[] = [];
  const claims: string[] = [];
  const log = { error: vi.fn() };
  const d = {
    repo: { day: async () => o.day ?? EMPTY },
    ...(o.noSkills ? {} : { skills: { day: async () => { if (o.skillsFail) throw new RangeError('x'); return o.skills ?? { applied: [], escalations: [] }; } } }),
    cfg: new FakeConfig({}), now: () => AT_1800, log, secrets: [],
    daily: { claim: async (day: string, kind: 'ai_digest') => { claims.push(`${day}:${kind}`); return true; } },
    post: async (p: { title?: string; body: string }) => void posts.push(p),
  };
  return { dg: new AiDigest(d as never), posts, claims, log };
}

describe('GROW-1 (C11): the digest Skills part', () => {
  it('posts with zero approval reviews when the Skills part has rows, under the same ai_digest claim', async () => {
    const t = mk({ skills: SKILLS });
    await t.dg.tick();
    expect(t.claims).toEqual(['2026-11-08:ai_digest']);
    const body = t.posts[0]!.body;
    expect(body).toContain('Skills applied by the AI:\n- handover v2 (software)');
    expect(body).toContain('Skill proposals escalated, per code:\n- url: 1\n- apply:stale: 2'.replace('apply:stale', 'apply:stale'));
  });
  it('only escalations (no applies) is enough too; only applies is enough too', () => {
    const t = mk();
    expect(t.dg.payload(EMPTY, { applied: [], escalations: [{ code: 'url', n: 1 }] })).not.toBeNull();
    expect(t.dg.payload(EMPTY, { applied: SKILLS.applied, escalations: [] })).not.toBeNull();
  });
  it('null only when reviews < 1 and both skill lists are empty; the approval digest alone is unchanged', async () => {
    const t = mk();
    expect(t.dg.payload(EMPTY)).toBeNull();
    expect(t.dg.payload(EMPTY, { applied: [], escalations: [] })).toBeNull();
    await t.dg.tick();
    expect(t.claims).toHaveLength(0);
    const only = mk({ day: { ...EMPTY, reviews: 1, approvals: [{ tool: 'web_search', n: 1 }] } });
    const p = only.dg.payload({ ...EMPTY, reviews: 1, approvals: [{ tool: 'web_search', n: 1 }] })!;
    expect(p.body).not.toContain('Skills applied');
    expect(p.body).not.toContain('Skill proposals escalated');
  });
  it('ids and codes are escaped like the other digest text', () => {
    const t = mk();
    const p = t.dg.payload(EMPTY, { applied: [{ skillId: 'a_b', deptId: 'x<@1>', version: 1 }], escalations: [] })!;
    expect(p.body).not.toMatch(/(^|[^\\])<@/);
  });
  it('a failing skills read does not stop the approval digest', async () => {
    const t = mk({ day: { ...EMPTY, reviews: 2 }, skillsFail: true });
    await t.dg.tick();
    expect(t.posts).toHaveLength(1);
    expect(t.log.error).toHaveBeenCalledWith({ errName: 'RangeError' }, 'ai digest skills read failed');
  });
  it('no skills dependency: same as before', async () => {
    const t = mk({ noSkills: true });
    await t.dg.tick();
    expect(t.posts).toHaveLength(0);
  });
});
