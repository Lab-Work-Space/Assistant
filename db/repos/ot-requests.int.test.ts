import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActorRef } from '../../company/types.js';
import { EventBus, type AppEvents } from '../../core/events.js';
import { Budget } from '../../governance/budget.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { migrate } from '../migrate.js';
import { freshDb, type TestDb } from '../test-helpers.js';
import { DepartmentRepo, TaskRepo } from './index.js';
import { OtRequestRepo, type OtGate, type OtRequest } from './ot-requests.js';

let db: TestDb;
let tasks: TaskRepo;
let gate: OtGate | null = null;
let faults: unknown[] = [];
const hq: ActorRef = { kind: 'head', dept: 'hq' };
const TZ = 'Asia/Bangkok';
const ADMIN = '123456789012345678';
const CH = '1565667791938387969';
const caps = { tz: TZ, perRoot: 2, perDay: 20, perPerson: 4 };
let msgSeq = 100000000000000000n;
const msgId = () => String(msgSeq++);

beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations'), 'up');
  await new DepartmentRepo(db.pool).upsert({ id: 'hq', name: 'HQ', categoryNamePattern: '', workChannelId: null, color: 0, model: null, provider: null, enabled: true });
  tasks = new TaskRepo(db.pool);
});
beforeEach(async () => {
  gate = null;
  faults = [];
  await db.pool.query('DELETE FROM ot_requests');
  await db.pool.query('DELETE FROM budget_days');
  await db.pool.query('DELETE FROM tasks');
});
afterAll(async () => { await db.close(); });

const repo = () => new OtRequestRepo(db.pool, { gate: () => gate, onFault: (e) => faults.push(e) });
const newRoot = () => tasks.create({ title: 't', deptId: 'hq', owner: hq, requester: { kind: 'human', userId: '1' }, origin: 'chat' });
const today = async (): Promise<string> => (await db.pool.query<{ d: string }>(`SELECT (now() AT TIME ZONE '${TZ}')::date::text AS d`)).rows[0]!.d;
const person = (n = 1) => `10000000000000000${n}`;

/** A posted request: raised, then its card stored. */
async function posted(r: OtRequestRepo, rootId: string, by = person()): Promise<OtRequest> {
  const x = await r.raise({ rootId, requestedBy: by, ...caps });
  if (!x.ok) throw new Error(`raise refused: ${x.why}`);
  expect(await r.setCard(x.row.id, CH, msgId())).toBe(true);
  return (await r.get(x.row.id))!;
}
const card = (o: OtRequest) => ({ id: o.id, digest: o.digest, messageId: o.cardMessageId, channelId: o.cardChannelId, userId: ADMIN });
const approve = (r: OtRequestRepo, o: OtRequest, over: { hours?: number; maxRuns?: number; maxUsd?: number; off?: boolean; halted?: boolean; enabled?: boolean } = {}) =>
  r.approve({ ...card(o), tz: TZ, hours: over.hours ?? 4, maxRuns: over.maxRuns ?? 30, maxUsd: over.maxUsd ?? 2, gates: { offDay: () => over.off ?? true, halted: () => over.halted ?? false, enabled: () => over.enabled ?? true } });
const granted = async (r: OtRequestRepo, rootId: string, over: Parameters<typeof approve>[2] = {}) => {
  const res = await approve(r, await posted(r, rootId), over);
  if (!res.ok) throw new Error(`approve refused: ${res.error}`);
  return res.row;
};

describe('OtRequestRepo.raise', () => {
  it('inserts a pending row with the DB-clock expiry (next local midnight) and day (OT-C14)', async () => {
    const r = repo();
    const t = await newRoot();
    const x = await r.raise({ rootId: t.id, requestedBy: person(), ...caps });
    expect(x.ok).toBe(true);
    if (!x.ok) return;
    expect(x.row).toMatchObject({ status: 'pending', seq: 1, localDay: await today() });
    expect(x.row.digest).toMatch(/^[0-9a-f]{12}$/);
    const q = (await db.pool.query<{ ok: boolean }>(`SELECT (expires_at = ((date_trunc('day', created_at AT TIME ZONE '${TZ}') + interval '1 day') AT TIME ZONE '${TZ}')) AS ok FROM ot_requests`)).rows[0]!;
    expect(q.ok).toBe(true);
  });

  it('a second raise while one is pending is refused (unique pending), 20 concurrent raises on one root give one row', async () => {
    const r = repo();
    const t = await newRoot();
    const rs = await Promise.all(Array.from({ length: 20 }, () => r.raise({ rootId: t.id, requestedBy: person(), ...caps })));
    expect(rs.filter((x) => x.ok)).toHaveLength(1);
    expect(rs.filter((x) => !x.ok).every((x) => !x.ok && x.why === 'pending')).toBe(true);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM ot_requests')).rows[0]).toEqual({ n: 1 });
  });

  it('the per-root daily cap (seq) stops a third request; an ended request leaves room only up to the cap', async () => {
    const r = repo();
    const t = await newRoot();
    for (let i = 1; i <= 2; i++) {
      const x = await r.raise({ rootId: t.id, requestedBy: person(), ...caps });
      expect(x.ok && x.row.seq).toBe(i);
      if (x.ok) await r.endUnposted(x.row.id);
    }
    const third = await r.raise({ rootId: t.id, requestedBy: person(), ...caps });
    expect(third).toMatchObject({ ok: false, why: 'cap_root' });
  });

  it('OT-C9: the global and per-person daily caps hold under concurrent raises', async () => {
    const r = repo();
    const roots = await Promise.all(Array.from({ length: 16 }, () => newRoot()));
    const person1 = await Promise.all(roots.slice(0, 8).map((t) => r.raise({ rootId: t.id, requestedBy: person(1), ...caps, perPerson: 3 })));
    expect(person1.filter((x) => x.ok)).toHaveLength(3);
    expect(person1.filter((x) => !x.ok).every((x) => !x.ok && x.why === 'cap_person')).toBe(true);
    const all = await Promise.all(roots.slice(8).map((t, i) => r.raise({ rootId: t.id, requestedBy: person(2 + (i % 8)), ...caps, perPerson: 50, perDay: 7 })));
    expect(all.filter((x) => x.ok)).toHaveLength(4); // 3 already today, 7 in all
    expect(all.filter((x) => !x.ok).every((x) => !x.ok && x.why === 'cap_day')).toBe(true);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM ot_requests')).rows[0]).toEqual({ n: 7 });
  });

  it('OT-C11: an unposted card is ended but still counts toward the caps; three failures on one root give at most perRoot attempts', async () => {
    const r = repo();
    const t = await newRoot();
    let attempts = 0;
    for (let i = 0; i < 3; i++) {
      const x = await r.raise({ rootId: t.id, requestedBy: person(), ...caps });
      if (x.ok) { attempts++; await r.endUnposted(x.row.id); }
    }
    expect(attempts).toBe(2);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM ot_requests WHERE status = 'expired' AND card_message_id IS NULL")).rows[0]).toEqual({ n: 2 });
  });

  it('deny is sticky for the rest of the day', async () => {
    const r = repo();
    const t = await newRoot();
    const o = await posted(r, t.id);
    expect((await r.deny(card(o))).ok).toBe(true);
    expect(await r.raise({ rootId: t.id, requestedBy: person(), ...caps })).toMatchObject({ ok: false, why: 'denied' });
  });

  it('OT-C6: a stale pending row of yesterday is expired by the raise itself, which then succeeds without waiting for the sweep', async () => {
    const r = repo();
    const t = await newRoot();
    const o = await posted(r, t.id);
    await db.pool.query("UPDATE ot_requests SET created_at = now() - interval '24 hours', expires_at = now() - interval '1 minute', local_day = local_day - 1 WHERE id = $1", [o.id]);
    const x = await r.raise({ rootId: t.id, requestedBy: person(), ...caps });
    expect(x.ok).toBe(true);
    if (x.ok) expect(x.expired).toEqual([{ channelId: CH, messageId: o.cardMessageId }]);
    expect((await r.get(o.id))!.status).toBe('expired');
  });

  it('an ended tree gets no request, and a usable grant blocks a new one while an exhausted grant does not (OT-C12)', async () => {
    const r = repo();
    const t = await newRoot();
    await granted(r, t.id, { maxRuns: 1 });
    expect(await r.raise({ rootId: t.id, requestedBy: person(), ...caps })).toMatchObject({ ok: false, why: 'usable' });
    expect((await r.consume(t.id, await today())).ok).toBe(true);
    const x = await r.raise({ rootId: t.id, requestedBy: person(), ...caps });
    expect(x.ok && x.row.seq).toBe(2);
    const u = await newRoot();
    await db.pool.query("UPDATE tasks SET status = 'cancelled' WHERE id = $1", [u.id]);
    expect(await r.raise({ rootId: u.id, requestedBy: person(), ...caps })).toMatchObject({ ok: false, why: 'ended' });
  });
});

describe('OtRequestRepo.consume (OT-C8, OT-C13)', () => {
  it('50 concurrent consumes on max_runs=30 give exactly 30 ok, then exhausted', async () => {
    const r = repo();
    const t = await newRoot();
    await granted(r, t.id, { maxRuns: 30 });
    const day = await today();
    const rs = await Promise.all(Array.from({ length: 50 }, () => r.consume(t.id, day)));
    expect(rs.filter((x) => x.ok)).toHaveLength(30);
    expect(rs.filter((x) => !x.ok).every((x) => !x.ok && x.why === 'exhausted')).toBe(true);
    expect(await r.usable(t.id, day)).toBe(false);
    expect((await db.pool.query('SELECT runs_used FROM ot_requests')).rows[0]).toEqual({ runs_used: 30 });
    expect((await r.unexpired(t.id, day))?.runsUsed).toBe(30); // still unexpired though exhausted
  });

  it('the USD slice: reserve and settle through Budget on the root; consume refuses once settled spend minus the base reaches max_usd', async () => {
    const t = await newRoot();
    const cfg = new FakeConfig({ 'limits.localUnlimited': false, 'budget.botDailyUsd': 1000, 'budget.companyDailyUsd': 1000, 'budget.taskUsd': 1000 });
    const budget = new Budget(db.pool, cfg, new EventBus<AppEvents>(), () => new Date());
    const spend = async (usd: number) => {
      const res = await budget.reserve({ actor: hq, estUsd: usd, taskId: t.id });
      if (!res.ok) throw new Error('reserve refused');
      await budget.settle(res.reservationId, usd);
    };
    await spend(0.5); // before OT: the base
    const r = repo();
    await granted(r, t.id, { maxUsd: 1 });
    const day = await today();
    expect((await r.consume(t.id, day)).ok).toBe(true);
    await spend(0.6);
    expect(await r.usable(t.id, day)).toBe(true); // 0.6 of 1.0 used in the slice
    await spend(0.5);
    expect(await r.usable(t.id, day)).toBe(false); // 1.1 >= 1.0
    expect(await r.consume(t.id, day)).toEqual({ ok: false, why: 'exhausted' });
  });

  it('a local_day other than the grant day, an ended root and an expired window each refuse', async () => {
    const r = repo();
    const t = await newRoot();
    await granted(r, t.id);
    expect((await r.consume(t.id, '2020-01-01')).ok).toBe(false);
    const day = await today();
    await db.pool.query("UPDATE tasks SET status = 'done' WHERE id = $1", [t.id]);
    expect(await r.consume(t.id, day)).toEqual({ ok: false, why: 'none' });
    await db.pool.query("UPDATE tasks SET status = 'doing' WHERE id = $1", [t.id]);
    expect((await r.consume(t.id, day)).ok).toBe(true);
    await db.pool.query("UPDATE ot_requests SET decided_at = now() - interval '1 hour', grant_expires_at = now() - interval '1 second'");
    expect((await r.consume(t.id, day)).ok).toBe(false);
  });

  it('a grant never crosses local midnight and is at most the configured hours', async () => {
    const r = repo();
    const t = await newRoot();
    const g = await granted(r, t.id, { hours: 12 });
    const q = (await db.pool.query<{ mid: Date }>(`SELECT ((date_trunc('day', now() AT TIME ZONE '${TZ}') + interval '1 day') AT TIME ZONE '${TZ}') AS mid`)).rows[0]!;
    expect(g.grantExpiresAt!.getTime()).toBeLessThanOrEqual(q.mid.getTime());
    expect(g.grantExpiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + 12 * 3600_000 + 5000);
  });

  it('OT-C7: ot.enabled off or a halt refuses consume, usable and unexpired; a gate read that throws counts as off', async () => {
    const r = repo();
    const t = await newRoot();
    await granted(r, t.id);
    const day = await today();
    gate = 'disabled';
    expect(await r.consume(t.id, day)).toEqual({ ok: false, why: 'disabled' });
    expect(await r.usable(t.id, day)).toBe(false);
    expect(await r.unexpired(t.id, day)).toBeNull();
    gate = null;
    expect(await r.usable(t.id, day)).toBe(true);
    gate = 'halted'; // a refused call also retries the halt revoke in the background
    expect(await r.consume(t.id, day)).toEqual({ ok: false, why: 'halted' });
    const throwing = new OtRequestRepo(db.pool, { gate: () => { throw new Error('cfg read'); } });
    expect(await throwing.usable(t.id, day)).toBe(false);
  });

  it('OT-C15: a database fault in usable or consume is reported with a fixed text (SQLSTATE only) and fails closed', async () => {
    const r = repo();
    const t = await newRoot();
    await granted(r, t.id);
    const broken = new OtRequestRepo({ query: () => Promise.reject(Object.assign(new Error('boom: secret title'), { code: '08006' })) } as never, { onFault: (e) => faults.push(e) });
    expect(await broken.usable(t.id, '2026-01-01')).toBe(false);
    expect(await broken.consume(t.id, '2026-01-01')).toEqual({ ok: false, why: 'error' });
    expect(faults.map((e) => (e as Error).message)).toEqual(['overtime check failed (08006)', 'overtime check failed (08006)']);
  });
});

describe('OtRequestRepo.approve and the decisions (OT-C6, OT-C16)', () => {
  it('approve snapshots the caps and usd_base = spent_usd only (reserved is not counted)', async () => {
    const r = repo();
    const t = await newRoot();
    await db.pool.query("INSERT INTO budget_days (day, scope, scope_id, spent_usd, reserved_usd) VALUES (DATE '1970-01-01', 'task', $1, 0.25, 0.5)", [t.id]);
    const g = await granted(r, t.id, { hours: 2, maxRuns: 7, maxUsd: 1.5 });
    expect(g).toMatchObject({ status: 'approved', maxRuns: 7, maxUsd: 1.5, usdBase: 0.25, decidedBy: ADMIN, runsUsed: 0 });
  });

  it('a digest tamper, a wrong message, a wrong channel and null ids are refused wrong_card', async () => {
    const r = repo();
    const o = await posted(r, (await newRoot()).id);
    const run = (patch: Partial<ReturnType<typeof card>>) => r.approve({ ...card(o), ...patch, tz: TZ, hours: 4, maxRuns: 5, maxUsd: 1, gates: { offDay: () => true, halted: () => false, enabled: () => true } });
    expect(await run({ digest: '000000000000' })).toEqual({ ok: false, error: 'wrong_card' });
    expect(await run({ messageId: msgId() })).toEqual({ ok: false, error: 'wrong_card' });
    expect(await run({ channelId: '1565667791938387970' })).toEqual({ ok: false, error: 'wrong_card' });
    expect(await run({ messageId: null })).toEqual({ ok: false, error: 'wrong_card' });
    expect(await run({ channelId: null })).toEqual({ ok: false, error: 'wrong_card' });
    expect((await r.get(o.id))!.status).toBe('pending');
    expect(await run({ id: 999999 })).toEqual({ ok: false, error: 'not_found' });
  });

  it('refuses halted, disabled, moot (a workday), root_ended and expired (stale row, and within a minute of midnight) without changing the row', async () => {
    const r = repo();
    const t = await newRoot();
    const o = await posted(r, t.id);
    expect(await approve(r, o, { halted: true })).toEqual({ ok: false, error: 'halted' });
    expect(await approve(r, o, { enabled: false })).toEqual({ ok: false, error: 'disabled' });
    expect(await approve(r, o, { off: false })).toEqual({ ok: false, error: 'moot' });
    await db.pool.query("UPDATE tasks SET status = 'cancelled' WHERE id = $1", [t.id]);
    expect(await approve(r, o)).toEqual({ ok: false, error: 'root_ended' });
    await db.pool.query("UPDATE tasks SET status = 'doing' WHERE id = $1", [t.id]);
    await db.pool.query("UPDATE ot_requests SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 second' WHERE id = $1", [o.id]);
    expect(await approve(r, o)).toEqual({ ok: false, error: 'expired' });
    await db.pool.query("UPDATE ot_requests SET expires_at = now() + interval '30 seconds', local_day = local_day - 1 WHERE id = $1", [o.id]);
    expect(await approve(r, o)).toEqual({ ok: false, error: 'expired' }); // its day is not today
    expect((await r.get(o.id))!.status).toBe('pending');
  });

  it('supersede: approving seq 2 revokes seq 1 and exactly one live grant remains', async () => {
    const r = repo();
    const t = await newRoot();
    const g1 = await granted(r, t.id, { maxRuns: 1 });
    await r.consume(t.id, await today());
    const g2 = await granted(r, t.id, { maxRuns: 5 });
    expect(g2.seq).toBe(2);
    const first = (await r.get(g1.id))!;
    expect(first).toMatchObject({ revokeReason: 'superseded', revokedBy: ADMIN });
    expect((await db.pool.query("SELECT count(*)::int AS n FROM ot_requests WHERE status = 'approved' AND revoked_at IS NULL")).rows[0]).toEqual({ n: 1 });
    expect(await r.usable(t.id, await today())).toBe(true);
  });

  it('approve, deny, day and a second approve race: exactly one wins', async () => {
    const r = repo();
    const o = await posted(r, (await newRoot()).id);
    const res = await Promise.all([
      approve(r, o), approve(r, o),
      r.deny(card(o)),
      r.claimDay({ ...card(o), tz: TZ, configChannelId: CH }),
    ]);
    expect(res.filter((x) => x.ok)).toHaveLength(1);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM ot_requests WHERE status <> 'pending'")).rows[0]).toEqual({ n: 1 });
  });

  it('claimDay needs the config channel, the digest, an unexpired row of today; unclaimDay gives the row back', async () => {
    const r = repo();
    const o = await posted(r, (await newRoot()).id);
    expect(await r.claimDay({ ...card(o), tz: TZ, configChannelId: '1565667791938387970' })).toEqual({ ok: false, error: 'wrong_card' });
    expect(await r.claimDay({ ...card(o), digest: 'ffffffffffff', tz: TZ, configChannelId: CH })).toEqual({ ok: false, error: 'wrong_card' });
    await db.pool.query("UPDATE ot_requests SET local_day = local_day - 1, expires_at = now() + interval '1 hour' WHERE id = $1", [o.id]);
    expect(await r.claimDay({ ...card(o), tz: TZ, configChannelId: CH })).toEqual({ ok: false, error: 'expired' });
    await db.pool.query('UPDATE ot_requests SET local_day = local_day + 1 WHERE id = $1', [o.id]);
    const c = await r.claimDay({ ...card(o), tz: TZ, configChannelId: CH });
    expect(c.ok && c.row.status).toBe('workday');
    await r.unclaimDay(o.id);
    expect((await r.get(o.id))!.status).toBe('pending');
  });

  it('closeMoot and the sweep end pending rows and return their cards; the sweep revokes a grant on an ended tree', async () => {
    const r = repo();
    const a = await posted(r, (await newRoot()).id);
    expect(await r.closeMoot()).toEqual([{ channelId: CH, messageId: a.cardMessageId }]);
    expect((await r.get(a.id))!.status).toBe('moot');
    const b = await posted(r, (await newRoot()).id);
    await db.pool.query("UPDATE ot_requests SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 second' WHERE id = $1", [b.id]);
    const t = await newRoot();
    const g = await granted(r, t.id);
    await db.pool.query("UPDATE tasks SET status = 'done' WHERE id = $1", [t.id]);
    const s = await r.sweep();
    expect(s.expired).toEqual([{ channelId: CH, messageId: b.cardMessageId }]);
    expect(s.ended.map((x) => x.id)).toEqual([g.id]);
    expect((await r.get(g.id))!.revokeReason).toBe('root_ended');
  });
});

describe('halt revokes (OT-C4, OT-C15)', () => {
  it('revokeAll(halt) revokes every grant and consume then refuses; resume restores nothing', async () => {
    const r = repo();
    const a = await newRoot(); const b = await newRoot();
    await granted(r, a.id); await granted(r, b.id);
    expect((await r.revokeAll('halt')).length).toBe(2);
    expect((await r.consume(a.id, await today())).ok).toBe(false);
    expect((await db.pool.query("SELECT DISTINCT revoke_reason FROM ot_requests WHERE status = 'approved'")).rows).toEqual([{ revoke_reason: 'halt' }]);
  });

  it('a halt revoke that failed is owed: the next usable pays it first, and refuses while it cannot', async () => {
    const t = await newRoot();
    await granted(repo(), t.id);
    let failing = true;
    const flaky = { query: (...a: unknown[]) => (failing && String(a[0]).includes('revoked_by = $1') ? Promise.reject(new Error('db down')) : (db.pool.query as (...x: unknown[]) => unknown)(...a)), connect: () => db.pool.connect() };
    const r = new OtRequestRepo(flaky as never, { gate: () => gate, onFault: (e) => faults.push(e) });
    await expect(r.revokeAll('halt')).rejects.toThrow();
    const day = await today();
    expect(await r.usable(t.id, day)).toBe(false); // owed and unpayable: refuses
    failing = false;
    expect(await r.usable(t.id, day)).toBe(false); // paid: the grant is gone
    expect((await db.pool.query("SELECT revoke_reason FROM ot_requests WHERE status = 'approved'")).rows).toEqual([{ revoke_reason: 'halt' }]);
  });

  it('OT-C4 boot: a grant decided before the halted row was written is revoked; one decided after is untouched', async () => {
    const r = repo();
    const a = await newRoot(); const b = await newRoot();
    const before = await granted(r, a.id);
    await db.pool.query("INSERT INTO config (key, value, updated_by) VALUES ('halted', 'false'::jsonb, 'test') ON CONFLICT (key) DO UPDATE SET updated_at = now() + interval '1 second'");
    await new Promise((res) => setTimeout(res, 20));
    await db.pool.query("UPDATE config SET updated_at = now() - interval '1 second' WHERE key = 'halted'");
    const after = await granted(r, b.id);
    await db.pool.query("UPDATE ot_requests SET decided_at = now() - interval '1 minute', created_at = now() - interval '2 minutes' WHERE id = $1", [before.id]);
    await db.pool.query("UPDATE config SET updated_at = now() - interval '30 seconds' WHERE key = 'halted'");
    expect((await r.revokeBeforeHaltedRow()).length).toBe(1);
    expect((await r.get(before.id))!.revokeReason).toBe('halt');
    expect((await r.get(after.id))!.revokedAt).toBeNull();
    expect((await r.consume(a.id, await today())).ok).toBe(false);
    expect((await r.consume(b.id, await today())).ok).toBe(true);
  });
});

describe('Gate 2 follow-ups: revokes hand back their rows (G2OT-01, G2OT-03, G2OT-04)', () => {
  it('approve returns the grants it superseded', async () => {
    const r = repo();
    const t = await newRoot();
    const g1 = await granted(r, t.id, { maxRuns: 1 });
    await r.consume(t.id, await today());
    const res = await approve(r, await posted(r, t.id), { maxRuns: 5 });
    expect(res.ok && res.superseded.map((x) => x.id)).toEqual([g1.id]);
  });

  it('revokeBeforeHaltedRow returns the revoked rows (with their cards)', async () => {
    const r = repo();
    const a = await newRoot();
    const g = await granted(r, a.id);
    await db.pool.query("INSERT INTO config (key, value, updated_by) VALUES ('halted', 'false'::jsonb, 'test') ON CONFLICT (key) DO UPDATE SET updated_at = now() + interval '1 minute'");
    const rows = await r.revokeBeforeHaltedRow();
    expect(rows.map((x) => [x.id, x.cardMessageId])).toEqual([[g.id, g.cardMessageId]]);
    await db.pool.query("DELETE FROM config WHERE key = 'halted'");
  });

  it('the halt revoke started by a refused call reports its rows through onRevoked', async () => {
    const got: OtRequest[][] = [];
    const r = new OtRequestRepo(db.pool, { gate: () => gate, onRevoked: (rows) => got.push(rows) });
    const t = await newRoot();
    const g = await granted(r, t.id);
    gate = 'halted';
    expect(await r.usable(t.id, await today())).toBe(false);
    await vi.waitFor(() => expect(got.flat().map((x) => x.id)).toEqual([g.id]));
  });

  it('a failed switch-off revoke is owed: when the switch is back on the next check pays it first', async () => {
    const t = await newRoot();
    await granted(repo(), t.id);
    let failing = true;
    const flaky = { query: (...a: unknown[]) => (failing && String(a[0]).includes('revoked_by = $1') ? Promise.reject(new Error('db down')) : (db.pool.query as (...x: unknown[]) => unknown)(...a)), connect: () => db.pool.connect() };
    const r = new OtRequestRepo(flaky as never, { gate: () => gate });
    await expect(r.revokeAll('admin', ADMIN)).rejects.toThrow();
    failing = false;
    expect(await r.usable(t.id, await today())).toBe(false); // gate null (switched back on): the owed revoke is paid first
    expect((await db.pool.query("SELECT revoke_reason FROM ot_requests WHERE status = 'approved'")).rows).toEqual([{ revoke_reason: 'admin' }]);
  });

  it('G2OT-04: unclaimDay that collides with a newer pending row ends the claimed row as expired', async () => {
    const r = repo();
    const t = await newRoot();
    const o = await posted(r, t.id);
    expect((await r.claimDay({ ...card(o), tz: TZ, configChannelId: CH })).ok).toBe(true);
    const second = await r.raise({ rootId: t.id, requestedBy: person(), ...caps });
    expect(second.ok).toBe(true);
    await r.unclaimDay(o.id);
    expect((await r.get(o.id))!.status).toBe('expired');
  });
});
