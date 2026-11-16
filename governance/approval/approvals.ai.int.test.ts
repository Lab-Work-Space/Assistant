import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ActorRef } from '../../company/types.js';
import { EventBus, type AppEvents } from '../../core/events.js';
import { DepartmentRepo, TaskRepo } from '../../db/index.js';
import { migrate } from '../../db/migrate.js';
import { AiApproverRepo } from '../../db/repos/ai-approver.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { FakeConfig } from '../test-helpers.js';
import { inputDigest, canonicalJson } from '../canonical.js';
import { Approvals } from './approvals.js';

let db: TestDb;
let tasks: TaskRepo;
let repo: AiApproverRepo;
const hq: ActorRef = { kind: 'head', dept: 'hq' };
const TZ = 'Asia/Bangkok';
const ON = async () => true;

class FakeHalt {
  halted = false;
  haltFromCall = Infinity;
  calls = 0;
  isHalted() { this.calls++; return this.halted || this.calls >= this.haltFromCall; }
}

const mk = () => {
  const cfg = new FakeConfig({});
  const bus = new EventBus<AppEvents>();
  const halt = new FakeHalt();
  const ready: { taskId: string }[] = [];
  bus.on('task.ready', (p) => { ready.push(p); });
  const approvals = new Approvals(db.pool, tasks, cfg, bus, halt, async () => undefined, ['hunter2-secret-literal']);
  return { cfg, approvals, halt, ready };
};
const input = (n: number) => ({ body: `post ${n}` });
const sha = (i: unknown) => inputDigest(canonicalJson(i));
const R = (reason = 'fits', over: Partial<{ sha: string; maxPerTree: number; maxPerDay: number; tz: string; stillOn: () => Promise<boolean> }> = {}) =>
  ({ sha: '', reason, maxPerTree: 40, maxPerDay: 300, tz: TZ, stillOn: ON, ...over });

async function newTask(parentId?: string) {
  return tasks.create({ title: 't', deptId: 'hq', owner: hq, requester: { kind: 'human', userId: '1' }, origin: 'chat', ...(parentId ? { parentId } : {}) });
}
async function request(m: ReturnType<typeof mk>, taskId: string, n = 1, name = 'forum_post') {
  const i = input(n);
  const a = await m.approvals.request({ kind: 'tool', tool: { name, input: i }, taskId, reason: 'tool forum_post: post', estCostUsd: 0, requestedBy: hq });
  return { a, sha: sha(i) };
}
const seedApproves = async (taskId: string, n: number, ago = '0 seconds') => {
  await db.pool.query(
    "INSERT INTO audit_log (actor, action, task_id, tool, outcome, ts) SELECT 'system:ai-approver','approval.ai.approve',$1,'forum_post','#0 seed', now() - $3::interval FROM generate_series(1,$2)", [taskId, n, ago]);
};
const aiRows = async () => (await db.pool.query("SELECT actor, action, tool, outcome FROM audit_log WHERE action IN ('approval.ai.approve','approval.approve') ORDER BY id")).rows;
const status = async (id: number) => (await db.pool.query<{ status: string; decided_by: string | null }>('SELECT status, decided_by FROM approvals WHERE id = $1', [id])).rows[0]!;
const taskStatus = async (id: string) => (await db.pool.query<{ status: string }>('SELECT status FROM tasks WHERE id = $1', [id])).rows[0]!.status;

beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations'), 'up');
  await new DepartmentRepo(db.pool).upsert({ id: 'hq', name: 'HQ', categoryNamePattern: '', workChannelId: null, color: 0, model: null, provider: null, enabled: true });
  tasks = new TaskRepo(db.pool);
  repo = new AiApproverRepo(db.pool);
});
beforeEach(async () => {
  await db.pool.query('DROP TRIGGER IF EXISTS fail_decide ON audit_log');
  await db.pool.query('DELETE FROM approvals');
  await db.pool.query('DELETE FROM approval_batches');
  await db.pool.query('DELETE FROM audit_log');
  await db.pool.query('DELETE FROM tasks');
});
afterAll(async () => { await db.close(); });

describe('Approvals.decideAi (AA-C11, AA-C12, AA-C14)', () => {
  it('approves one pending tool approval: two audit rows, decided_by ai-approver, task todo, task.ready', async () => {
    const m = mk();
    const t = await newTask();
    const { a, sha: s } = await request(m, t.id);
    expect(await taskStatus(t.id)).toBe('awaiting_approval');
    const res = await m.approvals.decideAi(a.id, R('looks fine hunter2-secret-literal', { sha: s }));
    expect(res).toMatchObject({ ok: true, tree: 1, day: 1 });
    expect(await status(a.id)).toEqual({ status: 'approved', decided_by: 'ai-approver' });
    expect(await taskStatus(t.id)).toBe('todo');
    expect(m.ready).toEqual([{ taskId: t.id }]);
    const rows = await aiRows();
    expect(rows).toEqual([
      { actor: 'system:ai-approver', action: 'approval.ai.approve', tool: 'forum_post', outcome: `#${a.id} looks fine [REDACTED]` },
      { actor: 'user:ai-approver', action: 'approval.approve', tool: 'forum_post', outcome: `ok #${a.id}` },
    ]);
  });
  it('refuses the rows it must not decide and changes nothing', async () => {
    const m = mk();
    const t = await newTask();
    const { a, sha: s } = await request(m, t.id);
    expect(await m.approvals.decideAi(a.id, R('x', { sha: 'f'.repeat(64) }))).toEqual({ ok: false, error: 'input_mismatch' });
    expect(await m.approvals.decideAi(999999, R('x', { sha: s }))).toEqual({ ok: false, error: 'not_pending' });
    await db.pool.query("UPDATE approvals SET created_at = now() - interval '3 days' WHERE id = $1", [a.id]);
    expect(await m.approvals.decideAi(a.id, R('x', { sha: s }))).toEqual({ ok: false, error: 'expired' });
    await db.pool.query("UPDATE approvals SET created_at = now(), kind = 'estimate' WHERE id = $1", [a.id]);
    expect(await m.approvals.decideAi(a.id, R('x', { sha: s }))).toEqual({ ok: false, error: 'not_tool' });
    await db.pool.query("UPDATE approvals SET kind = 'tool' WHERE id = $1", [a.id]);
    const t2 = await newTask();
    const b = await request(m, t2.id, 2);
    await db.pool.query("INSERT INTO approval_batches (task_id, requested_by, state, item_count, items_digest) VALUES ($1,'head:hq','open',1,'abcdef123456')", [t2.id]);
    await db.pool.query('UPDATE approvals SET batch_id = (SELECT max(id) FROM approval_batches) WHERE id = $1', [b.a.id]);
    expect(await m.approvals.decideAi(b.a.id, R('x', { sha: b.sha }))).toEqual({ ok: false, error: 'not_tool' });
    expect(await status(b.a.id)).toEqual({ status: 'pending', decided_by: null });
    expect(await status(a.id)).toEqual({ status: 'pending', decided_by: null });
    expect(await aiRows()).toEqual([]);
    await db.pool.query("UPDATE approvals SET status = 'rejected' WHERE id = $1", [a.id]);
    expect(await m.approvals.decideAi(a.id, R('x', { sha: s }))).toEqual({ ok: false, error: 'not_pending' });
  });
  it('cap boundaries: tree 39 approves, tree 40 refuses; day 299 approves, day 300 refuses', async () => {
    const m = mk();
    const t = await newTask();
    await seedApproves(t.id, 39);
    const one = await request(m, t.id, 1);
    expect(await m.approvals.decideAi(one.a.id, R('x', { sha: one.sha }))).toMatchObject({ ok: true, tree: 40 });
    const two = await request(m, t.id, 2);
    expect(await m.approvals.decideAi(two.a.id, R('x', { sha: two.sha }))).toEqual({ ok: false, error: 'cap_tree' });
    expect(await status(two.a.id)).toMatchObject({ status: 'pending' });
    // day: another tree, 299 rows today elsewhere
    await db.pool.query('DELETE FROM audit_log');
    const t2 = await newTask();
    await seedApproves(t2.id, 299);
    const three = await request(m, (await newTask()).id, 3);
    expect(await m.approvals.decideAi(three.a.id, R('x', { sha: three.sha }))).toMatchObject({ ok: true, day: 300 });
    const four = await request(m, (await newTask()).id, 4);
    expect(await m.approvals.decideAi(four.a.id, R('x', { sha: four.sha }))).toEqual({ ok: false, error: 'cap_day' });
  });
  it('yesterday\'s approvals count for the tree (lifetime) but not for the day (zone-local), and other trees do not count against the tree', async () => {
    const m = mk();
    const t = await newTask();
    await seedApproves(t.id, 300, '2 days');
    const other = await newTask();
    await seedApproves(other.id, 39);
    const a = await request(m, t.id);
    expect(await m.approvals.decideAi(a.a.id, R('x', { sha: a.sha, maxPerTree: 500, maxPerDay: 40 }))).toMatchObject({ ok: true, tree: 301, day: 40 });
  });
  it('two concurrent reviews at tree cap-1 give exactly one approve (same tree)', async () => {
    const m = mk();
    const root = await newTask();
    const child = await newTask(root.id);
    await seedApproves(root.id, 39);
    const x = await request(m, root.id, 1);
    const y = await request(m, child.id, 2);
    const res = await Promise.all([m.approvals.decideAi(x.a.id, R('x', { sha: x.sha })), m.approvals.decideAi(y.a.id, R('x', { sha: y.sha }))]);
    expect(res.filter((r) => r.ok)).toHaveLength(1);
    expect(res.filter((r) => !r.ok)).toEqual([{ ok: false, error: 'cap_tree' }]);
    expect((await aiRows()).filter((r) => r.action === 'approval.ai.approve' && !String(r.outcome).endsWith('seed'))).toHaveLength(1);
    expect(await repo.countTree(root.id)).toBe(40 + 0);
  });
  it('two concurrent reviews in different trees at day cap-1 give exactly one approve', async () => {
    const m = mk();
    const seed = await newTask();
    await seedApproves(seed.id, 299);
    const x = await request(m, (await newTask()).id, 1);
    const y = await request(m, (await newTask()).id, 2);
    const res = await Promise.all([m.approvals.decideAi(x.a.id, R('x', { sha: x.sha })), m.approvals.decideAi(y.a.id, R('x', { sha: y.sha }))]);
    expect(res.filter((r) => r.ok)).toHaveLength(1);
    expect(res.filter((r) => !r.ok)).toEqual([{ ok: false, error: 'cap_day' }]);
  });
  it('a failed audit insert rolls the whole approve back', async () => {
    const m = mk();
    const t = await newTask();
    const { a, sha: s } = await request(m, t.id);
    await db.pool.query(`CREATE OR REPLACE FUNCTION fail_decide_fn() RETURNS trigger AS $$ BEGIN IF NEW.action = 'approval.approve' THEN RAISE EXCEPTION 'planted'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await db.pool.query('CREATE TRIGGER fail_decide BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION fail_decide_fn()');
    await expect(m.approvals.decideAi(a.id, R('x', { sha: s }))).rejects.toThrow(/planted/);
    await db.pool.query('DROP TRIGGER fail_decide ON audit_log');
    expect(await status(a.id)).toEqual({ status: 'pending', decided_by: null });
    expect(await taskStatus(t.id)).toBe('awaiting_approval');
    expect(await aiRows()).toEqual([]);
    expect(m.ready).toEqual([]);
  });
  it('halt: refused before the transaction and at the last check; nothing is written', async () => {
    const m = mk();
    const t = await newTask();
    const { a, sha: s } = await request(m, t.id);
    m.halt.halted = true;
    expect(await m.approvals.decideAi(a.id, R('x', { sha: s }))).toEqual({ ok: false, error: 'halted' });
    m.halt.halted = false;
    m.halt.calls = 0;
    m.halt.haltFromCall = 2; // the second isHalted() call is the one inside the transaction
    expect(await m.approvals.decideAi(a.id, R('x', { sha: s }))).toEqual({ ok: false, error: 'halted' });
    expect(await status(a.id)).toEqual({ status: 'pending', decided_by: null });
    expect(await aiRows()).toEqual([]);
  });
  it('the enabled/pause re-check inside the transaction (a false answer or a throw) refuses with nothing written', async () => {
    const m = mk();
    const t = await newTask();
    const { a, sha: s } = await request(m, t.id);
    expect(await m.approvals.decideAi(a.id, R('x', { sha: s, stillOn: async () => false }))).toEqual({ ok: false, error: 'not_enabled' });
    expect(await m.approvals.decideAi(a.id, R('x', { sha: s, stillOn: async () => { throw new Error('db'); } }))).toEqual({ ok: false, error: 'not_enabled' });
    expect(await status(a.id)).toEqual({ status: 'pending', decided_by: null });
    expect(await aiRows()).toEqual([]);
  });
  it('decideAi creates no web grant and no task grant', async () => {
    const m = mk();
    const t = await newTask();
    const { a, sha: s } = await request(m, t.id, 1, 'fetch_page');
    await m.approvals.decideAi(a.id, R('x', { sha: s }));
    expect((await db.pool.query('SELECT count(*)::int AS n FROM web_grants')).rows[0].n).toBe(0);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM task_grants')).rows[0].n).toBe(0);
  });
});

describe('AiApproverRepo', () => {
  const user = (id: string) => `user:${id}`;
  const U = '123456789012345678';
  const row = (actor: string, action: string, ago = '0 seconds') => db.pool.query("INSERT INTO audit_log (actor, action, outcome, ts) VALUES ($1,$2,'ok', now() - $3::interval)", [actor, action, ago]);
  it('pausedToday: newest of today wins; yesterday and non-user actors are ignored', async () => {
    expect(await repo.pausedToday(TZ)).toBe(false);
    await row(user(U), 'approval.ai.pause', '3 days');
    expect(await repo.pausedToday(TZ)).toBe(false);
    await row('system:ai-approver', 'approval.ai.pause');
    await row('user:short', 'approval.ai.pause');
    await row('head:hq', 'approval.ai.pause');
    expect(await repo.pausedToday(TZ)).toBe(false);
    await row(user(U), 'approval.ai.pause', '2 seconds');
    expect(await repo.pausedToday(TZ)).toBe(true);
    await row(user(U), 'approval.ai.resume', '1 second');
    expect(await repo.pausedToday(TZ)).toBe(false);
    await row(user(U), 'approval.ai.pause');
    expect(await repo.pausedToday(TZ)).toBe(true);
  });
  it('setPause writes the user rows pausedToday reads: pause, resume, pause ends paused; a bad user id is not honoured', async () => {
    await repo.setPause(U, true);
    expect(await repo.pausedToday(TZ)).toBe(true);
    await repo.setPause(U, false);
    expect(await repo.pausedToday(TZ)).toBe(false);
    await repo.setPause(U, true);
    expect(await repo.pausedToday(TZ)).toBe(true);
    expect((await db.pool.query("SELECT actor, outcome FROM audit_log WHERE action = 'approval.ai.pause' ORDER BY id DESC LIMIT 1")).rows[0]).toEqual({ actor: user(U), outcome: 'ok' });
    await repo.setPause(U, false);
    await repo.setPause('abc', true); // the reader ignores it (AA-C18)
    expect(await repo.pausedToday(TZ)).toBe(false);
  });
  it('day (the digest read): approvals per tool, escalation codes, judge reasons newest first, reviews and capHit', async () => {
    const ins = (action: string, tool: string | null, outcome: string) => db.pool.query("INSERT INTO audit_log (actor, action, tool, outcome) VALUES ('system:ai-approver',$1,$2,$3)", [action, tool, outcome]);
    expect((await repo.day(TZ)).reviews).toBe(0);
    await ins('approval.ai.approve', 'forum_post', '#1 fine');
    await ins('approval.ai.approve', 'forum_post', '#2 fine');
    await ins('approval.ai.approve', 'web_search', '#3 fine');
    await ins('approval.ai.escalate', 'fetch_page', '#4 url_heuristic');
    await ins('approval.ai.escalate', 'fetch_page', '#5 judge first reason');
    await ins('approval.ai.escalate', 'fetch_page', '#6 judge second reason');
    const d = await repo.day(TZ);
    expect(d.reviews).toBe(6);
    expect(d.approvals).toEqual([{ tool: 'forum_post', n: 2 }, { tool: 'web_search', n: 1 }]);
    expect(d.escalations).toEqual([{ code: 'judge', n: 2 }, { code: 'url_heuristic', n: 1 }]);
    expect(d.reasons).toEqual(['second reason', 'first reason']);
    expect(d.capHit).toBe(false);
    await ins('approval.ai.escalate', 'forum_post', '#7 cap_day');
    expect((await repo.day(TZ)).capHit).toBe(true);
  });
  it('claim throws on a bad write; counts read the claim rows', async () => {
    const t = await newTask();
    await repo.claim({ actor: 'system:ai-approver', action: 'approval.ai.review', taskId: t.id, tool: 'forum_post', outcome: '#1 start' });
    expect(await repo.reviewsDay(TZ)).toBe(1);
    await expect(repo.claim({ actor: null as never, action: 'approval.ai.review', taskId: t.id, outcome: '#2 start' })).rejects.toThrow();
    await seedApproves(t.id, 2);
    expect(await repo.countTree(t.id)).toBe(2);
    expect(await repo.countDay(TZ)).toBe(2);
  });
  it('interrupted: start only is listed; start plus escalate or approve is not; batch members, expired and decided rows are not', async () => {
    const m = mk();
    const t = await newTask();
    const mkRow = async (n: number) => (await request(m, (await newTask()).id, n)).a;
    const [onlyStart, escalated, approved, batched, old, decided] = [await mkRow(1), await mkRow(2), await mkRow(3), await mkRow(4), await mkRow(5), await mkRow(6)];
    const start = (a: { id: number }, ago = '1 minute') => db.pool.query("INSERT INTO audit_log (actor, action, tool, outcome, ts) VALUES ('system:ai-approver','approval.ai.review','forum_post',$1, now() - $2::interval)", [`#${a.id} start`, ago]);
    for (const a of [onlyStart, escalated, approved, batched, old, decided]) await start(a);
    await db.pool.query("INSERT INTO audit_log (actor, action, outcome) VALUES ('system:ai-approver','approval.ai.escalate',$1)", [`#${escalated.id} judge odd`]);
    await db.pool.query("INSERT INTO audit_log (actor, action, outcome) VALUES ('system:ai-approver','approval.ai.approve',$1)", [`#${approved.id} fine`]);
    await db.pool.query("INSERT INTO approval_batches (task_id, requested_by, state, item_count, items_digest) VALUES ($1,'head:hq','open',1,'abcdef123456')", [batched.taskId]);
    await db.pool.query('UPDATE approvals SET batch_id = (SELECT max(id) FROM approval_batches) WHERE id = $1', [batched.id]);
    await db.pool.query("UPDATE approvals SET created_at = now() - interval '3 days' WHERE id = $1", [old.id]);
    await db.pool.query("UPDATE approvals SET status = 'approved' WHERE id = $1", [decided.id]);
    expect((await repo.interrupted(24)).map((a) => a.id)).toEqual([onlyStart.id]);
    expect((await repo.interrupted(24))[0]).toMatchObject({ kind: 'tool', toolName: 'forum_post', aiReview: null });
    // a prefix id must not match: #1 start vs #11 escalate
    await db.pool.query("INSERT INTO audit_log (actor, action, outcome) VALUES ('system:ai-approver','approval.ai.escalate',$1)", [`#${onlyStart.id}0 judge odd`]);
    expect((await repo.interrupted(24)).map((a) => a.id)).toEqual([onlyStart.id]);
  });
  it('setAiReview sets the line on a pending row only and the CHECK bounds it', async () => {
    const m = mk();
    const a = (await request(m, (await newTask()).id)).a;
    await repo.setAiReview(a.id, 'Not reviewed: unknown tool');
    expect((await db.pool.query('SELECT ai_review FROM approvals WHERE id = $1', [a.id])).rows[0].ai_review).toBe('Not reviewed: unknown tool');
    await repo.setAiReview(a.id, 'x'.repeat(500));
    expect((await db.pool.query('SELECT char_length(ai_review) AS n FROM approvals WHERE id = $1', [a.id])).rows[0].n).toBe(200);
    await db.pool.query("UPDATE approvals SET status = 'approved' WHERE id = $1", [a.id]);
    await repo.setAiReview(a.id, 'late');
    expect((await db.pool.query('SELECT ai_review FROM approvals WHERE id = $1', [a.id])).rows[0].ai_review).not.toBe('late');
  });
  it('day() summarises today: approvals per tool, escalations per code, newest reasons, cap flag', async () => {
    const t = await newTask();
    const add = (action: string, tool: string, outcome: string) => db.pool.query("INSERT INTO audit_log (actor, action, task_id, tool, outcome) VALUES ('system:ai-approver',$1,$2,$3,$4)", [action, t.id, tool, outcome]);
    await add('approval.ai.approve', 'forum_post', '#1 ok');
    await add('approval.ai.approve', 'forum_post', '#2 ok');
    await add('approval.ai.approve', 'web_search', '#3 ok');
    await add('approval.ai.escalate', 'forum_post', '#4 cap_tree');
    for (let i = 0; i < 6; i++) await add('approval.ai.escalate', 'forum_post', `#${10 + i} judge reason ${i}`);
    const d = await repo.day(TZ);
    expect(d.reviews).toBe(10);
    expect(d.approvals).toEqual([{ tool: 'forum_post', n: 2 }, { tool: 'web_search', n: 1 }]);
    expect(d.escalations).toEqual([{ code: 'judge', n: 6 }, { code: 'cap_tree', n: 1 }]);
    expect(d.reasons).toEqual(['reason 5', 'reason 4', 'reason 3', 'reason 2', 'reason 1']);
    expect(d.capHit).toBe(true);
  });
});

describe('Approvals.decideAi pool safety (G2-01)', () => {
  it('N >= pool max concurrent decideAi with the REAL pause reader all finish (the read runs on the tx client, not a second pool connection)', async () => {
    const poolMax = (db.pool as unknown as { options: { max: number } }).options.max;
    const n = poolMax + 2;
    const m = mk();
    const items: { id: number; sha: string }[] = [];
    for (let i = 0; i < n; i++) {
      const t = await newTask();
      const r = await request(m, t.id, i);
      items.push({ id: r.a.id, sha: r.sha });
    }
    const all = Promise.all(items.map((x) => m.approvals.decideAi(x.id, {
      sha: x.sha, reason: 'ok', maxPerTree: 40, maxPerDay: 300, tz: TZ,
      stillOn: async (q) => !(await repo.pausedToday(TZ, q)),
    })));
    const out = await Promise.race([all, new Promise<'HUNG'>((res) => setTimeout(() => res('HUNG'), 10_000))]);
    expect(out).not.toBe('HUNG');
    expect((out as { ok: boolean }[]).every((o) => o.ok)).toBe(true);
  }, 20_000);

  it('the real reader on the tx client still sees a pause row (paused -> not_enabled)', async () => {
    const m = mk();
    const t = await newTask();
    const r = await request(m, t.id);
    await repo.setPause('123456789012345678', true);
    expect(await m.approvals.decideAi(r.a.id, { sha: r.sha, reason: 'x', maxPerTree: 40, maxPerDay: 300, tz: TZ, stillOn: async (q) => !(await repo.pausedToday(TZ, q)) }))
      .toEqual({ ok: false, error: 'not_enabled' });
  });
});
