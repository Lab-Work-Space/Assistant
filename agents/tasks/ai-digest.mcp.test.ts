import { describe, expect, it } from 'vitest';
import { AiDigest } from './ai-digest.js';

/** R6 MCP-1 BE2 (spec 5.12, MCP-AC21): one fixed line with three integers; omitted at zero; a read failure is isolated. */
const day = { reviews: 0, approvals: [], escalations: [], reasons: [], capHit: false } as never;
const mcp = { calls: 12, failed: 3, quarantined: 1 };
const mk = () => new AiDigest({ repo: { day: async () => day }, cfg: { get: () => 'Asia/Bangkok' } as never, now: () => Date.now(), log: { error() {} }, daily: { claim: async () => true }, post: async () => undefined });

describe('R6 digest line', () => {
  it('the exact text, and nothing else when all three are 0', () => {
    expect(mk().payload(day, undefined, undefined, undefined, mcp)?.body).toContain('MCP today: 12 call(s), 3 failed, 1 quarantined.');
    expect(mk().payload(day, undefined, undefined, undefined, { calls: 0, failed: 0, quarantined: 0 })).toBeNull();
    expect(mk().payload(day, undefined, undefined, undefined, { calls: 0, failed: 0, quarantined: 2 })?.body).toContain('MCP today: 0 call(s), 0 failed, 2 quarantined.');
  });
  it('counts are coerced to integers (no text of a call can enter the line)', () => {
    const body = mk().payload(day, undefined, undefined, undefined, { calls: '4; @everyone' as never, failed: 1, quarantined: 0 })?.body ?? '';
    expect(body).not.toContain('@everyone');
  });
  it('tick reads the day through the closure, posts the line, and a failed read leaves the rest of the digest', async () => {
    const posts: string[] = [];
    const logs: unknown[] = [];
    const mkTick = (read: () => Promise<typeof mcp>, reviews: number) => new AiDigest({
      repo: { day: async () => ({ ...(day as object), reviews }) as never }, mcp: { day: read }, cfg: { get: () => 'UTC' } as never, now: () => new Date('2026-11-12T18:30:00Z'), log: { error: (o) => void logs.push(o) },
      daily: { claim: async () => true }, post: async (p) => void posts.push((p as { body: string }).body),
    });
    await mkTick(async () => mcp, 0).tick();
    expect(posts[0]).toContain('MCP today: 12 call(s), 3 failed, 1 quarantined.');
    await mkTick(async () => { throw new TypeError('db'); }, 2).tick();
    expect(posts[1]).toContain('Reviews today: 2.');
    expect(posts[1]).not.toContain('MCP today');
    expect(logs).toContainEqual({ errName: 'TypeError' });
  });
});
