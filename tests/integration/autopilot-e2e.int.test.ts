import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { autopilotNote } from '../../agents/context.js';
import { runAgent, type AgentDeps, type AgentOutcome, type AgentTrigger } from '../../agents/loop/loop.js';
import { respond, setup as loopSetup } from '../../agents/loop/loop-fixture.js';
import { Scheduler } from '../../agents/scheduler/scheduler.js';
import { MemNotes, auditSpy, newBus, noApprovedTools, prompts, runCtxBase } from '../../agents/test-helpers.js';
import { createCalendar, localDay } from '../../company/calendar.js';
import { Org, seed } from '../../company/index.js';
import type { ActorRef } from '../../company/types.js';
import type { Task } from '../../db/repos/tasks.js';
import { ChannelMapRepo, DepartmentRepo, PersonaRepo, ProjectRepo, TaskRepo } from '../../db/index.js';
import { migrate } from '../../db/migrate.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { CONFIG_CHANNEL_ID } from '../../discord/commands/types.js';
import { AutopilotService } from '../../governance/autopilot.js';
import { Limits } from '../../governance/limits.js';
import { ProjectService } from '../../governance/projects.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import type { FakeProvider } from '../../providers/index.js';
import { createHttpClient } from '../../services/http.js';
import { builtinTools, projectTools } from '../../tools/builtin/index.js';
import { createClickUpClient } from '../../tools/plugins/clickup/client.js';
import { clickupGroup } from '../../tools/plugins/clickup/index.js';
import type { PluginDeps } from '../../tools/plugins/deps.js';
import { fetchPageTool } from '../../tools/plugins/web/fetchPage.js';
import { webSearchTool } from '../../tools/plugins/web/webSearch.js';
import { ToolRegistry } from '../../tools/registry.js';
import { destructiveStub } from '../fakes/stub-tools.js';
import type { ToolContext } from '../../tools/types.js';
import { FakeDiscordPort } from '../fakes/discordPort.js';
import { workspaceFetch, ws } from '../fakes/clickup-workspace.js';
import { fakeResolver, fakeTransport } from '../fakes/net.js';

/**
 * AUTO-1 tester e2e (Stage 6). The closest available harness to createApp wiring (createApp needs Discord clients, Docker and a model):
 * real SQL, the real Scheduler on a shared bus with the real ProjectService, a real Org (Praw has no work channel), the real runAgent for the CEO,
 * and the real registry with fakes of the outside services. Nothing here is a stub of the code under test.
 */
const GUILD = '1565649426943442944';
const CHAT = '1570000000000000555'; // the channel a Bot Admin wrote to Praw in (Praw has no work channel)
const ADMIN = '123456789012345678';
const MON = Date.parse('2026-11-09T03:00:00Z');
const waiting = /^NOT DONE YET: waiting for approval/;
const hq: ActorRef = { kind: 'head', dept: 'hq' };
const praw: ActorRef = { kind: 'head', dept: 'praw' };
const rnd: ActorRef = { kind: 'head', dept: 'rnd' };
const cto: ActorRef = { kind: 'head', dept: 'software' };
const plusDays = (n: number): string => localDay(Date.now() + n * 86_400_000, 'Asia/Bangkok').date;

let db: TestDb;
let org: Org;
let tasks: TaskRepo;
let cfg: FakeConfig;

beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations'), 'up');
  const repos = { departments: new DepartmentRepo(db.pool), personas: new PersonaRepo(db.pool), channelMap: new ChannelMapRepo(db.pool) };
  await seed(repos, prompts);
  org = await Org.load(repos, prompts);
  tasks = new TaskRepo(db.pool);
});
afterAll(async () => db.close());
beforeEach(async () => {
  for (const t of ['project_tools', 'projects', 'task_grants', 'web_grants', 'ot_requests', 'approvals', 'audit_log', 'budget_days']) await db.pool.query(`DELETE FROM ${t}`);
  await db.pool.query('UPDATE tasks SET parent_id = NULL');
  await db.pool.query('DELETE FROM tasks');
  cfg = new FakeConfig({ 'schedule.offDays': [0, 6] });
});

class Port extends FakeDiscordPort {
  override snowflakes = true;
}

function registry(autopilot: boolean, halted: () => boolean, svc?: ProjectService): { reg: ToolRegistry; usage: { take: ReturnType<typeof vi.fn> } } {
  const reg = new ToolRegistry({ halt: { isHalted: halted }, autopilot });
  for (const t of builtinTools()) reg.register(t);
  if (svc) for (const t of projectTools({ projects: svc })) reg.register(t);
  reg.register(fetchPageTool({ resolver: fakeResolver({ 'invented.example': ['93.184.215.14'] }), transport: fakeTransport({ 'https://invented.example/page': { body: '<p>page</p>' } }), extraPorts: () => [] }));
  reg.register(webSearchTool({ search: async () => [{ title: 'Found', url: 'https://found.example/a', snippet: 'x' }] }));
  const usage = { take: vi.fn(async () => true) };
  const cu = createClickUpClient({ http: createHttpClient({ fetch: workspaceFetch(ws()) }), token: ws().token, teamId: '9001' });
  const cg = clickupGroup({ clickup: cu, clickupUsage: usage, cfg, log: { warn: vi.fn() }, clock: () => Date.parse('2026-11-08T05:00:00Z') } as unknown as PluginDeps);
  if ('disabled' in cg) throw new Error(cg.disabled);
  for (const t of cg.tools) reg.register(t);
  reg.register(destructiveStub());
  return { reg, usage };
}

async function world(o: { now?: number } = {}) {
  const halted = { v: false };
  const port = new Port();
  const bus = newBus();
  const limits = new Limits(cfg, tasks);
  const log = { error: vi.fn((..._a: unknown[]) => undefined), warn: vi.fn((..._a: unknown[]) => undefined) };
  const incidents = { report: vi.fn(() => '') };
  const repo = new ProjectRepo(db.pool, { cfg, halt: { isHalted: () => halted.v }, now: () => Date.now() });
  let cardSeq = 0;
  const svc = new ProjectService({
    repo, cfg, tasks, bus, halted: () => halted.v, secrets: [], configChannelId: CONFIG_CHANNEL_ID, now: () => Date.now(),
    postCard: async () => `8000000000000${String(10000 + ++cardSeq)}`, closeCard: async () => undefined, notifyHead: async () => undefined, log: { error: () => undefined },
  });
  const { reg, usage } = registry(true, () => halted.v, svc);
  const auto = new AutopilotService({ cfg, halted: () => halted.v, repo, org, describe: (n) => reg.describe(n), secrets: [], exhausted: (id) => svc.exhausted(id), log: { error: () => undefined } });
  const autoPort = { projectOf: (id: string) => auto.projectOf(id), toolsFor: (pid: number, a: ActorRef) => auto.toolsFor(pid, a), budgetHit: (t: Task) => svc.budgetHit(t), decide: (r: Parameters<AutopilotService['decide']>[0]) => auto.decide(r) };

  // the CEO run is the REAL loop over a scripted model; Praw's run is recorded (the Gemini provider is not available in tests)
  const s = await loopSetup({ script: [{ toolUses: [respond('planned')] }] });
  s.deps.tasks = tasks as never;
  s.deps.autopilot = autoPort;
  const runs: { actor: ActorRef; reason: string; taskId: string | undefined }[] = [];
  const run = vi.fn(async (t: AgentTrigger, _d: AgentDeps): Promise<AgentOutcome> => {
    runs.push({ actor: t.route.actor, reason: t.route.reason, taskId: t.route.taskId });
    if (t.route.actor.kind === 'head' && t.route.actor.dept === 'praw') return { payload: { type: 'chat', body: 'praw ran' }, costUsd: 0, turns: 1 };
    return runAgent(t, s.deps);
  });
  const sch = new Scheduler({
    agent: { limits, botRoots: { acquire: async () => () => undefined } } as unknown as AgentDeps,
    approvedTools: noApprovedTools, run, port, org, tasks, limits, halt: { isHalted: () => halted.v }, cfg, bus, log, incidents, now: () => o.now ?? MON,
    calendar: createCalendar(cfg), guildId: GUILD,
  } as never);
  sch.attach();
  return { halted, port, bus, repo, svc, reg, usage, auto, autoPort, s, runs, run, sch, incidents, log };
}
type W = Awaited<ReturnType<typeof world>>;

async function approve(w: W) {
  const r = await w.svc.start({ userId: ADMIN, title: 'Coffee shop launch', goal: 'Open the shop', deadline: plusDays(30), usd: 5, calls: 100 });
  if (!r.ok) throw new Error(`start ${r.code}`);
  const p = (await w.repo.get(r.id))!;
  const d = await w.svc.decideCard({ token: p.token, action: 'approve', userId: ADMIN, channelId: p.channelId, messageId: p.messageId });
  if (!d.ok || d.result !== 'approved') throw new Error('approve failed');
  await w.sch.idle();
  return { project: (await w.repo.get(r.id))!, root: d.root };
}

async function ctx(w: W, a: { actor: ActorRef; task: Task | null; tainted?: boolean; admin?: boolean; channelId?: string; port?: boolean }) {
  const base = runCtxBase();
  if (a.tainted) base.run.markTainted();
  const audits = auditSpy();
  const approvals = { needsApproval: () => false, request: vi.fn(async () => ({ id: 5 }) as never) };
  const c: ToolContext = {
    actor: a.actor, task: a.task, ...base, source: { ...base.source, userId: ADMIN, channelId: a.channelId ?? '' }, org: Object.assign(Object.create(org) as object, { toolsFor: () => w.reg.names() }) as never,
    tasks, approvals, limits: new Limits(cfg, tasks), bus: w.bus, notes: new MemNotes(), audit: audits.audit,
    ...(a.port === false ? {} : { autopilot: { projectOf: w.autoPort.projectOf, decide: w.autoPort.decide } }), ...(a.admin ? { personAdmin: true } : {}),
  } as unknown as ToolContext;
  return { c, approvals, audits };
}
const approveRows = async () => (await db.pool.query<{ tool: string }>("SELECT tool FROM audit_log WHERE action = 'approval.autopilot.approve' ORDER BY id")).rows.map((r) => r.tool);

describe('AUTO-1 e2e (1): approval click -> root -> CEO run with the note -> Praw project_task child runs', () => {
  it('the click creates the root and starts the CEO owner run, whose system prompt carries the autopilot note; a Praw project_task child then starts its own owner run in the chat channel', async () => {
    const w = await world();
    const { project, root } = await approve(w);
    // the root: a delegated hq task under the project, started by the click alone (no extra trigger)
    expect(root).toMatchObject({ owner: hq, origin: 'delegated' });
    expect(w.runs.filter((r) => r.reason === 'task_owner' && r.taskId === root.id)).toHaveLength(1);
    const system = (w.s.provider as FakeProvider).calls[0]!.system;
    expect(system).toContain(autopilotNote({ id: project.id, deadline: project.deadline }));
    expect(system).toContain('AUTOPILOT (code note');

    // Praw (no work channel) opens a task from the Bot Admin's chat
    expect(org.dept('praw')?.workChannelId ?? null).toBeNull();
    const chat = await ctx(w, { actor: praw, task: null, admin: true, channelId: CHAT });
    const opened = await w.reg.run('project_task', { projectId: project.id, title: 'Order the coffee machine list', instruction: 'Create the ClickUp task for the machine list' }, chat.c);
    expect(opened.isError, opened.content).toBeFalsy();
    await w.sch.idle();
    const kid = (await db.pool.query<{ id: string }>('SELECT id FROM tasks WHERE parent_id = $1', [root.id])).rows.map((r) => r.id);
    expect(kid).toHaveLength(1);
    const made = (await tasks.get(kid[0]!))!;
    expect(made).toMatchObject({ owner: praw, rootId: root.id, tainted: false });
    expect(made.channelId).toBe(CHAT);
    // the scheduler opened a thread in the CHAT channel (not a work channel) and ran Praw as the task owner
    expect(w.port.threads.some((t) => t.dept === 'praw' && t.channelId === CHAT)).toBe(true);
    expect(w.runs.filter((r) => r.reason === 'task_owner' && r.taskId === made.id && r.actor.kind === 'head' && r.actor.dept === 'praw')).toHaveLength(1);
    expect(w.incidents.report).not.toHaveBeenCalled();
    // the child's own ClickUp create inside the task: no card
    await tasks.update(made.id, { status: 'doing' }, (await tasks.get(made.id))!.status);
    const t = await ctx(w, { actor: praw, task: (await tasks.get(made.id))! });
    const r = await w.reg.run('clickup_create_task', { list_id: '7001', name: 'Machine list', description: 'espresso machine' }, t.c);
    expect(r.isError, r.content).toBeFalsy();
    expect(t.approvals.request).not.toHaveBeenCalled();
  });

  it('control: from a chat with no channel id the Praw task gets no thread and no owner run (so the channelId assertion above is what makes it start)', async () => {
    const w = await world();
    const { project, root } = await approve(w);
    const chat = await ctx(w, { actor: praw, task: null, admin: true, channelId: '' });
    const opened = await w.reg.run('project_task', { projectId: project.id, title: 'No channel', instruction: 'y' }, chat.c);
    expect(opened.isError, opened.content).toBeFalsy();
    await w.sch.idle().catch(() => undefined);
    const kid = (await db.pool.query<{ id: string }>('SELECT id FROM tasks WHERE parent_id = $1', [root.id])).rows[0]!;
    expect((await tasks.get(kid.id))!.channelId).toBeNull();
    expect(w.runs.some((r) => r.taskId === kid.id)).toBe(false);
  });

  it('a second approve click on the same card starts no second CEO run (one root, one owner run)', async () => {
    const w = await world();
    const { project, root } = await approve(w);
    const p = (await w.repo.get(project.id))!;
    const again = await w.svc.decideCard({ token: p.token, action: 'approve', userId: ADMIN, channelId: p.channelId, messageId: p.messageId });
    expect(again).toMatchObject({ ok: false, code: 'not_pending' });
    await w.sch.idle();
    expect(w.runs.filter((r) => r.taskId === root.id)).toHaveLength(1);
  });
});

describe('AUTO-1 e2e (2): a hard-deny call inside a project makes exactly one card', () => {
  it.each([
    ['github_create_branch', { owner: 'acme', repo: 'widgets', name: 'x' }],
  ])('%s in an active project, untainted and tainted: one approval request per call, no autopilot approval row', async (name, input) => {
    const w = await world();
    const { root } = await approve(w);
    const task = await tasks.create({ title: 'work', deptId: 'software', owner: cto, requester: hq, origin: 'delegated', parentId: root.id, status: 'doing' });
    for (const tainted of [false, true]) {
      const t = await ctx(w, { actor: cto, task, tainted });
      const res = await w.reg.run(name, input, t.c);
      expect(res.content).toMatch(waiting);
      expect(t.approvals.request).toHaveBeenCalledTimes(1);
    }
    expect(await approveRows()).toEqual([]);
  });

  it('with the real ApprovalService-shaped spy: the card carries the tool name and the budget is untouched (no approvals_used spent)', async () => {
    const w = await world();
    const { project, root } = await approve(w);
    const task = await tasks.create({ title: 'work', deptId: 'software', owner: cto, requester: hq, origin: 'delegated', parentId: root.id, status: 'doing' });
    const t = await ctx(w, { actor: cto, task });
    await w.reg.run('github_create_branch', { owner: 'acme', repo: 'widgets', name: 'x' }, t.c);
    expect(t.approvals.request).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(t.approvals.request.mock.calls[0])).toContain('github_create_branch');
    expect((await w.repo.get(project.id))!.approvalsUsed).toBe(0);
  });
});

describe('AUTO-1 e2e (3): switch off = today\'s behaviour exactly', () => {
  const CALLS: [string, unknown, boolean][] = [
    ['fetch_page', { url: 'https://invented.example/page' }, true],
    ['web_search', { query: 'espresso machines' }, true],
    ['clickup_create_task', { list_id: '7001', name: 'Machine list' }, true],
    ['clickup_add_comment', { task_id: 'a1', text: 'hello' }, false],
    ['github_create_branch', { owner: 'acme', repo: 'widgets', name: 'x' }, false],
  ];

  it('with autopilot.enabled=false each call gives the same result and the same approval request as a registry and context that never had the autopilot code', async () => {
    const w = await world();
    const { root } = await approve(w);
    const task = await tasks.create({ title: 'work', deptId: 'rnd', owner: rnd, requester: hq, origin: 'delegated', parentId: root.id, status: 'doing' });
    const live = await ctx(w, { actor: rnd, task, tainted: true });
    expect((await w.reg.run('fetch_page', { url: 'https://invented.example/page' }, live.c)).content).not.toMatch(waiting); // control: switch ON runs it
    expect(await approveRows()).toEqual(['fetch_page']);
    await db.pool.query('DELETE FROM audit_log');
    await db.pool.query('UPDATE projects SET approvals_used = 0');
    cfg.values.set('autopilot.enabled', false);
    const base = registry(false, () => false); // today's registry: no autopilot flag
    const strip = (v: unknown) => JSON.stringify(v).replace(/"id":\d+/g, '');
    for (const [name, input] of CALLS) {
      const on = await ctx(w, { actor: rnd, task, tainted: true }); // wired exactly as production, switch off
      const off = await ctx(w, { actor: rnd, task, tainted: true, port: false }); // today's context: no port
      const a = await w.reg.run(name, input, on.c);
      const b = await base.reg.run(name, input, off.c);
      expect(a.content, name).toBe(b.content);
      expect(!!a.isError, name).toBe(!!b.isError);
      expect(strip(on.approvals.request.mock.calls), name).toBe(strip(off.approvals.request.mock.calls));
      expect(on.approvals.request.mock.calls.length, name).toBe(off.approvals.request.mock.calls.length);
    }
    expect(await approveRows()).toEqual([]);
    expect((await w.repo.get((await db.pool.query<{ id: number }>('SELECT id FROM projects')).rows[0]!.id))!.approvalsUsed).toBe(0);
  });

  it('with the switch off: no autopilot note, no project tools, project_task refused, and no new waits (a CEO run on the root is the plain run)', async () => {
    const w = await world();
    const { project, root } = await approve(w);
    cfg.values.set('autopilot.enabled', false);
    expect(await w.autoPort.projectOf(root.id)).toBeNull();
    expect(await w.autoPort.toolsFor(project.id, hq)).toEqual([]);
    const chat = await ctx(w, { actor: praw, task: null, admin: true, channelId: CHAT });
    const res = await w.reg.run('project_task', { projectId: project.id, title: 'x', instruction: 'y' }, chat.c);
    expect(res.content).toBe('Autopilot is switched off; project tasks cannot be opened.');
    expect((await db.pool.query('SELECT 1 FROM tasks WHERE parent_id = $1', [root.id])).rowCount).toBe(0);
    // a fresh run of the root: no note in the prompt
    const s2 = await loopSetup({ script: [{ toolUses: [respond('plain')] }] });
    s2.deps.tasks = tasks as never;
    s2.deps.autopilot = w.autoPort;
    await db.pool.query("UPDATE tasks SET status = 'todo' WHERE id = $1", [root.id]);
    await runAgent({ route: { actor: hq, reason: 'task_owner', taskId: root.id } as never, task: (await tasks.get(root.id))!, history: [] }, s2.deps);
    expect((s2.provider as FakeProvider).calls[0]!.system).not.toContain('AUTOPILOT (code note');
  });
});
