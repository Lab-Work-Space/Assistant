import { describe, expect, it, vi } from 'vitest';
import type { AiDay } from '../../db/repos/ai-approver.js';
import type { ProjectDay } from '../../db/repos/projects.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { AiDigest } from './ai-digest.js';

const AT_1800 = Date.parse('2026-11-08T11:00:00Z');
const NO_REVIEWS: AiDay = { approvals: [], escalations: [], reasons: [], capHit: false, reviews: 0 };
const EMPTY: ProjectDay = { projects: [], tools: [], refused: [], exhausted: [], grants: [] };
const AUTO: ProjectDay = {
  projects: [{ id: 3, title: 'Big **launch** @everyone', n: 12 }, { id: 4, title: 'Small', n: 2 }],
  tools: [{ tool: 'web_search', n: 9 }, { tool: 'clickup_create_task', n: 5 }],
  refused: [{ code: 'query_heuristic', n: 2 }],
  exhausted: [{ id: 3, title: 'Big **launch**' }],
  grants: [{ projectId: 3, dept: 'software', tool: 'read_file' }],
};

function mk(o: { auto?: ProjectDay; autoFails?: boolean; none?: boolean } = {}) {
  const posts: { title?: string; body: string }[] = [];
  const claims: string[] = [];
  const log = { error: vi.fn() };
  const d = {
    repo: { day: async () => NO_REVIEWS },
    ...(o.none ? {} : { autopilot: { day: async () => { if (o.autoFails) throw new RangeError('x'); return o.auto ?? EMPTY; } } }),
    cfg: new FakeConfig({}), now: () => AT_1800, log, secrets: [],
    daily: { claim: async (day: string, kind: 'ai_digest') => { claims.push(`${day}:${kind}`); return true; } },
    post: async (p: { title?: string; body: string }) => void posts.push(p),
  };
  return { dg: new AiDigest(d as never), posts, claims, log };
}

describe('AUTO-1 (SA-1 3.10): the digest Autopilot part', () => {
  it('posts with zero reviews when the Autopilot part has rows, under the same ai_digest claim; the sections are in the spec order', async () => {
    const t = mk({ auto: AUTO });
    await t.dg.tick();
    expect(t.claims).toEqual(['2026-11-08:ai_digest']);
    const b = t.posts[0]!.body;
    expect(b).toContain('Autopilot:\nApproved without a card, per project:\n- #3 Big \\*\\*launch\\*\\* @​everyone: 12\n- #4 Small: 2');
    expect(b).toContain('Per tool:\n- web\\_search: 9\n- clickup\\_create\\_task: 5');
    expect(b).toContain('Refused as data-like, per code:\n- query\\_heuristic: 2');
    expect(b).toContain('Budget used up today:\n- #3 Big \\*\\*launch\\*\\*');
    expect(b).toContain('Tools granted to a project today:\n- #3 software read\\_file');
    expect(b).not.toContain('@everyone');
    expect(b.indexOf('Approved without')).toBeLessThan(b.indexOf('Per tool:'));
    expect(b.indexOf('Per tool:')).toBeLessThan(b.indexOf('Refused as data-like'));
    expect(b.indexOf('Refused as data-like')).toBeLessThan(b.indexOf('Budget used up today'));
  });
  it('null only when reviews < 1, skills empty and auto empty; payload(day) with two arguments is unchanged', async () => {
    const t = mk();
    expect(t.dg.payload(NO_REVIEWS)).toBeNull();
    expect(t.dg.payload(NO_REVIEWS, { applied: [], escalations: [] }, EMPTY)).toBeNull();
    expect(t.dg.payload(NO_REVIEWS, { applied: [], escalations: [] }, { ...EMPTY, refused: [{ code: 'masked_input', n: 1 }] })).not.toBeNull();
    await t.dg.tick();
    expect(t.claims).toHaveLength(0);
    const only = t.dg.payload({ ...NO_REVIEWS, reviews: 1, approvals: [{ tool: 'web_search', n: 1 }] })!;
    expect(only.body).not.toContain('Autopilot:');
  });
  it('shows only the parts that have rows, and at most 10 tools', () => {
    const t = mk();
    const body = t.dg.payload(NO_REVIEWS, undefined, { ...EMPTY, tools: Array.from({ length: 14 }, (_, i) => ({ tool: `t${i}`, n: 14 - i })) })!.body;
    expect(body).toContain('Per tool:');
    expect(body).not.toContain('Approved without a card');
    expect(body).not.toContain('Refused as data-like');
    expect(body).not.toContain('Budget used up');
    expect(body).toContain('- t9: 5');
    expect(body).not.toContain('- t10: 4');
  });
  it('a failing Autopilot read is logged by error name and never blocks the rest of the digest; no repo means no part', async () => {
    const t = mk({ autoFails: true });
    await t.dg.tick();
    expect(t.log.error).toHaveBeenCalledWith({ errName: 'RangeError' }, 'ai digest autopilot read failed');
    expect(t.posts).toHaveLength(0);
    const n = mk({ none: true });
    await n.dg.tick();
    expect(n.posts).toHaveLength(0);
  });
});

describe('AUTO-2 (SA-1 5.6, AC-C13): the digest company section', () => {
  const CO: ProjectDay = { ...EMPTY, company: { total: 7, tools: [{ tool: 'web_search', n: 5 }, { tool: 'clickup_create_task', n: 2 }], capHit: 'tree', treeGrants: [{ root8: 'abcdef01', dept: 'rnd', tool: 'read_file' }] } };
  it('posts with zero reviews when only the company part has rows; the section lists counts, the cap and the tree grants', async () => {
    const t = mk({ auto: CO });
    await t.dg.tick();
    const b = t.posts[0]!.body;
    expect(b).toContain('Company autopilot (no project):\nApproved without a card: 7\nPer tool:\n- web\\_search: 5\n- clickup\\_create\\_task: 2\nCap reached today: a task tree cap\nTools granted to a task tree today:\n- abcdef01 rnd read\\_file');
    expect(b).not.toContain('Autopilot:\n');
  });
  it('a day cap alone, or a person cap alone, is enough; each has its fixed label; an empty company object posts nothing', async () => {
    for (const [cap, label] of [['day', 'daily cap'], ['person', 'a per-person daily cap']] as const) {
      const t = mk({ auto: { ...EMPTY, company: { total: 0, tools: [], capHit: cap, treeGrants: [] } } });
      await t.dg.tick();
      expect(t.posts[0]!.body).toContain(`Cap reached today: ${label}`);
    }
    const none = mk({ auto: { ...EMPTY, company: { total: 0, tools: [], capHit: null, treeGrants: [] } } });
    await none.dg.tick();
    expect(none.posts).toHaveLength(0);
  });
  it('the project section and the company section both show when both have rows', async () => {
    const t = mk({ auto: { ...AUTO, company: CO.company! } });
    await t.dg.tick();
    expect(t.posts[0]!.body).toContain('Autopilot:\nApproved without a card, per project:');
    expect(t.posts[0]!.body).toContain('Company autopilot (no project):');
  });
});
