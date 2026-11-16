import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeConfig } from '../../governance/test-helpers.js';
import { migrate } from '../migrate.js';
import { freshDb, type TestDb } from '../test-helpers.js';
import { DepartmentRepo, ProjectRepo } from './index.js';

let db: TestDb;
beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations'), 'up');
  await new DepartmentRepo(db.pool).upsert({ id: 'hq', name: 'HQ', categoryNamePattern: '', workChannelId: null, color: 0, model: null, provider: null, enabled: true });
});
afterAll(async () => { await db.close(); });

describe('ProjectRepo.getRow and byRoot (AUTO-1 BE2)', () => {
  it('getRow carries the tree usage; byRoot finds a project in any status; unknown ids give null', async () => {
    const repo = new ProjectRepo(db.pool, { cfg: new FakeConfig(), halt: { isHalted: () => false } });
    const made = await repo.create({ title: 'Rows', goal: 'g', deadline: '2099-01-01', maxLocalCalls: 10, maxUsd: 1, proposer: 'head:hq', tainted: false });
    if (!made.ok) throw new Error('create');
    const d = await repo.decide({ token: made.project.token, by: '123456789012345678' });
    if (!d.ok) throw new Error('decide');
    await db.pool.query("INSERT INTO budget_days (day, scope, scope_id, spent_usd, reserved_usd, calls) VALUES ('1970-01-01','task',$1,0.25,0.25,4)", [d.root.id]);
    const row = (await repo.getRow(made.project.id))!;
    expect(row).toMatchObject({ id: made.project.id, pastDeadline: false });
    expect(Number(row.calls)).toBe(4);
    expect(Number(row.usd)).toBeCloseTo(0.5);
    expect((await repo.list(25)).map((r) => r.id)).toEqual([made.project.id]);
    expect((await repo.byRoot(d.root.id))?.id).toBe(made.project.id);
    await repo.close({ id: made.project.id, by: '123456789012345678' });
    expect((await repo.byRoot(d.root.id))?.status).toBe('done');
    expect(await repo.getRow(999999)).toBeNull();
    expect(await repo.getRow(0)).toBeNull();
    expect(await repo.byRoot('nope')).toBeNull();
  });
});
