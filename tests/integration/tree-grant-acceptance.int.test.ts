import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App } from '../../app.js';
import { seed } from '../../company/index.js';
import { ChannelMapRepo, DepartmentRepo, PersonaRepo } from '../../db/repos/index.js';
import { JobRepo } from '../../db/repos/jobs.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { handleInteraction } from '../../discord/index.js';
import { interaction } from '../../discord/commands/test-helpers.js';
import { CONFIG_DEFAULTS } from '../../config/defaults.js';
import { PROMPTS_DIR, loadPrompts } from '../../prompts/index.js';
import type { GroupFactory } from '../../tools/plugins/index.js';
import type { ToolPlugin } from '../../tools/types.js';
import { fakeResolver, fakeTransport } from '../fakes/net.js';
import { ActorProvider, CONFIG_CHANNEL, TestPort, boot, migrateUp, resetDb, respond, turn } from './helpers.js';

// R4 PM-C9: each stub takes the class of the real tool it stands for (an undeclared name is fail-closed). Only this seam; DERIVED stays the real one.
vi.mock('../../tools/manifest/catalog.js', async (orig) => {
  const { withTestClasses } = await import('../fakes/tool-classes.js');
  const real = await orig<typeof import('../../tools/manifest/catalog.js')>();
  const standsFor = { stub_cu_create: 'clickup_create_task', stub_image: 'image_generate', stub_gh_pr: 'github_create_pull_request', stub_cu_delete: 'clickup_delete_task' };
  return withTestClasses(real, Object.fromEntries(Object.entries(standsFor).map(([stub, r]) => [stub, { ...real.classOf(r), group: 'test' }])));
});

/**
 * TREEGRANT-1 acceptance (tester, stage 6): the owner scenarios through the real app (real repos, real registry, real card router),
 * independent of the developer suite (tree-grant-app.int.test.ts). Stub tools carry the real NAMES of the always-ask tools
 * (ClickUp, image, GitHub, schedule, delete) so the allow-list is what decides, not the stub.
 */
const PRAW_WORK = '1565999999999999001';
const FORUM = '1565999999999999555';
const SW_FORUM = '1565999999999999556';
const ADMIN = '123456789012345678';
let db: TestDb;
let app: App | null = null;
let base: string;

class RecPort extends TestPort {
  closes: { messageId: string; note: string; revoke: unknown }[] = [];
  notes: { messageId: string; note: string }[] = [];
  override async closeCard(channelId: string, messageId: string, note: string, revoke?: number | { task: number }): Promise<void> {
    this.closes.push({ messageId, note, revoke });
    await super.closeCard(channelId, messageId, note);
  }
  allPublic = true;
  override async channelIsPublic(id: string): Promise<boolean> { return this.allPublic ? true : super.channelIsPublic(id); }
  async noteCard(_c: string, messageId: string, note: string): Promise<void> { this.notes.push({ messageId, note }); }
}

beforeAll(async () => { db = await freshDb(); });
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'tg-acc-')); });
afterEach(async () => { await app?.stop(); app = null; await resetDb(db.pool); await db.pool.query('TRUNCATE scheduled_jobs RESTART IDENTITY'); rmSync(base, { recursive: true, force: true }); });
afterAll(async () => { await db.close(); });

// R4 (PM-C10): a test group may not reuse a declared tool name, so the four stubs carry stub_ names and (through the file-local catalog mock above) the class of the real tool they stand for.
const STUBS = ['stub_cu_create', 'stub_image', 'stub_gh_pr', 'stub_cu_delete'];
const SCHED = { name: 'schedule_add', input: { prompt: 'x', kind: 'daily', hhmm: '10:00' } };
const stubCalls: string[] = [];
const stubGroup: GroupFactory = () => ({
  id: 'stubs',
  tools: STUBS.map((name) => ({
    name, description: name, kind: 'write', inputSchema: z.object({ title: z.string() }), requiresApproval: () => false,
    run: async () => { stubCalls.push(name); return { content: `ran ${name}` }; },
  }) as ToolPlugin<any>),
});

const write = (path: string, extra: Record<string, unknown> = {}) => ({ name: 'write_file', input: { path, content: `c ${path}`, ...extra } });
const post = (title: string, forum = FORUM) => ({ name: 'forum_post', input: { forum, title, body: `body ${title}` } });
const stub = (name: string) => ({ name, input: { title: `t-${name}` } });
const fwd = () => ({ name: 'forward_to', input: { dept: 'software', summary: 'please build it', reason: 'engineering work', duty: 'engineering', estCostUsd: 0.1 } });

async function start(script: ConstructorParameters<typeof ActorProvider>[0], o: { cfg?: Record<string, unknown>; publicSrc?: boolean; run?: boolean } = {}) {
  stubCalls.length = 0;
  await migrateUp(db.pool);
  await seed({ departments: new DepartmentRepo(db.pool), personas: new PersonaRepo(db.pool), channelMap: new ChannelMapRepo(db.pool) }, loadPrompts(PROMPTS_DIR));
  await db.pool.query("UPDATE departments SET provider = 'claude', model = 'claude-sonnet-5-5', work_channel_id = $1 WHERE id = 'praw'", [PRAW_WORK]);
  await db.pool.query("UPDATE departments SET provider = 'claude', model = 'claude-sonnet-5-5' WHERE id = 'software'");
  await db.pool.query("INSERT INTO channel_map (channel_id, dept_id, is_work) VALUES ($1, 'praw', false), ($2, 'software', false)", [FORUM, SW_FORUM]);
  for (const [k, v] of Object.entries(o.cfg ?? {})) await db.pool.query("INSERT INTO config (key, value, updated_by) VALUES ($1, $2::jsonb, 'test')", [k, JSON.stringify(v)]);
  const port = new RecPort();
  port.snowflakes = true;
  port.forums.set(FORUM, { id: FORUM, name: 'ideas', tags: [] });
  port.forums.set(SW_FORUM, { id: SW_FORUM, name: 'sw', tags: [] });
  port.allPublic = o.publicSrc !== false;
  const t = await boot(db.pool, { provider: new ActorProvider(script), port, groups: [stubGroup], approvalBatching: { windowMs: 600_000 }, env: { prawWorkspaceDir: join(base, 'ws') }, net: { resolver: fakeResolver({}), transport: fakeTransport({}) } });
  app = t.app;
  if (o.run !== false) {
    await new JobRepo(db.pool).add({ guildId: 'g', channelId: PRAW_WORK, userId: '42', prompt: 'do the work', origin: 'schedule', kind: 'daily', hhmm: '09:00', tz: 'Asia/Bangkok', nextRunAt: new Date(Date.now() - 60_000) }, 'unlimited');
    await t.app.services.jobRunner.tick();
    await t.app.services.jobRunner.tick();
    await t.app.services.scheduler.idle();
  }
  return { ...t, port };
}
type S = Awaited<ReturnType<typeof start>>;
const cards = (t: S) => t.port.posts.filter((p) => p.target.channelId === CONFIG_CHANNEL && p.payload.type === 'approval');
const press = async (t: S, customId: string, messageId: string, opts: { userId?: string; roles?: string[] } = {}) => {
  const r = await handleInteraction(interaction({ kind: 'button', customId, userId: opts.userId ?? ADMIN, messageId, messageAuthorId: 'hq', ...(opts.roles ? { roles: opts.roles } : {}) }), t.app.services.commands);
  await t.app.services.scheduler.idle();
  return r;
};
const idle = (t: S) => t.app.services.scheduler.idle();
const q = async <T>(sql: string, p: unknown[] = []) => (await db.pool.query(sql, p)).rows as T[];
const tg = () => q<{ id: number; used: number; max_calls: number; used_by_tool: Record<string, number>; revoke_reason: string | null; card_message_id: string | null; web_grant_id: number | null; created_at: Date; expires_at: Date; root_id: string }>('SELECT * FROM task_grants ORDER BY id');
const wg = () => q<{ id: number; revoke_reason: string | null }>('SELECT id, revoke_reason FROM web_grants ORDER BY id');
const pending = () => q<{ id: number; reason: string; tool_name: string; input: Record<string, unknown> }>("SELECT id, reason, tool_name, tool_input AS input FROM approvals WHERE status = 'pending' ORDER BY id");
const tasks = () => q<{ id: string; dept_id: string; status: string; tainted: boolean; parent_id: string | null }>('SELECT id, dept_id, status, tainted, parent_id FROM tasks ORDER BY created_at');
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

describe('TREEGRANT-1 acceptance (real app)', () => {
  it('(a)(b)(c)(i) first card forum_post -> button -> approve+grant+companion web grant; 5 covered posts + child dept post run with no card; uncovered tools and overwrite and tainted write_file stay carded; wider forward is carded', async () => {
    const t = await start({
      'heads/praw': [
        turn(post('a')),
        turn(post('b'), post('c'), post('d'), post('e'), post('f'), fwd(), ...STUBS.map(stub), SCHED, write('new.txt'), write('old.txt', { overwrite: true })),
        turn(respond('report', 'done')),
      ],
      'heads/software': [turn(post('child-1', SW_FORUM), post('child-2', SW_FORUM)), turn(respond('report', 'built'))],
    }, { cfg: { 'forum.postsPerHeadPerDay': 50, 'tools.byDept': { ...CONFIG_DEFAULTS['tools.byDept'], software: [...CONFIG_DEFAULTS['tools.byDept']['software']!, 'forum_post'] } } });
    await t.app.services.batching!.flushAll();
    const first = cards(t)[0]!;
    // (a) the button is offered on the first covered card and says what it does
    expect(first.payload.buttons).toEqual({ approvalId: '1', task: true });
    expect(first.payload.body).toContain('Approve the whole task');
    expect(t.port.forumCreated).toEqual([]);
    await press(t, 'approval:1:task', first.id);
    await t.app.services.batching!.flushAll();
    await idle(t);

    const titles = t.port.forumCreated.map((f) => f.title);
    expect(titles).toEqual(expect.arrayContaining(['a', 'b', 'c', 'd', 'e', 'f', 'child-1', 'child-2']));
    const [g] = await tg();
    // approved call + grant + companion
    expect(g).toMatchObject({ revoke_reason: null, max_calls: 40 });
    expect(g!.web_grant_id).not.toBeNull();
    expect((await wg())[0]!.revoke_reason).toBeNull();
    // 5 praw posts + 1 forward_to + 2 child posts consumed (a itself replayed through runApproved)
    expect(g!.used_by_tool).toEqual({ forum_post: 7, forward_to: 1 });
    expect(g!.used).toBe(8);
    // (b)+(c)+(i): everything else still carded
    const p = await pending();
    // LEARN-1 LL-C2: this run is tainted (it resumes with an approved result), so schedule_add is refused in its precheck and files no card at all (it was carded before)
    expect(p.map((r) => r.tool_name).sort()).toEqual([...STUBS, 'write_file', 'write_file'].sort());
    for (const r of p) expect(r.reason).toContain('tool ');
    expect(stubCalls).toEqual([]);
    const wf = p.filter((r) => r.tool_name === 'write_file');
    expect(wf.map((r) => r.reason.match(/task grant not applied: (\w+)/)?.[1])).toEqual(['not_covered', 'not_covered']); // tainted resume + overwrite
    // child dept task exists and is tainted (it inherits the owner run's taint)
    const rows = await tasks();
    expect(rows.some((r) => r.dept_id === 'software')).toBe(true);
    // the usage line is edited in place, debounced (code-built names + integers only)
    await settle(16_000);
    const note = t.port.notes.at(-1);
    expect(note?.note).toMatch(/Used 8\/40/);
    expect(note?.note).toMatch(/forum_post×7/);
    expect(note?.note).toMatch(/forward_to×1/);
  }, 60_000);

  it('(c2) forward_to to a wider room (source not public) is carded under a live grant', async () => {
    const t = await start({ 'heads/praw': [turn(post('a')), turn(fwd()), turn(respond('report', 'done'))] }, { publicSrc: false });
    await t.app.services.batching!.flushAll();
    await press(t, 'approval:1:task', cards(t)[0]!.id);
    await t.app.services.batching!.flushAll();
    const p = await pending();
    expect(p.map((r) => r.tool_name)).toEqual(['forward_to']);
    expect(p[0]!.reason).toContain('task grant not applied: not_covered');
    expect((await tg())[0]!.used_by_tool).toEqual({});
  });

  it('(c3) first card write_file (untainted first run): button offered; after the click the resumed run is tainted and a second NEW write_file is carded', async () => {
    const t = await start({ 'heads/praw': [turn(write('one.txt')), turn(write('two.txt')), turn(respond('report', 'done'))] });
    await t.app.services.batching!.flushAll();
    expect(cards(t)[0]!.payload.buttons).toEqual({ approvalId: '1', task: true });
    await press(t, 'approval:1:task', cards(t)[0]!.id);
    await t.app.services.batching!.flushAll();
    const p = await pending();
    expect(p.map((r) => r.tool_name)).toEqual(['write_file']);
    expect(p[0]!.reason).toContain('task grant not applied: not_covered');
    const [g] = await tg();
    expect(g!.used).toBe(0);
    expect((await tasks())[0]).toMatchObject({ tainted: true }); // the approved result taints the task for good (G2-04)
  });

  it('(d) with the cap at 3 the 4th covered call gets a card naming cap_calls; ending the root revokes the grant, the companion and closes the card', async () => {
    const t = await start({ 'heads/praw': [turn(post('a')), turn(post('b'), post('c'), post('d'), post('e')), turn(respond('report', 'done'))] }, { cfg: { 'taskGrant.maxCalls': 3 } });
    await t.app.services.batching!.flushAll();
    const card = cards(t)[0]!;
    await press(t, 'approval:1:task', card.id);
    await t.app.services.batching!.flushAll();
    expect((await tg())[0]).toMatchObject({ used: 3, max_calls: 3, revoke_reason: null });
    const p = await pending();
    expect(p).toHaveLength(1);
    expect(p[0]!.reason).toContain('task grant not applied: cap_calls');
    // end the root: reject the waiting card -> the root is cancelled
    await t.app.services.approvals.decide(p[0]!.id, 'rejected', { id: ADMIN, isAdmin: true });
    await idle(t);
    await settle();
    expect((await tg())[0]!.revoke_reason).toBe('root_ended');
    expect((await wg())[0]!.revoke_reason).toBe('admin');
    expect(t.port.closes.some((c) => c.messageId === card.id && c.note.includes('the task ended'))).toBe(true);
  });

  it('(d2) a conversation root closes after the owner run finishes: the grant ends with root_ended (what the lifetime really is)', async () => {
    const t = await start({ 'heads/praw': [turn(post('a')), turn(post('b'), post('c')), turn(respond('report', 'done'))] });
    await t.app.services.batching!.flushAll();
    await press(t, 'approval:1:task', cards(t)[0]!.id);
    await t.app.services.batching!.flushAll();
    await idle(t);
    await settle();
    const [g] = await tg();
    expect(g!.used).toBe(2);
    expect(g!.revoke_reason).toBe('root_ended'); // the conversation root went done when the owner run ended: the grant lives only as long as the tree is open
    expect((await tasks())[0]).toMatchObject({ status: 'done', tainted: true });
  });

  it('(e) halt revokes both grants; resume does not restore them; the next covered call is carded', async () => {
    const t = await start({ 'heads/praw': [turn(post('a')), turn(write('x.txt')), turn(respond('report', 'done'))] });
    await t.app.services.batching!.flushAll();
    await press(t, 'approval:1:task', cards(t)[0]!.id);
    await t.app.services.halt.halt('admin');
    await settle();
    expect((await tg())[0]!.revoke_reason).toBe('halt');
    expect((await wg())[0]!.revoke_reason).toBe('halt');
    await t.app.services.halt.resume('admin');
    await settle();
    expect((await tg())[0]!.revoke_reason).toBe('halt'); // still revoked
    // the consume itself refuses
    const r = await db.pool.query("UPDATE task_grants SET used = used WHERE revoked_at IS NULL RETURNING id");
    expect(r.rowCount).toBe(0);
  });

  it('(f) revoke button: a non-admin is refused, a forged message id is refused, the admin on the own card ends both grants', async () => {
    const t = await start({ 'heads/praw': [turn(post('a')), turn(write('x.txt')), turn(respond('report', 'done'))] });
    await t.app.services.batching!.flushAll();
    const card = cards(t)[0]!;
    await press(t, 'approval:1:task', card.id);
    const [g] = await tg();
    const id = `approval:t:${g!.id}:revoke`;
    await press(t, id, card.id, { userId: '999999999999999999', roles: [] });
    expect((await tg())[0]!.revoke_reason).toBeNull();
    await press(t, id, '1570000000000000777');
    expect((await tg())[0]!.revoke_reason).toBeNull();
    await press(t, id, card.id);
    expect((await tg())[0]!.revoke_reason).toBe('admin');
    expect((await wg())[0]!.revoke_reason).toBe('admin');
    // double click is harmless
    await press(t, id, card.id);
    expect((await tg())[0]!.revoke_reason).toBe('admin');
  });

  it('(g) a conversation root gets expires_at = created_at + 4 h (not the 12 h default)', async () => {
    const t = await start({ 'heads/praw': [turn(post('a')), turn(respond('report', 'w'))] });
    await t.app.services.batching!.flushAll();
    await press(t, 'approval:1:task', cards(t)[0]!.id);
    const [g] = await tg();
    const ms = g!.expires_at.getTime() - g!.created_at.getTime();
    expect(Math.round(ms / 3_600_000)).toBe(4);
  });

  it('(h) the web grant revoke button still reaches the port (RecordingPort sees the numeric revoke) and a task-grant batch click works', async () => {
    // batch: two forum posts in one turn -> one batch card -> "Approve all + whole task"
    const t = await start({ 'heads/praw': [turn(post('a'), post('b')), turn(post('c')), turn(respond('report', 'done'))] });
    await t.app.services.batching!.flushAll();
    const card = cards(t)[0]!;
    const bb = card.payload.batchButtons!;
    expect((bb as { task?: unknown }).task).toBeTruthy();
    const { batchId, digest } = bb;
    await press(t, `approval:b:${batchId}:${digest}:task`, card.id);
    await t.app.services.batching!.flushAll();
    const [g] = await tg();
    expect(g).toMatchObject({ card_message_id: card.id });
    expect(t.port.forumCreated.map((f) => f.title).sort()).toEqual(['a', 'b', 'c']);
    expect(g!.used).toBe(1); // c from the grant; a and b replayed approved
    // a plain batch "Approve all" (no task) still works and creates no grant: separate test below
  });

  it('(h2) a plain Approve all on a batch creates no grant', async () => {
    const t = await start({ 'heads/praw': [turn(post('a'), post('b')), turn(respond('report', 'done'))] });
    await t.app.services.batching!.flushAll();
    const card = cards(t)[0]!;
    const { batchId, digest } = card.payload.batchButtons!;
    await press(t, `approval:b:${batchId}:${digest}:approve`, card.id);
    expect(await tg()).toEqual([]);
    expect(t.port.forumCreated.map((f) => f.title).sort()).toEqual(['a', 'b']);
  });

  it('(h3) a mixed batch (forum_post + ClickUp stub) carries no task button; a forged :task click is refused and decides nothing', async () => {
    const t = await start({ 'heads/praw': [turn(post('a'), stub('stub_cu_create')), turn(respond('report', 'done'))] });
    await t.app.services.batching!.flushAll();
    const card = cards(t)[0]!;
    const bb = card.payload.batchButtons!;
    expect((bb as { task?: unknown }).task).toBeFalsy();
    await press(t, `approval:b:${bb.batchId}:${bb.digest}:task`, card.id);
    expect(await tg()).toEqual([]);
    expect((await pending()).length).toBe(2);
    expect(stubCalls).toEqual([]);
  });

  it('(h4) WEBGRANT revoke fix: a fetch_page web grant closes its card WITH the numeric revoke argument', async () => {
    const hosts = { 'x.test': ['93.184.215.14'], 'a.test': ['93.184.215.14'] };
    await migrateUp(db.pool);
    stubCalls.length = 0;
    await seed({ departments: new DepartmentRepo(db.pool), personas: new PersonaRepo(db.pool), channelMap: new ChannelMapRepo(db.pool) }, loadPrompts(PROMPTS_DIR));
    await db.pool.query("UPDATE departments SET provider = 'claude', model = 'claude-sonnet-5-5', work_channel_id = $1 WHERE id = 'praw'", [PRAW_WORK]);
    const port = new RecPort();
    port.snowflakes = true;
    const fetchTurn = (u: string) => turn({ name: 'fetch_page', input: { url: u } });
    const t = await boot(db.pool, { provider: new ActorProvider({ 'heads/praw': [fetchTurn('https://x.test/'), fetchTurn('https://a.test/'), turn(respond('report', 'done'))] }), port, approvalBatching: { windowMs: 600_000 }, net: { resolver: fakeResolver(hosts), transport: fakeTransport({}) } });
    app = t.app;
    await new JobRepo(db.pool).add({ guildId: 'g', channelId: PRAW_WORK, userId: '42', prompt: 'read', origin: 'schedule', kind: 'daily', hhmm: '09:00', tz: 'Asia/Bangkok', nextRunAt: new Date(Date.now() - 60_000) }, 'unlimited');
    await t.app.services.jobRunner.tick();
    await t.app.services.jobRunner.tick();
    await t.app.services.scheduler.idle();
    await t.app.services.batching!.flushAll();
    const card = port.posts.filter((p) => p.target.channelId === CONFIG_CHANNEL && p.payload.type === 'approval')[0]!;
    await handleInteraction(interaction({ kind: 'button', customId: 'approval:1:grant', userId: ADMIN, messageId: card.id, messageAuthorId: 'hq' }), t.app.services.commands);
    await t.app.services.scheduler.idle();
    const w = await q<{ id: number }>('SELECT id FROM web_grants');
    expect(w).toHaveLength(1);
    expect(port.closes.at(-1)).toMatchObject({ messageId: card.id, revoke: Number(w[0]!.id) });
  });
});
