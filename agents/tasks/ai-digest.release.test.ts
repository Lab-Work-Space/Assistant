import { describe, expect, it } from 'vitest';
import { AiDigest } from './ai-digest.js';

const day = { reviews: 0, approvals: [], escalations: [], reasons: [], capHit: false } as never;
const rel = { requested: 3, released: 1, rejected: 1, expired: 0, failed: 1, waiting: 2 };
const mk = (releases?: { day(tz: string): Promise<typeof rel> }) =>
  new AiDigest({ repo: { day: async () => day }, ...(releases ? { releases } : {}), cfg: { get: () => 'Asia/Bangkok' } as never, now: () => Date.now(), log: { error() {} }, daily: { claim: async () => true }, post: async () => undefined });

describe('R5 digest line', () => {
  it('the line has fixed text and counts; an all-zero day with no other part stays empty', () => {
    const p = mk().payload(day, undefined, undefined, rel);
    expect(p?.body).toContain('Releases:\nRequested 3, released 1, rejected 1, expired 0, failed 1; waiting now 2.');
    expect(mk().payload(day, undefined, undefined, { requested: 0, released: 0, rejected: 0, expired: 0, failed: 0, waiting: 0 })).toBeNull();
    expect(mk().payload(day)).toBeNull();
  });
  it('any non-zero count (waiting alone included) makes the digest non-empty; counts are coerced to integers', () => {
    expect(mk().payload(day, undefined, undefined, { requested: 0, released: 0, rejected: 0, expired: 0, failed: 0, waiting: 1 })).not.toBeNull();
    expect(mk().payload(day, undefined, undefined, { ...rel, requested: '3; @everyone' as never })?.body).not.toContain('@everyone');
  });
  it('tick reads the release day, posts it, and a failed read leaves the rest of the digest', async () => {
    const posts: string[] = [];
    const mkTick = (releases: { day(tz: string): Promise<typeof rel> }, reviews: number) => new AiDigest({
      repo: { day: async () => ({ ...(day as object), reviews }) as never }, releases, cfg: { get: () => 'UTC' } as never, now: () => new Date('2026-11-12T18:30:00Z'), log: { error() {} },
      daily: { claim: async () => true }, post: async (p) => void posts.push((p as { body: string }).body),
    });
    await mkTick({ day: async () => rel }, 0).tick();
    expect(posts[0]).toContain('Requested 3, released 1');
    await mkTick({ day: async () => { throw new Error('db'); } }, 2).tick();
    expect(posts[1]).toContain('Reviews today: 2.');
    expect(posts[1]).not.toContain('Releases:');
  });
});
