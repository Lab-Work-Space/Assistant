import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../migrate.js';
import { freshDb, type TestDb } from '../test-helpers.js';
import { DepartmentRepo } from './org.js';
import { ParentCancelledError, TaskRepo, TASK_TREE_MAX_DEPTH } from './tasks.js';

// TASKADMIN-1: TA-C5 (subtree walk), TA-C8 (no child under a cancelled parent), TA-C13..C15 (blocked note), list and count for /task list.
const SECRET = 'sk-live-TOPSECRET-1234567890';
let db: TestDb;
let tasks: TaskRepo;
beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations'), 'up');
  const depts = new DepartmentRepo(db.pool);
  for (const id of ['hq', 'software']) await depts.upsert({ id, name: id, categoryNamePattern: '', workChannelId: null, color: 0, model: null, provider: null, enabled: true });
  tasks = new TaskRepo(db.pool, [SECRET]);
});
beforeEach(async () => { await db.pool.query('DELETE FROM tasks'); });
afterAll(async () => { await db.close(); });

const base = { title: 't', deptId: 'software' as const, owner: { kind: 'head', dept: 'software' } as const, requester: { kind: 'human', userId: '42' } as const, origin: 'chat' as const };
const noteOf = async (id: string) => (await db.pool.query<{ n: string | null; r: string | null }>('SELECT blocked_note AS n, blocked_reason AS r FROM tasks WHERE id = $1', [id])).rows[0]!;

describe('blocked note (TA-C13..C15)', () => {
  it('update_task style block stores reason owner and a masked, one-line, 300-character note; the Task row never carries it', async () => {
    const t = await tasks.create({ ...base, status: 'doing' });
    const raw = `need ${SECRET}\nand a key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 ` + 'x'.repeat(400);
    const b = await tasks.update(t.id, { status: 'blocked', blockedReason: 'owner', blockedNote: raw }, 'doing');
    expect(b).toMatchObject({ status: 'blocked', blockedReason: 'owner' });
    expect(b).not.toHaveProperty('blockedNote');
    const row = await noteOf(t.id);
    expect(row.r).toBe('owner');
    expect(row.n!.length).toBeLessThanOrEqual(300);
    expect(row.n).not.toContain(SECRET);
    expect(row.n).not.toMatch(/sk-ant/);
    expect(row.n).not.toMatch(/[\r\n]/);
    expect(row.n).toContain('[REDACTED]');
  });

  it('G2-02: a literal secret that straddles the 300 cut is masked whole before the cut (no prefix survives)', async () => {
    const t = await tasks.create({ ...base, status: 'doing' });
    await tasks.update(t.id, { status: 'blocked', blockedReason: 'owner', blockedNote: `${'a'.repeat(285)} ${SECRET} tail` }, 'doing');
    const n = (await noteOf(t.id)).n!;
    expect(n.length).toBeLessThanOrEqual(300);
    expect(n).not.toContain('sk-live');
    expect(n).not.toContain('TOPSECRET');
    expect(n.endsWith('[REDACTED]') || n.includes('[REDACTED]')).toBe(true);
  });

  it('any status change clears the note; a reason other than owner never keeps one; a note needs the owner reason', async () => {
    const t = await tasks.create({ ...base, status: 'doing' });
    await tasks.update(t.id, { status: 'blocked', blockedReason: 'owner', blockedNote: 'waiting for the vendor' }, 'doing');
    expect((await noteOf(t.id)).n).toBe('waiting for the vendor');
    await tasks.update(t.id, { status: 'todo' }, 'blocked');
    expect(await noteOf(t.id)).toEqual({ n: null, r: null });
    await tasks.update(t.id, { status: 'blocked', blockedReason: 'owner', blockedNote: 'again' });
    await tasks.update(t.id, { status: 'blocked', blockedReason: 'budget' });
    expect(await noteOf(t.id)).toEqual({ n: null, r: 'budget' });
    await expect(tasks.update(t.id, { status: 'blocked', blockedReason: 'turns', blockedNote: 'x' })).rejects.toThrow(/owner/);
    await expect(tasks.update(t.id, { blockedNote: 'x' })).rejects.toThrow(/owner/);
  });

  it('a status move that does not clear the note is refused by the backstop; unblockHalted keeps working', async () => {
    const a = await tasks.create({ ...base, status: 'doing' });
    await tasks.update(a.id, { status: 'blocked', blockedReason: 'halt' }, 'doing');
    const b = await tasks.create({ ...base, status: 'doing' });
    await tasks.update(b.id, { status: 'blocked', blockedReason: 'owner', blockedNote: 'n' }, 'doing');
    expect((await tasks.unblockHalted()).map((x) => x.id)).toEqual([a.id]);
    expect((await noteOf(b.id)).n).toBe('n'); // an owner block is never resumed by a halt sweep
    await expect(db.pool.query("UPDATE tasks SET status = 'cancelled' WHERE id = $1", [b.id])).rejects.toThrow(/tasks_blocked_note_owner/);
  });
});

describe('listOpenAdmin and countByStatus (/task list)', () => {
  it('lists open tasks stalest first with the open-children count and the note; done and cancelled never appear', async () => {
    const root = await tasks.create({ ...base, status: 'review' });
    const c1 = await tasks.create({ ...base, parentId: root.id, status: 'blocked' });
    await tasks.update(c1.id, { status: 'blocked', blockedReason: 'owner', blockedNote: 'need input' });
    const c2 = await tasks.create({ ...base, parentId: root.id });
    const done = await tasks.create({ ...base, parentId: root.id });
    await tasks.update(done.id, { status: 'done' });
    await db.pool.query("UPDATE tasks SET updated_at = now() - interval '3 hours' WHERE id = $1", [root.id]);
    const rows = await tasks.listOpenAdmin(['todo', 'doing', 'review', 'blocked', 'awaiting_approval'], 25);
    expect(rows.map((r) => r.id)).toEqual([root.id, c1.id, c2.id]);
    expect(rows[0]).toMatchObject({ id: root.id, deptId: 'software', status: 'review', depth: 0, openChildren: 2, blockedReason: null, blockedNote: null });
    expect(rows[1]).toMatchObject({ status: 'blocked', blockedReason: 'owner', blockedNote: 'need input', depth: 1, openChildren: 0 });
    expect(rows[0]!.updatedAt).toBeInstanceOf(Date);
    expect((await tasks.listOpenAdmin(['blocked'], 25)).map((r) => r.id)).toEqual([c1.id]);
    expect(await tasks.listOpenAdmin(['todo', 'doing', 'review', 'blocked', 'awaiting_approval'], 1)).toHaveLength(1);
    expect(await tasks.countByStatus()).toMatchObject({ todo: 1, doing: 0, review: 1, blocked: 1, awaiting_approval: 0 });
  });
});

describe('no child under a cancelled parent (TA-C8)', () => {
  it('create refuses a cancelled parent with a named error; a done parent still takes children; createUnderOpenParent returns null', async () => {
    const dead = await tasks.create({ ...base, status: 'doing' });
    await tasks.update(dead.id, { status: 'cancelled' });
    await expect(tasks.create({ ...base, parentId: dead.id })).rejects.toBeInstanceOf(ParentCancelledError);
    expect(await tasks.createUnderOpenParent({ ...base, parentId: dead.id })).toBeNull();
    expect(await db.pool.query('SELECT 1 FROM tasks WHERE parent_id = $1', [dead.id]).then((r) => r.rowCount)).toBe(0);
    const fin = await tasks.create({ ...base, status: 'doing' });
    await tasks.update(fin.id, { status: 'done' });
    expect(await tasks.create({ ...base, parentId: fin.id })).toMatchObject({ parentId: fin.id }); // today's done-then-create behaviour is kept
  });

  it('the check holds after waiting on a lock: an insert paused behind a cancel that commits is refused (deterministic race)', async () => {
    const parent = await tasks.create({ ...base, status: 'doing' });
    const locker = await db.pool.connect();
    try {
      await locker.query('BEGIN');
      await locker.query('SELECT id FROM tasks WHERE id = $1 FOR UPDATE', [parent.id]);
      await locker.query("UPDATE tasks SET status = 'cancelled' WHERE id = $1", [parent.id]);
      const pending = tasks.create({ ...base, parentId: parent.id }).then(() => 'created' as const, (e: unknown) => e);
      // wait until the insert really is blocked on the parent row lock
      for (let i = 0; i < 100; i++) {
        const w = await db.pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock' AND state = 'active'", [db.schema]);
        if (w.rowCount) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      await locker.query('COMMIT');
      const out = await pending;
      expect(out).toBeInstanceOf(ParentCancelledError);
    } finally {
      locker.release();
    }
    expect((await db.pool.query('SELECT 1 FROM tasks WHERE parent_id = $1', [parent.id])).rowCount).toBe(0);
  });
});

describe('openSubtree (TA-C5)', () => {
  it('walks a 12-level chain fully, skips ended rows, and reports a chain past the bound as too deep', async () => {
    let p = await tasks.create({ ...base, status: 'doing' });
    const ids = [p.id];
    for (let i = 0; i < 12; i++) { p = await tasks.create({ ...base, parentId: p.id }); ids.push(p.id); }
    await tasks.update(ids[5]!, { status: 'done' });
    const s = await tasks.openSubtree(ids[0]!);
    expect(s.tooDeep).toBe(false);
    expect(s.rows.map((r) => r.id).sort()).toEqual(ids.filter((_, i) => i !== 5).sort());
    expect(s.rows.find((r) => r.id === ids[0])).toMatchObject({ parentId: null, status: 'doing' });
    await db.pool.query('DELETE FROM tasks');
    let q = await tasks.create({ ...base, status: 'doing' });
    const first = q.id;
    for (let i = 0; i < TASK_TREE_MAX_DEPTH + 1; i++) q = await tasks.create({ ...base, parentId: q.id, depth: i + 1 });
    expect((await tasks.openSubtree(first)).tooDeep).toBe(true);
    await db.pool.query('DELETE FROM tasks');
    q = await tasks.create({ ...base, status: 'doing' });
    for (let i = 0; i < TASK_TREE_MAX_DEPTH; i++) q = await tasks.create({ ...base, parentId: q.id, depth: i + 1 });
    expect((await tasks.openSubtree(q.rootId)).tooDeep).toBe(false); // exactly at the bound is still fully walked
  });

  it('reads at most 51 open rows so a larger set is detectable', async () => {
    const root = await tasks.create({ ...base, status: 'doing' });
    for (let i = 0; i < 55; i++) await tasks.create({ ...base, parentId: root.id });
    expect((await tasks.openSubtree(root.id)).rows).toHaveLength(51);
  });
});
