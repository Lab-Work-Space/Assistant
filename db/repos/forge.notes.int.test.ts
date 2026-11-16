import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../migrate.js';
import { freshDb, type TestDb } from '../test-helpers.js';
import { ForgeRepo } from './forge.js';
import { newForge, newIdea, newRelease, newServer, resetForgeTables, seedDepts } from './forge-test-helpers.js';

/** R7 PLUGIN-FORGE BE2 (spec 5.5, FG-AC18): which ideas and which project the two prompt notes are built from. */
let db: TestDb;
let repo: ForgeRepo;
beforeAll(async () => { db = await freshDb(); await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations'), 'up'); repo = new ForgeRepo(db.pool); });
afterAll(async () => { await db.close(); });
beforeEach(async () => { await resetForgeTables(db.pool); await seedDepts(db.pool); });

describe('ForgeRepo.eligibleIdeas', () => {
  it('open, untainted ideas with no live or staged forge, oldest first, at most 5', async () => {
    const a = await newIdea(db.pool, { name: 'aaa-tool' });
    await newIdea(db.pool, { name: 'tainted-one', tainted: true });
    const closed = await newIdea(db.pool, { name: 'closed-one' });
    await db.pool.query("UPDATE tool_ideas SET status = 'closed', closed_by = '900000000000000001', closed_at = now() WHERE id = $1", [closed]);
    const busy = await newForge(db.pool);
    const b = await newIdea(db.pool, { name: 'bbb-tool' });
    const got = await repo.eligibleIdeas(5);
    expect(got.map((i) => i.id)).toEqual([a, b]);
    expect(got.every((i) => i.tainted === false && i.status === 'open')).toBe(true);
    expect(got.map((i) => i.id)).not.toContain(busy.ideaId);
    expect(got[0]).toMatchObject({ name: 'aaa-tool', deptId: 'software', problem: expect.any(String) });
  });
  it('a cancelled forge frees its idea again; a staged forge keeps it busy; the cap is 5', async () => {
    const f = await newForge(db.pool, { status: 'cancelled' });
    expect((await repo.eligibleIdeas(5)).map((i) => i.id)).toContain(f.ideaId);
    for (let i = 0; i < 7; i++) await newIdea(db.pool, { name: `extra-${i}x` });
    expect(await repo.eligibleIdeas(5)).toHaveLength(5);
    expect(await repo.eligibleIdeas(100)).toHaveLength(5);
  });
});

describe('ForgeRepo.softwareIdea (the task root of an active project with a live forge)', () => {
  it('returns the project and the idea (with its example)', async () => {
    const f = await newForge(db.pool);
    const got = await repo.softwareIdea(f.root!);
    expect(got).toMatchObject({ projectId: f.projectId, idea: { id: f.ideaId, status: 'open', tainted: false, example: 'an example' } });
  });
  it('null when the forge is not live, the project is not active, the root is unknown or not a uuid', async () => {
    const staged = await newForge(db.pool);
    const rel = await newRelease(db.pool, { forgeId: staged.forgeId });
    const srv = await newServer(db.pool, { slug: 'hello', status: 'pending', source: 'release', releaseId: rel });
    await db.pool.query("UPDATE plugin_forges SET status = 'staged', server_id = $2 WHERE id = $1", [staged.forgeId, srv]);
    const done = await newForge(db.pool, { projectStatus: 'done' });
    expect(await repo.softwareIdea(done.root!)).toBeNull();
    expect(await repo.softwareIdea('00000000-0000-4000-8000-000000000999')).toBeNull();
    expect(await repo.softwareIdea('not-a-uuid')).toBeNull();
    expect(await repo.softwareIdea(staged.root!)).toBeNull();
  });
});
