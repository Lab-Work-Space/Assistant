import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Org, seed } from '../../company/index.js';
import { prompts } from '../../agents/test-helpers.js';
import { migrate } from '../migrate.js';
import { freshDb, type TestDb } from '../test-helpers.js';
import { ChannelMapRepo, DepartmentRepo, PersonaRepo } from './org.js';
import { RetroRepo } from './grow.js';
import { TaskRepo, type NewTask, type Task } from './tasks.js';

let db: TestDb;
let tasks: TaskRepo;
let repo: RetroRepo;
const HEAD = { kind: 'head', dept: 'software' } as const;
const uuid = (n: number): string => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations'), 'up');
  const repos = { departments: new DepartmentRepo(db.pool), personas: new PersonaRepo(db.pool), channelMap: new ChannelMapRepo(db.pool) };
  await seed(repos, prompts);
  await Org.load(repos, prompts);
  tasks = new TaskRepo(db.pool, []);
  repo = new RetroRepo(db.pool);
});
afterAll(async () => db.close());
beforeEach(async () => {
  for (const t of ['dept_incidents', 'audit_log', 'dept_notes', 'skill_proposals', 'skill_attachments', 'retro_runs', 'tasks']) await db.pool.query(`DELETE FROM ${t}`);
});

const mk = (title: string, o: Partial<NewTask> = {}): Promise<Task> =>
  tasks.create({ title, deptId: 'software', owner: HEAD, requester: HEAD, origin: 'delegated', tainted: false, status: 'done', ...o });
const age = (id: string, days: number) => db.pool.query("UPDATE tasks SET updated_at = now() - ($2 || ' days')::interval WHERE id = $1", [id, String(days)]);
const audit = (actor: string, action: string, tool: string | null, outcome: string, taskId: string | null = null) =>
  db.pool.query('INSERT INTO audit_log (actor, action, tool, outcome, task_id) VALUES ($1,$2,$3,$4,$5)', [actor, action, tool, outcome, taskId]);

describe('RetroRepo claim, finish, skill slot', () => {
  it('claim: five concurrent claims of one (dept, week) give exactly one winner; another week and another dept are separate', async () => {
    const r = await Promise.all([1, 2, 3, 4, 5].map((i) => repo.claim('software', '2026-W46', uuid(i))));
    expect(r.filter(Boolean)).toHaveLength(1);
    expect(await repo.claimed('software', '2026-W46')).toBe(true);
    expect(await repo.claimed('software', '2026-W47')).toBe(false);
    expect(await repo.claim('software', '2026-W47', uuid(9))).toBe(true);
    expect(await repo.claim('rnd', '2026-W46', uuid(10))).toBe(true);
  });
  it('claim: a task id that is not a uuid, or a week that is not ISO, is refused by the database (it throws)', async () => {
    await expect(repo.claim('software', '2026-W46', 'nope')).rejects.toThrow();
    await expect(repo.claim('software', '2026-46', uuid(1))).rejects.toThrow();
  });
  it('finish records the first outcome only', async () => {
    await repo.claim('software', '2026-W46', uuid(1));
    await repo.finish('software', '2026-W46', 'failed');
    await repo.finish('software', '2026-W46', 'done');
    expect((await db.pool.query("SELECT outcome, finished_at IS NOT NULL AS fin FROM retro_runs")).rows).toEqual([{ outcome: 'failed', fin: true }]);
  });
  it('claimSkill: one winner under concurrency, then used; an unknown task is not_retro; release gives the slot back until a proposal is recorded', async () => {
    await repo.claim('software', '2026-W46', uuid(1));
    const r = await Promise.all([1, 2, 3, 4].map(() => repo.claimSkill(uuid(1))));
    expect(r.filter((x) => x === 'claimed')).toHaveLength(1);
    expect(r.filter((x) => x === 'used')).toHaveLength(3);
    expect(await repo.claimSkill(uuid(77))).toBe('not_retro');
    await repo.releaseSkill(uuid(1));
    expect(await repo.claimSkill(uuid(1))).toBe('claimed');
    await repo.setSkillProposal(uuid(1), 12);
    await repo.releaseSkill(uuid(1)); // a recorded proposal keeps the slot
    expect(await repo.claimSkill(uuid(1))).toBe('used');
    expect((await db.pool.query('SELECT skill_proposal_id::int AS p FROM retro_runs')).rows[0].p).toBe(12);
  });
});

describe('GW-C6 closeOpenRetroTasks (boot)', () => {
  it('cancels every non-terminal retro task whatever the outcome (a done claim whose close failed too), leaves terminal and other tasks, and marks open claims interrupted', async () => {
    const mkRetro = async (n: number, week: string, status: Task['status'], outcome: string | null) => {
      const t = await mk(`Weekly retro ${week}`, { id: uuid(n), status });
      await repo.claim('software', week, t.id);
      if (outcome) await repo.finish('software', week, outcome as 'done');
      return t;
    };
    const stuckDone = await mkRetro(1, '2026-W41', 'doing', 'done'); // closeRetro failed after finish
    const stuckOpen = await mkRetro(2, '2026-W42', 'doing', null);
    const stuckTodo = await mkRetro(3, '2026-W43', 'todo', 'failed');
    const finished = await mkRetro(4, '2026-W44', 'done', 'done');
    const other = await mk('Plain work', { status: 'doing' });
    const moved = await repo.closeOpenRetroTasks();
    expect(moved.map((t) => t.id).sort()).toEqual([stuckDone.id, stuckOpen.id, stuckTodo.id].sort());
    expect(moved.every((t) => t.status === 'cancelled')).toBe(true);
    expect((await tasks.get(finished.id))!.status).toBe('done');
    expect((await tasks.get(other.id))!.status).toBe('doing');
    expect((await db.pool.query('SELECT week, outcome FROM retro_runs ORDER BY week')).rows).toEqual([
      { week: '2026-W41', outcome: 'done' }, { week: '2026-W42', outcome: 'interrupted' }, { week: '2026-W43', outcome: 'failed' }, { week: '2026-W44', outcome: 'done' },
    ]);
    const reset = await tasks.resetDoingToTodo(); // the boot order: nothing of a retro is left to reset into a plain owner run
    expect(reset.map((t) => t.id)).toEqual([other.id]);
    expect(await repo.closeOpenRetroTasks()).toEqual([]);
  });
});

describe('RetroRepo.facts (F1-F8, GW-C5)', () => {
  it('F1/F2: counts the window; titles exclude tainted tasks, outside-origin tasks that say tainted=false, old tasks and the retro task itself', async () => {
    await mk('CLEAN-TITLE');
    await mk('TAINTED-TITLE', { tainted: true });
    for (const o of ['watch', 'import', 'poll'] as const) await mk(`OUTSIDE-${o}`, { origin: o, tainted: false });
    const old = await mk('OLD-TITLE');
    await age(old.id, 8);
    await mk('OPEN-TITLE', { status: 'doing' }); // not done/blocked/cancelled
    await mk('OTHER-DEPT', { deptId: 'rnd' });
    const retro = await mk('Weekly retro 2026-W45', { id: uuid(5) });
    await repo.claim('software', '2026-W45', retro.id);
    const f = await repo.facts('software');
    expect(f.titles.map((t) => t.title).sort()).toEqual(['CLEAN-TITLE']);
    // counts: clean + tainted + 3 outside = 5 done tasks of this department in the window (old, open, other dept and the retro task excluded)
    expect(f.counts).toEqual([{ status: 'done', n: 5 }]);
  });
  it('F3: tool errors of this head and its personas by (tool, code); other departments, successes and other actions are out', async () => {
    await audit('head:software', 'tool', 'create_task', 'tool_error');
    await audit('head:software', 'tool', 'create_task', 'tool_error');
    await audit('persona:system-analyst', 'tool', 'update_task', 'invalid_input');
    await audit('head:software', 'tool', 'respond', 'ok');
    await audit('head:rnd', 'tool', 'create_task', 'tool_error');
    await audit('head:software', 'other', 'create_task', 'tool_error');
    await audit('head:software', 'tool', 'create_task', 'some free text that is not a code');
    const f = await repo.facts('software');
    expect(f.toolErrors).toEqual([{ tool: 'create_task', outcome: 'tool_error', n: 2 }, { tool: 'update_task', outcome: 'invalid_input', n: 1 }]);
    expect(JSON.stringify(f)).not.toContain('free text');
  });
  it('F4/F5: heal and AI escalation counts by department of the task', async () => {
    const t = await mk('x', { status: 'blocked' });
    const o = await mk('y', { deptId: 'rnd', status: 'blocked' });
    await audit('system:healer', 'task.autoretry', null, 'claim #1', t.id);
    await audit('system:healer', 'task.heal.wake', 'head:software', 'claim #1 abc', t.id);
    await audit('system:healer', 'task.heal.wake', 'head:software', 'refused: busy', t.id);
    await audit('head:software', 'task.heal.resolve', null, 'retry', t.id);
    await audit('system:healer', 'task.autoretry', null, 'claim #1', o.id);
    await audit('system:ai-approver', 'approval.ai.escalate', 'github', '#4 judge', t.id);
    await audit('system:ai-approver', 'approval.ai.escalate', 'github', '#5 judge', t.id);
    await audit('system:ai-approver', 'approval.ai.escalate', 'github', '#6 tree_cap', t.id);
    await audit('system:ai-approver', 'approval.ai.escalate', 'github', '#7 judge', o.id);
    const f = await repo.facts('software');
    expect(f.heal).toEqual([{ action: 'task.autoretry', outcome: null, n: 1 }, { action: 'task.heal.resolve', outcome: 'retry', n: 1 }, { action: 'task.heal.wake', outcome: null, n: 1 }]);
    expect(f.escalations).toEqual([{ code: 'judge', n: 2 }, { code: 'tree_cap', n: 1 }]);
  });
  it('F6/F7/F8: active skills of the dept or attached to it, open proposals, untainted notes only', async () => {
    const skill = (id: string, status: string, owner: string | null) => db.pool.query(
      `WITH s AS (INSERT INTO skills (id, title, status, active_version, owner_dept, created_by) VALUES ($1,$2,$3,1,$4,'admin') RETURNING id)
       INSERT INTO skill_versions (skill_id, version, instructions, body_bytes, body_sha256, source, created_by) SELECT id, 1, 'Do the thing well and carefully.', 40, repeat('a', 64), 'admin', 'admin' FROM s`, [id, `Title ${id}`, status, owner]);
    await skill('own-skill', 'active', 'software');
    await skill('off-skill', 'disabled', 'software');
    await skill('other-skill', 'active', 'rnd');
    await skill('attached-skill', 'active', null);
    await db.pool.query("INSERT INTO skill_attachments (skill_id, target_kind, target_id, attached_by) VALUES ('attached-skill','dept','software','admin'), ('other-skill','dept','rnd','admin')");
    await db.pool.query(
      "INSERT INTO skill_proposals (dept_id, kind, skill_id, target_kind, target_id, payload, verdict, proposer) VALUES ('software','create','new-skill','dept','software','{\"reason\":\"SECRET-REASON\"}','{}','heads/software')");
    await db.pool.query("INSERT INTO dept_notes (dept_id, body, tainted) VALUES ('software','CLEAN-NOTE',false),('software','TAINTED-NOTE',true),('rnd','OTHER-NOTE',false)");
    const f = await repo.facts('software');
    expect(f.skills.map((s) => s.id)).toEqual(['attached-skill', 'own-skill']);
    expect(f.proposals).toEqual([{ id: expect.any(Number), kind: 'create', skillId: 'new-skill', status: 'open' }]);
    expect(f.notes).toEqual([{ body: 'CLEAN-NOTE' }]);
    expect(JSON.stringify(f)).not.toContain('SECRET-REASON');
  });
});

describe('LEARN-1 on-demand retro claims (D4a, LL-C8)', () => {
  it('request: one claim per dept per day key, manual and incident share it, a weekly key is separate; rows start with task_id NULL', async () => {
    expect(await repo.request('software', 'D2026-11-12', 'manual')).toBe(true);
    expect(await repo.request('software', 'D2026-11-12', 'incident')).toBe(false);
    expect(await repo.request('software', 'D2026-11-12', 'manual')).toBe(false);
    expect(await repo.request('rnd', 'D2026-11-12', 'incident')).toBe(true);
    expect(await repo.request('software', 'D2026-11-13', 'manual')).toBe(true);
    expect(await repo.claim('software', '2026-W46', uuid(1))).toBe(true);
    const r = await Promise.all([1, 2, 3, 4].map(() => repo.request('hq', 'D2026-11-14', 'manual')));
    expect(r.filter(Boolean)).toHaveLength(1);
    expect((await db.pool.query('SELECT dept_id, week, kind, task_id FROM retro_runs ORDER BY dept_id, week')).rows).toEqual([
      { dept_id: 'hq', week: 'D2026-11-14', kind: 'manual', task_id: null },
      { dept_id: 'rnd', week: 'D2026-11-12', kind: 'incident', task_id: null },
      { dept_id: 'software', week: '2026-W46', kind: 'weekly', task_id: uuid(1) },
      { dept_id: 'software', week: 'D2026-11-12', kind: 'manual', task_id: null },
      { dept_id: 'software', week: 'D2026-11-13', kind: 'manual', task_id: null },
    ]);
  });
  it('the CHECKs refuse a D-key with weekly, a W-key with manual and a malformed key', async () => {
    await expect(db.pool.query("INSERT INTO retro_runs (dept_id, week, kind) VALUES ('software','D2026-11-12','weekly')")).rejects.toThrow(/check/i);
    await expect(db.pool.query("INSERT INTO retro_runs (dept_id, week, kind) VALUES ('software','2026-W46','manual')")).rejects.toThrow(/check/i);
    await expect(db.pool.query("INSERT INTO retro_runs (dept_id, week, kind) VALUES ('software','D2026-1-1','manual')")).rejects.toThrow(/check/i);
    await expect(repo.request('software', '2026-W46', 'manual')).rejects.toThrow();
  });
  it('nextRequested lists only unassigned, unfinished rows oldest first; assign is a CAS; expireRequested drops rows older than 24 h', async () => {
    await repo.request('software', 'D2026-11-10', 'manual');
    await repo.request('rnd', 'D2026-11-11', 'incident');
    await repo.request('hq', 'D2026-11-12', 'manual');
    await db.pool.query("UPDATE retro_runs SET claimed_at = now() - interval '30 hours' WHERE dept_id = 'software'");
    await db.pool.query("UPDATE retro_runs SET claimed_at = now() - interval '2 hours' WHERE dept_id = 'rnd'");
    expect((await repo.nextRequested()).map((r) => r.deptId)).toEqual(['software', 'rnd', 'hq']);
    expect(await repo.expireRequested()).toBe(1);
    expect((await db.pool.query("SELECT outcome, finished_at IS NOT NULL AS fin FROM retro_runs WHERE dept_id = 'software'")).rows).toEqual([{ outcome: 'failed', fin: true }]);
    expect((await repo.nextRequested()).map((r) => r.deptId)).toEqual(['rnd', 'hq']);
    const won = await Promise.all([uuid(1), uuid(2), uuid(3)].map((id) => repo.assign('rnd', 'D2026-11-11', id)));
    expect(won.filter(Boolean)).toHaveLength(1);
    expect(await repo.assign('software', 'D2026-11-10', uuid(9))).toBe(false); // expired rows cannot be taken
    expect((await repo.nextRequested()).map((r) => r.deptId)).toEqual(['hq']);
  });
  it('closeOpenRetroTasks leaves a requested row (task_id NULL) alone, and still interrupts an assigned one', async () => {
    await repo.request('software', 'D2026-11-12', 'manual');
    await repo.request('rnd', 'D2026-11-12', 'manual');
    await repo.assign('rnd', 'D2026-11-12', uuid(4));
    await repo.closeOpenRetroTasks();
    expect((await db.pool.query('SELECT dept_id, outcome FROM retro_runs ORDER BY dept_id')).rows).toEqual([{ dept_id: 'rnd', outcome: 'interrupted' }, { dept_id: 'software', outcome: null }]);
    expect((await repo.nextRequested()).map((r) => r.deptId)).toEqual(['software']);
  });
  it('S8 incidentsSinceLastRetro counts task_blocked and tool_errors of 7 days newer than the latest retro claim of any kind', async () => {
    const ins = (kind: string, ikey: string, ago: string, dept = 'software') =>
      db.pool.query(`INSERT INTO dept_incidents (dept_id, kind, code, tool, task_id, ikey, created_at) VALUES ($1,$2,'error',$3,$4,$5, now() - $6::interval)`, [dept, kind, kind === 'tool_errors' ? 'read_file' : null, kind === 'tool_errors' ? null : uuid(7), ikey, ago]);
    await ins('task_blocked', 'a', '1 hour');
    await ins('tool_errors', 'b', '2 hours');
    await ins('task_cancelled', 'c', '1 hour'); // not counted
    await ins('heal_resolve', 'd', '1 hour'); // not counted
    await ins('task_blocked', 'e', '8 days'); // outside the window
    await ins('task_blocked', 'f', '1 hour', 'rnd'); // another department
    expect(await repo.incidentsSinceLastRetro('software')).toBe(2);
    await repo.request('software', 'D2026-11-12', 'manual');
    await db.pool.query("UPDATE retro_runs SET claimed_at = now() - interval '90 minutes'");
    expect(await repo.incidentsSinceLastRetro('software')).toBe(1); // only the 1-hour-old one is newer than the claim
    await db.pool.query("UPDATE retro_runs SET claimed_at = now()");
    expect(await repo.incidentsSinceLastRetro('software')).toBe(0);
  });
  it('F9 (S7): facts.incidents sums task_blocked and task_cancelled of the last 7 days by kind and code only', async () => {
    const row = (kind: string, code: string, ikey: string, n: number, ago = '1 hour') =>
      db.pool.query("INSERT INTO dept_incidents (dept_id, kind, code, task_id, n, ikey, created_at) VALUES ('software',$1,$2,$3,$4,$5, now() - $6::interval)", [kind, code, uuid(7), n, ikey, ago]);
    await row('task_blocked', 'error', 'a', 1);
    await row('task_blocked', 'error', 'b', 1);
    await row('task_blocked', 'turns', 'c', 1);
    await row('task_cancelled', 'cancelled', 'd', 1);
    await row('task_blocked', 'owner', 'e', 1, '9 days');
    await db.pool.query("INSERT INTO dept_incidents (dept_id, kind, code, tool, ikey) VALUES ('software','tool_errors','error','read_file','t')");
    const f = await repo.facts('software');
    expect([...f.incidents].sort((a, b) => a.code.localeCompare(b.code))).toEqual([{ kind: 'task_cancelled', code: 'cancelled', n: 1 }, { kind: 'task_blocked', code: 'error', n: 2 }, { kind: 'task_blocked', code: 'turns', n: 1 }]);
  });
});
