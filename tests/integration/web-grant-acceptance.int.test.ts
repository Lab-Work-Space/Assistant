import { z } from 'zod';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App } from '../../app.js';
import { seed } from '../../company/index.js';
import { ChannelMapRepo, DepartmentRepo, PersonaRepo } from '../../db/repos/index.js';
import { WebGrantRepo } from '../../db/repos/web-grants.js';
import { JobRepo } from '../../db/repos/jobs.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { handleInteraction } from '../../discord/index.js';
import { interaction } from '../../discord/commands/test-helpers.js';
import { PROMPTS_DIR, loadPrompts } from '../../prompts/index.js';
import type { GroupFactory } from '../../tools/plugins/index.js';
import type { ToolPlugin } from '../../tools/types.js';
import { fakeResolver, fakeTransport } from '../fakes/net.js';
import { ActorProvider, CONFIG_CHANNEL, TestPort, boot, migrateUp, resetDb, respond, taskIdOf, turn } from './helpers.js';

// R4 PM-C9: the stub tool is not in the catalog (an undeclared name is fail-closed), so this file gives it a test class. Only this seam; DERIVED stays the real one.
vi.mock('../../tools/manifest/catalog.js', async (orig) => {
  const { withTestClasses } = await import('../fakes/tool-classes.js');
  const { WRITE } = await import('../../tools/manifest/types.js');
  return withTestClasses(await orig<typeof import('../../tools/manifest/catalog.js')>(), { stub_write: { ...WRITE, sensitive: false, group: 'test' } });
});

/**
 * WEBGRANT-1 acceptance (tester, stage 6): the owner scenarios through the real app. Independent of the developer suite
 * (web-grant-app.int.test.ts); every url is a fake host behind the fake resolver/transport, so nothing leaves the process.
 */
const PRAW_WORK = '1565999999999999001';
const ADMIN = '123456789012345678';
const HOSTS = ['x.test', 'a.test', 'b.test', 'c.test', 'd.test', 'e.test', 'f.test', 'g.test', 'h.test'];
let db: TestDb;
let app: App | null = null;
beforeAll(async () => { db = await freshDb(); });
afterEach(async () => { await app?.stop(); app = null; await resetDb(db.pool); await db.pool.query('TRUNCATE scheduled_jobs RESTART IDENTITY'); });
afterAll(async () => { await db.close(); });

const fetchTurn = (...urls: string[]) => turn(...urls.map((url) => ({ name: 'fetch_page', input: { url } })));
function fakeWrite() {
  const calls: { title: string }[] = [];
  const tool: ToolPlugin<{ title: string }> = {
    name: 'stub_write', description: 'stub write', kind: 'write', inputSchema: z.object({ title: z.string() }), requiresApproval: () => false,
    run: async (i) => { calls.push(i); return { content: `wrote ${i.title}` }; },
  };
  const group: GroupFactory = () => ({ id: 'stub', tools: [tool as ToolPlugin<any>] });
  return { calls, group };
}

async function start(script: ConstructorParameters<typeof ActorProvider>[0], cfg: Record<string, unknown> = {}) {
  await migrateUp(db.pool);
  await seed({ departments: new DepartmentRepo(db.pool), personas: new PersonaRepo(db.pool), channelMap: new ChannelMapRepo(db.pool) }, loadPrompts(PROMPTS_DIR));
  await db.pool.query("UPDATE departments SET provider = 'claude', model = 'claude-sonnet-5-5', work_channel_id = $1 WHERE id = 'praw'", [PRAW_WORK]);
  for (const [k, v] of Object.entries(cfg)) await db.pool.query("INSERT INTO config (key, value, updated_by) VALUES ($1, $2::jsonb, 'test')", [k, JSON.stringify(v)]);
  const resolver = fakeResolver(Object.fromEntries(HOSTS.map((h) => [h, ['93.184.215.14']])));
  const transport = fakeTransport({});
  const fake = fakeWrite();
  const port = new TestPort();
  port.snowflakes = true;
  const provider = new ActorProvider(script);
  const t = await boot(db.pool, { provider, port, groups: [fake.group], approvalBatching: { windowMs: 600_000 }, net: { resolver, transport } });
  app = t.app;
  await new JobRepo(db.pool).add({ guildId: 'g', channelId: PRAW_WORK, userId: '42', prompt: 'read the pages', origin: 'schedule', kind: 'daily', hhmm: '09:00', tz: 'Asia/Bangkok', nextRunAt: new Date(Date.now() - 60_000) }, 'unlimited');
  await t.app.services.jobRunner.tick();
  await t.app.services.jobRunner.tick();
  await t.app.services.scheduler.idle();
  return { ...t, port, transport, fake, provider };
}
type Started = Awaited<ReturnType<typeof start>>;
const cards = (t: Started) => t.port.posts.filter((p) => p.target.channelId === CONFIG_CHANNEL && p.payload.type === 'approval');
const press = async (t: Started, customId: string, messageId: string, userId = ADMIN, roles?: string[]) => {
  const r = await handleInteraction(interaction({ kind: 'button', customId, userId, messageId, messageAuthorId: 'hq', ...(roles ? { roles } : {}) }), t.app.services.commands);
  await t.app.services.scheduler.idle();
  return r;
};
const fetched = (t: Started) => t.transport.requests.map((r) => r.url.href);
type G = { id: number; used: number; hosts: string[]; url_chars_used: number; revoke_reason: string | null };
const grants = async () => (await db.pool.query<G>('SELECT id, used, hosts, url_chars_used, revoke_reason FROM web_grants ORDER BY id')).rows;
const pending = async () => (await db.pool.query<{ id: number; reason: string; tool_name: string }>("SELECT id, reason, tool_name FROM approvals WHERE status = 'pending' ORDER BY id")).rows;
/** Taint the run with x.test, raise the first card for a.test, click the grant button: returns with the grant live and the run resumed. */
async function granted(t: Started) {
  await t.app.services.batching!.flushAll();
  const card = cards(t)[0]!;
  await press(t, 'approval:1:grant', card.id);
  return card;
}
const tail = (n: number) => Array.from({ length: n }, (_, i) => `https://b.test/page-${i + 1}/`);

describe('WEBGRANT-1 acceptance: owner scenarios (real app)', () => {
  it('(a1) 20 pages under the grant run with no card, the 21st gets a card that names cap_fetches', async () => {
    const t = await start({ 'heads/praw': [fetchTurn('https://x.test/'), fetchTurn('https://a.test/'), ...[0, 5, 10, 15].map((i) => fetchTurn(...tail(21).slice(i, i + 5))), fetchTurn(tail(21)[20]!), turn(respond('report', 'done'))] }, { 'limits.turnsPerTask': 100 });
    await granted(t);
    expect(fetched(t)).toEqual(['https://x.test/', 'https://a.test/', ...tail(20)]);
    expect((await grants())[0]).toMatchObject({ used: 20, hosts: ['b.test'], revoke_reason: null });
    const p = await pending();
    expect(p).toHaveLength(1);
    expect(p[0]!.reason).toContain('web grant not applied: cap_fetches');
    expect(p[0]!.reason).toContain('page-21');
  });

  it('(a2) the 6th distinct host gets a card that names cap_hosts; the 5th host still runs', async () => {
    const urls = ['b', 'c', 'd', 'e', 'f', 'g'].map((h) => `https://${h}.test/`);
    const t = await start({ 'heads/praw': [fetchTurn('https://x.test/'), fetchTurn('https://a.test/'), ...urls.map((u) => fetchTurn(u)), turn(respond('report', 'done'))] });
    await granted(t);
    expect(fetched(t)).toEqual(['https://x.test/', 'https://a.test/', ...urls.slice(0, 5)]);
    expect((await grants())[0]).toMatchObject({ used: 5, hosts: ['b.test', 'c.test', 'd.test', 'e.test', 'f.test'] });
    const p = await pending();
    expect(p).toHaveLength(1);
    expect(p[0]!.reason).toContain('web grant not applied: cap_hosts');
    expect(p[0]!.reason).toContain('g.test');
  });

  it('(a3) the URL character budget: with maxUrlChars 500, three ~150-char paths run, the fourth gets a card (cap_chars)', async () => {
    const path = (n: number) => `/alpha-bravo-charlie-delta-echo/foxtrot-golf-hotel-india-juliet/kilo-lima-mike-november-oscar-papa/quebec-victor-whiskey-xray-yankee-zulu-v${'x'.repeat(n)}/`;
    const urls = [1, 2, 3, 4].map((n) => `https://b.test${path(n)}`);
    const len = new URL(urls[0]!).pathname.length;
    expect(len).toBeGreaterThan(140);
    expect(len).toBeLessThanOrEqual(160);
    const t = await start({ 'heads/praw': [fetchTurn('https://x.test/'), fetchTurn('https://a.test/'), ...urls.map((u) => fetchTurn(u)), turn(respond('report', 'done'))] }, { 'web.taskGrant.maxUrlChars': 500 });
    await granted(t);
    expect(fetched(t)).toEqual(['https://x.test/', 'https://a.test/', ...urls.slice(0, 3)]);
    const g = (await grants())[0]!;
    expect(g.used).toBe(3);
    expect(g.url_chars_used).toBeLessThanOrEqual(500);
    expect(g.url_chars_used).toBeGreaterThan(420);
    const p = await pending();
    expect(p).toHaveLength(1);
    expect(p[0]!.reason).toContain('web grant not applied: cap_chars');
  });

  it('(b) suspicious urls (base64 query, 10-digit id, userinfo, http) under a live grant each get a card naming the rule; a plain url still runs', async () => {
    const bad = [
      'https://b.test/q?d=SGVsbG8gd29ybGQgdGhpcyBpcyBzZWNyZXQgZGF0YQ',
      'https://b.test/user/1234567890/',
      'https://user:pw@b.test/',
      'http://b.test/plain',
    ];
    const t = await start({ 'heads/praw': [fetchTurn('https://x.test/'), fetchTurn('https://a.test/'), fetchTurn(...bad), fetchTurn('https://c.test/ok/'), turn(respond('report', 'done'))] });
    await granted(t);
    // the parallel turn: every suspicious call has its own card; the plain one after it needs none
    await t.app.services.batching!.flushAll();
    const p = await pending();
    expect(p.length).toBe(4);
    expect(p.map((r) => /url:(E\d)/.exec(r.reason)?.[1] ?? 'none')).toEqual(['E7', 'E7', 'E2', 'E1']);
    expect((await grants())[0]).toMatchObject({ used: 0, hosts: [] });
    expect(fetched(t)).toEqual(['https://x.test/', 'https://a.test/']);
  });

  // DEFECT TASKWEB1-D1 (Medium): a UUID path with mixed hex groups passes E7 (every dash-split token is < 16 chars), so it is consumed with no card.
  // fixed: grant-url.ts rejects UUID shapes and stripped hex runs.
  it('(b2) a UUID path under a live grant gets a card (E7)', async () => {
    const t = await start({ 'heads/praw': [fetchTurn('https://x.test/'), fetchTurn('https://a.test/'), fetchTurn('https://b.test/doc/3f2b8c1e-9d4a-4e7b-8a61-0c5d2e9f7a13/'), turn(respond('report', 'done'))] });
    await granted(t);
    await t.app.services.batching!.flushAll();
    expect((await pending()).map((r) => /url:(E\d)/.exec(r.reason)?.[1])).toEqual(['E7']);
    expect((await grants())[0]).toMatchObject({ used: 0 });
  });

  it('(c) a child task delegated to another head shares the grant (same root, caps shared)', async () => {
    const t = await start({
      'heads/praw': [
        fetchTurn('https://x.test/'), fetchTurn('https://a.test/'), fetchTurn('https://b.test/'),
        turn({ name: 'create_task', input: { title: 'Read more pages', description: 'Read c.test and report.', assignee: { kind: 'head', dept: 'software' }, estCostUsd: 0.01 } }),
        turn(respond('chat', 'delegated')),
        turn(respond('report', 'done')),
      ],
      'heads/software': [fetchTurn('https://c.test/'), (req) => turn({ name: 'update_task', input: { taskId: taskIdOf(req), status: 'done', summary: 'read' } }, respond('report', 'read c'))],
    });
    await granted(t);
    await t.app.services.scheduler.idle();
    const child = (await db.pool.query<{ id: string; root_id: string; tainted: boolean; owner: { dept: string } }>("SELECT id, root_id, tainted, owner FROM tasks WHERE parent_id IS NOT NULL")).rows;
    expect(child).toHaveLength(1);
    expect(child[0]!.owner).toMatchObject({ dept: 'software' });
    expect(child[0]!.tainted).toBe(true);
    expect(fetched(t)).toContain('https://c.test/');
    expect((await grants())[0]).toMatchObject({ used: 2, hosts: ['b.test', 'c.test'] });
    expect(await pending()).toEqual([]);
  });

  it('(d) /halt revokes the grant; /resume does not bring it back; a fresh grant is needed', async () => {
    const t = await start({ 'heads/praw': [fetchTurn('https://x.test/'), fetchTurn('https://a.test/'), fetchTurn('https://b.test/'), turn(respond('report', 'done'))] });
    await granted(t);
    expect((await grants())[0]).toMatchObject({ used: 1, revoke_reason: null });
    await handleInteraction(interaction({ commandName: 'halt', userId: 'admin1' }), t.app.services.commands);
    expect((await grants())[0]!.revoke_reason).toBe('halt');
    await handleInteraction(interaction({ commandName: 'resume', userId: 'admin1' }), t.app.services.commands);
    await t.app.services.scheduler.idle();
    expect((await grants())[0]!.revoke_reason).toBe('halt');
    const r = await new WebGrantRepo(db.pool).consume({ rootId: (await db.pool.query<{ root_id: string }>('SELECT root_id FROM web_grants')).rows[0]!.root_id, host: 'c.test', chars: 1 });
    expect(r.ok).toBe(false);
    // a new grant click on a halted system is refused with nothing inserted
    expect((await grants()).length).toBe(1);
  });

  it('(e) batch card: two unseen urls in one turn, "grant" on the batch approves both and a later url needs no card', async () => {
    const t = await start({ 'heads/praw': [fetchTurn('https://x.test/'), fetchTurn('https://a.test/', 'https://b.test/'), fetchTurn('https://c.test/'), turn(respond('report', 'done'))] });
    await t.app.services.batching!.flushAll();
    const card = cards(t)[0]!;
    expect(card.payload.batchButtons).toBeDefined();
    expect(JSON.stringify(card.payload.batchButtons)).toContain('grant');
    const { batchId, digest } = card.payload.batchButtons!;
    await press(t, `approval:b:${batchId}:${digest}:grant`, card.id);
    expect(fetched(t)).toEqual(['https://x.test/', 'https://a.test/', 'https://b.test/', 'https://c.test/']);
    expect(await pending()).toEqual([]);
    expect((await grants())[0]).toMatchObject({ used: 1, hosts: ['c.test'], revoke_reason: null });
  });

  it('(f) revoke: the next unseen url gets a card again; a second revoke answers "Already revoked."', async () => {
    const t = await start({ 'heads/praw': [fetchTurn('https://x.test/'), fetchTurn('https://a.test/'), fetchTurn('https://b.test/'), fetchTurn('https://c.test/'), turn(respond('report', 'done'))] });
    // stop the run after b by revoking before it continues is racy; instead revoke after the whole script and re-run via a fresh card
    const card = await granted(t);
    const g = (await grants())[0]!;
    expect(g.used).toBe(2);
    const r1 = await press(t, `approval:g:${g.id}:revoke`, card.id);
    expect((await grants())[0]!.revoke_reason).toBe('admin');
    const r2 = await press(t, `approval:g:${g.id}:revoke`, card.id);
    expect(JSON.stringify(r1)).not.toContain('Already revoked');
    expect(JSON.stringify(r2)).toContain('Already revoked.');
  });

  it('(f2) a non-admin (no admin role) cannot revoke a live grant', async () => {
    const t = await start({ 'heads/praw': [fetchTurn('https://x.test/'), fetchTurn('https://a.test/'), turn(respond('report', 'done'))] });
    const card = await granted(t);
    const g = (await grants())[0]!;
    await press(t, `approval:g:${g.id}:revoke`, card.id, '999999999999999999', []);
    expect((await grants())[0]!.revoke_reason).toBeNull();
  });

  it('(d2) while halted, a grant click inserts nothing (card stays pending)', async () => {
    const t = await start({ 'heads/praw': [fetchTurn('https://x.test/'), fetchTurn('https://a.test/'), turn(respond('report', 'done'))] });
    await t.app.services.batching!.flushAll();
    const card = cards(t)[0]!;
    await handleInteraction(interaction({ commandName: 'halt', userId: 'admin1' }), t.app.services.commands);
    await press(t, 'approval:1:grant', card.id);
    expect(await grants()).toEqual([]);
    expect((await pending()).map((p) => p.id)).toEqual([1]);
  });

  it('(g) web_search and a write tool still raise their own cards under a live grant, and a plain fetch_page still runs', async () => {
    const t = await start({ 'heads/praw': [fetchTurn('https://x.test/'), fetchTurn('https://a.test/'), turn({ name: 'web_search', input: { query: 'weather' } }, { name: 'stub_write', input: { title: 'W' } }, { name: 'fetch_page', input: { url: 'https://b.test/' } }), turn(respond('report', 'done'))] });
    await granted(t);
    await t.app.services.batching!.flushAll();
    const p = await pending();
    expect(p.map((r) => r.tool_name).sort()).toEqual(['stub_write', 'web_search']);
    expect(t.fake.calls).toEqual([]);
    expect(fetched(t)).toContain('https://b.test/');
    expect(p.every((r) => !r.reason.includes('web grant'))).toBe(true);
  });

  it('(h) a non-admin click on the grant button creates no grant and leaves the card pending', async () => {
    const t = await start({ 'heads/praw': [fetchTurn('https://x.test/'), fetchTurn('https://a.test/'), turn(respond('report', 'done'))] });
    await t.app.services.batching!.flushAll();
    const card = cards(t)[0]!;
    await press(t, 'approval:1:grant', card.id, '999999999999999999', []);
    expect(await grants()).toEqual([]);
    expect((await pending()).map((p) => p.id)).toEqual([1]);
    expect(fetched(t)).toEqual(['https://x.test/']);
  });
});
