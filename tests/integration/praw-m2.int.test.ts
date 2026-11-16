import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App } from '../../app.js';
import { PRAW_DEFAULT_MODEL, seed } from '../../company/index.js';
import { CONFIG_DEFAULTS } from '../../config/defaults.js';
import { ChannelMapRepo, DepartmentRepo, PersonaRepo } from '../../db/repos/index.js';
import { JobRepo } from '../../db/repos/jobs.js';
import { ReminderRepo } from '../../db/repos/reminders.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { PROMPTS_DIR, loadPrompts } from '../../prompts/index.js';
import { createGeminiProvider, type GeminiChunk } from '../../providers/gemini/index.js';
import { toGeminiSchema } from '../../providers/gemini/convert.js';
import { importDiscordBot } from '../../scripts/import-discord-bot.js';
import { createToolPolicy } from '../../tools/policy.js';
import { pluginGroups, registerGroups } from '../../tools/plugins/index.js';
import type { PluginDeps } from '../../tools/plugins/index.js';
import { ReminderWorker } from '../../tools/plugins/reminders/worker.js';
import { ToolRegistry } from '../../tools/registry.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { makeFixtureDir } from '../fixtures/discord-bot/make-fixtures.js';
import { fakeGemini, type GeminiAttempt } from '../fakes/gemini.js';
import { ddgResultsHtml } from '../fakes/http.js';
import { fakeResolver, fakeTransport, redirect } from '../fakes/net.js';
import { ActorProvider, boot, humanMsg, mentionOf, migrateUp, resetDb, respond, turn } from './helpers.js';

const SANDBOX = '1565999999999999777';
const MSG = '1570000000000000042';
const PRAW = { kind: 'head', dept: 'praw' };
const prompts = loadPrompts(PROMPTS_DIR);
const usage = { promptTokens: 10, candidatesTokens: 5 };
const calls = (...fcs: { name: string; args: Record<string, unknown> }[]): GeminiAttempt => ({ chunks: [{ functionCalls: fcs, usage } satisfies GeminiChunk] });
const call = (name: string, args: Record<string, unknown>) => calls({ name, args });
const say = (body: string) => call('respond', { type: 'chat', body });

/** Every tool Task 12-21 added (M2). */
const M2_TOOLS = ['web_search', 'fetch_page', 'add_reminder', 'list_reminders', 'cancel_reminder', 'schedule_add', 'schedule_list', 'schedule_remove',
  'watch_add', 'watch_list', 'watch_remove', 'save_lesson', 'list_lessons', 'delete_lesson', 'list_files', 'read_file', 'write_file', 'pin_message'];

let db: TestDb;
let app: App | null = null;
let base: string;
beforeAll(async () => { db = await freshDb(); await migrateUp(db.pool); });
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'praw-m2-int-')); });
afterEach(async () => {
  await app?.stop();
  app = null;
  await resetDb(db.pool);
  await db.pool.query('TRUNCATE reminders, scheduled_jobs, watches, lessons RESTART IDENTITY');
  rmSync(base, { recursive: true, force: true });
});
afterAll(async () => { await db.close(); });

async function prepare() {
  await migrateUp(db.pool);
  await seed({ departments: new DepartmentRepo(db.pool), personas: new PersonaRepo(db.pool), channelMap: new ChannelMapRepo(db.pool) }, prompts);
  await db.pool.query("UPDATE departments SET work_channel_id = $1 WHERE id = 'praw'", [SANDBOX]);
}

type NetFakes = { resolver: ReturnType<typeof fakeResolver>; transport: ReturnType<typeof fakeTransport> };
async function startGemini(script: GeminiAttempt[], o: { net?: NetFakes; now?: () => number; workspace?: string } = {}) {
  await prepare();
  await db.pool.query("INSERT INTO config (key, value) VALUES ('provider.default', $1)", [JSON.stringify({ provider: 'gemini', model: PRAW_DEFAULT_MODEL })]);
  const fake = fakeGemini(script);
  const root = o.workspace ?? join(base, 'ws');
  const t = await boot(db.pool, {
    provider: createGeminiProvider({ client: fake, sleep: async () => undefined, random: () => 0 }), depts: ['hq', 'praw'],
    env: { prawWorkspaceDir: root }, ...(o.net ? { net: o.net } : {}), ...(o.now ? { now: o.now } : {}),
  });
  app = t.app;
  t.port.messages.set(MSG, SANDBOX);
  return { ...t, fake, root };
}
const ask = (text: string) => humanMsg(`${mentionOf('praw')} ${text}`, { id: MSG, channelId: SANDBOX, mentionedHeads: ['praw'] });
const seen = (fake: { requests: { contents: unknown }[] }) => JSON.stringify(fake.requests.map((r) => r.contents));

describe('AC5 e2e', () => {
  it('Praw fetch_page on 127.0.0.1, 169.254.169.254 and a redirecting public URL (fakes) refuses all three', async () => {
    const net: NetFakes = {
      resolver: fakeResolver({ 'public.example': ['93.184.216.34'] }),
      transport: fakeTransport({ 'http://public.example/go': redirect('http://169.254.169.254/latest/meta-data/') }),
    };
    const urls = ['http://127.0.0.1:8080/admin', 'http://169.254.169.254/latest/meta-data/', 'http://public.example/go'];
    const t = await startGemini([calls(...urls.map((url) => ({ name: 'fetch_page', args: { url } }))), say('ทำไม่ได้ค่ะ')], { net });
    await t.app.services.scheduler.onMessage(ask(`please read ${urls.join(' and ')}`));
    await t.app.services.scheduler.idle();
    const rows = (await db.pool.query("SELECT tool, outcome FROM audit_log WHERE action = 'tool' AND tool <> 'respond' ORDER BY id")).rows;
    expect(rows).toEqual([1, 2, 3].map(() => ({ tool: 'fetch_page', outcome: 'tool_error' })));
    expect(seen(t.fake).match(/fetch_page refused/g)).toHaveLength(3);
    // nothing was ever sent to a private address; the only request is the first hop of the redirecting URL
    expect(net.transport.requests.map((r) => r.url.href)).toEqual(['http://public.example/go']);
  });
});

describe('AC6 e2e', () => {
  const MIN = 60_000;
  async function remindersRun(extra: Record<string, unknown>) {
    let now = Date.parse('2026-11-01T10:00:00Z');
    const t = await startGemini([call('add_reminder', { text: 'ดื่มน้ำ', when: { inMinutes: 2 }, ...extra }), say('ตั้งเตือนแล้วค่ะ')], { now: () => now });
    await t.app.services.scheduler.onMessage(ask('ช่วยเตือน อีก 2 นาที'));
    await t.app.services.scheduler.idle();
    const repo = new ReminderRepo(db.pool);
    expect((await repo.list('42')).map((r) => r.text)).toEqual(['ดื่มน้ำ']);
    // a worker of its own over the same repo/port/fake clock (the app's timer is real-time)
    const worker = new ReminderWorker({ repo, port: t.port, clock: () => now, log: { warn: vi.fn(), error: vi.fn() } });
    const fired = () => t.port.posts.filter((p) => p.payload.body.includes('ดื่มน้ำ'));
    return { t, worker, fired, advance: (ms: number) => void (now += ms) };
  }

  it('"ช่วยเตือน อีก 2 นาที" via fake Gemini → add_reminder → worker fires once with mention', async () => {
    const r = await remindersRun({});
    await r.worker.tick();
    expect(r.fired()).toHaveLength(0);
    r.advance(2 * MIN);
    await r.worker.tick();
    await r.worker.tick();
    expect(r.fired()).toHaveLength(1);
    expect(r.fired()[0]).toMatchObject({ actor: PRAW, target: { channelId: SANDBOX }, opts: { mentionUserIds: ['42'] } });
    r.advance(60 * MIN);
    await r.worker.tick();
    expect(r.fired()).toHaveLength(1);
  });

  it('a recurring reminder fires again after everyMinutes', async () => {
    const r = await remindersRun({ everyMinutes: 10 });
    r.advance(2 * MIN);
    await r.worker.tick();
    expect(r.fired()).toHaveLength(1);
    r.advance(10 * MIN);
    await r.worker.tick();
    expect(r.fired()).toHaveLength(2);
    expect(r.fired()[1]).toMatchObject({ opts: { mentionUserIds: ['42'] } });
  });
});

describe('AC7 e2e', () => {
  const NOW = new Date('2026-11-01T00:00:00Z');
  const E = NOW.getTime() / 1000;
  const row = (o: Record<string, unknown>) => ({ guild_id: 1565649426943442944n, channel_id: 1100000000000000001n, user_id: 1200000000000000002n, created_at: E, ...o });

  it('import dry-run then apply then apply (0)', async () => {
    const from = makeFixtureDir({
      reminders: [row({ text: 'r1', remind_at: E + 600 })],
      tasks: [row({ prompt: 'p1', schedule_kind: 'daily', daily_hhmm: '08:30', next_run_at: E + 900 })],
      watches: [row({ kind: 'url', target: 'https://example.com/a', interval_minutes: 30, next_check_at: E + 60 })],
      lessons: [{ text: 'l1', source: 'manual', created_at: E, active: 1 }],
    });
    const o = (apply: boolean) => ({ from, pool: db.pool, apply, tz: 'Asia/Bangkok', now: () => NOW, guildId: '1565649426943442944', resolver: async () => ['93.184.216.34'] });
    const total = async () => Number((await db.pool.query('SELECT (SELECT count(*) FROM reminders) + (SELECT count(*) FROM scheduled_jobs) + (SELECT count(*) FROM watches) + (SELECT count(*) FROM lessons) AS n')).rows[0].n);
    const dry = await importDiscordBot(o(false));
    expect(dry.map((r) => [r.table, r.read, r.wouldInsert, r.inserted])).toEqual([['reminders', 1, 1, 0], ['scheduled_tasks', 1, 1, 0], ['watches', 1, 1, 0], ['lessons', 1, 1, 0]]);
    expect(await total()).toBe(0);
    const first = await importDiscordBot(o(true));
    expect(first.map((r) => r.inserted)).toEqual([1, 1, 1, 1]);
    expect(await total()).toBe(4);
    const second = await importDiscordBot(o(true));
    expect(second.map((r) => r.inserted)).toEqual([0, 0, 0, 0]);
    expect(await total()).toBe(4);
  });
});

describe('AC8 e2e', () => {
  it('write_file via symlink and ../ refused through the real registry', async () => {
    const root = join(base, 'ws');
    const outside = join(base, 'outside');
    mkdirSync(root, { mode: 0o700 });
    mkdirSync(outside);
    writeFileSync(join(outside, 'target.txt'), 'original');
    symlinkSync(outside, join(root, 'dirlink'));
    symlinkSync(join(outside, 'target.txt'), join(root, 'filelink.txt'));
    const t = await startGemini([
      call('write_file', { path: '../escape.txt', content: 'x' }),
      call('write_file', { path: 'dirlink/new.txt', content: 'x' }),
      call('write_file', { path: 'filelink.txt', content: 'pwned', overwrite: true }),
      say('ทำไม่ได้ค่ะ'),
    ], { workspace: root });
    await t.app.services.scheduler.onMessage(ask('write outside the workspace'));
    await t.app.services.scheduler.idle();
    expect(existsSync(join(base, 'escape.txt'))).toBe(false);
    expect(existsSync(join(outside, 'new.txt'))).toBe(false);
    expect(readFileSync(join(outside, 'target.txt'), 'utf8')).toBe('original');
    const rows = (await db.pool.query("SELECT tool, outcome FROM audit_log WHERE action = 'tool' AND tool <> 'respond' ORDER BY id")).rows;
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r).toMatchObject({ tool: 'write_file', outcome: expect.stringMatching(/^(invalid_input|tool_error)$/) });
    expect((await db.pool.query('SELECT count(*)::int AS n FROM approvals')).rows[0].n).toBe(0);
  });
});

describe('m2', () => {
  it('scheduled web_search run posts result', async () => {
    await prepare();
    await db.pool.query("UPDATE departments SET provider = 'claude', model = 'claude-sonnet-5-5' WHERE id = 'praw'");
    const net: NetFakes = {
      resolver: fakeResolver({ 'html.duckduckgo.com': ['52.142.124.215'] }),
      transport: fakeTransport({ 'https://html.duckduckgo.com/html/': { body: ddgResultsHtml([{ title: 'Node news', url: 'https://nodejs.org/en/blog', snippet: 'release' }]) } }),
    };
    const provider = new ActorProvider({ 'heads/praw': [turn({ name: 'web_search', input: { query: 'node news' } }), turn(respond('report', 'Top story: Node news.'))] });
    const t = await boot(db.pool, { provider, net });
    app = t.app;
    await new JobRepo(db.pool).add({ guildId: 'g', channelId: SANDBOX, userId: '42', prompt: 'search the web for node news', origin: 'schedule', kind: 'daily', hhmm: '09:00', tz: 'Asia/Bangkok', nextRunAt: new Date(Date.now() - 60_000) }, 'unlimited');
    await t.app.services.jobRunner.tick();
    await t.app.services.jobRunner.tick();
    await t.app.services.scheduler.idle();
    expect((await db.pool.query('SELECT origin, status FROM tasks')).rows).toEqual([{ origin: 'schedule', status: 'done' }]);
    expect(net.transport.requests.map((r) => r.url.href)).toEqual(['https://html.duckduckgo.com/html/']);
    expect(JSON.stringify(provider.callsOf('heads/praw')[1]!.messages)).toContain('nodejs.org/en/blog'); // the search result reached the model
    expect(t.port.posts.find((p) => p.payload.body === 'Top story: Node news.')).toMatchObject({ actor: PRAW, target: { channelId: SANDBOX }, opts: { mentionUserIds: ['42'] } });
    expect((await db.pool.query('SELECT count(*)::int AS n FROM approvals')).rows[0].n).toBe(0); // a job its creator wrote runs clean (G2-04)
  });

  it('all M2 tools audited with actor head:praw', async () => {
    const net: NetFakes = {
      resolver: fakeResolver({ 'html.duckduckgo.com': ['52.142.124.215'], 'news.example': ['93.184.216.34'] }),
      transport: fakeTransport({
        'https://html.duckduckgo.com/html/': { body: ddgResultsHtml([{ title: 'T', url: 'https://news.example/a', snippet: 's' }]) },
        'https://news.example/a': { body: '<html><body>hello</body></html>' },
      }),
    };
    const t = await startGemini([
      // a run has at most 8 provider calls (MAX_TOOL_ITERATIONS): several tool calls per turn
      calls(
        { name: 'add_reminder', args: { text: 'r', when: { inMinutes: 30 } } }, { name: 'list_reminders', args: {} }, { name: 'cancel_reminder', args: { id: 1 } },
        { name: 'schedule_add', args: { prompt: 'p', kind: 'interval', intervalMinutes: 60 } }, { name: 'schedule_list', args: {} }, { name: 'schedule_remove', args: { id: 1 } },
        { name: 'watch_add', args: { kind: 'url', target: 'https://news.example/a', intervalMinutes: 60 } }, { name: 'watch_list', args: {} }, { name: 'watch_remove', args: { id: 1 } },
        { name: 'save_lesson', args: { text: 'be brief' } }, { name: 'delete_lesson', args: { id: 1 } },
        { name: 'write_file', args: { path: 'a.txt', content: 'hi' } }, { name: 'list_files', args: {} }, { name: 'pin_message', args: {} },
      ),
      // reads that taint the run come last (web_search first: after taint it asks, G2-05)
      calls({ name: 'web_search', args: { query: 'news' } }, { name: 'read_file', args: { path: 'a.txt' } }, { name: 'list_lessons', args: {} }, { name: 'fetch_page', args: { url: 'https://news.example/a' } }),
      say('เสร็จแล้วค่ะ'),
    ], { net });
    await t.app.services.scheduler.onMessage(ask('exercise everything https://news.example/a'));
    await t.app.services.scheduler.idle();
    const rows = (await db.pool.query("SELECT actor, tool, outcome FROM audit_log WHERE action = 'tool' AND tool <> 'respond' ORDER BY id")).rows as { actor: string; tool: string; outcome: string }[];
    expect([...new Set(rows.map((r) => r.tool))].sort()).toEqual([...M2_TOOLS].sort());
    for (const r of rows) expect(r.actor, `${r.tool}:${r.outcome}`).toBe('head:praw');
    expect(rows.filter((r) => r.outcome !== 'ok'), 'every call in the happy path succeeded').toEqual([]);
  });

  const fullDeps = () => ({ cfg: new FakeConfig(), env: {}, log: { warn: vi.fn() }, workspaceRoot: '/nonexistent/praw-ws', net: { resolver: fakeResolver({}), transport: fakeTransport({}) },
      reminders: {}, jobs: {}, watches: {}, lessons: {}, port: {}, org: {}, clock: () => 0 }) as unknown as PluginDeps;
  function registry() {
    const reg = new ToolRegistry({ halt: { isHalted: () => false } });
    const deps = fullDeps();
    const r = registerGroups(reg, pluginGroups, deps);
    return { reg, r };
  }

  it('every M2 tool that returns external content is flagged untrustedOutput', () => {
    const flagged = new Set(pluginGroups.flatMap((f) => { const g = f(fullDeps()); return 'tools' in g ? g.tools : []; }).filter((t) => t.untrustedOutput).map((t) => t.name));
    // web pages, search results, workspace file text and lesson text (which may come from a person or an import) are untrusted (P2)
    for (const n of ['web_search', 'fetch_page', 'read_file', 'list_lessons']) expect(flagged, n).toContain(n);
  });

  it('wiring: praw has every M2 tool, software has web_search and fetch_page only, tool names equal the old bot\'s where they exist, tool names unique, every M2 inputSchema converts via toGeminiSchema', () => {
    const { reg, r } = registry();
    expect(r.disabled.filter((d) => d.id !== 'clickup' && d.id !== 'github' && d.id !== 'ocr' && d.id !== 'music' && d.id !== 'docs' && d.id !== 'media' && d.id !== 'ws')).toEqual([]); // docs without the separate renderer container (RFMD P3, RF15); M3 groups are off without their keys, M4 ocr without the metered service, M5 music without the player
    const names = reg.names();
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining(M2_TOOLS));
    // the names the old Python bot already used (so prompts and habits carry over)
    for (const n of ['web_search', 'add_reminder', 'list_reminders', 'save_lesson', 'pin_message', 'list_files', 'read_file', 'write_file']) expect(names, n).toContain(n);
    const policy = createToolPolicy({ get: (k: keyof typeof CONFIG_DEFAULTS) => CONFIG_DEFAULTS[k] } as never, () => reg.names());
    const m2 = (list: string[]) => list.filter((n) => M2_TOOLS.includes(n)).sort();
    expect(m2(policy.effective('praw', ['*']))).toEqual([...M2_TOOLS].sort());
    expect(m2(policy.effective('software', []))).toEqual(['fetch_page', 'web_search']);
    for (const s of reg.specsFor(M2_TOOLS)) {
      const g = toGeminiSchema(s.inputSchema) as { type?: string };
      expect(g.type, s.name).toBe('OBJECT');
    }
    expect(reg.specsFor(M2_TOOLS)).toHaveLength(M2_TOOLS.length);
  });
});
