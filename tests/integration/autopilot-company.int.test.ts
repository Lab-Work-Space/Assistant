import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPANY_AUTOPILOT_NOTE } from '../../agents/context.js';
import { Budget, LOCAL_PROVIDER } from '../../governance/budget.js';
import { AiDigest } from '../../agents/tasks/ai-digest.js';
import { runAgent } from '../../agents/loop/loop.js';
import { setup as loopSetup, route as loopRoute, respond } from '../../agents/loop/loop-fixture.js';
import { humanMsg, MemNotes, auditSpy, newBus, runCtxBase, seededOrg } from '../../agents/test-helpers.js';
import { localDay } from '../../company/calendar.js';
import type { ActorRef } from '../../company/types.js';
import type { DeptId } from '../../core/env.js';
import { EventBus, type AppEvents } from '../../core/events.js';
import { migrate } from '../../db/migrate.js';
import { DepartmentRepo, ProjectRepo, TaskRepo } from '../../db/repos/index.js';
import type { Task } from '../../db/repos/tasks.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { CONFIG_CHANNEL_ID } from '../../discord/commands/types.js';
import { AutopilotService, CAP_NOTICE_TITLE, capNoticeBody } from '../../governance/autopilot.js';
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
 * AUTO-2 acceptance (Gate 1 AC-C5..C15): the owner's 14:17-15:05 log replayed with NO project and scope 'company'. Real database (projects, tasks, the claim and its audit row), the real registry, the real
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
const logged: unknown[] = [];
const notices: { title: string; body: string }[] = [];

const hq: ActorRef = { kind: 'head', dept: 'hq' };
const rnd: ActorRef = { kind: 'head', dept: 'rnd' };
const cto: ActorRef = { kind: 'head', dept: 'software' };
const praw: ActorRef = { kind: 'head', dept: 'praw' };
const ADMIN = '123456789012345678';
const PERSON = '323456789012345678';
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
  cfg = new FakeConfig({ 'autopilot.scope': 'company' });
  logged.length = 0;
  notices.length = 0;
  bus = new EventBus<AppEvents>({ error: () => undefined });
  repo = new ProjectRepo(db.pool, { cfg, halt: { isHalted: () => halted }, now: () => Date.now() });
  svc = new ProjectService({
    repo, cfg, tasks, bus, halted: () => halted, secrets: [], configChannelId: CONFIG_CHANNEL_ID, now: () => Date.now(),
    postCard: async () => `8000000000000${String(10000 + ++posts)}`, closeCard: async () => undefined, notifyHead: async () => undefined, log: { error: () => undefined },
  });
  for (const t of ['tree_tools', 'autopilot_company_counts', 'daily_runs', 'project_tools', 'projects', 'task_grants', 'web_grants', 'ot_requests', 'approvals', 'audit_log', 'budget_days']) await db.pool.query(`DELETE FROM ${t}`);
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
    cfg, halted: () => halted, repo, org: await seededOrg(), describe: (n) => reg.describe(n), secrets: [], exhausted: (id) => svc.exhausted(id), log: { error: (o) => void logged.push(o) },
    capNotice: async (which) => { if (await repo.claimCapNotice(which)) notices.push({ title: CAP_NOTICE_TITLE, body: capNoticeBody(which) }); },
  });
});

/** A Bot Admin's project (the project-scope comparison rows). */
async function startProject(o: { usd?: number; calls?: number } = {}) {
  const r = await svc.start({ userId: ADMIN, title: 'Coffee shop launch', goal: 'Open the shop', deadline: plusDays(30), usd: o.usd ?? 5, calls: o.calls ?? 100 });
  if (!r.ok) throw new Error(`start ${r.code}`);
  const p = (await repo.get(r.id))!;
  const d = await svc.decideCard({ token: p.token, action: 'approve', userId: ADMIN, channelId: p.channelId, messageId: p.messageId });
  if (!d.ok || d.result !== 'approved') throw new Error('approve failed');
  await tasks.update(d.root.id, { status: 'doing' }, 'todo');
  return { project: (await repo.get(r.id))!, root: (await tasks.get(d.root.id))! };
}
const child = (root: Task, owner: ActorRef, o: { tainted?: boolean } = {}) =>
  tasks.create({ title: 'kid', deptId: owner.kind === 'head' ? owner.dept : 'software', owner, requester: hq, origin: 'delegated', parentId: root.id, status: 'doing', ...(o.tainted !== undefined ? { tainted: o.tainted } : {}) });
const rootOf = (o: { origin?: 'chat' | 'watch' | 'poll'; owner?: ActorRef; title?: string; status?: 'doing' | 'done' } = {}) =>
  tasks.create({ title: o.title ?? 'chat', deptId: ((o.owner ?? rnd) as { dept: DeptId }).dept, owner: o.owner ?? rnd, requester: { kind: 'human', userId: PERSON }, origin: o.origin ?? 'chat', status: o.status ?? 'doing', sourceUserId: PERSON, conversation: true });

/** A run context. `chat: true` has no task and the conversation hook (one memoised task per run, like the loop's `opened ??=`); else `task` is the run's own. */
async function ctxFor(a: { actor: ActorRef; task?: Task | null; chat?: boolean; title?: string; tainted?: boolean }) {
  const base = runCtxBase({ origin: 'chat' });
  if (a.tainted) base.run.markTainted();
  const audits = auditSpy();
  const approvals = { needsApproval: () => false, request: vi.fn(async () => ({ id: 5 }) as never) };
  const org = Object.assign(Object.create(await seededOrg()) as object, { toolsFor: () => reg.names() });
  let opened: Promise<Task> | null = null;
  const ensure = vi.fn(() => (opened ??= rootOf({ owner: a.actor, ...(a.title ? { title: a.title } : {}) })));
  const c: ToolContext = {
    actor: a.actor, task: a.task ?? null, ...base, source: { ...base.source, userId: PERSON }, org: org as never, tasks, approvals, limits: new Limits(cfg, tasks), bus: newBus(), notes: new MemNotes(), audit: audits.audit,
    autopilot: { projectOf: (id) => auto.projectOf(id), decide: (r) => auto.decide(r), companyOn: () => auto.companyOn(), inCompany: (id) => auto.inCompany(id) },
    ...(a.chat ? { ensureConversationTask: ensure } : {}),
  };
  return { c, approvals, audits, ensure };
}
const companyRows = async () => (await db.pool.query<{ tool: string; outcome: string; task_id: string | null }>("SELECT tool, outcome, task_id FROM audit_log WHERE action = 'approval.autopilot.company' ORDER BY id")).rows;
const FETCH = { url: 'https://invented.example/page' };

describe('AUTO-2 acceptance: the 14:17-15:05 log, replayed with no project and scope company', () => {
  it('R&D (tainted chat run): web_search and fetch_page run with no card; each is one claimed company approval on the conversation root', async () => {
    const t = await ctxFor({ actor: rnd, chat: true, tainted: true });
    const s = await reg.run('web_search', { query: 'thai coffee market size' }, t.c);
    expect(s.isError, s.content).toBeFalsy();
    expect(s.content).not.toMatch(waiting);
    const f = await reg.run('fetch_page', FETCH, t.c);
    expect(f.isError, f.content).toBeFalsy();
    expect(t.approvals.request).not.toHaveBeenCalled();
    expect((await db.pool.query('SELECT 1 FROM tasks')).rowCount).toBe(1); // one conversation task for the whole run
    const conv = (await tasks.get((await db.pool.query<{ id: string }>('SELECT id FROM tasks')).rows[0]!.id))!;
    expect((await companyRows()).map((r) => [r.tool, r.outcome, r.task_id])).toEqual([['web_search', 'ok d1/600 t1/80', conv.id], ['fetch_page', 'ok d2/600 t2/80', conv.id]]);
    expect((await tasks.get(conv.id))!.tainted).toBe(true); // the web read tainted the opened task
  });

  it('CTO: ws_run from chat gets the conversation task and reports an exit code (the log\'s E_NOTASK is gone); ws_export too', async () => {
    docker.plan = [{ out: 'tests failed', exit: 1 }];
    const t = await ctxFor({ actor: cto, chat: true });
    const r = await reg.run('ws_run', { slug: 'proj', command: 'npm test' }, t.c);
    expect(r.content).toMatch(/ws_run test in proj: exit 1 /);
    expect(r.content).not.toContain(WS_TEXT.E_NOTASK);
    expect(t.approvals.request).not.toHaveBeenCalled();
    expect(t.c.run.tainted()).toBe(true);
    expect((await db.pool.query('SELECT 1 FROM tasks')).rowCount).toBe(1);
  });

  it('AC-C10: ws_run from chat in project scope is E_NOTASK (today), and flipping to company makes it run', async () => {
    cfg.values.set('autopilot.scope', 'project');
    expect((await reg.run('ws_run', { slug: 'proj', command: 'npm test' }, (await ctxFor({ actor: cto, chat: true })).c)).content).toContain(WS_TEXT.E_NOTASK);
    cfg.values.set('autopilot.scope', 'company');
    docker.plan = [{ out: 'ok', exit: 0 }];
    expect((await reg.run('ws_run', { slug: 'proj', command: 'npm test' }, (await ctxFor({ actor: cto, chat: true })).c)).content).toMatch(/exit 0/);
  });

  it('Praw creates a ClickUp task from chat with no card and no /task create; the daily counter is taken once', async () => {
    const t = await ctxFor({ actor: praw, chat: true });
    const r = await reg.run('clickup_create_task', { list_id: '7001', name: 'Machine list', description: 'espresso machine, grinder' }, t.c);
    expect(r.isError, r.content).toBeFalsy();
    expect(r.content).toMatch(/Created task/);
    expect(t.approvals.request).not.toHaveBeenCalled();
    expect(usage.take).toHaveBeenCalledTimes(1);
    expect((await companyRows()).map((x) => x.tool)).toEqual(['clickup_create_task']);
  });

  it('the CEO run carries the company note; ask_requester to a human is refused and sends nothing; a head requester can still be asked', async () => {
    const root = await rootOf({ owner: hq });
    const s = await loopSetup({ script: [{ toolUses: [respond('planned')] }] });
    s.deps.tasks = tasks as never;
    s.deps.autopilot = { budgetHit: async () => undefined, projectOf: (id) => auto.projectOf(id), toolsFor: (p, a) => auto.toolsFor(p, a), decide: (r) => auto.decide(r), companyOn: () => auto.companyOn(), inCompany: (id) => auto.inCompany(id), treeToolsFor: (id, a) => auto.treeToolsFor(id, a) };
    await tasks.update(root.id, { status: 'todo' }, 'doing');
    await runAgent({ route: loopRoute(hq), task: (await tasks.get(root.id))!, history: [] }, s.deps);
    expect((s.provider as FakeProvider).calls[0]!.system).toContain(COMPANY_AUTOPILOT_NOTE);
    const t = await ctxFor({ actor: hq, task: root });
    const ask = { ask: vi.fn(async () => ({ ok: true as const, seq: 1, hours: 4 })), answer: vi.fn() };
    expect(await askRequester.run({ question: 'which supplier?' }, { ...t.c, ask: ask as never })).toEqual({ content: ASK_REFUSALS.autopilotCompany, isError: true });
    expect(ask.ask).not.toHaveBeenCalled();
    const kid = await tasks.create({ title: 'kid', deptId: 'rnd', owner: rnd, requester: hq, origin: 'delegated', parentId: root.id, status: 'doing' });
    const t2 = await ctxFor({ actor: rnd, task: kid });
    expect((await askRequester.run({ question: 'which supplier?' }, { ...t2.c, ask: ask as never })).isError).toBeFalsy();
  });

  it('a seeded hard-deny call (destructive GitHub branch) makes exactly 1 card; the rest of the replay makes none', async () => {
    const a = await ctxFor({ actor: rnd, chat: true, tainted: true });
    const b = await ctxFor({ actor: praw, chat: true });
    const c = await ctxFor({ actor: cto, chat: true });
    await reg.run('web_search', { query: 'thai coffee market' }, a.c);
    await reg.run('clickup_create_task', { list_id: '7001', name: 'x' }, b.c);
    const del = await reg.run('github_create_branch', { owner: 'acme', repo: 'widgets', name: 'x' }, c.c);
    expect(del.content).toMatch(waiting);
    expect(a.approvals.request.mock.calls.length + b.approvals.request.mock.calls.length + c.approvals.request.mock.calls.length).toBe(1);
    expect(c.approvals.request).toHaveBeenCalledTimes(1);
  });

  it('a watch-origin root and a poll-origin root still make a card (AC-C1); a tree grant is refused there', async () => {
    for (const origin of ['watch', 'poll'] as const) {
      const root = await rootOf({ origin });
      const t = await ctxFor({ actor: rnd, task: root, tainted: true });
      expect((await reg.run('fetch_page', FETCH, t.c)).content).toMatch(waiting);
      expect(t.approvals.request).toHaveBeenCalledTimes(1);
      expect(await auto.projectGrant({ dept: 'rnd', taskId: root.id, tool: 'clickup_update_task' })).toEqual({ kind: 'not_project' });
    }
    expect(await companyRows()).toEqual([]);
  });

  it('a tree in a paused, exhausted, past-deadline or closed-with-open-child project still makes a card (AC-C2)', async () => {
    const { project, root } = await startProject();
    const task = await child(root, rnd);
    const call = async () => reg.run('fetch_page', FETCH, (await ctxFor({ actor: rnd, task, tainted: true })).c);
    cfg.values.set('autopilot.scope', 'company');
    // live: the PROJECT rules run it (and not the company ones)
    expect((await call()).content).not.toMatch(waiting);
    expect(await companyRows()).toEqual([]);
    expect(await svc.pause(project.id, ADMIN)).toMatchObject({ ok: true });
    expect((await call()).content).toMatch(waiting);
    expect(await svc.resume(project.id, ADMIN)).toMatchObject({ ok: true });
    await db.pool.query('UPDATE projects SET exhausted_at = now() WHERE id = $1', [project.id]);
    expect((await call()).content).toMatch(waiting);
    await db.pool.query('UPDATE projects SET exhausted_at = NULL, deadline = current_date - 3 WHERE id = $1', [project.id]);
    expect((await call()).content).toMatch(waiting);
    await db.pool.query('UPDATE projects SET deadline = current_date + 30 WHERE id = $1', [project.id]);
    expect(await svc.close(project.id, ADMIN)).toMatchObject({ ok: true });
    await tasks.update(task.id, { status: 'doing' }).catch(() => undefined);
    expect((await call()).content).toMatch(waiting); // closed project: the open child's tree does not become a company tree
    expect(await companyRows()).toEqual([]);
  });

  it('AC-C14: halt, autopilot.enabled=false and /settings scope project each stop company decisions within one call; the flip back resumes', async () => {
    const call = async () => reg.run('fetch_page', FETCH, (await ctxFor({ actor: rnd, chat: true, tainted: true })).c);
    expect((await call()).content).not.toMatch(waiting);
    cfg.values.set('autopilot.scope', 'project');
    expect((await call()).content).toMatch(waiting);
    cfg.values.set('autopilot.scope', 'company');
    expect((await call()).content).not.toMatch(waiting);
    halted = true;
    expect((await call()).content).toMatch(waiting);
    halted = false;
    cfg.values.set('autopilot.enabled', false);
    expect((await call()).content).toMatch(waiting);
    cfg.values.set('autopilot.enabled', true);
    expect((await call()).content).not.toMatch(waiting);
  });

  it('caps: the call past the tree cap and past the day cap is a card, with exactly one notice per day', async () => {
    cfg.values.set('autopilot.company.maxApprovalsPerTree', 2);
    const a = await ctxFor({ actor: rnd, chat: true, tainted: true });
    expect((await reg.run('web_search', { query: `coffee one` }, a.c)).content).not.toMatch(waiting);
    expect((await reg.run('web_search', { query: `coffee two` }, a.c)).content).not.toMatch(waiting);
    expect((await reg.run('web_search', { query: `coffee three` }, a.c)).content).toMatch(waiting);
    expect((await reg.run('web_search', { query: `coffee four` }, a.c)).content).toMatch(waiting);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.title).toBe('Company autopilot cap reached');
    // a second tree, now the day cap
    cfg.values.set('autopilot.company.maxApprovalsPerTree', 80);
    cfg.values.set('autopilot.company.maxApprovalsPerDay', 2);
    const b = await ctxFor({ actor: rnd, chat: true, tainted: true });
    expect((await reg.run('web_search', { query: `coffee five` }, b.c)).content).toMatch(waiting);
    expect(notices).toHaveLength(1); // one notice per day, whichever cap
    expect((await db.pool.query("SELECT 1 FROM audit_log WHERE action = 'autopilot.company.cap'")).rowCount).toBe(1);
  });

  it('a project-scope run: scope default project keeps today\'s card for a chat call (the whole company branch is dormant)', async () => {
    cfg.values.set('autopilot.scope', 'project');
    const t = await ctxFor({ actor: rnd, chat: true, tainted: true });
    expect((await reg.run('fetch_page', FETCH, t.c)).content).toMatch(waiting);
    expect(await companyRows()).toEqual([]);
  });

  it('AC-C11: a tree grant is made in a company tree, offered and dispatched to that department in that tree only, and gone when the root ends', async () => {
    const root = await rootOf({ owner: rnd });
    const other = await rootOf({ owner: rnd });
    expect(await auto.projectGrant({ dept: 'rnd', taskId: root.id, tool: 'clickup_update_task' })).toEqual({ kind: 'granted_tree', rootId: root.id });
    expect(await auto.treeToolsFor(root.id, rnd)).toEqual(['clickup_update_task']);
    expect(await auto.treeToolsFor(other.id, rnd)).toEqual([]);
    expect(await auto.treeToolsFor(root.id, cto)).toEqual([]);
    const offered = async (taskId: string) => {
      const s = await loopSetup({ script: [{ toolUses: [{ name: 'clickup_update_task', input: { task_id: 'a1', name: 'Renamed' } }] }, { toolUses: [respond('ok')] }] });
      s.deps.tasks = tasks as never;
      s.deps.tools = reg;
      s.deps.autopilot = { budgetHit: async () => undefined, projectOf: (id) => auto.projectOf(id), toolsFor: (p, a) => auto.toolsFor(p, a), decide: (r) => auto.decide(r), companyOn: () => auto.companyOn(), inCompany: (id) => auto.inCompany(id), treeToolsFor: (id, a) => auto.treeToolsFor(id, a) };
      await tasks.update(taskId, { status: 'todo' }).catch(() => undefined);
      await runAgent({ route: loopRoute(rnd), task: (await tasks.get(taskId))!, history: [] }, s.deps);
      const calls = (s.provider as FakeProvider).calls;
      return { offered: calls[0]!.tools?.map((x) => x.name) ?? [], result: (calls[1]!.messages.at(-1)!.content[0] as { content: string }).content };
    };
    const during = await offered(root.id);
    expect(during.offered).toContain('clickup_update_task');
    expect(during.result).not.toContain('not allowed');
    expect((await offered(other.id)).offered).not.toContain('clickup_update_task');
    await tasks.update(root.id, { status: 'done' }).catch(() => undefined);
    await db.pool.query("UPDATE tasks SET status = 'done' WHERE id = $1", [root.id]);
    expect(await auto.treeToolsFor(root.id, rnd)).toEqual([]);
  });

  it('AC-C13: a planted marker in the chat title, the tool input and the cap path never appears in the log lines, the notice, the digest or the audit outcomes', async () => {
    const MARK = 'PLANTEDMARKER90';
    cfg.values.set('autopilot.company.maxApprovalsPerTree', 1);
    const t = await ctxFor({ actor: rnd, chat: true, tainted: true, title: MARK });
    await reg.run('web_search', { query: `coffee ${MARK}` }, t.c);
    await reg.run('web_search', { query: `coffee ${MARK}` }, t.c); // over the tree cap: a card plus the notice
    await reg.run('fetch_page', { url: `https://invented.example/page?k=${MARK}${MARK}${MARK}` }, t.c);
    const audit = JSON.stringify((await db.pool.query('SELECT actor, action, tool, outcome FROM audit_log')).rows);
    const digest = new AiDigest({ cfg, secrets: [] } as never).payload({ approvals: [], escalations: [], reasons: [], capHit: false, reviews: 1 }, undefined, await repo.day('Asia/Bangkok'));
    expect(JSON.stringify(digest)).toContain('Company autopilot (no project):');
    expect(notices).toHaveLength(1);
    for (const out of [audit, JSON.stringify(logged), JSON.stringify(notices), JSON.stringify(digest), JSON.stringify(t.audits.entries.map((e) => e.outcome))]) expect(out).not.toContain(MARK);
  });

  it('AC-C12: after company approvals (and the skipped estimate card) the spend caps still refuse: the per-task USD cap (treeCap) and the local-calls-per-task cap (localCap)', async () => {
    cfg.values.set('budget.botDailyUsd', 1000);
    cfg.values.set('budget.companyDailyUsd', 1000);
    cfg.values.set('budget.taskUsd', 1);
    cfg.values.set('limits.localCallsPerTask', 2);
    cfg.values.set('limits.localUnlimited', false);
    const root = await rootOf({ owner: hq });
    const kid = await tasks.create({ title: 'k', deptId: 'rnd', owner: rnd, requester: hq, origin: 'delegated', parentId: root.id, status: 'doing' });
    expect(await auto.decide({ taskId: kid.id, tool: 'web_search', input: { query: 'plain words' } })).toEqual({ kind: 'run' }); // a company approval was claimed
    const b = new Budget(db.pool, cfg, new EventBus<AppEvents>(), () => new Date(), { project: (r, c) => repo.capFor(r, c) });
    expect(await b.reserve({ actor: rnd, estUsd: 2, taskId: kid.id })).toEqual({ ok: false, scope: 'task' });
    expect((await b.reserve({ actor: rnd, estUsd: 0, taskId: kid.id, provider: LOCAL_PROVIDER, model: 'm' })).ok).toBe(true);
    expect((await b.reserve({ actor: rnd, estUsd: 0, taskId: kid.id, provider: LOCAL_PROVIDER, model: 'm' })).ok).toBe(true);
    expect(await b.reserve({ actor: rnd, estUsd: 0, taskId: kid.id, provider: LOCAL_PROVIDER, model: 'm' })).toEqual({ ok: false, scope: 'local_task' });
  });

  it('AC-C15 evidence: the whole replay in one run makes exactly ONE card, the seeded hard-deny, across every context', async () => {
    const ctxs: Awaited<ReturnType<typeof ctxFor>>[] = [];
    const go = async (a: Parameters<typeof ctxFor>[0], tool: string, input: unknown) => {
      const t = await ctxFor(a);
      ctxs.push(t);
      return reg.run(tool, input, t.c);
    };
    docker.plan = [{ out: 'tests failed', exit: 1 }];
    expect((await go({ actor: rnd, chat: true, tainted: true }, 'web_search', { query: 'thai coffee market size' })).content).not.toMatch(waiting);
    expect((await go({ actor: rnd, chat: true, tainted: true }, 'fetch_page', FETCH)).content).not.toMatch(waiting);
    expect((await go({ actor: cto, chat: true }, 'ws_run', { slug: 'proj', command: 'npm test' })).content).toMatch(/exit 1 /);
    expect((await go({ actor: praw, chat: true }, 'clickup_create_task', { list_id: '7001', name: 'Machine list' })).content).toMatch(/Created task/);
    // the CEO: the note is in its system prompt and ask_requester to a human is refused
    const ceoRoot = await rootOf({ owner: hq });
    const s = await loopSetup({ script: [{ toolUses: [respond('planned')] }] });
    s.deps.tasks = tasks as never;
    s.deps.autopilot = { budgetHit: async () => undefined, projectOf: (id) => auto.projectOf(id), toolsFor: (p, a) => auto.toolsFor(p, a), decide: (r) => auto.decide(r), companyOn: () => auto.companyOn(), inCompany: (id) => auto.inCompany(id), treeToolsFor: (id, a) => auto.treeToolsFor(id, a) };
    await tasks.update(ceoRoot.id, { status: 'todo' }, 'doing');
    await runAgent({ route: loopRoute(hq), task: (await tasks.get(ceoRoot.id))!, history: [] }, s.deps);
    expect((s.provider as FakeProvider).calls[0]!.system).toContain(COMPANY_AUTOPILOT_NOTE);
    const ceo = await ctxFor({ actor: hq, task: ceoRoot });
    ctxs.push(ceo);
    const ask = { ask: vi.fn(async () => ({ ok: true as const, seq: 1, hours: 4 })), answer: vi.fn() };
    expect((await askRequester.run({ question: 'which supplier?' }, { ...ceo.c, ask: ask as never })).content).toBe(ASK_REFUSALS.autopilotCompany);
    // the seeded hard-deny
    expect((await go({ actor: cto, chat: true }, 'github_create_branch', { owner: 'acme', repo: 'widgets', name: 'x' })).content).toMatch(waiting);
    expect(ctxs.reduce((n, t) => n + t.approvals.request.mock.calls.length, 0)).toBe(1);
    expect((await companyRows()).map((r) => r.tool)).toEqual(['web_search', 'fetch_page', 'clickup_create_task']);
  });

  it('AC-C13: a planted marker in a human chat message through the real loop never reaches the logger, the audit rows or the system note', async () => {
    const MARK = 'CHATMARKER77';
    const lines: unknown[] = [];
    const s = await loopSetup({ script: [{ toolUses: [respond('hi')] }] });
    s.deps.tasks = tasks as never;
    (s.deps as unknown as { log: unknown }).log = { error: (o: unknown) => void lines.push(o), warn: (o: unknown) => void lines.push(o), info: (o: unknown) => void lines.push(o), debug: (o: unknown) => void lines.push(o) };
    s.deps.autopilot = { budgetHit: async () => undefined, projectOf: (id) => auto.projectOf(id), toolsFor: (p, a) => auto.toolsFor(p, a), decide: (r) => auto.decide(r), companyOn: () => auto.companyOn(), inCompany: (id) => auto.inCompany(id), treeToolsFor: (id, a) => auto.treeToolsFor(id, a) };
    s.deps.conversation = { open: async () => { throw new Error('not opened in this test'); } } as never; // G2-01: the note needs the conversation hook
    await runAgent({ route: loopRoute(rnd), msg: humanMsg(`please search ${MARK}`), task: null, history: [] }, s.deps);
    const system = (s.provider as FakeProvider).calls[0]!.system;
    expect(system).toContain(COMPANY_AUTOPILOT_NOTE);
    expect(system).not.toContain(MARK);
    expect(JSON.stringify(lines)).not.toContain(MARK);
    expect(JSON.stringify((await db.pool.query('SELECT actor, action, tool, outcome FROM audit_log')).rows)).not.toContain(MARK);
  });
});
