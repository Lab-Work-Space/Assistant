import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AlertKind } from '../../db/repos/quota.js';
import type { QuotaSnapshot, QuotaWindowName } from '../../providers/claude-code-local/quota.js';
import { QuotaStore, type QuotaRepoPort } from './quota.js';

// R8 PROV-FALLBACK, BE2: onHoldStart (PV-C03), the A1/A2 texts and the provider.fallback audit rows.
const NOW = 1_794_000_000_000;
const snap = (o: { five?: 'allowed' | 'rejected'; week?: 'allowed' | 'rejected'; weekReset?: number; top?: 'allowed' | 'rejected' } = {}): QuotaSnapshot => ({
  status: o.top ?? 'allowed', rateLimitType: 'seven_day',
  windows: {
    five_hour: { utilization: 0.2, resetsAt: Math.floor(NOW / 1000) + 3600, status: o.five ?? 'allowed' },
    seven_day: { utilization: 0.4, resetsAt: o.weekReset ?? Math.floor(NOW / 1000) + 86_400, status: o.week ?? 'allowed' },
  },
});
const stored = (s: QuotaSnapshot, at = NOW) => ({ snapshot: s, observedAt: new Date(at) });

function mk(o: { fb?: Partial<NonNullable<ConstructorParameters<typeof QuotaStore>[0]['fallback']>> | null; load?: ReturnType<typeof stored> | null; hold?: boolean } = {}) {
  const starts: number[] = [];
  const ends: number[] = [];
  const posts: string[] = [];
  const audits: string[] = [];
  const claims = new Set<string>();
  const repo: QuotaRepoPort = {
    load: async () => o.load ?? null, save: async () => {},
    claimAlert: async (w: QuotaWindowName, r: number, k: AlertKind) => { const key = `${w}:${r}:${k}`; if (claims.has(key)) return false; claims.add(key); return true; },
    releaseAlert: async () => {},
  };
  const fallback = o.fb === null ? undefined : { enabled: () => true, keyed: () => true, capUsd: () => 50, used: () => false, spend: async () => ({ usd: 1.5, calls: 3 }), ...o.fb };
  const store = new QuotaStore({
    repo, alert: async (_t, b) => { posts.push(b); }, timezone: () => 'UTC', now: () => Date.now(),
    onHoldStart: () => { starts.push(Date.now()); }, onHoldEnd: () => { ends.push(Date.now()); },
    ...(fallback ? { fallback } : {}), audit: async (outcome: string) => { audits.push(outcome); },
    log: { error: () => {}, info: () => {} },
  });
  return { store, starts, ends, posts, audits };
}
const settle = () => vi.advanceTimersByTimeAsync(20);

describe('R8 QuotaStore.onHoldStart (PV-C03)', () => {
  afterEach(() => vi.useRealTimers());

  it('fires once on the not-held to held transition, not on later snapshots of the same hold', async () => {
    vi.useFakeTimers({ now: NOW });
    const f = mk();
    f.store.publish(snap({ week: 'rejected' }));
    f.store.publish(snap({ week: 'rejected', five: 'rejected' })); // changed, still held
    f.store.publish(snap({ week: 'rejected' }));
    expect(f.starts).toHaveLength(1);
    await settle();
  });

  it('does not fire for a snapshot that holds nothing, and not for a rejected one whose reset has passed (eventRejected true, heldUntil null)', async () => {
    vi.useFakeTimers({ now: NOW });
    const f = mk();
    f.store.publish(snap());
    f.store.publish(snap({ week: 'rejected', weekReset: Math.floor(NOW / 1000) - 7200 }));
    expect(f.store.heldUntil()).toBeNull();
    expect(f.starts).toHaveLength(0);
    await settle();
  });

  it('does not fire when a persisted hold is loaded at boot (the scheduler does not exist yet)', async () => {
    vi.useFakeTimers({ now: NOW });
    const f = mk({ load: stored(snap({ week: 'rejected' })) });
    await f.store.load();
    expect(f.store.heldUntil()).not.toBeNull();
    expect(f.starts).toHaveLength(0);
  });

  it('fires again for a new hold after the first one ended', async () => {
    vi.useFakeTimers({ now: NOW });
    const f = mk();
    f.store.publish(snap({ week: 'rejected' }));
    f.store.publish(snap());
    expect(f.ends).toHaveLength(1);
    f.store.publish(snap({ week: 'rejected' }));
    expect(f.starts).toHaveLength(2);
    await settle();
  });

  it('a throwing callback never breaks the store', async () => {
    vi.useFakeTimers({ now: NOW });
    const store = new QuotaStore({ onHoldStart: () => { throw new Error('boom'); }, log: { error: () => {}, info: () => {} } });
    expect(() => store.publish(snap({ week: 'rejected' }))).not.toThrow();
    expect(store.heldUntil()).not.toBeNull();
  });
});

describe('R8 QuotaStore alert texts (A1, A2) and audit', () => {
  afterEach(() => vi.useRealTimers());

  it('A1: the switch off keeps today\'s text byte for byte, with or without a fallback context', async () => {
    vi.useFakeTimers({ now: NOW });
    for (const fb of [null, { enabled: () => false }]) {
      const f = mk({ fb });
      f.store.publish(snap({ week: 'rejected' }));
      await settle();
      expect(f.posts[0]).toMatch(/^The Weekly Claude quota is used up\. The bots will idle until <t:\d+:R> \(.* UTC\)\.$/);
      expect(f.audits).toEqual([]);
    }
  });

  it('A1: switch on and a key present announces the metered backup with the company cap', async () => {
    vi.useFakeTimers({ now: NOW });
    const f = mk();
    f.store.publish(snap({ week: 'rejected' }));
    await settle();
    expect(f.posts[0]).toMatch(/^The Weekly Claude quota is used up\. Bots except Praw continue on the Claude API \(metered; company cap \$50\.00\/day\) until <t:\d+:R>/);
    expect(f.audits).toEqual(['engaged']);
  });

  it('A1 variant: switch on, no key: the backup is unavailable and the bots idle', async () => {
    vi.useFakeTimers({ now: NOW });
    const f = mk({ fb: { keyed: () => false } });
    f.store.publish(snap({ week: 'rejected' }));
    await settle();
    expect(f.posts[0]).toMatch(/^The Weekly Claude quota is used up\. The Claude API backup is unavailable: no API key\. The bots will idle until /);
    expect(f.audits).toEqual([]);
  });

  it('A1 is claimed once per window and reset (the existing claim): a second snapshot posts nothing new', async () => {
    vi.useFakeTimers({ now: NOW });
    const f = mk();
    f.store.publish(snap({ week: 'rejected' }));
    f.store.publish(snap({ week: 'rejected', top: 'allowed' }));
    await settle();
    expect(f.posts.filter((b) => b.includes('Claude API (metered'))).toHaveLength(1);
    expect(f.audits).toEqual(['engaged']);
  });

  it('A2: unchanged text without the backup; with it, the API spend today only when the backup ran', async () => {
    vi.useFakeTimers({ now: NOW });
    const plain = mk({ fb: { enabled: () => false } });
    plain.store.publish(snap({ week: 'rejected' }));
    await settle();
    plain.store.publish(snap());
    await settle();
    expect(plain.posts.at(-1)).toBe('The Claude quota hold is over. Claude-backed work has resumed.');

    const unused = mk();
    unused.store.publish(snap({ week: 'rejected' }));
    await settle();
    unused.store.publish(snap());
    await settle();
    expect(unused.posts.at(-1)).toBe('The Claude quota hold is over. Bots are back on the subscription.');
    expect(unused.audits).toContain('ended');

    const used = mk({ fb: { used: () => true } });
    used.store.publish(snap({ week: 'rejected' }));
    await settle();
    used.store.publish(snap());
    await settle();
    expect(used.posts.at(-1)).toBe('The Claude quota hold is over. Bots are back on the subscription. Claude API spend today: $1.50 (3 calls).');
  });

  it('a failing spend read or audit never blocks the end alert or the end callback', async () => {
    vi.useFakeTimers({ now: NOW });
    const f = mk({ fb: { used: () => true, spend: async () => { throw new Error('db'); } } });
    f.store.publish(snap({ week: 'rejected' }));
    await settle();
    f.store.publish(snap());
    await settle();
    expect(f.ends).toHaveLength(1);
    expect(f.posts.at(-1)).toBe('The Claude quota hold is over. Bots are back on the subscription.');
  });
});
