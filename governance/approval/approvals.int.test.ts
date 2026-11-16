import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EventBus, type AppEvents } from '../../core/events.js';
import { migrate } from '../../db/migrate.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { ApprovalRepo, DepartmentRepo, TaskRepo } from '../../db/index.js';
import type { ActorRef } from '../../company/types.js';
import { createConversation } from '../../agents/conversation.js';
import { Approvals } from './approvals.js';
import { compactItemFits, soloShowsWhole } from '../../discord/embeds/approval.js';
import { WebGrantRepo } from '../../db/repos/web-grants.js';
import { canonicalJson, inputDigest } from '../canonical.js';
import { Budget } from '../budget.js';
import { FakeConfig } from '../test-helpers.js';

let db: TestDb;
let tasks: TaskRepo;
const hq: ActorRef = { kind: 'head', dept: 'hq' };
const admin = { id: 'admin1', isAdmin: true };
const human = { id: 'user1', isAdmin: false };
const NOW = new Date('2026-10-31T10:00:00Z'); // Budget clock only; approvals use the DB clock

class FakeHalt {
  halted = false;
  /** G2W-02: reads from this call number on answer true (the halt lands mid-click). */
  haltFromCall = Infinity;
  calls = 0;
  isHalted() { this.calls++; return this.halted || this.calls >= this.haltFromCall; }
}

const mk = (cfgInit: ConstructorParameters<typeof FakeConfig>[0] = {}) => {
  const cfg = new FakeConfig({ 'limits.localUnlimited': false, 'budget.botDailyUsd': 1000, 'budget.companyDailyUsd': 1000, ...cfgInit });
  const bus = new EventBus<AppEvents>();
  const halt = new FakeHalt();
  const requested: unknown[] = [];
  const ready: unknown[] = [];
  bus.on('approval.requested', (a) => { requested.push(a); });
  bus.on('task.ready', (p) => { ready.push(p); });
  const audits: { action: string; outcome?: string | null; taskId?: string | null }[] = [];
  const approvals = new Approvals(db.pool, tasks, cfg, bus, halt, async (e) => { audits.push(e); });
  const budget = new Budget(db.pool, cfg, bus, () => NOW, { taskCap: (id, c) => approvals.treeCap(id, c) });
  return { cfg, bus, halt, requested, ready, approvals, budget, audits };
};

const newTask = (parentId?: string, status?: 'todo' | 'awaiting_approval') =>
  tasks.create({ title: 't', deptId: 'hq', owner: hq, requester: { kind: 'human', userId: '1' }, origin: 'chat', parentId, status });

beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations'), 'up');
  await new DepartmentRepo(db.pool).upsert({ id: 'hq', name: 'HQ', categoryNamePattern: '', workChannelId: null, color: 0, model: null, provider: null, enabled: true });
  tasks = new TaskRepo(db.pool);
});
beforeEach(async () => {
  await db.pool.query('DELETE FROM web_grants');
  await db.pool.query('DELETE FROM approvals');
  await db.pool.query('DELETE FROM budget_days');
  await db.pool.query('DELETE FROM tasks');
});
afterAll(async () => { await db.close(); });
const ADMIN_ID = '123456789012345678';

describe('Approvals', () => {
  it('needsApproval(1.01) true, (1.00) false', () => {
    const { approvals } = mk();
    expect(approvals.needsApproval(Number.NaN)).toBe(true);
    expect(approvals.needsApproval(Number.POSITIVE_INFINITY)).toBe(true);
    expect(approvals.needsApproval(1.01)).toBe(true);
    expect(approvals.needsApproval(1.0)).toBe(false);
  });

  it('request sets task awaiting_approval', async () => {
    const { approvals, requested } = mk();
    const t = await newTask();
    const a = await approvals.request({ taskId: t.id, reason: 'big', estCostUsd: 2, requestedBy: hq });
    expect(a.status).toBe('pending');
    expect(a.estCostUsd).toBe(2);
    expect((await tasks.get(t.id))!.status).toBe('awaiting_approval');
    expect(requested).toEqual([a]);
    expect(a.kind).toBe('estimate'); // WS7: the event carries the kind, so card routing can tell estimate and tool cards from cap cards
  });

  it('the stored reason is masked with the literal secret list (and the generic patterns)', async () => {
    const cfg = new FakeConfig({ 'limits.localUnlimited': false });
    const lit = 'opaque-literal-PLANTED-77';
    const approvals = new Approvals(db.pool, tasks, cfg, new EventBus<AppEvents>(), new FakeHalt(), async () => undefined, [lit]);
    const t = await newTask();
    await approvals.request({ taskId: t.id, reason: `tool x on ${lit}: key AIzaSyPlantedKey0123456789abcdefgh`, estCostUsd: 0, requestedBy: hq });
    const reason = (await db.pool.query<{ reason: string }>('SELECT reason FROM approvals WHERE task_id = $1', [t.id])).rows[0]!.reason;
    expect(reason).toBe('tool x on [REDACTED]: key [REDACTED]');
    // a reason capped upstream mid-literal: the cut-off tail is masked too
    const t2 = await newTask();
    await approvals.request({ taskId: t2.id, reason: `tool x on ${lit.slice(0, 12)}`, estCostUsd: 0, requestedBy: hq });
    const cut = (await db.pool.query<{ reason: string }>('SELECT reason FROM approvals WHERE task_id = $1', [t2.id])).rows[0]!.reason;
    expect(cut).toBe('tool x on [REDACTED]');
  });

  it('request rejects missing, negative and non-finite estCostUsd', async () => {
    const { approvals } = mk();
    const t = await newTask();
    for (const est of [-1, Number.NaN, Number.POSITIVE_INFINITY, undefined as unknown as number])
      await expect(approvals.request({ taskId: t.id, reason: 'x', estCostUsd: est, requestedBy: hq })).rejects.toThrow();
    expect((await tasks.get(t.id))!.status).toBe('todo');
  });

  it('non-admin decide returns not_admin and leaves pending', async () => {
    const { approvals } = mk();
    const t = await newTask();
    const a = await approvals.request({ taskId: t.id, reason: 'x', estCostUsd: 2, requestedBy: hq });
    expect(await approvals.decide(a.id, 'approved', human)).toEqual({ ok: false, error: 'not_admin' });
    expect(await approvals.decide(a.id, 'ask', human)).toEqual({ ok: false, error: 'not_admin' });
    expect((await new ApprovalRepo(db.pool).get(a.id))!.status).toBe('pending');
    expect((await tasks.get(t.id))!.status).toBe('awaiting_approval');
  });

  it('approve moves task to todo and emits task.ready; reject cancels', async () => {
    const { approvals, ready } = mk();
    const t1 = await newTask();
    const a1 = await approvals.request({ taskId: t1.id, reason: 'x', estCostUsd: 2, requestedBy: hq });
    const r1 = await approvals.decide(a1.id, 'approved', admin);
    expect(r1.ok && r1.approval).toMatchObject({ status: 'approved', decidedBy: 'admin1' });
    expect((await tasks.get(t1.id))!.status).toBe('todo');
    expect(ready).toEqual([{ taskId: t1.id }]);
    const t2 = await newTask();
    const a2 = await approvals.request({ taskId: t2.id, reason: 'x', estCostUsd: 2, requestedBy: hq });
    expect((await approvals.decide(a2.id, 'rejected', admin)).ok).toBe(true);
    expect((await tasks.get(t2.id))!.status).toBe('cancelled');
    expect(ready).toHaveLength(1);
  });

  it('second decide returns not_pending', async () => {
    const { approvals } = mk();
    const t = await newTask();
    const a = await approvals.request({ taskId: t.id, reason: 'x', estCostUsd: 2, requestedBy: hq });
    expect((await approvals.decide(a.id, 'rejected', admin)).ok).toBe(true);
    expect(await approvals.decide(a.id, 'approved', admin)).toEqual({ ok: false, error: 'not_pending' });
    expect((await tasks.get(t.id))!.status).toBe('cancelled');
    expect(await approvals.decide(99999, 'approved', admin)).toEqual({ ok: false, error: 'not_pending' });
  });

  it('two parallel admin decides yield one ok', async () => {
    const { approvals, ready } = mk();
    const t = await newTask();
    const a = await approvals.request({ taskId: t.id, reason: 'x', estCostUsd: 2, requestedBy: hq });
    const rs = await Promise.all([
      approvals.decide(a.id, 'approved', admin),
      approvals.decide(a.id, 'rejected', { id: 'admin2', isAdmin: true }),
      approvals.decide(a.id, 'approved', { id: 'admin3', isAdmin: true }),
    ]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(rs.filter((r) => !r.ok && r.error === 'not_pending')).toHaveLength(2);
    const final = (await new ApprovalRepo(db.pool).get(a.id))!;
    expect((await tasks.get(t.id))!.status).toBe(final.status === 'approved' ? 'todo' : 'cancelled');
    expect(ready).toHaveLength(final.status === 'approved' ? 1 : 0);
  });

  it('decide on an expired pending approval is refused', async () => {
    const { approvals } = mk();
    const t = await newTask();
    const a = await approvals.request({ taskId: t.id, reason: 'x', estCostUsd: 2, requestedBy: hq });
    await db.pool.query("UPDATE approvals SET created_at = now() - interval '25 hours' WHERE id = $1", [a.id]);
    expect(await approvals.decide(a.id, 'approved', admin)).toEqual({ ok: false, error: 'expired' });
    expect(await approvals.decide(a.id, 'ask', admin)).toEqual({ ok: false, error: 'expired' });
    expect((await new ApprovalRepo(db.pool).get(a.id))!.status).toBe('pending');
  });

  it('ask requires admin, leaves the approval pending', async () => {
    const { approvals } = mk();
    const t = await newTask();
    const a = await approvals.request({ taskId: t.id, reason: 'x', estCostUsd: 2, requestedBy: hq });
    const r = await approvals.decide(a.id, 'ask', admin);
    expect(r.ok && r.approval.status).toBe('pending');
    expect((await tasks.get(t.id))!.status).toBe('awaiting_approval');
  });

  it('expireOld after 24h cancels task', async () => {
    const { approvals } = mk();
    const t = await newTask();
    const fresh = await newTask();
    const a = await approvals.request({ taskId: t.id, reason: 'x', estCostUsd: 2, requestedBy: hq });
    const b = await approvals.request({ taskId: fresh.id, reason: 'x', estCostUsd: 2, requestedBy: hq });
    await db.pool.query("UPDATE approvals SET created_at = now() - interval '25 hours' WHERE id = $1", [a.id]);
    expect(await approvals.expireOld()).toBe(1);
    expect((await new ApprovalRepo(db.pool).get(a.id))!.status).toBe('expired');
    expect((await tasks.get(t.id))!.status).toBe('cancelled');
    expect((await new ApprovalRepo(db.pool).get(b.id))!.status).toBe('pending');
    expect((await tasks.get(fresh.id))!.status).toBe('awaiting_approval');
    expect(await approvals.expireOld()).toBe(0);
  });

  it('halted approve records but emits no task.ready; resumeApproved releases it', async () => {
    const { approvals, halt, ready } = mk();
    const t = await newTask();
    const a = await approvals.request({ taskId: t.id, reason: 'x', estCostUsd: 2, requestedBy: hq });
    halt.halted = true;
    const r = await approvals.decide(a.id, 'approved', admin);
    expect(r.ok).toBe(true);
    expect(ready).toEqual([]);
    expect(await approvals.resumeApproved()).toBe(0); // still halted
    expect(ready).toEqual([]);
    halt.halted = false;
    expect(await approvals.resumeApproved()).toBe(1);
    expect(ready).toEqual([{ taskId: t.id }]);
    expect((await tasks.get(t.id))!.status).toBe('todo');
    expect(await approvals.resumeApproved()).toBe(0);
  });
});

describe('tree cap (R16, Gate 1 D1)', () => {
  it('treeCap defaults to budget.taskUsd and follows the approved tree cap of the root', async () => {
    const { approvals } = mk();
    const root = await newTask();
    const child = await newTask(root.id);
    expect(await approvals.treeCap(root.id)).toBe(0.5);
    const a = (await approvals.onTreeCapHit({ rootId: root.id, taskId: child.id, est: 5, requestedBy: hq }))!;
    expect(await approvals.treeCap(root.id)).toBe(0.5); // pending does not count
    await approvals.decide(a.id, 'approved', admin);
    expect(await approvals.treeCap(root.id)).toBe(5);
    const other = await newTask();
    expect(await approvals.treeCap(other.id)).toBe(0.5);
  });

  it('tree spend over threshold awaits approval despite estCostUsd 0', async () => {
    const { approvals, budget, requested } = mk();
    const root = await newTask();
    const child = await newTask(root.id);
    const r1 = await budget.reserve({ actor: hq, taskId: child.id, estUsd: 0.5 });
    expect(r1.ok).toBe(true);
    if (r1.ok) await budget.settle(r1.reservationId, 0.5);
    expect(await budget.reserve({ actor: hq, taskId: child.id, estUsd: 0.2 })).toEqual({ ok: false, scope: 'task' });

    const a = (await approvals.onTreeCapHit({ rootId: root.id, est: 0, requestedBy: hq }))!;
    expect(a.taskId).toBe(root.id);
    expect(a.status).toBe('pending');
    expect(a.estCostUsd).toBeCloseTo(1.5, 6); // max(0.5 + 0, 0.5 + threshold 1)
    expect((await tasks.get(root.id))!.status).toBe('awaiting_approval');
    expect(requested).toHaveLength(1);

    // idempotent while pending
    const again = (await approvals.onTreeCapHit({ rootId: root.id, est: 0, requestedBy: hq }))!;
    expect(again.id).toBe(a.id);
    expect(requested).toHaveLength(1);

    expect((await approvals.decide(a.id, 'approved', admin)).ok).toBe(true);
    expect(await approvals.treeCap(root.id)).toBeCloseTo(1.5, 6);
    expect((await budget.reserve({ actor: hq, taskId: child.id, estUsd: 0.9 })).ok).toBe(true);
    expect(await budget.reserve({ actor: hq, taskId: child.id, estUsd: 0.2 })).toEqual({ ok: false, scope: 'task' });
  });

  it('new cap covers a large estimate: max(spent+reserved+est, cap+threshold)', async () => {
    const { approvals, budget } = mk();
    const root = await newTask();
    const r = await budget.reserve({ actor: hq, taskId: root.id, estUsd: 0.4 });
    expect(r.ok).toBe(true); // stays reserved
    const a = (await approvals.onTreeCapHit({ rootId: root.id, est: 5, requestedBy: hq }))!;
    expect(a.estCostUsd).toBeCloseTo(5.4, 6);
    await expect(approvals.onTreeCapHit({ rootId: root.id, est: -1, requestedBy: hq })).rejects.toThrow();
  });

  it('R33: an approved $2 estimate child can spend past $0.50 up to $2.50 without a second approval', async () => {
    const { approvals, budget, requested } = mk();
    const root = await newTask();
    const child = await newTask(root.id, 'awaiting_approval');
    const e = await approvals.request({ taskId: child.id, reason: 'estimated cost 2.00 USD', estCostUsd: 2, requestedBy: hq });
    expect(await approvals.treeCap(root.id)).toBe(0.5); // pending does not count
    await approvals.decide(e.id, 'approved', admin);
    expect(await approvals.treeCap(root.id)).toBeCloseTo(2.5, 6);
    const r1 = await budget.reserve({ actor: hq, taskId: child.id, estUsd: 1.5 });
    expect(r1.ok).toBe(true);
    if (r1.ok) await budget.settle(r1.reservationId, 1.5);
    const r2 = await budget.reserve({ actor: hq, taskId: child.id, estUsd: 0.9 });
    expect(r2.ok).toBe(true); // 2.40 of 2.50
    const r3 = await budget.reserve({ actor: hq, taskId: child.id, estUsd: 0.2 });
    expect(r3).toMatchObject({ ok: false, scope: 'task' }); // past 2.50
    expect(requested).toHaveLength(1);
  });

  it('R33: the cap is the larger of the approved tree cap and taskUsd plus approved estimates', async () => {
    const { approvals } = mk();
    const root = await newTask();
    const hit = (await approvals.onTreeCapHit({ rootId: root.id, est: 1.5, requestedBy: hq }))!;
    await approvals.decide(hit.id, 'approved', admin);
    expect(await approvals.treeCap(root.id)).toBeCloseTo(1.5, 6);
    for (const est of [1.2, 1.3]) {
      const c = await newTask(root.id);
      const a = await approvals.request({ taskId: c.id, reason: 'x', estCostUsd: est, requestedBy: hq });
      await approvals.decide(a.id, 'approved', admin);
    }
    const rejected = await newTask(root.id);
    const r = await approvals.request({ taskId: rejected.id, reason: 'x', estCostUsd: 9, requestedBy: hq });
    await approvals.decide(r.id, 'rejected', admin);
    expect(await approvals.treeCap(root.id)).toBeCloseTo(0.5 + 1.2 + 1.3, 6);
  });

  it('an approved estimate approval never lowers the tree cap', async () => {
    const { approvals } = mk();
    const root = await newTask();
    const hit = (await approvals.onTreeCapHit({ rootId: root.id, est: 5, requestedBy: hq }))!;
    expect(hit.estCostUsd).toBeCloseTo(5, 6);
    await approvals.decide(hit.id, 'approved', admin);
    const child = await newTask(root.id);
    const e = await approvals.request({ taskId: child.id, reason: 'x', estCostUsd: 1.2, requestedBy: hq });
    await approvals.decide(e.id, 'approved', admin);
    expect(await approvals.treeCap(root.id)).toBeCloseTo(5, 6);
  });

  it('rejected tree-cap request blocks further hits: no new approval, requester blocked', async () => {
    const { approvals, requested } = mk();
    const root = await newTask();
    const c1 = await newTask(root.id);
    const c2 = await newTask(root.id);
    const a = (await approvals.onTreeCapHit({ rootId: root.id, taskId: c1.id, est: 0, requestedBy: hq }))!;
    await approvals.decide(a.id, 'rejected', admin);
    expect(await approvals.onTreeCapHit({ rootId: root.id, taskId: c2.id, est: 0, requestedBy: hq })).toBeNull();
    expect((await tasks.get(c2.id))!.status).toBe('blocked');
    expect(requested).toHaveLength(1);
    expect((await db.pool.query('SELECT 1 FROM approvals')).rowCount).toBe(1);
  });

  it('request on a cancelled task is refused and does not revive it', async () => {
    const { approvals } = mk();
    const t = await newTask();
    await tasks.update(t.id, { status: 'cancelled' });
    await expect(approvals.request({ taskId: t.id, reason: 'x', estCostUsd: 2, requestedBy: hq })).rejects.toThrow();
    expect((await tasks.get(t.id))!.status).toBe('cancelled');
    expect((await db.pool.query('SELECT 1 FROM approvals')).rowCount).toBe(0);
  });

  it('cap hit while the root is doing leaves the root doing; only the requester awaits', async () => {
    const { approvals, ready } = mk();
    const root = await newTask();
    await tasks.update(root.id, { status: 'doing' });
    const child = await newTask(root.id);
    const a = (await approvals.onTreeCapHit({ rootId: root.id, taskId: child.id, est: 0, requestedBy: hq }))!;
    expect(a.taskId).toBe(child.id);
    expect((await tasks.get(root.id))!.status).toBe('doing');
    expect((await tasks.get(child.id))!.status).toBe('awaiting_approval');
    await approvals.decide(a.id, 'approved', admin);
    expect((await tasks.get(child.id))!.status).toBe('todo');
    expect(ready).toEqual([{ taskId: child.id }]);
  });

  it('cap hit on a finished root returns null and does not revive it', async () => {
    const { approvals } = mk();
    const root = await newTask();
    await tasks.update(root.id, { status: 'done' });
    expect(await approvals.onTreeCapHit({ rootId: root.id, est: 0, requestedBy: hq })).toBeNull();
    expect((await tasks.get(root.id))!.status).toBe('done');
  });

  it('8 concurrent reserves against a pool of max 2 complete (taskCap uses the reserve client)', async () => {
    const small = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2, options: (db.pool as unknown as { options: { options: string } }).options.options });
    try {
      const cfg = new FakeConfig({ 'limits.localUnlimited': false, 'budget.botDailyUsd': 1000, 'budget.companyDailyUsd': 1000, 'budget.taskUsd': 1000 });
      const bus = new EventBus<AppEvents>();
      const approvals = new Approvals(small, tasks, cfg, bus, new FakeHalt(), async () => undefined);
      const budget = new Budget(small, cfg, bus, () => NOW, { taskCap: (id, c) => approvals.treeCap(id, c) });
      const root = await newTask();
      const rs = await Promise.race([
        Promise.all(Array.from({ length: 8 }, () => budget.reserve({ actor: hq, taskId: root.id, estUsd: 0.01 }))),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('deadlock')), 5000)),
      ]);
      expect(rs.every((r) => r.ok)).toBe(true);
    } finally {
      await small.end();
    }
  }, 10000);

  const waiters = async (approvals: Approvals) => {
    const root = await newTask();
    const c1 = await newTask(root.id);
    const c2 = await newTask(root.id);
    const a = (await approvals.onTreeCapHit({ rootId: root.id, taskId: c1.id, est: 0, requestedBy: hq }))!;
    const b = (await approvals.onTreeCapHit({ rootId: root.id, taskId: c2.id, est: 0, requestedBy: hq }))!;
    expect(b.id).toBe(a.id);
    expect((await tasks.get(c2.id))!.status).toBe('awaiting_approval');
    return { a, c1, c2 };
  };

  it('approve resumes every waiter of the tree', async () => {
    const { approvals, ready } = mk();
    const { a, c1, c2 } = await waiters(approvals);
    await approvals.decide(a.id, 'approved', admin);
    expect((await tasks.get(c1.id))!.status).toBe('todo');
    expect((await tasks.get(c2.id))!.status).toBe('todo');
    expect(ready.map((r) => (r as { taskId: string }).taskId).sort()).toEqual([c1.id, c2.id].sort());
  });

  it('reject blocks the other waiters', async () => {
    const { approvals, ready } = mk();
    const { a, c1, c2 } = await waiters(approvals);
    await approvals.decide(a.id, 'rejected', admin);
    expect((await tasks.get(c1.id))!.status).toBe('cancelled');
    expect((await tasks.get(c2.id))!.status).toBe('blocked');
    expect(ready).toEqual([]);
  });

  it('expiry blocks the other waiters', async () => {
    const { approvals } = mk();
    const { a, c1, c2 } = await waiters(approvals);
    await db.pool.query("UPDATE approvals SET created_at = now() - interval '25 hours' WHERE id = $1", [a.id]);
    expect(await approvals.expireOld()).toBe(1);
    expect((await tasks.get(c1.id))!.status).toBe('cancelled');
    expect((await tasks.get(c2.id))!.status).toBe('blocked');
  });

  it('halted approve then resumeApproved resumes both waiters', async () => {
    const { approvals, halt, ready } = mk();
    const { a, c1, c2 } = await waiters(approvals);
    halt.halted = true;
    await approvals.decide(a.id, 'approved', admin);
    expect(ready).toEqual([]);
    expect((await tasks.get(c2.id))!.status).toBe('awaiting_approval');
    halt.halted = false;
    expect(await approvals.resumeApproved()).toBe(2);
    expect((await tasks.get(c1.id))!.status).toBe('todo');
    expect((await tasks.get(c2.id))!.status).toBe('todo');
    expect(ready.map((r) => (r as { taskId: string }).taskId).sort()).toEqual([c1.id, c2.id].sort());
  });

  it.each(['approved', 'rejected'] as const)('concurrent waiter enrolment and %s decide never orphans a task', async (decision) => {
    const { approvals } = mk();
    for (let i = 0; i < 20; i++) {
      await db.pool.query('DELETE FROM approvals');
      await db.pool.query('DELETE FROM tasks');
      const root = await newTask();
      const c1 = await newTask(root.id);
      const c2 = await newTask(root.id);
      const a = (await approvals.onTreeCapHit({ rootId: root.id, taskId: c1.id, est: 0, requestedBy: hq }))!;
      await Promise.all([
        approvals.onTreeCapHit({ rootId: root.id, taskId: c2.id, est: 0, requestedBy: hq }),
        approvals.decide(a.id, decision, admin),
      ]);
      const orphans = await db.pool.query(
        `SELECT t.id FROM tasks t WHERE t.status = 'awaiting_approval'
           AND NOT EXISTS (SELECT 1 FROM approvals p WHERE p.status = 'pending' AND p.task_id IN (SELECT id FROM tasks WHERE root_id = t.root_id))`,
      );
      expect(orphans.rows).toEqual([]);
    }
  });
});

describe('task.changed mirroring (final #4)', () => {
  /** Records task.changed and checks the change is already committed when the event fires (emitted after COMMIT). */
  const watch = (bus: EventBus<AppEvents>) => {
    const seen: { id: string; from: string; to: string; reason: string | null; committed: string | undefined }[] = [];
    bus.on('task.changed', async (e) => {
      seen.push({ id: e.task.id, from: e.from, to: e.to, reason: e.task.blockedReason, committed: (await tasks.get(e.task.id))?.status });
    });
    return seen;
  };
  const tidy = (s: ReturnType<typeof watch>) => [...s].sort((a, b) => a.id.localeCompare(b.id) || a.to.localeCompare(b.to));

  it('request, approve and reject emit task.changed after COMMIT; approve also emits task.ready', async () => {
    const { approvals, bus, ready } = mk();
    const seen = watch(bus);
    const t1 = await newTask();
    await tasks.update(t1.id, { status: 'doing' });
    const a1 = await approvals.request({ taskId: t1.id, reason: 'x', estCostUsd: 2, requestedBy: hq });
    await approvals.decide(a1.id, 'approved', admin);
    const t2 = await newTask();
    const a2 = await approvals.request({ taskId: t2.id, reason: 'x', estCostUsd: 2, requestedBy: hq });
    await approvals.decide(a2.id, 'rejected', admin);
    expect(seen).toEqual([
      { id: t1.id, from: 'doing', to: 'awaiting_approval', reason: null, committed: 'awaiting_approval' },
      { id: t1.id, from: 'awaiting_approval', to: 'todo', reason: null, committed: 'todo' },
      { id: t2.id, from: 'todo', to: 'awaiting_approval', reason: null, committed: 'awaiting_approval' },
      { id: t2.id, from: 'awaiting_approval', to: 'cancelled', reason: null, committed: 'cancelled' },
    ]);
    expect(ready).toEqual([{ taskId: t1.id }]);
  });

  it('reject of a tree-cap approval cancels the requester and blocks the waiters with reason approval', async () => {
    const { approvals, bus } = mk();
    const root = await newTask();
    const c1 = await newTask(root.id);
    const c2 = await newTask(root.id);
    const a = (await approvals.onTreeCapHit({ rootId: root.id, taskId: c1.id, est: 0, requestedBy: hq }))!;
    await approvals.onTreeCapHit({ rootId: root.id, taskId: c2.id, est: 0, requestedBy: hq });
    const seen = watch(bus);
    await approvals.decide(a.id, 'rejected', admin);
    expect(tidy(seen)).toEqual(tidy([
      { id: c1.id, from: 'awaiting_approval', to: 'cancelled', reason: null, committed: 'cancelled' },
      { id: c2.id, from: 'awaiting_approval', to: 'blocked', reason: 'approval', committed: 'blocked' },
    ]));
  });

  it('expireOld emits the cancelled requester and the blocked waiters', async () => {
    const { approvals, bus } = mk();
    const root = await newTask();
    const c1 = await newTask(root.id);
    const c2 = await newTask(root.id);
    const a = (await approvals.onTreeCapHit({ rootId: root.id, taskId: c1.id, est: 0, requestedBy: hq }))!;
    await approvals.onTreeCapHit({ rootId: root.id, taskId: c2.id, est: 0, requestedBy: hq });
    await db.pool.query("UPDATE approvals SET created_at = now() - interval '25 hours' WHERE id = $1", [a.id]);
    const seen = watch(bus);
    expect(await approvals.expireOld()).toBe(1);
    expect(tidy(seen)).toEqual(tidy([
      { id: c1.id, from: 'awaiting_approval', to: 'cancelled', reason: null, committed: 'cancelled' },
      { id: c2.id, from: 'awaiting_approval', to: 'blocked', reason: 'approval', committed: 'blocked' },
    ]));
  });

  it('onTreeCapHit emits the requester change; a refused hit blocks it with reason budget', async () => {
    const { approvals, bus } = mk();
    const root = await newTask();
    const c1 = await newTask(root.id);
    await tasks.update(c1.id, { status: 'doing' });
    const c2 = await newTask(root.id);
    await tasks.update(c2.id, { status: 'doing' });
    const seen = watch(bus);
    const a = (await approvals.onTreeCapHit({ rootId: root.id, taskId: c1.id, est: 0, requestedBy: hq }))!;
    await approvals.decide(a.id, 'rejected', admin);
    seen.length = 0;
    expect(await approvals.onTreeCapHit({ rootId: root.id, taskId: c2.id, est: 0, requestedBy: hq })).toBeNull();
    expect(seen).toEqual([{ id: c2.id, from: 'doing', to: 'blocked', reason: 'budget', committed: 'blocked' }]);
  });

  it('resumeApproved emits task.changed then task.ready', async () => {
    const { approvals, bus, halt, ready } = mk();
    const t = await newTask();
    const a = await approvals.request({ taskId: t.id, reason: 'x', estCostUsd: 2, requestedBy: hq });
    halt.halted = true;
    await approvals.decide(a.id, 'approved', admin);
    halt.halted = false;
    const seen = watch(bus);
    await approvals.resumeApproved();
    expect(seen).toEqual([{ id: t.id, from: 'awaiting_approval', to: 'todo', reason: null, committed: 'todo' }]);
    expect(ready).toEqual([{ taskId: t.id }]);
  });
});

describe('Approvals: per-root local call cap (Gate 1 L8)', () => {
  const LOCAL = 'claude-code-local';
  const mkLocal = (perTask = 2) => {
    const base = mk({ 'limits.localCallsPerTask': perTask });
    const budget = new Budget(db.pool, base.cfg, base.bus, () => NOW, {
      taskCap: (id, c) => base.approvals.treeCap(id, c), localCap: (id, c) => base.approvals.localCap(id, c),
    });
    const local = (taskId: string) => budget.reserve({ actor: hq, taskId, estUsd: 0, model: 'local/claude-sonnet-5-5', provider: LOCAL });
    return { ...base, budget, local };
  };

  it('local cap hit awaits approval; approval raises the cap by localCallsPerTask and it never decreases', async () => {
    const { approvals, local, requested, cfg } = mkLocal(2);
    const root = await newTask();
    expect(await approvals.localCap(root.id)).toBe(2);
    expect((await local(root.id)).ok).toBe(true);
    expect((await local(root.id)).ok).toBe(true);
    expect(await local(root.id)).toEqual({ ok: false, scope: 'local_task' });
    const a = (await approvals.onLocalCapHit({ rootId: root.id, requestedBy: hq }))!;
    expect(a).toMatchObject({ status: 'pending', taskId: root.id, estCostUsd: null });
    expect(a.reason).toMatch(/local call cap reached 2 calls/);
    expect(requested).toEqual([a]);
    expect((await tasks.get(root.id))!.status).toBe('awaiting_approval');
    // A second hit while pending joins the same approval.
    const child = await newTask(root.id);
    expect((await approvals.onLocalCapHit({ rootId: root.id, taskId: child.id, requestedBy: hq }))!.id).toBe(a.id);
    expect((await tasks.get(child.id))!.status).toBe('awaiting_approval');
    await approvals.decide(a.id, 'approved', admin);
    expect((await tasks.get(root.id))!.status).toBe('todo');
    expect((await tasks.get(child.id))!.status).toBe('todo'); // the waiter is released too
    expect(await approvals.localCap(root.id)).toBe(4);
    expect((await local(root.id)).ok).toBe(true);
    cfg.values.set('limits.localCallsPerTask', 1);
    expect(await approvals.localCap(root.id)).toBe(4); // lowering the default never lowers an approved cap
    cfg.values.set('limits.localCallsPerTask', 10);
    expect(await approvals.localCap(root.id)).toBe(10);
  });

  it('a pending USD tree-cap approval does not absorb a local cap hit (kinds are separate)', async () => {
    const { approvals } = mkLocal(1);
    const root = await newTask();
    const usd = (await approvals.onTreeCapHit({ rootId: root.id, est: 0, requestedBy: hq }))!;
    const child = await newTask(root.id);
    const loc = (await approvals.onLocalCapHit({ rootId: root.id, taskId: child.id, requestedBy: hq }))!;
    expect(loc.id).not.toBe(usd.id);
    await approvals.decide(usd.id, 'approved', admin);
    expect(await approvals.localCap(root.id)).toBe(1); // a USD cap approval does not raise the call cap
    expect((await tasks.get(child.id))!.status).toBe('awaiting_approval');
  });

  it('a rejected local cap request blocks further hits; expiry also blocks waiters', async () => {
    const { approvals } = mkLocal(1);
    const root = await newTask();
    const c1 = await newTask(root.id);
    const c2 = await newTask(root.id);
    const a = (await approvals.onLocalCapHit({ rootId: root.id, taskId: c1.id, requestedBy: hq }))!;
    await approvals.onLocalCapHit({ rootId: root.id, taskId: c2.id, requestedBy: hq });
    await approvals.decide(a.id, 'rejected', admin);
    expect((await tasks.get(c1.id))!.status).toBe('cancelled');
    expect((await tasks.get(c2.id))!).toMatchObject({ status: 'blocked', blockedReason: 'approval' });
    expect(await approvals.onLocalCapHit({ rootId: root.id, requestedBy: hq })).toBeNull();
    expect((await tasks.get(root.id))!).toMatchObject({ status: 'blocked', blockedReason: 'budget' });

    const r2 = await newTask();
    const w = await newTask(r2.id);
    await approvals.onLocalCapHit({ rootId: r2.id, requestedBy: hq });
    await approvals.onLocalCapHit({ rootId: r2.id, taskId: w.id, requestedBy: hq });
    await db.pool.query("UPDATE approvals SET created_at = now() - interval '25 hours' WHERE status = 'pending'");
    expect(await approvals.expireOld()).toBe(1);
    expect((await tasks.get(w.id))!).toMatchObject({ status: 'blocked', blockedReason: 'approval' });
  });

  it('halted approval of a local cap is released by resumeApproved with its waiters', async () => {
    const { approvals, halt } = mkLocal(1);
    const root = await newTask();
    const c = await newTask(root.id);
    const a = (await approvals.onLocalCapHit({ rootId: root.id, requestedBy: hq }))!;
    await approvals.onLocalCapHit({ rootId: root.id, taskId: c.id, requestedBy: hq });
    halt.halted = true;
    await approvals.decide(a.id, 'approved', admin);
    expect((await tasks.get(c.id))!.status).toBe('awaiting_approval');
    halt.halted = false;
    expect(await approvals.resumeApproved()).toBe(2);
    expect((await tasks.get(c.id))!.status).toBe('todo');
  });
});

describe('Approvals: cap waiters are scoped to the approval they joined (fix round 1)', () => {
  const mkBoth = () => {
    const base = mk({ 'limits.localCallsPerTask': 1 });
    return base;
  };
  /** Root with a pending USD tree-cap request (by c1) and a pending local-cap request (by c2), plus one waiter of each. */
  async function twoCaps(approvals: Approvals) {
    const root = await newTask();
    const [c1, c2, wUsd, wLocal] = [await newTask(root.id), await newTask(root.id), await newTask(root.id), await newTask(root.id)];
    const usd = (await approvals.onTreeCapHit({ rootId: root.id, taskId: c1.id, est: 0, requestedBy: hq }))!;
    const loc = (await approvals.onLocalCapHit({ rootId: root.id, taskId: c2.id, requestedBy: hq }))!;
    expect((await approvals.onTreeCapHit({ rootId: root.id, taskId: wUsd.id, est: 0, requestedBy: hq }))!.id).toBe(usd.id);
    expect((await approvals.onLocalCapHit({ rootId: root.id, taskId: wLocal.id, requestedBy: hq }))!.id).toBe(loc.id);
    return { root, c1, c2, wUsd, wLocal, usd, loc };
  }
  const status = async (id: string) => (await tasks.get(id))!.status;

  it('rejecting the USD cap leaves a local-cap waiter awaiting; approving the local cap then releases it', async () => {
    const { approvals } = mkBoth();
    const t = await twoCaps(approvals);
    await approvals.decide(t.usd.id, 'rejected', admin);
    expect(await status(t.c1.id)).toBe('cancelled');
    expect((await tasks.get(t.wUsd.id))!).toMatchObject({ status: 'blocked', blockedReason: 'approval' });
    expect(await status(t.c2.id)).toBe('awaiting_approval');
    expect(await status(t.wLocal.id)).toBe('awaiting_approval');
    await approvals.decide(t.loc.id, 'approved', admin);
    expect(await status(t.c2.id)).toBe('todo');
    expect(await status(t.wLocal.id)).toBe('todo');
  });

  it('rejecting the local cap leaves a USD-cap waiter awaiting; approving the USD cap then releases it', async () => {
    const { approvals } = mkBoth();
    const t = await twoCaps(approvals);
    await approvals.decide(t.loc.id, 'rejected', admin);
    expect(await status(t.c2.id)).toBe('cancelled');
    expect((await tasks.get(t.wLocal.id))!).toMatchObject({ status: 'blocked', blockedReason: 'approval' });
    expect(await status(t.wUsd.id)).toBe('awaiting_approval');
    await approvals.decide(t.usd.id, 'approved', admin);
    expect(await status(t.wUsd.id)).toBe('todo');
  });

  it('approving one kind does not release waiters of the other, still pending, kind', async () => {
    const { approvals } = mkBoth();
    const t = await twoCaps(approvals);
    await approvals.decide(t.usd.id, 'approved', admin);
    expect(await status(t.wUsd.id)).toBe('todo');
    expect(await status(t.wLocal.id)).toBe('awaiting_approval');
  });

  it('expiry of one kind blocks only its own waiters', async () => {
    const { approvals } = mkBoth();
    const t = await twoCaps(approvals);
    await db.pool.query("UPDATE approvals SET created_at = now() - interval '25 hours' WHERE id = $1", [t.usd.id]);
    expect(await approvals.expireOld()).toBe(1);
    expect((await tasks.get(t.wUsd.id))!).toMatchObject({ status: 'blocked', blockedReason: 'approval' });
    expect(await status(t.wLocal.id)).toBe('awaiting_approval');
  });

  it('resumeApproved does not release a waiter of a still-pending other-kind cap', async () => {
    const { approvals, halt } = mkBoth();
    const t = await twoCaps(approvals);
    halt.halted = true;
    await approvals.decide(t.usd.id, 'approved', admin);
    halt.halted = false;
    expect(await approvals.resumeApproved()).toBe(2); // the USD requester and its waiter
    expect(await status(t.c1.id)).toBe('todo');
    expect(await status(t.wUsd.id)).toBe('todo');
    expect(await status(t.wLocal.id)).toBe('awaiting_approval');
    expect(await status(t.c2.id)).toBe('awaiting_approval');
  });
});

describe('tool approvals (R4, P3)', () => {
  const toolReq = (m: ReturnType<typeof mk>, taskId: string, input: unknown = { id: 'X', repo: 'o/r' }, name = 'delete_item') =>
    m.approvals.request({ kind: 'tool', tool: { name, input }, taskId, reason: `delete ${name}`, estCostUsd: 0, requestedBy: hq });
  /** The `run` claims only, in the shape the T12 tests assert (claimToolOutcomes also settles rejected/expired rows). */
  const claimRun = async (m: ReturnType<typeof mk>, taskId: string) =>
    (await m.approvals.claimToolOutcomes(taskId)).flatMap((c) => (c.kind === 'run' ? [{ approvalId: c.approvalId, name: c.name, input: c.input }] : []));
  const approve = async (m: ReturnType<typeof mk>, id: number) => {
    const r = await m.approvals.decide(id, 'approved', admin);
    expect(r.ok).toBe(true);
  };

  it('tool approval row stores name and validated input as canonical JSON with its sha256', async () => {
    const m = mk();
    const t = await newTask();
    const a = await toolReq(m, t.id, { repo: 'o/r', id: 'X', n: { b: 1, a: 2 } });
    expect(a).toMatchObject({ status: 'pending', toolName: 'delete_item', toolInput: { id: 'X', n: { a: 2, b: 1 }, repo: 'o/r' } });
    const row = (await db.pool.query<{ kind: string; tool_input_text: string; input_sha256: string; executed_at: Date | null }>(
      'SELECT kind, tool_input::text AS tool_input_text, input_sha256, executed_at FROM approvals WHERE id = $1', [a.id])).rows[0]!;
    expect(row.kind).toBe('tool');
    expect(row.executed_at).toBeNull();
    expect(row.input_sha256).toBe(inputDigest(canonicalJson({ id: 'X', n: { a: 2, b: 1 }, repo: 'o/r' })));
    expect(a.inputSha256).toBe(row.input_sha256);
    expect((await tasks.get(t.id))!.status).toBe('awaiting_approval');
    expect(m.requested).toEqual([a]);
  });

  it('a tool request needs a name and a JSON-able input', async () => {
    const m = mk();
    const t = await newTask();
    await expect(toolReq(m, t.id, { n: Number.NaN })).rejects.toThrow();
    await expect(toolReq(m, t.id, {}, '')).rejects.toThrow();
    expect((await tasks.get(t.id))!.status).toBe('todo');
  });

  it('an approved row is claimed once; second claim empty', async () => {
    const m = mk();
    const t = await newTask();
    const a = await toolReq(m, t.id);
    await approve(m, a.id);
    expect(await claimRun(m, t.id)).toEqual([{ approvalId: a.id, name: 'delete_item', input: { id: 'X', repo: 'o/r' } }]);
    expect(await claimRun(m, t.id)).toEqual([]);
  });

  it('two concurrent claimers: exactly one gets it', async () => {
    const m = mk();
    const t = await newTask();
    await approve(m, (await toolReq(m, t.id)).id);
    const got = await Promise.all(Array.from({ length: 6 }, () => claimRun(m, t.id)));
    expect(got.filter((g) => g.length === 1)).toHaveLength(1);
    expect(got.flat()).toHaveLength(1);
  });

  it('pending/rejected/expired rows are never claimed', async () => {
    const m = mk();
    const [p, r, e] = [await newTask(), await newTask(), await newTask()];
    await toolReq(m, p.id);
    await m.approvals.decide((await toolReq(m, r.id)).id, 'rejected', admin);
    const ex = await toolReq(m, e.id);
    await db.pool.query("UPDATE approvals SET created_at = now() - interval '100 hours' WHERE id = $1", [ex.id]);
    expect(await m.approvals.expireOld()).toBe(1);
    for (const t of [p, r, e]) expect(await claimRun(m, t.id)).toEqual([]);
  });

  it('non-tool approvals are never claimed', async () => {
    const m = mk();
    const t = await newTask();
    const a = await m.approvals.request({ taskId: t.id, reason: 'big', estCostUsd: 2, requestedBy: hq });
    await approve(m, a.id);
    expect(await claimRun(m, t.id)).toEqual([]);
  });

  it("claim is per task (another task's approval not returned)", async () => {
    const m = mk();
    const [a, b] = [await newTask(), await newTask()];
    const ra = await toolReq(m, a.id);
    await approve(m, ra.id);
    await approve(m, (await toolReq(m, b.id, { id: 'B' })).id);
    expect(await claimRun(m, a.id)).toEqual([expect.objectContaining({ approvalId: ra.id })]);
    expect(await claimRun(m, b.id)).toEqual([expect.objectContaining({ input: { id: 'B' } })]);
  });

  it('approved delete X cannot run delete Y', async () => {
    const m = mk();
    const t = await newTask();
    const a = await toolReq(m, t.id, { id: 'X' });
    await approve(m, a.id);
    await db.pool.query(`UPDATE approvals SET tool_input = '{"id":"Y"}'::jsonb WHERE id = $1`, [a.id]);
    expect(await claimRun(m, t.id)).toEqual([]);
    expect(m.audits).toContainEqual(expect.objectContaining({ action: 'approval.claim', outcome: 'digest_mismatch', taskId: t.id }));
    // a second approval for Y is a new request with its own digest
    const y = await toolReq(m, t.id, { id: 'Y' });
    await approve(m, y.id);
    expect(await claimRun(m, t.id)).toEqual([expect.objectContaining({ approvalId: y.id, input: { id: 'Y' } })]);
  });

  it('digest reuse refused (executed digest, or stored input whose sha256 no longer matches)', async () => {
    const m = mk();
    const t = await newTask();
    const a = await toolReq(m, t.id, { id: 'X' });
    await approve(m, a.id);
    expect(await claimRun(m, t.id)).toHaveLength(1);
    await db.pool.query('UPDATE approvals SET status = $2 WHERE id = $1', [a.id, 'approved']); // replay attempt
    expect(await claimRun(m, t.id)).toEqual([]);
    const b = await toolReq(m, t.id, { id: 'X' });
    await approve(m, b.id);
    await db.pool.query("UPDATE approvals SET input_sha256 = $2 WHERE id = $1", [b.id, inputDigest(canonicalJson({ id: 'Z' }))]);
    expect(await claimRun(m, t.id)).toEqual([]);
    expect(m.audits.filter((e) => e.outcome === 'digest_mismatch')).toHaveLength(1);
  });

  it('nothing is claimed while halted and the claim is not consumed', async () => {
    const m = mk();
    const t = await newTask();
    const a = await toolReq(m, t.id);
    m.halt.halted = true;
    await approve(m, a.id);
    expect(await claimRun(m, t.id)).toEqual([]);
    expect((await db.pool.query('SELECT executed_at FROM approvals WHERE id = $1', [a.id])).rows[0]!.executed_at).toBeNull();
    m.halt.halted = false;
    expect(await claimRun(m, t.id)).toEqual([expect.objectContaining({ approvalId: a.id })]);
  });

  it('claimToolOutcomes settles approved, rejected, expired and tampered rows once each; pending stays', async () => {
    const m = mk();
    const t = await newTask();
    const ok = await toolReq(m, t.id, { id: 'A' });
    const rej = await toolReq(m, t.id, { id: 'B' });
    const exp = await toolReq(m, t.id, { id: 'C' });
    const bad = await toolReq(m, t.id, { id: 'D' });
    const pend = await toolReq(m, t.id, { id: 'E' });
    await m.approvals.decide(rej.id, 'rejected', admin);
    await db.pool.query("UPDATE approvals SET created_at = now() - interval '100 hours' WHERE id = $1", [exp.id]);
    await m.approvals.expireOld();
    await approve(m, ok.id);
    await approve(m, bad.id);
    await db.pool.query(`UPDATE approvals SET tool_input = '{"id":"Z"}'::jsonb WHERE id = $1`, [bad.id]);
    const got = await m.approvals.claimToolOutcomes(t.id);
    expect(got.map(({ claimedAt: _c, ...g }) => g)).toEqual([
      { kind: 'run', approvalId: ok.id, name: 'delete_item', input: { id: 'A' } },
      { kind: 'refused', approvalId: rej.id, name: 'delete_item', why: 'rejected' },
      { kind: 'refused', approvalId: exp.id, name: 'delete_item', why: 'expired' },
      { kind: 'refused', approvalId: bad.id, name: 'delete_item', why: 'digest_mismatch' },
    ]);
    expect(m.audits).toContainEqual(expect.objectContaining({ action: 'approval.claim', outcome: 'digest_mismatch', taskId: t.id }));
    expect(await m.approvals.claimToolOutcomes(t.id)).toEqual([]);
    expect((await db.pool.query('SELECT executed_at FROM approvals WHERE id = $1', [pend.id])).rows[0]!.executed_at).toBeNull();
  });

  it('contract (a): unclaimTool clears only its own claim, and the row is claimable again', async () => {
    const m = mk();
    const t = await newTask();
    const a = await toolReq(m, t.id);
    await approve(m, a.id);
    const [c] = await m.approvals.claimToolOutcomes(t.id);
    expect(c).toMatchObject({ kind: 'run', approvalId: a.id });
    expect(await m.approvals.unclaimTool({ ...c!, claimedAt: '2000-01-01 00:00:00+00' })).toBe(false);
    expect(await m.approvals.claimToolOutcomes(t.id)).toEqual([]);
    expect(await m.approvals.unclaimTool(c!)).toBe(true);
    expect(await m.approvals.unclaimTool(c!)).toBe(false); // the claim is gone; a second un-claim is a no-op
    expect(await m.approvals.claimToolOutcomes(t.id)).toEqual([expect.objectContaining({ kind: 'run', approvalId: a.id })]);
  });

  it('M2: a tampered (digest mismatch) row is never un-claimed, even with a forged run claim (checked in SQL)', async () => {
    const m = mk();
    const t = await newTask();
    const a = await toolReq(m, t.id, { id: 'X' });
    await approve(m, a.id);
    await db.pool.query(`UPDATE approvals SET tool_input = '{"id":"Y"}'::jsonb WHERE id = $1`, [a.id]);
    const [c] = await m.approvals.claimToolOutcomes(t.id);
    expect(c).toMatchObject({ kind: 'refused', why: 'digest_mismatch' });
    expect(await m.approvals.unclaimTool(c!)).toBe(false);
    expect(await m.approvals.unclaimTool({ kind: 'run', approvalId: a.id, name: 'delete_item', input: { id: 'Y' }, claimedAt: c!.claimedAt })).toBe(false);
    expect(await m.approvals.claimToolOutcomes(t.id)).toEqual([]);
  });

  it('a stored result stays pending until marked delivered, and a row with a result is never un-claimed', async () => {
    const m = mk();
    const t = await newTask();
    const a = await toolReq(m, t.id, { id: 'A' });
    const r = await toolReq(m, t.id, { id: 'R' });
    await m.approvals.decide(r.id, 'rejected', admin);
    await approve(m, a.id);
    const claims = await m.approvals.claimToolOutcomes(t.id);
    const run = claims.find((c) => c.kind === 'run')!;
    expect(await m.approvals.storeToolResult(run, 'ran:\nok')).toBe(true);
    expect(await m.approvals.storeToolResult(run, 'ran:\nagain')).toBe(false); // stored once
    expect(await m.approvals.unclaimTool(run)).toBe(false); // it ran: never released for a re-run
    const want = [
      { approvalId: a.id, name: 'delete_item', state: 'result', text: 'ran:\nok' },
      { approvalId: r.id, name: 'delete_item', state: 'rejected', text: null },
    ];
    expect(await m.approvals.pendingToolDeliveries(t.id)).toEqual(want);
    expect(await m.approvals.pendingToolDeliveries(t.id)).toEqual(want); // reading does not consume
    await m.approvals.markToolsDelivered([a.id, r.id]);
    expect(await m.approvals.pendingToolDeliveries(t.id)).toEqual([]);
    expect(await m.approvals.claimToolOutcomes(t.id)).toEqual([]);
  });

  it('M3: a claimed call with no recorded outcome is reported as interrupted (not a mismatch), never claimable again', async () => {
    const m = mk();
    const t = await newTask();
    const a = await toolReq(m, t.id, { id: 'A' });
    const b = await toolReq(m, t.id, { id: 'B' });
    await approve(m, a.id);
    await approve(m, b.id);
    await m.approvals.claimToolOutcomes(t.id); // the process "crashes" before running or storing either
    await db.pool.query(`UPDATE approvals SET tool_input = '{"id":"Z"}'::jsonb WHERE id = $1`, [b.id]);
    expect(await m.approvals.interruptedToolCalls()).toEqual([{ approvalId: a.id, taskId: t.id, name: 'delete_item' }]);
    expect((await m.approvals.pendingToolDeliveries(t.id)).map((d) => d.state)).toEqual(['interrupted', 'digest_mismatch']);
    expect(await m.approvals.claimToolOutcomes(t.id)).toEqual([]);
    await m.approvals.markToolsDelivered([a.id, b.id]);
    expect(await m.approvals.interruptedToolCalls()).toEqual([]);
  });

  it('interruptedToolCalls skips rows of a done or cancelled task (the boot alert does not repeat forever)', async () => {
    const m = mk();
    const open = await newTask();
    const closed = await newTask();
    const a = await toolReq(m, open.id, { id: 'A' });
    const b = await toolReq(m, closed.id, { id: 'B' });
    await approve(m, a.id);
    await approve(m, b.id);
    await m.approvals.claimToolOutcomes(open.id);
    await m.approvals.claimToolOutcomes(closed.id);
    expect((await m.approvals.interruptedToolCalls()).map((x) => x.approvalId)).toEqual([a.id, b.id]);
    for (const status of ['done', 'cancelled']) {
      await db.pool.query('UPDATE tasks SET status = $2 WHERE id = $1', [closed.id, status]);
      expect(await m.approvals.interruptedToolCalls()).toEqual([{ approvalId: a.id, taskId: open.id, name: 'delete_item' }]);
    }
  });

  it('mention-chat approval creates a depth-0 root task and is not refused', async () => {
    const m = mk();
    await new DepartmentRepo(db.pool).upsert({ id: 'praw', name: 'Praw', categoryNamePattern: '', workChannelId: null, color: 0, model: null, provider: null, enabled: true });
    const conv = createConversation({
      tasks, port: { createThread: async () => 'thread1' }, bus: m.bus,
      limits: { checkOpenTasks: async () => true },
    });
    const task = await conv.open({
      actor: { kind: 'head', dept: 'praw' },
      msg: { author: { kind: 'human', id: 'u1' }, origin: 'chat', content: 'delete X', channelId: 'c1', threadId: null, parentChannelId: null } as never,
    });
    const a = await toolReq(m, task.id);
    expect(a.status).toBe('pending');
    const cur = (await tasks.get(task.id))!;
    expect(cur).toMatchObject({ depth: 0, rootId: task.id, status: 'awaiting_approval' });
  });
});


// ---- WEBGRANT-1: decideGrant (D6; W-C3b, W-C4, W-C8) ----
describe('decideGrant', () => {
  const mkGrant = (cfgInit: ConstructorParameters<typeof FakeConfig>[0] = {}) => {
    const cfg = new FakeConfig({ 'limits.localUnlimited': false, 'budget.botDailyUsd': 1000, 'budget.companyDailyUsd': 1000, ...cfgInit });
    const halt = new FakeHalt();
    const approvals = new Approvals(db.pool, tasks, cfg, new EventBus<AppEvents>(), halt, async () => undefined, [], undefined,
      { solo: (a) => soloShowsWhole(a, []), batch: (a) => compactItemFits(a, []) });
    return { cfg, halt, approvals };
  };
  const fetchReq = (approvals: Approvals, taskId: string, url = 'https://example.com/docs/intro', name = 'fetch_page', input: unknown = { url }) =>
    approvals.request({ taskId, reason: 'fetch_page after untrusted content, url not seen in this run', estCostUsd: 0, requestedBy: hq, kind: 'tool', tool: { name, input } });
  const grants = async () => (await db.pool.query('SELECT * FROM web_grants ORDER BY id')).rows;
  const status = async (id: number) => (await db.pool.query<{ status: string }>('SELECT status FROM approvals WHERE id = $1', [id])).rows[0]!.status;

  it('approves the call and creates the grant in one step: caps snapshotted from config, keyed by the tree root, approval stays replayable', async () => {
    const { approvals } = mkGrant({ 'web.taskGrant.maxFetches': 12, 'web.taskGrant.maxHosts': 3, 'web.taskGrant.maxUrlChars': 900, 'web.taskGrant.hours': 2 });
    const root = await newTask();
    const child = await newTask(root.id);
    const a = await fetchReq(approvals, child.id);
    const r = await approvals.decideGrant(a.id, { id: ADMIN_ID, isAdmin: true });
    expect(r.ok).toBe(true);
    const rows = await grants();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ root_id: root.id, approval_id: a.id, granted_by: ADMIN_ID, requested_by: 'head:hq', max_fetches: 12, max_hosts: 3, max_url_chars: 900, used: 0, url_chars_used: 0 });
    const hrs = (new Date(rows[0].expires_at).getTime() - new Date(rows[0].created_at).getTime()) / 3_600_000;
    expect(hrs).toBeCloseTo(2, 3);
    expect(r.ok && r.grant).toMatchObject({ id: Number(rows[0].id), rootId: root.id, maxFetches: 12, maxHosts: 3, maxUrlChars: 900 });
    expect(await status(a.id)).toBe('approved');
    expect((await tasks.get(child.id))!.status).toBe('todo');
    // the approved url still replays through the claim path (never consumed here)
    const claimed = await approvals.claimToolOutcomes(child.id);
    expect(claimed.map((c) => c.kind)).toEqual(['run']);
    expect((await grants())[0].used).toBe(0);
    // a live consume works on it
    expect((await new WebGrantRepo(db.pool).consume({ rootId: root.id, host: 'example.com', chars: 5 })).ok).toBe(true);
  });

  it('maxHosts is clamped to maxFetches in the snapshot (D4)', async () => {
    const { approvals } = mkGrant({ 'web.taskGrant.maxFetches': 3, 'web.taskGrant.maxHosts': 10 });
    const t = await newTask();
    await approvals.decideGrant((await fetchReq(approvals, t.id)).id, { id: ADMIN_ID, isAdmin: true });
    expect((await grants())[0]).toMatchObject({ max_fetches: 3, max_hosts: 3 });
  });

  it('a tampered input_sha256, a tampered tool_input and a cut url are not_grantable and leave the card pending (W-C4)', async () => {
    const { approvals } = mkGrant();
    const t = await newTask();
    const sha = await fetchReq(approvals, t.id);
    await db.pool.query("UPDATE approvals SET input_sha256 = $2 WHERE id = $1", [sha.id, 'f'.repeat(64)]);
    expect(await approvals.decideGrant(sha.id, { id: ADMIN_ID, isAdmin: true })).toEqual({ ok: false, error: 'not_grantable' });
    const inp = await fetchReq(approvals, t.id);
    await db.pool.query("UPDATE approvals SET tool_input = '{\"url\":\"https://evil.example.com/x\"}'::jsonb WHERE id = $1", [inp.id]);
    expect(await approvals.decideGrant(inp.id, { id: ADMIN_ID, isAdmin: true })).toEqual({ ok: false, error: 'not_grantable' });
    const cut = await fetchReq(approvals, t.id, `https://example.com/${'abc-'.repeat(40)}x`.slice(0, 150));
    expect(await approvals.decideGrant(cut.id, { id: ADMIN_ID, isAdmin: true })).toEqual({ ok: false, error: 'not_grantable' });
    for (const id of [sha.id, inp.id, cut.id]) expect(await status(id)).toBe('pending');
    expect(await grants()).toEqual([]);
  });

  it('another tool, a url that fails the heuristics, and the feature switched off are not_grantable', async () => {
    const { approvals, cfg } = mkGrant();
    const t = await newTask();
    for (const a of [
      await fetchReq(approvals, t.id, undefined, 'web_search', { query: 'q' }),
      await fetchReq(approvals, t.id, undefined, 'watch_add', { url: 'https://example.com/a' }),
      await fetchReq(approvals, t.id, 'https://example.com/u/1234567890'),
      await fetchReq(approvals, t.id, 'http://example.com/a'),
    ]) {
      expect(await approvals.decideGrant(a.id, { id: ADMIN_ID, isAdmin: true })).toEqual({ ok: false, error: 'not_grantable' });
      expect(await status(a.id)).toBe('pending');
    }
    cfg.values.set('web.taskGrant.enabled', false);
    const off = await fetchReq(approvals, t.id);
    expect(await approvals.decideGrant(off.id, { id: ADMIN_ID, isAdmin: true })).toEqual({ ok: false, error: 'not_grantable' });
    expect(await grants()).toEqual([]);
  });

  it('without the card predicates injected, decideGrant refuses (fail closed)', async () => {
    const { approvals } = mk();
    const t = await newTask();
    const a = await fetchReq(approvals, t.id);
    expect(await approvals.decideGrant(a.id, { id: ADMIN_ID, isAdmin: true })).toEqual({ ok: false, error: 'not_grantable' });
  });

  it('non-admin, unknown, already decided and expired approvals', async () => {
    const { approvals } = mkGrant();
    const t = await newTask();
    const a = await fetchReq(approvals, t.id);
    expect(await approvals.decideGrant(a.id, { id: ADMIN_ID, isAdmin: false })).toEqual({ ok: false, error: 'not_admin' });
    expect(await approvals.decideGrant(999999, { id: ADMIN_ID, isAdmin: true })).toEqual({ ok: false, error: 'not_pending' });
    await db.pool.query("UPDATE approvals SET created_at = now() - interval '25 hours' WHERE id = $1", [a.id]);
    expect(await approvals.decideGrant(a.id, { id: ADMIN_ID, isAdmin: true })).toEqual({ ok: false, error: 'expired' });
    const b = await fetchReq(approvals, (await newTask()).id);
    expect((await approvals.decide(b.id, 'approved', admin)).ok).toBe(true);
    expect(await approvals.decideGrant(b.id, { id: ADMIN_ID, isAdmin: true })).toEqual({ ok: false, error: 'not_pending' });
    expect(await grants()).toEqual([]);
  });

  it('halted: nothing is decided and no grant row exists after resume (W-C3b)', async () => {
    const { approvals, halt } = mkGrant();
    const t = await newTask();
    const a = await fetchReq(approvals, t.id);
    halt.halted = true;
    expect(await approvals.decideGrant(a.id, { id: ADMIN_ID, isAdmin: true })).toEqual({ ok: false, error: 'halted' });
    halt.halted = false;
    expect(await status(a.id)).toBe('pending');
    expect(await grants()).toEqual([]);
    expect((await approvals.decide(a.id, 'approved', admin)).ok).toBe(true); // plain Approve stays available
  });

  it('an ended task tree: root_ended, approval untouched', async () => {
    const { approvals } = mkGrant();
    const root = await newTask();
    const a = await fetchReq(approvals, root.id);
    await db.pool.query("UPDATE tasks SET status = 'cancelled' WHERE id = $1", [root.id]);
    expect(await approvals.decideGrant(a.id, { id: ADMIN_ID, isAdmin: true })).toEqual({ ok: false, error: 'root_ended' });
    expect(await status(a.id)).toBe('pending');
  });

  it('a second grant supersedes every unrevoked row of the tree, live or exhausted (W-C8); concurrent grants end with one unrevoked row', async () => {
    const { approvals } = mkGrant({ 'web.taskGrant.maxFetches': 1, 'web.taskGrant.maxHosts': 1 });
    const root = await newTask();
    const first = await fetchReq(approvals, root.id);
    await approvals.decideGrant(first.id, { id: ADMIN_ID, isAdmin: true });
    const repo = new WebGrantRepo(db.pool);
    expect((await repo.consume({ rootId: root.id, host: 'example.com', chars: 1 })).ok).toBe(true); // exhausted, unrevoked
    // the first task moved to todo; a new approval needs a task that can wait again
    const t2 = await tasks.create({ title: 'c2', deptId: 'hq', owner: hq, requester: { kind: 'human', userId: '1' }, origin: 'chat', parentId: root.id });
    const t3 = await tasks.create({ title: 'c3', deptId: 'hq', owner: hq, requester: { kind: 'human', userId: '1' }, origin: 'chat', parentId: root.id });
    const [b, c] = [await fetchReq(approvals, t2.id), await fetchReq(approvals, t3.id)];
    const rs = await Promise.all([approvals.decideGrant(b.id, { id: ADMIN_ID, isAdmin: true }), approvals.decideGrant(c.id, { id: ADMIN_ID, isAdmin: true })]);
    expect(rs.every((r) => r.ok)).toBe(true);
    const rows = await grants();
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.revoked_at === null)).toHaveLength(1);
    expect(rows.filter((r) => r.revoke_reason === 'superseded')).toHaveLength(2);
  });

  it('G2W-03: the clicked message id is written inside the grant transaction (solo)', async () => {
    const { approvals } = mkGrant();
    const t = await newTask();
    const a = await fetchReq(approvals, t.id);
    await approvals.decideGrant(a.id, { id: ADMIN_ID, isAdmin: true }, { messageId: '1570000000000000042' });
    expect((await grants())[0].card_message_id).toBe('1570000000000000042');
    const b = await fetchReq(approvals, (await newTask()).id);
    await approvals.decideGrant(b.id, { id: ADMIN_ID, isAdmin: true }, { messageId: 'not-a-snowflake' });
    expect((await grants())[1].card_message_id).toBeNull();
  });

  it('G2W-02/G2W-07: a halt landing after the last in-transaction check but before COMMIT: the committed grant is revoked at once, not restored by /resume; the error is halted_after_commit', async () => {
    const { approvals, halt } = mkGrant();
    const t = await newTask();
    const a = await fetchReq(approvals, t.id);
    halt.calls = 0;
    halt.haltFromCall = 3; // call 1: entry check, call 2: last in-tx check, call 3: after COMMIT
    expect(await approvals.decideGrant(a.id, { id: ADMIN_ID, isAdmin: true })).toMatchObject({ ok: false, error: 'halted_after_commit', approval: { id: a.id, status: 'approved' } });
    const rows = await grants();
    expect(rows).toHaveLength(1);
    expect(await status(a.id)).toBe('approved'); // G2W-07: the call stays approved; only the grant is revoked
    expect(rows[0]).toMatchObject({ revoke_reason: 'halt', revoked_by: 'system' });
    halt.haltFromCall = Infinity;
    expect(await new WebGrantRepo(db.pool).live(t.id)).toBeNull();
    // G2W-07: "runs after /resume" is true: while halted nothing is released, after /resume the approved call's task is runnable again
    halt.halted = true;
    expect(await approvals.resumeApproved()).toBe(0);
    halt.halted = false;
    await approvals.resumeApproved();
    expect(['todo', 'doing', 'done']).toContain((await tasks.get(t.id))!.status);
    expect(await new WebGrantRepo(db.pool).live(t.id)).toBeNull(); // and the grant stays revoked
  });
});
