import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeConfig } from '../../governance/test-helpers.js';
import { migrate } from '../migrate.js';
import { freshDb, type TestDb } from '../test-helpers.js';
import { newIdea, resetForgeTables, seedDepts } from './forge-test-helpers.js';
import { ProjectRepo } from './index.js';

/** R7 PLUGIN-FORGE BE2 (spec 5.2, FG-AC13): `ProjectRepo.create` with an idea inserts the forge row in the same transaction, behind the idea and cap checks. */
let db: TestDb;
let repo: ProjectRepo;
const ADMIN = '900000000000000001';
beforeAll(async () => { db = await freshDb(); await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations'), 'up'); });
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  await resetForgeTables(db.pool);
  await db.pool.query('DELETE FROM projects');
  repo = new ProjectRepo(db.pool, { cfg: new FakeConfig({}) as never, halt: { isHalted: () => false } });
  await seedDepts(db.pool);
});
const mk = (over: Record<string, unknown> = {}) => ({ title: `P${Math.random()}`, goal: 'g', deadline: '2099-01-01', maxLocalCalls: 100, maxUsd: 5, proposer: 'head:hq', tainted: false, adopt: [] as string[], ...over });
const audits = async () => (await db.pool.query<{ actor: string; action: string; outcome: string }>("SELECT actor, action, outcome FROM audit_log WHERE action = 'forge.link' ORDER BY id")).rows;
const forges = async () => (await db.pool.query<{ idea_id: number; project_id: number; dept_id: string; proposer: string; status: string }>('SELECT idea_id, project_id, dept_id, proposer, status FROM plugin_forges ORDER BY id')).rows;

describe('ProjectRepo.create with ideaId', () => {
  it('inserts the project and its live forge in one transaction (dept of the idea, the proposer) and audits forge.link; returns the forge info', async () => {
    const idea = await newIdea(db.pool, { dept: 'software', name: 'csvtool' });
    const r = await repo.create(mk({ ideaId: idea }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.forge).toMatchObject({ ideaId: idea, ideaName: 'csvtool', deptId: 'software' });
    expect(await forges()).toEqual([{ idea_id: idea, project_id: r.project.id, dept_id: 'software', proposer: 'head:hq', status: 'live' }]);
    expect(await audits()).toEqual([{ actor: 'head:hq', action: 'forge.link', outcome: `#${r.forge!.id} idea #${idea} project #${r.project.id}` }]);
  });
  it('a user proposer is stored as user:<id>', async () => {
    const idea = await newIdea(db.pool);
    const r = await repo.create(mk({ ideaId: idea, proposer: `user:${ADMIN}` }));
    expect(r.ok).toBe(true);
    expect((await forges())[0]!.proposer).toBe(`user:${ADMIN}`);
  });
  it('a tainted idea, a closed idea and a missing idea are idea_invalid: no project, no forge, a refusal audit', async () => {
    const tainted = await newIdea(db.pool, { tainted: true });
    const closed = await newIdea(db.pool);
    await db.pool.query("UPDATE tool_ideas SET status = 'closed', closed_by = $2, closed_at = now() WHERE id = $1", [closed, ADMIN]);
    for (const id of [tainted, closed, 999999]) expect(await repo.create(mk({ ideaId: id })), String(id)).toEqual({ ok: false, code: 'idea_invalid' });
    expect((await db.pool.query('SELECT count(*)::int AS n FROM projects')).rows[0].n).toBe(0);
    expect(await forges()).toEqual([]);
    expect((await audits()).map((a) => a.outcome)).toEqual(['refused:idea_invalid', 'refused:idea_invalid', 'refused:idea_invalid']);
  });
  it('a second proposal for an idea that has a live forge is idea_busy', async () => {
    const idea = await newIdea(db.pool);
    expect((await repo.create(mk({ ideaId: idea }))).ok).toBe(true);
    expect(await repo.create(mk({ ideaId: idea }))).toEqual({ ok: false, code: 'idea_busy' });
    expect((await db.pool.query('SELECT count(*)::int AS n FROM projects')).rows[0].n).toBe(1);
    expect((await audits()).at(-1)!.outcome).toBe('refused:idea_busy');
  });
  it('concurrent proposals for one idea: exactly one wins, the rest are idea_busy (the unique index, not only the lock)', async () => {
    const idea = await newIdea(db.pool);
    const out = await Promise.all(Array.from({ length: 4 }, () => repo.create(mk({ ideaId: idea }))));
    expect(out.filter((x) => x.ok)).toHaveLength(1);
    expect(out.filter((x) => !x.ok).every((x) => !x.ok && (x.code === 'idea_busy' || x.code === 'open_cap'))).toBe(true);
    expect((await forges()).length).toBe(1);
  });
  it('forge_cap: three forges live or staged already', async () => {
    for (let i = 0; i < 3; i++) {
      const idea = await newIdea(db.pool);
      const r = await repo.create(mk({ ideaId: idea }));
      expect(r.ok, String(i)).toBe(true);
      await db.pool.query("UPDATE projects SET status = 'cancelled', closed_by = 'system', closed_at = now() WHERE status = 'proposed'"); // frees the proposal cap; the forge stays live until the reconcile runs
    }
    const idea = await newIdea(db.pool);
    expect(await repo.create(mk({ ideaId: idea }))).toEqual({ ok: false, code: 'forge_cap' });
    expect((await audits()).at(-1)!.outcome).toBe('refused:forge_cap');
    await db.pool.query("UPDATE plugin_forges SET status = 'cancelled', closed_at = now(), close_reason = 'admin_cancel' WHERE id = (SELECT min(id) FROM plugin_forges)");
    expect((await repo.create(mk({ ideaId: idea }))).ok).toBe(true);
  });
  it('the forge row is inside the project transaction: a forge insert that fails rolls the project back too', async () => {
    const idea = await newIdea(db.pool);
    await expect(repo.create(mk({ ideaId: idea, proposer: 'not-a-proposer' }))).rejects.toThrow(/plugin_forges|check/i);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM projects')).rows[0].n).toBe(0);
    expect(await forges()).toEqual([]);
    expect(await audits()).toEqual([]);
  });
  it('without an idea nothing about the forge is touched', async () => {
    const r = await repo.create(mk());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.forge).toBeUndefined();
    expect(await forges()).toEqual([]);
  });
});
