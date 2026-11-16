import { describe, expect, it } from 'vitest';
import { AiDigest, type ForgeDay } from './ai-digest.js';

/** R7 PLUGIN-FORGE BE2 (spec 5.10, FG-AC24): one fixed line and five integers; omitted when all are 0; a read failure is isolated. */
const day = { reviews: 0, approvals: [], escalations: [], reasons: [], capHit: false } as never;
const f = (o: Partial<ForgeDay> = {}): ForgeDay => ({ builds: 2, staged: 1, failed: 1, installed: 1, waiting: 3, ...o });
const mk = () => new AiDigest({ repo: { day: async () => day }, cfg: { get: () => 'Asia/Bangkok' } as never, now: () => Date.now(), log: { error() {} }, daily: { claim: async () => true }, post: async () => undefined });

describe('R7 digest line', () => {
  it('the exact text', () => {
    expect(mk().payload(day, undefined, undefined, undefined, undefined, f())?.body).toContain('Plugin forge today: 2 build(s), 1 staged, 1 failed, 1 installed; 3 waiting for /mcp approve.');
  });
  it('omitted when all five are 0 (and then there is no digest at all); one non-zero count keeps it', () => {
    expect(mk().payload(day, undefined, undefined, undefined, undefined, f({ builds: 0, staged: 0, failed: 0, installed: 0, waiting: 0 }))).toBeNull();
    expect(mk().payload(day, undefined, undefined, undefined, undefined, f({ builds: 0, staged: 0, failed: 0, installed: 0, waiting: 2 }))?.body).toContain('2 waiting for /mcp approve');
  });
  it('counts are coerced to integers (no text can enter the line)', () => {
    const body = mk().payload(day, undefined, undefined, undefined, undefined, f({ builds: '4; @everyone' as never }))?.body ?? '';
    expect(body).not.toContain('@everyone');
  });
  it('tick reads the day through the closure; a failed read leaves the rest of the digest and logs errName only', async () => {
    const posts: string[] = [];
    const logs: unknown[] = [];
    const mkTick = (read: () => Promise<ForgeDay>, reviews: number) => new AiDigest({
      repo: { day: async () => ({ ...(day as object), reviews }) as never }, forge: { day: read }, cfg: { get: () => 'UTC' } as never, now: () => new Date('2026-11-12T18:30:00Z'), log: { error: (o) => void logs.push(o) },
      daily: { claim: async () => true }, post: async (p) => void posts.push((p as { body: string }).body),
    });
    await mkTick(async () => f(), 0).tick();
    expect(posts[0]).toContain('Plugin forge today: 2 build(s)');
    await mkTick(async () => { throw new TypeError('db'); }, 2).tick();
    expect(posts[1]).toContain('Reviews today: 2.');
    expect(posts[1]).not.toContain('Plugin forge today');
    expect(logs).toContainEqual({ errName: 'TypeError' });
  });
});
