import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPANY_AUTOPILOT_NOTE, autopilotNote } from '../../agents/context.js';
import { runAgent } from '../../agents/loop/loop.js';
import { setup as loopSetup, route as loopRoute, respond } from '../../agents/loop/loop-fixture.js';
import { MemNotes, auditSpy, newBus, runCtxBase, seededOrg } from '../../agents/test-helpers.js';
import { localDay } from '../../company/calendar.js';
import type { ActorRef } from '../../company/types.js';
import { EventBus, type AppEvents } from '../../core/events.js';
import { migrate } from '../../db/migrate.js';
import { DepartmentRepo, ProjectRepo, TaskRepo } from '../../db/repos/index.js';
import type { Task } from '../../db/repos/tasks.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { CONFIG_CHANNEL_ID } from '../../discord/commands/types.js';
import { AutopilotService } from '../../governance/autopilot.js';
import { Limits } from '../../governance/limits.js';
import { ProjectService } from '../../governance/projects.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import type { FakeProvider } from '../../providers/index.js';
import { ASK_REFUSALS, askRequester } from '../../tools/builtin/askRequester.js';
import { createTask } from '../../tools/builtin/createTask.js';
import type { ToolContext } from '../../tools/types.js';

/**
 * AUTO-2 AC-C5: one table. Project states x consumers; only the state "none" gets company behaviour. The consumers are the real ones on a real database:
 * AutopilotService.decide, the loop's note, ask_requester, create_task's estimate skip, treeToolsFor and toolsForTask.
 */
let db: TestDb;
let tasks: TaskRepo;
let repo: ProjectRepo;
let svc: ProjectService;
let auto: AutopilotService;
let cfg: FakeConfig;
const hq: ActorRef = { kind: 'head', dept: 'hq' };
const rnd: ActorRef = { kind: 'head', dept: 'rnd' };
const ADMIN = '123456789012345678';
const plusDays = (n: number): string => localDay(Date.now() + n * 86_400_000, 'Asia/Bangkok').date;
const HERE = dirname(fileURLToPath(import.meta.url));

beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(HERE, '..', '..', 'db', 'migrations'), 'up');
  for (const id of ['hq', 'rnd']) await new DepartmentRepo(db.pool).upsert({ id: id as never, name: id, categoryNamePattern: '', workChannelId: null, color: 0, model: null, provider: null, enabled: true });
  tasks = new TaskRepo(db.pool);
});
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  cfg = new FakeConfig({ 'autopilot.scope': 'company' });
  repo = new ProjectRepo(db.pool, { cfg, halt: { isHalted: () => false }, now: () => Date.now() });
  let posts = 0;
  svc = new ProjectService({
    repo, cfg, tasks, bus: new EventBus<AppEvents>({ error: () => undefined }), halted: () => false, secrets: [], configChannelId: CONFIG_CHANNEL_ID, now: () => Date.now(),
    postCard: async () => `8000000000000${String(10000 + ++posts)}`, closeCard: async () => undefined, notifyHead: async () => undefined, log: { error: () => undefined },
  });
  for (const t of ['tree_tools', 'autopilot_company_counts', 'daily_runs', 'project_tools', 'projects', 'task_grants', 'web_grants', 'ot_requests', 'approvals', 'audit_log', 'budget_days']) await db.pool.query(`DELETE FROM ${t}`);
  await db.pool.query('UPDATE tasks SET parent_id = NULL');
  await db.pool.query('DELETE FROM tasks');
  auto = new AutopilotService({ cfg, halted: () => false, repo, org: await seededOrg(), describe: () => ({ kind: 'read' }) as never, secrets: [], exhausted: (id) => svc.exhausted(id), log: { error: () => undefined } });
});

const STATES = ['live', 'paused', 'exhausted', 'past_deadline', 'closed_open_child', 'none'] as const;
type State = (typeof STATES)[number];

async function seed(state: State): Promise<{ root: Task; kid: Task }> {
  let root: Task;
  if (state === 'none') {
    root = await tasks.create({ title: 'chat', deptId: 'hq', owner: hq, requester: { kind: 'human', userId: '42' }, origin: 'chat', status: 'doing', conversation: true });
  } else {
    const r = await svc.start({ userId: ADMIN, title: 'Coffee', goal: 'g', deadline: plusDays(30), usd: 5, calls: 100 });
    if (!r.ok) throw new Error('start');
    const p = (await repo.get(r.id))!;
    const d = await svc.decideCard({ token: p.token, action: 'approve', userId: ADMIN, channelId: p.channelId, messageId: p.messageId });
    if (!d.ok || d.result !== 'approved') throw new Error('approve');
    root = (await tasks.get(d.root.id))!;
    await tasks.update(root.id, { status: 'doing' }, 'todo');
    if (state === 'paused') await svc.pause(r.id, ADMIN);
    if (state === 'exhausted') await db.pool.query('UPDATE projects SET exhausted_at = now() WHERE id = $1', [r.id]);
    if (state === 'past_deadline') await db.pool.query('UPDATE projects SET deadline = current_date - 3 WHERE id = $1', [r.id]);
  }
  const kid = await tasks.create({ title: 'kid', deptId: 'rnd', owner: rnd, requester: hq, origin: 'delegated', parentId: root.id, status: 'doing' });
  if (state === 'closed_open_child') await svc.close((await db.pool.query<{ id: number }>('SELECT id FROM projects')).rows[0]!.id, ADMIN);
  await db.pool.query("INSERT INTO tree_tools (root_task_id, dept_id, tool) VALUES ($1,'rnd','clickup_update_task')", [root.id]);
  return { root, kid: (await tasks.get(kid.id))! };
}

const auditCount = async (action: string) => (await db.pool.query("SELECT 1 FROM audit_log WHERE action = $1", [action])).rowCount;
const COMPANY_ROW: Record<State, boolean> = { live: false, paused: false, exhausted: false, past_deadline: false, closed_open_child: false, none: true };

describe('AC-C5 consistency matrix', () => {
  for (const state of STATES) {
    it(`state ${state}: only "none" is a company tree for every consumer`, async () => {
      const { root, kid } = await seed(state);
      const isCompany = COMPANY_ROW[state];
      const live = state === 'live';
      // decide: project rules run in "live", company rules in "none", a card everywhere else
      const d = await auto.decide({ taskId: kid.id, tool: 'web_search', input: { query: 'plain words' } });
      expect(d.kind, 'decide').toBe(isCompany || live ? 'run' : 'card');
      expect(await auditCount('approval.autopilot.company'), 'decide company audit').toBe(isCompany ? 1 : 0);
      expect(await auditCount('approval.autopilot.approve'), 'decide project audit').toBe(live ? 1 : 0);
      // the shared predicate behind the note, ask_requester and the estimate skip
      expect(await auto.inCompany(kid.id), 'inCompany').toBe(isCompany);
      // treeToolsFor and toolsForTask
      expect(await auto.treeToolsFor(kid.id, rnd), 'treeToolsFor').toEqual(isCompany ? ['clickup_update_task'] : []);
      expect(await auto.toolsForTask(kid.id, rnd), 'toolsForTask').toEqual(isCompany ? ['clickup_update_task'] : []);
      // the loop's note
      const s = await loopSetup({ script: [{ toolUses: [respond('ok')] }] });
      s.deps.tasks = tasks as never;
      s.deps.autopilot = { budgetHit: async () => undefined, projectOf: (id) => auto.projectOf(id), toolsFor: (p, a) => auto.toolsFor(p, a), decide: (r) => auto.decide(r), companyOn: () => auto.companyOn(), inCompany: (id) => auto.inCompany(id), treeToolsFor: (id, a) => auto.treeToolsFor(id, a) };
      await tasks.update(kid.id, { status: 'todo' }, 'doing');
      await runAgent({ route: loopRoute(rnd), task: (await tasks.get(kid.id))!, history: [] }, s.deps);
      const system = (s.provider as FakeProvider).calls[0]!.system;
      expect(system.includes(COMPANY_AUTOPILOT_NOTE), 'company note').toBe(isCompany);
      expect(system.includes('AUTOPILOT (code note, project #'), 'project note').toBe(live);
      await tasks.update(kid.id, { status: 'doing' }, 'todo');
      // ask_requester to a human, and the estimate card
      const human = await tasks.create({ title: 'asked', deptId: 'rnd', owner: rnd, requester: { kind: 'human', userId: '42' }, origin: 'delegated', parentId: root.id, status: 'doing' });
      const org = await seededOrg();
      const ctx = (task: Task): ToolContext => ({
        actor: rnd, task, ...runCtxBase(), org: org as never, tasks: tasks as never,
        approvals: { needsApproval: (e: number) => e > 1, request: vi.fn(async () => ({ id: 1 }) as never) }, limits: new Limits(cfg, tasks as never), bus: newBus(), notes: new MemNotes(), audit: auditSpy().audit,
        autopilot: { projectOf: (id) => auto.projectOf(id), decide: (r) => auto.decide(r), companyOn: () => auto.companyOn(), inCompany: (id) => auto.inCompany(id) },
        ask: { ask: vi.fn(async () => ({ ok: true as const, seq: 1, hours: 4 })), answer: vi.fn() } as never,
      });
      const ask = await askRequester.run({ question: 'which one?' }, ctx(human));
      expect(ask.content === ASK_REFUSALS.autopilotCompany, 'ask company text').toBe(isCompany);
      expect(ask.content === ASK_REFUSALS.autopilot, 'ask project text').toBe(live);
      const c = ctx(human);
      const made = await createTask.run(createTask.inputSchema.parse({ title: 't', description: 'd', assignee: hq, estCostUsd: 50 }), c);
      expect(made.isError, made.content).toBeFalsy();
      const child = (await db.pool.query<{ status: string }>("SELECT status FROM tasks WHERE parent_id = $1 AND title = 't'", [human.id])).rows[0]!;
      expect(child.status, 'estimate skip').toBe(isCompany || live ? 'todo' : 'awaiting_approval');
    });
  }

  it('company scope off (default project): "none" behaves like every other card state', async () => {
    cfg.values.set('autopilot.scope', 'project');
    const { kid } = await seed('none');
    expect((await auto.decide({ taskId: kid.id, tool: 'web_search', input: { query: 'plain words' } })).kind).toBe('card');
    expect(await auto.inCompany(kid.id)).toBe(false);
    expect(await auto.treeToolsFor(kid.id, rnd)).toEqual([]);
    expect(await auto.toolsForTask(kid.id, rnd)).toEqual([]);
  });
});

describe('AC-C5 grep: no company gate keys on projectOf being null', () => {
  const FILES = ['governance/autopilot.ts', 'tools/registry.ts', 'agents/loop/loop.ts', 'tools/builtin/askRequester.ts', 'tools/builtin/createTask.ts', 'tools/plugins/ws/index.ts', 'grow/tool-requests.ts', 'db/repos/projects.ts'];
  it('no line that mentions company negates or null-tests projectOf, and the loop and decide gates use companyRoot / inCompany', () => {
    for (const f of FILES) {
      const lines = readFileSync(join(HERE, '..', '..', f), 'utf8').split('\n');
      const bad = lines.filter((l) => /company/i.test(l) && (/!\s*\(?\s*(await\s+)?[\w.?]*projectOf\s*\(/.test(l) || /projectOf\s*\([^)]*\)\s*(===|==)\s*null/.test(l)));
      expect(bad, f).toEqual([]);
    }
    const decide = readFileSync(join(HERE, '..', '..', 'governance/autopilot.ts'), 'utf8');
    expect(decide).toContain('(await this.d.repo.companyRoot(r.taskId)) === null');
  });
  it('autopilotNote is not the company note (never mixed up)', () => {
    expect(autopilotNote({ id: 1, deadline: '2026-12-31' })).not.toBe(COMPANY_AUTOPILOT_NOTE);
  });
});
