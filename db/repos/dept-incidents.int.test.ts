import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Org, seed } from '../../company/index.js';
import { prompts } from '../../agents/test-helpers.js';
import { migrate } from '../migrate.js';
import { freshDb, type TestDb } from '../test-helpers.js';
import { ChannelMapRepo, DepartmentRepo, PersonaRepo } from './org.js';
import { RetroRepo } from './grow.js';
import { DeptIncidentRepo } from './dept-incidents.js';
import { newBuild, newForge, newRelease, resetForgeTables } from './forge-test-helpers.js';
import { TaskRepo, type NewTask, type Task } from './tasks.js';
import type { SweepStep } from './dept-incidents.js';

let db: TestDb;
let tasks: TaskRepo;
let repo: DeptIncidentRepo;
const HEAD = { kind: 'head', dept: 'software' } as const;
const TZ = 'Asia/Bangkok';
const ALL: SweepStep[] = ['tasks', 'heal', 'tools', 'retention', 'cap'];
const MARK = 'MARKER-IGNORE-ALL-RULES';

beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations'), 'up');
  const repos = { departments: new DepartmentRepo(db.pool), personas: new PersonaRepo(db.pool), channelMap: new ChannelMapRepo(db.pool) };
  await seed(repos, prompts);
  await Org.load(repos, prompts);
  tasks = new TaskRepo(db.pool, []);
  repo = new DeptIncidentRepo(db.pool);
});
afterAll(async () => db.close());
beforeEach(async () => {
  for (const t of ['dept_incidents', 'audit_log', 'retro_runs', 'tasks']) await db.pool.query(`DELETE FROM ${t}`);
});

const sweep = async (steps: SweepStep[] = ALL) => { for (const s of steps) await repo.step(s, TZ); };
const mk = (title: string, o: Partial<NewTask> = {}): Promise<Task> =>
  tasks.create({ title, deptId: 'software', owner: HEAD, requester: HEAD, origin: 'delegated', tainted: false, status: 'blocked', ...o });
const setReason = (id: string, reason: string | null, note: string | null = null) => db.pool.query('UPDATE tasks SET blocked_reason = $2, blocked_note = $3 WHERE id = $1', [id, reason, note]);
const audit = (actor: string, action: string, tool: string | null, outcome: string, taskId: string | null = null, ago = '1 hour') =>
  db.pool.query("INSERT INTO audit_log (actor, action, tool, outcome, task_id, ts) VALUES ($1,$2,$3,$4,$5, now() - $6::interval)", [actor, action, tool, outcome, taskId, ago]);
const rows = async () => (await db.pool.query('SELECT dept_id, kind, code, tool, task_id, n, ikey FROM dept_incidents ORDER BY kind, code, ikey')).rows;

describe('LEARN-1 sweep S1: tasks (D2)', () => {
  it('records error, turns, owner and budget blocks and cancelled tasks; halt and approval blocks and open tasks are not', async () => {
    for (const r of ['error', 'turns', 'owner', 'budget', 'halt', 'approval']) await setReason((await mk(`t-${r}`)).id, r);
    await mk('cancelled one', { status: 'cancelled' });
    await mk('still doing', { status: 'doing' });
    await mk('done', { status: 'done' });
    await sweep(['tasks']);
    expect((await rows()).map((r) => `${r.kind}:${r.code}`).sort()).toEqual(['task_blocked:budget', 'task_blocked:error', 'task_blocked:owner', 'task_blocked:turns', 'task_cancelled:cancelled']);
  });
  it('praw, retro tasks, heal decide tasks, old rows and non-UUID ids are excluded', async () => {
    await setReason((await mk('keep me')).id, 'owner');
    await mk('no reason'); // a blocked task with a NULL reason is recorded with code owner (COALESCE in the exclusion predicate)
    await mk('praw task', { deptId: 'praw', owner: { kind: 'head', dept: 'praw' } });
    const retro = await mk('Weekly retro 2026-W45', {});
    await db.pool.query("INSERT INTO retro_runs (dept_id, week, task_id) VALUES ('software','2026-W45',$1)", [retro.id]);
    await setReason(retro.id, 'error');
    const decide = await mk('Decide on blocked task abc12345', { deptId: 'hq', owner: { kind: 'head', dept: 'hq' } });
    await setReason(decide.id, 'error');
    const old = await mk('old');
    await setReason(old.id, 'error');
    await db.pool.query("UPDATE tasks SET updated_at = now() - interval '3 days' WHERE id = $1", [old.id]);
    const odd = await mk('odd id', { id: 'not-a-uuid-id' });
    await setReason(odd.id, 'error');
    await sweep(['tasks']);
    const r = await rows();
    expect(r).toHaveLength(2);
    expect(r.map((x) => `${x.dept_id}:${x.kind}:${x.code}`)).toEqual(['software:task_blocked:owner', 'software:task_blocked:owner']);
  });
  it('a child decide task (parent set) in hq is still counted; a second sweep adds no rows; a reason change is a new row', async () => {
    const parent = await mk('p', { status: 'doing' });
    const child = await mk('Decide on blocked task 1', { deptId: 'hq', owner: { kind: 'head', dept: 'hq' }, parentId: parent.id });
    await setReason(child.id, 'error');
    const t = await mk('x');
    await setReason(t.id, 'error');
    await sweep(['tasks']);
    const first = await rows();
    expect(first).toHaveLength(2);
    await sweep(['tasks']);
    expect(await rows()).toEqual(first);
    await setReason(t.id, 'turns');
    await sweep(['tasks']);
    expect(await rows()).toHaveLength(3);
  });
  it('the batch is at most 200 tasks per sweep', async () => {
    for (let i = 0; i < 205; i++) await setReason((await mk(`t${i}`)).id, 'error');
    await sweep(['tasks']);
    expect(await rows()).toHaveLength(200);
    await sweep(['tasks']);
    expect((await rows()).length).toBeGreaterThanOrEqual(200);
  });
});

describe('LEARN-1 sweep S2: heal decisions', () => {
  it('retry and cancel keep their code, refused:<any> becomes refused, other outcomes and other departments of praw are skipped, a repeat adds nothing', async () => {
    const t = await mk('x');
    await audit('head:hq', 'task.heal.resolve', null, 'retry', t.id);
    await audit('head:hq', 'task.heal.resolve', null, 'cancel', t.id);
    await audit('head:hq', 'task.heal.resolve', null, `refused:${MARK}`, t.id);
    await audit('head:hq', 'task.heal.resolve', null, `something else ${MARK}`, t.id);
    await audit('head:hq', 'task.heal.resolve', null, 'retry', t.id, '3 days');
    await audit('head:hq', 'task.heal.resolve', null, 'retry', null);
    const p = await mk('praw', { deptId: 'praw', owner: { kind: 'head', dept: 'praw' } });
    await audit('head:hq', 'task.heal.resolve', null, 'retry', p.id);
    await sweep(['heal']);
    expect((await rows()).map((r) => r.code).sort()).toEqual(['cancel', 'refused', 'retry']);
    await sweep(['heal']);
    expect(await rows()).toHaveLength(3);
  });
});

describe('LEARN-1 sweep S3: tool error clusters', () => {
  it('a cluster needs n >= 3 per dept, day, tool and code; personas map to their department; unknown_tool, praw and bad names are excluded; a growing count updates n', async () => {
    for (let i = 0; i < 3; i++) await audit('head:software', 'tool', 'create_task', 'tool_error');
    for (let i = 0; i < 2; i++) await audit('head:software', 'tool', 'update_task', 'denied'); // below 3
    for (let i = 0; i < 3; i++) await audit('persona:system-analyst', 'tool', 'read_file', 'invalid_input'); // persona of software
    for (let i = 0; i < 4; i++) await audit('head:software', 'tool', 'ignore_the_rules_and_do_x_now', 'unknown_tool');
    for (let i = 0; i < 4; i++) await audit('head:praw', 'tool', 'create_task', 'tool_error');
    for (let i = 0; i < 4; i++) await audit('head:software', 'tool', 'Bad Tool Name', 'tool_error');
    for (let i = 0; i < 4; i++) await audit('head:software', 'tool', 'create_task', 'free text outcome');
    for (let i = 0; i < 4; i++) await audit('head:software', 'other', 'create_task', 'tool_error');
    await sweep(['tools']);
    let r = (await rows()).map((x) => `${x.dept_id}:${x.tool}:${x.code}:${x.n}`).sort();
    expect(r).toEqual(['software:create_task:tool_error:3', 'software:read_file:invalid_input:3']);
    await audit('head:software', 'tool', 'create_task', 'tool_error');
    await sweep(['tools']);
    r = (await rows()).map((x) => `${x.dept_id}:${x.tool}:${x.code}:${x.n}`).sort();
    expect(r).toEqual(['software:create_task:tool_error:4', 'software:read_file:invalid_input:3']);
  });
});

describe('LEARN-1 S4 retention and S5 cap, S6 summary', () => {
  const ins = (i: number, dept: string, ago: string) =>
    db.pool.query("INSERT INTO dept_incidents (dept_id, kind, code, task_id, ikey, created_at) VALUES ($1,'task_blocked','error',$2,$3, now() - $4::interval)", [dept, `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`, `k${i}`, ago]);
  it('S4 deletes rows older than 30 days', async () => {
    await ins(1, 'software', '31 days');
    await ins(2, 'software', '29 days');
    await sweep(['retention']);
    expect((await rows()).map((r) => r.ikey)).toEqual(['k2']);
  });
  it('S5 keeps the newest 500 per department and leaves other departments alone', async () => {
    await db.pool.query("INSERT INTO dept_incidents (dept_id, kind, code, task_id, ikey, created_at) SELECT 'software','task_blocked','error','00000000-0000-0000-0000-000000000001','s'||g, now() - (g || ' seconds')::interval FROM generate_series(1, 503) g");
    await ins(900, 'rnd', '1 hour');
    await sweep(['cap']);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM dept_incidents WHERE dept_id = 'software'")).rows[0].n).toBe(500);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM dept_incidents WHERE dept_id = 'rnd'")).rows[0].n).toBe(1);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM dept_incidents WHERE ikey IN ('s501','s502','s503')")).rows[0].n).toBe(0); // the oldest went
  });
  it('S6 summary: 7 days, this department only, grouped, biggest first, at most 20 rows', async () => {
    await db.pool.query("INSERT INTO dept_incidents (dept_id, kind, code, tool, ikey, n) VALUES ('software','tool_errors','error','a_tool','t1',5), ('software','tool_errors','error','b_tool','t2',9), ('rnd','tool_errors','error','a_tool','t3',50)");
    await db.pool.query("INSERT INTO dept_incidents (dept_id, kind, code, tool, ikey, n, created_at) VALUES ('software','tool_errors','error','old_tool','t4',99, now() - interval '8 days')");
    await ins(1, 'software', '1 hour');
    await ins(2, 'software', '2 hours');
    const s = await repo.summary('software');
    expect(s).toEqual([{ kind: 'tool_errors', code: 'error', tool: 'b_tool', n: 9 }, { kind: 'tool_errors', code: 'error', tool: 'a_tool', n: 5 }, { kind: 'task_blocked', code: 'error', tool: null, n: 2 }]);
  });
});

describe('LEARN-1 LL-C5: no free text ever reaches a column', () => {
  it('markers planted in a title, description, blocked_note, audit outcomes/tool names and a room-style reason appear in no dept_incidents column', async () => {
    const t = await mk(`Title ${MARK}`, { description: `Desc ${MARK}` });
    await setReason(t.id, 'owner', `Note ${MARK}`);
    const c = await mk(`Cancelled ${MARK}`, { status: 'cancelled', description: MARK });
    void c;
    await audit('head:hq', 'task.heal.resolve', null, `refused:${MARK}`, t.id);
    await audit('head:software', 'task.event', 'summary', `event summary ${MARK}`, t.id);
    await audit('head:software', 'admin', 'reason', `admin.reason ${MARK}`, t.id);
    for (let i = 0; i < 5; i++) await audit('head:software', 'tool', `unknown_${MARK.toLowerCase().replace(/-/g, '_')}`, 'unknown_tool');
    await sweep();
    const all = JSON.stringify(await db.pool.query('SELECT * FROM dept_incidents'));
    expect(all).not.toContain('MARKER');
    expect(all.toLowerCase()).not.toContain('marker');
    expect((await rows()).length).toBeGreaterThanOrEqual(3);
  });
  it('the repo for the retro facts and the since-retro count read the same table without text', async () => {
    const retro = new RetroRepo(db.pool);
    await setReason((await mk('x')).id, 'error');
    await sweep(['tasks']);
    expect(await retro.incidentsSinceLastRetro('software')).toBe(1);
    expect((await retro.facts('software')).incidents).toEqual([{ kind: 'task_blocked', code: 'error', n: 1 }]);
  });
});

describe('R7 sweep S9: failed plugin builds (FG-AC19)', () => {
  const failedBuild = async (code: string, o: { ago?: string; taskId?: string } = {}) => {
    const f = await newForge(db.pool);
    const rel = await newRelease(db.pool, { forgeId: f.forgeId, ...(o.taskId ? { taskId: o.taskId } : {}) });
    const b = await newBuild(db.pool, { forgeId: f.forgeId, releaseId: rel, status: 'failed', code });
    if (o.ago) await db.pool.query('UPDATE plugin_builds SET finished_at = now() - $2::interval WHERE id = $1', [b, o.ago]);
    return b;
  };
  afterEach(async () => { await resetForgeTables(db.pool); }); // the file-level beforeEach deletes tasks, which the projects of these tests reference
  beforeEach(async () => { await db.pool.query('DELETE FROM dept_incidents'); });
  it('inserts one row per failed build with the release department, the release task id and the build id key; a second sweep adds nothing', async () => {
    const b = await failedBuild('verify_failed');
    await repo.step('forge', TZ);
    await repo.step('forge', TZ);
    const r = (await db.pool.query('SELECT dept_id, kind, code, tool, task_id, n, ikey FROM dept_incidents')).rows;
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ dept_id: 'software', kind: 'forge_failed', code: 'verify_failed', tool: null, n: 1, ikey: `forge:${b}` });
    expect(r[0].task_id).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('only the closed code list, only failed builds, only the last 2 days', async () => {
    await failedBuild('plugin_invalid');
    await failedBuild('interrupted', { ago: '3 days' });
    await failedBuild('stage_probe', { ago: '1 day' });
    const f = await newForge(db.pool);
    await newBuild(db.pool, { forgeId: f.forgeId, releaseId: await newRelease(db.pool, { forgeId: f.forgeId }), status: 'cancelled', code: 'expired' });
    await repo.step('forge', TZ);
    expect((await db.pool.query('SELECT code FROM dept_incidents')).rows).toEqual([{ code: 'stage_probe' }]);
    const sum = await repo.summary('software');
    expect(sum).toEqual([{ kind: 'forge_failed', code: 'stage_probe', tool: null, n: 1 }]);
  });
  it('G2-FG answer 10: the retro queries S7 and S8 include forge_failed (kind, code and count only, the release department), and a row with an unknown code is neither counted nor listed', async () => {
    const retro = new RetroRepo(db.pool);
    await failedBuild('verify_failed');
    await repo.step('forge', TZ);
    expect(await retro.incidentsSinceLastRetro('software')).toBe(1);
    expect((await retro.facts('software')).incidents).toEqual([{ kind: 'forge_failed', code: 'verify_failed', n: 1 }]);
    expect(await retro.incidentsSinceLastRetro('hq')).toBe(0); // the department is the release's, never another
    // a code outside the closed list (the table's CHECK allows any snake_case code) reaches neither query
    await db.pool.query('DELETE FROM dept_incidents');
    await db.pool.query("INSERT INTO dept_incidents (dept_id, kind, code, task_id, ikey) VALUES ('software','forge_failed','not_a_build_code','11111111-1111-4111-8111-111111111111','forge:9001')");
    expect(await retro.incidentsSinceLastRetro('software')).toBe(0);
    expect((await retro.facts('software')).incidents).toEqual([]);
  });
  it('no free text column exists: the row holds closed values only (the CHECKs refuse anything else)', async () => {
    await expect(db.pool.query("INSERT INTO dept_incidents (dept_id, kind, code, task_id, ikey) VALUES ('software','forge_failed','Bad Text!', '11111111-1111-4111-8111-111111111111', 'forge:9')")).rejects.toThrow(/check/i);
  });
});
