import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../../app.js';
import { seed } from '../../company/index.js';
import type { ActorRef } from '../../company/types.js';
import { ChannelMapRepo, DepartmentRepo, PersonaRepo, TaskRepo } from '../../db/repos/index.js';
import { JobRepo } from '../../db/repos/jobs.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { handleInteraction } from '../../discord/index.js';
import { interaction } from '../../discord/commands/test-helpers.js';
import { PROMPTS_DIR, loadPrompts } from '../../prompts/index.js';
import { ActorProvider, CONFIG_CHANNEL, TestPort, boot, migrateUp, resetDb, respond, turn } from './helpers.js';

/**
 * TREEGRANT-1 end to end through the real app: a scheduled Praw run (never `direct`) files a write_file card -> "Approve the whole task" -> the owner run
 * writes more files without cards -> uncovered calls still ask -> revoke / halt / root end / switch off. Real repos wired as app.ts wires them.
 */
const PRAW_WORK = '1565999999999999001';
const ADMIN = '123456789012345678';
let db: TestDb;
let app: App | null = null;
let base: string;
const praw: ActorRef = { kind: 'head', dept: 'praw' };

/** The real port plus a record of the revoke argument closeCard receives (the app must pass it through: the fake's own signature drops it). */
class RecordingPort extends TestPort {
  revokes: { messageId: string; note: string; revoke: unknown }[] = [];
  override async closeCard(channelId: string, messageId: string, note: string, revoke?: number | { task: number }): Promise<void> {
    this.revokes.push({ messageId, note, revoke });
    await super.closeCard(channelId, messageId, note);
  }
}

beforeAll(async () => { db = await freshDb(); });
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'tg-app-int-')); });
afterEach(async () => { await app?.stop(); app = null; await resetDb(db.pool); await db.pool.query('TRUNCATE scheduled_jobs RESTART IDENTITY'); rmSync(base, { recursive: true, force: true }); });
afterAll(async () => { await db.close(); });

const FORUM = '1565999999999999555';
const write = (path: string, extra: Record<string, unknown> = {}) => ({ name: 'write_file', input: { path, content: `content of ${path}`, ...extra } });
const post = (title: string) => ({ name: 'forum_post', input: { forum: FORUM, title, body: `body of ${title}` } });

async function seedOrg() {
  await migrateUp(db.pool);
  await seed({ departments: new DepartmentRepo(db.pool), personas: new PersonaRepo(db.pool), channelMap: new ChannelMapRepo(db.pool) }, loadPrompts(PROMPTS_DIR));
  await db.pool.query("UPDATE departments SET provider = 'claude', model = 'claude-sonnet-5-5', work_channel_id = $1 WHERE id = 'praw'", [PRAW_WORK]);
  await db.pool.query("INSERT INTO channel_map (channel_id, dept_id, is_work) VALUES ($1, 'praw', false)", [FORUM]); // praw's own forum
}

async function start(script: ConstructorParameters<typeof ActorProvider>[0], o: { run?: boolean } = {}) {
  await seedOrg();
  const port = new RecordingPort();
  port.snowflakes = true;
  port.forums.set(FORUM, { id: FORUM, name: 'ideas', tags: [] });
  const root = join(base, 'ws');
  const t = await boot(db.pool, { provider: new ActorProvider(script), port, approvalBatching: { windowMs: 600_000 }, env: { prawWorkspaceDir: root } });
  app = t.app;
  if (o.run !== false) {
    await new JobRepo(db.pool).add({ guildId: 'g', channelId: PRAW_WORK, userId: '42', prompt: 'write the files', origin: 'schedule', kind: 'daily', hhmm: '09:00', tz: 'Asia/Bangkok', nextRunAt: new Date(Date.now() - 60_000) }, 'unlimited');
    await t.app.services.jobRunner.tick();
    await t.app.services.jobRunner.tick();
    await t.app.services.scheduler.idle();
  }
  return { ...t, port, root };
}
type Started = Awaited<ReturnType<typeof start>>;
const cards = (t: Started) => t.port.posts.filter((p) => p.target.channelId === CONFIG_CHANNEL && p.payload.type === 'approval');
const press = async (t: Started, customId: string, messageId: string) => {
  const r = await handleInteraction(interaction({ kind: 'button', customId, userId: ADMIN, messageId, messageAuthorId: 'hq' }), t.app.services.commands);
  await t.app.services.scheduler.idle();
  return r;
};
const tg = async () => (await db.pool.query<{ id: number; used: number; max_calls: number; used_by_tool: Record<string, number>; revoke_reason: string | null; card_message_id: string | null; card_channel_id: string | null; web_grant_id: number | null; root_id: string }>('SELECT * FROM task_grants ORDER BY id')).rows;
const wg = async () => (await db.pool.query<{ id: number; revoke_reason: string | null; card_message_id: string | null }>('SELECT id, revoke_reason, card_message_id FROM web_grants ORDER BY id')).rows;
const pending = async () => (await db.pool.query<{ id: number; reason: string; tool_name: string }>("SELECT id, reason, tool_name FROM approvals WHERE status = 'pending' ORDER BY id")).rows;
const audits = async (like: string) => (await db.pool.query<{ action: string; outcome: string; tool: string | null }>('SELECT action, outcome, tool FROM audit_log WHERE action LIKE $1 ORDER BY id', [like])).rows;

describe('task-tree grant through the real app', () => {
  it('grant on the first card: the approved call replays without consuming, the owner run posts b and c without cards, a write_file still asks (tainted run), then revoke ends it', async () => {
    const t = await start({ 'heads/praw': [turn(post('a')), turn(post('b'), post('c'), write('x.txt')), turn(respond('report', 'done'))] });
    await t.app.services.batching!.flushAll();
    expect(cards(t)).toHaveLength(1);
    const card = cards(t)[0]!;
    expect(card.payload.buttons).toEqual({ approvalId: '1', task: true });
    expect(card.payload.body).toContain('Approve the whole task');
    expect(card.payload.body).toContain('also allows web reading'); // web.taskGrant.enabled defaults on
    expect(t.port.forumCreated).toEqual([]);

    await press(t, 'approval:1:task', card.id);
    // post a (the card's own call) ran through runApproved and did not consume; b and c came from the grant with no new card
    expect(t.port.forumCreated.map((f) => f.title)).toEqual(['a', 'b', 'c']);
    const [g] = await tg();
    expect(g).toMatchObject({ used: 2, max_calls: 40, used_by_tool: { forum_post: 2 }, revoke_reason: null, card_message_id: card.id, card_channel_id: CONFIG_CHANNEL });
    // TG-C10: the companion web grant exists, linked, with no card id of its own
    const [w] = await wg();
    expect(w).toMatchObject({ revoke_reason: null, card_message_id: null });
    expect(g!.web_grant_id).toBe(w!.id);
    // TG-C4: the run that resumes after an approval carries approved results, so it is tainted: write_file is never covered there and got its own card
    expect((await pending()).map((p) => p.tool_name)).toEqual(['write_file']);
    expect((await pending())[0]!.reason).toContain('task grant not applied: not_covered');
    expect(existsSync(join(t.root, 'x.txt'))).toBe(false);
    // the card was closed in place and the REVOKE ARGUMENT REACHED THE PORT (the app's cards.close must forward it)
    expect(t.port.revokes.at(-1)).toMatchObject({ messageId: card.id, revoke: { task: Number(g!.id) } });
    expect(t.port.revokes.at(-1)!.note).toContain('every department and persona in this task tree');
    expect(t.port.revokes.at(-1)!.note).toContain('Used 0/40');

    // a forged revoke (another message) does nothing; the real one ends both grants
    await press(t, `approval:t:${g!.id}:revoke`, '1570000000000000777');
    expect((await tg())[0]!.revoke_reason).toBeNull();
    await press(t, `approval:t:${g!.id}:revoke`, card.id);
    expect((await tg())[0]!.revoke_reason).toBe('admin');
    expect((await wg())[0]!.revoke_reason).toBe('admin');
    const use = await audits('task_grant.%');
    expect(use.map((a) => a.action)).toEqual(['task_grant.use', 'task_grant.use', 'task_grant.use', 'task_grant.revoke']);
    expect(use[0]!.outcome).toBe('none'); // before the click: a had no grant yet and got its card
    expect(use[1]!.outcome).toBe(`ok #${g!.id} 1/40`);
    expect(use[2]!.outcome).toBe(`ok #${g!.id} 2/40`);
    expect(use[3]).toMatchObject({ outcome: `admin #${g!.id}` });
    expect(use.every((a) => a.tool === null || a.tool === 'forum_post')).toBe(true);
    expect((await audits('approval.task_grant'))[0]!.outcome).toBe(`ok #1 grant #${g!.id} web_grant #${w!.id}`);
  });

  it('a halt revokes the task grant and its companion web grant at once', async () => {
    const t = await start({ 'heads/praw': [turn(post('a')), turn(write('x.txt')), turn(respond('report', 'done'))] });
    await t.app.services.batching!.flushAll();
    await press(t, 'approval:1:task', cards(t)[0]!.id);
    expect((await tg())[0]!.revoke_reason).toBeNull();
    await t.app.services.halt.halt('admin');
    await new Promise((r) => setTimeout(r, 100));
    expect((await tg())[0]!.revoke_reason).toBe('halt');
    expect((await wg())[0]!.revoke_reason).toBe('halt');
  });

  it('the root of the tree ending revokes the grant with root_ended and closes the card (TG-C18)', async () => {
    const t = await start({ 'heads/praw': [turn(post('a')), turn(post('b'), write('x.txt')), turn(respond('report', 'done'))] });
    await t.app.services.batching!.flushAll();
    await press(t, 'approval:1:task', cards(t)[0]!.id);
    const root = (await db.pool.query<{ id: string }>("SELECT id FROM tasks WHERE parent_id IS NULL ORDER BY created_at LIMIT 1")).rows[0]!.id;
    const open = (await pending())[0]; // the carded write_file
    expect(open).toBeDefined();
    await t.app.services.approvals.decide(open!.id, 'rejected', { id: ADMIN, isAdmin: true }); // cancels the waiting root: task.changed with id === rootId
    await t.app.services.scheduler.idle();
    await new Promise((r) => setTimeout(r, 100));
    const row = (await tg())[0]!;
    expect(row.root_id).toBe(root);
    expect(row.revoke_reason).toBe('root_ended');
    expect((await wg())[0]!.revoke_reason).toBe('admin');
    expect(t.port.revokes.some((r) => r.note.includes('the task ended'))).toBe(true);
  });

  it('with the switch off at runtime no card carries the button, and flipping it off revokes live grants (TG-C8)', async () => {
    const t = await start({ 'heads/praw': [turn(post('a')), turn(write('x.txt')), turn(respond('report', 'done'))] });
    await t.app.services.batching!.flushAll();
    await press(t, 'approval:1:task', cards(t)[0]!.id);
    expect((await tg())[0]!.revoke_reason).toBeNull();
    await t.app.services.cfg.set('taskGrant.enabled', false, 'psql');
    await new Promise((r) => setTimeout(r, 100));
    expect((await tg())[0]!.revoke_reason).toBe('disabled');
  });

  it('with the switch off the card has no task button and a stale click is refused with the card left pending', async () => {
    await migrateUp(db.pool);
    await db.pool.query("INSERT INTO config (key, value, updated_by) VALUES ('taskGrant.enabled', 'false'::jsonb, 'test')");
    const t = await start({ 'heads/praw': [turn(post('a')), turn(respond('report', 'waiting'))] });
    await t.app.services.batching!.flushAll();
    expect(cards(t)[0]!.payload.buttons).toEqual({ approvalId: '1' });
    await press(t, 'approval:1:task', cards(t)[0]!.id);
    expect(await tg()).toEqual([]);
    expect((await pending()).map((p) => p.id)).toEqual([1]);
  });

  const seedGrant = async () => {
    await seedOrg();
    const root = await new TaskRepo(db.pool).create({ id: 'root-tg', title: 't', deptId: 'praw', owner: praw, requester: { kind: 'human', userId: '1' }, origin: 'chat' });
    const a = await db.pool.query<{ id: number }>("INSERT INTO approvals (task_id, reason, est_cost_usd, requested_by, kind, tool_name, tool_input, input_sha256, status) VALUES ($1,'r',0,'head:praw','tool','write_file','{}'::jsonb,'x','approved') RETURNING id", [root.id]);
    await db.pool.query("INSERT INTO task_grants (root_id, approval_id, granted_by, requested_by, max_calls, expires_at) VALUES ('root-tg', $1, $2, 'head:praw', 40, now() + interval '4 hours')", [a.rows[0]!.id, ADMIN]);
  };

  it('boot: a grant older than the halted row is revoked; a newer one survives; boot while halted revokes all; boot with the switch off revokes (TG-C7, TG-C8)', async () => {
    await seedGrant();
    await db.pool.query("INSERT INTO config (key, value, updated_by) VALUES ('halted', 'false'::jsonb, 'psql') ON CONFLICT (key) DO UPDATE SET updated_at = now()");
    const t = await boot(db.pool, { provider: new ActorProvider({}), start: false });
    app = t.app;
    expect((await tg())[0]).toMatchObject({ revoke_reason: 'halt' });
    await t.app.stop(); app = null;

    await db.pool.query('DELETE FROM task_grants');
    await db.pool.query("INSERT INTO task_grants (root_id, approval_id, granted_by, requested_by, max_calls, expires_at) SELECT 'root-tg', id, $1, 'head:praw', 40, now() + interval '4 hours' FROM approvals LIMIT 1", [ADMIN]);
    const t1 = await boot(db.pool, { provider: new ActorProvider({}), start: false });
    expect((await tg())[0]!.revoke_reason).toBeNull(); // newer than the halted row: survives
    await t1.app.stop();
    await db.pool.query("UPDATE config SET value = 'true'::jsonb WHERE key = 'halted'");
    const t2 = await boot(db.pool, { provider: new ActorProvider({}), start: false });
    expect((await tg())[0]!.revoke_reason).toBe('halt');
    await t2.app.stop();
    await db.pool.query("UPDATE config SET value = 'false'::jsonb WHERE key = 'halted'");
    await db.pool.query("UPDATE task_grants SET revoked_at = NULL, revoked_by = NULL, revoke_reason = NULL");
    await db.pool.query("INSERT INTO config (key, value, updated_by) VALUES ('taskGrant.enabled', 'false'::jsonb, 't')");
    await db.pool.query("UPDATE config SET updated_at = now() - interval '1 day' WHERE key = 'halted'");
    const t3 = await boot(db.pool, { provider: new ActorProvider({}), start: false });
    app = t3.app;
    expect((await tg())[0]!.revoke_reason).toBe('disabled');
  });

  it('startup refuses conversationHours above hours (TG-C16)', async () => {
    await migrateUp(db.pool);
    await db.pool.query("INSERT INTO config (key, value, updated_by) VALUES ('taskGrant.hours', '2'::jsonb, 't'), ('taskGrant.conversationHours', '4'::jsonb, 't')");
    await expect(boot(db.pool, { provider: new ActorProvider({}), start: false })).rejects.toThrow(/conversationHours must not exceed/);
  });
});
