import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../app.js';
import { seed } from '../../company/index.js';
import { ChannelMapRepo, DepartmentRepo, PersonaRepo, TaskRepo } from '../../db/repos/index.js';
import { JobRepo } from '../../db/repos/jobs.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { handleInteraction } from '../../discord/index.js';
import { interaction } from '../../discord/commands/test-helpers.js';
import { PROMPTS_DIR, loadPrompts } from '../../prompts/index.js';
import { fakeResolver, fakeTransport } from '../fakes/net.js';
import { ActorProvider, CONFIG_CHANNEL, TestPort, boot, migrateUp, resetDb, respond, turn } from './helpers.js';

/** WEBGRANT-1 end to end through the real app: solo card -> "Allow web reading" -> the owner run reads more pages without cards -> revoke. */
const PRAW_WORK = '1565999999999999001';
const HOSTS = ['x.test', 'a.test', 'b.test', 'c.test', 'd.test'];
let db: TestDb;
let app: App | null = null;
beforeAll(async () => { db = await freshDb(); });
afterEach(async () => { await app?.stop(); app = null; await resetDb(db.pool); await db.pool.query('TRUNCATE scheduled_jobs RESTART IDENTITY'); });
afterAll(async () => { await db.close(); });

const fetchTurn = (...urls: string[]) => turn(...urls.map((url) => ({ name: 'fetch_page', input: { url } })));

async function start(script: ConstructorParameters<typeof ActorProvider>[0]) {
  await migrateUp(db.pool);
  await seed({ departments: new DepartmentRepo(db.pool), personas: new PersonaRepo(db.pool), channelMap: new ChannelMapRepo(db.pool) }, loadPrompts(PROMPTS_DIR));
  await db.pool.query("UPDATE departments SET provider = 'claude', model = 'claude-sonnet-5-5', work_channel_id = $1 WHERE id = 'praw'", [PRAW_WORK]);
  const resolver = fakeResolver(Object.fromEntries(HOSTS.map((h) => [h, ['93.184.215.14']])));
  const page = { body: '<p>hello</p>' };
  const transport = fakeTransport(Object.fromEntries(HOSTS.map((h) => [`https://${h}/`, page])));
  const port = new TestPort();
  port.snowflakes = true;
  const t = await boot(db.pool, { provider: new ActorProvider(script), port, approvalBatching: { windowMs: 600_000 }, net: { resolver, transport } });
  app = t.app;
  await new JobRepo(db.pool).add({ guildId: 'g', channelId: PRAW_WORK, userId: '42', prompt: 'read the pages', origin: 'schedule', kind: 'daily', hhmm: '09:00', tz: 'Asia/Bangkok', nextRunAt: new Date(Date.now() - 60_000) }, 'unlimited');
  await t.app.services.jobRunner.tick();
  await t.app.services.jobRunner.tick();
  await t.app.services.scheduler.idle();
  return { ...t, port, transport };
}
type Started = Awaited<ReturnType<typeof start>>;
const cards = (t: Started) => t.port.posts.filter((p) => p.target.channelId === CONFIG_CHANNEL && p.payload.type === 'approval');
const press = async (t: Started, customId: string, messageId: string) => {
  const r = await handleInteraction(interaction({ kind: 'button', customId, userId: '123456789012345678', messageId, messageAuthorId: 'hq' }), t.app.services.commands);
  await t.app.services.scheduler.idle();
  return r;
};
const fetched = (t: Started) => t.transport.requests.map((r) => r.url.href);
const grants = async () => (await db.pool.query<{ id: number; used: number; hosts: string[]; revoke_reason: string | null; card_message_id: string | null }>('SELECT id, used, hosts, revoke_reason, card_message_id FROM web_grants ORDER BY id')).rows;
const pending = async () => (await db.pool.query<{ id: number; reason: string }>("SELECT id, reason FROM approvals WHERE status = 'pending' ORDER BY id")).rows;

describe('web grant through the real app', () => {
  it('grant on the first card: the approved url replays without consuming, the owner run reads b and c without cards, then revoke ends it', async () => {
    const t = await start({ 'heads/praw': [fetchTurn('https://x.test/'), fetchTurn('https://a.test/'), fetchTurn('https://b.test/', 'https://c.test/'), turn(respond('report', 'done'))] });
    await t.app.services.batching!.flushAll();
    expect(cards(t)).toHaveLength(1);
    const card = cards(t)[0]!;
    expect(card.payload.buttons).toEqual({ approvalId: '1', grant: true });
    expect(fetched(t)).toEqual(['https://x.test/']);

    await press(t, 'approval:1:grant', card.id);
    // a.test (the approved card's own url) ran through runApproved and did not consume; b and c came from the grant, with no new card
    expect(fetched(t)).toEqual(['https://x.test/', 'https://a.test/', 'https://b.test/', 'https://c.test/']);
    expect(await pending()).toEqual([]);
    const g = (await grants())[0]!;
    expect(g).toMatchObject({ used: 2, hosts: ['b.test', 'c.test'], revoke_reason: null, card_message_id: card.id });
    expect(cards(t)).toHaveLength(1);
    // the card was closed in place with the honest text and the revoke button
    const closed = t.port.closed.at(-1)!;
    expect(JSON.stringify(closed)).toContain('every department working on this task tree');
    expect(JSON.stringify(closed)).toContain('about 4000 characters');

    // a forged revoke (another message) does nothing; the real one ends the grant
    await press(t, `approval:g:${g.id}:revoke`, '1570000000000000777');
    expect((await grants())[0]!.revoke_reason).toBeNull();
    await press(t, `approval:g:${g.id}:revoke`, card.id);
    expect((await grants())[0]!.revoke_reason).toBe('admin');
    const audit = (await db.pool.query<{ action: string; outcome: string }>("SELECT action, outcome FROM audit_log WHERE action LIKE 'approval.grant' OR action LIKE 'web_grant.%' ORDER BY id")).rows;
    expect(audit.map((a) => a.action)).toEqual(['web_grant.consume', 'approval.grant', 'web_grant.consume', 'web_grant.consume', 'web_grant.revoke']);
    expect(audit[0]!.outcome).toBe('none'); // before the grant: a.test missed (no grant yet) and got its card
    expect(audit[1]!.outcome).toBe(`ok #1 grant #${g.id}`);
    expect(audit.slice(2, 4).map((a) => a.outcome)).toEqual([`ok #${g.id} 1/20`, `ok #${g.id} 2/20`]);
    expect(JSON.stringify(audit)).not.toContain('.test');
  });

  it('with the feature switched off the card has no grant button, and a click on a stale grant button is refused with the card left pending', async () => {
    await migrateUp(db.pool);
    await db.pool.query("INSERT INTO config (key, value, updated_by) VALUES ('web.taskGrant.enabled', 'false'::jsonb, 'test')");
    const t = await start({ 'heads/praw': [fetchTurn('https://x.test/'), fetchTurn('https://a.test/'), turn(respond('report', 'waiting'))] });
    await t.app.services.batching!.flushAll();
    expect(cards(t)[0]!.payload.buttons).toEqual({ approvalId: '1' });
    await press(t, 'approval:1:grant', cards(t)[0]!.id);
    expect(await grants()).toEqual([]);
    expect((await pending()).map((p) => p.id)).toEqual([1]);
    expect(fetched(t)).toEqual(['https://x.test/']);
  });

  const seedGrant = async () => {
    await migrateUp(db.pool);
    await seed({ departments: new DepartmentRepo(db.pool), personas: new PersonaRepo(db.pool), channelMap: new ChannelMapRepo(db.pool) }, loadPrompts(PROMPTS_DIR));
    const task = { rows: [await new TaskRepo(db.pool).create({ id: 'root-wg', title: 't', deptId: 'praw', owner: { kind: 'head', dept: 'praw' }, requester: { kind: 'human', userId: '1' }, origin: 'chat' })] };
    const a = await db.pool.query<{ id: number }>("INSERT INTO approvals (task_id, reason, est_cost_usd, requested_by, kind, tool_name, tool_input, input_sha256, status) VALUES ($1,'r',0,'head:praw','tool','fetch_page','{}'::jsonb,'x','approved') RETURNING id", [task.rows[0]!.id]);
    await db.pool.query("INSERT INTO web_grants (root_id, approval_id, granted_by, requested_by, max_fetches, max_hosts, max_url_chars, expires_at) VALUES ('root-wg', $1, '123456789012345678', 'head:praw', 20, 5, 4000, now() + interval '4 hours')", [a.rows[0]!.id]);
  };

  it('boot: a grant older than the halted row (a halt and resume while the process was down) is revoked; a newer one survives', async () => {
    await seedGrant();
    await db.pool.query("INSERT INTO config (key, value, updated_by) VALUES ('halted', 'false'::jsonb, 'psql') ON CONFLICT (key) DO UPDATE SET updated_at = now()");
    const t = await boot(db.pool, { provider: new ActorProvider({}), start: false });
    app = t.app;
    expect((await grants())[0]).toMatchObject({ revoke_reason: 'halt' });
  });

  it('boot while halted revokes every grant; boot with no halt row leaves a live grant alone', async () => {
    await seedGrant();
    const t0 = await boot(db.pool, { provider: new ActorProvider({}), start: false });
    expect((await grants())[0]!.revoke_reason).toBeNull();
    await t0.app.stop();
    await db.pool.query("INSERT INTO config (key, value, updated_by) VALUES ('halted', 'true'::jsonb, 'psql') ON CONFLICT (key) DO UPDATE SET value = 'true'::jsonb");
    const t1 = await boot(db.pool, { provider: new ActorProvider({}), start: false });
    app = t1.app;
    expect((await grants())[0]!.revoke_reason).toBe('halt');
  });

  it('startup refuses maxHosts above maxFetches (D4)', async () => {
    await migrateUp(db.pool);
    await db.pool.query("INSERT INTO config (key, value, updated_by) VALUES ('web.taskGrant.maxFetches', '3'::jsonb, 't'), ('web.taskGrant.maxHosts', '10'::jsonb, 't')");
    await expect(boot(db.pool, { provider: new ActorProvider({}), start: false })).rejects.toThrow(/maxHosts must not exceed/);
  });
});
