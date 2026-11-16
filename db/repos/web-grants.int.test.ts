import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ActorRef } from '../../company/types.js';
import { migrate } from '../migrate.js';
import { freshDb, type TestDb } from '../test-helpers.js';
import { DepartmentRepo, TaskRepo } from './index.js';
import { IncidentReporter } from '../../core/incidents.js';
import { insertGrant, supersedeAll, WebGrantRepo } from './web-grants.js';

let db: TestDb;
let tasks: TaskRepo;
const hq: ActorRef = { kind: 'head', dept: 'hq' };
const ADMIN = '123456789012345678';

beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations'), 'up');
  await new DepartmentRepo(db.pool).upsert({ id: 'hq', name: 'HQ', categoryNamePattern: '', workChannelId: null, color: 0, model: null, provider: null, enabled: true });
  tasks = new TaskRepo(db.pool);
});
beforeEach(async () => {
  await db.pool.query('DELETE FROM web_grants');
  await db.pool.query('DELETE FROM approvals');
  await db.pool.query('DELETE FROM tasks');
});
afterAll(async () => { await db.close(); });

const newRoot = () => tasks.create({ title: 't', deptId: 'hq', owner: hq, requester: { kind: 'human', userId: '1' }, origin: 'chat' });
let seq = 0;
const approval = async (taskId: string): Promise<number> => {
  const r = await db.pool.query<{ id: number }>(
    `INSERT INTO approvals (task_id, reason, est_cost_usd, requested_by, kind, tool_name, tool_input, input_sha256) VALUES ($1,'r',0,'head:hq','tool','fetch_page',$2::jsonb,'x') RETURNING id`,
    [taskId, JSON.stringify({ url: `https://example.com/${++seq}` })],
  );
  return r.rows[0]!.id;
};
const grant = async (rootId: string, o: { maxFetches?: number; maxHosts?: number; maxUrlChars?: number; hours?: number } = {}) =>
  insertGrant(db.pool, { rootId, approvalId: await approval(rootId), grantedBy: ADMIN, requestedBy: 'head:hq', maxFetches: o.maxFetches ?? 20, maxHosts: o.maxHosts ?? 5, maxUrlChars: o.maxUrlChars ?? 4000, hours: o.hours ?? 4 });

describe('WebGrantRepo.consume (W-C12)', () => {
  it('50 concurrent consumes on max_fetches=40 give exactly 40 ok', async () => {
    const t = await newRoot();
    await grant(t.id, { maxFetches: 40, maxHosts: 10 });
    const repo = new WebGrantRepo(db.pool);
    const rs = await Promise.all(Array.from({ length: 50 }, () => repo.consume({ rootId: t.id, host: 'example.com', chars: 10 })));
    expect(rs.filter((r) => r.ok)).toHaveLength(40);
    expect(rs.filter((r) => !r.ok).every((r) => !r.ok && r.why === 'cap_fetches')).toBe(true);
    const g = await repo.live(t.id);
    expect(g).toBeNull(); // exhausted
    expect((await db.pool.query('SELECT used, url_chars_used FROM web_grants')).rows[0]).toEqual({ used: 40, url_chars_used: 400 });
  });

  it('11 concurrent distinct hosts on max_hosts=10 give exactly 10', async () => {
    const t = await newRoot();
    await grant(t.id, { maxFetches: 50, maxHosts: 10 });
    const repo = new WebGrantRepo(db.pool);
    const rs = await Promise.all(Array.from({ length: 11 }, (_, i) => repo.consume({ rootId: t.id, host: `h${i}.example.com`, chars: 5 })));
    expect(rs.filter((r) => r.ok)).toHaveLength(10);
    expect(rs.find((r) => !r.ok)).toEqual({ ok: false, why: 'cap_hosts' });
    // a known host still passes at the host cap
    expect((await repo.consume({ rootId: t.id, host: 'h3.example.com', chars: 5 })).ok).toBe(true);
  });

  it('the character budget is consumed atomically and refuses a fetch that would exceed it', async () => {
    const t = await newRoot();
    await grant(t.id, { maxUrlChars: 500 });
    const repo = new WebGrantRepo(db.pool);
    const rs = await Promise.all(Array.from({ length: 10 }, () => repo.consume({ rootId: t.id, host: 'example.com', chars: 100 })));
    expect(rs.filter((r) => r.ok)).toHaveLength(5);
    expect(rs.find((r) => !r.ok)).toEqual({ ok: false, why: 'cap_chars' });
    expect((await repo.consume({ rootId: t.id, host: 'example.com', chars: 0 })).ok).toBe(true); // 500 of 500 used: zero chars still fits
  });

  it('a done root, a cancelled root, an expired grant and a revoked grant each give not-ok; no grant gives none', async () => {
    const repo = new WebGrantRepo(db.pool);
    const a = await newRoot(); await grant(a.id);
    await db.pool.query("UPDATE tasks SET status = 'done' WHERE id = $1", [a.id]);
    expect(await repo.consume({ rootId: a.id, host: 'example.com', chars: 1 })).toEqual({ ok: false, why: 'root_ended' });
    const b = await newRoot(); await grant(b.id);
    await db.pool.query("UPDATE tasks SET status = 'cancelled' WHERE id = $1", [b.id]);
    expect(await repo.consume({ rootId: b.id, host: 'example.com', chars: 1 })).toEqual({ ok: false, why: 'root_ended' });
    const c = await newRoot(); await grant(c.id);
    await db.pool.query("UPDATE web_grants SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE root_id = $1", [c.id]);
    expect(await repo.consume({ rootId: c.id, host: 'example.com', chars: 1 })).toEqual({ ok: false, why: 'expired' });
    const d = await newRoot(); const g = await grant(d.id);
    expect(await repo.revoke(g.id, ADMIN, 'admin')).toBe(true);
    expect(await repo.revoke(g.id, ADMIN, 'admin')).toBe(false); // twice
    expect(await repo.consume({ rootId: d.id, host: 'example.com', chars: 1 })).toEqual({ ok: false, why: 'revoked' });
    const e = await newRoot();
    expect(await repo.consume({ rootId: e.id, host: 'example.com', chars: 1 })).toEqual({ ok: false, why: 'none' });
  });

  it('consume never throws: a pg error becomes why:error plus one fault report that carries no host', async () => {
    const faults: unknown[] = [];
    const broken = { query: async () => { throw new Error('connection reset'); } } as never;
    const repo = new WebGrantRepo(broken, { onFault: (e) => faults.push(e) });
    const r = await repo.consume({ rootId: 'x', host: 'secret-host.example.com', chars: 3 });
    expect(r).toEqual({ ok: false, why: 'error' });
    expect(faults).toHaveLength(1);
    expect(String((faults[0] as Error).message)).not.toContain('secret-host');
  });

  it('enabled=false at runtime: consume refuses on a live grant and spends nothing (W-C7); halted too (W-C3a)', async () => {
    const t = await newRoot();
    await grant(t.id);
    let gate: 'halted' | 'disabled' | null = 'disabled';
    const repo = new WebGrantRepo(db.pool, { gate: () => gate });
    expect(await repo.consume({ rootId: t.id, host: 'example.com', chars: 1 })).toEqual({ ok: false, why: 'disabled' });
    gate = 'halted';
    expect(await repo.consume({ rootId: t.id, host: 'example.com', chars: 1 })).toEqual({ ok: false, why: 'halted' });
    expect((await db.pool.query('SELECT used FROM web_grants')).rows[0]).toEqual({ used: 0 });
    const t0 = Date.now();
    while ((await repo.live(t.id)) !== null && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 10)); // the halted refusal retried the revoke
    expect(await repo.live(t.id)).toBeNull();
    gate = null;
    await grant((await newRoot()).id); // (a fresh grant on another tree, to keep the rest of the test meaningful)
    await db.pool.query('UPDATE web_grants SET revoked_at = NULL, revoked_by = NULL, revoke_reason = NULL WHERE root_id = $1', [t.id]);
    expect((await repo.consume({ rootId: t.id, host: 'example.com', chars: 1 })).ok).toBe(true);
  });
});

describe('G2W-01: a halt-revoke owed after a database outage', () => {
  it('outage -> read as halted -> revokeAll throws -> recovery: the next consume revokes first and returns not-ok (a card)', async () => {
    const t = await newRoot();
    await grant(t.id);
    let halted = true;
    let down = true;
    const flaky = { query: (...a: unknown[]) => (down ? Promise.reject(new Error('connection lost')) : (db.pool.query as (...x: unknown[]) => unknown)(...a)) } as never;
    const repo = new WebGrantRepo(flaky, { gate: () => (halted ? 'halted' : null) });
    expect(await repo.consume({ rootId: t.id, host: 'example.com', chars: 1 })).toEqual({ ok: false, why: 'halted' });
    await new Promise((r) => setTimeout(r, 50)); // the retry inside the halted refusal also failed: still unrevoked
    expect((await db.pool.query('SELECT revoked_at FROM web_grants')).rows[0].revoked_at).toBeNull();
    // the hook path (Halt.runHooks) failing is the same owed debt
    await expect(repo.revokeAll('halt')).rejects.toThrow();
    // recovery: the store reads healthy again with no row write, so the gate is open
    down = false;
    halted = false;
    expect(await repo.consume({ rootId: t.id, host: 'example.com', chars: 1 })).toEqual({ ok: false, why: 'revoked' });
    const row = (await db.pool.query('SELECT used, revoke_reason FROM web_grants')).rows[0];
    expect(row).toEqual({ used: 0, revoke_reason: 'halt' });
    // debt paid: a new grant on another tree works normally
    const u = await newRoot();
    await grant(u.id);
    expect((await repo.consume({ rootId: u.id, host: 'example.com', chars: 1 })).ok).toBe(true);
  });
});

describe('web grant fault reporting (W-C12 / W9, rule 19)', () => {
  it('a database fault becomes one #bot-log incident that carries neither the host nor the url, and the call falls back to a card', async () => {
    const posts: { title?: string; body: string }[] = [];
    const logged: unknown[] = [];
    const reporter = new IncidentReporter({
      port: { post: async (_a: unknown, _t: unknown, p: { title?: string; body: string }) => void posts.push(p) } as never,
      channelId: '1566454343820124352', log: { error: (o: unknown) => void logged.push(o), warn: () => undefined, info: () => undefined } as never, secrets: [], now: () => Date.now(),
    });
    const broken = { query: async () => { throw Object.assign(new Error('could not connect for host leak-host.example.com path /secret-path'), { code: '08006', detail: 'host leak-host.example.com' }); } } as never;
    const repo = new WebGrantRepo(broken, { onFault: (err) => void reporter.report({ source: 'web_grant', stage: 'consume', toolName: 'fetch_page', err }) });
    expect(await repo.consume({ rootId: 'r', host: 'leak-host.example.com', chars: 12 })).toEqual({ ok: false, why: 'error' });
    const t0 = Date.now();
    while (posts.length < 1 && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 10));
    expect(posts).toHaveLength(1);
    const all = JSON.stringify([posts, logged]);
    expect(all).toContain('web_grant');
    expect(all).toContain('consume');
    expect(all).toContain('08006');
    expect(all).not.toContain('leak-host');
    expect(all).not.toContain('secret-path');
  });
});

describe('WebGrantRepo grants', () => {
  it('grant after an expired/exhausted grant succeeds and the old row is superseded (W-C8)', async () => {
    const t = await newRoot();
    const old = await grant(t.id, { maxFetches: 1 });
    const repo = new WebGrantRepo(db.pool);
    expect((await repo.consume({ rootId: t.id, host: 'example.com', chars: 1 })).ok).toBe(true); // exhausted, still unrevoked
    // without superseding, the unique index refuses a second unrevoked row
    await expect(grant(t.id)).rejects.toThrow();
    const c = await db.pool.connect();
    try {
      await c.query('BEGIN');
      await supersedeAll(c, t.id, ADMIN);
      const g2 = await insertGrant(c, { rootId: t.id, approvalId: await approval(t.id), grantedBy: ADMIN, requestedBy: 'head:hq', maxFetches: 20, maxHosts: 5, maxUrlChars: 4000, hours: 4 });
      await c.query('COMMIT');
      expect(g2.id).not.toBe(old.id);
    } finally { c.release(); }
    expect((await db.pool.query('SELECT revoke_reason FROM web_grants WHERE id = $1', [old.id])).rows[0]).toEqual({ revoke_reason: 'superseded' });
    expect((await repo.live(t.id))?.used).toBe(0);
  });

  it('row CHECKs: expiry over 24 h, a bad grantor id and a cap overshoot are refused by the table', async () => {
    const t = await newRoot();
    await expect(grant(t.id, { hours: 25 })).rejects.toThrow(/web_grants_expiry/);
    await expect(insertGrant(db.pool, { rootId: t.id, approvalId: await approval(t.id), grantedBy: 'admin1', requestedBy: 'x', maxFetches: 1, maxHosts: 1, maxUrlChars: 500, hours: 1 })).rejects.toThrow();
    const g = await grant(t.id, { maxFetches: 1 });
    await expect(db.pool.query('UPDATE web_grants SET used = 2 WHERE id = $1', [g.id])).rejects.toThrow(/web_grants_used_cap/);
  });

  it('revokeAll and the boot revoke (W-C3c, W-C3d)', async () => {
    const repo = new WebGrantRepo(db.pool);
    const a = await newRoot(); await grant(a.id);
    const b = await newRoot(); await grant(b.id);
    expect(await repo.revokeAll('halt')).toBe(2);
    expect(await repo.live(a.id)).toBeNull();
    // boot: a grant older than the halted row's updated_at is revoked; a newer one is kept
    const c = await newRoot(); await grant(c.id);
    await db.pool.query("INSERT INTO config (key, value, updated_by) VALUES ('halted', 'false'::jsonb, 'test') ON CONFLICT (key) DO UPDATE SET updated_at = now()");
    const d = await newRoot(); await grant(d.id); // made after the halted row last changed
    expect(await repo.revokeBeforeHaltedRow()).toBe(1);
    expect(await repo.live(c.id)).toBeNull();
    expect(await repo.live(d.id)).not.toBeNull();
    expect((await db.pool.query("SELECT revoke_reason FROM web_grants WHERE root_id = $1", [c.id])).rows[0]).toEqual({ revoke_reason: 'halt' });
  });

  it('card message id is stored once and found by message (W-C11b)', async () => {
    const t = await newRoot();
    const g = await grant(t.id);
    const repo = new WebGrantRepo(db.pool);
    await repo.setCard(g.id, '111111111111111111');
    await repo.setCard(g.id, '222222222222222222');
    expect((await repo.unrevokedOfMessage('111111111111111111'))?.id).toBe(g.id);
    expect(await repo.unrevokedOfMessage('222222222222222222')).toBeNull();
    await repo.revoke(g.id, ADMIN, 'admin');
    expect(await repo.unrevokedOfMessage('111111111111111111')).toBeNull();
  });
});

describe('WebGrantRepo.revokeRoot (TASKADMIN-1, TA-C9/C22)', () => {
  it('revokes every unrevoked grant of the root with reason admin and returns their ids; other roots and revoked rows are untouched', async () => {
    const a = await newRoot();
    const b = await newRoot();
    const g2 = await grant(a.id);
    const repo = new WebGrantRepo(db.pool);
    expect(await repo.revoke(g2.id, ADMIN, 'superseded')).toBe(true); // one live grant per root: the first is already revoked
    const g1 = await grant(a.id);
    const gb = await grant(b.id);
    expect(await repo.revokeRoot(a.id, ADMIN)).toEqual([g1.id]);
    const rows = (await db.pool.query<{ id: number; revoke_reason: string; revoked_by: string }>('SELECT id, revoke_reason, revoked_by FROM web_grants ORDER BY id')).rows;
    expect(rows).toEqual([
      { id: g2.id, revoke_reason: 'superseded', revoked_by: ADMIN },
      { id: g1.id, revoke_reason: 'admin', revoked_by: ADMIN },
      { id: gb.id, revoke_reason: null, revoked_by: null },
    ]);
    expect(await repo.revokeRoot(a.id, ADMIN)).toEqual([]);
  });
});
