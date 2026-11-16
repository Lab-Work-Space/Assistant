import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readTierConfig } from '../executor/tiers.js';
import { readWelcomeConfig } from '../executor/welcome.js';
import { createRateGate } from '../executor/rate.js';
import { createAudit } from '../governance/audit.js';
import { applyExecutorRole, EXECUTOR_TABLE_GRANTS, executorGrantStatements } from './executor-role.js';
import { migrate } from './migrate.js';
import type { Pool } from './pool.js';
import { AdminCardRepo } from './repos/adminCards.js';
import { DeployRepo } from './repos/deploy.js';
import { ExecRepo } from './repos/exec.js';
import { AuditRepo } from './repos/ledger.js';
import { freshDb, type TestDb } from './test-helpers.js';

/**
 * OD-1: every query the executor runs, executed as the least-privilege executor role (SET ROLE), plus the tables it must NOT reach.
 * A missing grant would only show at runtime on the owner's Mac; this test is the check (the suite itself runs as a superuser).
 */
let db: TestDb;
let client: pg.PoolClient;
let as: Pool; // a pool-shaped view of the connection that runs as the executor role
const role = `lw_exec_${randomBytes(4).toString('hex')}`;
const CARD = 'f'.repeat(32);

beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), 'migrations'), 'up');
  await applyExecutorRole(db.pool, { role, password: randomBytes(24).toString('hex'), schema: db.schema });
  await db.pool.query(
    `INSERT INTO admin_cards (id, proposer_id, kind, payload, snapshot, channel_id, status, decided_by, decided_at, expires_at, message_id)
     VALUES ($1, 'u1', 'deploy', '{}', '{}', 'c', 'confirmed', 'u1', now(), now() + interval '10 minutes', 'm')`, [CARD]);
  client = await db.pool.connect();
  await client.query(`SET ROLE ${role}`);
  as = { query: (...a: unknown[]) => (client.query as (...x: unknown[]) => unknown)(...a) } as unknown as Pool;
});
afterAll(async () => {
  await client?.query('RESET ROLE').catch(() => undefined);
  client?.release();
  await db.pool.query(`DROP OWNED BY ${role}`).catch(() => undefined);
  await db.pool.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
  await db.close();
});

describe('the executor role can do what the executor does', () => {
  it('claims a confirmed card exactly once, and can read it', async () => {
    expect(((await as.query('SELECT current_user AS u')) as { rows: { u: string }[] }).rows[0]!.u).toBe(role);
    const cards = new AdminCardRepo(as);
    expect(await cards.claimForExecution(CARD)).toMatchObject({ id: CARD, kind: 'deploy' });
    expect(await cards.claimForExecution(CARD)).toBeNull();
  });
  it('ExecRepo: state, outbox (incl. deploy.result), welcome dedupe, archives, purge', async () => {
    const exec = new ExecRepo(as);
    await exec.setState('k', { a: 1 });
    expect(await exec.getState('k')).toEqual({ a: 1 });
    expect(await exec.clearState('k')).toBe(true);
    expect(await exec.firstWelcome('u9')).toBe(true);
    await exec.recordArchive('ch1', 'u1');
    await exec.push('deploy.result', { cardId: CARD, channelId: 'c', text: 't' });
    const [row] = await exec.pending();
    expect(row).toMatchObject({ kind: 'deploy.result' });
    expect(await exec.markDone(row!.id)).toBe(true);
    await expect(exec.purge()).resolves.toMatchObject({ audit: expect.any(Number) });
  });
  it('audit append, rate gate counting, tier and welcome config reads', async () => {
    const audit = createAudit(new AuditRepo(as));
    await audit({ actor: 'user:u1 via deploy', action: 'server.test', outcome: 'ok' });
    await expect(createRateGate(as).check('u1', 1, 0)).resolves.toBeNull();
    await expect(readTierConfig(as)).resolves.toBeDefined();
    await expect(readWelcomeConfig(as)).resolves.toBeDefined();
    await expect(as.query('SELECT channel_id FROM channel_map')).resolves.toBeDefined();
    await expect(as.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'admin_cards' AND column_name = 'executed_at' AND table_schema = current_schema()`)).resolves.toMatchObject({ rowCount: 1 });
  });
  it('DeployRepo: the executor side (read and delete uploads, its job queue)', async () => {
    await db.pool.query(`INSERT INTO deploy_uploads (sha256, size, data, proposer_id) VALUES ($1, 3, 'abc', 'u1')`, ['a'.repeat(64)]);
    const d = new DeployRepo(as);
    expect(await d.getUpload('a'.repeat(64))).toMatchObject({ size: 3 });
    await d.addJob('J-0123456789abcdef', CARD, 'add', 'c');
    expect((await d.openJobs()).map((j) => j.job)).toEqual(['J-0123456789abcdef']);
    await d.finishJob('J-0123456789abcdef', 'done');
    await d.deleteUpload('a'.repeat(64));
    await expect(d.purge()).resolves.toBeUndefined();
  });
});

describe('self-code tables (migration 017)', () => {
  it('the executor reads jobs and bundles and stamps the outcome; it cannot create or edit anything else', async () => {
    await db.pool.query(`INSERT INTO dev_jobs (id, repo, kind, requester_id, request) VALUES ('J-0123456789abcdef', 'o/r', 'assistant', '${'1'.repeat(18)}', 'x')`);
    await db.pool.query(`INSERT INTO dev_job_bundles (job, sha256, size, data) VALUES ('J-0123456789abcdef', '${'a'.repeat(64)}', 1, 'x')`);
    await expect(as.query('SELECT sha256, data FROM dev_job_bundles')).resolves.toMatchObject({ rowCount: 1 });
    await expect(as.query(`UPDATE dev_jobs SET status = 'applied', outcome = 'ok', finished_at = now(), updated_at = now()`)).resolves.toBeDefined();
    for (const q of ["UPDATE dev_jobs SET request = 'evil'", "UPDATE dev_jobs SET head_sha = '" + 'b'.repeat(40) + "'", 'DELETE FROM dev_jobs', "INSERT INTO dev_job_bundles (job, sha256, size, data) VALUES ('J-0123456789abcdef', '" + 'b'.repeat(64) + "', 1, 'x')", "UPDATE dev_job_bundles SET data = 'evil'", 'DELETE FROM dev_job_bundles']) {
      await expect(as.query(q), q).rejects.toThrow(/permission denied/);
    }
  });
});

describe('and nothing else', () => {
  it('TEAMTALK T14: room_entries (the room memory) is outside the executor role: no read, no write', async () => {
    expect(EXECUTOR_TABLE_GRANTS.map((g) => g.table)).not.toContain('room_entries');
    await expect(as.query('SELECT 1 FROM room_entries LIMIT 1')).rejects.toThrow(/permission denied/);
    await expect(as.query("INSERT INTO room_entries (persona_id, dept_id, kind, body) VALUES ('p','hq','idea','x')")).rejects.toThrow(/permission denied/);
  });
  it('cannot read any table outside its list, nor write the ones it only reads', async () => {
    const rows = (await db.pool.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'`, [db.schema])).rows;
    const allowed = new Set(EXECUTOR_TABLE_GRANTS.map((g) => g.table));
    const others = rows.map((r) => r.table_name).filter((t) => !allowed.has(t) && t !== 'schema_migrations');
    expect(others.length).toBeGreaterThan(5);
    for (const t of others) await expect(as.query(`SELECT 1 FROM "${t}" LIMIT 1`), t).rejects.toThrow(/permission denied/);
    for (const q of ["INSERT INTO config (key, value) VALUES ('x', '1')", "UPDATE config SET value = '2'", 'DELETE FROM config', "INSERT INTO channel_map VALUES ('a','b',false)"]) {
      await expect(as.query(q), q).rejects.toThrow(/permission denied/);
    }
  });
  it('cannot change a card other than stamping executed_at, nor create one', async () => {
    for (const q of ["UPDATE admin_cards SET status = 'confirmed'", "UPDATE admin_cards SET decided_by = 'x'", "UPDATE admin_cards SET payload = '{}'", 'DELETE FROM admin_cards', "INSERT INTO admin_cards (id, proposer_id, kind, payload, snapshot, channel_id, expires_at) VALUES ('z','u','deploy','{}','{}','c',now())"]) {
      await expect(as.query(q), q).rejects.toThrow(/permission denied/);
    }
    await expect(as.query('UPDATE admin_cards SET executed_at = executed_at')).resolves.toBeDefined();
  });
  it('cannot add an upload (that is the main application), alter the audit rows, or run DDL', async () => {
    for (const q of ["INSERT INTO deploy_uploads (sha256, size, data, proposer_id) VALUES ('" + 'b'.repeat(64) + "', 1, 'x', 'u')", "UPDATE audit_log SET outcome = 'x'", 'CREATE TABLE evil (a int)', 'DROP TABLE exec_state', 'ALTER TABLE exec_state ADD COLUMN x int', 'TRUNCATE exec_state', 'CREATE ROLE evil', 'CREATE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql']) {
      await expect(as.query(q), q).rejects.toThrow(/permission denied|must be owner|must have/);
    }
  });
  it('the role is not a superuser and cannot create roles or databases', async () => {
    const r = await db.pool.query<{ rolsuper: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolreplication: boolean }>('SELECT rolsuper, rolcreaterole, rolcreatedb, rolreplication FROM pg_roles WHERE rolname = $1', [role]);
    expect(r.rows[0]).toEqual({ rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false });
  });
});

describe('statement builder', () => {
  it('refuses unsafe identifiers', () => {
    expect(() => executorGrantStatements('x"; DROP', 'public')).toThrow();
    expect(() => executorGrantStatements('lw_executor', 'a;b')).toThrow();
    expect(executorGrantStatements('lw_executor', 'public').some((s) => /GRANT (ALL|CREATE)/.test(s))).toBe(false);
  });
});
