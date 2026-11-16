import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../db/migrate.js';
import { ADMIN, newForge, resetForgeTables } from '../db/repos/forge-test-helpers.js';
import { ReleaseRepo, type NewRelease } from '../db/repos/releases.js';
import { freshDb, type TestDb } from '../db/test-helpers.js';

/** R7 PLUGIN-FORGE BE2 (spec 5.2, 7.1, FG-AC01 part): the release repo carries the forge columns and the new target. */
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const TZ = 'Asia/Bangkok';
const ZIP = Buffer.from('PK-int');
const SHA = 'c'.repeat(64);
const MAN = 'd'.repeat(64);
let db: TestDb;
let repo: ReleaseRepo;
beforeAll(async () => { db = await freshDb(); await migrate(db.pool, dir, 'up'); repo = new ReleaseRepo(db.pool); });
afterAll(async () => { await db.close(); });
beforeEach(async () => { await resetForgeTables(db.pool); await db.pool.query('DELETE FROM releases'); });

const nr = (forgeId: number | null, over: Partial<NewRelease> = {}): NewRelease => ({
  token: 'e'.repeat(32), deptId: 'software', requester: 'head:software', taskId: '00000000-0000-4000-8000-000000000001', rootId: '00000000-0000-4000-8000-000000000002', projectId: null, target: 'install_plugin',
  title: 'T', summary: 'S', slug: 'hello-ws', sha256: SHA, bytes: ZIP.length, files: 1, skipped: 0, zip: ZIP, evidence: { runs: [], writesAfterLastRun: null }, tainted: false, catalogDigest: 'd'.repeat(64),
  sourceChannelId: '700000000000000001', sourceThreadId: null, forgeId, pluginSlug: forgeId === null ? null : 'hello', pluginManifestSha256: forgeId === null ? null : MAN, ...over,
});

describe('ReleaseRepo and the install_plugin target', () => {
  it('create stores the forge columns; byId and claim return them (claim also returns decided_by)', async () => {
    const f = await newForge(db.pool);
    const made = await repo.create(nr(f.forgeId), TZ);
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(await repo.byId(made.id)).toMatchObject({ target: 'install_plugin', forgeId: f.forgeId, pluginSlug: 'hello', pluginManifestSha256: MAN });
    await repo.setCard(made.id, '1565682159375749161', '800000000000000001');
    const c = await repo.claim('e'.repeat(32), ADMIN);
    expect(c).toMatchObject({ id: made.id, target: 'install_plugin', forgeId: f.forgeId, pluginSlug: 'hello', pluginManifestSha256: MAN, decidedBy: ADMIN });
    expect(c!.zip.equals(ZIP)).toBe(true);
  });
  it('a handoff row has null forge columns', async () => {
    const made = await repo.create(nr(null, { target: 'handoff' }), TZ);
    if (!made.ok) throw new Error('refused');
    expect(await repo.byId(made.id)).toMatchObject({ target: 'handoff', forgeId: null, pluginSlug: null, pluginManifestSha256: null });
  });
  it('install_plugin without the forge columns is refused by releases_plugin; github is still refused by releases_target_check', async () => {
    await expect(repo.create(nr(null, { target: 'install_plugin' }), TZ)).rejects.toThrow(/releases_plugin/);
    await expect(repo.create(nr(null, { target: 'github' as never }), TZ)).rejects.toThrow(/releases_target_check/);
  });
});
