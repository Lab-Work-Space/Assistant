import { Writable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App } from '../../app.js';
import { seed } from '../../company/index.js';
import { CONFIG_DEFAULTS } from '../../config/defaults.js';
import { createLogger } from '../../core/logger.js';
import { ChannelMapRepo, DepartmentRepo, PersonaRepo } from '../../db/repos/index.js';
import { JobRepo } from '../../db/repos/jobs.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { PROMPTS_DIR, loadPrompts } from '../../prompts/index.js';
import { toGeminiRequest } from '../../providers/gemini/convert.js';
import type { ChatRequest } from '../../providers/index.js';
import { createHttpClient } from '../../services/http.js';
import { createClickUpClient } from '../../tools/plugins/clickup/client.js';
import { clickupGroup } from '../../tools/plugins/clickup/index.js';
import { rig as githubRig, APP_ID, INSTALLATION_ID, KP, PEM, REPO } from '../../tools/plugins/github/test-helpers.js';
import type { PluginDeps } from '../../tools/plugins/index.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { CLICKUP_BASE, clickupRoutes, fakeFetch, githubRoutes } from '../fakes/http.js';
import { ActorProvider, boot, humanMsg, mentionOf, migrateUp, resetDb, respond, turn } from './helpers.js';

/** M3 acceptance (T31): the ClickUp / GitHub tool surface end to end over socket-free fakes. */
const PRAW_WORK = '1565999999999999001';
const CU = { token: 'pk_12345678_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345', listId: '901800000001' };

let db: TestDb;
let app: App | null = null;
beforeAll(async () => { db = await freshDb(); });
afterEach(async () => { await app?.stop(); app = null; await resetDb(db.pool); await db.pool.query('TRUNCATE scheduled_jobs RESTART IDENTITY'); });
afterAll(async () => { await db.close(); });

function world() {
  const gh = githubRoutes({ appId: APP_ID, installationId: INSTALLATION_ID, publicKey: KP.publicKey, repos: [REPO] });
  const f = fakeFetch({
    ...clickupRoutes({ token: CU.token, listId: CU.listId, listName: 'Sprint', tasks: [{ id: 'a1', name: 'Existing', status: { status: 'to do', type: 'open' } }] }),
    ...gh.routes,
  });
  const env = { clickup: { apiToken: CU.token, listId: CU.listId }, github: { appId: APP_ID, installationId: INSTALLATION_ID, privateKey: PEM } };
  return { f, env, gh };
}

async function prepare(): Promise<void> {
  await migrateUp(db.pool);
  await seed({ departments: new DepartmentRepo(db.pool), personas: new PersonaRepo(db.pool), channelMap: new ChannelMapRepo(db.pool) }, loadPrompts(PROMPTS_DIR));
  await db.pool.query("UPDATE departments SET provider = 'claude', model = 'claude-sonnet-5-5', work_channel_id = $1 WHERE id = 'praw'", [PRAW_WORK]);
}
const toolNames = (r: ChatRequest) => r.tools.map((t) => t.name);
const text = (r: ChatRequest) => JSON.stringify(r.messages);
const create2 = turn({ name: 'clickup_create_task', input: { name: 'Task one' } }, { name: 'clickup_create_task', input: { name: 'Task two' } });
const posts = (f: ReturnType<typeof fakeFetch>) => f.requests.filter((q) => q.method === 'POST' && q.url === `${CLICKUP_BASE}/list/${CU.listId}/task`);
const pending = async () => (await db.pool.query<{ id: number }>("SELECT id FROM approvals WHERE status = 'pending' ORDER BY id")).rows.map((r) => r.id);

describe('m3', () => {
  it('m3 › software head can run clickup/github read tools; finance cannot', async () => {
    await prepare();
    const w = world();
    const reads = [
      turn({ name: 'clickup_list_projects', input: {} }, { name: 'github_get_repository_info', input: { owner: 'acme', repo: 'widgets' } }, { name: 'clickup_create_task', input: { name: 'nope' } }),
      turn(respond('chat', 'ok')),
    ];
    const provider = new ActorProvider({ 'heads/software': reads, 'heads/finance': [turn(respond('chat', 'no tools'))] });
    const t = await boot(db.pool, { provider, env: w.env, fetch: w.f });
    app = t.app;
    await t.app.services.scheduler.onMessage(humanMsg(`${mentionOf('software')} status?`, { mentionedHeads: ['software'] }));
    await t.app.services.scheduler.idle();
    const sw = provider.callsOf('heads/software');
    for (const n of ['clickup_list_projects', 'clickup_list_open_tasks', 'github_get_repository_info', 'github_get_pull_request']) expect(toolNames(sw[0]!), n).toContain(n);
    expect(toolNames(sw[0]!).filter((n) => /^(clickup|github)_/.test(n) && /create|update|assign|comment|delete|transition|status|branch|file|pull_request$/.test(n) && !/get_|list_/.test(n))).toEqual([]);
    expect(text(sw[1]!)).toContain('Sprint'); // the clickup read really ran
    expect(text(sw[1]!)).toContain('Sprint');
    expect(text(sw[1]!)).toMatch(/widgets/);
    expect(text(sw[1]!)).toMatch(/not allowed|unknown tool|not available/i); // a write tool is not in the software head's allowlist
    expect(posts(w.f)).toHaveLength(0);

    await t.app.services.scheduler.onMessage(humanMsg(`${mentionOf('finance')} tasks?`, { mentionedHeads: ['finance'] }));
    await t.app.services.scheduler.idle();
    expect(toolNames(provider.callsOf('heads/finance')[0]!).filter((n) => /^(clickup|github)_/.test(n))).toEqual([]);
  });

  it('m3 › Praw delegated "create the ClickUp tasks for this plan" (CEO task dept praw, fake Gemini; depth>0, so delegated) asks approval for each write and runs the stored calls once after approval', async () => {
    await prepare();
    const w = world();
    const provider = new ActorProvider({
      'heads/hq': [turn({ name: 'create_task', input: { title: 'Create the ClickUp tasks for this plan', description: 'Create task one and task two.', assignee: { kind: 'head', dept: 'praw' }, estCostUsd: 0.1 } }), turn(respond('chat', 'Asked Praw.')), turn(respond('report', 'done'))],
      'heads/praw': [create2, turn(respond('report', 'created both')), turn(respond('report', 'created both'))],
    });
    const t = await boot(db.pool, { provider, env: w.env, fetch: w.f });
    app = t.app;
    await t.app.services.scheduler.onMessage(humanMsg(`${mentionOf('hq')} please create the tasks`, { channelId: '1565652605290414160', mentionedHeads: ['hq'] }));
    await t.app.services.scheduler.idle();
    const ids = await pending();
    expect(ids).toHaveLength(2);
    expect(posts(w.f)).toHaveLength(0);
    for (const id of ids) expect((await t.app.services.approvals.decide(id, 'approved', { id: 'admin1', isAdmin: true })).ok).toBe(true);
    await t.app.services.scheduler.idle();
    expect(posts(w.f).map((q) => JSON.parse(q.body!).name).sort()).toEqual(['Task one', 'Task two']);
    for (const id of ids) expect((await t.app.services.approvals.decide(id, 'approved', { id: 'admin1', isAdmin: true })).ok).toBe(false);
    await t.app.services.scheduler.idle();
    expect(posts(w.f)).toHaveLength(2); // once each
    expect((await db.pool.query('SELECT 1 FROM tasks WHERE dept_id = $1 AND origin = $2', ['praw', 'delegated'])).rowCount).toBe(1);
  });

  it('m3 › a direct praw chat request "create 2 ClickUp tasks" runs without approval', async () => {
    await prepare();
    const w = world();
    const provider = new ActorProvider({ 'heads/praw': [create2, turn(respond('chat', 'made 2 tasks'))] });
    const t = await boot(db.pool, { provider, env: w.env, fetch: w.f });
    app = t.app;
    await t.app.services.scheduler.onMessage(humanMsg(`${mentionOf('praw')} create 2 ClickUp tasks`, { mentionedHeads: ['praw'] }));
    await t.app.services.scheduler.idle();
    expect(posts(w.f)).toHaveLength(2);
    expect(await pending()).toEqual([]);
  });

  it('m3 › same instruction reached via a scheduled run asks approval for each write', async () => {
    await prepare();
    const w = world();
    const provider = new ActorProvider({ 'heads/praw': [create2, turn(respond('report', 'created both'))] });
    const t = await boot(db.pool, { provider, env: w.env, fetch: w.f });
    app = t.app;
    await new JobRepo(db.pool).add({ guildId: 'g', channelId: PRAW_WORK, userId: '42', prompt: 'create 2 ClickUp tasks', origin: 'schedule', kind: 'daily', hhmm: '09:00', tz: 'Asia/Bangkok', nextRunAt: new Date(Date.now() - 60_000) }, 'unlimited');
    await t.app.services.jobRunner.tick();
    await t.app.services.jobRunner.tick();
    await t.app.services.scheduler.idle();
    const ids = await pending();
    expect(ids).toHaveLength(2);
    expect(posts(w.f)).toHaveLength(0);
    for (const id of ids) await t.app.services.approvals.decide(id, 'approved', { id: 'admin1', isAdmin: true });
    await t.app.services.scheduler.idle();
    expect(posts(w.f)).toHaveLength(2);
  });

  it('m3 › every M3 tool schema converts for Gemini', async () => {
    await prepare();
    const w = world();
    const provider = new ActorProvider({ 'heads/praw': [turn(respond('chat', 'hi'))] });
    const t = await boot(db.pool, { provider, env: w.env, fetch: w.f });
    app = t.app;
    await t.app.services.scheduler.onMessage(humanMsg(`${mentionOf('praw')} hi`, { mentionedHeads: ['praw'] }));
    await t.app.services.scheduler.idle();
    const req = provider.callsOf('heads/praw')[0]!;
    const m3 = req.tools.filter((x) => /^(clickup|github)_/.test(x.name));
    expect(m3.length).toBeGreaterThanOrEqual(25);
    for (const n of ['clickup_create_task', 'github_create_or_update_file', 'github_create_pull_request']) expect(m3.map((x) => x.name), n).toContain(n);
    // tools.byDept defaults name only tools that exist (no stale pre-port names)
    const registered = new Set(toolNames(req));
    const stale = Object.entries(CONFIG_DEFAULTS['tools.byDept']).flatMap(([d, ns]) => ns.filter((n) => !registered.has(n) && n !== 'extract_receipt' && n !== 'doc_create' && n !== 'diagram_create' && n !== 'image_generate' && n !== 'video_generate' && n !== 'clickup_search_tasks' && !n.startsWith('ws_')).map((n) => `${d}:${n}`));
    expect(stale).toEqual([]);
    const g = toGeminiRequest({ ...req, tools: m3 });
    expect(g.functionDeclarations).toHaveLength(m3.length);
    for (const d of g.functionDeclarations) expect(JSON.stringify(d), d.name).not.toMatch(/additionalProperties|\$schema|\$ref/);
  });

  it('m3 › every M3 tool that returns bodies/comments is flagged untrustedOutput (P2)', async () => {
    const f = fakeFetch({});
    const http = createHttpClient({ fetch: f });
    const deps = {
      clickup: createClickUpClient({ http, token: CU.token, listId: CU.listId }),
      github: githubRig().client, cfg: new FakeConfig(), log: { warn: vi.fn() },
    } as unknown as PluginDeps;
    const groups = [clickupGroup(deps), githubRig().g];
    const tools = groups.flatMap((g) => ('tools' in g ? g.tools : []));
    expect(tools.length).toBeGreaterThanOrEqual(25);
    const reads = tools.filter((x) => x.kind === 'read');
    expect(reads.length).toBeGreaterThanOrEqual(15);
    expect(reads.filter((x) => !x.untrustedOutput).map((x) => x.name)).toEqual([]);
    for (const n of ['clickup_list_comments', 'clickup_get_task_detail', 'github_get_issue', 'github_get_pull_request', 'github_list_repository_issues']) {
      expect(tools.find((x) => x.name === n)?.untrustedOutput, n).toBe(true);
    }
    expect(tools.filter((x) => x.untrustedOutput && !x.untrustedSource).map((x) => x.name)).toEqual([]);
  });

  it('m3 › no secret value in any fake-recorded outbound Discord payload or audit row', async () => {
    await prepare();
    const w = world();
    const provider = new ActorProvider({
      'heads/hq': [turn({ name: 'create_task', input: { title: 'Plan', description: 'Create it', assignee: { kind: 'head', dept: 'praw' }, estCostUsd: 0.1 } }), turn(respond('chat', 'ok')), turn(respond('report', 'ok'))],
      'heads/praw': [
        turn({ name: 'clickup_create_task', input: { name: `x ${CU.token}`, description: `${CU.token}` } }, { name: 'clickup_list_open_tasks', input: {} }),
        turn(respond('report', 'done')), turn(respond('report', 'done')),
      ],
    });
    const t = await boot(db.pool, { provider, env: w.env, fetch: w.f });
    app = t.app;
    await t.app.services.scheduler.onMessage(humanMsg(`${mentionOf('hq')} go`, { channelId: '1565652605290414160', mentionedHeads: ['hq'] }));
    await t.app.services.scheduler.idle();
    for (const id of await pending()) await t.app.services.approvals.decide(id, 'approved', { id: 'admin1', isAdmin: true });
    await t.app.services.scheduler.idle();
    const out = JSON.stringify(t.port.posts);
    const audit = JSON.stringify((await db.pool.query('SELECT * FROM audit_log')).rows);
    expect(audit).toContain('clickup_create_task');
    for (const [where, s] of [['payloads', out], ['audit', audit], ['approvals table (reason)', JSON.stringify((await db.pool.query('SELECT reason FROM approvals')).rows)]] as const) {
      expect(s, where).not.toContain(CU.token);
      expect(s, where).not.toContain(PEM.split('\n')[1]!);
    }
  });
});

describe('github denylist prefetch at startup', () => {
  it('m3 › a failed denied-id prefetch logs a warning and raises one governance alert', async () => {
    await prepare();
    const lines: string[] = [];
    const logger = createLogger('trace', { destination: new Writable({ write(c, _e, cb) { lines.push(String(c)); cb(); } }) });
    const f = fakeFetch({}); // every GitHub route 404s: the installation cannot be resolved, so the deny list cannot be built
    const t = await boot(db.pool, { provider: new ActorProvider({}), env: { github: { appId: APP_ID, installationId: INSTALLATION_ID, privateKey: PEM } }, fetch: f, logger });
    app = t.app;
    await vi.waitFor(() => expect(t.port.posts.filter((p) => p.payload.type === 'alert' && p.payload.body.includes('where: boot · github')).length).toBe(1));
    await new Promise((r) => setTimeout(r, 300)); // a further tick: still exactly one
    expect(t.port.posts.filter((p) => p.payload.type === 'alert' && p.payload.body.includes('where: boot · github'))).toHaveLength(1);
    expect(lines.join('')).toMatch(/denylist|denied/i);
    expect(lines.join('')).toMatch(/"level":40/);
    expect(JSON.stringify(t.port.posts)).not.toContain(PEM.split('\n')[1]!);
  });
});
