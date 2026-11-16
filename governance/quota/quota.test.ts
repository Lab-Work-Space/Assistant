import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AlertKind } from '../../db/repos/quota.js';
import type { QuotaSnapshot, QuotaWindowName } from '../../providers/claude-code-local/quota.js';
import { QUOTA_HOLD_GRACE_MS, QuotaStore, quotaHoldUntil, quotaLines, type QuotaRepoPort } from './quota.js';

const snap = (five: number, week: number, o: { weekReset?: number; weekStatus?: 'allowed' | 'allowed_warning' | 'rejected' } = {}): QuotaSnapshot => ({
  status: 'allowed', rateLimitType: 'seven_day',
  windows: { five_hour: { utilization: five, resetsAt: 1794307800, status: 'allowed' }, seven_day: { utilization: week, resetsAt: o.weekReset ?? 1794614400, status: o.weekStatus ?? 'allowed' } },
});
function fake(failPost = false) {
  const claims = new Set<string>();
  const posts: { title: string; body: string }[] = [];
  const saved: QuotaSnapshot[] = [];
  const repo: QuotaRepoPort = {
    load: async () => null,
    save: async (s) => { saved.push(s); },
    claimAlert: async (w: QuotaWindowName, r: number, k: AlertKind) => { const key = `${w}:${r}:${k}`; if (claims.has(key)) return false; claims.add(key); return true; },
    releaseAlert: async (w, r, k) => { claims.delete(`${w}:${r}:${k}`); },
  };
  let fail = failPost;
  const store = new QuotaStore({ repo, alert: async (title, body) => { if (fail) throw new Error('x'); posts.push({ title, body }); }, timezone: () => 'Asia/Bangkok', now: () => 1_794_000_000_000, log: { error: () => {} } });
  return { store, posts, saved, claims, heal: () => { fail = false; } };
}
const settle = () => new Promise((r) => setTimeout(r, 10));

describe('USAGE-1 QuotaStore', () => {
  it('keeps the latest snapshot with observedAt, persists on change only', async () => {
    const f = fake();
    f.store.publish(snap(0.2, 0.5));
    f.store.publish(snap(0.2, 0.5));
    f.store.publish(snap(0.3, 0.5));
    await settle();
    expect(f.store.latest()?.snapshot.windows.five_hour?.utilization).toBe(0.3);
    expect(f.store.latest()?.observedAt.getTime()).toBe(1_794_000_000_000);
    expect(f.saved).toHaveLength(2);
  });
  it('alerts once per window and reset period at >= 90%, again for a new reset period', async () => {
    const f = fake();
    f.store.publish(snap(0.22, 0.89));
    await settle();
    expect(f.posts).toHaveLength(0);
    f.store.publish(snap(0.22, 0.91));
    f.store.publish(snap(0.22, 0.95));
    await settle();
    expect(f.posts).toHaveLength(1);
    expect(f.posts[0]!.body).toMatch(/^The Weekly Claude quota is at 91\.0%\. It resets <t:1794614400:R> \(2026-11-\d\d \d\d:\d\d Asia\/Bangkok\)\.$/);
    f.store.publish(snap(0.22, 0.92, { weekReset: 1795219200 }));
    await settle();
    expect(f.posts).toHaveLength(2);
  });
  it('allowed_warning below 90% does not alert', async () => {
    const f = fake();
    f.store.publish(snap(0.1, 0.8, { weekStatus: 'allowed_warning' }));
    await settle();
    expect(f.posts).toHaveLength(0);
  });
  it('a rejected window posts the idle-until text once, in addition to the high alert', async () => {
    const f = fake();
    f.store.publish(snap(0.1, 1, { weekStatus: 'rejected' }));
    f.store.publish(snap(0.1, 1, { weekStatus: 'rejected' }));
    await settle();
    expect(f.posts.map((p) => p.body.replace(/<t:.*$/, ''))).toEqual(['The Weekly Claude quota is used up. The bots will idle until ', 'The Weekly Claude quota is at 100.0%. It resets ']);
  });
  it('a failed post releases the claim so the next snapshot retries', async () => {
    const f = fake(true);
    f.store.publish(snap(0.1, 0.95));
    await settle();
    expect(f.claims.size).toBe(0);
    f.heal();
    f.store.publish(snap(0.1, 0.95));
    await settle();
    expect(f.posts).toHaveLength(1);
  });
  it('load restores a persisted snapshot; a failing repo never throws', async () => {
    const at = new Date(1_794_000_000_000);
    const s = new QuotaStore({ repo: { load: async () => ({ snapshot: snap(0.1, 0.2), observedAt: at }) } as unknown as QuotaRepoPort, log: { error: () => {} } });
    await s.load();
    expect(s.latest()?.observedAt).toBe(at);
    const bad = new QuotaStore({ repo: { load: async () => { throw new Error('db'); } } as unknown as QuotaRepoPort, log: { error: () => {} } });
    await bad.load();
    expect(bad.latest()).toBeNull();
  });
});

describe('USAGE-1 quotaLines', () => {
  it('says no data yet', () => expect(quotaLines(null, 'Asia/Bangkok')).toEqual(['No data yet.']));
  it('renders one line per window with percent, status, reset and the observed time', () => {
    const l = quotaLines({ snapshot: snap(0.22, 0.91, { weekStatus: 'allowed_warning' }), observedAt: new Date(1_794_000_000_000) }, 'Asia/Bangkok');
    expect(l[0]).toMatch(/^5-hour: 22\.0% \(allowed\), resets <t:1794307800:R> \(\d{4}-\d\d-\d\d \d\d:\d\d Asia\/Bangkok\)$/);
    expect(l[1]).toMatch(/^Weekly: 91\.0% \(allowed_warning\), resets <t:1794614400:R>/);
    expect(l[2]).toBe('Observed <t:1794000000:R>');
  });
});

/** OPS-HOLD */
const NOW = 1_794_000_000_000;
const stored = (s: QuotaSnapshot, at = NOW) => ({ snapshot: s, observedAt: new Date(at) });
describe('OPS-HOLD quotaHoldUntil', () => {
  it('no data, allowed and warning windows do not hold', () => {
    expect(quotaHoldUntil(null, NOW)).toBeNull();
    expect(quotaHoldUntil(stored(snap(0.2, 0.95, { weekStatus: 'allowed_warning' })), NOW)).toBeNull();
  });
  it('a rejected window holds until its resetsAt plus 60 s; the later of two rejected windows wins', () => {
    expect(quotaHoldUntil(stored(snap(0.2, 1, { weekStatus: 'rejected' })), NOW)).toBe(1794614400 * 1000 + QUOTA_HOLD_GRACE_MS);
    const both = snap(1, 1, { weekStatus: 'rejected' });
    both.windows.five_hour!.status = 'rejected';
    expect(quotaHoldUntil(stored(both), NOW)).toBe(1794614400 * 1000 + QUOTA_HOLD_GRACE_MS);
  });
  it('a stale rejected window (reset plus grace already past) is ignored, also after the grace edge', () => {
    const s = snap(0.2, 1, { weekStatus: 'rejected' });
    const edge = 1794614400 * 1000 + QUOTA_HOLD_GRACE_MS;
    expect(quotaHoldUntil(stored(s), edge - 1)).toBe(edge);
    expect(quotaHoldUntil(stored(s), edge)).toBeNull();
    expect(quotaHoldUntil(stored(s), edge + 86_400_000)).toBeNull();
  });
  it('a per-model window rejected alone does not hold the other models; a top-level rejection names its window', () => {
    const m = snap(0.1, 0.1);
    m.windows.seven_day_opus = { utilization: 1, resetsAt: 1794614400, status: 'rejected' };
    expect(quotaHoldUntil(stored(m), NOW)).toBeNull();
    m.status = 'rejected';
    m.rateLimitType = 'seven_day_opus';
    expect(quotaHoldUntil(stored(m), NOW)).toBe(1794614400 * 1000 + QUOTA_HOLD_GRACE_MS);
  });
  it('a top-level rejection with an unknown window holds a short fixed time from the observation', () => {
    const u: QuotaSnapshot = { status: 'rejected', rateLimitType: 'unknown', windows: { five_hour: { utilization: 0.5, resetsAt: 1794307800, status: 'allowed' } } };
    expect(quotaHoldUntil(stored(u), NOW + 1000)).toBe(NOW + 15 * 60_000);
    expect(quotaHoldUntil(stored(u), NOW + 15 * 60_000)).toBeNull();
  });
});

describe('OPS-HOLD QuotaStore hold lifecycle', () => {
  afterEach(() => vi.useRealTimers());
  const mkStore = (o: { load?: ReturnType<typeof stored> | null } = {}) => {
    const ends: number[] = [];
    const posts: string[] = [];
    const logs: string[] = [];
    const store = new QuotaStore({
      repo: { load: async () => o.load ?? null, save: async () => {}, claimAlert: async () => true, releaseAlert: async () => {} },
      alert: async (_t, b) => { posts.push(b); },
      onHoldEnd: () => { ends.push(Date.now()); },
      log: { error: () => {}, info: (_o: unknown, m?: string) => { logs.push(m ?? ''); } },
    });
    return { store, ends, posts, logs };
  };
  it('publish of a rejected snapshot holds; at resetsAt + 60 s the hold ends once: one end line, the end callback, heldUntil null', async () => {
    vi.useFakeTimers({ now: NOW });
    const f = mkStore();
    f.store.publish(snap(0.2, 1, { weekStatus: 'rejected', weekReset: Math.floor(NOW / 1000) + 3600 }));
    expect(f.store.heldUntil()).toBe((Math.floor(NOW / 1000) + 3600) * 1000 + QUOTA_HOLD_GRACE_MS);
    await vi.advanceTimersByTimeAsync(3600_000 + QUOTA_HOLD_GRACE_MS - 1);
    expect(f.ends).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(f.ends).toHaveLength(1);
    expect(f.store.heldUntil()).toBeNull();
    expect(f.posts.filter((b) => /resumed/i.test(b))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(f.ends).toHaveLength(1);
  });
  it('a restart during a hold keeps it: load of a persisted rejected snapshot holds and arms the end', async () => {
    vi.useFakeTimers({ now: NOW });
    const f = mkStore({ load: stored(snap(0.2, 1, { weekStatus: 'rejected', weekReset: Math.floor(NOW / 1000) + 600 })) });
    await f.store.load();
    expect(f.store.heldUntil()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(600_000 + QUOTA_HOLD_GRACE_MS + 1);
    expect(f.ends).toHaveLength(1);
  });
  it('a stale persisted rejected snapshot holds nothing and arms nothing', async () => {
    vi.useFakeTimers({ now: NOW });
    const f = mkStore({ load: stored(snap(0.2, 1, { weekStatus: 'rejected', weekReset: Math.floor(NOW / 1000) - 7200 }), NOW - 86_400_000) });
    await f.store.load();
    expect(f.store.heldUntil()).toBeNull();
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(f.ends).toHaveLength(0);
  });
  it('a fresh allowed snapshot before the reset lifts the hold at once and the end still fires once', async () => {
    vi.useFakeTimers({ now: NOW });
    const f = mkStore();
    f.store.publish(snap(0.2, 1, { weekStatus: 'rejected', weekReset: Math.floor(NOW / 1000) + 3600 }));
    f.store.publish(snap(0.1, 0.1, { weekReset: Math.floor(NOW / 1000) + 3600 }));
    expect(f.store.heldUntil()).toBeNull();
    await vi.advanceTimersByTimeAsync(10);
    expect(f.ends).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(7_200_000);
    expect(f.ends).toHaveLength(1);
  });
});

describe('OPS-HOLD quotaLines', () => {
  it('shows "Held until" while a window is rejected, nothing otherwise', () => {
    const q = stored(snap(0.2, 1, { weekStatus: 'rejected' }));
    expect(quotaLines(q, 'Asia/Bangkok', NOW)[0]).toMatch(/^Held: Claude-backed bots wait until <t:1794614460:R>/);
    expect(quotaLines(stored(snap(0.2, 0.5)), 'Asia/Bangkok', NOW).join('\n')).not.toMatch(/Held/);
  });
});
