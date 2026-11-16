import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../migrate.js';
import { freshDb, type TestDb } from '../test-helpers.js';
import { McpRepo, type StageIn } from './mcp.js';
import { ADMIN, ADMIN2, IMG, newBuild, newForge, newRelease, newServer, resetForgeTables } from './forge-test-helpers.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const SHA = 'a'.repeat(64);
const TOOL = { name: 'echo', description: 'd', inputSchema: { type: 'object' } };
let db: TestDb;
let repo: McpRepo;
beforeAll(async () => { db = await freshDb(); await migrate(db.pool, dir, 'up'); repo = new McpRepo(db.pool); });
afterAll(async () => { await db.close(); });
beforeEach(async () => { await resetForgeTables(db.pool); });

const audits = async () => (await db.pool.query<{ actor: string; action: string; outcome: string }>('SELECT actor, action, outcome FROM audit_log ORDER BY id')).rows;
const row = async (slug: string) => (await db.pool.query<{ source: string; release_id: number | null; added_by: string; status: string; image_id: string }>('SELECT source, release_id, added_by, status, image_id FROM mcp_servers WHERE slug = $1', [slug])).rows[0];
/** A forge with an approved release and a build that is `building` on IMG (what the builder holds when it calls stage). */
async function ready(o: { forge?: Parameters<typeof newForge>[1]; release?: Partial<Parameters<typeof newRelease>[1]>; build?: Partial<Parameters<typeof newBuild>[1]> } = {}) {
  const f = await newForge(db.pool, o.forge);
  const rel = await newRelease(db.pool, { forgeId: f.forgeId, projectId: f.projectId, ...o.release });
  const b = await newBuild(db.pool, { forgeId: f.forgeId, releaseId: rel, status: 'building', imageId: IMG, ...o.build });
  return { f, rel, b };
}
const stageIn = (rel: number, over: Partial<StageIn> = {}): StageIn => ({
  slug: 'hello', title: 'Hello', imageId: IMG, imageRef: null, command: [], env: {}, toolClass: 'write', timeoutMs: 60000, maxCallsPerDay: 100, snapshot: [TOOL], snapshotSha256: SHA, depts: ['software'], by: ADMIN, cfg12: 'abcdef012345',
  source: 'release', releaseId: rel, ...over,
});

describe('R7 PF-C9: McpRepo.stage with source release is bound to a real approved release, its building build and its live forge', () => {
  it('stages a pending release-sourced row with added_by = decided_by, the dept grant and the system:forge audit row', async () => {
    const { rel } = await ready();
    const r = await repo.stage(stageIn(rel));
    expect(r).toMatchObject({ ok: true });
    expect(await row('hello')).toEqual({ source: 'release', release_id: rel, added_by: ADMIN, status: 'pending', image_id: IMG });
    expect((await db.pool.query('SELECT dept_id FROM mcp_server_depts')).rows).toEqual([{ dept_id: 'software' }]);
    expect(await audits()).toEqual([{ actor: 'system:forge', action: 'mcp.add', outcome: `pending hello abcdef012345 1 release:#${rel}` }]);
  });
  const refused: [string, () => Promise<{ rel: number; over?: Partial<StageIn> }>][] = [
    ['a release that is pending', async () => ({ rel: (await ready({ release: { status: 'pending' } })).rel })],
    ['a release that failed', async () => ({ rel: (await ready({ release: { status: 'failed' } })).rel })],
    ['a release that was rejected', async () => ({ rel: (await ready({ release: { status: 'rejected' } })).rel })],
    ['an unknown release id', async () => ({ rel: 999999 })],
    ['another deciding admin', async () => ({ rel: (await ready()).rel, over: { by: ADMIN2 } })],
    ['a build that recorded another deciding admin', async () => ({ rel: (await ready({ build: { decidedBy: ADMIN2 } })).rel })],
    ['another slug than the release', async () => ({ rel: (await ready()).rel, over: { slug: 'other' } })],
    ['a build whose slug differs from the release', async () => ({ rel: (await ready({ build: { slug: 'other' } })).rel })],
    ['a build whose sha256 differs from the release', async () => ({ rel: (await ready({ build: { sha: 'f'.repeat(64) } })).rel })],
    ['a build that is queued, not building', async () => ({ rel: (await ready({ build: { status: 'queued', imageId: null } })).rel })],
    ['a build that is already staged', async () => ({ rel: (await ready({ build: { status: 'staged' } })).rel })],
    ['another image than the one the build recorded (PF-C5)', async () => ({ rel: (await ready()).rel, over: { imageId: `sha256:${'9'.repeat(64)}` } })],
    ['a build with no recorded image', async () => ({ rel: (await ready({ build: { imageId: null } })).rel })],
    ['a forge that is not live (cancelled while the build ran)', async () => ({ rel: (await ready({ forge: { status: 'cancelled' } })).rel })],
    ['a forge that is already staged', async () => ({ rel: (await ready({ forge: { status: 'staged', serverId: await newServer(db.pool, { slug: 'zz' }) } })).rel })],
    ['a project that is no longer active', async () => ({ rel: (await ready({ forge: { projectStatus: 'done' } })).rel })],
    ['a department other than the forge department', async () => ({ rel: (await ready()).rel, over: { depts: ['hq'] } })],
    ['more than the forge department', async () => ({ rel: (await ready()).rel, over: { depts: ['software', 'hq'] } })],
    ['class read', async () => ({ rel: (await ready()).rel, over: { toolClass: 'read' } })],
    ['a release id with source admin', async () => ({ rel: (await ready()).rel, over: { source: 'admin' } })],
    ['source release without a release id', async () => ({ rel: (await ready()).rel, over: { releaseId: null } })],
  ];
  it.each(refused)('E_STATE and nothing written for %s', async (_n, mk) => {
    const { rel, over } = await mk();
    expect(await repo.stage(stageIn(rel, over))).toEqual({ ok: false, code: 'E_STATE' });
    expect(await row('hello')).toBeUndefined();
    expect((await db.pool.query('SELECT count(*)::int AS n FROM mcp_server_depts')).rows[0]).toEqual({ n: 0 });
    expect(await audits()).toEqual([]);
  });
  it('a build whose forge is not the release forge is refused', async () => {
    const a = await ready();
    const g = await newForge(db.pool);
    await db.pool.query('UPDATE plugin_builds SET forge_id = $2 WHERE id = $1', [a.b, g.forgeId]);
    expect(await repo.stage(stageIn(a.rel))).toEqual({ ok: false, code: 'E_STATE' });
  });
  it('a failing audit insert rolls the row and the grants back', async () => {
    const { rel } = await ready();
    await db.pool.query("ALTER TABLE audit_log ADD CONSTRAINT fail_mcp CHECK (action <> 'mcp.add') NOT VALID");
    try { await expect(repo.stage(stageIn(rel))).rejects.toThrow(/fail_mcp/); } finally { await db.pool.query('ALTER TABLE audit_log DROP CONSTRAINT fail_mcp'); }
    expect(await row('hello')).toBeUndefined();
  });
  it('the build and forge rows are locked for the duration: a concurrent cancel of the forge waits for the stage and the stage is not torn', async () => {
    const { f, rel } = await ready();
    const [a, b] = await Promise.all([
      repo.stage(stageIn(rel)),
      db.pool.query("UPDATE plugin_forges SET status = 'cancelled', closed_at = now(), close_reason = 'admin_cancel' WHERE id = $1 AND status = 'live'", [f.forgeId]),
    ]);
    // either order is consistent: staged then cancelled, or cancelled first and the stage refused
    expect(a.ok === true || (a.ok === false && a.code === 'E_STATE')).toBe(true);
    expect(b.rowCount).toBe(1);
    expect((await row('hello') !== undefined) === a.ok).toBe(true);
  });
});

describe('R7 PF-C8: the slug rule is re-checked under the lock; a release stage never overwrites an admin row or another forge\'s row', () => {
  it('no row: staged. A pending or active row (any source): E_EXISTS', async () => {
    const a = await ready();
    expect((await repo.stage(stageIn(a.rel))).ok).toBe(true);
    await db.pool.query("UPDATE plugin_builds SET status = 'failed', code = 'x', zip = NULL, finished_at = now() WHERE id = $1", [a.b]); // one building build at a time
    const b = await ready();
    expect(await repo.stage(stageIn(b.rel))).toEqual({ ok: false, code: 'E_EXISTS' });
    await db.pool.query("UPDATE mcp_servers SET status = 'active', approved_by = $1, approved_at = now(), approved_config_sha256 = $2 WHERE slug = 'hello'", [ADMIN, 'e'.repeat(64)]);
    expect(await repo.stage(stageIn(b.rel))).toEqual({ ok: false, code: 'E_EXISTS' });
  });
  it.each(['disabled', 'quarantined'] as const)('a %s ADMIN row with the slug is not overwritten (E_EXISTS, the row is unchanged)', async (st) => {
    const sid = await newServer(db.pool, { slug: 'hello', status: st, source: 'admin', imageId: `sha256:${'8'.repeat(64)}` });
    const { rel } = await ready();
    expect(await repo.stage(stageIn(rel))).toEqual({ ok: false, code: 'E_EXISTS' });
    expect(await row('hello')).toMatchObject({ source: 'admin', release_id: null, status: st, image_id: `sha256:${'8'.repeat(64)}` });
    expect(sid).toBeGreaterThan(0);
  });
  it.each(['disabled', 'quarantined'] as const)('a %s row from a release of ANOTHER forge is not overwritten', async (st) => {
    const other = await ready({ build: { status: 'failed', imageId: `sha256:${'8'.repeat(64)}` } });
    await newServer(db.pool, { slug: 'hello', status: st, releaseId: other.rel, imageId: `sha256:${'8'.repeat(64)}` });
    const mine = await ready();
    expect(await repo.stage(stageIn(mine.rel))).toEqual({ ok: false, code: 'E_EXISTS' });
    expect(await row('hello')).toMatchObject({ release_id: other.rel, image_id: `sha256:${'8'.repeat(64)}` });
  });
  it.each(['disabled', 'quarantined'] as const)('a %s row from an earlier release of the SAME forge is replaced (a retry after a failed install), with the new release id', async (st) => {
    const a = await ready();
    const rel1 = await newRelease(db.pool, { forgeId: a.f.forgeId, projectId: a.f.projectId });
    await newServer(db.pool, { slug: 'hello', status: st, releaseId: rel1, imageId: `sha256:${'8'.repeat(64)}` });
    expect(await repo.stage(stageIn(a.rel))).toMatchObject({ ok: true });
    expect(await row('hello')).toEqual({ source: 'release', release_id: a.rel, added_by: ADMIN, status: 'pending', image_id: IMG });
  });
  it('an admin re-add over a disabled release row resets source to admin and release_id to NULL (the release CHECK stops binding)', async () => {
    const a = await ready();
    await newServer(db.pool, { slug: 'hello', status: 'disabled', releaseId: a.rel });
    expect(await repo.stage({ ...stageIn(a.rel), source: 'admin', releaseId: null, toolClass: 'read' })).toMatchObject({ ok: true });
    expect(await row('hello')).toMatchObject({ source: 'admin', release_id: null, status: 'pending' });
  });
  it('the 8-server cap still applies to a release stage', async () => {
    for (let i = 0; i < 8; i++) await newServer(db.pool, { slug: `adm${i}x`, status: 'pending' });
    const { rel } = await ready();
    expect(await repo.stage(stageIn(rel))).toEqual({ ok: false, code: 'E_MAX_SERVERS' });
  });
});
