import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../migrate.js';
import { freshDb, type TestDb } from '../test-helpers.js';
import { ForgeRepo } from './forge.js';
import { ADMIN, IMG, newBuild, newForge, newRelease, newServer, resetForgeTables } from './forge-test-helpers.js';

/** R7 PLUGIN-FORGE BE2 (spec 5.8, FG-AC23 repo half): the reads and the one write behind `/forge list|show|cancel`. */
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
let db: TestDb;
let repo: ForgeRepo;
beforeAll(async () => { db = await freshDb(); await migrate(db.pool, dir, 'up'); repo = new ForgeRepo(db.pool); });
afterAll(async () => { await db.close(); });
beforeEach(async () => { await resetForgeTables(db.pool); });
const audits = async () => (await db.pool.query<{ actor: string; action: string; outcome: string }>('SELECT actor, action, outcome FROM audit_log ORDER BY id')).rows;

describe('ForgeRepo.listItems and detail', () => {
  it('lists forges newest first with the idea name, the server slug and the last build', async () => {
    const a = await newForge(db.pool);
    const b = await newForge(db.pool);
    const rel = await newRelease(db.pool, { forgeId: a.forgeId });
    const bd = await newBuild(db.pool, { forgeId: a.forgeId, releaseId: rel, status: 'failed', code: 'commit_failed' });
    const items = await repo.listItems(25);
    expect(items.map((i) => i.id)).toEqual([b.forgeId, a.forgeId]);
    expect(items[0]).toMatchObject({ id: b.forgeId, lastBuild: null, serverSlug: null, status: 'live', projectId: b.projectId });
    expect(items[1]).toMatchObject({ id: a.forgeId, lastBuild: { id: bd, status: 'failed', code: 'commit_failed' } });
    expect(typeof items[1]!.ideaName).toBe('string');
  });
  it('detail returns idea, project, releases, builds (no zip) and the server', async () => {
    const f = await newForge(db.pool);
    const rel = await newRelease(db.pool, { forgeId: f.forgeId });
    const srv = await newServer(db.pool, { slug: 'hello', status: 'pending', source: 'release', releaseId: rel });
    await newBuild(db.pool, { forgeId: f.forgeId, releaseId: rel, status: 'staged', imageId: IMG });
    await db.pool.query("UPDATE plugin_forges SET status = 'staged', server_id = $2 WHERE id = $1", [f.forgeId, srv]);
    const d = await repo.detail(f.forgeId);
    expect(d).toMatchObject({ id: f.forgeId, status: 'staged', projectId: f.projectId, projectStatus: 'active', releases: [{ id: rel, status: 'released' }], server: { slug: 'hello', status: 'pending' } });
    expect(d!.builds).toEqual([expect.objectContaining({ releaseId: rel, status: 'staged', image12: IMG.slice(7, 19) })]);
    expect(JSON.stringify(d)).not.toContain('zip');
    expect(await repo.detail(999999)).toBeNull();
  });
});

describe('ForgeRepo.adminCancel (3.2 /forge cancel)', () => {
  it('cancels a live forge: admin_cancel, queued builds cancelled (zip dropped), the audit row names the admin and carries no free text', async () => {
    const f = await newForge(db.pool);
    const rel = await newRelease(db.pool, { forgeId: f.forgeId });
    const b = await newBuild(db.pool, { forgeId: f.forgeId, releaseId: rel, status: 'queued' });
    expect(await repo.adminCancel(f.forgeId, ADMIN)).toEqual({ ok: true, serverSlug: null, serverStatus: null });
    expect(await repo.byId(f.forgeId)).toMatchObject({ status: 'cancelled', closeReason: 'admin_cancel' });
    expect(await repo.build(b)).toMatchObject({ status: 'cancelled', code: 'forge_cancelled' });
    expect((await db.pool.query('SELECT zip IS NULL AS n FROM plugin_builds WHERE id = $1', [b])).rows[0].n).toBe(true);
    expect((await audits()).filter((a) => a.action === 'forge.cancel')).toEqual([{ actor: `user:${ADMIN}`, action: 'forge.cancel', outcome: `#${f.forgeId} admin_cancel` }]);
  });
  it('is refused `busy` while a build is building, and nothing changes', async () => {
    const f = await newForge(db.pool);
    const rel = await newRelease(db.pool, { forgeId: f.forgeId });
    await newBuild(db.pool, { forgeId: f.forgeId, releaseId: rel, status: 'building' });
    expect(await repo.adminCancel(f.forgeId, ADMIN)).toEqual({ ok: false, code: 'busy' });
    expect((await repo.byId(f.forgeId))!.status).toBe('live');
    expect((await audits()).filter((a) => a.action === 'forge.cancel')).toEqual([]);
  });
  it('a staged forge is cancelled but its server is not touched; the result names the server so the reply can say /mcp disable', async () => {
    const f = await newForge(db.pool);
    const rel = await newRelease(db.pool, { forgeId: f.forgeId });
    const srv = await newServer(db.pool, { slug: 'hello', status: 'pending', source: 'release', releaseId: rel });
    await newBuild(db.pool, { forgeId: f.forgeId, releaseId: rel, status: 'staged', imageId: IMG });
    await db.pool.query("UPDATE plugin_forges SET status = 'staged', server_id = $2 WHERE id = $1", [f.forgeId, srv]);
    expect(await repo.adminCancel(f.forgeId, ADMIN)).toEqual({ ok: true, serverSlug: 'hello', serverStatus: 'pending' });
    expect((await db.pool.query('SELECT status FROM mcp_servers WHERE id = $1', [srv])).rows[0].status).toBe('pending');
  });
  it('not_found for a missing id; not_open for installed or cancelled; a bad id is not_found', async () => {
    const done = await newForge(db.pool, { status: 'cancelled' });
    const inst = await newForge(db.pool, { status: 'installed', serverId: await newServer(db.pool, { slug: 'abc', status: 'active', approvedBy: ADMIN }) });
    expect(await repo.adminCancel(999999, ADMIN)).toEqual({ ok: false, code: 'not_found' });
    expect(await repo.adminCancel(-1, ADMIN)).toEqual({ ok: false, code: 'not_found' });
    expect(await repo.adminCancel(done.forgeId, ADMIN)).toEqual({ ok: false, code: 'not_open' });
    expect(await repo.adminCancel(inst.forgeId, ADMIN)).toEqual({ ok: false, code: 'not_open' });
  });
  it('rejects a non-snowflake admin id before writing', async () => {
    const f = await newForge(db.pool);
    await expect(repo.adminCancel(f.forgeId, 'someone')).rejects.toThrow();
    expect((await repo.byId(f.forgeId))!.status).toBe('live');
  });
});
