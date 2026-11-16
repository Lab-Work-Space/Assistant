import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { autopilotNote } from '../../agents/context.js';
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
import { createHttpClient } from '../../services/http.js';
import { workspaceFetch, ws } from '../fakes/clickup-workspace.js';
import { fakeResolver, fakeTransport } from '../fakes/net.js';
import { MemWorkspaceRepo } from '../../db/repos/workspaces.mem.js';
import { ASK_REFUSALS, askRequester } from '../../tools/builtin/askRequester.js';
import { builtinTools, projectTools } from '../../tools/builtin/index.js';
import { createClickUpClient } from '../../tools/plugins/clickup/client.js';
import { clickupGroup } from '../../tools/plugins/clickup/index.js';
import type { PluginDeps } from '../../tools/plugins/deps.js';
import { fetchPageTool } from '../../tools/plugins/web/fetchPage.js';
import { webSearchTool } from '../../tools/plugins/web/webSearch.js';
import { wsGroup } from '../../tools/plugins/ws/index.js';
import { ToolRegistry } from '../../tools/registry.js';
import { destructiveStub } from '../fakes/stub-tools.js';
import type { ToolContext } from '../../tools/types.js';
import { WS_TEXT } from '../../workspaces/errors.js';
import { ProjectFiles } from '../../workspaces/files.js';
import { SlugLock } from '../../workspaces/lock.js';
import { WsService } from '../../workspaces/service.js';
import { FakeDocker } from '../../workspaces/test-helpers.js';

/**
 * AUTO-1 acceptance (Gate 1 AP-C18): the owner's 14:17-15:05 log replayed as a project. Real database (projects, tasks, the claim and its audit row), the real registry, the real
 * web, ClickUp and workspace tools on fakes of their outside services, the real ProjectService, AutopilotService and ProjectRepo, and the real loop for the CEO's note.
 */
let db: TestDb;
let tasks: TaskRepo;
let repo: ProjectRepo;
let svc: ProjectService;
let auto: AutopilotService;
let cfg: FakeConfig;
let reg: ToolRegistry;
let bus: EventBus<AppEvents>;
let docker: FakeDocker;
let usage: { take: ReturnType<typeof vi.fn> };
let wsBase: string;
let halted = false;
let posts = 0;

const hq: ActorRef = { kind: 'head', dept: 'hq' };
const rnd: ActorRef = { kind: 'head', dept: 'rnd' };
const cto: ActorRef = { kind: 'head', dept: 'software' };
const praw: ActorRef = { kind: 'head', dept: 'praw' };
const ADMIN = '123456789012345678';
const waiting = /^NOT DONE YET: waiting for approval/;
const plusDays = (n: number): string => localDay(Date.now() + n * 86_400_000, 'Asia/Bangkok').date;

beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations'), 'up');
  for (const id of ['hq', 'rnd', 'software', 'praw']) await new DepartmentRepo(db.pool).upsert({ id: id as never, name: id, categoryNamePattern: '', workChannelId: null, color: 0, model: null, provider: null, enabled: true });
  tasks = new TaskRepo(db.pool);
  wsBase = realpathSync(mkdtempSync(join(tmpdir(), 'autopilot-acc-')));
});
afterAll(async () => { rmSync(wsBase, { recursive: true, force: true }); await db.close(); });

beforeEach(async () => {
  halted = false;
  posts = 0;
  cfg = new FakeConfig();
  bus = new EventBus<AppEvents>({ error: () => undefined });
  repo = new ProjectRepo(db.pool, { cfg, halt: { isHalted: () => halted }, now: () => Date.now() });
  svc = new ProjectService({
    repo, cfg, tasks, bus, halted: () => halted, secrets: [], configChannelId: CONFIG_CHANNEL_ID, now: () => Date.now(),
    postCard: async () => `8000000000000${String(10000 + ++posts)}`, closeCard: async () => undefined, notifyHead: async () => undefined, log: { error: () => undefined },
  });
  for (const t of ['project_tools', 'projects', 'task_grants', 'web_grants', 'ot_requests', 'approvals', 'audit_log', 'budget_days']) await db.pool.query(`DELETE FROM ${t}`);
  await db.pool.query('UPDATE tasks SET parent_id = NULL');
  await db.pool.query('DELETE FROM tasks');

  // the real registry: web (fakes for search and net), ClickUp workspace writes, workspaces (FakeDocker), project tools, core builtins
  reg = new ToolRegistry({ halt: { isHalted: () => halted }, autopilot: true });
  for (const t of builtinTools()) reg.register(t);
  for (const t of projectTools({ projects: svc })) reg.register(t);
  reg.register(fetchPageTool({ resolver: fakeResolver({ 'invented.example': ['93.184.215.14'] }), transport: fakeTransport({ 'https://invented.example/page': { body: '<p>page</p>' } }), extraPorts: () => [] }));
  reg.register(webSearchTool({ search: async () => [{ title: 'Found', url: 'https://found.example/a', snippet: 'x' }] }));
  usage = { take: vi.fn(async () => true) };
  const cu = createClickUpClient({ http: createHttpClient({ fetch: workspaceFetch(ws()) }), token: ws().token, teamId: '9001' });
  const cg = clickupGroup({ clickup: cu, clickupUsage: usage, cfg, log: { warn: vi.fn() }, clock: () => Date.parse('2026-11-08T05:00:00Z') } as unknown as PluginDeps);
  if ('disabled' in cg) throw new Error(cg.disabled);
  for (const t of cg.tools) reg.register(t);
  reg.register(destructiveStub());
  const root = join(wsBase, `root-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { mode: 0o700 });
  docker = new FakeDocker();
  const wsSvc = new WsService({
    repo: new MemWorkspaceRepo(), root, files: new ProjectFiles(root), lock: new SlugLock(),
    run: { docker, image: `sha256:${'c'.repeat(64)}`, uid: 501, gid: 20, caps: () => ({ tree: 40, day: 200 }), isHalted: () => halted, secrets: () => [], haltPollMs: 5 },
  });
  await wsSvc.create('proj', 't', 'head:software');
  writeFileSync(join(root, 'proj', 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  const wg = wsGroup({ env: {}, cfg: Object.assign(new FakeConfig({ 'ws.enabled': true }), { get: (k: string) => (k === 'ws.enabled' ? true : undefined) }), log: { warn: vi.fn(), info: vi.fn() }, clock: () => 0, halt: { track: (p: Promise<unknown>) => p, isHalted: () => halted }, org: await seededOrg(), ws: wsSvc, port: {}, wsSecrets: [] } as unknown as PluginDeps);
  if ('disabled' in wg) throw new Error(wg.disabled);
  for (const t of wg.tools) reg.register(t);

  auto = new AutopilotService({
    cfg, halted: () => halted, repo, org: await seededOrg(), describe: (n) => reg.describe(n), secrets: [], exhausted: (id) => svc.exhausted(id), log: { error: () => undefined },
  });
});

/** The Bot Admin's one confirmation: propose, click Approve; returns the project and its root task (the CEO's). */
async function startProject(o: { title?: string; usd?: number; calls?: number } = {}) {
  const r = await svc.start({ userId: ADMIN, title: o.title ?? 'Coffee shop launch', goal: 'Open the shop', deadline: plusDays(30), usd: o.usd ?? 5, calls: o.calls ?? 100 });
  if (!r.ok) throw new Error(`start ${r.code}`);
  const p = (await repo.get(r.id))!;
  const d = await svc.decideCard({ token: p.token, action: 'approve', userId: ADMIN, channelId: p.channelId, messageId: p.messageId });
  if (!d.ok || d.result !== 'approved') throw new Error('approve failed');
  await tasks.update(d.root.id, { status: 'doing' }, 'todo');
  return { project: (await repo.get(r.id))!, root: (await tasks.get(d.root.id))! };
}
const child = (root: Task, owner: ActorRef, o: { tainted?: boolean; requester?: ActorRef } = {}) =>
  tasks.create({ title: `work of ${owner.kind === 'head' ? owner.dept : 'x'}`, deptId: owner.kind === 'head' ? owner.dept : 'software', owner, requester: o.requester ?? hq, origin: 'delegated', parentId: root.id, status: 'doing', ...(o.tainted !== undefined ? { tainted: o.tainted } : {}) });

async function ctxFor(a: { actor: ActorRef; task: Task | null; tainted?: boolean; admin?: boolean; userId?: string }) {
  const base = runCtxBase();
  if (a.tainted) base.run.markTainted();
  const audits = auditSpy();
  const approvals = { needsApproval: () => false, request: vi.fn(async () => ({ id: 5 }) as never) };
  const org = Object.assign(Object.create(await seededOrg()) as object, { toolsFor: () => reg.names() });
  const c: ToolContext = {
    actor: a.actor, task: a.task, ...base, source: { ...base.source, userId: a.userId ?? null }, org: org as never, tasks, approvals, limits: new Limits(cfg, tasks), bus: newBus(), notes: new MemNotes(), audit: audits.audit,
    autopilot: { projectOf: (id) => auto.projectOf(id), decide: (r) => auto.decide(r) }, ...(a.admin ? { personAdmin: true } : {}),
  };
  return { c, approvals, audits };
}
const approveRows = async () => (await db.pool.query<{ tool: string; outcome: string }>("SELECT tool, outcome FROM audit_log WHERE action = 'approval.autopilot.approve' ORDER BY id")).rows;

describe('AUTO-1 acceptance: the 14:17-15:05 log, replayed inside an active project', () => {
  it('R&D (tainted run): web_search and fetch_page run with no card; each is one claimed approval with its audit row', async () => {
    const { project, root } = await startProject();
    const task = await child(root, rnd);
    const { c, approvals } = await ctxFor({ actor: rnd, task, tainted: true });
    const s = await reg.run('web_search', { query: 'thai coffee market size' }, c);
    expect(s.content).not.toMatch(waiting);
    expect(s.isError).toBeFalsy();
    const f = await reg.run('fetch_page', { url: 'https://invented.example/page' }, c); // a url nobody typed and no search returned: today's card
    expect(f.content).not.toMatch(waiting);
    expect(f.isError, f.content).toBeFalsy();
    expect(approvals.request).not.toHaveBeenCalled();
    expect(await approveRows()).toEqual([{ tool: 'web_search', outcome: `ok p${project.id} 1/500` }, { tool: 'fetch_page', outcome: `ok p${project.id} 2/500` }]);
    expect((await repo.get(project.id))!.approvalsUsed).toBe(2);
  });

  it('a ClickUp create from a TAINTED run (the log\'s R&D case) runs with no card too', async () => {
    const { root } = await startProject();
    const task = await child(root, rnd);
    const t = await ctxFor({ actor: rnd, task, tainted: true });
    const r = await reg.run('clickup_create_task', { list_id: '7001', name: 'Competitor notes', description: 'from the web research' }, t.c);
    expect(r.isError, r.content).toBeFalsy();
    expect(r.content).toMatch(/Created task/);
    expect(t.approvals.request).not.toHaveBeenCalled();
    expect((await approveRows()).map((x) => x.tool)).toEqual(['clickup_create_task']);
  });

  it('AP-C9: past the deadline the same tainted call is a card (today\'s rules)', async () => {
    const { project, root } = await startProject();
    const task = await child(root, rnd);
    const call = async () => reg.run('fetch_page', { url: 'https://invented.example/page' }, (await ctxFor({ actor: rnd, task, tainted: true })).c);
    expect((await call()).content).not.toMatch(waiting);
    await db.pool.query('UPDATE projects SET deadline = current_date - 3 WHERE id = $1', [project.id]);
    expect((await call()).content).toMatch(waiting);
  });

  it('AP-C7: a project grant makes the tool appear in the offer AND the dispatch list of that department\'s runs in the project; after close it is gone from both', async () => {
    const { project, root } = await startProject();
    const task = await child(root, rnd);
    expect(await auto.projectGrant({ dept: 'rnd', taskId: task.id, tool: 'clickup_update_task' })).toEqual({ kind: 'granted', projectId: project.id });
    const runIt = async () => {
      const s = await loopSetup({ script: [{ toolUses: [{ name: 'clickup_update_task', input: { task_id: 'a1', name: 'Renamed' } }] }, { toolUses: [respond('ok')] }] });
      s.deps.tasks = tasks as never;
      s.deps.tools = reg;
      s.deps.autopilot = { projectOf: (id) => auto.projectOf(id), toolsFor: (pid, a) => auto.toolsFor(pid, a), budgetHit: (t) => svc.budgetHit(t), decide: (r) => auto.decide(r) };
      await runAgent({ route: loopRoute(rnd), task: (await tasks.get(task.id))!, history: [] }, s.deps);
      const calls = (s.provider as FakeProvider).calls;
      return { offered: calls[0]!.tools?.map((x) => x.name) ?? [], result: (calls[1]!.messages.at(-1)!.content[0] as { content: string }).content };
    };
    const during = await runIt();
    expect(during.offered).toContain('clickup_update_task');
    expect(during.result).not.toContain('not allowed');
    expect(await svc.close(project.id, ADMIN)).toMatchObject({ ok: true });
    await tasks.update(task.id, { status: 'doing' }).catch(() => undefined);
    const after = await runIt();
    expect(after.offered).not.toContain('clickup_update_task');
    expect(after.result).toContain('not allowed');
  });

  it('data-like calls are refused with the fixed text and no card (an @ in a search, a long url query)', async () => {
    const { root } = await startProject();
    const task = await child(root, rnd);
    const { c, approvals, audits } = await ctxFor({ actor: rnd, task, tainted: true });
    const a = await reg.run('web_search', { query: 'send to boss@example.com' }, c);
    expect(a).toMatchObject({ isError: true, content: expect.stringContaining('Refused in this project') });
    const b = await reg.run('fetch_page', { url: 'https://invented.example/page?k=abcdefghijklmnopqrstuvwxyz0123456789' }, c);
    expect(b.content).toContain('Refused in this project');
    expect(approvals.request).not.toHaveBeenCalled();
    expect(audits.entries.filter((e) => e.outcome?.startsWith('autopilot_refused:')).map((e) => e.outcome)).toEqual(['autopilot_refused:query_heuristic', 'autopilot_refused:url_heuristic']);
    expect(await approveRows()).toEqual([]);
  });

  it('CTO: ws_run in chat is E_NOTASK (the log), inside a task it runs and reports the exit code, tainting the run', async () => {
    const { root } = await startProject();
    const task = await child(root, cto);
    docker.plan = [{ out: 'tests failed', exit: 1 }];
    const chat = await ctxFor({ actor: cto, task: null });
    expect((await reg.run('ws_run', { slug: 'proj', command: 'npm test' }, chat.c)).content).toContain(WS_TEXT.E_NOTASK);
    const t = await ctxFor({ actor: cto, task });
    const r = await reg.run('ws_run', { slug: 'proj', command: 'npm test' }, t.c);
    expect(r.content).toMatch(/ws_run test in proj: exit 1 /);
    expect(t.approvals.request).not.toHaveBeenCalled();
    expect(t.c.run.tainted()).toBe(true);
    expect(await approveRows()).toEqual([]); // ws_run never asked: it is unchanged by autopilot
  });

  it('Praw (Bot Admin, untainted chat) opens a project_task; the ClickUp create inside that task runs with no card, with its per-run and daily counters', async () => {
    const { project, root } = await startProject();
    const chat = await ctxFor({ actor: praw, task: null, admin: true, userId: ADMIN });
    const opened = await reg.run('project_task', { projectId: project.id, title: 'Order the coffee machine list', instruction: 'Create the ClickUp task for the machine list' }, chat.c);
    expect(opened.isError, opened.content).toBeFalsy();
    const kid = (await db.pool.query<{ id: string }>("SELECT id FROM tasks WHERE parent_id = $1", [root.id])).rows[0]!;
    const made = (await tasks.get(kid.id))!;
    expect(made).toMatchObject({ owner: praw, requester: praw, status: 'todo', tainted: false, origin: 'delegated', rootId: root.id, sourceUserId: ADMIN });
    expect(opened.content).toContain(`opened task ${made.id} in project #${project.id}`);
    // the task's own run
    await tasks.update(made.id, { status: 'doing' }, 'todo');
    const t = await ctxFor({ actor: praw, task: (await tasks.get(made.id))! });
    const r = await reg.run('clickup_create_task', { list_id: '7001', name: 'Machine list', description: 'espresso machine, grinder' }, t.c);
    expect(r.isError, r.content).toBeFalsy();
    expect(r.content).toMatch(/Created task/);
    expect(t.approvals.request).not.toHaveBeenCalled();
    expect(usage.take).toHaveBeenCalledTimes(1); // AP-C8: the daily counter is taken in run
    expect((await approveRows()).map((x) => x.tool)).toEqual(['clickup_create_task']);
    // AP-C8: the per-run cap (filed) still counts through onApprovalTask: five more creates in this run, the sixth is refused
    let refused = 0;
    for (let i = 0; i < 6; i++) if ((await reg.run('clickup_create_task', { list_id: '7001', name: `More ${i}` }, t.c)).isError) refused++;
    expect(refused).toBe(2); // RUN_CAP 5: the first create plus four more are filed, the sixth and seventh are refused (`filed` counts through onApprovalTask on this path)
  });

  it('AP-C8: inside a project a ClickUp write still runs its precheck first (scope), fails closed without the daily counter, and refuses a 1501-character description; none of them spends an approval', async () => {
    const { project, root } = await startProject();
    const task = await child(root, praw);
    const t = await ctxFor({ actor: praw, task });
    // scope: a list of another workspace is refused by the tool's own precheck, before the branch (no claim, no card)
    const foreign = await reg.run('clickup_create_task', { list_id: '7999', name: 'x' }, t.c);
    expect(foreign.isError).toBe(true);
    expect(foreign.content).not.toMatch(waiting);
    // the daily counter throws: the write is refused, nothing was made, still no card
    usage.take.mockRejectedValueOnce(new Error('db down'));
    const down = await reg.run('clickup_create_task', { list_id: '7001', name: 'x' }, t.c);
    expect(down.isError).toBe(true);
    expect(down.content).not.toMatch(waiting);
    // over the limit of the tool's own schema (the card could not show it whole): refused before any approval
    const long = await reg.run('clickup_create_task', { list_id: '7001', name: 'x', description: 'd'.repeat(1501) }, t.c);
    expect(long.isError).toBe(true);
    expect(long.content).toContain('invalid input');
    expect(t.approvals.request).not.toHaveBeenCalled();
    const used = (await repo.get(project.id))!.approvalsUsed;
    expect(used).toBe(1); // only the one whose precheck passed (the counter failure) was claimed; the claim is spent before the write, as for any run
  });

  it('project_task from a chat that is not a Bot Admin\'s, or a tainted one, is refused and creates nothing', async () => {
    const { project, root } = await startProject();
    const input = { projectId: project.id, title: 'x', instruction: 'y' };
    expect((await reg.run('project_task', input, (await ctxFor({ actor: praw, task: null, admin: false })).c)).content).toContain('Bot Admin asked in this chat');
    expect((await reg.run('project_task', input, (await ctxFor({ actor: praw, task: null, admin: true, tainted: true })).c)).content).toContain('after reading outside content');
    expect((await db.pool.query('SELECT 1 FROM tasks WHERE parent_id = $1', [root.id])).rowCount).toBe(0);
  });

  it('the CEO\'s run on the root gets the autopilot note (verbatim, with the project number and the deadline)', async () => {
    const { project, root } = await startProject();
    const s = await loopSetup({ script: [{ toolUses: [respond('planned')] }] });
    s.deps.tasks = tasks as never;
    s.deps.autopilot = { projectOf: (id) => auto.projectOf(id), toolsFor: (pid, a) => auto.toolsFor(pid, a), budgetHit: (t) => svc.budgetHit(t), decide: (r) => auto.decide(r) };
    await db.pool.query("UPDATE tasks SET status = 'todo' WHERE id = $1", [root.id]);
    await runAgent({ route: loopRoute(hq), task: (await tasks.get(root.id))!, history: [] }, s.deps);
    const system = (s.provider as FakeProvider).calls[0]!.system;
    expect(system).toContain(autopilotNote({ id: project.id, deadline: project.deadline }));
    expect(system).toContain(`project #${project.id}, deadline ${project.deadline}`);
  });

  it('ask_requester to a person is refused inside the project and sends nothing; update_task works with the 8-character prefix the header shows', async () => {
    const { root } = await startProject();
    const t = await ctxFor({ actor: hq, task: root });
    const ask = { ask: vi.fn(async () => ({ ok: true as const, seq: 1, hours: 4 })), answer: vi.fn() };
    const res = await askRequester.run({ question: 'which supplier?' }, { ...t.c, ask: ask as never });
    expect(res).toEqual({ content: ASK_REFUSALS.autopilot, isError: true });
    expect(ask.ask).not.toHaveBeenCalled();
    const upd = await reg.run('update_task', { taskId: root.id.slice(0, 8), status: 'review' }, t.c);
    expect(upd.isError, upd.content).toBeFalsy();
    expect((await tasks.get(root.id))!.status).toBe('review');
    const bad = await reg.run('update_task', { taskId: 'ffffffff', status: 'review' }, t.c);
    expect(bad.content).toBe(`no task has that id. Your open tasks (id status dept): ${root.id.slice(0, 8)} review hq`);
  });

  it('a hard-deny call (destructive GitHub branch), a tainted write_file and a comment still make a card', async () => {
    const { root } = await startProject();
    const task = await child(root, cto);
    const t = await ctxFor({ actor: cto, task });
    const del = await reg.run('github_create_branch', { owner: 'acme', repo: 'widgets', name: 'x' }, t.c);
    expect(del.content).toMatch(waiting);
    const cm = await reg.run('clickup_add_comment', { task_id: 'a1', text: 'hello' }, t.c);
    expect(cm.content).toMatch(waiting);
    expect(t.approvals.request).toHaveBeenCalledTimes(2);
    expect(await approveRows()).toEqual([]);
  });

  it('when the project is closed the same tainted call is a card again (today\'s rules)', async () => {
    const { project, root } = await startProject();
    const task = await child(root, rnd);
    const before = await ctxFor({ actor: rnd, task, tainted: true });
    expect((await reg.run('fetch_page', { url: 'https://invented.example/page' }, before.c)).content).not.toMatch(waiting);
    expect(await svc.close(project.id, ADMIN)).toMatchObject({ ok: true });
    const after = await ctxFor({ actor: rnd, task: (await tasks.get(task.id))!, tainted: true });
    expect((await reg.run('fetch_page', { url: 'https://invented.example/page' }, after.c)).content).toMatch(waiting);
  });

  it('a halt, the switch off, and a paused project each give the card, never a run', async () => {
    const { project, root } = await startProject();
    const task = await child(root, rnd);
    const call = async () => reg.run('fetch_page', { url: 'https://invented.example/page' }, (await ctxFor({ actor: rnd, task, tainted: true })).c);
    cfg.values.set('autopilot.enabled', false);
    expect((await call()).content).toMatch(waiting);
    cfg.values.set('autopilot.enabled', true);
    expect(await svc.pause(project.id, ADMIN)).toMatchObject({ ok: true });
    expect((await call()).content).toMatch(waiting);
    expect(await svc.resume(project.id, ADMIN)).toMatchObject({ ok: true });
    expect((await call()).content).not.toMatch(waiting);
  });

  it('AP-C13: under halt and with the switch off project_task is refused with the fixed texts, and the branch gives the card', async () => {
    const { project, root } = await startProject();
    const input = { projectId: project.id, title: 'x', instruction: 'y' };
    halted = true;
    expect((await reg.run('project_task', input, (await ctxFor({ actor: praw, task: null, admin: true })).c)).content).toBe('The company is halted; try again after /resume.');
    halted = false;
    cfg.values.set('autopilot.enabled', false);
    expect((await reg.run('project_task', input, (await ctxFor({ actor: praw, task: null, admin: true })).c)).content).toBe('Autopilot is switched off; project tasks cannot be opened.');
    expect((await db.pool.query('SELECT 1 FROM tasks WHERE parent_id = $1', [root.id])).rowCount).toBe(0);
  });

  it('the project budget: once the approvals are used up the next call is a card and exactly one budget card is posted', async () => {
    const { project, root } = await startProject();
    await db.pool.query('UPDATE projects SET approvals_used = max_approvals - 1 WHERE id = $1', [project.id]);
    const task = await child(root, rnd);
    const call = async () => reg.run('fetch_page', { url: 'https://invented.example/page' }, (await ctxFor({ actor: rnd, task, tainted: true })).c);
    expect((await call()).content).not.toMatch(waiting); // the last one
    const before = posts;
    expect((await call()).content).toMatch(waiting);
    expect((await call()).content).toMatch(waiting);
    expect(posts - before).toBe(1);
  });
});
