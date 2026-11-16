import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EventBus, type AppEvents } from '../../core/events.js';
import { migrate } from '../../db/migrate.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { ApprovalBatchRepo, DepartmentRepo, TaskRepo } from '../../db/index.js';
import type { ActorRef } from '../../company/types.js';
import { Approvals, cancelDigest, TASK_CANCEL_MAX } from './approvals.js';
import { FakeConfig } from '../test-helpers.js';
import type { PoolClient } from 'pg';
import { ParentCancelledError } from '../../db/repos/tasks.js';

// TASKADMIN-1: Approvals.adminCancel (TA-C5..C9, C14). Real PostgreSQL.
let db: TestDb;
let tasks: TaskRepo;
let batches: ApprovalBatchRepo;
const hq: ActorRef = { kind: 'head', dept: 'hq' };
const fits = () => true;

class FakeHalt { halted = false; isHalted() { return this.halted; } }

const mk = () => {
  const cfg = new FakeConfig({ 'approval.thresholdUsd': 1 });
  const bus = new EventBus<AppEvents>();
  const halt = new FakeHalt();
  const events: AppEvents['task.changed'][] = [];
  const ready: unknown[] = [];
  const order: string[] = [];
  bus.on('task.changed', (e) => { events.push(e); order.push(`changed:${e.task.id}`); });
  bus.on('task.ready', (p) => { ready.push(p); });
  const approvals = new Approvals(db.pool, tasks, cfg, bus, halt, async () => undefined);
  return { approvals, halt, events, ready, order };
};

const mkTask = (parentId?: string, status: 'todo' | 'doing' | 'review' | 'blocked' = 'todo') =>
  tasks.create({ title: 't', deptId: 'hq', owner: hq, requester: { kind: 'human', userId: '1' }, origin: 'chat', ...(parentId ? { parentId } : {}), status });
const tree = async () => {
  const root = await mkTask(undefined, 'doing');
  const child = await mkTask(root.id, 'doing');
  const grand = await mkTask(child.id, 'todo');
  return { root, child, grand };
};
const status = async (id: string) => (await tasks.get(id))!.status;
const digestOf = async (id: string, cascade: boolean) => cancelDigest((await tasks.openSubtree(id)).rows, cascade);
const go = async (m: ReturnType<typeof mk>, target: string, cascade = true, beforeEmit?: (ids: string[]) => void) =>
  m.approvals.adminCancel({ target, cascade, digest: await digestOf(target, cascade), userId: 'admin1' }, beforeEmit);
const toolApproval = (m: ReturnType<typeof mk>, taskId: string, n: number) =>
  m.approvals.request({ taskId, kind: 'tool', tool: { name: 'write_file', input: { n } }, reason: 'r', estCostUsd: 0, requestedBy: hq });

beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations'), 'up');
  await new DepartmentRepo(db.pool).upsert({ id: 'hq', name: 'HQ', categoryNamePattern: '', workChannelId: null, color: 0, model: null, provider: null, enabled: true });
  tasks = new TaskRepo(db.pool);
  batches = new ApprovalBatchRepo(db.pool);
});
beforeEach(async () => {
  await db.pool.query('UPDATE approvals SET batch_id = NULL WHERE batch_id IS NOT NULL').catch(() => undefined);
  await db.pool.query('DELETE FROM approvals');
  await db.pool.query('DELETE FROM approval_batches');
  await db.pool.query('DELETE FROM tasks');
});
afterAll(async () => { await db.close(); });

describe('Approvals.adminCancel', () => {
  it('cancels a 3-level cascade, expires the pending approvals, emits task.changed with admin.cascadeIds after the abort hook, and wakes nothing', async () => {
    const m = mk();
    const { root, child, grand } = await tree();
    const done = await mkTask(root.id);
    await tasks.update(done.id, { status: 'done' });
    const a1 = await m.approvals.request({ taskId: child.id, reason: 'big', estCostUsd: 5, requestedBy: hq });
    const a2 = await toolApproval(m, grand.id, 1);
    m.events.length = 0;
    m.order.length = 0;
    const res = await go(m, root.id, true, (ids) => m.order.push(`abort:${ids.length}`));
    expect(res).toMatchObject({ ok: true, rootEnded: true });
    if (!res.ok) throw new Error('unreachable');
    expect(res.ids.sort()).toEqual([root.id, child.id, grand.id].sort());
    for (const id of [root.id, child.id, grand.id]) expect(await status(id)).toBe('cancelled');
    expect(await status(done.id)).toBe('done'); // an ended row is never touched
    const rows = (await db.pool.query('SELECT id, status, decided_by FROM approvals ORDER BY id')).rows;
    expect(rows).toEqual([{ id: a1.id, status: 'expired', decided_by: 'admin1' }, { id: a2.id, status: 'expired', decided_by: 'admin1' }]);
    expect(res.expired.map((x) => x.id).sort()).toEqual([a1.id, a2.id].sort());
    expect(m.order[0]).toBe('abort:3'); // TA-C9: the abort comes before any event
    expect(m.events.map((e) => e.task.id).sort()).toEqual([root.id, child.id, grand.id].sort());
    for (const e of m.events) {
      expect(e).toMatchObject({ to: 'cancelled' });
      expect([...e.admin!.cascadeIds].sort()).toEqual([root.id, child.id, grand.id].sort());
    }
    expect(m.ready).toEqual([]);
  });

  it('works while halted and starts nothing', async () => {
    const m = mk();
    m.halt.halted = true;
    const { root } = await tree();
    expect((await go(m, root.id)).ok).toBe(true);
    expect(m.ready).toEqual([]);
  });

  it('cancels a task blocked by its owner (the note backstop CHECK passes because move() clears the note)', async () => {
    const m = mk();
    const t = await mkTask(undefined, 'doing');
    await tasks.update(t.id, { status: 'blocked', blockedReason: 'owner', blockedNote: 'need the key' });
    expect((await go(m, t.id, false)).ok).toBe(true);
    expect((await db.pool.query('SELECT status, blocked_reason AS r, blocked_note AS n FROM tasks WHERE id = $1', [t.id])).rows[0]).toEqual({ status: 'cancelled', r: null, n: null });
  });

  it('batches in the states open, sealed and posted are all dissolved or closed (TA-C7): open gets items_digest first', async () => {
    const m = mk();
    const { root, child, grand } = await tree();
    // open batch on root, sealed on child, posted on grand
    const mkBatch = async (taskId: string, n: number, upto: 'open' | 'sealed' | 'posted') => {
      const a1 = await toolApproval(m, taskId, n);
      const a2 = await toolApproval(m, taskId, n + 100);
      const j1 = await batches.join(a1, { windowMs: 60_000, fits });
      const j2 = await batches.join(a2, { windowMs: 60_000, fits });
      if (j1.kind !== 'joined' || j2.kind !== 'joined') throw new Error('join failed');
      if (upto !== 'open') await batches.seal(j1.batchId);
      if (upto === 'posted') await batches.markPosted(j1.batchId, '1570000000000000001', '1570000000000000002');
      return j1.batchId;
    };
    const bo = await mkBatch(root.id, 1, 'open');
    const bs = await mkBatch(child.id, 2, 'sealed');
    const bp = await mkBatch(grand.id, 3, 'posted');
    const res = await go(m, root.id);
    expect(res.ok).toBe(true);
    const st = Object.fromEntries((await db.pool.query<{ id: number; state: string; items_digest: string | null }>('SELECT id, state, items_digest FROM approval_batches')).rows.map((r) => [r.id, r]));
    expect(st[bo]).toMatchObject({ state: 'dissolved' });
    expect(st[bo]!.items_digest).toMatch(/^[0-9a-f]{12}$/);
    expect(st[bs]).toMatchObject({ state: 'dissolved' });
    expect(st[bp]).toMatchObject({ state: 'closed' });
    if (!res.ok) throw new Error('unreachable');
    // the posted card is reported so the command can close it (TA-C9 step 4)
    expect(res.batches).toContainEqual({ id: bp, state: 'closed', channelId: '1570000000000000001', messageId: '1570000000000000002' });
    expect((await db.pool.query("SELECT 1 FROM approvals WHERE status = 'pending'")).rowCount).toBe(0);
  });

  it('G2-01: a join that seals an aged batch and opens a new one does not deadlock with an admin cancel holding the task row (lock order task -> batch)', async () => {
    const m = mk();
    const t = await mkTask(undefined, 'doing');
    const a1 = await toolApproval(m, t.id, 1);
    const a2 = await toolApproval(m, t.id, 2);
    const j1 = await batches.join(a1, { windowMs: 60_000, fits });
    if (j1.kind !== 'joined') throw new Error('join failed');
    const c = await db.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT id FROM tasks WHERE id = $1 FOR UPDATE', [t.id]); // adminCancel: the task rows first
      const joined = batches.join(a2, { windowMs: 0, fits }).then((r) => ({ ok: r }), (e: { code?: string }) => ({ err: e.code ?? String(e) })); // the batch is aged: seal, then open a new one
      await new Promise((r) => setTimeout(r, 300));
      const cancelBatches = await c.query("SELECT id FROM approval_batches WHERE task_id = $1 AND state IN ('open','sealed','posted') ORDER BY id FOR UPDATE", [t.id]).then(() => 'ok', (e: { code?: string }) => e.code ?? String(e));
      await c.query('COMMIT');
      expect(cancelBatches).toBe('ok');
      const out = await Promise.race([joined, new Promise<{ err: string }>((r) => setTimeout(() => r({ err: 'timeout' }), 5000))]);
      expect(out).toHaveProperty('ok');
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  });

  it('a markPosted that loses to the flip is a no-op, and a stale batch card answers stale (TA-C7)', async () => {
    const m = mk();
    const t = await mkTask(undefined, 'doing');
    const a1 = await toolApproval(m, t.id, 1);
    const a2 = await toolApproval(m, t.id, 2);
    const j = await batches.join(a1, { windowMs: 60_000, fits });
    await batches.join(a2, { windowMs: 60_000, fits });
    if (j.kind !== 'joined') throw new Error('join failed');
    await batches.seal(j.batchId);
    const digest = (await batches.get(j.batchId))!.digest!;
    expect((await go(m, t.id, false)).ok).toBe(true); // sealed -> dissolved
    expect(await batches.markPosted(j.batchId, '1570000000000000001', '1570000000000000002')).toBe(false);
    expect((await batches.get(j.batchId))!.state).toBe('dissolved');
    const m2 = new Approvals(db.pool, tasks, new FakeConfig({ 'approval.thresholdUsd': 1 }), new EventBus<AppEvents>(), new FakeHalt(), async () => undefined, [], () => true);
    expect(await m2.decideBatch(j.batchId, digest, 'approved', { id: 'admin1', isAdmin: true })).toEqual({ ok: false, error: 'stale' });
  });

  it('a join racing the cancel either lands before the lock (and is expired) or is refused, with no deadlock across 50 runs', async () => {
    for (let i = 0; i < 50; i++) {
      const m = mk();
      const t = await mkTask(undefined, 'doing');
      const a0 = await toolApproval(m, t.id, 1);
      await batches.join(a0, { windowMs: 60_000, fits });
      const late = await toolApproval(m, t.id, 2).catch(() => null); // refused once the task ended
      const [c, j] = await Promise.all([
        go(m, t.id, false),
        late ? batches.join(late, { windowMs: 60_000, fits }).catch(() => null) : Promise.resolve(null),
      ]);
      expect(c.ok).toBe(true);
      expect((await db.pool.query("SELECT 1 FROM approvals WHERE status = 'pending'")).rowCount).toBe(0);
      void j;
      await db.pool.query('UPDATE approvals SET batch_id = NULL WHERE batch_id IS NOT NULL').catch(() => undefined);
      await db.pool.query('DELETE FROM approvals');
      await db.pool.query('DELETE FROM approval_batches');
      await db.pool.query('DELETE FROM tasks');
    }
  }, 60_000);

  it('a child created between the confirm and the click gives stale and changes nothing', async () => {
    const m = mk();
    const { root } = await tree();
    const digest = await digestOf(root.id, true);
    await mkTask(root.id); // a new open child after the confirm
    const res = await m.approvals.adminCancel({ target: root.id, cascade: true, digest, userId: 'admin1' });
    expect(res).toEqual({ ok: false, error: 'stale' });
    expect(await status(root.id)).toBe('doing');
    expect(m.events).toEqual([]);
  });

  it('a status change after the confirm is stale as well; a wrong digest never cancels', async () => {
    const m = mk();
    const t = await mkTask(undefined, 'doing');
    const digest = await digestOf(t.id, false);
    await tasks.update(t.id, { status: 'review' });
    expect(await m.approvals.adminCancel({ target: t.id, cascade: false, digest, userId: 'a' })).toEqual({ ok: false, error: 'stale' });
    expect(await m.approvals.adminCancel({ target: t.id, cascade: false, digest: 'deadbeef0000', userId: 'a' })).toEqual({ ok: false, error: 'stale' });
    expect(await status(t.id)).toBe('review');
  });

  it('refuses an ended or unknown target, a non-cascade cancel with open children, more than 50 tasks, and a tree past the depth bound', async () => {
    const m = mk();
    const { root, child } = await tree();
    expect(await m.approvals.adminCancel({ target: 'nope', cascade: true, digest: 'x', userId: 'a' })).toEqual({ ok: false, error: 'not_found' });
    expect(await go(m, root.id, false)).toMatchObject({ ok: false, error: 'open_children' });
    expect(await status(child.id)).toBe('doing');
    const gone = await mkTask();
    await tasks.update(gone.id, { status: 'done' });
    expect(await m.approvals.adminCancel({ target: gone.id, cascade: true, digest: 'x', userId: 'a' })).toEqual({ ok: false, error: 'ended' });
    const big = await mkTask(undefined, 'doing');
    for (let i = 0; i < TASK_CANCEL_MAX; i++) await mkTask(big.id);
    expect(await m.approvals.adminCancel({ target: big.id, cascade: true, digest: 'x', userId: 'a' })).toEqual({ ok: false, error: 'too_many' });
    let p = await mkTask(undefined, 'doing');
    const deepRoot = p.id;
    for (let i = 0; i < 21; i++) p = await tasks.create({ title: 't', deptId: 'hq', owner: hq, requester: { kind: 'human', userId: '1' }, origin: 'chat', parentId: p.id, depth: i + 1 });
    expect(await m.approvals.adminCancel({ target: deepRoot, cascade: true, digest: 'x', userId: 'a' })).toEqual({ ok: false, error: 'too_deep' });
    expect(await status(deepRoot)).toBe('doing');
  });

  it('cancels a 12-level chain in full', async () => {
    const m = mk();
    let p = await mkTask(undefined, 'doing');
    const ids = [p.id];
    for (let i = 0; i < 12; i++) { p = await mkTask(p.id); ids.push(p.id); }
    const res = await go(m, ids[0]!);
    expect(res.ok && res.ids.length).toBe(13);
    for (const id of ids) expect(await status(id)).toBe('cancelled');
  });

  it('a cap approval waiter OUTSIDE the cancelled set is blocked with reason approval (T7)', async () => {
    const m = mk();
    const root = await mkTask(undefined, 'doing');
    const a = await mkTask(root.id, 'doing');
    const b = await mkTask(root.id, 'doing');
    const cap = (await m.approvals.onTreeCapHit({ rootId: root.id, taskId: a.id, est: 5, requestedBy: hq }))!;
    await m.approvals.onTreeCapHit({ rootId: root.id, taskId: b.id, est: 5, requestedBy: hq }); // joins the same approval
    expect(await status(b.id)).toBe('awaiting_approval');
    const res = await go(m, a.id, false);
    expect(res.ok).toBe(true);
    expect(await status(a.id)).toBe('cancelled');
    expect(await tasks.get(b.id)).toMatchObject({ status: 'blocked', blockedReason: 'approval' });
    expect((await db.pool.query('SELECT status FROM approvals WHERE id = $1', [cap.id])).rows[0]!.status).toBe('expired');
    expect(await status(root.id)).toBe('doing');
  });

  it('a create_task that starts only after the cancel commits leaves no child under the cancelled parent and wakes nothing (TA-C8)', async () => {
    const m = mk();
    const parent = await mkTask(undefined, 'doing');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let atStart!: () => void;
    const reached = new Promise<void>((r) => { atStart = r; });
    // AUTO-1 (AP-C15): a child's insert now runs in its own transaction on a pooled connection, so the pause is placed where that transaction would open.
    const paused = new TaskRepo(new Proxy(db.pool, {
      get(target, prop, recv) {
        if (prop === 'query') return target.query.bind(target); // Pool.query calls this.connect: keep it on the real pool
        if (prop !== 'connect') return Reflect.get(target, prop, recv);
        return async () => { atStart(); await gate; return target.connect(); };
      },
    }) as never);
    const creating = paused.create({ title: 'late child', deptId: 'hq', owner: hq, requester: hq, origin: 'delegated', parentId: parent.id }).then(() => 'created', (e: unknown) => e);
    await reached;
    expect((await go(m, parent.id, false)).ok).toBe(true);
    release();
    expect(await creating).toBeInstanceOf(ParentCancelledError);
    expect((await db.pool.query('SELECT 1 FROM tasks WHERE parent_id = $1', [parent.id])).rowCount).toBe(0);
    expect(m.ready).toEqual([]);
  });

  it('AUTO-1 (AP-C15): a create_task paused inside its insert transaction holds the parent, so a cancel that read the old tree is refused as stale and cancels nothing', async () => {
    const m = mk();
    const parent = await mkTask(undefined, 'doing');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let atInsert!: () => void;
    const reached = new Promise<void>((r) => { atInsert = r; });
    const wrapClient = (c: PoolClient) => new Proxy(c, {
      get(t, prop, recv) {
        if (prop !== 'query') return Reflect.get(t, prop, recv);
        return async (sql: unknown, params: unknown) => {
          if (typeof sql === 'string' && sql.includes('INSERT INTO tasks')) { atInsert(); await gate; }
          return (t.query as (a: unknown, b: unknown) => Promise<unknown>).call(t, sql, params);
        };
      },
    });
    const paused = new TaskRepo(new Proxy(db.pool, {
      get(target, prop, recv) {
        if (prop === 'query') return target.query.bind(target);
        if (prop !== 'connect') return Reflect.get(target, prop, recv);
        return async () => wrapClient(await target.connect());
      },
    }) as never);
    const creating = paused.create({ title: 'racing child', deptId: 'hq', owner: hq, requester: hq, origin: 'delegated', parentId: parent.id });
    await reached;
    let cancelDone = false;
    const cancelling = go(m, parent.id, true).then((r) => { cancelDone = true; return r; }); // digest read before the child commits
    await new Promise((r) => setTimeout(r, 300));
    expect(cancelDone).toBe(false); // the cancel waits on the parent row the insert holds
    release();
    const child = await creating;
    const r = await cancelling;
    expect(r).toMatchObject({ ok: false, error: 'stale' });
    expect(await status(parent.id)).toBe('doing');
    expect(await status(child.id)).toBe('todo');
    expect((await go(m, parent.id, true)).ok).toBe(true); // a fresh look sees the child and cancels both
    expect(await status(parent.id)).toBe('cancelled');
    expect(await status(child.id)).toBe('cancelled');
  });
});
