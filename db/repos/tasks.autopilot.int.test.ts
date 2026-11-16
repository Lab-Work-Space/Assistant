import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ActorRef } from '../../company/types.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { migrate } from '../migrate.js';
import { freshDb, type TestDb } from '../test-helpers.js';
import { DepartmentRepo, ProjectRepo, TaskRepo } from './index.js';

let db: TestDb;
let tasks: TaskRepo;
const hq: ActorRef = { kind: 'head', dept: 'hq' };
const cto: ActorRef = { kind: 'head', dept: 'software' };

beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations'), 'up');
  const d = new DepartmentRepo(db.pool);
  for (const id of ['hq', 'software']) await d.upsert({ id, name: id, categoryNamePattern: '', workChannelId: null, color: 0, model: null, provider: null, enabled: true });
  tasks = new TaskRepo(db.pool);
});
beforeEach(async () => {
  for (const t of ['project_tools', 'projects', 'audit_log']) await db.pool.query(`DELETE FROM ${t}`);
  await db.pool.query('UPDATE tasks SET parent_id = NULL');
  await db.pool.query('DELETE FROM tasks');
});
afterAll(async () => { await db.close(); });

const mk = (id: string, owner: ActorRef = hq, status: 'todo' | 'done' = 'todo') =>
  tasks.create({ id, title: `TITLE-MARKER-${id}`, deptId: owner.kind === 'head' ? owner.dept : 'hq', owner, requester: { kind: 'human', userId: '1' }, origin: 'chat', status });

describe('TaskRepo.ownByPrefix (SA-1 3.9, AP-C17)', () => {
  it('finds the one open task of the owner by a unique prefix of 8 to 35 characters', async () => {
    const a = await mk('aaaaaaaa-1111-4111-8111-111111111111');
    await mk('bbbbbbbb-2222-4222-8222-222222222222');
    expect((await tasks.ownByPrefix(hq, 'aaaaaaaa'))?.id).toBe(a.id);
    expect((await tasks.ownByPrefix(hq, 'aaaaaaaa-1111'))?.id).toBe(a.id);
    expect((await tasks.ownByPrefix(hq, a.id.slice(0, 35)))?.id).toBe(a.id); // a full id is the exact `get`'s job (the pattern stops at 35)
    expect(await tasks.ownByPrefix(hq, a.id)).toBeNull();
  });
  it('null for no match, an ambiguous prefix, someone else\'s task, an ended task', async () => {
    await mk('cccccccc-1111-4111-8111-111111111111');
    await mk('cccccccc-2222-4222-8222-222222222222');
    await mk('dddddddd-1111-4111-8111-111111111111', cto);
    await mk('eeeeeeee-1111-4111-8111-111111111111', hq, 'done');
    expect(await tasks.ownByPrefix(hq, 'cccccccc')).toBeNull(); // two match
    expect((await tasks.ownByPrefix(hq, 'cccccccc-2'))?.id).toBe('cccccccc-2222-4222-8222-222222222222');
  });
  it('the owner filter stays: another department cannot reach a task by prefix', async () => {
    await mk('dddddddd-1111-4111-8111-111111111111', cto);
    expect(await tasks.ownByPrefix(hq, 'dddddddd')).toBeNull();
    expect((await tasks.ownByPrefix(cto, 'dddddddd'))?.deptId).toBe('software');
    await mk('eeeeeeee-1111-4111-8111-111111111111', hq, 'done');
    expect(await tasks.ownByPrefix(hq, 'eeeeeeee')).toBeNull();
    expect(await tasks.ownByPrefix(hq, 'ffffffff')).toBeNull();
  });
  it('no LIKE wildcard, quote or short/long prefix is ever run as a pattern', async () => {
    await mk('aaaaaaaa-1111-4111-8111-111111111111');
    for (const bad of ['%', '_', 'aaaaaaa%', 'aaaaaaa_', "aaaaaaaa'--", 'aaaaaaa', '', 'AAAAAAAA', 'a'.repeat(36), 'aaaaaaaa-1111-4111-8111-111111111111', '%%%%%%%%', '________']) expect(await tasks.ownByPrefix(hq, bad), bad).toBeNull();
  });
});

describe('TaskRepo.create with a parent (AP-C15)', () => {
  it('a child waits for a tree move that holds the rows and then takes the NEW root and depth + 1', async () => {
    const old = await mk('11111111-1111-4111-8111-111111111111');
    const mid = await tasks.create({ title: 'm', deptId: 'hq', owner: hq, requester: hq, origin: 'delegated', parentId: old.id });
    const newRoot = await mk('22222222-2222-4222-8222-222222222222');
    const mover = await db.pool.connect();
    try {
      await mover.query('BEGIN');
      // the adoption's lock: the whole old tree, root first, FOR UPDATE
      await mover.query('SELECT id FROM tasks WHERE id = ANY($1) ORDER BY (id = $2) DESC, id FOR UPDATE', [[old.id, mid.id], old.id]);
      let done = false;
      const kid = tasks.create({ title: 'k', deptId: 'hq', owner: hq, requester: hq, origin: 'delegated', parentId: mid.id }).then((t) => { done = true; return t; });
      await new Promise((r) => setTimeout(r, 300));
      expect(done).toBe(false); // blocked by the lock, it did not read the old position
      await mover.query('UPDATE tasks SET root_id = $2, depth = depth + 1, parent_id = CASE WHEN id = $1 THEN $2 ELSE parent_id END WHERE id = ANY($3)', [old.id, newRoot.id, [old.id, mid.id]]);
      await mover.query('COMMIT');
      const t = await kid;
      expect(t).toMatchObject({ rootId: newRoot.id, depth: 3, parentId: mid.id });
      const moved = await tasks.get(mid.id);
      expect(t.rootId).toBe(moved!.rootId);
      expect(t.depth).toBe(moved!.depth + 1);
    } finally { mover.release(); }
  });
  it('children created while a real adoption commits always match their parent\'s root and depth', async () => {
    const cfg = new FakeConfig();
    const projects = new ProjectRepo(db.pool, { cfg, halt: { isHalted: () => false } });
    const old = await mk('33333333-3333-4333-8333-333333333333');
    const mid = await tasks.create({ title: 'm', deptId: 'hq', owner: hq, requester: hq, origin: 'delegated', parentId: old.id });
    const c = await projects.create({ title: 'Race', goal: 'g', deadline: '2099-01-01', maxLocalCalls: 5, maxUsd: 1, proposer: 'head:hq', tainted: false, adopt: [old.id] });
    if (!c.ok) throw new Error(c.code);
    const mkKid = () => tasks.create({ title: 'k', deptId: 'hq', owner: hq, requester: hq, origin: 'delegated', parentId: mid.id }).catch((e: unknown) => e);
    const [d, ...kids] = await Promise.all([projects.decide({ token: c.project.token, by: '123456789012345678' }), ...Array.from({ length: 8 }, mkKid)]);
    if (!d.ok) throw new Error(d.code);
    expect(d.adopted).toEqual([old.id]);
    // DEFECT-001: a returned Task is read after its transaction commits, and an adoption that was waiting on that child's lock may move the tree right after. So the returned
    // position is either the old one (the child committed first) or the new one, and it is never compared with the parent's FINAL position; the stored rows are what must agree.
    const parent = (await tasks.get(mid.id))!;
    for (const k of kids) {
      expect(k).not.toBeInstanceOf(Error);
      const t = k as { id: string; rootId: string; depth: number };
      expect([old.id, parent.rootId]).toContain(t.rootId);
      expect(t.depth).toBe(t.rootId === old.id ? 2 : parent.depth + 1);
      const row = (await tasks.get(t.id))!;
      expect(row.rootId).toBe(parent.rootId);
      expect(row.depth).toBe(parent.depth + 1);
    }
    expect((await db.pool.query("SELECT count(*)::int AS n FROM tasks WHERE title = 'k' AND root_id <> $1", [d.root.id])).rows[0]).toEqual({ n: 0 });
  });
  it('a child committed while the adoption waits on its lock is still moved with the tree (deterministic)', async () => {
    const cfg = new FakeConfig();
    const projects = new ProjectRepo(db.pool, { cfg, halt: { isHalted: () => false } });
    const old = await mk('55555555-5555-4555-8555-555555555555');
    const mid = await tasks.create({ title: 'm', deptId: 'hq', owner: hq, requester: hq, origin: 'delegated', parentId: old.id });
    const c = await projects.create({ title: 'Det', goal: 'g', deadline: '2099-01-01', maxLocalCalls: 5, maxUsd: 1, proposer: 'head:hq', tainted: false, adopt: [old.id] });
    if (!c.ok) throw new Error(c.code);
    const kid = await db.pool.connect();
    try {
      await kid.query('BEGIN'); // a child insert in flight: the root and parent share locks, the row not yet visible
      await kid.query('SELECT 1 FROM tasks WHERE id = ANY($1) ORDER BY (id = $2) DESC, id FOR SHARE', [[old.id, mid.id], old.id]);
      await kid.query(
        `INSERT INTO tasks (id, title, description, dept_id, owner, requester, parent_id, root_id, depth, status, origin, tainted)
         VALUES ('66666666-6666-4666-8666-666666666666','k','','hq','{"kind":"head","dept":"hq"}','{"kind":"head","dept":"hq"}',$1,$2,2,'todo','delegated',false)`, [mid.id, old.id]);
      let done = false;
      const dec = projects.decide({ token: c.project.token, by: '123456789012345678' }).then((r) => { done = true; return r; });
      await new Promise((r) => setTimeout(r, 400));
      expect(done).toBe(false); // the adoption's FOR UPDATE waits on the child's share locks, its snapshot cannot see the child
      await kid.query('COMMIT');
      const d = await dec;
      if (!d.ok) throw new Error(d.code);
      expect(d.adopted).toEqual([old.id]);
      const k = (await tasks.get('66666666-6666-4666-8666-666666666666'))!;
      expect(k).toMatchObject({ rootId: d.root.id, depth: 3, parentId: mid.id });
    } finally { await kid.query('ROLLBACK').catch(() => undefined); kid.release(); }
  });
  it('a missing parent still throws (create) or returns null (under an open parent); a done parent under requireOpenParent gives null', async () => {
    await expect(tasks.create({ title: 'k', deptId: 'hq', owner: hq, requester: hq, origin: 'delegated', parentId: 'missing' })).rejects.toThrow(/not found/);
    expect(await tasks.createUnderOpenParent({ title: 'k', deptId: 'hq', owner: hq, requester: hq, origin: 'delegated', parentId: 'missing' })).toBeNull();
    const p = await mk('44444444-4444-4444-8444-444444444444');
    expect(await tasks.createUnderOpenParent({ title: 'k', deptId: 'hq', owner: hq, requester: hq, origin: 'delegated', parentId: p.id })).toBeNull(); // todo is not doing/review
    const n = (await db.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM tasks WHERE title = 'k'")).rows[0]!.n;
    expect(n).toBe(0);
  });
});
