import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../app.js';
import { seed } from '../../company/index.js';
import { ChannelMapRepo, DepartmentRepo, PersonaRepo } from '../../db/repos/index.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { handleInteraction } from '../../discord/commands/index.js';
import { interaction } from '../../discord/commands/test-helpers.js';
import { PROMPTS_DIR, loadPrompts } from '../../prompts/index.js';
import { ADMIN_ROLE, BOT_IDS, CONFIG_CHANNEL, ActorProvider, boot, humanMsg, migrateUp, resetDb, turn, type Booted } from './helpers.js';

const ADMIN = '900000000000000001';
const PRAW_WORK = '1565999999999999001';
let db: TestDb;
let b: Booted | null = null;
let app: App | null = null;
beforeAll(async () => { db = await freshDb(); });
afterEach(async () => { await app?.stop(); app = null; b = null; await resetDb(db.pool); await db.pool.query('TRUNCATE admin_cards RESTART IDENTITY'); });
afterAll(async () => { await db.close(); });

async function start(script: Parameters<typeof turn>[0][] | ReturnType<typeof turn>[]) {
  await migrateUp(db.pool);
  await seed({ departments: new DepartmentRepo(db.pool), personas: new PersonaRepo(db.pool), channelMap: new ChannelMapRepo(db.pool) }, loadPrompts(PROMPTS_DIR));
  await db.pool.query("UPDATE departments SET provider = 'claude', model = 'claude-sonnet-5-5', work_channel_id = $1 WHERE id = 'praw'", [PRAW_WORK]);
  const provider = new ActorProvider({ 'heads/praw': script as never });
  b = await boot(db.pool, { provider });
  app = b.app;
  return { provider, s: app.services };
}
const adminMsg = (content: string, over = {}) => humanMsg(content, { channelId: CONFIG_CHANNEL, author: { id: ADMIN, name: 'boss', kind: 'human' }, isAdmin: true, ...over });

describe('admin console end to end (Gate 1 Part A)', () => {
  it('a Bot Admin asks in #setting, Praw proposes, hq posts the card, the click applies the stored change', async () => {
    const { provider, s } = await start([
      turn({ name: 'config_get', input: { key: 'budget.taskUsd' } }),
      turn({ name: 'config_propose', input: { changes: [{ key: 'budget.taskUsd', valueJson: '2' }], note: 'as you asked' } }),
      { text: 'I posted a card for budget.taskUsd 0.5 to 2. It waits for your Confirm.' },
    ]);
    await s.scheduler.onMessage(adminMsg('set the per-task budget to 2 dollars'));
    await s.scheduler.idle();
    const card = b!.port.posts.find((p) => p.payload.adminCardId)!;
    expect(card.actor).toEqual({ kind: 'head', dept: 'hq' });
    expect(card.target).toEqual({ channelId: CONFIG_CHANNEL });
    const reply = b!.port.posts.find((p) => p.actor.kind === 'head' && p.actor.dept === 'praw')!;
    expect(reply.target).toEqual({ channelId: CONFIG_CHANNEL });
    expect(reply.payload.body).toContain('waits for your Confirm');
    expect(s.cfg.get('budget.taskUsd')).toBe(0.5); // nothing yet
    // the run saw only the admin tools
    expect(provider.callsOf('heads/praw')[0]!.tools.map((t) => t.name).sort()).toEqual(['admin_op_propose', 'code_propose', 'code_rollback', 'config_get', 'config_propose', 'deploy_propose', 'deploy_read', 'discord_read', 'perm_propose', 'server_propose', 'site_publish_static']);

    const id = card.payload.adminCardId!;
    const click = interaction({ kind: 'button', customId: `admincfg:${id}:confirm`, userId: ADMIN, roles: [ADMIN_ROLE], messageId: card.id, messageAuthorId: BOT_IDS.hq });
    await handleInteraction(click, s.commands);
    expect(click.deferred).toEqual({ ephemeral: true });
    expect(JSON.stringify(click.edits)).toContain('budget.taskUsd');
    expect(s.cfg.get('budget.taskUsd')).toBe(2);
    const audit = (await db.pool.query("SELECT actor, action, tool, outcome FROM audit_log WHERE action = 'config.set'")).rows;
    expect(audit).toEqual([{ actor: `user:${ADMIN} via praw tier:bot_admin`, action: 'config.set', tool: 'budget.taskUsd', outcome: expect.stringContaining(`card:${id}`) }]);
    expect(b!.port.closed.at(-1)).toMatchObject({ messageId: card.id, note: `Confirmed by <@${ADMIN}>: applied.` });
    // the card cannot be used twice
    const again = interaction({ kind: 'button', customId: `admincfg:${id}:confirm`, userId: ADMIN, roles: [ADMIN_ROLE], messageId: card.id, messageAuthorId: BOT_IDS.hq });
    await handleInteraction(again, s.commands);
    expect(JSON.stringify(again.edits)).toContain('already used');
  });

  it('a non-admin, a webhook and a thread message in #setting never start a run', async () => {
    const { provider, s } = await start([]);
    await s.scheduler.onMessage(adminMsg('change something', { isAdmin: false }));
    await s.scheduler.onMessage(adminMsg('change something', { author: { id: '5', name: 'hook', kind: 'foreign_bot' } }));
    await s.scheduler.onMessage(adminMsg('change something', { threadId: 't1', parentChannelId: CONFIG_CHANNEL }));
    await s.scheduler.idle();
    expect(provider.calls).toEqual([]);
    expect(b!.port.posts.filter((p) => p.target.channelId === CONFIG_CHANNEL)).toEqual([]);
  });

  it('a secret in the admin message gets the fixed warning; the provider, the logs and the audit never see it', async () => {
    const lines: string[] = [];
    await migrateUp(db.pool);
    await seed({ departments: new DepartmentRepo(db.pool), personas: new PersonaRepo(db.pool), channelMap: new ChannelMapRepo(db.pool) }, loadPrompts(PROMPTS_DIR));
    await db.pool.query("UPDATE departments SET provider = 'claude', model = 'claude-sonnet-5-5', work_channel_id = $1 WHERE id = 'praw'", [PRAW_WORK]);
    const provider = new ActorProvider({ 'heads/praw': [] });
    const { createLogger } = await import('../../core/logger.js');
    b = await boot(db.pool, { provider, logger: createLogger('debug', { destination: { write: (x: string) => void lines.push(x) } }) });
    app = b.app;
    const token = 'sk-ant-api03-PLANTEDSECRETVALUE0123456789';
    await app.services.scheduler.onMessage(adminMsg(`the key is ${token}`));
    await app.services.scheduler.idle();
    expect(provider.calls).toEqual([]);
    const posted = JSON.stringify(b.port.posts);
    expect(posted).toContain('delete the message now and rotate');
    expect(posted).not.toContain('PLANTEDSECRET');
    expect(lines.join('')).not.toContain('PLANTEDSECRET');
    expect(JSON.stringify((await db.pool.query('SELECT * FROM audit_log')).rows)).not.toContain('PLANTEDSECRET');
    expect((await db.pool.query("SELECT outcome FROM audit_log WHERE action = 'admin.secret'")).rows).toEqual([{ outcome: 'secret pattern matched' }]);
  });

  it('perm_propose is off while the owner constants are empty: the model reads why, no card is posted', async () => {
    const { provider, s } = await start([
      turn({ name: 'perm_propose', input: { opsJson: JSON.stringify([{ kind: 'role.assign', member: '900000000000000009', role: '900000000000000010' }]) } }),
      { text: 'permission operations are off' },
    ]);
    await s.scheduler.onMessage(adminMsg('give alice the staff role'));
    await s.scheduler.idle();
    expect(b!.port.posts.some((p) => p.payload.adminCardId)).toBe(false);
    const result = JSON.stringify(provider.callsOf('heads/praw')[1]!.messages.at(-1));
    expect(result).toContain('permission operations are off');
    expect((await db.pool.query('SELECT 1 FROM admin_cards')).rowCount).toBe(0);
  });

  it('a normal Praw chat in another channel has none of the admin tools', async () => {
    const { provider, s } = await start([{ text: 'hello' }]);
    await db.pool.query("INSERT INTO channel_map (channel_id, dept_id, is_work) VALUES ($1, 'praw', true) ON CONFLICT DO NOTHING", [PRAW_WORK]);
    await s.org.reload();
    await s.scheduler.onMessage(humanMsg('hi praw', { channelId: PRAW_WORK }));
    await s.scheduler.idle();
    const tools = provider.callsOf('heads/praw')[0]?.tools.map((t) => t.name) ?? [];
    for (const n of ['config_get', 'config_propose', 'admin_op_propose', 'discord_read', 'perm_propose']) expect(tools).not.toContain(n);
  });
});
