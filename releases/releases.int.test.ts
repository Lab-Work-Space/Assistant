import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../db/migrate.js';
import { ReleaseRepo, type NewRelease } from '../db/repos/releases.js';
import { freshDb, type TestDb } from '../db/test-helpers.js';
import { SLUG_RE } from '../workspaces/files.js';
import { ReleaseService, type ReleaseDeps } from './service.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const CONFIG = '1565682159375749161';
const SRC = '700000000000000001';
const ADMIN = '900000000000000001';
const TZ = 'Asia/Bangkok';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tok = (n: number) => n.toString(16).padStart(32, '0');
const ZIP = Buffer.from('PK-int-zip-bytes');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const EV = { runs: [], writesAfterLastRun: null };

let db: TestDb;
let repo: ReleaseRepo;
beforeAll(async () => { db = await freshDb(); await migrate(db.pool, dir, 'up'); repo = new ReleaseRepo(db.pool); });
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  await db.pool.query('DELETE FROM releases');
  await db.pool.query('DELETE FROM audit_log');
  await db.pool.query('DELETE FROM workspaces');
});

const nr = (n: number, over: Partial<NewRelease> = {}): NewRelease => ({
  token: tok(n), deptId: 'software', requester: 'head:software', taskId: uuid(n), rootId: uuid(1000 + n), projectId: null, target: 'handoff', title: `Title ${n}`, summary: `Summary ${n}`, slug: 'proj-a',
  sha256: sha(ZIP), bytes: ZIP.length, files: 2, skipped: 0, zip: ZIP, evidence: EV, tainted: false, catalogDigest: 'd'.repeat(64), sourceChannelId: SRC, sourceThreadId: null, ...over,
});
const made = async (n: number, over: Partial<NewRelease> = {}) => {
  const r = await repo.create(nr(n, over), TZ);
  if (!r.ok) throw new Error(`create refused ${r.code}`);
  return r;
};
const status = async (id: number) => (await db.pool.query('SELECT status, zip IS NULL AS nozip, outcome FROM releases WHERE id = $1', [id])).rows[0] as { status: string; nozip: boolean; outcome: string | null };
const card = (id: number, msg = '800000000000000001') => repo.setCard(id, CONFIG, msg);

describe('migration 045: every CHECK', () => {
  const raw = (over: Record<string, unknown> = {}) => {
    const base: Record<string, unknown> = {
      token: tok(1), dept_id: 'software', requester: 'head:software', task_id: uuid(1), root_id: uuid(2), target: 'handoff', title: 't', summary: 's', slug: 'proj-a', sha256: 'a'.repeat(64), bytes: 3, files: 1,
      zip: Buffer.from('abc'), evidence: '{}', tainted: false, catalog_digest: 'd'.repeat(64), source_channel_id: SRC, status: 'pending', ...over,
    };
    const keys = Object.keys(base);
    const sql = `INSERT INTO releases (${keys.join(',')}, expires_at) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}, now() + interval '7 days')`;
    return db.pool.query(sql, keys.map((k) => base[k]));
  };
  it('the base row is valid', async () => { await raw(); });
  it('zip is present iff the status is pending or releasing, and its length equals bytes', async () => {
    await expect(raw({ zip: null })).rejects.toThrow(/releases_zip/);
    await expect(raw({ zip: Buffer.from('ab') })).rejects.toThrow(/releases_zip/);
    await expect(raw({ status: 'rejected', decided_by: ADMIN })).rejects.toThrow(/releases_(zip|decided)/); // zip must be NULL after a terminal state
    await raw({ status: 'rejected', zip: null, decided_by: ADMIN, decided_at: new Date() });
    await expect(raw({ token: tok(9), root_id: uuid(9), status: 'released', zip: null, decided_by: ADMIN, decided_at: new Date() })).rejects.toThrow(/releases_released/);
    await expect(raw({ token: tok(10), root_id: uuid(10), status: 'failed', zip: Buffer.from('abc'), decided_by: ADMIN, decided_at: new Date() })).rejects.toThrow(/releases_zip/);
  });
  it('target, expiry, decided, shapes and sizes', async () => {
    await expect(raw({ target: 'github' })).rejects.toThrow(/releases_target_check/);
    await expect(db.pool.query("INSERT INTO releases (token, dept_id, requester, task_id, root_id, target, title, summary, slug, sha256, bytes, files, zip, evidence, tainted, catalog_digest, source_channel_id, expires_at) VALUES ($1,'software','head:software',$2,$3,'handoff','t','s','proj-a',$4,3,1,'abc','{}',false,$5,$6, now() + interval '8 days')", [tok(2), uuid(3), uuid(4), 'a'.repeat(64), 'd'.repeat(64), SRC])).rejects.toThrow(/releases_expiry/);
    await expect(raw({ token: tok(3), root_id: uuid(5), status: 'releasing' })).rejects.toThrow(/releases_decided/);
    await expect(raw({ token: 'XYZ' })).rejects.toThrow(/check/i);
    await expect(raw({ token: tok(4), slug: 'A_b' })).rejects.toThrow(/check/i);
    await expect(raw({ token: tok(5), source_channel_id: 'chan' })).rejects.toThrow(/check/i);
    await expect(raw({ token: tok(6), title: '' })).rejects.toThrow(/check/i);
    await expect(raw({ token: tok(7), summary: 'x'.repeat(601), root_id: uuid(7) })).rejects.toThrow(/check/i);
    await expect(raw({ token: tok(8), bytes: 10_000_001, zip: Buffer.alloc(10_000_001), root_id: uuid(8) })).rejects.toThrow(/check/i);
    await expect(raw({ token: tok(11), evidence: JSON.stringify({ x: 'y'.repeat(3000) }), root_id: uuid(11) })).rejects.toThrow(/check/i);
    await expect(raw({ token: tok(12), evidence: '[]', root_id: uuid(12) })).rejects.toThrow(/check/i);
  });
  it('up, down, up again', async () => {
    await migrate(db.pool, dir, 'down');
    expect((await db.pool.query("SELECT to_regclass('releases') AS t")).rows[0].t).toBeNull();
    await migrate(db.pool, dir, 'up');
    expect((await db.pool.query("SELECT to_regclass('releases') AS t")).rows[0].t).toBe('releases');
    repo = new ReleaseRepo(db.pool);
  });
});

describe('ReleaseRepo: create, caps, counts', () => {
  it('create returns the id and a database-computed 7 day expiry', async () => {
    const r = await made(1);
    expect(r.id).toBeGreaterThan(0);
    const d = (await db.pool.query<{ d: number }>('SELECT extract(epoch FROM expires_at - created_at)::int AS d FROM releases WHERE id = $1', [r.id])).rows[0]!.d;
    expect(d).toBe(7 * 86400);
    expect(Math.abs(r.expiresAt.getTime() - (Date.now() + 7 * 86400_000))).toBeLessThan(60_000);
  });
  it('one open per tree under concurrent create: exactly one wins, the rest are tree_pending', async () => {
    const out = await Promise.all(Array.from({ length: 8 }, (_, i) => repo.create(nr(100 + i, { rootId: uuid(7777) }), TZ)));
    expect(out.filter((x) => x.ok)).toHaveLength(1);
    expect(out.filter((x) => !x.ok).every((x) => !x.ok && x.code === 'tree_pending')).toBe(true);
  });
  it('2 open per department, 5 in total, 5 requests per department per local day (the lock makes them exact)', async () => {
    const a = await Promise.all(Array.from({ length: 6 }, (_, i) => repo.create(nr(200 + i), TZ)));
    expect(a.filter((x) => x.ok)).toHaveLength(2);
    expect(a.filter((x) => !x.ok).every((x) => !x.ok && x.code === 'dept_cap')).toBe(true);
    await db.pool.query('DELETE FROM releases');
    for (let i = 0; i < 5; i++) await made(300 + i, { deptId: ['software', 'rnd', 'sales', 'hr', 'ops'][i]!, requester: `head:${['software', 'rnd', 'sales', 'hr', 'ops'][i]}` });
    const sixth = await repo.create(nr(310, { deptId: 'it', requester: 'head:it' }), TZ);
    expect(sixth).toEqual({ ok: false, code: 'total_cap' });
    await db.pool.query('DELETE FROM releases');
    for (let i = 0; i < 5; i++) { const r = await made(400 + i); await repo.reject(tok(400 + i), ADMIN, null); expect(r.ok).toBe(true); }
    expect(await repo.create(nr(410), TZ)).toEqual({ ok: false, code: 'day_cap' });
    expect(await repo.create(nr(411, { deptId: 'rnd', requester: 'head:rnd' }), TZ)).toMatchObject({ ok: true });
  });
  it('openCounts reports the tree, department, total and today counts', async () => {
    await made(1);
    await made(2, { deptId: 'rnd', requester: 'head:rnd' });
    expect(await repo.openCounts('software', uuid(1001), TZ)).toEqual({ tree: 1, dept: 1, total: 2, today: 1 });
    expect(await repo.openCounts('rnd', uuid(5), TZ)).toEqual({ tree: 0, dept: 1, total: 2, today: 1 });
  });
  it('a release created before local midnight does not count today (the day is the local day of tz)', async () => {
    const r = await made(1);
    await repo.reject(tok(1), ADMIN, null);
    await db.pool.query("UPDATE releases SET created_at = now() - interval '2 days', expires_at = now() + interval '5 days' WHERE id = $1", [r.id]);
    expect((await repo.openCounts('software', uuid(5), TZ)).today).toBe(0);
  });
});

describe('ReleaseRepo: read, claim, revert, settle, fail, reject, expire', () => {
  it('byToken / byId return every column except zip, camelCase, with live; no read selects zip but claim (RL-C14)', async () => {
    const r = await made(1);
    await card(r.id);
    const row = (await repo.byToken(tok(1)))!;
    expect(row).toMatchObject({ id: r.id, deptId: 'software', rootId: uuid(1001), status: 'pending', live: true, channelId: CONFIG, messageId: '800000000000000001', evidence: EV, sourceThreadId: null });
    expect(row).not.toHaveProperty('zip');
    expect(await repo.byId(r.id)).toMatchObject({ live: true });
    expect(await repo.byToken(tok(99))).toBeNull();
    expect((await repo.list(5))[0]).not.toHaveProperty('zip');
    await db.pool.query("UPDATE releases SET expires_at = now() - interval '1 minute', created_at = now() - interval '7 days' WHERE id = $1", [r.id]);
    expect((await repo.byToken(tok(1)))!.live).toBe(false);
  });
  it('G2-RL-03: no read, claim, reject, expire or recovery view carries the token (the byToken lookup still finds the row by it)', async () => {
    const a = await made(1);
    await card(a.id);
    const T = tok(1);
    const has = (v: unknown) => JSON.stringify(v, (_k, x) => (Buffer.isBuffer(x) ? 'buf' : x)).includes(T) || Object.keys(v as object).includes('token');
    expect(has((await repo.byToken(T))!)).toBe(false);
    expect(has((await repo.byId(a.id))!)).toBe(false);
    expect((await repo.list(5)).some(has)).toBe(false);
    const claimed = (await repo.claim(T, ADMIN))!;
    expect(claimed.id).toBe(a.id);
    expect(has(claimed)).toBe(false);
    expect(Object.keys(claimed)).toContain('zip');
    await repo.revert(a.id);
    expect(has((await repo.reject(T, ADMIN, null))!)).toBe(false);
    const b = await made(2);
    expect(has((await repo.rejectById(b.id, ADMIN, 'no'))!)).toBe(false);
    const c = await made(3);
    await db.pool.query("UPDATE releases SET expires_at = now() - interval '1 minute', created_at = now() - interval '7 days' WHERE id = $1", [c.id]);
    const expired = await repo.expire();
    expect(expired).toHaveLength(1);
    expect(has(expired[0]!)).toBe(false);
    const d = await made(4);
    await card(d.id);
    await repo.claim(tok(4), ADMIN);
    const failed = await repo.failInterrupted('infinity');
    expect(failed).toHaveLength(1);
    expect(has(failed[0]!)).toBe(false);
  });
  it('setCard only while pending', async () => {
    const r = await made(1);
    expect(await card(r.id)).toBe(true);
    await repo.reject(tok(1), ADMIN, null);
    expect(await card(r.id, '800000000000000009')).toBe(false);
  });
  it('claim: pending to releasing with the zip; exactly one winner under 10 concurrent claims; the zip stays while releasing', async () => {
    const r = await made(1);
    const out = await Promise.all(Array.from({ length: 10 }, () => repo.claim(tok(1), ADMIN)));
    expect(out.filter((x) => x !== null)).toHaveLength(1);
    const won = out.find((x) => x !== null)!;
    expect(won.zip.equals(ZIP)).toBe(true);
    expect(won).toMatchObject({ status: 'releasing', decidedBy: ADMIN });
    expect(await status(r.id)).toMatchObject({ status: 'releasing', nozip: false });
  });
  it('RL-C11: claim requires expires_at > now()', async () => {
    const r = await made(1);
    await db.pool.query("UPDATE releases SET created_at = now() - interval '7 days', expires_at = now() - interval '1 second' WHERE id = $1", [r.id]);
    expect(await repo.claim(tok(1), ADMIN)).toBeNull();
    expect((await status(r.id)).status).toBe('pending');
  });
  it('revert puts a releasing row back to pending with the decision cleared; it does nothing to a settled row', async () => {
    const r = await made(1);
    await repo.claim(tok(1), ADMIN);
    expect(await repo.revert(r.id)).toBe(true);
    expect(await status(r.id)).toMatchObject({ status: 'pending', nozip: false });
    expect(await repo.byId(r.id)).toMatchObject({ decidedBy: null, decidedAt: null });
    expect(await repo.revert(r.id)).toBe(false);
  });
  it('settleReleased: released, zip NULL, message id, outcome ok; only from releasing', async () => {
    const r = await made(1);
    expect(await repo.settleReleased(r.id, '800000000000000077')).toBe(false);
    await repo.claim(tok(1), ADMIN);
    expect(await repo.settleReleased(r.id, '800000000000000077')).toBe(true);
    expect(await status(r.id)).toEqual({ status: 'released', nozip: true, outcome: 'ok' });
    expect(await repo.byId(r.id)).toMatchObject({ releasedMessageId: '800000000000000077', decidedBy: ADMIN });
    expect(await repo.revert(r.id)).toBe(false);
  });
  it('fail: failed, zip NULL, the outcome; only from releasing', async () => {
    const r = await made(1);
    expect(await repo.fail(r.id, 'hash_mismatch')).toBe(false);
    await repo.claim(tok(1), ADMIN);
    expect(await repo.fail(r.id, 'post_unknown')).toBe(true);
    expect(await status(r.id)).toEqual({ status: 'failed', nozip: true, outcome: 'post_unknown' });
  });
  it('reject (button and by id with a reason): a CAS on pending that purges the zip; not allowed while releasing or after a decision', async () => {
    const a = await made(1);
    const b = await made(2, { deptId: 'rnd', requester: 'head:rnd' });
    expect(await repo.reject(tok(1), ADMIN, null)).toMatchObject({ id: a.id, status: 'rejected', reason: null });
    expect(await repo.reject(tok(1), ADMIN, null)).toBeNull();
    expect(await repo.rejectById(b.id, ADMIN, 'Needs tests')).toMatchObject({ id: b.id, status: 'rejected', reason: 'Needs tests', decidedBy: ADMIN });
    expect((await status(b.id)).nozip).toBe(true);
    const c = await made(3);
    await repo.claim(tok(3), ADMIN);
    expect(await repo.reject(tok(3), ADMIN, null)).toBeNull();
    expect(await repo.rejectById(c.id, ADMIN, 'x')).toBeNull();
    expect((await status(c.id)).status).toBe('releasing');
  });
  it('expire: pending rows past expiry become expired with the zip purged; live and releasing rows are untouched', async () => {
    const a = await made(1);
    const b = await made(2, { deptId: 'rnd', requester: 'head:rnd' });
    const c = await made(3, { deptId: 'it', requester: 'head:it' });
    await repo.claim(tok(3), ADMIN);
    await db.pool.query("UPDATE releases SET created_at = now() - interval '7 days', expires_at = now() - interval '1 minute' WHERE id = ANY($1)", [[a.id, c.id]]);
    const out = await repo.expire();
    expect(out.map((x) => x.id)).toEqual([a.id]);
    expect(await status(a.id)).toMatchObject({ status: 'expired', nozip: true });
    expect((await status(b.id)).status).toBe('pending');
    expect((await status(c.id)).status).toBe('releasing');
  });
  it('day(tz): today counts and the open count', async () => {
    const a = await made(1);
    await repo.reject(tok(1), ADMIN, null);
    await made(2, { deptId: 'rnd', requester: 'head:rnd' });
    const c = await made(3, { deptId: 'it', requester: 'head:it' });
    await repo.claim(tok(3), ADMIN);
    await repo.fail(c.id, 'interrupted');
    expect(await repo.day(TZ)).toEqual({ requested: 3, released: 0, rejected: 1, expired: 0, failed: 1, waiting: 1 });
    expect(a.ok).toBe(true);
  });
  it('RL-C14: the zip column is read only in claim (grep of the source)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'repos', 'releases.ts'), 'utf8');
    expect(src.match(/RETURNING[^`'"]*\bzip\b/g) ?? []).toHaveLength(1);
    const colConst = /const COLS = ([^;]*);/.exec(src)![1]!;
    expect(colConst).not.toMatch(/\bzip\b/);
    expect(colConst).not.toMatch(/\btoken\b/); // G2-RL-03
    expect(src.match(/SELECT[^`'"]*\bzip\b(?! IS NULL)/g) ?? []).toHaveLength(0);
  });
});

describe('RL-C5: failInterrupted(bootTime) touches only rows claimed before bootTime', () => {
  it('a row claimed after bootTime is untouched; an older one is failed with the zip purged', async () => {
    const old = await made(1);
    await repo.claim(tok(1), ADMIN);
    await db.pool.query("UPDATE releases SET decided_at = now() - interval '1 hour' WHERE id = $1", [old.id]);
    const boot = await repo.now();
    const fresh = await made(2, { deptId: 'rnd', requester: 'head:rnd' });
    await repo.claim(tok(2), ADMIN);
    const out = await repo.failInterrupted(boot);
    expect(out.map((x) => x.id)).toEqual([old.id]);
    expect(await status(old.id)).toEqual({ status: 'failed', nozip: true, outcome: 'interrupted' });
    expect(await status(fresh.id)).toMatchObject({ status: 'releasing', nozip: false });
    expect(await repo.failInterrupted(boot)).toEqual([]);
  });
  it('now() has microsecond text precision and parses back as a timestamptz', async () => {
    const t = await repo.now();
    expect(t).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
    expect((await db.pool.query('SELECT $1::timestamptz AS t', [t])).rows[0].t).toBeInstanceOf(Date);
  });
});

describe('evidence (spec 5.2, 5.3, RL-C4)', () => {
  const ws = (slug: string) => db.pool.query("INSERT INTO workspaces (slug, title, created_by) VALUES ($1, 't', 'head:software') ON CONFLICT DO NOTHING", [slug]);
  const aud = (action: string, tool: string, outcome: string, ago: string) =>
    db.pool.query(`INSERT INTO audit_log (ts, actor, action, tool, outcome) VALUES (now() - interval '${ago}', 'head:software', $1, $2, $3)`, [action, tool, outcome]);
  const win = async (slug: string) => { const w = await repo.window(slug); return w as { since: string; until: string }; };

  it('window(slug): since is the workspace created_at, until is the database now; a missing workspace has since null', async () => {
    await ws('proj-a');
    const w = await repo.window('proj-a');
    expect(w.since).toMatch(/^\d{4}-/);
    expect(w.until >= w.since!).toBe(true);
    expect((await repo.window('nope-x')).since).toBeNull();
  });
  it('a proj row never matches proj-2: and malformed outcomes are dropped; newest first, at most 3', async () => {
    await ws('proj');
    await ws('proj-2');
    await db.pool.query("UPDATE workspaces SET created_at = now() - interval '1 day'");
    await aud('ws.run', 'ws_run', 'proj-2:test:exit=1', '5 minutes');
    await aud('ws.run', 'ws_run', 'proj:test:exit=0', '4 minutes');
    await aud('ws.run', 'ws_run', 'proj:bogus:exit=0', '3 minutes');
    await aud('ws.run', 'ws_run', 'proj:test:exit=abc', '3 minutes');
    await aud('ws.run', 'ws_run', 'proj:install:timeout', '10 minutes');
    await aud('ws.run', 'ws_run', 'proj:tsc:oom', '20 minutes');
    await aud('ws.run', 'ws_run', 'proj:ci:exit=0', '30 minutes');
    await aud('ws.run', 'other_tool', 'proj:test:exit=0', '1 minute');
    const w = await win('proj');
    const ev = await repo.evidence('proj', w.since, w.until);
    expect(ev.runs.map((r) => `${r.verb}:${r.result}`)).toEqual(['test:exit=0', 'install:timeout', 'tsc:oom']);
    expect(ev.runs.every((r) => !Number.isNaN(Date.parse(r.at)))).toBe(true);
    const ev2 = await repo.evidence('proj-2', (await win('proj-2')).since, (await win('proj-2')).until);
    expect(ev2.runs.map((r) => r.result)).toEqual(['exit=1']);
  });
  it('the slug is validated (no LIKE metacharacters reach the query), the same SLUG_RE as the workspace code', async () => {
    const w = { since: '2026-01-01T00:00:00.000000Z', until: '2026-01-02T00:00:00.000000Z' };
    for (const bad of ['a%', 'a_b', 'A', '', 'a:b', "a'b", 'x'.repeat(41)]) await expect(repo.evidence(bad, w.since, w.until)).rejects.toThrow();
    expect(SLUG_RE.test('a%')).toBe(false);
  });
  it('no runs: writesAfterLastRun is null', async () => {
    await ws('proj');
    const w = await win('proj');
    expect(await repo.evidence('proj', w.since, w.until)).toEqual({ runs: [], writesAfterLastRun: null });
  });
  it('RL-C4: a run audited after `until` is absent', async () => {
    await ws('proj');
    await db.pool.query("UPDATE workspaces SET created_at = now() - interval '1 day'");
    await aud('ws.run', 'ws_run', 'proj:test:exit=0', '2 minutes');
    const until = await repo.now();
    await aud('ws.run', 'ws_run', 'proj:node:exit=0', '0 seconds'); // after until
    const since = (await win('proj')).since;
    const ev = await repo.evidence('proj', since, until);
    expect(ev.runs.map((r) => r.verb)).toEqual(['test']);
  });
  it('RL-C4: a write audited after `until` but after the last run shows yes (no upper bound on writes); one before the last run shows no', async () => {
    await ws('proj');
    await db.pool.query("UPDATE workspaces SET created_at = now() - interval '1 day'");
    await aud('ws.write', 'ws_write', 'proj:src/a.ts:10', '10 minutes');
    await aud('ws.run', 'ws_run', 'proj:test:exit=0', '5 minutes');
    const until = await repo.now();
    const since = (await win('proj')).since;
    expect((await repo.evidence('proj', since, until)).writesAfterLastRun).toBe(false);
    await aud('ws.delete', 'ws_delete', 'proj:src/b.ts', '0 seconds'); // after until, after the last run
    expect((await repo.evidence('proj', since, until)).writesAfterLastRun).toBe(true);
    await aud('ws.write', 'ws_write', 'proj-2:src/c.ts:1', '0 seconds'); // another slug never counts
  });
  it('RL-C4: a slug that was deleted and re-created shows no old runs or writes', async () => {
    await ws('proj');
    await db.pool.query("UPDATE workspaces SET created_at = now() - interval '2 days'");
    await aud('ws.run', 'ws_run', 'proj:test:exit=0', '1 day');
    await aud('ws.write', 'ws_write', 'proj:a.ts:1', '1 day');
    await db.pool.query('DELETE FROM workspaces WHERE slug = $1', ['proj']);
    await ws('proj'); // re-created now
    const w = await win('proj');
    expect(await repo.evidence('proj', w.since, w.until)).toEqual({ runs: [], writesAfterLastRun: null });
  });
});

// ---- the service on the real repo, with fake ports -------------------------------------------------------------------------------------------------------

function service(over: { halted?: boolean; failFirst?: unknown; secrets?: string[]; zip?: Buffer } = {}) {
  const st = { halted: over.halted ?? false, failPost: over.failFirst as unknown };
  const files: { target: { channelId: string; threadId?: string }; file: { name: string; data: Buffer; contentType: string } }[] = [];
  const closed: string[] = [];
  const notices: string[] = [];
  const audits: { action: string; outcome?: string | null }[] = [];
  const zip = over.zip ?? ZIP;
  const deps = {
    repo,
    ws: { export: async () => ({ zip, files: 2, sha256: sha(zip), skipped: 0 }) },
    projects: { byRoot: async () => null },
    enabled: () => true, wsEnabled: () => true, halted: () => st.halted, tz: () => TZ,
    audit: async (e: never) => void audits.push(e), secrets: over.secrets ?? [], configChannelId: CONFIG, catalogDigest: 'd'.repeat(64),
    postCard: async () => '800000000000000021',
    postFile: async (_a: unknown, target: { channelId: string; threadId?: string }, _p: unknown, file: { name: string; data: Buffer; contentType: string }) => {
      if (target.channelId !== CONFIG && st.failPost) throw st.failPost;
      files.push({ target, file });
      return target.channelId === CONFIG ? '800000000000000020' : '800000000000000030';
    },
    provenance: { record: async () => undefined },
    closeCard: async (_c: string, _m: string, note: string) => void closed.push(note),
    notifyHead: async (_d: string, text: string) => void notices.push(text),
    log: { error: () => undefined },
  } as unknown as ReleaseDeps;
  const svc = new ReleaseService(deps);
  return { svc, st, files, closed, notices, audits, deps };
}
const run = (n = 1) => ({ tainted: false, task: { id: uuid(n), rootId: uuid(1000 + n), tainted: false }, ownsTask: true, source: { channelId: SRC, threadId: null } });
const HEAD = { kind: 'head', dept: 'software' } as const;
const IN = { slug: 'proj-a', title: 'Title', summary: 'Summary' };

async function filed(s: ReturnType<typeof service>, n = 1) {
  await db.pool.query("INSERT INTO workspaces (slug, title, created_by) VALUES ('proj-a', 't', 'head:software') ON CONFLICT DO NOTHING");
  const res = await s.svc.request(HEAD, run(n), IN);
  if (!res.ok) throw new Error(`refused ${res.code}`);
  const row = (await repo.byId(res.id!))!;
  const token = (await db.pool.query<{ token: string }>('SELECT token FROM releases WHERE id = $1', [res.id])).rows[0]!.token; // the views carry no token (G2-RL-03)
  return { id: res.id!, token, messageId: row.messageId! };
}
const click = (s: ReturnType<typeof service>, f: { token: string; messageId: string }, action: 'approve' | 'reject' = 'approve') =>
  s.svc.decide({ token: f.token, action, userId: ADMIN, channelId: CONFIG, messageId: f.messageId });

describe('the service on the real repo', () => {
  it('request: pinned row, card stored, copy posted from the same bytes (RL-C9), the zip is in the row and nowhere else', async () => {
    const s = service();
    const f = await filed(s);
    const row = (await repo.byId(f.id))!;
    expect(row).toMatchObject({ status: 'pending', sha256: sha(ZIP), bytes: ZIP.length, files: 2, channelId: CONFIG, messageId: '800000000000000021', tainted: false });
    expect(sha(s.files[0]!.file.data)).toBe(row.sha256);
    expect(s.files[0]!.file.contentType).toBe('application/zip');
    expect(await status(f.id)).toMatchObject({ status: 'pending', nozip: false });
  });
  it('approve: released, the zip posted from the pinned bytes (same sha), zip NULL, the card closed, a second click is not_pending', async () => {
    const s = service();
    const f = await filed(s);
    expect(await click(s, f)).toMatchObject({ ok: true, result: 'released' });
    const posted = s.files.find((x) => x.target.channelId === SRC)!;
    expect(sha(posted.file.data)).toBe(sha(ZIP));
    expect(posted.file.contentType).toBe('application/zip');
    expect(await status(f.id)).toEqual({ status: 'released', nozip: true, outcome: 'ok' });
    expect((await repo.byId(f.id))!.releasedMessageId).toBe('800000000000000030');
    expect(await click(s, f)).toMatchObject({ ok: false, code: 'not_pending' });
    expect(s.files.filter((x) => x.target.channelId === SRC)).toHaveLength(1);
    expect(s.closed).toHaveLength(1);
  });
  it('RL-C11: two concurrent approvals post exactly once', async () => {
    const s = service();
    const f = await filed(s);
    const out = await Promise.all([click(s, f), click(s, f), click(s, f)]);
    expect(out.filter((x) => x.ok)).toHaveLength(1);
    expect(s.files.filter((x) => x.target.channelId === SRC)).toHaveLength(1);
  });
  it('RL-C11: a stale card (another message id) and a copy in another channel are wrong_card; the row stays pending', async () => {
    const s = service();
    const f = await filed(s);
    expect(await s.svc.decide({ token: f.token, action: 'approve', userId: ADMIN, channelId: CONFIG, messageId: '800000000000000099' })).toMatchObject({ code: 'wrong_card' });
    expect(await s.svc.decide({ token: f.token, action: 'approve', userId: ADMIN, channelId: SRC, messageId: f.messageId })).toMatchObject({ code: 'wrong_card' });
    expect((await status(f.id)).status).toBe('pending');
  });
  it('RL-C11: halted or off leaves the row pending; after /resume the same card works', async () => {
    const s = service();
    const f = await filed(s);
    s.st.halted = true;
    expect(await click(s, f)).toMatchObject({ code: 'halted' });
    expect((await status(f.id)).status).toBe('pending');
    s.st.halted = false;
    expect(await click(s, f)).toMatchObject({ ok: true });
  });
  it('RL-C11: reject while releasing is not_pending; reject of a pending row purges the zip', async () => {
    const s = service();
    const f = await filed(s);
    await repo.claim(f.token, ADMIN);
    expect(await click(s, f, 'reject')).toMatchObject({ ok: false, code: 'not_pending' });
    expect((await status(f.id)).status).toBe('releasing');
    await db.pool.query('DELETE FROM releases');
    const g = await filed(s, 2);
    expect(await click(s, g, 'reject')).toMatchObject({ ok: true, result: 'rejected' });
    expect(await status(g.id)).toMatchObject({ status: 'rejected', nozip: true });
  });
  it('hash_mismatch: a corrupted pinned zip fails the row with the zip purged and nothing posted in the thread', async () => {
    const s = service();
    const f = await filed(s);
    await db.pool.query("UPDATE releases SET zip = 'PK-int-zip-BYTES' WHERE id = $1", [f.id]);
    expect(await click(s, f)).toMatchObject({ ok: false, code: 'hash_mismatch' });
    expect(await status(f.id)).toEqual({ status: 'failed', nozip: true, outcome: 'hash_mismatch' });
    expect(s.files.filter((x) => x.target.channelId === SRC)).toHaveLength(0);
  });
  it('RL-C3: a 403 on the thread post reverts to pending (a second click can post); a 500 fails as post_unknown and a second click is not_pending', async () => {
    const s = service({ failFirst: Object.assign(new Error('Missing Access'), { status: 403 }) });
    const f = await filed(s);
    expect(await click(s, f)).toMatchObject({ ok: false, code: 'post_failed' });
    expect(await status(f.id)).toMatchObject({ status: 'pending', nozip: false });
    s.st.failPost = null;
    expect(await click(s, f)).toMatchObject({ ok: true });
    await db.pool.query('DELETE FROM releases');
    const t = service({ failFirst: Object.assign(new Error('timeout'), { status: 504 }) });
    const g = await filed(t, 2);
    expect(await click(t, g)).toMatchObject({ ok: false, code: 'post_unknown' });
    expect(await status(g.id)).toEqual({ status: 'failed', nozip: true, outcome: 'post_unknown' });
    t.st.failPost = null;
    expect(await click(t, g)).toMatchObject({ ok: false, code: 'not_pending' });
    expect(t.files.filter((x) => x.target.channelId === SRC)).toHaveLength(0);
  });
  it('RL-C5: recover(bootTime) fails an older releasing row and leaves one claimed after the boot time', async () => {
    const s = service();
    const f = await filed(s);
    await repo.claim(f.token, ADMIN);
    await db.pool.query("UPDATE releases SET decided_at = now() - interval '1 hour' WHERE id = $1", [f.id]);
    const boot = await s.svc.bootTime();
    await s.svc.recover(boot);
    expect(await status(f.id)).toEqual({ status: 'failed', nozip: true, outcome: 'interrupted' });
    expect(s.files.filter((x) => x.target.channelId === SRC)).toHaveLength(0);
    expect(s.closed.at(-1)).toContain('Interrupted during the release');
  });
  it('the request refuses a second release in the same tree and the third open of a department', async () => {
    const s = service();
    await filed(s, 1);
    expect(await s.svc.request(HEAD, run(1), IN)).toMatchObject({ ok: false, code: 'tree_pending' });
    await filed(s, 2);
    expect(await s.svc.request(HEAD, run(3), IN)).toMatchObject({ ok: false, code: 'dept_cap' });
  });
  it('no zip, title or summary appears in any audit row or log (audit outcomes are codes)', async () => {
    const s = service();
    await filed(s);
    expect(JSON.stringify(s.audits)).not.toContain('Summary');
    expect(JSON.stringify(s.audits)).not.toContain('PK-int');
  });
});
