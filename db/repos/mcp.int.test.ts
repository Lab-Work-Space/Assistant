import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { configSha256 } from '../../mcp/snapshot.js';
import { migrate } from '../migrate.js';
import { freshDb, type TestDb } from '../test-helpers.js';
import { McpRepo, type McpRow, type StageIn } from './mcp.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const ADMIN = '900000000000000001';
const SHA = 'a'.repeat(64);
const SHA2 = 'b'.repeat(64);
const IMG = `sha256:${'c'.repeat(64)}`;
const TREE = '00000000-0000-4000-8000-000000000001';
const TOOL = { name: 'echo', description: 'd', inputSchema: { type: 'object' } };

let db: TestDb;
let repo: McpRepo;
beforeAll(async () => { db = await freshDb(); await migrate(db.pool, dir, 'up'); repo = new McpRepo(db.pool); });
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  for (const t of ['approvals', 'mcp_call_counts', 'mcp_server_depts', 'mcp_servers', 'audit_log', 'tasks']) await db.pool.query(`DELETE FROM ${t}`);
});

const stageIn = (slug: string, over: Partial<StageIn> = {}): StageIn => ({
  slug, title: `T ${slug}`, imageId: IMG, imageRef: 'x/y:1', command: [], env: {}, toolClass: 'write', timeoutMs: 60000, maxCallsPerDay: 100, snapshot: [TOOL], snapshotSha256: SHA, depts: ['software'], by: ADMIN, cfg12: 'abcdef012345', ...over,
});
const staged = async (slug: string, over: Partial<StageIn> = {}) => {
  const r = await repo.stage(stageIn(slug, over));
  if (!r.ok) throw new Error(`stage refused ${r.code}`);
  return r.id;
};
const ok = (_row: unknown) => 'abcdef012345';
const activate = (slug: string, sha = SHA, check: (r: McpRow) => string | null = ok) => repo.activate({ slug, snapshotSha256: sha, check, fullHash: configSha256, by: ADMIN });
const audits = async () => (await db.pool.query<{ actor: string; action: string; tool: string | null; outcome: string }>('SELECT actor, action, tool, outcome FROM audit_log ORDER BY id')).rows;
const statusOf = async (slug: string) => (await db.pool.query<{ status: string }>('SELECT status FROM mcp_servers WHERE slug = $1', [slug])).rows[0]?.status;

async function approvalRow(tool: string, status = 'pending', executed = false): Promise<number> {
  await db.pool.query("INSERT INTO departments (id, name) VALUES ('hq','hq') ON CONFLICT DO NOTHING");
  await db.pool.query("INSERT INTO tasks (id, title, dept_id, owner, requester, root_id, origin, tainted) VALUES ($1,'t','hq','{}','{}',$1,'chat',false) ON CONFLICT DO NOTHING", [TREE]);
  const r = await db.pool.query<{ id: number }>(
    `INSERT INTO approvals (task_id, reason, est_cost_usd, requested_by, kind, tool_name, tool_input, input_sha256, status, executed_at)
     VALUES ($1,'r',0,'head:praw','tool',$2,'{}'::jsonb,'x',$3, CASE WHEN $4::boolean THEN now() END) RETURNING id`, [TREE, tool, status, executed]);
  return r.rows[0]!.id;
}
const apStatus = async (id: number) => (await db.pool.query<{ status: string }>('SELECT status FROM approvals WHERE id = $1', [id])).rows[0]!.status;

describe('MCP-AC01 / MC-C17: migration 046 CHECKs', () => {
  const raw = (over: Record<string, unknown> = {}) => {
    const base: Record<string, unknown> = { slug: 'ab', title: 't', image_id: IMG, tool_class: 'write', snapshot: '[{"name":"x"}]', snapshot_sha256: SHA, added_by: ADMIN, ...over };
    const keys = Object.keys(base);
    return db.pool.query(`INSERT INTO mcp_servers (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`, keys.map((k) => base[k]));
  };
  it('the base row is valid; each CHECK refuses', async () => {
    await raw();
    await expect(raw({ slug: 'ab' })).rejects.toThrow(/duplicate|unique/i);
    await expect(raw({ slug: 'Ab' })).rejects.toThrow(/slug/);
    await expect(raw({ slug: 'a_b' })).rejects.toThrow(/slug/);
    await expect(raw({ slug: 'abcdefghijklmnopq' })).rejects.toThrow(/slug/);
    await expect(raw({ slug: 'cd', egress: 'proxy' })).rejects.toThrow(/mcp_servers_egress_check/);
    await expect(raw({ slug: 'cd', transport: 'http' })).rejects.toThrow(/mcp_servers_transport_check/);
    await expect(raw({ slug: 'cd', source: 'other', release_id: 1 })).rejects.toThrow(/mcp_servers_source_check/); // 048: 'release' is a legal source now (with a release_id and class write); any other value is refused
    await expect(raw({ slug: 'cd', source: 'release' })).rejects.toThrow(/mcp_servers_release/); // a release source needs its release_id
    await expect(raw({ slug: 'cd', release_id: 1 })).rejects.toThrow(/mcp_servers_release/);
    await expect(raw({ slug: 'cd', snapshot: JSON.stringify(Array.from({ length: 33 }, (_, i) => ({ name: `t${i}` }))) })).rejects.toThrow(/snapshot/);
    await expect(raw({ slug: 'cd', snapshot: '[]' })).rejects.toThrow(/snapshot/);
    await expect(raw({ slug: 'cd', status: 'active' })).rejects.toThrow(/mcp_servers_approved/);
    await expect(raw({ slug: 'cd', status: 'quarantined' })).rejects.toThrow(/mcp_servers_quarantined/);
    await expect(raw({ slug: 'cd', status: 'disabled' })).rejects.toThrow(/mcp_servers_disabled/);
    await expect(raw({ slug: 'cd', image_id: 'sha256:abc' })).rejects.toThrow(/image_id/);
    await expect(raw({ slug: 'cd', tool_class: 'admin' })).rejects.toThrow(/tool_class/);
    await expect(raw({ slug: 'cd', timeout_ms: 4000 })).rejects.toThrow(/timeout_ms/);
    await expect(raw({ slug: 'cd', max_calls_per_day: 1001 })).rejects.toThrow(/max_calls/);
    await expect(raw({ slug: 'cd', added_by: 'u' })).rejects.toThrow(/added_by/);
    await expect(raw({ slug: 'cd', command: '{}' })).rejects.toThrow(/command/);
    await expect(raw({ slug: 'cd', env: '[]' })).rejects.toThrow(/env/);
    await expect(raw({ slug: 'cd', status: 'active', approved_by: ADMIN, approved_at: new Date() })).rejects.toThrow(/mcp_servers_pin/); // 047: active needs the pin
    await expect(raw({ slug: 'cd', approved_config_sha256: 'abc' })).rejects.toThrow(/mcp_servers_approved_config_sha256_check/);
    await expect(raw({ slug: 'cd', approved_config_sha256: 'A'.repeat(64) })).rejects.toThrow(/mcp_servers_approved_config_sha256_check/);
    await expect(raw({ slug: 'cd', status: 'quarantined', quarantine_reason: 'other', quarantined_at: new Date() })).rejects.toThrow(/quarantine_reason/);
    await raw({ slug: 'gh', status: 'quarantined', quarantine_reason: 'config_changed', quarantined_at: new Date() });
    await raw({ slug: 'ef', status: 'active', approved_by: ADMIN, approved_at: new Date(), approved_config_sha256: 'f'.repeat(64) });
  });
  it('dept grants and counters are checked', async () => {
    const id = await staged('ab');
    await expect(db.pool.query("INSERT INTO mcp_server_depts (server_id, dept_id, granted_by) VALUES ($1,'Bad','900000000000000001')", [id])).rejects.toThrow(/dept_id/);
    await expect(db.pool.query("INSERT INTO mcp_server_depts (server_id, dept_id, granted_by) VALUES (999,'software','900000000000000001')")).rejects.toThrow(/foreign key/i);
    await expect(db.pool.query("INSERT INTO mcp_call_counts (scope, scope_key, used) VALUES ('tree','x',1)")).rejects.toThrow(/mcp_call_counts/);
    await expect(db.pool.query("INSERT INTO mcp_call_counts (scope, scope_key, used) VALUES ('day','2026-11-12',-1)")).rejects.toThrow(/mcp_call_counts/);
    await expect(db.pool.query("INSERT INTO mcp_call_counts (scope, scope_key, used) VALUES ('server_day','Ab:2026-11-12',1)")).rejects.toThrow(/mcp_call_counts/);
    await db.pool.query("INSERT INTO mcp_call_counts (scope, scope_key, used) VALUES ('server_day','ab:2026-11-12',1)");
    await db.pool.query('DELETE FROM mcp_servers');
    expect((await db.pool.query('SELECT count(*)::int AS n FROM mcp_server_depts')).rows[0]).toEqual({ n: 0 }); // cascade
  });
  it('up, down, up again; down also removes the three config keys', async () => {
    await db.pool.query("INSERT INTO config (key, value) VALUES ('mcp.enabled','true'::jsonb), ('mcp.maxCallsPerTree','5'::jsonb)");
    await migrate(db.pool, dir, 'down');
    const t = async () => (await db.pool.query<{ t: string }>("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = current_schema() AND table_name LIKE 'mcp\\_%'")).rows;
    expect(await t()).toEqual([]);
    await migrate(db.pool, dir, 'up');
    expect((await t()).map((r) => r.t).sort()).toEqual(['mcp_call_counts', 'mcp_server_depts', 'mcp_servers']);
    await db.pool.query("DELETE FROM config WHERE key LIKE 'mcp.%'");
  });
});

describe('McpRepo.stage (add and re-add)', () => {
  it('creates a pending row with its depts and a throwing audit row in the same transaction', async () => {
    const id = await staged('ab', { depts: ['software', 'sales'] });
    const row = (await repo.get('ab'))!;
    expect(row).toMatchObject({ id, slug: 'ab', status: 'pending', imageId: IMG, toolClass: 'write', command: [], env: {}, snapshotSha256: SHA, source: 'admin', releaseId: null, addedBy: ADMIN, approvedBy: null });
    expect(row.depts).toEqual(['sales', 'software']);
    expect(await audits()).toEqual([{ actor: `user:${ADMIN}`, action: 'mcp.add', tool: null, outcome: 'pending ab abcdef012345 1' }]);
  });
  it('a pending or active slug is E_EXISTS; a quarantined or disabled one is re-added with the approval, quarantine and disable columns cleared', async () => {
    await staged('ab');
    expect(await repo.stage(stageIn('ab'))).toEqual({ ok: false, code: 'E_EXISTS' });
    expect(await activate('ab')).toMatchObject({ ok: true });
    expect(await repo.stage(stageIn('ab'))).toEqual({ ok: false, code: 'E_EXISTS' });
    expect(await repo.quarantine({ id: (await repo.get('ab'))!.id, slug: 'ab', snapshotSha256: SHA })).toMatchObject({ ok: true });
    await staged('ab', { snapshot: [TOOL, { ...TOOL, name: 'two' }], snapshotSha256: SHA2, depts: ['sales'], toolClass: 'read' });
    const row = (await repo.get('ab'))!;
    expect(row).toMatchObject({ status: 'pending', toolClass: 'read', snapshotSha256: SHA2, approvedBy: null, approvedAt: null, quarantineReason: null, quarantinedAt: null, disabledBy: null, disabledAt: null });
    expect(row.depts).toEqual(['sales']);
    expect(await repo.disable('ab', ADMIN)).toMatchObject({ ok: true });
    await staged('ab');
    expect(await statusOf('ab')).toBe('pending');
  });
  it('at most 8 rows are pending or active; a re-add counts like a new row, a disabled row does not', async () => {
    for (let i = 0; i < 8; i++) await staged(`s${i}x`);
    expect(await repo.stage(stageIn('extra'))).toEqual({ ok: false, code: 'E_MAX_SERVERS' });
    await repo.disable('s0x', ADMIN);
    await staged('extra');
    expect(await repo.stage(stageIn('s0x'))).toEqual({ ok: false, code: 'E_MAX_SERVERS' });
  });
  it('a re-add also expires open tool approvals of both classes for that slug (defence in depth: an approval filed in a race), and returns their ids', async () => {
    await staged('ab');
    await activate('ab');
    await repo.disable('ab', ADMIN);
    const [w, r, other] = [await approvalRow('mcp_w_ab_echo'), await approvalRow('mcp_r_ab_x'), await approvalRow('mcp_w_abc_echo')];
    const s = await repo.stage(stageIn('ab'));
    expect(s.ok && [...s.expired].sort((x, y) => x - y)).toEqual([w, r].sort((x, y) => x - y));
    expect([await apStatus(w), await apStatus(r), await apStatus(other)]).toEqual(['expired', 'expired', 'pending']);
  });
});

describe('McpRepo.activate (MC-C8: lock, compare-and-set, full-config token)', () => {
  it('sets active with approved_by and approved_at, audits, and refuses a wrong token, a changed snapshot and a non-pending row', async () => {
    await staged('ab');
    expect(await activate('ab', SHA2)).toEqual({ ok: false, code: 'E_CHANGED' });
    expect(await activate('ab', SHA, () => null)).toEqual({ ok: false, code: 'E_HASH' });
    expect(await statusOf('ab')).toBe('pending');
    expect(await activate('ab')).toEqual({ ok: true, cfg12: 'abcdef012345' });
    expect(await repo.get('ab')).toMatchObject({ status: 'active', approvedBy: ADMIN });
    expect((await repo.get('ab'))!.approvedAt).toBeInstanceOf(Date);
    expect(await activate('ab')).toEqual({ ok: false, code: 'E_STATE' });
    expect(await activate('zz')).toEqual({ ok: false, code: 'E_STATE' });
    expect((await audits()).map((a) => `${a.action} ${a.outcome}`)).toEqual(['mcp.add pending ab abcdef012345 1', 'mcp.approve active ab abcdef012345']);
  });
  it('the check function sees the locked row with its depts read on the same transaction', async () => {
    await staged('ab', { depts: ['software', 'sales'] });
    let seen: unknown = null;
    await repo.activate({ slug: 'ab', snapshotSha256: SHA, by: ADMIN, fullHash: configSha256, check: (r) => { seen = { depts: r.depts, env: r.env, cls: r.toolClass }; return 'abcdef012345'; } });
    expect(seen).toEqual({ depts: ['sales', 'software'], env: {}, cls: 'write' });
  });
  it('8 active at most: a pending row that got past stage (a direct SQL insert) cannot be approved as the ninth', async () => {
    for (let i = 0; i < 8; i++) { await staged(`s${i}x`); expect(await activate(`s${i}x`)).toMatchObject({ ok: true }); }
    await db.pool.query("INSERT INTO mcp_servers (slug, title, image_id, tool_class, snapshot, snapshot_sha256, added_by) VALUES ('nine','t',$1,'read','[{\"name\":\"x\"}]',$2,$3)", [IMG, SHA, ADMIN]);
    expect(await activate('nine')).toEqual({ ok: false, code: 'E_MAX_SERVERS' });
    expect(await statusOf('nine')).toBe('pending');
  });
  it('two concurrent approvals of the same row: exactly one wins', async () => {
    await staged('ab');
    const rs = await Promise.all([activate('ab'), activate('ab')]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect((await audits()).filter((a) => a.action === 'mcp.approve')).toHaveLength(1);
  });
});

describe('McpRepo.quarantine and disable (MC-C8: CAS and expiry in the same transaction)', () => {
  it('quarantine is a CAS on (id, active, snapshot hash): a stale call changes nothing and writes no audit row', async () => {
    const id = await staged('ab');
    await activate('ab');
    expect(await repo.quarantine({ id, slug: 'ab', snapshotSha256: SHA2 })).toEqual({ ok: false });
    expect(await statusOf('ab')).toBe('active');
    expect((await audits()).filter((a) => a.action === 'mcp.quarantine')).toHaveLength(0);
    expect(await repo.quarantine({ id, slug: 'ab', snapshotSha256: SHA })).toEqual({ ok: true, expired: [] });
    expect(await repo.get('ab')).toMatchObject({ status: 'quarantined', quarantineReason: 'snapshot_changed' });
    expect(await repo.quarantine({ id, slug: 'ab', snapshotSha256: SHA })).toEqual({ ok: false });
    expect((await audits()).filter((a) => a.action === 'mcp.quarantine')).toEqual([{ actor: 'system:mcp', action: 'mcp.quarantine', tool: null, outcome: 'ab snapshot_changed' }]);
  });
  it('a stale quarantine cannot hit a freshly re-approved row with another snapshot', async () => {
    const id = await staged('ab');
    await activate('ab');
    await repo.disable('ab', ADMIN);
    await staged('ab', { snapshotSha256: SHA2 });
    await activate('ab', SHA2);
    expect(await repo.quarantine({ id, slug: 'ab', snapshotSha256: SHA })).toEqual({ ok: false });
    expect(await statusOf('ab')).toBe('active');
  });
  it('leaving active expires open tool approvals for both prefixes of that slug (pending, and approved but not executed) and returns their ids; other slugs and other kinds are untouched', async () => {
    const id = await staged('ab');
    await staged('abc');
    await activate('ab');
    await activate('abc');
    const [w, r, ap, ex, other, similar, nonTool] = [
      await approvalRow('mcp_w_ab_echo'), await approvalRow('mcp_r_ab_x'), await approvalRow('mcp_w_ab_y', 'approved'), await approvalRow('mcp_w_ab_z', 'approved', true),
      await approvalRow('mcp_w_abc_echo'), await approvalRow('mcp_wXab_echo'), await approvalRow('write_file'),
    ];
    const q = await repo.quarantine({ id, slug: 'ab', snapshotSha256: SHA });
    expect(q).toMatchObject({ ok: true });
    expect([...(q as { expired: number[] }).expired].sort((a, b) => a - b)).toEqual([w, r, ap].sort((a, b) => a - b));
    expect([await apStatus(w), await apStatus(r), await apStatus(ap), await apStatus(ex)]).toEqual(['expired', 'expired', 'expired', 'approved']);
    expect([await apStatus(other), await apStatus(similar), await apStatus(nonTool)]).toEqual(['pending', 'pending', 'pending']);
    const w2 = await approvalRow('mcp_w_abc_two');
    const d = await repo.disable('abc', ADMIN);
    expect(d).toMatchObject({ ok: true });
    expect((d as { expired: number[] }).expired.sort((a, b) => a - b)).toEqual([other, w2].sort((a, b) => a - b));
  });
  it('the expiry and the state change are one transaction: a failing audit insert rolls both back', async () => {
    const id = await staged('ab');
    await activate('ab');
    const w = await approvalRow('mcp_w_ab_echo');
    await db.pool.query("ALTER TABLE audit_log ADD CONSTRAINT audit_block CHECK (action <> 'mcp.quarantine')");
    try {
      await expect(repo.quarantine({ id, slug: 'ab', snapshotSha256: SHA })).rejects.toThrow(/audit_block/);
      expect(await statusOf('ab')).toBe('active');
      expect(await apStatus(w)).toBe('pending');
    } finally {
      await db.pool.query('ALTER TABLE audit_log DROP CONSTRAINT audit_block');
    }
  });
  it('disable: allowed from pending, active and quarantined, E_STATE when already disabled or unknown; clears the quarantine columns', async () => {
    const id = await staged('ab');
    expect(await repo.disable('ab', ADMIN)).toMatchObject({ ok: true });
    expect(await repo.disable('ab', ADMIN)).toEqual({ ok: false, code: 'E_STATE' });
    expect(await repo.disable('zz', ADMIN)).toEqual({ ok: false, code: 'E_STATE' });
    await staged('ab');
    await activate('ab');
    await repo.quarantine({ id, slug: 'ab', snapshotSha256: SHA });
    expect(await repo.disable('ab', ADMIN)).toMatchObject({ ok: true });
    expect(await repo.get('ab')).toMatchObject({ status: 'disabled', disabledBy: ADMIN, quarantineReason: null, quarantinedAt: null });
    expect((await audits()).filter((a) => a.action === 'mcp.disable').map((a) => a.outcome)).toEqual(['ab', 'ab']);
  });
});

const pinOf = async (slug: string) => (await db.pool.query<{ p: string | null }>('SELECT approved_config_sha256 AS p FROM mcp_servers WHERE slug = $1', [slug])).rows[0]!.p;

describe('047 pin: approve stores it, depts rewrites it, re-add clears it, quarantine takes a reason', () => {
  it('approve stores the full hash of the locked row in the approve transaction; pending rows hold none', async () => {
    await staged('ab', { depts: ['software', 'sales'] });
    expect(await pinOf('ab')).toBeNull();
    expect(await activate('ab')).toMatchObject({ ok: true });
    const row = (await repo.get('ab'))!;
    expect(row.approvedConfigSha256).toBe(configSha256(row));
    expect(row.approvedConfigSha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it('a refused approve (E_HASH) stores nothing', async () => {
    await staged('ab');
    expect(await activate('ab', SHA, () => null)).toEqual({ ok: false, code: 'E_HASH' });
    expect(await pinOf('ab')).toBeNull();
  });
  it('setDepts on an active row rewrites the pin to the new grants; on a pending row it leaves it NULL', async () => {
    await staged('ab', { depts: ['software'] });
    await repo.setDepts('ab', ['sales'], ADMIN, configSha256);
    expect(await pinOf('ab')).toBeNull();
    await activate('ab');
    const before = await pinOf('ab');
    expect(await repo.setDepts('ab', ['hq', 'sales'], ADMIN, configSha256)).toEqual({ ok: true });
    const row = (await repo.get('ab'))!;
    expect(row.approvedConfigSha256).not.toBe(before);
    expect(row.approvedConfigSha256).toBe(configSha256(row));
  });
  it('setDepts refuses (E_STATE, nothing written) an active row edited behind the approval: it never re-blesses a tampered row', async () => {
    await staged('ab');
    await activate('ab');
    await db.pool.query('UPDATE mcp_servers SET image_id = $2 WHERE slug = $1', ['ab', `sha256:${'d'.repeat(64)}`]);
    const pin = await pinOf('ab');
    const n = (await audits()).length;
    expect(await repo.setDepts('ab', ['sales'], ADMIN, configSha256)).toEqual({ ok: false, code: 'E_STATE' });
    expect(await pinOf('ab')).toBe(pin);
    expect((await repo.get('ab'))!.depts).toEqual(['software']);
    expect((await audits()).length).toBe(n);
  });
  it('re-add clears the pin', async () => {
    await staged('ab');
    await activate('ab');
    const row = (await repo.get('ab'))!;
    await repo.quarantine({ id: row.id, slug: 'ab', snapshotSha256: SHA });
    await staged('ab');
    expect(await pinOf('ab')).toBeNull();
    expect(await statusOf('ab')).toBe('pending');
  });
  it('quarantine with the reason config_changed: column, audit outcome and CAS; the default stays snapshot_changed', async () => {
    const id = await staged('ab');
    await activate('ab');
    expect(await repo.quarantine({ id, slug: 'ab', snapshotSha256: SHA2, reason: 'config_changed' })).toEqual({ ok: false });
    expect(await repo.quarantine({ id, slug: 'ab', snapshotSha256: SHA, reason: 'config_changed' })).toEqual({ ok: true, expired: [] });
    expect((await repo.get('ab'))!.quarantineReason).toBe('config_changed');
    expect((await audits()).pop()).toEqual({ actor: 'system:mcp', action: 'mcp.quarantine', tool: null, outcome: 'ab config_changed' });
    const id2 = await staged('cd');
    await activate('cd');
    await repo.quarantine({ id: id2, slug: 'cd', snapshotSha256: SHA });
    expect((await repo.get('cd'))!.quarantineReason).toBe('snapshot_changed');
  });
});

describe('G2-MCP-R4 (048): leaving active clears the approval and the pin', () => {
  const approval = async (slug: string) => (await db.pool.query<{ approved_by: string | null; approved_at: Date | null; approved_config_sha256: string | null }>('SELECT approved_by, approved_at, approved_config_sha256 FROM mcp_servers WHERE slug = $1', [slug])).rows[0]!;
  const cleared = { approved_by: null, approved_at: null, approved_config_sha256: null };
  it('quarantine clears approved_by, approved_at and the pin', async () => {
    const id = await staged('ab');
    await activate('ab');
    expect((await approval('ab')).approved_config_sha256).not.toBeNull();
    expect(await repo.quarantine({ id, slug: 'ab', snapshotSha256: SHA })).toMatchObject({ ok: true });
    expect(await approval('ab')).toEqual(cleared);
  });
  it('disable clears them from active and from quarantined; the DB refuses a pin on a non-active row', async () => {
    const id = await staged('ab');
    await activate('ab');
    expect(await repo.disable('ab', ADMIN)).toMatchObject({ ok: true });
    expect(await approval('ab')).toEqual(cleared);
    await staged('ab');
    await activate('ab');
    await repo.quarantine({ id, slug: 'ab', snapshotSha256: SHA });
    expect(await repo.disable('ab', ADMIN)).toMatchObject({ ok: true });
    expect(await approval('ab')).toEqual(cleared);
    await expect(db.pool.query("UPDATE mcp_servers SET approved_config_sha256 = $1 WHERE slug = 'ab'", ['f'.repeat(64)])).rejects.toThrow(/mcp_servers_pin/);
  });
});

describe('McpRepo.setDepts, reads', () => {
  it('replaces the grants in one transaction and audits the count; E_STATE for an unknown slug', async () => {
    await staged('ab', { depts: ['software'] });
    expect(await repo.setDepts('ab', ['sales', 'hq', 'sales'], ADMIN, configSha256)).toEqual({ ok: true });
    expect((await repo.get('ab'))!.depts).toEqual(['hq', 'sales']);
    expect(await repo.setDepts('zz', ['sales'], ADMIN, configSha256)).toEqual({ ok: false, code: 'E_STATE' });
    expect((await audits()).pop()).toMatchObject({ action: 'mcp.depts', outcome: 'ab 2' });
  });
  it('list omits the snapshot; activeRows holds only active rows with snapshot and depts', async () => {
    await staged('ab');
    await staged('cd');
    await activate('cd');
    expect((await repo.list()).map((r) => [r.slug, r.status, r.tools])).toEqual([['ab', 'pending', 1], ['cd', 'active', 1]]);
    expect('snapshot' in (await repo.list())[0]!).toBe(false);
    const a = await repo.activeRows();
    expect(a.map((r) => r.slug)).toEqual(['cd']);
    expect(a[0]!.snapshot).toEqual([TOOL]);
    expect(a[0]!.depts).toEqual(['software']);
    expect(await repo.get('zz')).toBeNull();
    expect(await repo.get('A b')).toBeNull();
  });
});

describe('McpRepo.claim (MC-C13: claim first, counters and the start row in one transaction)', () => {
  const c = (over: Partial<Parameters<McpRepo['claim']>[0]> = {}) => repo.claim({ treeKey: TREE, dayKey: '2026-11-12', slug: 'ab', treeCap: 2, dayCap: 5, serverCap: 3, actor: 'head:praw', tool: 'mcp_r_ab_echo', taskId: null, ...over });
  const used = async () => (await db.pool.query<{ scope: string; scope_key: string; used: number }>('SELECT scope, scope_key, used FROM mcp_call_counts ORDER BY scope')).rows;
  it('counts tree, day and server_day, and writes the start row', async () => {
    expect(await c()).toBe('ok');
    expect(await used()).toEqual([{ scope: 'day', scope_key: '2026-11-12', used: 1 }, { scope: 'server_day', scope_key: 'ab:2026-11-12', used: 1 }, { scope: 'tree', scope_key: TREE, used: 1 }]);
    expect(await audits()).toEqual([{ actor: 'head:praw', action: 'mcp.call', tool: 'mcp_r_ab_echo', outcome: 'start' }]);
  });
  it('a cap rolls everything back: no counter moves and no start row exists', async () => {
    await c(); await c();
    expect(await c()).toBe('tree');
    expect((await used()).map((u) => u.used)).toEqual([2, 2, 2]);
    expect(await audits()).toHaveLength(2);
    expect(await c({ treeKey: null, dayCap: 2 })).toBe('day');
    expect(await c({ treeKey: null, dayCap: 9, serverCap: 2 })).toBe('server');
    expect((await used()).map((u) => u.used)).toEqual([2, 2, 2]);
    expect(await audits()).toHaveLength(2);
  });
  it('no task: the tree scope is skipped', async () => {
    expect(await c({ treeKey: null })).toBe('ok');
    expect((await used()).map((u) => u.scope)).toEqual(['day', 'server_day']);
  });
  it('a failing start-row insert rolls the counters back (no claim without its row)', async () => {
    await db.pool.query("ALTER TABLE audit_log ADD CONSTRAINT audit_block CHECK (action <> 'mcp.call')");
    try {
      await expect(c()).rejects.toThrow(/audit_block/);
      expect(await used()).toEqual([]);
    } finally {
      await db.pool.query('ALTER TABLE audit_log DROP CONSTRAINT audit_block');
    }
  });
  it('concurrent claims never exceed a cap', async () => {
    const rs = await Promise.all(Array.from({ length: 8 }, () => c({ treeKey: null, dayCap: 3, serverCap: 9 })));
    expect(rs.filter((r) => r === 'ok')).toHaveLength(3);
    expect((await used()).find((u) => u.scope === 'day')!.used).toBe(3);
  });
  it('bad caps or keys are refused before any write', async () => {
    expect(await c({ dayCap: 0 })).toBe('day');
    expect(await c({ treeCap: 1.5 })).toBe('tree');
    await expect(c({ dayKey: 'tomorrow' })).rejects.toThrow();
    expect(await used()).toEqual([]);
  });
});

describe('R6 BE3: leaving active also takes the waiting task out of awaiting_approval (the expireOld path)', () => {
  const taskStatus = async (id: string) => (await db.pool.query<{ status: string; awaiting_approval_id: number | null }>('SELECT status, awaiting_approval_id FROM tasks WHERE id = $1', [id])).rows[0]!;
  const wait = async (taskId: string, approvalId: number) => { await db.pool.query("UPDATE tasks SET status = 'awaiting_approval', awaiting_approval_id = $2 WHERE id = $1", [taskId, approvalId]); };
  it('quarantine cancels the task waiting on the expired approval, in the same transaction, and reports it after commit; a task waiting on another approval is untouched', async () => {
    const moved: { id: string; from: string; to: string }[] = [];
    const r2 = new McpRepo(db.pool, { onTasksMoved: async (cs) => { for (const c of cs) moved.push({ id: c.task.id, from: c.from, to: c.task.status }); } });
    const st = await r2.stage(stageIn('ab'));
    if (!st.ok) throw new Error('stage');
    await r2.activate({ slug: 'ab', snapshotSha256: SHA, check: ok, fullHash: configSha256, by: ADMIN });
    const w = await approvalRow('mcp_w_ab_echo');
    await wait(TREE, w);
    const q = await r2.quarantine({ id: st.id, slug: 'ab', snapshotSha256: SHA });
    expect(q).toMatchObject({ ok: true });
    expect(await taskStatus(TREE)).toEqual({ status: 'cancelled', awaiting_approval_id: null });
    expect(moved).toEqual([{ id: TREE, from: 'awaiting_approval', to: 'cancelled' }]);
  });
  it('disable and re-add do the same; a task that waits on a non-MCP approval stays', async () => {
    await staged('ab');
    await activate('ab');
    const w = await approvalRow('mcp_w_ab_echo');
    await wait(TREE, w);
    expect(await repo.disable('ab', ADMIN)).toMatchObject({ ok: true });
    expect((await taskStatus(TREE)).status).toBe('cancelled');
    await db.pool.query("UPDATE tasks SET status = 'awaiting_approval', awaiting_approval_id = NULL WHERE id = $1", [TREE]);
    const other = await approvalRow('write_file');
    await wait(TREE, other);
    await staged('ab');
    expect((await taskStatus(TREE)).status).toBe('awaiting_approval');
  });
  it('a failing audit rolls the task move back with the rest, and nothing is reported', async () => {
    const moved: unknown[] = [];
    const r2 = new McpRepo(db.pool, { onTasksMoved: async (cs) => void moved.push(cs) });
    const st = await r2.stage(stageIn('ab'));
    if (!st.ok) throw new Error('stage');
    await r2.activate({ slug: 'ab', snapshotSha256: SHA, check: ok, fullHash: configSha256, by: ADMIN });
    const w = await approvalRow('mcp_w_ab_echo');
    await wait(TREE, w);
    await db.pool.query("ALTER TABLE audit_log ADD CONSTRAINT zz_fail CHECK (action <> 'mcp.quarantine') NOT VALID");
    try {
      await expect(r2.quarantine({ id: st.id, slug: 'ab', snapshotSha256: SHA })).rejects.toThrow();
    } finally {
      await db.pool.query('ALTER TABLE audit_log DROP CONSTRAINT zz_fail');
    }
    expect((await taskStatus(TREE)).status).toBe('awaiting_approval');
    expect(moved).toEqual([]);
  });
});

describe('G2-MCP-07: expire takes the sorted root lock first (root -> approval rows), like expireOld', () => {
  it('while another transaction holds the root of the waiting task, disable waits on the ROOT and has not locked the approval row; it finishes after the root is released', async () => {
    await staged('ab');
    await activate('ab');
    const w = await approvalRow('mcp_w_ab_echo');
    const root = (await db.pool.query<{ root_id: string }>('SELECT root_id FROM tasks WHERE id = $1', [TREE])).rows[0]!.root_id;
    const holder = await db.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM tasks WHERE id = $1 FOR UPDATE', [root]);
      let done = false;
      const p = repo.disable('ab', ADMIN).then((r) => { done = true; return r; });
      await new Promise((r) => setTimeout(r, 300));
      expect(done).toBe(false);
      const probe = await db.pool.connect();
      try {
        await probe.query('BEGIN');
        await probe.query('SELECT id FROM approvals WHERE id = $1 FOR UPDATE NOWAIT', [w]); // would throw (55P03) if the expire had already locked the approval row before the root
        await probe.query('ROLLBACK');
      } finally { probe.release(); }
      await holder.query('COMMIT');
      expect(await p).toMatchObject({ ok: true, expired: [w] });
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  });
});
