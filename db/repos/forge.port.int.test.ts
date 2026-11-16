import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../migrate.js';
import { freshDb, type TestDb } from '../test-helpers.js';
import { ForgeRepo } from './forge.js';
import { newForge, newRelease, newServer, resetForgeTables } from './forge-test-helpers.js';

/** R7 PLUGIN-FORGE BE2 (spec 3.0 F8, PF-C8 request-time half, 3.3 steps 8b and 11): the two reads behind the release request port. */
let db: TestDb;
let repo: ForgeRepo;
beforeAll(async () => { db = await freshDb(); await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations'), 'up'); repo = new ForgeRepo(db.pool); });
afterAll(async () => { await db.close(); });
beforeEach(async () => { await resetForgeTables(db.pool); });

describe('ForgeRepo.forgeOfProject', () => {
  it('the forge of a project with the idea name and department; null for a project without one', async () => {
    const f = await newForge(db.pool);
    expect(await repo.forgeOfProject(f.projectId)).toMatchObject({ id: f.forgeId, status: 'live', ideaId: f.ideaId, deptId: 'software', ideaName: expect.any(String) });
    expect(await repo.forgeOfProject(999999)).toBeNull();
    expect(await repo.forgeOfProject(0)).toBeNull();
  });
});

describe('ForgeRepo.slugTaken (F8)', () => {
  it('free when no server has the slug', async () => {
    const f = await newForge(db.pool);
    expect(await repo.slugTaken('hello', f.forgeId)).toBe(false);
  });
  it('taken by an admin row of any status, and by a pending or active release row', async () => {
    const f = await newForge(db.pool);
    for (const status of ['pending', 'active', 'disabled', 'quarantined'] as const) {
      await db.pool.query('DELETE FROM mcp_servers');
      await newServer(db.pool, { slug: 'hello', status, source: 'admin' });
      expect(await repo.slugTaken('hello', f.forgeId), `admin ${status}`).toBe(true);
    }
    const rel = await newRelease(db.pool, { forgeId: f.forgeId });
    for (const status of ['pending', 'active'] as const) {
      await db.pool.query('DELETE FROM mcp_servers');
      await newServer(db.pool, { slug: 'hello', status, source: 'release', releaseId: rel });
      expect(await repo.slugTaken('hello', f.forgeId), `release ${status}`).toBe(true);
    }
  });
  it('free for a retry: a disabled or quarantined row that came from a release of THE SAME forge', async () => {
    const f = await newForge(db.pool);
    const rel = await newRelease(db.pool, { forgeId: f.forgeId });
    for (const status of ['disabled', 'quarantined'] as const) {
      await db.pool.query('DELETE FROM mcp_servers');
      await newServer(db.pool, { slug: 'hello', status, source: 'release', releaseId: rel });
      expect(await repo.slugTaken('hello', f.forgeId), status).toBe(false);
    }
  });
  it('taken when that disabled release row belongs to another forge', async () => {
    const a = await newForge(db.pool);
    const b = await newForge(db.pool);
    const rel = await newRelease(db.pool, { forgeId: a.forgeId });
    await newServer(db.pool, { slug: 'hello', status: 'disabled', source: 'release', releaseId: rel });
    expect(await repo.slugTaken('hello', b.forgeId)).toBe(true);
    expect(await repo.slugTaken('hello', a.forgeId)).toBe(false);
  });
});
