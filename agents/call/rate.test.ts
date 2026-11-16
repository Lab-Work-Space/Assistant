import { describe, expect, it } from 'vitest';
import { FakeConfig } from '../../governance/test-helpers.js';
import { PrawConcurrency, PrawRateLimit } from './rate.js';

describe('PrawRateLimit / PrawConcurrency (R8)', () => {
  it('within() does not charge: the request that took the last slot is still within the limit', () => {
    let now = 0;
    const r = new PrawRateLimit(new FakeConfig({ 'limits.prawPerUser10Min': 2 }), () => now);
    expect(r.take('u')).toEqual({ ok: true });
    expect(r.take('u')).toEqual({ ok: true });
    expect(r.within('u')).toBe(true);
    expect(r.within('u')).toBe(true); // repeated checks never consume
    expect(r.take('u')).toEqual({ ok: false, notice: true });
    now = 600_001;
    expect(r.take('u')).toEqual({ ok: true });
  });
  it('acquire() is null at the cap and a release frees one slot (idempotent)', () => {
    const c = new PrawConcurrency(new FakeConfig({ 'limits.prawConcurrency': 2 }));
    const a = c.acquire()!;
    c.acquire();
    expect(c.acquire()).toBeNull();
    a();
    a();
    expect(c.acquire()).not.toBeNull();
    expect(c.acquire()).toBeNull();
  });
  it('refund() gives back the last slot; unseen users get no map entry', () => {
    const r = new PrawRateLimit(new FakeConfig({ 'limits.prawPerUser10Min': 1 }), () => 0);
    expect(r.within('ghost')).toBe(true);
    expect((r as unknown as { runs: Map<string, number[]> }).runs.has('ghost')).toBe(false);
    r.take('u');
    r.refund('u');
    expect(r.take('u')).toEqual({ ok: true });
  });
  it('wait() queues until a release; cancelWaiters() resolves null', async () => {
    const c = new PrawConcurrency(new FakeConfig({ 'limits.prawConcurrency': 1 }));
    const a = c.acquire()!;
    const w = c.wait();
    a();
    expect(await w).toBeTypeOf('function');
    const w2 = c.wait();
    c.cancelWaiters();
    expect(await w2).toBeNull();
  });
});
