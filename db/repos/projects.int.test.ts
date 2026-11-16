import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ActorRef } from '../../company/types.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { migrate } from '../migrate.js';
import { freshDb, type TestDb } from '../test-helpers.js';
import { DepartmentRepo, ProjectRepo, TaskRepo, type Project } from './index.js';

let db: TestDb;
let tasks: TaskRepo;
let cfg: FakeConfig;
let halted = false;
let repo: ProjectRepo;
const hq: ActorRef = { kind: 'head', dept: 'hq' };
const ADMIN = '123456789012345678';
const ADMIN2 = '223456789012345679';
const TASK_DAY = '1970-01-01';

beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations'), 'up');
  await new DepartmentRepo(db.pool).upsert({ id: 'hq', name: 'HQ', categoryNamePattern: '', workChannelId: null, color: 0, model: null, provider: null, enabled: true });
  tasks = new TaskRepo(db.pool);
});
beforeEach(async () => {
  halted = false;
  cfg = new FakeConfig();
  repo = new ProjectRepo(db.pool, { cfg, halt: { isHalted: () => halted } });
  for (const t of ['project_tools', 'projects', 'task_grants', 'web_grants', 'ot_requests', 'approvals', 'audit_log', 'budget_days']) await db.pool.query(`DELETE FROM ${t}`);
  await db.pool.query('UPDATE tasks SET parent_id = NULL');
  await db.pool.query('DELETE FROM tasks');
});
afterAll(async () => { await db.close(); });

const root = (o: { origin?: 'chat' | 'watch' | 'delegated'; conversation?: boolean; status?: 'todo' | 'doing' | 'done' } = {}) =>
  tasks.create({ title: 'old', deptId: 'hq', owner: hq, requester: { kind: 'human', userId: '1' }, origin: o.origin ?? 'chat', conversation: o.conversation ?? false, status: o.status ?? 'todo' });
const child = (parentId: string, status: 'todo' | 'doing' = 'todo') => tasks.create({ title: 'kid', deptId: 'hq', owner: hq, requester: hq, origin: 'delegated', parentId, status });
let n = 0;
const propose = async (o: Partial<{ title: string; maxLocalCalls: number; maxUsd: number; adopt: string[]; forced: string[]; tainted: boolean }> = {}): Promise<Project> => {
  const r = await repo.create({ title: o.title ?? `P${++n}`, goal: 'g', deadline: '2099-01-01', maxLocalCalls: o.maxLocalCalls ?? 100, maxUsd: o.maxUsd ?? 5, proposer: 'head:hq', tainted: o.tainted ?? false, adopt: o.adopt ?? [] });
  if (!r.ok) throw new Error(`create ${r.code}`);
  // `forced` writes the ids as stored, bypassing the proposal-time resolution: it simulates a tree that became ineligible between the proposal and the click
  if (o.forced) await db.pool.query('UPDATE projects SET adopt_ids = $2 WHERE id = $1', [r.project.id, o.forced]);
  return (await repo.get(r.project.id))!;
};
const start = async (o: Parameters<typeof propose>[0] = {}) => {
  const p = await propose(o);
  const d = await repo.decide({ token: p.token, by: ADMIN });
  if (!d.ok) throw new Error(`decide ${d.code}`);
  return d;
};
const seedBudget = (rootId: string, usd: number, calls: number) =>
  db.pool.query("INSERT INTO budget_days (day, scope, scope_id, spent_usd, calls) VALUES ($1,'task',$2,$3,$4) ON CONFLICT (day, scope, scope_id) DO UPDATE SET spent_usd = $3, calls = $4", [TASK_DAY, rootId, usd, calls]);
const setUsed = (id: number, used: number, max?: number) => db.pool.query('UPDATE projects SET approvals_used = $2, max_approvals = COALESCE($3, max_approvals) WHERE id = $1', [id, used, max ?? null]);
const audits = async (action: string) => (await db.pool.query<{ outcome: string; tool: string | null; task_id: string | null }>('SELECT outcome, tool, task_id FROM audit_log WHERE action = $1 ORDER BY id', [action])).rows;

describe('create (proposal)', () => {
  it('stores a proposed row with the config approval cap, a 7 day expiry and an audit row', async () => {
    const p = await propose({ title: 'Alpha', maxLocalCalls: 50, maxUsd: 2.5 });
    expect(p).toMatchObject({ status: 'proposed', title: 'Alpha', maxLocalCalls: 50, baseLocalCalls: 50, maxUsd: 2.5, baseUsd: 2.5, maxApprovals: 500, baseApprovals: 500, approvalsUsed: 0, rootTaskId: null, paused: false });
    expect(p.token).toMatch(/^[0-9a-f]{32}$/);
    expect(p.expiresAt.getTime() - p.createdAt.getTime()).toBe(7 * 24 * 3600 * 1000);
    expect(await audits('project.propose')).toEqual([{ outcome: `#${p.id} proposed`, tool: null, task_id: null }]);
  });
  it('open cap of 3 unexpired proposals and a case-insensitive duplicate title; an expired one does not count', async () => {
    await propose({ title: 'One' });
    await propose({ title: 'Two' });
    expect(await repo.create({ title: 'ONE', goal: 'g', deadline: '2099-01-01', maxLocalCalls: 1, maxUsd: 0, proposer: 'head:hq', tainted: false })).toEqual({ ok: false, code: 'duplicate' });
    const three = await propose({ title: 'Three' });
    const full = { title: 'Four', goal: 'g', deadline: '2099-01-01', maxLocalCalls: 1, maxUsd: 0, proposer: 'head:hq', tainted: false };
    expect(await repo.create(full)).toEqual({ ok: false, code: 'open_cap' });
    await db.pool.query("UPDATE projects SET created_at = now() - interval '8 days', expires_at = now() - interval '1 day' WHERE id = $1", [three.id]);
    expect((await repo.create(full)).ok).toBe(true);
  });
  it('concurrent proposals cannot pass the open cap', async () => {
    const rs = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => repo.create({ title: `C${i}`, goal: 'g', deadline: '2099-01-01', maxLocalCalls: 1, maxUsd: 0, proposer: 'head:hq', tainted: false })));
    expect(rs.filter((r) => r.ok)).toHaveLength(3);
    expect(rs.filter((r) => !r.ok && r.code === 'open_cap')).toHaveLength(3);
  });
  it('refuses while halted or switched off; a switch read error counts as off', async () => {
    const x = { title: 'X', goal: 'g', deadline: '2099-01-01', maxLocalCalls: 1, maxUsd: 0, proposer: 'head:hq', tainted: false };
    halted = true;
    expect(await repo.create(x)).toEqual({ ok: false, code: 'halted' });
    halted = false;
    cfg.values.set('autopilot.enabled', false);
    expect(await repo.create(x)).toEqual({ ok: false, code: 'off' });
    cfg.values.delete('autopilot.enabled');
    cfg.throwOn.add('autopilot.enabled');
    expect(await repo.create(x)).toEqual({ ok: false, code: 'off' });
  });
});

describe('decide', () => {
  it('approves in one transaction: root task todo/delegated/hq, project active with its root, audit row', async () => {
    const p = await propose({ title: 'Ship', tainted: true });
    const d = await repo.decide({ token: p.token, by: ADMIN });
    if (!d.ok) throw new Error(d.code);
    expect(d.project).toMatchObject({ id: p.id, status: 'active', approvedBy: ADMIN, rootTaskId: d.root.id, maxApprovals: 500 });
    expect(d.root).toMatchObject({ status: 'todo', origin: 'delegated', deptId: 'hq', parentId: null, rootId: d.root.id, depth: 0, tainted: true, title: 'Project: Ship', owner: hq, requester: { kind: 'human', userId: ADMIN } });
    expect(d.root.description).toContain(`Project #${p.id}, approved by a Bot Admin.`);
    expect(await audits('project.decide')).toEqual([{ outcome: `#${p.id} approved root ${d.root.id.slice(0, 8)} adopted 0 skipped 0`, tool: null, task_id: d.root.id }]);
  });
  it('a double click: exactly one wins, one root task exists', async () => {
    const p = await propose();
    const rs = await Promise.all([repo.decide({ token: p.token, by: ADMIN }), repo.decide({ token: p.token, by: ADMIN2 }), repo.decide({ token: p.token, by: ADMIN })]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(rs.filter((r) => !r.ok).every((r) => !r.ok && r.code === 'not_pending')).toBe(true);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM tasks')).rows[0]).toEqual({ n: 1 });
    expect(await audits('project.decide')).toHaveLength(1);
  });
  it('unknown token, bad token, expired proposal, halted and off', async () => {
    expect(await repo.decide({ token: 'a'.repeat(32), by: ADMIN })).toEqual({ ok: false, code: 'not_found' });
    expect(await repo.decide({ token: "x'; DROP", by: ADMIN })).toEqual({ ok: false, code: 'not_found' });
    expect(await repo.decide({ token: 'a'.repeat(32), by: 'nope' })).toEqual({ ok: false, code: 'not_found' });
    const p = await propose();
    await db.pool.query("UPDATE projects SET created_at = now() - interval '8 days', expires_at = now() - interval '1 day' WHERE id = $1", [p.id]);
    expect(await repo.decide({ token: p.token, by: ADMIN })).toEqual({ ok: false, code: 'expired' });
    expect((await repo.expire(p.id))?.status).toBe('cancelled');
    expect(await repo.expire(p.id)).toBeNull();
    const q = await propose();
    halted = true;
    expect(await repo.decide({ token: q.token, by: ADMIN })).toEqual({ ok: false, code: 'halted' });
    halted = false;
    cfg.values.set('autopilot.enabled', false);
    expect(await repo.decide({ token: q.token, by: ADMIN })).toEqual({ ok: false, code: 'off' });
    expect((await repo.get(q.id))?.status).toBe('proposed');
    expect((await db.pool.query('SELECT count(*)::int AS n FROM tasks')).rows[0]).toEqual({ n: 0 });
  });
  it('reject is a CAS from proposed', async () => {
    const p = await propose();
    expect((await repo.reject(p.id, ADMIN))?.status).toBe('cancelled');
    expect(await repo.reject(p.id, ADMIN)).toBeNull();
    expect(await repo.decide({ token: p.token, by: ADMIN })).toEqual({ ok: false, code: 'not_pending' });
  });
});

describe('adoption (SA-1 3.2a, AP-C4)', () => {
  const skippedOf = async (...ids: string[]) => {
    const d = await start({ forced: ids });
    return d.skipped.map((s) => s.code);
  };
  it('adopts an idle root with its tree: root_id, depth + 1, parent of the old root', async () => {
    const old = await root();
    const kid = await child(old.id);
    const grand = await child(kid.id);
    const d = await start({ adopt: [old.id] });
    expect(d.adopted).toEqual([old.id]);
    expect(d.skipped).toEqual([]);
    const rows = (await db.pool.query<{ id: string; parent_id: string | null; root_id: string; depth: number }>('SELECT id, parent_id, root_id, depth FROM tasks')).rows;
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by[old.id]).toMatchObject({ parent_id: d.root.id, root_id: d.root.id, depth: 1 });
    expect(by[kid.id]).toMatchObject({ parent_id: old.id, root_id: d.root.id, depth: 2 });
    expect(by[grand.id]).toMatchObject({ parent_id: kid.id, root_id: d.root.id, depth: 3 });
    expect(await audits('project.decide')).toEqual([expect.objectContaining({ outcome: expect.stringMatching(/adopted 1 skipped 0$/) })]);
    expect((await repo.projectOf(grand.id))?.id).toBe(d.project.id);
  });
  it('not_found and not_root', async () => {
    const old = await root();
    const kid = await child(old.id);
    expect((await skippedOf('a'.repeat(36), kid.id)).sort()).toEqual(['not_found', 'not_root']);
  });
  it('project_root: another project\'s idle root is skipped, active or closed (AP-C4)', async () => {
    const first = await start();
    expect(await skippedOf(first.root.id)).toEqual(['project_root']);
    await db.pool.query("UPDATE tasks SET status = 'done' WHERE id = $1", [first.root.id]);
    await repo.rootEnded(first.root.id, 'done');
    expect(await skippedOf(first.root.id)).toEqual(['project_root']);
    expect((await db.pool.query('SELECT root_id, depth FROM tasks WHERE id = $1', [first.root.id])).rows[0]).toEqual({ root_id: first.root.id, depth: 0 });
  });
  it('outside_origin: a watch root is skipped (AP-C4)', async () => {
    const w = await root({ origin: 'watch' });
    expect(await skippedOf(w.id)).toEqual(['outside_origin']);
  });
  it('ended, conversation, running', async () => {
    const done = await root({ status: 'done' });
    const conv = await root({ conversation: true });
    const busy = await root();
    await child(busy.id, 'doing');
    const d = await start({ forced: [done.id, conv.id, busy.id] });
    expect(Object.fromEntries(d.skipped.map((s) => [s.id, s.code]))).toEqual({ [done.id]: 'ended', [conv.id]: 'conversation', [busy.id]: 'running' });
  });
  it('pending_approval and has_grant (task grant, web grant, ot request)', async () => {
    const pend = await root();
    await db.pool.query("INSERT INTO approvals (task_id, reason, requested_by) VALUES ($1,'r','head:hq')", [pend.id]);
    const withTg = await root();
    const withWg = await root();
    const withOt = await root();
    const aid = async (t: string) => (await db.pool.query<{ id: number }>("INSERT INTO approvals (task_id, reason, requested_by, status, kind, tool_name, tool_input, input_sha256) VALUES ($1,'r','head:hq','approved','tool','write_file','{\"path\":\"a\"}','x') RETURNING id", [t])).rows[0]!.id;
    await db.pool.query("INSERT INTO task_grants (root_id, approval_id, granted_by, requested_by, max_calls, expires_at) VALUES ($1,$2,$3,'head:hq',10, now() + interval '1 hour')", [withTg.id, await aid(withTg.id), ADMIN]);
    await db.pool.query("INSERT INTO web_grants (root_id, approval_id, granted_by, requested_by, max_fetches, max_hosts, max_url_chars, expires_at) VALUES ($1,$2,$3,'head:hq',10,5,4000, now() + interval '1 hour')", [withWg.id, await aid(withWg.id), ADMIN]);
    await db.pool.query("INSERT INTO ot_requests (root_id, local_day, seq, requested_by, digest, expires_at) VALUES ($1,'2026-11-10',1,'1','aaaaaaaaaaaa', now() + interval '1 hour')", [withOt.id]);
    const d = await start({ forced: [pend.id, withTg.id, withWg.id, withOt.id] });
    expect(Object.fromEntries(d.skipped.map((s) => [s.id, s.code]))).toEqual({ [pend.id]: 'pending_approval', [withTg.id]: 'has_grant', [withWg.id]: 'has_grant', [withOt.id]: 'has_grant' });
    expect(d.adopted).toEqual([]);
  });
  it('too_deep: a tree whose deepest row + 1 passes limits.depth', async () => {
    const old = await root();
    const c1 = await child(old.id);
    const c2 = await child(c1.id);
    const c3 = await child(c2.id);
    expect(c3.depth).toBe(3);
    expect(await skippedOf(old.id)).toEqual(['too_deep']);
    const ok = await root();
    await child(ok.id);
    const d = await start({ forced: [ok.id] });
    expect(d.adopted).toEqual([ok.id]);
  });
  it('children_cap: at most min(20, limits.childrenPerTask) are adopted', async () => {
    const ids = [] as string[];
    for (let i = 0; i < 7; i++) ids.push((await root()).id);
    const d = await start({ forced: ids });
    expect(d.adopted).toHaveLength(5);
    expect(d.skipped.map((s) => s.code)).toEqual(['children_cap', 'children_cap']);
  });
  it('a failed check skips that id and leaves its tree untouched', async () => {
    const w = await root({ origin: 'watch' });
    const k = await child(w.id);
    await start({ forced: [w.id] });
    expect((await db.pool.query('SELECT root_id, depth FROM tasks WHERE id = $1', [k.id])).rows[0]).toEqual({ root_id: w.id, depth: 1 });
  });
});

describe('adopt resolution at proposal time (SA-1 3.2)', () => {
  const mkRoot = (id: string, o: Parameters<typeof root>[0] = {}) => tasks.create({ id, title: 'old', deptId: 'hq', owner: hq, requester: { kind: 'human', userId: '1' }, origin: o.origin ?? 'chat', conversation: o.conversation ?? false, status: o.status ?? 'todo' });
  const resolve = async (...entries: string[]) => repo.resolveAdopt(entries);
  it('a unique 8-character prefix of an open root resolves to the full id, and the stored adopt_ids hold only full eligible ids', async () => {
    const a = await mkRoot('aaaaaaaa-1111-4111-8111-111111111111');
    const w = await mkRoot('bbbbbbbb-2222-4222-8222-222222222222', { origin: 'watch' });
    const p = await repo.create({ title: 'R', goal: 'g', deadline: '2099-01-01', maxLocalCalls: 5, maxUsd: 1, proposer: 'head:hq', tainted: false, adopt: ['aaaaaaaa', 'bbbbbbbb', 'cccccccc'] });
    if (!p.ok) throw new Error(p.code);
    expect(p.adopt).toEqual({ ids: [a.id], skipped: [{ id8: w.id.slice(0, 8), code: 'outside_origin' }, { id8: 'cccccccc', code: 'not_found' }] });
    expect(p.project.adoptIds).toEqual([a.id]);
    const d = await repo.decide({ token: p.project.token, by: ADMIN });
    if (!d.ok) throw new Error(d.code);
    expect(d.adopted).toEqual([a.id]);
    expect((await tasks.get(a.id))?.rootId).toBe(d.root.id);
  });
  it('an ambiguous prefix and a prefix of a non-root or ended task are dropped as not_found; an exact id says why', async () => {
    await mkRoot('dddddddd-1111-4111-8111-111111111111');
    await mkRoot('dddddddd-2222-4222-8222-222222222222');
    const top = await mkRoot('eeeeeeee-1111-4111-8111-111111111111');
    const kid = await tasks.create({ id: 'ffffffff-1111-4111-8111-111111111111', title: 'k', deptId: 'hq', owner: hq, requester: hq, origin: 'delegated', parentId: top.id });
    const ended = await mkRoot('99999999-1111-4111-8111-111111111111', { status: 'done' });
    expect((await resolve('dddddddd')).skipped).toEqual([{ id8: 'dddddddd', code: 'not_found' }]);
    expect((await resolve('ffffffff')).skipped).toEqual([{ id8: 'ffffffff', code: 'not_found' }]);
    expect((await resolve(kid.id)).skipped).toEqual([{ id8: 'ffffffff', code: 'not_root' }]);
    expect((await resolve(ended.id)).skipped).toEqual([{ id8: '99999999', code: 'ended' }]);
    expect((await resolve('99999999')).skipped).toEqual([{ id8: '99999999', code: 'not_found' }]); // a prefix looks only at open roots
    expect((await resolve('dddddddd-2222')).ids).toEqual(['dddddddd-2222-4222-8222-222222222222']);
  });
  it('junk, wildcards, short prefixes and duplicates never match more than they name', async () => {
    await mkRoot('aaaaaaaa-1111-4111-8111-111111111111');
    const r = await resolve('%', '________', 'aaaaaaa', "aaaaaaaa'--", '', 'AAAAAAAA', 'aaaaaaaa-1111', 'aaaaaaaa');
    expect(r.ids).toEqual(['aaaaaaaa-1111-4111-8111-111111111111']); // the upper-case prefix and the longer prefix are the same task: listed once
    expect(r.skipped.map((x) => x.code)).toEqual(['not_found', 'not_found', 'not_found', 'not_found', 'not_found']);
    expect(r.skipped.every((x) => /^[0-9a-f-]{1,8}$|^invalid$/.test(x.id8))).toBe(true);
  });
  it('children_cap applies at proposal time and 21 or more entries are cut, never a CHECK error', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push((await root()).id);
    const r = await resolve(...ids);
    expect(r.ids).toHaveLength(5);
    expect(r.skipped.map((x) => x.code)).toEqual(['children_cap', 'children_cap']);
    const many = Array.from({ length: 30 }, (_, i) => `0000000${i % 10}`);
    const p = await repo.create({ title: 'Many', goal: 'g', deadline: '2099-01-01', maxLocalCalls: 5, maxUsd: 1, proposer: 'head:hq', tainted: false, adopt: many });
    expect(p.ok).toBe(true);
  });
  it('the proposal-time and the click-time checks give the same code for the same state', async () => {
    const t = await root();
    await child(t.id, 'doing');
    const at = await repo.resolveAdopt([t.id]);
    expect(at.skipped).toEqual([{ id8: t.id.slice(0, 8), code: 'running' }]);
    const d = await start({ forced: [t.id] });
    expect(d.skipped).toEqual([{ id: t.id, code: 'running' }]);
  });
});

describe('projectOf and capFor', () => {
  it('returns the active project of any task of the tree, through the DB join', async () => {
    const d = await start();
    const k = await child(d.root.id);
    expect(await repo.projectOf(k.id)).toEqual({ id: d.project.id, rootTaskId: d.root.id, deadline: '2099-01-01' });
    expect(await repo.projectOf((await root()).id)).toBeNull();
    expect(await repo.projectOf('nope')).toBeNull();
  });
  it('null while paused, exhausted, past deadline, closed, switched off, halted or when a read throws (AP-C9, AP-C10)', async () => {
    const d = await start();
    const id = d.project.id;
    const live = async () => (await repo.projectOf(d.root.id)) !== null;
    expect(await live()).toBe(true);
    await repo.setPaused({ id, paused: true, by: ADMIN });
    expect(await live()).toBe(false);
    await repo.setPaused({ id, paused: false, by: ADMIN });
    expect(await live()).toBe(true);
    halted = true; expect(await live()).toBe(false); halted = false;
    cfg.values.set('autopilot.enabled', false); expect(await live()).toBe(false);
    cfg.values.delete('autopilot.enabled'); cfg.throwOn.add('autopilot.enabled'); expect(await live()).toBe(false); cfg.throwOn.clear();
    await db.pool.query("UPDATE projects SET deadline = '2000-01-01' WHERE id = $1", [id]);
    expect(await live()).toBe(false);
    await db.pool.query("UPDATE projects SET deadline = '2099-01-01' WHERE id = $1", [id]);
    await repo.exhaust(id);
    expect(await live()).toBe(false);
  });
  it('capFor: the caps for an active root (exhausted and past deadline still capped), null when off, paused or not a project', async () => {
    const d = await start({ maxLocalCalls: 7, maxUsd: 1.5 });
    const cap = (r: string) => repo.capFor(r, db.pool);
    expect(await cap(d.root.id)).toEqual({ maxUsd: 1.5, maxCalls: 7 });
    await repo.exhaust(d.project.id);
    expect(await cap(d.root.id)).toEqual({ maxUsd: 1.5, maxCalls: 7 });
    await db.pool.query("UPDATE projects SET deadline = '2000-01-01'");
    expect(await cap(d.root.id)).toEqual({ maxUsd: 1.5, maxCalls: 7 });
    expect(await cap((await root()).id)).toBeNull();
    cfg.values.set('autopilot.enabled', false);
    expect(await cap(d.root.id)).toBeNull();
    cfg.values.delete('autopilot.enabled');
    await repo.setPaused({ id: d.project.id, paused: true, by: ADMIN });
    expect(await cap(d.root.id)).toBeNull();
    await repo.setPaused({ id: d.project.id, paused: false, by: ADMIN });
    await repo.close({ id: d.project.id, by: ADMIN });
    expect(await cap(d.root.id)).toBeNull();
  });
});

describe('claimApproval (SA-1 5.2, AP-C5)', () => {
  it('run: counts, audits in the same transaction, and works from any task of the tree', async () => {
    const d = await start();
    const k = await child(d.root.id);
    expect(await repo.claimApproval(d.project.id, k.id, 'web_search')).toEqual({ kind: 'run', used: 1, max: 500 });
    expect(await repo.claimApproval(d.project.id, d.root.id, 'fetch_page')).toEqual({ kind: 'run', used: 2, max: 500 });
    expect((await repo.get(d.project.id))?.approvalsUsed).toBe(2);
    expect(await audits('approval.autopilot.approve')).toEqual([
      { outcome: `ok p${d.project.id} 1/500`, tool: 'web_search', task_id: k.id },
      { outcome: `ok p${d.project.id} 2/500`, tool: 'fetch_page', task_id: d.root.id },
    ]);
  });
  it('approvals boundary: used = max - 1 runs once, then budget', async () => {
    const d = await start();
    await setUsed(d.project.id, 9, 10);
    expect((await repo.claimApproval(d.project.id, d.root.id, 't')).kind).toBe('run');
    expect(await repo.claimApproval(d.project.id, d.root.id, 't')).toEqual({ kind: 'budget' });
    expect((await repo.get(d.project.id))?.approvalsUsed).toBe(10);
    expect(await audits('approval.autopilot.approve')).toHaveLength(1);
  });
  it('500 approvals used (the default cap) gives budget', async () => {
    const d = await start();
    await setUsed(d.project.id, 500);
    expect(await repo.claimApproval(d.project.id, d.root.id, 't')).toEqual({ kind: 'budget' });
  });
  it('usd boundary on the root budget key: spend below maxUsd runs, spend equal to maxUsd is budget', async () => {
    const d = await start({ maxUsd: 2 });
    await seedBudget(d.root.id, 1.999999, 0);
    expect((await repo.claimApproval(d.project.id, d.root.id, 't')).kind).toBe('run');
    await seedBudget(d.root.id, 2, 0);
    expect(await repo.claimApproval(d.project.id, d.root.id, 't')).toEqual({ kind: 'budget' });
    await db.pool.query("UPDATE budget_days SET spent_usd = 1, reserved_usd = 1 WHERE scope = 'task'");
    expect(await repo.claimApproval(d.project.id, d.root.id, 't')).toEqual({ kind: 'budget' }); // reserved counts
  });
  it('maxUsd 0 does not stop approvals by usd (local-only projects); calls boundary does', async () => {
    const d = await start({ maxUsd: 0, maxLocalCalls: 10 });
    await seedBudget(d.root.id, 0, 9);
    expect((await repo.claimApproval(d.project.id, d.root.id, 't')).kind).toBe('run');
    await seedBudget(d.root.id, 0, 10);
    expect(await repo.claimApproval(d.project.id, d.root.id, 't')).toEqual({ kind: 'budget' });
  });
  it('10 parallel claims at used = max - 1 give exactly one run', async () => {
    const d = await start();
    await setUsed(d.project.id, 4, 5);
    const rs = await Promise.all(Array.from({ length: 10 }, () => repo.claimApproval(d.project.id, d.root.id, 't')));
    expect(rs.filter((r) => r.kind === 'run')).toHaveLength(1);
    expect(rs.filter((r) => r.kind === 'budget')).toHaveLength(9);
    expect((await repo.get(d.project.id))?.approvalsUsed).toBe(5);
    expect(await audits('approval.autopilot.approve')).toHaveLength(1);
  });
  it('not_active: paused, exhausted, past deadline, closed, halted, off, other project id, task outside', async () => {
    const d = await start();
    const other = await propose();
    const c = () => repo.claimApproval(d.project.id, d.root.id, 't');
    await repo.setPaused({ id: d.project.id, paused: true, by: ADMIN });
    expect(await c()).toEqual({ kind: 'not_active' });
    await repo.setPaused({ id: d.project.id, paused: false, by: ADMIN });
    halted = true; expect(await c()).toEqual({ kind: 'not_active' }); halted = false;
    cfg.values.set('autopilot.enabled', false); expect(await c()).toEqual({ kind: 'not_active' }); cfg.values.delete('autopilot.enabled');
    expect(await repo.claimApproval(other.id, d.root.id, 't')).toEqual({ kind: 'not_active' });
    expect(await repo.claimApproval(d.project.id, (await root()).id, 't')).toEqual({ kind: 'not_active' });
    expect(await repo.claimApproval(d.project.id, 'missing', 't')).toEqual({ kind: 'not_active' });
    await db.pool.query("UPDATE projects SET deadline = '2000-01-01' WHERE id = $1", [d.project.id]);
    expect(await c()).toEqual({ kind: 'not_active' });
    await db.pool.query("UPDATE projects SET deadline = '2099-01-01' WHERE id = $1", [d.project.id]);
    await repo.exhaust(d.project.id);
    expect(await c()).toEqual({ kind: 'not_active' });
    expect((await repo.get(d.project.id))?.approvalsUsed).toBe(0);
    expect(await audits('approval.autopilot.approve')).toHaveLength(0);
  });
  it('lock order: the root task row is taken before the projects row', async () => {
    const d = await start();
    const holder = await db.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM tasks WHERE id = $1 FOR UPDATE', [d.root.id]);
      const pending = repo.claimApproval(d.project.id, d.root.id, 't');
      await new Promise((r) => setTimeout(r, 300));
      // the claim is waiting on the root row, so it holds no lock on the project row yet
      const probe = await db.pool.connect();
      try {
        await probe.query('BEGIN');
        await probe.query('SELECT id FROM projects WHERE id = $1 FOR UPDATE NOWAIT', [d.project.id]);
        await probe.query('ROLLBACK');
      } finally { probe.release(); }
      await holder.query('COMMIT');
      expect((await pending).kind).toBe('run');
    } finally { holder.release(); }
  });
  it('an audit insert that fails rolls the claim back (claim-first, throwing)', async () => {
    const d = await start();
    await db.pool.query("ALTER TABLE audit_log ADD CONSTRAINT zz_block CHECK (action <> 'approval.autopilot.approve')");
    try {
      await expect(repo.claimApproval(d.project.id, d.root.id, 't')).rejects.toThrow();
    } finally {
      await db.pool.query('ALTER TABLE audit_log DROP CONSTRAINT zz_block');
    }
    expect((await repo.get(d.project.id))?.approvalsUsed).toBe(0);
  });
});

describe('exhaust and raise (SA-1 3.5, AP-C12)', () => {
  it('exhaust is claim-first: of 6 concurrent callers exactly one gets the row, with a fresh token', async () => {
    const d = await start();
    const rs = await Promise.all(Array.from({ length: 6 }, () => repo.exhaust(d.project.id)));
    expect(rs.filter((r) => r !== null)).toHaveLength(1);
    const row = rs.find((r) => r)!;
    expect(row.budgetToken).toMatch(/^[0-9a-f]{32}$/);
    expect(row.exhaustedAt).not.toBeNull();
    expect(await repo.exhaust(d.project.id)).toBeNull();
    expect(await repo.setBudgetCard(d.project.id, '323456789012345678', '423456789012345678')).toBe(true);
    expect((await repo.getByBudgetToken(row.budgetToken!))?.id).toBe(d.project.id);
  });
  it('raise adds the base amounts, clears the mark, unblocks only the budget-blocked tasks of that root (not turns-blocked, not another tree), audits', async () => {
    const d = await start({ maxLocalCalls: 10, maxUsd: 2 });
    const k1 = await child(d.root.id);
    const k2 = await child(d.root.id);
    const k3 = await child(d.root.id);
    const foreign = await root();
    await db.pool.query("UPDATE tasks SET status = 'blocked', blocked_reason = 'budget' WHERE id IN ($1,$2,$3,$4)", [k1.id, k2.id, k3.id, foreign.id]);
    await db.pool.query("UPDATE tasks SET blocked_reason = 'turns' WHERE id = $1", [k2.id]);
    const ex = (await repo.exhaust(d.project.id))!;
    const r = await repo.raise({ id: d.project.id, by: ADMIN, token: ex.budgetToken! });
    if (!r.ok) throw new Error(r.code);
    expect(r.project).toMatchObject({ maxLocalCalls: 20, maxUsd: 4, maxApprovals: 1000, exhaustedAt: null });
    expect(r.unblocked.map((t) => t.id).sort()).toEqual([k1.id, k3.id].sort());
    const st = Object.fromEntries((await db.pool.query<{ id: string; status: string; blocked_reason: string | null }>('SELECT id, status, blocked_reason FROM tasks')).rows.map((x) => [x.id, x]));
    expect(st[k1.id]).toMatchObject({ status: 'todo', blocked_reason: null });
    expect(st[k2.id]).toMatchObject({ status: 'blocked', blocked_reason: 'turns' });
    expect(st[foreign.id]).toMatchObject({ status: 'blocked', blocked_reason: 'budget' });
    expect(await audits('project.raise')).toEqual([expect.objectContaining({ outcome: `#${d.project.id} ok unblocked 2`, task_id: d.root.id })]);
    expect(await repo.raise({ id: d.project.id, by: ADMIN })).toEqual({ ok: false, code: 'not_exhausted' });
  });
  it('raise refusals: halted, not_found, not_active, wrong_card; a button of an older notice is wrong_card after a new exhaust', async () => {
    const d = await start();
    const ex = (await repo.exhaust(d.project.id))!;
    halted = true; expect(await repo.raise({ id: d.project.id, by: ADMIN })).toEqual({ ok: false, code: 'halted' }); halted = false;
    expect(await repo.raise({ id: 9999, by: ADMIN })).toEqual({ ok: false, code: 'not_found' });
    expect(await repo.raise({ id: d.project.id, by: ADMIN, token: 'a'.repeat(32) })).toEqual({ ok: false, code: 'wrong_card' });
    expect((await repo.raise({ id: d.project.id, by: ADMIN, token: ex.budgetToken! })).ok).toBe(true);
    const ex2 = (await repo.exhaust(d.project.id))!;
    expect(ex2.budgetToken).not.toBe(ex.budgetToken);
    expect(await repo.raise({ id: d.project.id, by: ADMIN, token: ex.budgetToken! })).toEqual({ ok: false, code: 'wrong_card' });
    await repo.close({ id: d.project.id, by: ADMIN });
    expect(await repo.raise({ id: d.project.id, by: ADMIN })).toEqual({ ok: false, code: 'not_active' });
  });
  it('a CHECK overflow gives raise_max and changes nothing', async () => {
    const d = await start({ maxLocalCalls: 100 });
    await db.pool.query('UPDATE projects SET max_local_calls = 999950 WHERE id = $1', [d.project.id]);
    await repo.exhaust(d.project.id);
    const k = await child(d.root.id);
    await db.pool.query("UPDATE tasks SET status = 'blocked', blocked_reason = 'budget' WHERE id = $1", [k.id]);
    expect(await repo.raise({ id: d.project.id, by: ADMIN })).toEqual({ ok: false, code: 'raise_max' });
    const p = (await repo.get(d.project.id))!;
    expect(p.maxLocalCalls).toBe(999950);
    expect(p.exhaustedAt).not.toBeNull();
    expect((await db.pool.query('SELECT status FROM tasks WHERE id = $1', [k.id])).rows[0]).toEqual({ status: 'blocked' });
  });
});

describe('lifecycle', () => {
  it('pause and resume are conditional and audited', async () => {
    const d = await start();
    expect((await repo.setPaused({ id: d.project.id, paused: true, by: ADMIN })).ok).toBe(true);
    expect(await repo.setPaused({ id: d.project.id, paused: true, by: ADMIN })).toEqual({ ok: false, code: 'unchanged' });
    expect((await repo.setPaused({ id: d.project.id, paused: false, by: ADMIN })).ok).toBe(true);
    expect(await repo.setPaused({ id: 4040, paused: true, by: ADMIN })).toEqual({ ok: false, code: 'not_found' });
    expect((await audits('project.pause')).length + (await audits('project.resume')).length).toBe(2);
    await repo.close({ id: d.project.id, by: ADMIN });
    expect(await repo.setPaused({ id: d.project.id, paused: true, by: ADMIN })).toEqual({ ok: false, code: 'not_active' });
  });
  it('close with only the root open sets the root done and returns it; with open children it leaves the tree', async () => {
    const a = await start();
    const r = await repo.close({ id: a.project.id, by: ADMIN });
    if (!r.ok) throw new Error(r.code);
    expect(r.project).toMatchObject({ status: 'done', closedBy: ADMIN });
    expect(r.rootClosed).toMatchObject({ from: 'todo', task: { id: a.root.id, status: 'done' } });
    expect(await repo.close({ id: a.project.id, by: ADMIN })).toEqual({ ok: false, code: 'not_active' });
    expect(await repo.close({ id: 5050, by: ADMIN })).toEqual({ ok: false, code: 'not_found' });
    const b = await start();
    const k = await child(b.root.id);
    const r2 = await repo.close({ id: b.project.id, by: ADMIN });
    if (!r2.ok) throw new Error(r2.code);
    expect(r2.rootClosed).toBeNull();
    expect((await db.pool.query('SELECT status FROM tasks WHERE id = ANY($1) ORDER BY id', [[b.root.id, k.id]])).rows.every((x) => x.status === 'todo')).toBe(true);
    expect((await audits('project.close')).length).toBe(2);
  });
  it('rootEnded closes an active project once and writes project.end; later calls do nothing', async () => {
    const a = await start();
    expect(await repo.rootEnded(a.root.id, 'cancelled')).toBe(a.project.id);
    expect(await repo.rootEnded(a.root.id, 'cancelled')).toBeNull();
    expect(await repo.get(a.project.id)).toMatchObject({ status: 'cancelled', closedBy: 'system' });
    expect(await audits('project.end')).toEqual([expect.objectContaining({ outcome: `#${a.project.id} cancelled`, task_id: a.root.id })]);
    const b = await start();
    expect(await repo.rootEnded(b.root.id, 'done')).toBe(b.project.id);
    expect((await repo.get(b.project.id))?.status).toBe('done');
    expect(await repo.rootEnded((await root()).id, 'done')).toBeNull();
  });
  it('list: newest first with calls, usd and pastDeadline', async () => {
    const a = await start();
    await seedBudget(a.root.id, 1.25, 3);
    const b = await start();
    await db.pool.query("UPDATE projects SET deadline = '2000-01-01' WHERE id = $1", [a.project.id]);
    const rows = await repo.list();
    expect(rows.map((r) => r.id)).toEqual([b.project.id, a.project.id]);
    expect(rows[1]).toMatchObject({ calls: 3, usd: 1.25, pastDeadline: true });
    expect(rows[0]).toMatchObject({ calls: 0, usd: 0, pastDeadline: false });
  });
});

describe('deadline (AP-C9)', () => {
  it('the one notice is claimed once; extend clears it and is a CAS with an audit row', async () => {
    const d = await start();
    expect(await repo.deadlineOwed()).toEqual([]);
    await db.pool.query("UPDATE projects SET deadline = '2000-01-01' WHERE id = $1", [d.project.id]);
    expect((await repo.deadlineOwed()).map((p) => p.id)).toEqual([d.project.id]);
    const rs = await Promise.all(Array.from({ length: 5 }, () => repo.claimDeadlineNotice(d.project.id)));
    expect(rs.filter((r) => r)).toHaveLength(1);
    expect(await repo.deadlineOwed()).toEqual([]);
    expect(await repo.extend({ id: d.project.id, deadline: 'nonsense', by: ADMIN })).toEqual({ ok: false, code: 'bad_date' });
    const e = await repo.extend({ id: d.project.id, deadline: '2099-02-02', by: ADMIN });
    if (!e.ok) throw new Error(e.code);
    expect(e.project).toMatchObject({ deadline: '2099-02-02', deadlineNoticedAt: null });
    expect(await repo.claimDeadlineNotice(d.project.id)).toBeNull(); // not past it any more
    expect(await audits('project.extend')).toEqual([expect.objectContaining({ outcome: `#${d.project.id} ok 2099-02-02`, task_id: d.root.id })]);
    halted = true;
    expect(await repo.extend({ id: d.project.id, deadline: '2099-03-03', by: ADMIN })).toEqual({ ok: false, code: 'halted' });
    halted = false;
    await repo.close({ id: d.project.id, by: ADMIN });
    expect(await repo.extend({ id: d.project.id, deadline: '2099-03-03', by: ADMIN })).toEqual({ ok: false, code: 'not_active' });
    expect(await repo.extend({ id: 7070, deadline: '2099-03-03', by: ADMIN })).toEqual({ ok: false, code: 'not_found' });
  });
});

describe('project tools (C2, AP-C7)', () => {
  it('grantTool: one per (project, dept, tool), 10 per project, only on an active project', async () => {
    const d = await start();
    const g = (tool: string, dept = 'sales') => repo.grantTool({ projectId: d.project.id, deptId: dept, tool, taskId: d.root.id });
    expect(await g('read_file')).toEqual({ ok: true });
    expect(await g('read_file')).toEqual({ ok: false, code: 'exists' });
    expect(await g('read_file', 'hr')).toEqual({ ok: true });
    for (let i = 0; i < 8; i++) expect(await g(`tool_${i}`)).toEqual({ ok: true });
    expect(await g('one_more')).toEqual({ ok: false, code: 'cap' });
    expect(await g('read_file')).toEqual({ ok: false, code: 'exists' });
    const other = await propose();
    expect(await repo.grantTool({ projectId: other.id, deptId: 'sales', tool: 'x', taskId: null })).toEqual({ ok: false, code: 'not_active' });
  });
  it('concurrent grants cannot pass the cap of 10', async () => {
    const d = await start();
    const rs = await Promise.all(Array.from({ length: 14 }, (_, i) => repo.grantTool({ projectId: d.project.id, deptId: 'sales', tool: `t_${i}`, taskId: null })));
    expect(rs.filter((r) => r.ok)).toHaveLength(10);
  });
  it('toolsFor: only the active, unpaused, not exhausted project and that department; toolsForTask: active even when paused or exhausted, empty after close', async () => {
    const d = await start();
    const k = await child(d.root.id);
    await repo.grantTool({ projectId: d.project.id, deptId: 'sales', tool: 'read_file', taskId: null });
    await repo.grantTool({ projectId: d.project.id, deptId: 'hr', tool: 'forum_read', taskId: null });
    expect(await repo.toolsFor(d.project.id, 'sales')).toEqual(['read_file']);
    expect(await repo.toolsFor(d.project.id, 'none')).toEqual([]);
    expect(await repo.toolsForTask(k.id, 'sales')).toEqual(['read_file']);
    await repo.setPaused({ id: d.project.id, paused: true, by: ADMIN });
    expect(await repo.toolsFor(d.project.id, 'sales')).toEqual([]);
    expect(await repo.toolsForTask(k.id, 'sales')).toEqual(['read_file']);
    await repo.setPaused({ id: d.project.id, paused: false, by: ADMIN });
    await repo.exhaust(d.project.id);
    expect(await repo.toolsFor(d.project.id, 'sales')).toEqual([]);
    expect(await repo.toolsForTask(k.id, 'sales')).toEqual(['read_file']);
    await repo.close({ id: d.project.id, by: ADMIN });
    expect(await repo.toolsFor(d.project.id, 'sales')).toEqual([]);
    expect(await repo.toolsForTask(k.id, 'sales')).toEqual([]);
    expect(await repo.toolsForTask('nope', 'sales')).toEqual([]);
  });
});

describe('day (digest)', () => {
  it('counts today\'s auto approvals per project and tool, refusals per code, exhausted projects and grants', async () => {
    const a = await start({ title: 'Alpha' });
    const k = await child(a.root.id);
    await repo.claimApproval(a.project.id, k.id, 'web_search');
    await repo.claimApproval(a.project.id, k.id, 'web_search');
    await repo.claimApproval(a.project.id, a.root.id, 'fetch_page');
    await db.pool.query("INSERT INTO audit_log (actor, action, task_id, tool, outcome) VALUES ('head:hq','tool',$1,'web_search','autopilot_refused:query_heuristic'), ('head:hq','tool',$1,'fetch_page','autopilot_refused:url_heuristic'), ('head:hq','tool',$1,'web_search','autopilot_refused:query_heuristic'), ('head:hq','tool',$1,'web_search','ok')", [k.id]);
    await repo.grantTool({ projectId: a.project.id, deptId: 'sales', tool: 'read_file', taskId: null });
    await repo.exhaust(a.project.id);
    expect(await repo.day('Asia/Bangkok')).toEqual({
      projects: [{ id: a.project.id, title: 'Alpha', n: 3 }],
      tools: [{ tool: 'web_search', n: 2 }, { tool: 'fetch_page', n: 1 }],
      refused: [{ code: 'query_heuristic', n: 2 }, { code: 'url_heuristic', n: 1 }],
      exhausted: [{ id: a.project.id, title: 'Alpha' }],
      grants: [{ projectId: a.project.id, dept: 'sales', tool: 'read_file' }],
      company: { total: 0, tools: [], capHit: null, treeGrants: [] }, // AUTO-2: nothing company-wide in a project-only day
    });
    await db.pool.query("UPDATE audit_log SET ts = now() - interval '2 days'");
    expect((await repo.day('Asia/Bangkok')).projects).toEqual([]);
  });
});
