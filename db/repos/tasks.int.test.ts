import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../migrate.js';
import { freshDb, type TestDb } from '../test-helpers.js';
import { DepartmentRepo } from './org.js';
import { PersonaWebhookRepo } from './persona-webhooks.js';
import { MemTasks } from '../../agents/test-helpers.js';
import { TaskRepo } from './tasks.js';

let db: TestDb;
let tasks: TaskRepo;
beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations'), 'up');
  const depts = new DepartmentRepo(db.pool);
  for (const id of ['hq', 'software'])
    await depts.upsert({ id, name: id, categoryNamePattern: '', workChannelId: null, color: 0, model: null, provider: null, enabled: true });
  tasks = new TaskRepo(db.pool);
});
beforeEach(async () => { await db.pool.query('DELETE FROM tasks'); });
afterAll(async () => { await db.close(); });

const base = { title: 't', deptId: 'software' as const, owner: { kind: 'head', dept: 'software' } as const, requester: { kind: 'human', userId: '42' } as const, origin: 'chat' as const };

describe('TaskRepo', () => {
  it('create/get roundtrip preserves ActorRef json', async () => {
    const t = await tasks.create({ ...base, owner: { kind: 'persona', personaId: 'system-analyst' }, estCostUsd: 0.25 });
    expect(await tasks.get(t.id)).toEqual(t);
    expect(t).toMatchObject({
      owner: { kind: 'persona', personaId: 'system-analyst' }, requester: { kind: 'human', userId: '42' },
      status: 'todo', depth: 0, parentId: null, rootId: t.id, costUsd: 0, estCostUsd: 0.25,
    });
  });

  it('child inherits root_id and depth from parent', async () => {
    const root = await tasks.create(base);
    const child = await tasks.create({ ...base, parentId: root.id });
    const grand = await tasks.create({ ...base, parentId: child.id });
    expect([child.rootId, grand.rootId]).toEqual([root.id, root.id]);
    expect([child.depth, grand.depth]).toEqual([1, 2]);
  });

  it('update with stale expectedStatus returns null', async () => {
    const t = await tasks.create(base);
    expect(await tasks.update(t.id, { status: 'doing', costUsd: 0.125 }, 'todo')).toMatchObject({ status: 'doing', costUsd: 0.125 });
    expect(await tasks.update(t.id, { status: 'done' }, 'todo')).toBeNull();
    expect((await tasks.get(t.id))?.status).toBe('doing');
  });

  it('resetDoingToTodo moves only doing rows and returns them', async () => {
    const a = await tasks.create({ ...base, status: 'doing' });
    const b = await tasks.create({ ...base, status: 'review' });
    expect(await tasks.resetDoingToTodo()).toEqual([expect.objectContaining({ id: a.id, status: 'todo' })]);
    expect((await tasks.get(a.id))?.status).toBe('todo');
    expect((await tasks.get(b.id))?.status).toBe('review');
  });

  it('blockedReason is stored with blocked and cleared by any other status (R35)', async () => {
    const t = await tasks.create(base);
    expect(t.blockedReason).toBeNull();
    expect(await tasks.update(t.id, { status: 'blocked', blockedReason: 'halt' })).toMatchObject({ status: 'blocked', blockedReason: 'halt' });
    expect(await tasks.update(t.id, { status: 'todo' })).toMatchObject({ status: 'todo', blockedReason: null });
    expect(await tasks.update(t.id, { status: 'blocked' })).toMatchObject({ status: 'blocked', blockedReason: null });
  });

  it('unblockHalted moves only halt-blocked rows to todo, clears the reason and returns them (R35)', async () => {
    const a = await tasks.create({ ...base, status: 'blocked' });
    await tasks.update(a.id, { blockedReason: 'halt' });
    const b = await tasks.create({ ...base, status: 'blocked' });
    await tasks.update(b.id, { blockedReason: 'budget' });
    const changed = await tasks.unblockHalted();
    expect(changed).toEqual([expect.objectContaining({ id: a.id, status: 'todo', blockedReason: null })]);
    expect(await tasks.get(b.id)).toMatchObject({ status: 'blocked', blockedReason: 'budget' });
  });

  it('findByThread and listByStatus', async () => {
    const t = await tasks.create({ ...base, threadId: 'th1' });
    expect((await tasks.findByThread('th1'))?.id).toBe(t.id);
    expect(await tasks.findByThread('nope')).toBeNull();
    expect((await tasks.listByStatus('todo')).map((x) => x.id)).toEqual([t.id]);
  });
});

// Same cases against the real repo and the in-memory fake (backend rule 9).
describe.each([['TaskRepo', () => tasks], ['MemTasks', () => new MemTasks() as unknown as TaskRepo]] as const)('%s.lastEndedChild', (_n, repo) => {
  it('is the child that most recently became done or cancelled; open children and other parents do not count', async () => {
    const r = repo();
    const p = await r.create(base);
    const other = await r.create(base);
    expect(await r.lastEndedChild(p.id)).toBeNull();
    const a = await r.create({ ...base, parentId: p.id });
    const b = await r.create({ ...base, parentId: p.id });
    const c = await r.create({ ...base, parentId: p.id });
    await r.create({ ...base, parentId: other.id, status: 'done' });
    await r.update(b.id, { status: 'done' });
    await new Promise((res) => setTimeout(res, 5));
    await r.update(a.id, { status: 'cancelled' });
    await r.update(c.id, { status: 'doing' });
    expect((await r.lastEndedChild(p.id))?.id).toBe(a.id);
    await new Promise((res) => setTimeout(res, 5));
    await r.update(b.id, { description: 'later edit' });
    await r.update(c.id, { status: 'done' });
    expect((await r.lastEndedChild(p.id))?.id).toBe(c.id);
  });
});

describe('PersonaWebhookRepo', () => {
  it('upsert, lookup by channel and webhook id', async () => {
    const r = new PersonaWebhookRepo(db.pool);
    const w = { channelId: 'c1', webhookId: 'w1', applicationId: 'app1', deptId: 'software' as const };
    await r.upsert(w);
    await r.upsert({ ...w, webhookId: 'w2' });
    expect(await r.getByChannel('c1')).toEqual({ ...w, webhookId: 'w2' });
    expect(await r.getByWebhookId('w2')).toMatchObject({ channelId: 'c1' });
    expect(await r.getByWebhookId('w1')).toBeNull();
  });
});

describe('TaskRepo counts', () => {
  it('countChildren counts direct children; countOpen excludes done and cancelled', async () => {
    const root = await tasks.create(base);
    const c1 = await tasks.create({ ...base, parentId: root.id });
    await tasks.create({ ...base, parentId: root.id });
    await tasks.create({ ...base, parentId: c1.id });
    expect(await tasks.countChildren(root.id)).toBe(2);
    expect(await tasks.countOpen()).toBe(4);
    await tasks.update(c1.id, { status: 'done' });
    await tasks.update(root.id, { status: 'cancelled' });
    expect(await tasks.countOpen()).toBe(2);
  });

  it('countOpenChildren (the childrenPerTask cap since 2026-11-08) ignores done and cancelled children', async () => {
    const root = await tasks.create(base);
    const kids = await Promise.all([1, 2, 3].map(() => tasks.create({ ...base, parentId: root.id })));
    expect(await tasks.countOpenChildren(root.id)).toBe(3);
    await tasks.update(kids[0]!.id, { status: 'done' });
    await tasks.update(kids[1]!.id, { status: 'cancelled' });
    expect(await tasks.countOpenChildren(root.id)).toBe(1);
    expect(await tasks.countChildren(root.id)).toBe(3);
  });
});

describe.each([['TaskRepo', () => tasks], ['MemTasks', () => new MemTasks() as unknown as TaskRepo]] as const)('%s warroom wait (LF7)', (_n, repo) => {
  it('the id is stored once (snowflake only) and exactly one caller claims it', async () => {
    const r = repo();
    const t = await r.create({ title: 'c', deptId: 'hq', owner: { kind: 'head', dept: 'hq' }, requester: { kind: 'human', userId: '1' }, origin: 'chat', conversation: true });
    expect(await r.setWarroomSay(t.id, 'msg-1')).toBe(false);
    expect(await r.setWarroomSay(t.id, '1570000000000000001')).toBe(true);
    expect(await r.setWarroomSay(t.id, '1570000000000000002')).toBe(false);
    expect((await r.get(t.id))?.warroomSayId).toBe('1570000000000000001');
    const claims = await Promise.all([r.claimWarroomSay(t.id), r.claimWarroomSay(t.id), r.claimWarroomSay(t.id)]);
    expect(claims.filter(Boolean)).toHaveLength(1); // exactly one winner; which concurrent caller wins is not ordered

    expect((await r.get(t.id))?.warroomSayId ?? null).toBeNull();
  });
});

describe('TaskRepo origin (R3)', () => {
  it('stores origin, channelId and sourceUserId as given; no inheritance from the parent', async () => {
    const root = await tasks.create({ ...base, origin: 'slash', channelId: 'ch-9', sourceUserId: 'u7' });
    expect(await tasks.get(root.id)).toMatchObject({ origin: 'slash', channelId: 'ch-9', sourceUserId: 'u7' });
    const child = await tasks.create({ ...base, origin: 'delegated', parentId: root.id });
    expect(child).toMatchObject({ origin: 'delegated', channelId: null, sourceUserId: null });
  });

  it('CHECK rejects values outside the nine origins; every one of the nine is accepted', async () => {
    for (const origin of ['chat', 'slash', 'voice', 'delegated', 'schedule', 'watch', 'reminder', 'poll', 'import'] as const)
      expect((await tasks.create({ ...base, origin })).origin).toBe(origin);
    await expect(tasks.create({ ...base, origin: 'admin' as never })).rejects.toThrow(/origin/);
    await expect(db.pool.query("UPDATE tasks SET origin = 'human'")).rejects.toThrow(/origin/);
  });

  it('there is no column default: a raw insert without origin fails', async () => {
    await expect(
      db.pool.query("INSERT INTO tasks (id, title, dept_id, owner, requester, root_id) VALUES ('x','t','software','{}','{}','x')"),
    ).rejects.toThrow(/origin/);
  });

  it('card ids: claim stores once (conditional UPDATE), replace needs the old id, bad ids are refused (TW15)', async () => {
    const t = await tasks.create(base);
    expect(await tasks.messageId(t.id, 'log')).toBeNull();
    expect(await tasks.claimMessage(t.id, 'log', 'not-a-snowflake')).toBe(false);
    expect(await tasks.claimMessage(t.id, 'log', '1570000000000000001')).toBe(true);
    expect(await tasks.claimMessage(t.id, 'log', '1570000000000000002')).toBe(false); // the loser of a race
    expect(await tasks.messageId(t.id, 'log')).toBe('1570000000000000001');
    expect(await tasks.messageId(t.id, 'card')).toBeNull(); // the two cards are independent
    expect(await tasks.replaceMessage(t.id, 'log', '1570000000000000009', '1570000000000000003')).toBe(false);
    expect(await tasks.replaceMessage(t.id, 'log', '1570000000000000001', '1570000000000000003')).toBe(true);
    expect((await tasks.get(t.id))).toMatchObject({ logMessageId: '1570000000000000003', cardMessageId: null });
  });

  it('boardSnapshot counts per status, caps rows and limits done to today', async () => {
    for (let i = 0; i < 3; i++) await tasks.create({ ...base, title: `d${i}`, status: 'doing' });
    await tasks.create({ ...base, status: 'todo' });
    const old = await tasks.create({ ...base, status: 'done' });
    await db.pool.query("UPDATE tasks SET updated_at = now() - interval '3 days' WHERE id = $1", [old.id]);
    await tasks.create({ ...base, status: 'done' });
    await tasks.create({ ...base, status: 'cancelled' });
    const snap = await tasks.boardSnapshot(2);
    expect(snap.doing.total).toBe(3);
    expect(snap.doing.rows).toHaveLength(2);
    expect([snap.todo.total, snap.done.total, snap.blocked.total]).toEqual([1, 1, 0]);
  });
});

describe('Work-style §5 repo queries', () => {
  it('openIds returns id, status and department only (no text), open statuses only', async () => {
    const a = await tasks.create({ ...base, title: 'SECRET TITLE' });
    await tasks.create({ ...base, title: 'closed' }).then((t) => tasks.update(t.id, { status: 'cancelled' }));
    const rows = await tasks.openIds(10);
    expect(rows).toEqual([{ id: a.id, status: 'todo', deptId: 'software' }]);
    expect(JSON.stringify(rows)).not.toContain('SECRET');
  });

  it('HEAL-1 H6: openOf shows a blocked task as blocked-<reason> (NULL reads owner), other statuses unchanged, never the note', async () => {
    const todo = await tasks.create({ ...base, title: 'plain' });
    const b1 = await tasks.create({ ...base, title: 'SECRET TITLE' });
    await tasks.update(b1.id, { status: 'blocked', blockedReason: 'budget' });
    const b2 = await tasks.create(base);
    await tasks.update(b2.id, { status: 'blocked' });
    const b3 = await tasks.create(base);
    await tasks.update(b3.id, { status: 'blocked', blockedReason: 'owner' });
    const rows = await tasks.openOf({ kind: 'head', dept: 'software' }, 10);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({ [todo.id]: 'todo', [b1.id]: 'blocked-budget', [b2.id]: 'blocked-owner', [b3.id]: 'blocked-owner' });
    expect(JSON.stringify(rows)).not.toContain('SECRET');
  });

  it('dashboardCounts counts open, blocked, review and done today, and pending approvals per origin category', async () => {
    const t1 = await tasks.create({ ...base, originCategoryId: '1570000000000000100' } as never);
    const t2 = await tasks.create(base);
    await tasks.update(t2.id, { status: 'blocked' });
    const t3 = await tasks.create(base);
    await tasks.update(t3.id, { status: 'done' });
    await db.pool.query("INSERT INTO approvals (task_id, reason, requested_by) VALUES ($1,'r','x'), ($1,'r','x'), ($2,'r','x')", [t1.id, t2.id]);
    const c = await tasks.dashboardCounts();
    expect(c).toMatchObject({ open: 2, blocked: 1, review: 0, doneToday: 1 });
    expect(c.pendingByCategory).toEqual([{ categoryId: '1570000000000000100', n: 2 }, { categoryId: null, n: 1 }]);
    await db.pool.query('DELETE FROM approvals');
  });

  it('claimOffdayNotice is taken once per root per local day', async () => {
    const t = await tasks.create(base);
    expect(await tasks.claimOffdayNotice(t.id, '2026-11-07')).toBe(true);
    expect(await tasks.claimOffdayNotice(t.id, '2026-11-07')).toBe(false);
    expect(await tasks.claimOffdayNotice(t.id, '2026-11-08')).toBe(true);
  });

  it('TEAMTALK: acceptance and due date round trip, the result message id takes a snowflake only, the handoff id is a message kind, openOwnedBy lists open persona tasks', async () => {
    const t = await tasks.create({ ...base, owner: { kind: 'persona', personaId: 'sa' }, acceptance: 'tests green', dueOn: '2026-11-20' });
    expect(t).toMatchObject({ acceptance: 'tests green', dueOn: '2026-11-20', handoffMessageId: null, resultMessageId: null });
    expect(await tasks.setResultMessage(t.id, 'nope')).toBe(false);
    expect(await tasks.setResultMessage(t.id, '1570000000000000009')).toBe(true);
    expect((await tasks.get(t.id))!.resultMessageId).toBe('1570000000000000009');
    expect(await tasks.claimMessage(t.id, 'handoff', '1570000000000000010')).toBe(true);
    expect(await tasks.claimMessage(t.id, 'handoff', '1570000000000000011')).toBe(false);
    expect(await tasks.messageId(t.id, 'handoff')).toBe('1570000000000000010');
    await expect(tasks.create({ ...base, dueOn: '2026-02-31' })).rejects.toThrow(/date/i);
    const done = await tasks.create({ ...base, owner: { kind: 'persona', personaId: 'sa' } });
    await tasks.update(done.id, { status: 'done' });
    await tasks.create({ ...base, owner: { kind: 'persona', personaId: 'other' } });
    expect((await tasks.openOwnedBy('sa', 8)).map((x) => x.id)).toEqual([t.id]);
  });

  describe('REROUTE-1 (RR-C5, RR-C12, RR-C14)', () => {
    const SRC = '1570000000000000501';
    const WHERE = '1570000000000000502';
    const hq = { kind: 'head', dept: 'hq' } as const;
    const kid = (o: Record<string, unknown> = {}) => ({ ...base, deptId: 'software' as const, owner: base.owner, requester: hq, origin: 'delegated' as const, rerouteSourceId: SRC, rerouteWhere: WHERE, ...o });

    it('the guarded insert makes the child only while the parent is doing or review; a done, cancelled, blocked or missing parent makes no row', async () => {
      const parent = await tasks.create({ ...base, deptId: 'hq', owner: hq, status: 'doing' });
      expect(await tasks.createUnderOpenParent(kid({ parentId: parent.id }) as never)).toMatchObject({ parentId: parent.id, rootId: parent.id, depth: 1, rerouteSourceId: SRC, rerouteWhere: WHERE });
      for (const [i, status] of (['review'] as const).entries()) {
        await tasks.update(parent.id, { status });
        expect(await tasks.createUnderOpenParent(kid({ parentId: parent.id, rerouteSourceId: `157000000000000060${i}` }) as never), status).not.toBeNull();
      }
      for (const status of ['done', 'cancelled', 'blocked', 'todo', 'awaiting_approval'] as const) {
        await tasks.update(parent.id, { status });
        const before = (await db.pool.query('SELECT count(*)::int AS n FROM tasks')).rows[0].n;
        expect(await tasks.createUnderOpenParent(kid({ parentId: parent.id, rerouteSourceId: '1570000000000000700' }) as never), status).toBeNull();
        expect((await db.pool.query('SELECT count(*)::int AS n FROM tasks')).rows[0].n, status).toBe(before);
      }
      expect(await tasks.createUnderOpenParent(kid({ parentId: 'no-such-parent' }) as never)).toBeNull();
    });

    it('one task per (message, department): the second insert violates tasks_reroute_once; another department with the same message is fine', async () => {
      await tasks.create(kid());
      await expect(tasks.create(kid())).rejects.toMatchObject({ code: '23505', constraint: 'tasks_reroute_once' });
      expect(await tasks.rerouteExists(SRC, 'software')).toBe(true);
      expect(await tasks.rerouteExists(SRC, 'hq')).toBe(false);
      await expect(tasks.create(kid({ deptId: 'hq' }))).resolves.toMatchObject({ deptId: 'hq' });
    });

    it('a source or channel id that is not a snowflake is refused by the column CHECK (23514)', async () => {
      await expect(tasks.create(kid({ rerouteSourceId: 'stall-1' }))).rejects.toMatchObject({ code: '23514' });
      await expect(tasks.create(kid({ rerouteWhere: 'x' }))).rejects.toMatchObject({ code: '23514' });
    });

    it('recentRerouteOpen: same mentioner, department and source within the window; or an open child of the parent in that department; done tasks and other sources do not count', async () => {
      const since = new Date(Date.now() - 60_000);
      expect(await tasks.recentRerouteOpen({ deptId: 'software', requester: hq, where: WHERE, since })).toBe(false);
      const a = await tasks.create(kid());
      expect(await tasks.recentRerouteOpen({ deptId: 'software', requester: hq, where: WHERE, since })).toBe(true);
      expect(await tasks.recentRerouteOpen({ deptId: 'software', requester: hq, where: '1570000000000000999', since })).toBe(false);
      expect(await tasks.recentRerouteOpen({ deptId: 'software', requester: { kind: 'head', dept: 'rnd' }, where: WHERE, since })).toBe(false);
      expect(await tasks.recentRerouteOpen({ deptId: 'hq', requester: hq, where: WHERE, since })).toBe(false);
      expect(await tasks.recentRerouteOpen({ deptId: 'software', requester: hq, where: WHERE, since: new Date(Date.now() + 60_000) })).toBe(false);
      await tasks.update(a.id, { status: 'done' });
      expect(await tasks.recentRerouteOpen({ deptId: 'software', requester: hq, where: WHERE, since })).toBe(false);
      const parent = await tasks.create({ ...base, deptId: 'hq', owner: hq, status: 'doing' });
      await tasks.create({ ...base, parentId: parent.id, requester: hq, origin: 'delegated' }); // the mentioner's own create_task
      expect(await tasks.recentRerouteOpen({ deptId: 'software', requester: hq, where: WHERE, parentId: parent.id, since })).toBe(true);
    });

    it('countOpenRerouteRoots counts a person\'s open rerouted roots only', async () => {
      const person = { kind: 'human', userId: '42' } as const;
      await tasks.create(kid({ requester: person, origin: 'chat', rerouteSourceId: '1570000000000000801' }));
      const done = await tasks.create(kid({ requester: person, origin: 'chat', rerouteSourceId: '1570000000000000802' }));
      await tasks.update(done.id, { status: 'done' });
      await tasks.create(kid({ requester: { kind: 'human', userId: '43' }, origin: 'chat', rerouteSourceId: '1570000000000000803' }));
      await tasks.create({ ...base, requester: person }); // not rerouted
      const parent = await tasks.create({ ...base, status: 'doing' });
      await tasks.create(kid({ requester: person, parentId: parent.id, rerouteSourceId: '1570000000000000804' })); // a child, not a root
      expect(await tasks.countOpenRerouteRoots('42')).toBe(1);
      expect(await tasks.countOpenRerouteRoots('43')).toBe(1);
      expect(await tasks.countOpenRerouteRoots('44')).toBe(0);
    });

    it('migration 032 down then up again leaves the columns and the unique index working', async () => {
      const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
      await db.pool.query('DELETE FROM tasks');
      const sql = (f: string) => readFileSync(join(dir, f), 'utf8');
      for (let i = 0; i < 2; i++) {
        await db.pool.query(sql('032_reroute.down.sql'));
        const cols = await db.pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'tasks' AND column_name LIKE 'reroute%'");
        expect(cols.rows).toEqual([]);
        expect((await db.pool.query("SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname LIKE 'tasks_reroute%'")).rowCount).toBe(0);
        await db.pool.query(sql('032_reroute.up.sql'));
      }
      await tasks.create(kid());
      await expect(tasks.create(kid())).rejects.toMatchObject({ constraint: 'tasks_reroute_once' });
    });
  });
});

describe('TaskRepo stale review (OPS-HOLD)', () => {
  afterEach(async () => { await db.pool.query('DELETE FROM approvals'); await db.pool.query('DELETE FROM projects'); });
  const old = (id: string) => db.pool.query("UPDATE tasks SET updated_at = now() - interval '30 hours' WHERE id = $1", [id]);
  const review = async (o: Partial<Parameters<TaskRepo['create']>[0]> = {}) => {
    const t = await tasks.create({ ...base, ...o });
    await tasks.update(t.id, { status: 'review' });
    await old(t.id);
    return t;
  };
  const cutoff = () => new Date(Date.now() - 24 * 3_600_000);
  it('lists only old review tasks with nothing open under them, no pending approval and no active project', async () => {
    const ok = await review();
    const withChild = await review();
    await tasks.create({ ...base, parentId: withChild.id });
    const endedChild = await review();
    const c = await tasks.create({ ...base, parentId: endedChild.id });
    await tasks.update(c.id, { status: 'done' });
    const pending = await review();
    await db.pool.query("INSERT INTO approvals (task_id, reason, requested_by) VALUES ($1,'r','head:hq')", [pending.id]);
    const inProject = await review();
    await db.pool.query(
      `INSERT INTO projects (token, title, goal, deadline, max_local_calls, max_usd, max_approvals, base_local_calls, base_usd, base_approvals, status, root_task_id, approved_by, approved_at, proposer, expires_at)
       VALUES (repeat('a',32),'p','g',current_date + 30,10,1,10,10,1,10,'active',$1,'12345678901234567',now(),'head:hq',now() + interval '1 day')`, [inProject.id]);
    const fresh = await tasks.create({ ...base });
    await tasks.update(fresh.id, { status: 'review' });
    const doing = await tasks.create({ ...base });
    await tasks.update(doing.id, { status: 'doing' });
    await old(doing.id);
    const ids = (await tasks.staleReview(cutoff(), 50)).map((t) => t.id);
    expect(ids.sort()).toEqual([ok.id, endedChild.id].sort());
  });
  it('R1-02: an open ASKBACK question (pending or asked, unexpired) on the task or a descendant keeps it out; answered, expired and moot ones do not', async () => {
    const q = (taskId: string, status: string, exp: string | null) => db.pool.query(
      `INSERT INTO task_questions (task_id, root_id, seq, asker, requester, question, status, asked_at, expires_at, closed_at, answer)
       SELECT id, root_id, 1, '{"kind":"head","dept":"hq"}', '{"kind":"head","dept":"hq"}', 'q?', $2::text, now(), ${exp ?? 'NULL'},
              CASE WHEN $2::text IN ('pending','asked') THEN NULL ELSE now() END, CASE WHEN $2::text = 'answered' THEN 'a' END FROM tasks WHERE id = $1`, [taskId, status]);
    const own = await review();
    await q(own.id, 'asked', "now() + interval '1 hour'");
    const viaKid = await review();
    const kid = await tasks.create({ ...base, parentId: viaKid.id });
    await tasks.update(kid.id, { status: 'done' });
    await q(kid.id, 'pending', null);
    const answered = await review();
    await q(answered.id, 'answered', null);
    const expired = await review();
    await q(expired.id, 'asked', "now() - interval '1 minute'");
    const moot = await review();
    await q(moot.id, 'moot', null);
    const ids = (await tasks.staleReview(cutoff(), 50)).map((t) => t.id);
    expect(ids.sort()).toEqual([answered.id, expired.id, moot.id].sort());
    await db.pool.query('DELETE FROM task_questions');
  });
  it('a project that is done no longer shields its tree', async () => {
    const t = await review();
    await db.pool.query(
      `INSERT INTO projects (token, title, goal, deadline, max_local_calls, max_usd, max_approvals, base_local_calls, base_usd, base_approvals, status, root_task_id, approved_by, approved_at, proposer, expires_at)
       VALUES (repeat('b',32),'p','g',current_date + 30,10,1,10,10,1,10,'done',$1,'12345678901234567',now(),'head:hq',now() + interval '1 day')`, [t.id]);
    expect((await tasks.staleReview(cutoff(), 50)).map((x) => x.id)).toEqual([t.id]);
  });
  it('closeStaleReview moves review to done once; it refuses a task that was touched, got a child or left review', async () => {
    const t = await review();
    expect(await tasks.closeStaleReview(t.id, cutoff())).toMatchObject({ id: t.id, status: 'done' });
    expect(await tasks.closeStaleReview(t.id, cutoff())).toBeNull();
    const touched = await review();
    await tasks.update(touched.id, { turnsUsed: 1 });
    expect(await tasks.closeStaleReview(touched.id, cutoff())).toBeNull();
    const parent = await review();
    await tasks.create({ ...base, parentId: parent.id });
    expect(await tasks.closeStaleReview(parent.id, cutoff())).toBeNull();
  });
});
