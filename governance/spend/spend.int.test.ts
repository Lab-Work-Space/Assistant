import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { OutboundPayload } from '../../agents/loop/payload.js';
import type { ActorRef } from '../../company/types.js';
import { ConfigSchema } from '../../config/schema.js';
import { EventBus, type AppEvents } from '../../core/events.js';
import { migrate } from '../../db/migrate.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { Budget } from '../budget.js';
import { SPEND_MAX_USD, SpendAlerts, SpendOverrides, SpendRepo, SpendWatch, bindSpendStop, effectiveDeptCap, renderAlert, spendReport, spendView, summaryRenderer } from './spend.js';
import { FakeConfig } from '../test-helpers.js';

const CHANNEL = '1565667791938387969';
const hq: ActorRef = { kind: 'head', dept: 'hq' };
const MODEL = 'claude-sonnet-5-5';
let db: TestDb;
let clock = Date.parse('2026-11-10T05:00:00Z');

beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations'), 'up');
});
beforeEach(async () => {
  clock = Date.parse('2026-11-10T05:00:00Z');
  for (const t of ['spend_overrides', 'spend_alerts', 'spend_days', 'budget_days']) await db.pool.query(`DELETE FROM ${t}`);
});
afterAll(async () => { await db.close(); });

/** The override service over the real database; cards and alerts go to recorders. */
function mk(init: ConstructorParameters<typeof FakeConfig>[0] = { 'spend.deptMonthlyUsd': { hq: 10 }, 'budget.companyDailyUsd': 1000, 'budget.botDailyUsd': 1000, 'budget.taskUsd': 1000 }) {
  const cfg = new FakeConfig(init);
  const posts: { card: OutboundPayload[]; alert: OutboundPayload[] } = { card: [], alert: [] };
  const audits: { action: string; tool?: string | undefined; outcome?: string | undefined }[] = [];
  const failures = { card: 0, alert: 0 };
  const repo = new SpendRepo(db.pool);
  const alerts = new SpendAlerts(repo, { alert: async (p) => { if (failures.alert-- > 0) throw new Error('boom'); posts.alert.push(p); } }, { error: () => undefined }, undefined, (r) => summaryRenderer(repo, overrides, cfg, () => clock)(r));
  const overrides = new SpendOverrides({
    pool: db.pool, cfg, clock: () => clock, configChannelId: CHANNEL, alerts, log: { error: () => undefined },
    audit: async (e) => void audits.push({ action: e.action, tool: e.tool ?? undefined, outcome: e.outcome ?? undefined }),
    ports: { postCard: async (p) => { if (failures.card-- > 0) throw new Error('boom'); posts.card.push(p); return `m${posts.card.length}`; } },
  });
  return { cfg, posts, audits, failures, repo, alerts, overrides };
}
const stop = (o: SpendOverrides, estUsd = 1, day = '2026-11-01') => o.onStop({ dept: 'hq', day, estUsd });
const rows = async () => (await db.pool.query<{ id: string; status: string; old: number; neu: number; expires: string; message_id: string | null; decided_by: string | null }>(
  "SELECT id, status, old_cap_usd::float8 AS old, new_cap_usd::float8 AS neu, to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS expires, message_id, decided_by FROM spend_overrides ORDER BY created_at, (status = 'pending'), id")).rows;
const setDeptRow = (usd: number, month = '2026-11-01') => db.pool.query("INSERT INTO budget_days (day, scope, scope_id, spent_usd) VALUES ($1, 'dept', 'hq', $2) ON CONFLICT (day, scope, scope_id) DO UPDATE SET spent_usd = $2", [month, usd]);
const click = (o: SpendOverrides, id: string, action: 'approve' | 'reject', over: Partial<{ channelId: string | null; messageId: string | null; userId: string }> = {}) =>
  o.decide({ id, action, userId: over.userId ?? 'admin1', channelId: over.channelId === undefined ? CHANNEL : over.channelId, messageId: over.messageId === undefined ? 'm1' : over.messageId });

describe('SPEND-1 overrides (Gate 1 S3 to S8)', () => {
  it('S3 (SP-01): one maximum everywhere: 1e6 is refused by the schema, and a cap at the maximum makes an alert and no card', async () => {
    expect(ConfigSchema['spend.deptMonthlyUsd'].safeParse({ hq: 1_000_000 }).success).toBe(false);
    expect(ConfigSchema['spend.deptMonthlyUsd'].safeParse({ hq: SPEND_MAX_USD }).success).toBe(true);
    const t = mk({ 'spend.deptMonthlyUsd': { hq: SPEND_MAX_USD } });
    await stop(t.overrides, 5);
    expect(await rows()).toEqual([]);
    expect(t.posts.card).toEqual([]);
    expect(t.posts.alert).toHaveLength(1);
    expect(JSON.stringify(t.posts.alert[0])).toContain('already at the maximum');
  });

  it('S3: a raise clamps to the maximum instead of overflowing numeric(12,6)', async () => {
    const t = mk({ 'spend.deptMonthlyUsd': { hq: 900_000 } });
    await setDeptRow(950_000);
    await stop(t.overrides, 100_000);
    expect(await rows()).toMatchObject([{ status: 'pending', old: 900_000, neu: SPEND_MAX_USD }]);
  });

  it('S6: new cap = ceil_cent(max(used + est, max(cap,1) x (1 + step))); the card shows only code-written facts and its buttons carry no amount', async () => {
    const a = mk({ 'spend.deptMonthlyUsd': { hq: 3.333 } });
    await stop(a.overrides, 0.01); // 3.333 x 1.25 = 4.16625 -> 4.17
    expect((await rows())[0]).toMatchObject({ old: 3.333, neu: 4.17 });
    await db.pool.query('DELETE FROM spend_overrides');
    await setDeptRow(10);
    const b = mk({ 'spend.deptMonthlyUsd': { hq: 10 } });
    await stop(b.overrides, 5); // used 10 + est 5 = 15 beats 12.5
    expect((await rows())[0]).toMatchObject({ old: 10, neu: 15 });
    const card = b.posts.card[0]!;
    expect(card).toMatchObject({ type: 'approval', origin: 'governance' });
    expect(card.spendOverrideId).toMatch(/^[0-9a-f]{32}$/);
    expect(card.spendOverrideId).not.toContain('15'.repeat(8)); // an opaque random id: no amount in it
    await db.pool.query('DELETE FROM spend_overrides');
    await setDeptRow(0);
    const c = mk({ 'spend.deptMonthlyUsd': { hq: 0 } });
    await stop(c.overrides, 0); // cap 0: max(cap,1) x 1.25 = 1.25
    expect((await rows())[0]).toMatchObject({ old: 0, neu: 1.25 });
  });

  it('S6: 10 concurrent stops make exactly one pending row and one card', async () => {
    const t = mk();
    await Promise.all(Array.from({ length: 10 }, () => stop(t.overrides)));
    expect(await rows()).toHaveLength(1);
    expect(t.posts.card).toHaveLength(1);
    expect(t.posts.alert).toHaveLength(1); // S15: one alert per stop claim
  });

  it('S6: effective cap = max(config, approved overrides), read through a given client; an approval for month M does not apply to M+1', async () => {
    const t = mk();
    await stop(t.overrides, 1);
    const id = (await rows())[0]!.id;
    expect(await t.overrides.effectiveCap('hq', '2026-11-01')).toBe(10); // pending counts for nothing
    expect((await click(t.overrides, id, 'approve')).ok).toBe(true);
    expect(await t.overrides.effectiveCap('hq', '2026-11-01')).toBe(12.5);
    expect(await t.overrides.effectiveCap('hq', '2026-12-01')).toBe(10);
    expect(await t.overrides.effectiveCap('rnd', '2026-11-01')).toBe(Infinity); // no config cap: no cap
    const client = await db.pool.connect();
    try { expect(await effectiveDeptCap(t.cfg, 'hq', '2026-11-01', client)).toBe(12.5); } finally { client.release(); }
    t.cfg.values.set('spend.deptMonthlyUsd', { hq: 20 });
    expect(await t.overrides.effectiveCap('hq', '2026-11-01')).toBe(20); // the config can be higher than the override
  });

  it('S6: after a rejection there is no new card that month (alert only)', async () => {
    const t = mk();
    await stop(t.overrides);
    const id = (await rows())[0]!.id;
    expect((await click(t.overrides, id, 'reject')).ok).toBe(true);
    await stop(t.overrides);
    await stop(t.overrides);
    expect(await rows()).toHaveLength(1);
    expect(t.posts.card).toHaveLength(1);
    expect(t.posts.alert.map((a) => a.body).some((b) => b.includes('already rejected'))).toBe(true);
    // the next month is a fresh start
    await stop(t.overrides, 1, '2026-12-01');
    expect(await rows()).toHaveLength(2);
  });

  it('G2SP-01: a refusal of a month that already ended (handled after local midnight) makes no row, no card and no alert', async () => {
    const t = mk();
    await setDeptRow(10, '2026-10-01');
    await stop(t.overrides, 1, '2026-10-01'); // the clock is in 2026-11 (Asia/Bangkok)
    expect(await rows()).toHaveLength(0);
    expect(t.posts.card).toHaveLength(0);
    expect(t.posts.alert).toHaveLength(0);
  });

  it('S2: a double click has one winner; an expired, off-channel, mismatched or malformed click changes nothing', async () => {
    const t = mk();
    await stop(t.overrides);
    const id = (await rows())[0]!.id;
    expect(await click(t.overrides, id, 'approve', { channelId: '999' })).toEqual({ ok: false, text: 'Unknown action.' });
    expect(await click(t.overrides, id, 'approve', { messageId: 'other' })).toEqual({ ok: false, text: 'Unknown action.' });
    expect(await click(t.overrides, id, 'approve', { messageId: null })).toEqual({ ok: false, text: 'Unknown action.' });
    expect(await click(t.overrides, 'not-an-id', 'approve')).toEqual({ ok: false, text: 'Unknown action.' });
    expect((await rows())[0]!.status).toBe('pending');
    const two = await Promise.all([click(t.overrides, id, 'approve'), click(t.overrides, id, 'reject', { userId: 'admin2' })]);
    expect(two.filter((r) => r.ok)).toHaveLength(1);
    expect(two.find((r) => !r.ok)).toEqual({ ok: false, text: 'That raise expired or was already decided.' });
    const [row] = await rows();
    expect(['approved', 'rejected']).toContain(row!.status);
    expect(t.audits.filter((a) => a.action === 'spend.override')).toHaveLength(1);
    expect(t.audits[0]!.outcome).toMatch(/^(approved|rejected) cap=10->12\.5 hq 2026-11$/);
  });

  it('S7: in Asia/Bangkok a card made on 2026-11-30 at 16:00Z expires at 17:00Z (month end), and a click at 17:00:01Z is refused', async () => {
    const t = mk();
    clock = Date.parse('2026-11-30T16:00:00Z');
    await stop(t.overrides);
    expect((await rows())[0]!.expires).toBe('2026-11-30T17:00:00Z');
    const id = (await rows())[0]!.id;
    clock = Date.parse('2026-11-30T17:00:01Z');
    expect(await click(t.overrides, id, 'approve')).toEqual({ ok: false, text: 'That raise expired or was already decided.' });
    expect((await rows())[0]!.status).toBe('pending'); // refused, nothing decided
  });

  it('S7: mid-month the card lives approval.expiryHours (24 h), not past the month', async () => {
    const t = mk();
    clock = Date.parse('2026-11-10T05:00:00Z');
    await stop(t.overrides);
    expect((await rows())[0]!.expires).toBe('2026-11-11T05:00:00Z');
  });

  it('S5 (SP-03): a pending row past its time does not block a new stop, and a failed card post leaves no blocking row', async () => {
    const t = mk();
    await stop(t.overrides);
    clock += 25 * 3_600_000; // 25 h: expired, but nothing pruned it
    await stop(t.overrides);
    expect((await rows()).map((r) => r.status)).toEqual(['expired', 'pending']);
    expect(t.posts.card).toHaveLength(2);
    // a post failure: the row is expired at once, the next stop retries
    await db.pool.query('DELETE FROM spend_overrides');
    t.failures.card = 1;
    await stop(t.overrides);
    expect((await rows()).map((r) => r.status)).toEqual(['expired']);
    await stop(t.overrides);
    expect((await rows()).map((r) => r.status)).toEqual(['expired', 'pending']);
    expect(t.posts.card).toHaveLength(3);
  });

  it('SP-03: if the alert claim cannot be written the card is still posted, and a failed card post leaves an expired row (never a stranded pending one)', async () => {
    const t = mk();
    const brokenRepo = Object.assign(Object.create(t.repo) as SpendRepo, { claim: async () => { throw new Error('db hiccup'); } });
    const broken = new SpendOverrides({
      pool: db.pool, cfg: t.cfg, clock: () => clock, configChannelId: CHANNEL, log: { error: () => undefined }, audit: async () => undefined,
      alerts: new SpendAlerts(brokenRepo, { alert: async () => undefined }, { error: () => undefined }),
      ports: { postCard: async (p) => { t.posts.card.push(p); return `m${t.posts.card.length}`; } },
    });
    await stop(broken);
    expect(t.posts.card).toHaveLength(1);
    expect((await rows())[0]).toMatchObject({ status: 'pending', message_id: 'm1' }); // the card exists: the row is decidable
    await db.pool.query('DELETE FROM spend_overrides');
    const failing = new SpendOverrides({
      pool: db.pool, cfg: t.cfg, clock: () => clock, configChannelId: CHANNEL, log: { error: () => undefined }, audit: async () => undefined,
      alerts: new SpendAlerts(brokenRepo, { alert: async () => undefined }, { error: () => undefined }),
      ports: { postCard: async () => { throw new Error('discord down'); } },
    });
    await stop(failing);
    expect((await rows()).map((r) => r.status)).toEqual(['expired']);
    await stop(t.overrides);
    expect((await rows()).map((r) => r.status).sort()).toEqual(['expired', 'pending']);
  });

  it('S4 (SP-02): after an approved raise is used up, the next dept refusal in the same process and month makes a new card (real Budget, bus and onStop wiring)', async () => {
    const t = mk();
    const bus = new EventBus<AppEvents>();
    const budget = new Budget(db.pool, t.cfg, bus, () => new Date(clock), { deptCap: (d, m, c) => effectiveDeptCap(t.cfg, d, m, c) });
    bindSpendStop(bus, t.overrides, { error: () => undefined });
    const waitFor = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 10)); expect(f()).toBe(true); };
    const spend = async (usd: number) => { const r = await budget.reserve({ actor: hq, estUsd: usd, model: MODEL }); if (r.ok) await budget.settle(r.reservationId, usd); return r; };
    expect((await spend(10)).ok).toBe(true);
    expect(await spend(1)).toEqual({ ok: false, scope: 'dept' });
    await waitFor(() => t.posts.card.length === 1);
    const id = (await rows())[0]!.id;
    expect((await click(t.overrides, id, 'approve')).ok).toBe(true); // 10 -> 12.5
    expect((await spend(2.5)).ok).toBe(true); // used up again
    expect(await spend(1)).toEqual({ ok: false, scope: 'dept' });
    await waitFor(() => t.posts.card.length === 2);
    expect((await rows()).map((r) => r.status)).toEqual(['approved', 'pending']);
    expect((await rows())[1]).toMatchObject({ old: 12.5 });
  });

  it('SP-12: a slow card post never holds up the refused caller (onStop is not awaited by reserve)', async () => {
    const t = mk();
    let release: () => void = () => undefined;
    const slow = new Promise<void>((r) => { release = r; });
    const o2 = new SpendOverrides({
      pool: db.pool, cfg: t.cfg, clock: () => clock, configChannelId: CHANNEL, alerts: t.alerts, log: { error: () => undefined }, audit: async () => undefined,
      ports: { postCard: async () => { await slow; return 'm1'; } },
    });
    const bus = new EventBus<AppEvents>();
    const budget = new Budget(db.pool, t.cfg, bus, () => new Date(clock));
    bindSpendStop(bus, o2, { error: () => undefined });
    const r = await budget.reserve({ actor: hq, estUsd: 11, model: MODEL });
    expect(r).toEqual({ ok: false, scope: 'dept' }); // returned while the card post is still pending
    release();
    for (let i = 0; i < 200 && !(await rows())[0]?.message_id; i++) await new Promise((x) => setTimeout(x, 10));
    expect((await rows())[0]!.message_id).toBe('m1');
  });

  it('S8 (SP-05): a human cap change ends this month\'s approved and pending overrides, audited, and the enforced cap is the new one', async () => {
    const t = mk();
    await stop(t.overrides);
    const id = (await rows())[0]!.id;
    await click(t.overrides, id, 'approve');
    expect(await t.overrides.effectiveCap('hq', '2026-11-01')).toBe(12.5);
    await db.pool.query('DELETE FROM spend_overrides WHERE id <> $1', [id]);
    await db.pool.query("INSERT INTO spend_overrides (id, dept_id, month, old_cap_usd, new_cap_usd, channel_id, expires_at, message_id) VALUES ($1, 'hq', '2026-11-01', 12.5, 20, $2, now() + interval '1 day', 'm9')", ['b'.repeat(32), CHANNEL]);
    t.cfg.values.set('spend.deptMonthlyUsd', { hq: 8 }); // the human lowers the cap
    const r = await t.overrides.supersede('hq', 'admin1');
    expect(r.count).toBe(2); // the approved row and the pending one both end
    expect(await t.overrides.effectiveCap('hq', '2026-11-01')).toBe(8);
    expect(t.audits.some((a) => a.action === 'spend.override' && /^superseded/.test(a.outcome ?? ''))).toBe(true);
  });

  it('S14: alert claims survive a restart (a new service posts nothing again), and an anomaly respects the USD floor when the median is 0', async () => {
    const t = mk();
    expect(await t.alerts.deliver('2026-11', 'warn', 'hq', { dept: 'hq', pct: 85, spentUsd: 8.5, capUsd: 10 })).toBe(true);
    const again = new SpendAlerts(new SpendRepo(db.pool), { alert: async (p) => void t.posts.alert.push(p) }, { error: () => undefined });
    expect(await again.deliver('2026-11', 'warn', 'hq', { dept: 'hq', pct: 85, spentUsd: 8.5, capUsd: 10 })).toBe(false);
    expect(t.posts.alert).toHaveLength(1);
    // anomaly floor
    const watch = new SpendWatch({ repo: t.repo, cfg: t.cfg, overrides: t.overrides, alerts: t.alerts, clock: () => clock, offDay: () => ({ off: false }), log: { error: () => undefined } });
    await db.pool.query("INSERT INTO spend_days (day, dept_id, provider, tool, spent_usd) VALUES ('2026-11-10','hq','gemini','ocr', 0.3)");
    await watch.tick();
    expect(t.posts.alert.filter((a) => a.title === 'Unusual spend today')).toHaveLength(0); // 0.3 < the 0.5 floor
    await db.pool.query("UPDATE spend_days SET spent_usd = 0.6");
    clock += 6 * 60_000;
    await watch.tick();
    expect(t.posts.alert.filter((a) => a.title === 'Unusual spend today')).toHaveLength(2); // hq and _company
    clock += 6 * 60_000;
    await watch.tick(); // claimed for the day: no repeat
    expect(t.posts.alert.filter((a) => a.title === 'Unusual spend today')).toHaveLength(2);
  });

  it('S14: warn reads the dept row (the enforced figure) against the effective cap, once per month; alertsEnabled=false stops it but never the stop alert', async () => {
    const t = mk();
    await setDeptRow(8.5);
    const watch = new SpendWatch({ repo: t.repo, cfg: t.cfg, overrides: t.overrides, alerts: t.alerts, clock: () => clock, offDay: () => ({ off: true, reason: 'weekday' }), log: { error: () => undefined } });
    t.cfg.values.set('spend.alertsEnabled', false);
    await watch.tick();
    expect(t.posts.alert).toHaveLength(0);
    t.cfg.values.set('spend.alertsEnabled', true);
    await watch.tick(); // off days and halted state do not matter: alerts only read and post
    await watch.tick();
    expect(t.posts.alert.map((a) => a.title)).toEqual(['Department budget warning']);
    t.cfg.values.set('spend.alertsEnabled', false);
    await stop(t.overrides, 5);
    expect(t.posts.alert.map((a) => a.title)).toContain('Department budget used up');
    expect(t.posts.card).toHaveLength(1);
  });

  it('S15: exactly one stop alert per claim, with the right dept text (month, no bot or UTC wording)', async () => {
    const t = mk();
    await stop(t.overrides);
    await stop(t.overrides);
    const stops = t.posts.alert.filter((a) => a.title === 'Department budget used up');
    expect(stops).toHaveLength(1);
    expect(stops[0]!.body).toContain('2026-11');
    expect(stops[0]!.body).not.toMatch(/UTC|\/budget set bot|bot daily/i);
    expect(renderAlert('stop', '2026-11', 'hq:1000', { dept: 'hq', capUsd: 10, usedUsd: 10, outcome: 'card' }).body).toContain('#⚙️-setting');
  });

  it('S14: a failed post is retried on later ticks, 3 attempts in all, then given up (logged)', async () => {
    const t = mk();
    t.cfg.values.set('spend.weeklySummary', false);
    const errors: unknown[] = [];
    let posted = 0;
    const alerts = new SpendAlerts(t.repo, { alert: async () => { posted++; throw new Error('boom'); } }, { error: (o, m) => void errors.push([o, m]) }, undefined, undefined, 0);
    await setDeptRow(9);
    const watch = new SpendWatch({ repo: t.repo, cfg: t.cfg, overrides: t.overrides, alerts, clock: () => clock, offDay: () => ({ off: false }), log: { error: () => undefined } });
    for (let i = 0; i < 6; i++) await watch.tick();
    expect(posted).toBe(3); // posted (and failed) exactly 3 times
    const row = (await db.pool.query('SELECT attempts, posted_at FROM spend_alerts WHERE kind = $1', ['warn'])).rows[0];
    expect(row).toMatchObject({ attempts: 3, posted_at: null });
    expect(JSON.stringify(errors)).toContain('given up');
  });

  it('G2SP-02: the retry pass never re-posts a claim that is being posted (in-flight set) or that is younger than the retry age', async () => {
    const t = mk();
    let posts = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const mkAlerts = (age?: number) => new SpendAlerts(t.repo, { alert: async () => { posts++; await gate; } }, { error: () => undefined }, undefined, undefined, age);
    const detail = { dept: 'hq', capUsd: 10, usedUsd: 10, outcome: 'card' };
    // age 0: only the in-flight set protects the claim
    const a = mkAlerts(0);
    const first = a.deliver('2026-11', 'stop', 'hq:1000', detail);
    for (let i = 0; i < 100 && posts === 0; i++) await new Promise((r) => setTimeout(r, 5));
    await a.retry();
    await a.retry();
    expect(posts).toBe(1);
    release();
    await first;
    expect((await db.pool.query('SELECT attempts, posted_at FROM spend_alerts')).rows[0]).toMatchObject({ attempts: 1 });
    // default age: a fresh unposted claim (a crash before the first attempt) waits for the retry age
    await db.pool.query('DELETE FROM spend_alerts');
    posts = 0;
    await t.repo.claim('2026-11', 'stop', 'hq:1000', detail);
    const b = mkAlerts();
    await b.retry();
    expect(posts).toBe(0);
    await db.pool.query("UPDATE spend_alerts SET claimed_at = now() - interval '3 minutes'");
    await b.retry();
    expect(posts).toBe(1);
  });

  it('G2SP-04: a human cap change also ends the month\'s rejected rows, so a new raise card can appear; the next month is untouched', async () => {
    const t = mk();
    await stop(t.overrides);
    const id = (await rows())[0]!.id;
    await click(t.overrides, id, 'reject');
    await stop(t.overrides);
    expect(t.posts.card).toHaveLength(1); // blocked by the rejection
    const r = await t.overrides.supersede('hq', 'admin1');
    expect(r.count).toBe(1);
    expect((await rows()).map((x) => x.status)).toEqual(['expired']);
    expect(t.audits.some((a) => a.action === 'spend.override' && /^superseded 1 hq 2026-11$/.test(a.outcome ?? ''))).toBe(true);
    await stop(t.overrides);
    expect(t.posts.card).toHaveLength(2);
    expect((await rows()).map((x) => x.status).sort()).toEqual(['expired', 'pending']);
  });

  it('G2SP-03: a stop that arrives while one for the same department and month is running is coalesced (one card)', async () => {
    const t = mk();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = new SpendOverrides({
      pool: db.pool, cfg: t.cfg, clock: () => clock, configChannelId: CHANNEL, alerts: t.alerts, log: { error: () => undefined }, audit: async () => undefined,
      ports: { postCard: async (p) => { await gate; t.posts.card.push(p); return 'm1'; } },
    });
    const a = stop(slow);
    await new Promise((r) => setTimeout(r, 50));
    await stop(slow); // returns at once: the one in flight owns this (dept, month)
    expect(t.posts.card).toHaveLength(0);
    release();
    await a;
    expect(t.posts.card).toHaveLength(1);
    await stop(slow, 1, '2026-12-01'); // another month is not coalesced with it
    expect(await rows()).toHaveLength(2); // one per (dept, month)
  });

  it('prune keeps the retention window and expires pending overrides past their time', async () => {
    const t = mk();
    await db.pool.query("INSERT INTO spend_days (day, dept_id, provider, tool, spent_usd) VALUES ('2025-01-01','hq','x','ocr',1), ('2026-11-01','hq','x','ocr',1)");
    await db.pool.query("INSERT INTO spend_overrides (id, dept_id, month, old_cap_usd, new_cap_usd, channel_id, expires_at) VALUES ($1,'hq','2026-11-01',1,2,$2, now() - interval '1 hour')", ['c'.repeat(32), CHANNEL]);
    const watch = new SpendWatch({ repo: t.repo, cfg: t.cfg, overrides: t.overrides, alerts: t.alerts, clock: () => Date.now(), offDay: () => ({ off: false }), log: { error: () => undefined } });
    await watch.tick();
    expect((await db.pool.query("SELECT to_char(day,'YYYY-MM-DD') AS d FROM spend_days")).rows.map((r) => r.d)).toEqual(['2026-11-01']);
    expect((await rows())[0]!.status).toBe('expired');
  });

  it('S16: a task title planted in the database never appears in the report, the dashboard view or an alert (task trees are ids only)', async () => {
    const t = mk();
    await db.pool.query("INSERT INTO departments (id, name) VALUES ('hq','hq') ON CONFLICT DO NOTHING");
    await db.pool.query("INSERT INTO tasks (id, title, dept_id, owner, requester, root_id, origin, tainted) VALUES ($1,'SECRET-TITLE-do-not-leak','hq','{}','{}',$1,'chat',false)", ['deadbeef'.repeat(4)]);
    await db.pool.query("INSERT INTO spend_days (day, dept_id, provider, tool, root_id, spent_usd) VALUES ('2026-11-10','hq','gemini','ocr',$1,3)", ['deadbeef'.repeat(4)]);
    await setDeptRow(9);
    const rep = await spendReport(t.repo, t.overrides, t.cfg, clock, 'dept');
    const w = new SpendWatch({ repo: t.repo, cfg: t.cfg, overrides: t.overrides, alerts: t.alerts, clock: () => clock, offDay: () => ({ off: false }), log: { error: () => undefined } });
    await w.tick();
    await stop(t.overrides, 5);
    const everything = JSON.stringify([rep, t.posts, await spendView(t.repo, t.overrides, t.cfg, clock)]);
    expect(everything).not.toContain('SECRET-TITLE');
    expect(everything).toContain('#deadbeef');
    expect(t.posts.alert.some((a) => a.title === 'Weekly spend summary')).toBe(true);
    for (const p of [...t.posts.alert, ...t.posts.card]) expect(p.mentionUsers).toBeUndefined();
    expect(t.posts.alert.every((a) => a.type === 'config')).toBe(true); // never type alert: that one pings the admin role
  });

  it('the trend report reads spend_days: at most 25 fields, each value at most 1024, the whole at most 6000, ids only for task trees', async () => {
    const t = mk();
    for (let d = 0; d < 30; d++)
      for (const dept of ['hq', 'rnd', 'software', 'it', 'marketing', 'sales', 'hr', 'finance', 'ops', 'praw'])
        await db.pool.query("INSERT INTO spend_days (day, dept_id, provider, tool, root_id, spent_usd) VALUES (('2026-11-10'::date - $1::int), $2, 'gemini', 'ocr', $3, $4)", [d, dept, d === 0 ? `${'a1b2c3d4'}${'0'.repeat(24)}` : '', 1 + d / 10]);
    await setDeptRow(40);
    for (const by of ['dept', 'provider', 'tool'] as const) {
      const r = await spendReport(t.repo, t.overrides, t.cfg, clock, by);
      expect(r.fields.length).toBeLessThanOrEqual(25);
      expect(r.fields.every((f) => f.value.length <= 1024 && f.name.length <= 256)).toBe(true);
      expect(r.body.length + r.fields.reduce((n, f) => n + f.name.length + f.value.length, 0)).toBeLessThanOrEqual(6000);
    }
    const r = await spendReport(t.repo, t.overrides, t.cfg, clock, 'dept');
    expect(r.body).toMatch(/^MTD \$.* · 7d \$.* \(prev 7d \$.*, [+-]?\d+%\) · 30d \$.* · projected month end \$/);
    expect(r.fields.find((f) => f.name === 'Top drivers')!.value).toContain('#a1b2c3d4');
    expect(r.fields.find((f) => f.name === 'Budgets')!.value).toContain('`hq` $40.00 / $10.00');
  });
});
