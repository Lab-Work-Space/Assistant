import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../db/migrate.js';
import { ForgeRepo } from '../db/repos/forge.js';
import { ADMIN, ADMIN2, newForge, newRelease, resetForgeTables } from '../db/repos/forge-test-helpers.js';
import { freshDb, type TestDb } from '../db/test-helpers.js';
import { makeForgeEnqueue } from './enqueue.js';
import { helloBuild, helloFiles, zipOfFiles } from './test-helpers.js';
import { createHash } from 'node:crypto';

/** R7 PLUGIN-FORGE BE2 (spec 3.4 step 1, PF-C11 repo half, FG-AC10): the enqueue closure validates the pinned bytes again and inserts the inert build row. */
let db: TestDb;
let repo: ForgeRepo;
beforeAll(async () => { db = await freshDb(); await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations'), 'up'); repo = new ForgeRepo(db.pool); });
afterAll(async () => { await db.close(); });
beforeEach(async () => { await resetForgeTables(db.pool); });
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

async function seed(zip = helloBuild().zip) {
  const f = await newForge(db.pool);
  expect(f.ideaId).toBe(1);
  const hb = helloBuild({ zip });
  const rel = await newRelease(db.pool, { forgeId: f.forgeId, projectId: f.projectId, sha: sha(zip), manifest: hb.manifestSha256, zip, bytes: zip.length, status: 'pending' }).catch(() => 0);
  return { f, hb, rel, zip };
}
const args = (s: Awaited<ReturnType<typeof seed>>, over: Record<string, unknown> = {}) => ({ releaseId: s.rel, forgeId: s.f.forgeId, pluginSlug: 'hello', sha256: sha(s.zip), bytes: s.zip.length, manifestSha256: s.hb.manifestSha256, decidedBy: ADMIN, zip: s.zip, ...over });

describe('makeForgeEnqueue', () => {
  it('a valid pinned plugin: the inert queued build row with the deciding admin', async () => {
    const s = await seed();
    const enq = makeForgeEnqueue({ repo, secrets: () => [] });
    expect(await enq(args(s))).toEqual({ ok: true });
    expect((await db.pool.query('SELECT status, decided_by, plugin_slug, sha256, manifest_sha256, attempts FROM plugin_builds')).rows).toEqual([{ status: 'queued', decided_by: ADMIN, plugin_slug: 'hello', sha256: sha(s.zip), manifest_sha256: s.hb.manifestSha256, attempts: 0 }]);
  });
  it('PF-C11: the same release approved again by another admin updates only decided_by', async () => {
    const s = await seed();
    const enq = makeForgeEnqueue({ repo, secrets: () => [] });
    await enq(args(s));
    expect(await enq(args(s, { decidedBy: ADMIN2 }))).toEqual({ ok: true });
    expect((await db.pool.query('SELECT decided_by FROM plugin_builds')).rows).toEqual([{ decided_by: ADMIN2 }]);
  });
  it('a stored plugin that no longer passes the rules is plugin_invalid and nothing is inserted', async () => {
    const f = helloFiles();
    f['Dockerfile'] = 'FROM scratch';
    const zip = zipOfFiles(f);
    const s = await seed(zip).catch(async () => seed());
    const enq = makeForgeEnqueue({ repo, secrets: () => [] });
    expect(await enq(args(s, { zip, sha256: sha(zip), bytes: zip.length }))).toEqual({ ok: false, code: 'plugin_invalid' });
    expect((await db.pool.query('SELECT count(*)::int AS n FROM plugin_builds')).rows[0].n).toBe(0);
  });
  it('a manifest hash, a sha256 or a size that does not match the bytes is plugin_invalid', async () => {
    const s = await seed();
    const enq = makeForgeEnqueue({ repo, secrets: () => [] });
    for (const over of [{ manifestSha256: 'f'.repeat(64) }, { sha256: 'f'.repeat(64) }, { bytes: s.zip.length + 1 }]) expect(await enq(args(s, over)), JSON.stringify(over)).toEqual({ ok: false, code: 'plugin_invalid' });
    expect((await db.pool.query('SELECT count(*)::int AS n FROM plugin_builds')).rows[0].n).toBe(0);
  });
  it('forge.json naming another idea than the forge is plugin_invalid (the idea comes from the forge row)', async () => {
    const f = helloFiles();
    f['forge.json'] = f['forge.json']!.replace(/"idea":\s*1/, '"idea":2');
    const zip = zipOfFiles(f);
    const s = await seed();
    const enq = makeForgeEnqueue({ repo, secrets: () => [] });
    expect(await enq(args(s, { zip, sha256: sha(zip), bytes: zip.length }))).toEqual({ ok: false, code: 'plugin_invalid' });
  });
  it('an unknown forge, a conflicting build row and a repo fault are `exception` (certain: nothing happened, the row reverts)', async () => {
    const s = await seed();
    const enq = makeForgeEnqueue({ repo, secrets: () => [] });
    expect(await enq(args(s, { forgeId: 999999 }))).toEqual({ ok: false, code: 'exception' });
    await enq(args(s));
    await db.pool.query("UPDATE plugin_builds SET status = 'building', started_at = now(), attempts = 1");
    expect(await enq(args(s))).toEqual({ ok: false, code: 'exception' });
    const boom = makeForgeEnqueue({ repo: { byId: vi.fn(async () => { throw new Error('db'); }), enqueue: vi.fn() }, secrets: () => [] });
    expect(await boom(args(s))).toEqual({ ok: false, code: 'exception' });
  });
});
