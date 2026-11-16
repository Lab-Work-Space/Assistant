import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ActorRef } from '../../company/types.js';
import { migrate } from '../migrate.js';
import { freshDb, type TestDb } from '../test-helpers.js';
import { DepartmentRepo, TaskRepo } from './index.js';
import { insertGrant } from './web-grants.js';
import { insertTaskGrant, liveGrantOf, supersedeAllTaskGrants, TaskGrantRepo, type TaskGrant } from './task-grants.js';

let db: TestDb;
let tasks: TaskRepo;
const hq: ActorRef = { kind: 'head', dept: 'hq' };
const ADMIN = '123456789012345678';
const MSG = '223456789012345678';
const CH = '323456789012345678';

beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations'), 'up');
  await new DepartmentRepo(db.pool).upsert({ id: 'hq', name: 'HQ', categoryNamePattern: '', workChannelId: null, color: 0, model: null, provider: null, enabled: true });
  tasks = new TaskRepo(db.pool);
});
beforeEach(async () => {
  await db.pool.query('DELETE FROM task_grants');
  await db.pool.query('DELETE FROM web_grants');
  await db.pool.query('DELETE FROM approvals');
  await db.pool.query('DELETE FROM tasks');
});
afterAll(async () => { await db.close(); });

const newRoot = () => tasks.create({ title: 't', deptId: 'hq', owner: hq, requester: { kind: 'human', userId: '1' }, origin: 'chat' });
let seq = 0;
const approval = async (taskId: string, tool = 'write_file'): Promise<number> => {
  const r = await db.pool.query<{ id: number }>(
    `INSERT INTO approvals (task_id, reason, est_cost_usd, requested_by, kind, tool_name, tool_input, input_sha256) VALUES ($1,'r',0,'head:hq','tool',$2,$3::jsonb,'x') RETURNING id`,
    [taskId, tool, JSON.stringify({ path: `a${++seq}.txt` })],
  );
  return r.rows[0]!.id;
};
const grant = async (rootId: string, o: { maxCalls?: number; hours?: number; webGrantId?: number | null } = {}) =>
  insertTaskGrant(db.pool, { rootId, approvalId: await approval(rootId), grantedBy: ADMIN, requestedBy: 'head:hq', maxCalls: o.maxCalls ?? 40, hours: o.hours ?? 12, webGrantId: o.webGrantId ?? null });
const webGrant = async (rootId: string) =>
  (await insertGrant(db.pool, { rootId, approvalId: await approval(rootId, 'fetch_page'), grantedBy: ADMIN, requestedBy: 'head:hq', maxFetches: 20, maxHosts: 5, maxUrlChars: 4000, hours: 4 })).id;

describe('TaskGrantRepo.consume (TG-C20, concurrency)', () => {
  it('60 concurrent consumes on max_calls=40 give exactly 40 ok and the per-tool counts add up', async () => {
    const t = await newRoot();
    await grant(t.id, { maxCalls: 40 });
    const repo = new TaskGrantRepo(db.pool);
    const rs = await Promise.all(Array.from({ length: 60 }, (_, i) => repo.consume({ rootId: t.id, tool: i % 2 ? 'write_file' : 'forum_post' })));
    expect(rs.filter((r) => r.ok)).toHaveLength(40);
    expect(rs.filter((r) => !r.ok).every((r) => !r.ok && r.why === 'cap_calls')).toBe(true);
    const row = (await db.pool.query('SELECT used, used_by_tool FROM task_grants')).rows[0];
    expect(row.used).toBe(40);
    expect(Object.values(row.used_by_tool as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(40);
    expect(await repo.live(t.id)).toBeNull(); // exhausted
  });

  it('a done root, a cancelled root, an expired grant and a revoked grant each give not-ok; no grant gives none (TG-C18: no listener needed)', async () => {
    const repo = new TaskGrantRepo(db.pool);
    const a = await newRoot(); await grant(a.id);
    await db.pool.query("UPDATE tasks SET status = 'done' WHERE id = $1", [a.id]);
    expect(await repo.consume({ rootId: a.id, tool: 'write_file' })).toEqual({ ok: false, why: 'root_ended' });
    const b = await newRoot(); await grant(b.id);
    await db.pool.query("UPDATE tasks SET status = 'cancelled' WHERE id = $1", [b.id]);
    expect(await repo.consume({ rootId: b.id, tool: 'write_file' })).toEqual({ ok: false, why: 'root_ended' });
    const c = await newRoot(); await grant(c.id);
    await db.pool.query("UPDATE task_grants SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE root_id = $1", [c.id]);
    expect(await repo.consume({ rootId: c.id, tool: 'write_file' })).toEqual({ ok: false, why: 'expired' });
    const d = await newRoot(); const g = await grant(d.id);
    expect(await repo.revoke(g.id, ADMIN, 'admin')).toBe(true);
    expect(await repo.revoke(g.id, ADMIN, 'admin')).toBe(false);
    expect(await repo.consume({ rootId: d.id, tool: 'write_file' })).toEqual({ ok: false, why: 'revoked' });
    expect(await repo.consume({ rootId: (await newRoot()).id, tool: 'write_file' })).toEqual({ ok: false, why: 'none' });
  });

  it('a tool name never reaches SQL as anything but a bound text parameter (key of used_by_tool)', async () => {
    const t = await newRoot(); await grant(t.id);
    const repo = new TaskGrantRepo(db.pool);
    expect((await repo.consume({ rootId: t.id, tool: "x'); DROP TABLE tasks;--" })).ok).toBe(true);
    expect(Object.keys((await db.pool.query('SELECT used_by_tool FROM task_grants')).rows[0].used_by_tool)).toEqual(["x'); DROP TABLE tasks;--"]);
  });

  it('consume never throws: a pg error becomes why:error plus one fault report without the tool name', async () => {
    const faults: unknown[] = [];
    const broken = { query: async () => { throw Object.assign(new Error('connection reset secret-tool'), { code: '08006' }); } } as never;
    const repo = new TaskGrantRepo(broken, { onFault: (e) => faults.push(e) });
    expect(await repo.consume({ rootId: 'x', tool: 'secret-tool' })).toEqual({ ok: false, why: 'error' });
    expect(faults).toHaveLength(1);
    expect(String((faults[0] as Error).message)).toBe('task grant consume failed (08006)');
  });

  it('the gate refuses before any SQL: halted, disabled and tainted spend nothing (TG-C7, F-8)', async () => {
    const t = await newRoot(); await grant(t.id);
    let gate: 'halted' | 'disabled' | 'tainted' | null = 'disabled';
    const repo = new TaskGrantRepo(db.pool, { gate: () => gate });
    expect(await repo.consume({ rootId: t.id, tool: 'write_file' })).toEqual({ ok: false, why: 'disabled' });
    gate = 'tainted';
    expect(await repo.consume({ rootId: t.id, tool: 'write_file' })).toEqual({ ok: false, why: 'tainted' });
    gate = 'halted';
    expect(await repo.consume({ rootId: t.id, tool: 'write_file' })).toEqual({ ok: false, why: 'halted' });
    const t0 = Date.now();
    while ((await repo.live(t.id)) !== null && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 10)); // the halted refusal retried the revoke
    expect(await repo.live(t.id)).toBeNull();
    expect((await db.pool.query('SELECT used FROM task_grants')).rows[0]).toEqual({ used: 0 });
  });

  it('fires onUse with the grant id after an ok consume only', async () => {
    const t = await newRoot(); const g = await grant(t.id, { maxCalls: 1 });
    const used: number[] = [];
    const repo = new TaskGrantRepo(db.pool, { onUse: (id) => { used.push(id); throw new Error('boom'); } });
    expect((await repo.consume({ rootId: t.id, tool: 'write_file' })).ok).toBe(true); // a throwing hook does not undo or fail the consume
    expect((await repo.consume({ rootId: t.id, tool: 'write_file' })).ok).toBe(false);
    expect(used).toEqual([g.id]);
  });
});

describe('TG-C7: halt revoke owed after a database outage (mutation-checked)', () => {
  it('outage -> revokeAll throws -> recovery: the next consume revokes first and returns not-ok', async () => {
    const t = await newRoot(); await grant(t.id);
    let halted = true;
    let down = true;
    const flaky = { query: (...a: unknown[]) => (down ? Promise.reject(new Error('connection lost')) : (db.pool.query as (...x: unknown[]) => unknown)(...a)) } as never;
    const repo = new TaskGrantRepo(flaky, { gate: () => (halted ? 'halted' : null) });
    expect(await repo.consume({ rootId: t.id, tool: 'write_file' })).toEqual({ ok: false, why: 'halted' });
    await expect(repo.revokeAll('halt')).rejects.toThrow();
    down = false; halted = false;
    expect(await repo.consume({ rootId: t.id, tool: 'write_file' })).toEqual({ ok: false, why: 'revoked' });
    expect((await db.pool.query('SELECT used, revoke_reason FROM task_grants')).rows[0]).toEqual({ used: 0, revoke_reason: 'halt' });
  });

  it('a payment that itself fails is `error` (a card), not a pass', async () => {
    const t = await newRoot(); await grant(t.id);
    let down = true;
    const flaky = { query: (...a: unknown[]) => (down ? Promise.reject(new Error('lost')) : (db.pool.query as (...x: unknown[]) => unknown)(...a)) } as never;
    const repo = new TaskGrantRepo(flaky);
    await expect(repo.revokeAll('halt')).rejects.toThrow();
    expect(await repo.consume({ rootId: t.id, tool: 'write_file' })).toEqual({ ok: false, why: 'error' });
    down = false;
    expect(await repo.consume({ rootId: t.id, tool: 'write_file' })).toEqual({ ok: false, why: 'revoked' });
  });
});

describe('TG-C8: the switch turned off', () => {
  it('a failed revokeAll(disabled) is owed: when the switch is back on, the next consume pays it before spending', async () => {
    const t = await newRoot(); await grant(t.id);
    let down = true;
    const flaky = { query: (...a: unknown[]) => (down ? Promise.reject(new Error('lost')) : (db.pool.query as (...x: unknown[]) => unknown)(...a)) } as never;
    const repo = new TaskGrantRepo(flaky);
    await expect(repo.revokeAll('disabled')).rejects.toThrow();
    down = false; // switch is back on (gate open): the old grant must not come back
    expect(await repo.consume({ rootId: t.id, tool: 'write_file' })).toEqual({ ok: false, why: 'revoked' });
    expect((await db.pool.query('SELECT revoke_reason FROM task_grants')).rows[0]).toEqual({ revoke_reason: 'disabled' });
  });

  it('revokeAll(disabled) revokes every grant and the companion web grants (reason admin, inside the 027 CHECK)', async () => {
    const a = await newRoot(); const b = await newRoot();
    const wa = await webGrant(a.id);
    await grant(a.id, { webGrantId: wa }); await grant(b.id);
    const closed: { n: number; why: string }[] = [];
    const repo = new TaskGrantRepo(db.pool, { onRevoked: (rows, why) => closed.push({ n: rows.length, why }) });
    expect(await repo.revokeAll('disabled', 'u1')).toHaveLength(2);
    expect(closed).toEqual([{ n: 2, why: 'disabled' }]);
    expect((await db.pool.query('SELECT revoke_reason FROM task_grants ORDER BY id')).rows.map((r) => r.revoke_reason)).toEqual(['disabled', 'disabled']);
    expect((await db.pool.query('SELECT revoke_reason FROM web_grants')).rows[0]).toEqual({ revoke_reason: 'admin' });
  });
});

describe('TG-C9 / TG-C18: revoke with root_ended and disabled leaves both rows revoked', () => {
  it.each(['root_ended', 'disabled'] as const)('revoke(%s) keeps the task revoke and revokes the companion', async (reason) => {
    const t = await newRoot();
    const w = await webGrant(t.id);
    const g = await grant(t.id, { webGrantId: w });
    const repo = new TaskGrantRepo(db.pool);
    expect(await repo.revoke(g.id, 'system', reason)).toBe(true);
    expect((await db.pool.query('SELECT revoke_reason FROM task_grants')).rows[0]).toEqual({ revoke_reason: reason });
    expect((await db.pool.query('SELECT revoke_reason FROM web_grants')).rows[0]).toEqual({ revoke_reason: 'admin' });
  });

  it('a companion that cannot be revoked never undoes the task-grant revoke', async () => {
    const t = await newRoot();
    const w = await webGrant(t.id);
    const g = await grant(t.id, { webGrantId: w });
    const real = new TaskGrantRepo(db.pool);
    const spy = { query: (sql: string, p?: unknown[]) => (/web_grants/.test(sql) ? Promise.reject(new Error('web revoke failed')) : db.pool.query(sql, p as never)) } as never;
    expect(await new TaskGrantRepo(spy).revoke(g.id, ADMIN, 'admin')).toBe(true);
    expect((await real.get(g.id))?.revokeReason).toBe('admin');
  });

  it('revokeRoot revokes one tree only and reports the rows (the root-end close)', async () => {
    const a = await newRoot(); const b = await newRoot();
    await grant(a.id); await grant(b.id);
    const seen: TaskGrant[][] = [];
    const repo = new TaskGrantRepo(db.pool, { onRevoked: (r) => seen.push(r) });
    expect((await repo.revokeRoot(a.id)).map((r) => r.rootId)).toEqual([a.id]);
    expect(seen[0]).toHaveLength(1);
    expect(await repo.live(b.id)).not.toBeNull();
    expect((await repo.get(seen[0]![0]!.id))?.revokeReason).toBe('root_ended');
  });
});

describe('TG-C7: boot revoke and supersede', () => {
  it('revokeBeforeHaltedRow revokes a grant older than the halted row and leaves a newer one', async () => {
    const a = await newRoot(); const b = await newRoot();
    await grant(a.id);
    await db.pool.query("INSERT INTO config (key, value, updated_at) VALUES ('halted','false'::jsonb, now()) ON CONFLICT (key) DO UPDATE SET updated_at = now()");
    await new Promise((r) => setTimeout(r, 20));
    await grant(b.id);
    const repo = new TaskGrantRepo(db.pool);
    expect((await repo.revokeBeforeHaltedRow()).map((r) => r.rootId)).toEqual([a.id]);
    expect(await repo.live(b.id)).not.toBeNull();
    expect((await db.pool.query('SELECT revoke_reason FROM task_grants WHERE root_id = $1', [a.id])).rows[0]).toEqual({ revoke_reason: 'halt' });
  });

  it('supersedeAllTaskGrants retires unrevoked rows and their companions; the unique partial index refuses a second unrevoked row', async () => {
    const t = await newRoot();
    const w = await webGrant(t.id);
    await grant(t.id, { webGrantId: w });
    await expect(grant(t.id)).rejects.toThrow(/task_grants_one_live_idx/);
    await supersedeAllTaskGrants(db.pool, t.id, ADMIN);
    expect((await db.pool.query('SELECT revoke_reason FROM web_grants')).rows[0]).toEqual({ revoke_reason: 'superseded' });
    expect((await grant(t.id)).id).toBeGreaterThan(0);
    expect((await liveGrantOf(db.pool, t.id))?.maxCalls).toBe(40);
  });
});

describe('TG-C20: migration 035 constraints', () => {
  const bad = (sql: string, params: unknown[]) => expect(db.pool.query(sql, params)).rejects.toThrow();
  it('rejects a non-snowflake granter, caps out of range, expiry over 72 h, an inconsistent revoke and a non-object used_by_tool', async () => {
    const t = await newRoot();
    const ins = (over: Record<string, string>) => {
      const base: Record<string, string> = { granted_by: `'${ADMIN}'`, max_calls: '40', expires_at: "now() + interval '1 hour'", used: '0', used_by_tool: "'{}'::jsonb", revoked_at: 'NULL', revoke_reason: 'NULL', card_message_id: 'NULL', ...over };
      return approval(t.id).then((aid) => db.pool.query(
        `INSERT INTO task_grants (root_id, approval_id, granted_by, requested_by, max_calls, used, used_by_tool, expires_at, revoked_at, revoke_reason, card_message_id)
         VALUES ($1,$2,${base.granted_by},'head:hq',${base.max_calls},${base.used},${base.used_by_tool},${base.expires_at},${base.revoked_at},${base.revoke_reason},${base.card_message_id})`, [t.id, aid]));
    };
    await expect(ins({ granted_by: "'abc'" })).rejects.toThrow();
    await expect(ins({ max_calls: '0' })).rejects.toThrow();
    await expect(ins({ max_calls: '501' })).rejects.toThrow();
    await expect(ins({ used: '41' })).rejects.toThrow();
    await expect(ins({ expires_at: "now() + interval '73 hours'" })).rejects.toThrow();
    await expect(ins({ revoked_at: 'now()' })).rejects.toThrow();
    await expect(ins({ revoke_reason: "'admin'" })).rejects.toThrow();
    await expect(ins({ revoke_reason: "'bogus'", revoked_at: 'now()' })).rejects.toThrow();
    await expect(ins({ used_by_tool: "'[]'::jsonb" })).rejects.toThrow();
    await expect(ins({ card_message_id: "'12'" })).rejects.toThrow();
    await ins({ expires_at: "now() + interval '72 hours'" });
    void bad;
  });

  it('insertTaskGrant stores only snowflake card ids and the DB-clock expiry', async () => {
    const t = await newRoot();
    const g = await insertTaskGrant(db.pool, { rootId: t.id, approvalId: await approval(t.id), grantedBy: ADMIN, requestedBy: 'head:hq', maxCalls: 5, hours: 4, cardMessageId: MSG, cardChannelId: 'not-a-snowflake' });
    expect(g.cardMessageId).toBe(MSG);
    expect(g.cardChannelId).toBeNull();
    expect(CH).toHaveLength(18);
    expect(g.expiresAt.getTime() - g.createdAt.getTime()).toBe(4 * 3600_000);
  });
});
