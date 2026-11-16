import { describe, expect, it, vi } from 'vitest';
import { ForgeService, forgeCommandDeps, forgeDigestDeps } from './service.js';

/** R7 PLUGIN-FORGE BE2 (spec 5.3, 5.8; PF-C13; FG-AC21 holders): the closures the slash layer and the digest get are plain objects with exactly their own methods. */
describe('forgeCommandDeps', () => {
  const svc = { list: vi.fn(async () => []), show: vi.fn(async () => null), cancel: vi.fn(async () => ({ ok: false as const, code: 'busy' as const })), tick: vi.fn(), gc: vi.fn(), recover: vi.fn(), latch: {} };
  const d = forgeCommandDeps(svc as never);
  it('has exactly list, show and cancel as own properties and no prototype methods (no build, retry, tick, gc or recover)', () => {
    expect(Object.getOwnPropertyNames(d).sort()).toEqual(['cancel', 'list', 'show']);
    expect(Object.getPrototypeOf(d)).toBe(Object.prototype);
  });
  it('passes through to the service', async () => {
    await d.list(25);
    await d.show(3);
    await d.cancel({ id: 3, userId: '900000000000000001' });
    expect(svc.list).toHaveBeenCalledWith(25);
    expect(svc.show).toHaveBeenCalledWith(3);
    expect(svc.cancel).toHaveBeenCalledWith({ id: 3, userId: '900000000000000001' });
    expect(svc.tick).not.toHaveBeenCalled();
  });
});
describe('forgeDigestDeps', () => {
  it('exposes `day` and nothing else of the repo', async () => {
    const repo = { day: vi.fn(async () => ({ builds: 1, staged: 0, failed: 0, installed: 0, waiting: 0 })), enqueue: vi.fn(), fail: vi.fn() };
    const d = forgeDigestDeps(repo as never);
    expect(Object.getOwnPropertyNames(d)).toEqual(['day']);
    expect(await d.day('Asia/Bangkok')).toMatchObject({ builds: 1 });
    expect(repo.day).toHaveBeenCalledWith('Asia/Bangkok');
  });
});

describe('ForgeService list, show and cancel never throw', () => {
  const mk = (repo: Record<string, unknown>) => new ForgeService({ repo, docker: { exec: vi.fn() }, stage: vi.fn(), baseImageId: null, stageRoot: '/nonexistent/x', isHalted: () => false, forgeEnabled: () => true, tz: () => 'UTC', audit: vi.fn(), notify: vi.fn(), log: { error: vi.fn() } } as never);
  it('a repo fault is an empty list, null and `exception`', async () => {
    const boom = async (): Promise<never> => { throw new Error('db'); };
    const s = mk({ listItems: boom, detail: boom, adminCancel: boom });
    expect(await s.list(25)).toEqual([]);
    expect(await s.show(1)).toBeNull();
    expect(await s.cancel({ id: 1, userId: '900000000000000001' })).toEqual({ ok: false, code: 'exception' });
  });
  it('passes the repo answers through; the cancel id must be a positive integer', async () => {
    const adminCancel = vi.fn(async () => ({ ok: true as const, serverSlug: null, serverStatus: null }));
    const s = mk({ listItems: async () => [{ id: 1 }], detail: async () => ({ id: 1 }), adminCancel });
    expect(await s.list(500)).toEqual([{ id: 1 }]);
    expect(await s.show(1)).toEqual({ id: 1 });
    expect(await s.cancel({ id: 0, userId: '900000000000000001' })).toEqual({ ok: false, code: 'not_found' });
    expect(adminCancel).not.toHaveBeenCalled();
    expect(await s.cancel({ id: 2, userId: '900000000000000001' })).toMatchObject({ ok: true });
  });
});
