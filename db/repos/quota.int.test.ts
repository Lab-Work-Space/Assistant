import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../migrate.js';
import { freshDb, type TestDb } from '../test-helpers.js';
import { LlmUsageRepo, QuotaRepo } from './quota.js';

let db: TestDb;
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
beforeAll(async () => { db = await freshDb(); await migrate(db.pool, dir, 'up'); });
afterAll(async () => { await db.close(); });
beforeEach(async () => { await db.pool.query('DELETE FROM quota_snapshot'); await db.pool.query('DELETE FROM quota_alerts'); await db.pool.query('DELETE FROM audit_log'); });

const snap = { status: 'allowed' as const, rateLimitType: 'seven_day' as const, windows: { seven_day: { utilization: 0.91, resetsAt: 1794614400, status: 'allowed_warning' as const } } };

describe('USAGE-1 quota repo (migration 041)', () => {
  it('keeps exactly one snapshot row, overwritten in place', async () => {
    const r = new QuotaRepo(db.pool);
    expect(await r.load()).toBeNull();
    await r.save(snap, new Date('2026-11-10T01:00:00Z'));
    await r.save({ ...snap, status: 'rejected' }, new Date('2026-11-10T02:00:00Z'));
    const l = await r.load();
    expect(l?.snapshot.status).toBe('rejected');
    expect(l?.observedAt.toISOString()).toBe('2026-11-10T02:00:00.000Z');
    expect((await db.pool.query('SELECT count(*)::int AS n FROM quota_snapshot')).rows[0].n).toBe(1);
    await expect(db.pool.query("INSERT INTO quota_snapshot VALUES (2, '{}', now())")).rejects.toThrow(/check/i);
  });
  it('claims an alert once per window, reset and kind; release allows a retry; old claims are pruned', async () => {
    const r = new QuotaRepo(db.pool);
    const now = Date.parse('2026-11-10T00:00:00Z');
    expect(await r.claimAlert('seven_day', 1794614400, 'high', now)).toBe(true);
    expect(await r.claimAlert('seven_day', 1794614400, 'high', now)).toBe(false);
    expect(await r.claimAlert('seven_day', 1794614400, 'rejected', now)).toBe(true);
    expect(await r.claimAlert('five_hour', 1794614400, 'high', now)).toBe(true);
    await r.releaseAlert('seven_day', 1794614400, 'high');
    expect(await r.claimAlert('seven_day', 1794614400, 'high', now)).toBe(true);
    await db.pool.query("INSERT INTO quota_alerts(win, resets_at, kind) VALUES ('five_hour', 1000, 'high')");
    await r.claimAlert('five_hour', 1794700000, 'high', now);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM quota_alerts WHERE resets_at = 1000')).rows[0].n).toBe(0);
  });
  it('sums llm.call rows per actor since a time, ignoring other actions and older rows', async () => {
    const ins = (ts: string, actor: string, action: string, ti: number | null, to: number | null, c: number) =>
      db.pool.query('INSERT INTO audit_log(ts, actor, action, tokens_in, tokens_out, cost_usd) VALUES ($1,$2,$3,$4,$5,$6)', [ts, actor, action, ti, to, c]);
    await ins('2026-11-10T01:00:00Z', 'head:hq', 'llm.call', 100, 20, 0);
    await ins('2026-11-10T02:00:00Z', 'head:hq', 'llm.call', null, null, 0);
    await ins('2026-11-10T03:00:00Z', 'persona:x', 'llm.call', 5, 1, 0.25);
    await ins('2026-11-10T03:00:00Z', 'head:hq', 'budget.settle', 9, 9, 9);
    await ins('2026-11-09T23:00:00Z', 'head:hq', 'llm.call', 1000, 1000, 1);
    expect(await new LlmUsageRepo(db.pool).byActor(new Date('2026-11-10T00:00:00Z'))).toEqual([
      { actor: 'head:hq', calls: 2, tokensIn: 100, tokensOut: 20, costUsd: 0 },
      { actor: 'persona:x', calls: 1, tokensIn: 5, tokensOut: 1, costUsd: 0.25 },
    ]);
  });
});
