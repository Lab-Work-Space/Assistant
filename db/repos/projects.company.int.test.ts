import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ActorRef } from '../../company/types.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { migrate } from '../migrate.js';
import { freshDb, type TestDb } from '../test-helpers.js';
import { DepartmentRepo, ProjectRepo, TaskRepo } from './index.js';

/** AUTO-2 (Gate 1 AC-C1, AC-C2, AC-C9, AC-C16): the company repo methods against a real database. */
let db: TestDb;
let tasks: TaskRepo;
let cfg: FakeConfig;
let halted = false;
let nowMs = Date.parse('2026-11-12T12:00:00Z');
let repo: ProjectRepo;
const hq: ActorRef = { kind: 'head', dept: 'hq' };
const ADMIN = '123456789012345678';
const PERSON = '323456789012345678';

beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations'), 'up');
  await new DepartmentRepo(db.pool).upsert({ id: 'hq', name: 'HQ', categoryNamePattern: '', workChannelId: null, color: 0, model: null, provider: null, enabled: true });
  tasks = new TaskRepo(db.pool);
});
beforeEach(async () => {
  halted = false;
  nowMs = Date.parse('2026-11-12T12:00:00Z');
  cfg = new FakeConfig({ 'autopilot.scope': 'company' });
  repo = new ProjectRepo(db.pool, { cfg, halt: { isHalted: () => halted }, now: () => nowMs });
  for (const t of ['tree_tools', 'autopilot_company_counts', 'daily_runs', 'project_tools', 'projects', 'task_grants', 'web_grants', 'ot_requests', 'approvals', 'audit_log', 'budget_days']) await db.pool.query(`DELETE FROM ${t}`);
  await db.pool.query('UPDATE tasks SET parent_id = NULL');
  await db.pool.query('DELETE FROM tasks');
});
afterAll(async () => { await db.close(); });

type Origin = 'chat' | 'watch' | 'poll' | 'import' | 'schedule' | 'delegated';
const root = (o: { origin?: Origin; status?: 'todo' | 'doing' | 'done' | 'cancelled'; sourceUserId?: string | null } = {}) =>
  tasks.create({ title: 'r', deptId: 'hq', owner: hq, requester: { kind: 'human', userId: '1' }, origin: o.origin ?? 'chat', status: o.status ?? 'todo', sourceUserId: o.sourceUserId ?? null });
const child = (parentId: string, status: 'todo' | 'doing' = 'todo') => tasks.create({ title: 'kid', deptId: 'hq', owner: hq, requester: hq, origin: 'delegated', parentId, status });
let n = 0;
const startProject = async (adopt: string[] = []) => {
  const r = await repo.create({ title: `P${++n}`, goal: 'g', deadline: '2099-01-01', maxLocalCalls: 100, maxUsd: 5, proposer: 'head:hq', tainted: false, adopt });
  if (!r.ok) throw new Error(`create ${r.code}`);
  const d = await repo.decide({ token: r.project.token, by: ADMIN });
  if (!d.ok) throw new Error(`decide ${d.code}`);
  return d;
};
const used = async (scope: string, key?: string) =>
  (await db.pool.query<{ used: number }>('SELECT used FROM autopilot_company_counts WHERE scope = $1' + (key ? ' AND scope_key = $2' : ''), key ? [scope, key] : [scope])).rows.map((r) => r.used);
const audits = async (action: string) => (await db.pool.query<{ outcome: string; tool: string | null; task_id: string | null }>('SELECT outcome, tool, task_id FROM audit_log WHERE action = $1 ORDER BY id', [action])).rows;
const setCaps = (day: number, tree: number, person = 200) => {
  cfg.values.set('autopilot.company.maxApprovalsPerDay', day);
  cfg.values.set('autopilot.company.maxApprovalsPerTree', tree);
  cfg.values.set('autopilot.company.maxApprovalsPerPersonDay', person);
};

describe('companyRoot (AC-C1, AC-C2)', () => {
  it('a chat root and its child answer the root id; a done or cancelled root and an unknown id answer null', async () => {
    const r = await root();
    const k = await child(r.id);
    expect(await repo.companyRoot(r.id)).toBe(r.id);
    expect(await repo.companyRoot(k.id)).toBe(r.id);
    expect(await repo.companyRoot('00000000-0000-0000-0000-000000000000')).toBeNull();
    for (const status of ['done', 'cancelled'] as const) expect(await repo.companyRoot((await root({ status })).id), status).toBeNull();
  });
  it('AC-C1: watch, poll and import roots (and their children) are not company trees, in all four repo methods', async () => {
    for (const origin of ['watch', 'poll', 'import'] as const) {
      const r = await root({ origin });
      const k = await child(r.id);
      expect(await repo.companyRoot(k.id), origin).toBeNull();
      expect(await repo.claimCompany(k.id, 'web_search'), origin).toEqual({ kind: 'not_company' });
      expect(await repo.grantTreeTool({ taskId: k.id, deptId: 'hq', tool: 'web_search' }), origin).toEqual({ ok: false, code: 'not_company' });
      // a grant row that exists anyway (planted) is never offered
      await db.pool.query("INSERT INTO tree_tools (root_task_id, dept_id, tool) VALUES ($1,'hq','web_search')", [r.id]);
      expect(await repo.treeToolsFor(k.id, 'hq'), origin).toEqual([]);
    }
    expect(await used('tree')).toEqual([]);
    expect(await audits('approval.autopilot.company')).toEqual([]);
    expect(await repo.companyRoot((await root({ origin: 'schedule' })).id)).not.toBeNull(); // R9: schedule roots stay company trees
  });
  it('AC-C2: a root with a projects row in ANY status is not a company tree (active, paused, exhausted, closed with an open child, cancelled)', async () => {
    const active = await startProject();
    const paused = await startProject();
    await repo.setPaused({ id: paused.project.id, paused: true, by: ADMIN });
    const exhausted = await startProject();
    await repo.exhaust(exhausted.project.id);
    const closed = await startProject();
    const open = await child(closed.root.id);
    expect((await repo.close({ id: closed.project.id, by: ADMIN })).ok).toBe(true);
    const cancelled = await startProject();
    await db.pool.query("UPDATE projects SET status = 'cancelled' WHERE id = $1", [cancelled.project.id]);
    for (const [name, id] of [['active', active.root.id], ['paused', paused.root.id], ['exhausted', exhausted.root.id], ['closed', open.id], ['closed root', closed.root.id], ['cancelled', cancelled.root.id]] as const) {
      expect(await repo.companyRoot(id), name).toBeNull();
      expect(await repo.claimCompany(id, 'web_search'), name).toEqual({ kind: 'not_company' });
      expect(await repo.grantTreeTool({ taskId: id, deptId: 'hq', tool: 'web_search' }), name).toEqual({ ok: false, code: 'not_company' });
    }
    expect(await used('tree')).toEqual([]);
  });
});

describe('claimCompany (AUTO-2 5.3, AC-C9)', () => {
  it('runs: counts tree, person and day; one audit row per count with the day and tree numbers', async () => {
    const r = await root({ sourceUserId: PERSON });
    const k = await child(r.id);
    expect(await repo.claimCompany(r.id, 'web_search')).toEqual({ kind: 'run', day: 1, tree: 1 });
    expect(await repo.claimCompany(k.id, 'fetch_page')).toEqual({ kind: 'run', day: 2, tree: 2 });
    expect(await used('tree', r.id)).toEqual([2]);
    expect(await used('day', '2026-11-12')).toEqual([2]);
    expect(await used('person', `2026-11-12:${PERSON}`)).toEqual([2]);
    expect(await audits('approval.autopilot.company')).toEqual([
      { outcome: 'ok d1/600 t1/80', tool: 'web_search', task_id: r.id },
      { outcome: 'ok d2/600 t2/80', tool: 'fetch_page', task_id: k.id },
    ]);
  });
  it('the person is the human requester when the root has no sourceUserId; a root with no person has no person row', async () => {
    const r = await root();
    await repo.claimCompany(r.id, 'web_search');
    expect(await used('person', '2026-11-12:1')).toEqual([1]);
    const bot = await tasks.create({ title: 'b', deptId: 'hq', owner: hq, requester: hq, origin: 'schedule', status: 'todo' });
    await repo.claimCompany(bot.id, 'web_search');
    expect((await used('person')).length).toBe(1);
  });
  it('scope project, scope read error, halted, enabled off: not_company and nothing written', async () => {
    const r = await root();
    cfg.values.set('autopilot.scope', 'project');
    expect(await repo.claimCompany(r.id, 'web_search')).toEqual({ kind: 'not_company' });
    cfg.values.set('autopilot.scope', 'company');
    cfg.throwOn.add('autopilot.scope');
    expect(await repo.claimCompany(r.id, 'web_search')).toEqual({ kind: 'not_company' });
    cfg.throwOn.clear();
    halted = true;
    expect(await repo.claimCompany(r.id, 'web_search')).toEqual({ kind: 'not_company' });
    halted = false;
    cfg.values.set('autopilot.enabled', false);
    expect(await repo.claimCompany(r.id, 'web_search')).toEqual({ kind: 'not_company' });
    expect(await used('tree')).toEqual([]);
    expect(await audits('approval.autopilot.company')).toEqual([]);
  });
  it('a halt that appears after the counters were taken (step 7) rolls everything back', async () => {
    const r = await root({ sourceUserId: PERSON });
    let calls = 0;
    const flip = new ProjectRepo(db.pool, { cfg, halt: { isHalted: () => ++calls > 1 }, now: () => nowMs });
    expect(await flip.claimCompany(r.id, 'web_search')).toEqual({ kind: 'not_company' });
    expect(await used('tree')).toEqual([]);
    expect(await used('day')).toEqual([]);
    expect(await used('person')).toEqual([]);
    expect(await audits('approval.autopilot.company')).toEqual([]);
  });
  it('tree cap: cap tree, nothing written beyond the capped counter; the day counter is untouched', async () => {
    setCaps(600, 2);
    const r = await root();
    await repo.claimCompany(r.id, 'a');
    await repo.claimCompany(r.id, 'a');
    expect(await repo.claimCompany(r.id, 'a')).toEqual({ kind: 'cap', which: 'tree' });
    expect(await used('tree', r.id)).toEqual([2]);
    expect(await used('day', '2026-11-12')).toEqual([2]);
    expect((await audits('approval.autopilot.company')).length).toBe(2);
  });
  it('day cap: the tree increment rolls back (tree row unchanged); a different tree is refused too', async () => {
    setCaps(2, 80);
    const a = await root();
    const b = await root();
    await repo.claimCompany(a.id, 'x');
    await repo.claimCompany(b.id, 'x');
    expect(await repo.claimCompany(a.id, 'x')).toEqual({ kind: 'cap', which: 'day' });
    expect(await used('tree', a.id)).toEqual([1]);
    expect(await used('tree', b.id)).toEqual([1]);
    expect(await used('day', '2026-11-12')).toEqual([2]);
    expect((await audits('approval.autopilot.company')).length).toBe(2);
  });
  it('AC-C16 person cap: one person stops at the cap, tree and day roll back, another person still runs', async () => {
    setCaps(600, 80, 2);
    const a = await root({ sourceUserId: PERSON });
    const b = await root({ sourceUserId: PERSON });
    const other = await root({ sourceUserId: '423456789012345678' });
    await repo.claimCompany(a.id, 'x');
    await repo.claimCompany(b.id, 'x');
    expect(await repo.claimCompany(a.id, 'x')).toEqual({ kind: 'cap', which: 'person' });
    expect(await used('tree', a.id)).toEqual([1]);
    expect(await used('day', '2026-11-12')).toEqual([2]);
    expect(await repo.claimCompany(other.id, 'x')).toMatchObject({ kind: 'run', day: 3 });
    nowMs += 24 * 3600 * 1000; // the next day: the person counter starts again
    expect(await repo.claimCompany(a.id, 'x')).toMatchObject({ kind: 'run', day: 1 });
  });
  it.each([['tree'], ['day'], ['person']] as const)('10 parallel claims at cap-1 give exactly one run (%s cap)', async (which) => {
    setCaps(which === 'day' ? 5 : 600, which === 'tree' ? 5 : 80, which === 'person' ? 5 : 200);
    const r = await root({ sourceUserId: PERSON });
    for (let i = 0; i < 4; i++) expect((await repo.claimCompany(r.id, 'x')).kind).toBe('run');
    const out = await Promise.all(Array.from({ length: 10 }, () => repo.claimCompany(r.id, 'x')));
    expect(out.filter((o) => o.kind === 'run').length).toBe(1);
    expect(out.filter((o) => o.kind === 'cap').length).toBe(9);
    expect(await used('tree', r.id)).toEqual([5]);
    expect(await used('day', '2026-11-12')).toEqual([5]);
    expect((await audits('approval.autopilot.company')).length).toBe(5); // every counted row has its audit row
  });
  it('a root adopted into a project mid-claim: the tree moved under a project root gives not_company, with no counter written', async () => {
    const r = await root();
    const k = await child(r.id);
    const d = await startProject([r.id]);
    expect(d.adopted).toContain(r.id);
    expect(await repo.claimCompany(k.id, 'web_search')).toEqual({ kind: 'not_company' });
    expect(await repo.claimCompany(r.id, 'web_search')).toEqual({ kind: 'not_company' });
    expect(await used('tree')).toEqual([]);
  });
  it('a root that ends (done) gives not_company; the day key follows schedule.timezone', async () => {
    const r = await root();
    nowMs = Date.parse('2026-11-12T23:30:00Z'); // 2026-11-13 06:30 in Bangkok
    cfg.values.set('schedule.timezone', 'Asia/Bangkok');
    await repo.claimCompany(r.id, 'x');
    expect(await used('day', '2026-11-13')).toEqual([1]);
    expect(await used('day', '2026-11-12')).toEqual([]);
    await db.pool.query("UPDATE tasks SET status = 'done' WHERE id = $1", [r.id]);
    expect(await repo.claimCompany(r.id, 'x')).toEqual({ kind: 'not_company' });
  });
  it('a database fault is rethrown (decide turns it into a card)', async () => {
    const r = await root();
    await db.pool.query('ALTER TABLE audit_log ADD CONSTRAINT zz_no_company CHECK (action <> \'approval.autopilot.company\') NOT VALID');
    try {
      await expect(repo.claimCompany(r.id, 'x')).rejects.toThrow();
      expect(await used('tree')).toEqual([]); // the throwing audit row rolled the claim back
    } finally {
      await db.pool.query('ALTER TABLE audit_log DROP CONSTRAINT zz_no_company');
    }
  });
});

describe('claimCapNotice (AUTO-2 3.8)', () => {
  it('exactly one notice per day across concurrent callers, one audit row; a new day owes a new notice', async () => {
    const out = await Promise.all(Array.from({ length: 10 }, (_, i) => repo.claimCapNotice(i % 2 ? 'day' : 'tree')));
    expect(out.filter(Boolean).length).toBe(1);
    expect((await audits('autopilot.company.cap')).length).toBe(1);
    expect((await db.pool.query("SELECT 1 FROM daily_runs WHERE kind = 'autopilot_cap'")).rowCount).toBe(1);
    nowMs += 24 * 3600 * 1000;
    expect(await repo.claimCapNotice('person')).toBe(true);
    expect(await repo.claimCapNotice('person')).toBe(false);
    expect((await audits('autopilot.company.cap')).map((a) => a.outcome)).toHaveLength(2);
  });
});

describe('grantTreeTool and treeToolsFor (AUTO-2 3.7, AC-C9, AC-C11)', () => {
  it('grants, refuses a repeat (exists), caps at 5 per tree, audits each grant; another tree is separate', async () => {
    const r = await root();
    const k = await child(r.id);
    for (const t of ['a1', 'a2', 'a3', 'a4', 'a5']) expect(await repo.grantTreeTool({ taskId: k.id, deptId: 'hq', tool: t })).toEqual({ ok: true, rootId: r.id });
    expect(await repo.grantTreeTool({ taskId: k.id, deptId: 'hq', tool: 'a1' })).toEqual({ ok: false, code: 'exists' });
    expect(await repo.grantTreeTool({ taskId: r.id, deptId: 'sales', tool: 'a6' })).toEqual({ ok: false, code: 'cap' });
    expect((await audits('tool.tree_grant')).length).toBe(5);
    expect((await audits('tool.tree_grant'))[0]).toEqual({ outcome: 'ok hq a1', tool: 'a1', task_id: k.id });
    expect(await repo.treeToolsFor(r.id, 'hq')).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
    expect(await repo.treeToolsFor(k.id, 'sales')).toEqual([]);
    const o = await root();
    expect(await repo.grantTreeTool({ taskId: o.id, deptId: 'hq', tool: 'a1' })).toEqual({ ok: true, rootId: o.id });
  });
  it('10 parallel grants of distinct tools on one tree give exactly 5', async () => {
    const r = await root();
    const out = await Promise.all(Array.from({ length: 10 }, (_, i) => repo.grantTreeTool({ taskId: r.id, deptId: 'hq', tool: `t${i}` })));
    expect(out.filter((o) => o.ok).length).toBe(5);
    expect((await db.pool.query('SELECT 1 FROM tree_tools')).rowCount).toBe(5);
  });
  it('grants vanish when the root ends or a project adopts the root; the rows are kept', async () => {
    const r = await root();
    await repo.grantTreeTool({ taskId: r.id, deptId: 'hq', tool: 'web_search' });
    expect(await repo.treeToolsFor(r.id, 'hq')).toEqual(['web_search']);
    await db.pool.query("UPDATE tasks SET status = 'done' WHERE id = $1", [r.id]);
    expect(await repo.treeToolsFor(r.id, 'hq')).toEqual([]);
    expect(await repo.grantTreeTool({ taskId: r.id, deptId: 'hq', tool: 'fetch_page' })).toEqual({ ok: false, code: 'not_company' });
    expect((await db.pool.query('SELECT 1 FROM tree_tools')).rowCount).toBe(1);
    const a = await root();
    await repo.grantTreeTool({ taskId: a.id, deptId: 'hq', tool: 'web_search' });
    await startProject([a.id]);
    expect(await repo.treeToolsFor(a.id, 'hq')).toEqual([]);
  });
  it('off, project scope, halt, a bad dept or tool shape: not_company; a read failure of treeToolsFor is []', async () => {
    const r = await root();
    cfg.values.set('autopilot.scope', 'project');
    expect(await repo.grantTreeTool({ taskId: r.id, deptId: 'hq', tool: 'web_search' })).toEqual({ ok: false, code: 'not_company' });
    cfg.values.set('autopilot.scope', 'company');
    halted = true;
    expect(await repo.grantTreeTool({ taskId: r.id, deptId: 'hq', tool: 'web_search' })).toEqual({ ok: false, code: 'not_company' });
    halted = false;
    expect(await repo.grantTreeTool({ taskId: r.id, deptId: 'HQ', tool: 'web_search' })).toEqual({ ok: false, code: 'not_company' });
    expect(await repo.grantTreeTool({ taskId: r.id, deptId: 'hq', tool: 'bad-tool' })).toEqual({ ok: false, code: 'not_company' });
    expect(await repo.treeToolsFor('not-a-uuid\u0000', 'hq')).toEqual([]);
    expect((await db.pool.query('SELECT 1 FROM tree_tools')).rowCount).toBe(0);
  });
});

describe('day().company (AUTO-2 5.3, digest)', () => {
  it('counts today\'s company approvals per tool, the first cap hit, and the tree grants (root8, dept, tool)', async () => {
    const empty = await repo.day('UTC');
    expect(empty.company).toEqual({ total: 0, tools: [], capHit: null, treeGrants: [] });
    const r = await root();
    await repo.claimCompany(r.id, 'web_search');
    await repo.claimCompany(r.id, 'web_search');
    await repo.claimCompany(r.id, 'fetch_page');
    await repo.claimCapNotice('tree');
    await repo.grantTreeTool({ taskId: r.id, deptId: 'hq', tool: 'read_file' });
    const d = await repo.day('UTC');
    expect(d.company).toEqual({ total: 3, tools: [{ tool: 'web_search', n: 2 }, { tool: 'fetch_page', n: 1 }], capHit: 'tree', treeGrants: [{ root8: r.id.slice(0, 8), dept: 'hq', tool: 'read_file' }] });
  });
});
