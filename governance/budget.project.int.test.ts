import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ActorRef } from '../company/types.js';
import { EventBus, type AppEvents } from '../core/events.js';
import { DepartmentRepo, ProjectRepo, TaskRepo } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { freshDb, type TestDb } from '../db/test-helpers.js';
import { Budget, LIFTED_CAPS, LOCAL_PROVIDER } from './budget.js';
import { FakeConfig } from './test-helpers.js';

/** AUTO-1 (SA-1 3.4, Gate 1 AP-C6, AP-C10): the 'project' budget scope. */
let db: TestDb;
let tasks: TaskRepo;
let cfg: FakeConfig;
let projects: ProjectRepo;
let halted = false;
const now = new Date('2026-11-10T10:00:00Z');
const hq: ActorRef = { kind: 'head', dept: 'hq' };
const LOCAL = LOCAL_PROVIDER;
const ADMIN = '123456789012345678';

beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations'), 'up');
  await new DepartmentRepo(db.pool).upsert({ id: 'hq', name: 'HQ', categoryNamePattern: '', workChannelId: null, color: 0, model: null, provider: null, enabled: true });
  tasks = new TaskRepo(db.pool);
});
beforeEach(async () => {
  halted = false;
  cfg = new FakeConfig({ 'limits.localUnlimited': false, 'budget.botDailyUsd': 1000, 'budget.companyDailyUsd': 1000, 'budget.taskUsd': 1000, 'limits.localCallsPerTask': 1000 });
  projects = new ProjectRepo(db.pool, { cfg, halt: { isHalted: () => halted } });
  for (const t of ['project_tools', 'projects', 'budget_days', 'spend_days', 'audit_log']) await db.pool.query(`DELETE FROM ${t}`);
  await db.pool.query('UPDATE tasks SET parent_id = NULL');
  await db.pool.query('DELETE FROM tasks');
});
afterAll(async () => { await db.close(); });

const mk = (extra: ConstructorParameters<typeof Budget>[4] = { project: (r, c) => projects.capFor(r, c) }) => new Budget(db.pool, cfg, new EventBus<AppEvents>(), () => now, extra);
const startProject = async (o: { maxLocalCalls: number; maxUsd: number }) => {
  const c = await projects.create({ title: `P${Math.random()}`, goal: 'g', deadline: '2099-01-01', ...o, proposer: 'head:hq', tainted: false });
  if (!c.ok) throw new Error(c.code);
  const d = await projects.decide({ token: c.project.token, by: ADMIN });
  if (!d.ok) throw new Error(d.code);
  const kid = await tasks.create({ title: 'k', deptId: 'hq', owner: hq, requester: hq, origin: 'delegated', parentId: d.root.id });
  return { project: d.project, root: d.root, kid };
};
const local = (b: Budget, taskId: string) => b.reserve({ actor: hq, estUsd: 0, taskId, provider: LOCAL, model: 'm' });
const usd = (b: Budget, taskId: string, est: number) => b.reserve({ actor: hq, estUsd: est, taskId });
const calls = async (rootId: string) => (await db.pool.query<{ calls: number }>("SELECT calls FROM budget_days WHERE scope = 'task' AND scope_id = $1", [rootId])).rows[0]?.calls ?? 0;

describe('project scope, local calls', () => {
  it('the project call cap refuses with scope project, counted on the root for child tasks; the refused call consumes nothing', async () => {
    const { root, kid } = await startProject({ maxLocalCalls: 3, maxUsd: 5 });
    const b = mk();
    expect((await local(b, root.id)).ok).toBe(true);
    expect((await local(b, kid.id)).ok).toBe(true);
    expect((await local(b, kid.id)).ok).toBe(true);
    expect(await local(b, kid.id)).toEqual({ ok: false, scope: 'project' });
    expect(await calls(root.id)).toBe(3);
    expect((await local(b, (await tasks.create({ title: 'o', deptId: 'hq', owner: hq, requester: hq, origin: 'chat' })).id)).ok).toBe(true); // other trees unaffected
  });
  it('limits.localUnlimited does not lift the project cap, and a project root never returns local_task (AP-C6)', async () => {
    cfg.values.set('limits.localUnlimited', true);
    cfg.values.set('limits.localCallsPerTask', 1);
    const { root, kid } = await startProject({ maxLocalCalls: 2, maxUsd: 5 });
    const b = mk();
    expect((await local(b, root.id)).ok).toBe(true);
    expect((await local(b, kid.id)).ok).toBe(true); // 2 calls with a per-tree cap of 1: local_task does not apply
    expect(await local(b, kid.id)).toEqual({ ok: false, scope: 'project' });
    // without a project the same lifted setting lets the tree run past limits.localCallsPerTask
    const free = await tasks.create({ title: 'o', deptId: 'hq', owner: hq, requester: hq, origin: 'chat' });
    for (let i = 0; i < 4; i++) expect((await local(b, free.id)).ok).toBe(true);
  });
  it('LIFTED_CAPS is unchanged by AUTO-1 (no project key)', () => {
    expect([...LIFTED_CAPS].sort()).toEqual([
      'limits.localCallsPerDay', 'limits.localCallsPerTask', 'limits.turnsPerTask', 'meetings.adHocPerDay', 'warroom.localCallsPerDay',
      'warroom.rootTasksPerDay', 'warroom.turnsPerHour', 'warroom.turnsPerThreadPerHour',
    ]);
  });
  it('the per-day local count is still reported before the project count', async () => {
    cfg.values.set('limits.localCallsPerDay', 1);
    const { root } = await startProject({ maxLocalCalls: 5, maxUsd: 5 });
    const b = mk();
    expect((await local(b, root.id)).ok).toBe(true);
    expect(await local(b, root.id)).toEqual({ ok: false, scope: 'local' });
  });
});

describe('project scope, USD', () => {
  it('the project USD cap replaces budget.taskUsd for the tree: refused with scope project at the cap, allowed up to it', async () => {
    cfg.values.set('budget.taskUsd', 0.1);
    const { root, kid } = await startProject({ maxLocalCalls: 10, maxUsd: 2 });
    const b = mk();
    const r1 = await usd(b, kid.id, 1.5);
    expect(r1.ok).toBe(true); // 1.5 > budget.taskUsd 0.1, but the project cap is 2
    if (r1.ok) await b.settle(r1.reservationId, 1.5);
    expect(await usd(b, root.id, 0.6)).toEqual({ ok: false, scope: 'project' });
    expect((await usd(b, root.id, 0.5)).ok).toBe(true); // exactly at the cap
  });
  it('maxUsd 0: every metered call in the tree is refused with project (AP-C6)', async () => {
    const { root, kid } = await startProject({ maxLocalCalls: 10, maxUsd: 0 });
    const b = mk();
    expect(await usd(b, root.id, 0.000001)).toEqual({ ok: false, scope: 'project' });
    expect(await usd(b, kid.id, 0.01)).toEqual({ ok: false, scope: 'project' });
    expect((await local(b, kid.id)).ok).toBe(true); // local calls cost nothing
  });
  it('a tree outside any project keeps scope task', async () => {
    cfg.values.set('budget.taskUsd', 1);
    const t = await tasks.create({ title: 'o', deptId: 'hq', owner: hq, requester: hq, origin: 'chat' });
    expect(await usd(mk(), t.id, 2)).toEqual({ ok: false, scope: 'task' });
  });
  it('a company or bot limit is still reported as that scope, not project', async () => {
    cfg.values.set('budget.botDailyUsd', 0.5);
    const { root } = await startProject({ maxLocalCalls: 10, maxUsd: 100 });
    expect(await usd(mk(), root.id, 1)).toEqual({ ok: false, scope: 'bot' });
  });
});

describe('fail-safe (AP-C10)', () => {
  it('a throwing project seam fails the reservation closed (the caller makes no provider call)', async () => {
    const { root } = await startProject({ maxLocalCalls: 5, maxUsd: 5 });
    const b = mk({ project: async () => { throw new Error('boom'); } });
    await expect(usd(b, root.id, 0.1)).rejects.toThrow('boom');
    await expect(local(b, root.id)).rejects.toThrow('boom');
    expect(await calls(root.id)).toBe(0);
  });
  it('autopilot.enabled false (or a read error): no project cap, today\'s caps apply', async () => {
    cfg.values.set('budget.taskUsd', 10);
    const { root } = await startProject({ maxLocalCalls: 1, maxUsd: 0.5 });
    cfg.values.set('autopilot.enabled', false);
    const b = mk();
    expect((await usd(b, root.id, 5)).ok).toBe(true);
    expect((await local(b, root.id)).ok).toBe(true);
    expect((await local(b, root.id)).ok).toBe(true);
    cfg.values.delete('autopilot.enabled');
    cfg.throwOn.add('autopilot.enabled');
    expect((await usd(b, root.id, 1)).ok).toBe(true);
  });
  it('without the seam the budget is exactly as before', async () => {
    const { root } = await startProject({ maxLocalCalls: 1, maxUsd: 0.5 });
    const b = mk({});
    expect((await usd(b, root.id, 5)).ok).toBe(true);
    expect((await local(b, root.id)).ok).toBe(true);
    expect((await local(b, root.id)).ok).toBe(true);
  });
});
