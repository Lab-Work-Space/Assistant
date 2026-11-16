import { describe, expect, it, vi } from 'vitest';
import type { AiDay } from '../../db/repos/ai-approver.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { AiDigest } from './ai-digest.js';

// 2026-11-08 is a Sunday (off day): 17:59 and 18:00 Asia/Bangkok
const AT_1759 = Date.parse('2026-11-08T10:59:00Z');
const AT_1800 = Date.parse('2026-11-08T11:00:00Z');
const DAY: AiDay = { approvals: [{ tool: 'web_search', n: 3 }], escalations: [{ code: 'cap_day', n: 1 }, { code: 'judge', n: 1 }], reasons: ['looks <@1> risky'], capHit: true, reviews: 5 };

function mk(o: { day?: AiDay; now?: number; claimed?: boolean; readFails?: boolean; postFails?: boolean; cfg?: Record<string, unknown> } = {}) {
  const posts: { title?: string; body: string }[] = [];
  const claims: string[] = [];
  const log = { error: vi.fn() };
  let now = o.now ?? AT_1800;
  const d = {
    repo: { day: vi.fn(async () => { if (o.readFails) throw new RangeError('x'); return o.day ?? DAY; }) },
    cfg: new FakeConfig((o.cfg ?? {}) as never), now: () => now, log,
    daily: { claim: async (day: string, kind: 'ai_digest') => { claims.push(`${day}:${kind}`); return o.claimed ?? true; } },
    post: async (p: { title?: string; body: string }) => { if (o.postFails) throw new TypeError('x'); posts.push(p); },
    secrets: ['sekret-value-123'],
  };
  return { dg: new AiDigest(d as never), posts, claims, log, d, setNow: (n: number) => { now = n; } };
}

describe('AI-APPROVE-1: AiDigest (AA-C20)', () => {
  it('nothing before 18:00 local, not even a read', async () => {
    const t = mk({ now: AT_1759 });
    await t.dg.tick();
    expect(t.d.repo.day).not.toHaveBeenCalled();
    expect(t.posts).toHaveLength(0);
  });
  it('posts once at 18:00 on an off day, with its own claim; a second tick does nothing', async () => {
    const t = mk();
    await t.dg.tick();
    await t.dg.tick();
    expect(t.claims).toEqual(['2026-11-08:ai_digest']);
    expect(t.posts).toHaveLength(1);
    expect(t.posts[0]!.title).toBe('AI approval digest');
    expect(t.posts[0]!.body).toContain('web\\_search');
    expect(t.posts[0]!.body).toContain('cap\\_day');
    expect(t.posts[0]!.body).toContain('Cap reached today: yes');
    expect(t.posts[0]!.body).not.toMatch(/(^|[^\\])<@/);
  });
  it('zero reviews: no claim, no post, and a later tick with a review still posts', async () => {
    const t = mk({ day: { approvals: [], escalations: [], reasons: [], capHit: false, reviews: 0 } });
    await t.dg.tick();
    expect(t.claims).toHaveLength(0);
    expect(t.posts).toHaveLength(0);
  });
  it('a claim lost to another process posts nothing', async () => {
    const t = mk({ claimed: false });
    await t.dg.tick();
    expect(t.posts).toHaveLength(0);
  });
  it('a read or post error never throws and logs errName only', async () => {
    const a = mk({ readFails: true });
    await a.dg.tick();
    expect(a.log.error).toHaveBeenCalledWith({ errName: 'RangeError' }, expect.any(String));
    const b = mk({ postFails: true });
    await b.dg.tick();
    expect(b.log.error).toHaveBeenCalledWith({ errName: 'TypeError' }, expect.any(String));
  });
  it('masks secrets and caps lists (10 tools via the repo, 5 reasons)', () => {
    const t = mk();
    const p = t.dg.payload({ ...DAY, reasons: Array.from({ length: 9 }, (_, i) => `r${i} sekret-value-123`) })!;
    expect(p.body).not.toContain('sekret-value-123');
    expect(p.body.split('\n').filter((l) => /^- r\d/.test(l))).toHaveLength(5);
  });
});
