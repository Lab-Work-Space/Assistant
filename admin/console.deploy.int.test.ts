import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigStore } from '../config/store.js';
import { EventBus, type AppEvents } from '../core/events.js';
import { migrate } from '../db/migrate.js';
import { AdminCardRepo } from '../db/repos/adminCards.js';
import { freshDb, type TestDb } from '../db/test-helpers.js';
import { ADMIN_ROLE, GUILD, makeDeps } from '../discord/commands/test-helpers.js';
import { CONFIG_CHANNEL_ID } from '../discord/commands/types.js';
import { FakeDiscordPort } from '../tests/fakes/discordPort.js';
import { AdminConsole, type Click, type PermPort } from './console.js';

/** Deploy cards (Gate 1 V22) through the real console and card table: Bot Admin only, single use, applied by card id through the executor port. */
const ADMIN = '900000000000000001';
const HQ = '800000000000000001';
const MOD = '900000000000000009';
let db: TestDb;
let store: ConfigStore;
beforeAll(async () => { db = await freshDb(); await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations'), 'up'); });
afterAll(async () => { await store?.close(); await db.close(); });
beforeEach(async () => {
  await store?.close();
  await db.pool.query('TRUNCATE admin_cards RESTART IDENTITY');
  await db.pool.query('DELETE FROM config');
  store = await ConfigStore.open(db.pool, new EventBus<AppEvents>());
});

function fakePort() {
  const calls = { propose: [] as unknown[], apply: [] as { cardId: string; userId: string }[] };
  const p: PermPort = {
    readiness: async () => null,
    propose: async (ops) => {
      calls.propose.push(ops);
      const op = (ops as { op: string; repo: string; category: string }[])[0]!;
      return { ok: true, payload: { ...op, sha: 'a'.repeat(40) }, snapshot: { canon: 'x', tier: 'bot_admin' }, items: [{ label: 'Deploy new site', old: '(not deployed)', neu: `Lab-Work-Space/${op.repo}@aaaaaaaaaaaa -> https://${op.repo}.labworkspace.net/` }] };
    },
    apply: async (_p, _s, who) => { calls.apply.push(who); return { kind: 'done', ok: true, lines: ['Queued on the VPS as J-0123456789abcdef.'], applied: 1, total: 1 }; },
    read: async () => ({ ok: true, text: '' }),
  };
  return { p, calls };
}
async function rigUp(deploy?: PermPort) {
  const t = await makeDeps({ cfg: store as never });
  const port = new FakeDiscordPort();
  const cards = new AdminCardRepo(db.pool);
  const c = new AdminConsole({ guildId: GUILD, adminRoleId: ADMIN_ROLE, cards, cfg: store, cmd: t.deps, port, audit: t.deps.audit, log: { error() {} }, hqUserId: () => HQ, ...(deploy ? { deploy } : {}) });
  const click = (cardId: string, action: 'confirm' | 'cancel', over: Partial<Click> = {}) =>
    c.click({ cardId, action, guildId: GUILD, channelId: CONFIG_CHANNEL_ID, userId: ADMIN, memberRoleIds: [ADMIN_ROLE], messageId: 'msg-1', messageAuthorId: HQ, ...over });
  return { c, port, cards, click };
}
const P = { userId: ADMIN, tainted: false };
const REQ = { op: 'add', repo: 'blog', category: 'apps' };

describe('deploy cards', () => {
  it('posts one "VPS deploy" card with the exact op and URL, stored as kind deploy', async () => {
    const f = fakePort();
    const x = await rigUp(f.p);
    const r = await x.c.proposeDeploy(P, REQ);
    expect(r).toMatchObject({ ok: true, cardId: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(f.calls.propose).toEqual([[REQ]]);
    expect(x.port.posts[0]!.payload.title).toContain('VPS deploy');
    expect(JSON.stringify(x.port.posts[0]!.payload)).toContain('https://blog.labworkspace.net/');
    expect(await x.cards.get((r as { cardId: string }).cardId)).toMatchObject({ kind: 'deploy', status: 'pending', channelId: CONFIG_CHANNEL_ID });
  });
  it('is refused for a tier run (Manager/Moderator) and when the executor is not configured', async () => {
    const x = await rigUp(fakePort().p);
    expect(await x.c.proposeDeploy({ ...P, tier: 'moderator', channelId: 'x' }, REQ)).toMatchObject({ ok: false, error: expect.stringContaining('Bot Admins') });
    expect(await x.c.proposeDeploy({ ...P, tier: 'manager', channelId: 'x' }, REQ)).toMatchObject({ ok: false });
    const none = await rigUp();
    expect(await none.c.proposeDeploy(P, REQ)).toMatchObject({ ok: false, error: expect.stringContaining('not configured') });
    expect(x.port.posts).toHaveLength(0);
  });
  it('Confirm applies once through the executor by card id; a second click is refused', async () => {
    const f = fakePort();
    const x = await rigUp(f.p);
    const r = (await x.c.proposeDeploy(P, REQ)) as { cardId: string };
    const reply = await x.click(r.cardId, 'confirm');
    expect(JSON.stringify(reply)).toContain('Queued on the VPS');
    expect(f.calls.apply).toEqual([{ cardId: r.cardId, userId: ADMIN, via: 'praw' }]);
    expect(await x.click(r.cardId, 'confirm')).toMatchObject({ ephemeral: true });
    expect(f.calls.apply).toHaveLength(1);
  });
  it('a click without the Bot Admin role, or from a mod-room channel, never reaches the executor', async () => {
    const f = fakePort();
    const x = await rigUp(f.p);
    const r = (await x.c.proposeDeploy(P, REQ)) as { cardId: string };
    await x.click(r.cardId, 'confirm', { userId: MOD, memberRoleIds: [] });
    await x.click(r.cardId, 'confirm', { channelId: '123' });
    expect(f.calls.apply).toHaveLength(0);
  });
  it('the executor claim only takes deploy cards that were confirmed by their proposer', async () => {
    const x = await rigUp(fakePort().p);
    const r = (await x.c.proposeDeploy(P, REQ)) as { cardId: string };
    expect(await x.cards.claimForExecution(r.cardId)).toBeNull(); // still pending
    await x.click(r.cardId, 'confirm');
    await db.pool.query('UPDATE admin_cards SET executed_at = NULL WHERE id = $1', [r.cardId]);
    expect(await x.cards.claimForExecution(r.cardId)).toMatchObject({ kind: 'deploy' });
    expect(await x.cards.claimForExecution(r.cardId)).toBeNull(); // single use
  });
});
