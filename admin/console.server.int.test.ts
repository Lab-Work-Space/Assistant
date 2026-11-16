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

const ADMIN = '900000000000000001';
const OTHER = '900000000000000002';
const HQ = '800000000000000001';
const TARGET = '900000000000000077';

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

function fakePort(over: { proposeError?: string; readiness?: string | null } = {}) {
  const calls = { propose: [] as unknown[], apply: [] as unknown[] };
  const p: PermPort = {
    readiness: async () => over.readiness ?? null,
    propose: async (ops, ctx) => {
      calls.propose.push([ops, ctx]);
      return over.proposeError ? { ok: false, error: over.proposeError } : {
        ok: true, payload: { ops, named: ctx?.namedIds ?? [] }, snapshot: { snaps: [{}] },
        items: [{ label: 'Kick member', refs: [{ kind: 'user', id: TARGET }], old: 'member', neu: 'kicked', risk: true, warn: 'target chosen by Praw, not by you' }],
      };
    },
    apply: async (payload, snapshot, who) => { calls.apply.push(who); return { kind: 'done', ok: true, lines: ['done: Kick member'], applied: 1, total: 1 }; },
    read: async () => ({ ok: true, text: '[]' }),
  };
  return { p, calls };
}

async function rigUp(o: { server?: PermPort; welcome?: { check(r: readonly string[], c: string | null): Promise<string | null> } } = {}) {
  const t = await makeDeps({ cfg: store as never });
  const port = new FakeDiscordPort();
  port.channels = [{ id: '700000000000000001', name: 'general', parentId: null, type: 0 }];
  const cards = new AdminCardRepo(db.pool);
  const c = new AdminConsole({
    guildId: GUILD, adminRoleId: ADMIN_ROLE, cards, cfg: store, cmd: t.deps, port, audit: t.deps.audit, log: { error() {} }, hqUserId: () => HQ,
    ...(o.server ? { server: o.server } : {}), ...(o.welcome ? { welcome: o.welcome } : {}),
  });
  const click = (cardId: string, action: 'confirm' | 'cancel', over: Partial<Click> = {}) =>
    c.click({ cardId, action, guildId: GUILD, channelId: CONFIG_CHANNEL_ID, userId: ADMIN, memberRoleIds: [ADMIN_ROLE], messageId: 'msg-1', messageAuthorId: HQ, ...over });
  return { c, t, port, cards, click };
}
const P = { userId: ADMIN, tainted: false };

describe('server proposals (kind "server")', () => {
  it('posts one card with the warning field, stores the ids the admin named and passes them to the executor', async () => {
    const f = fakePort();
    const x = await rigUp({ server: f.p });
    const r = await x.c.proposeServer({ ...P, namedIds: [TARGET] }, [{ kind: 'member.kick', member: TARGET }]);
    expect(r).toMatchObject({ ok: true, cardId: expect.stringMatching(/^[0-9a-f]{32}$/), items: [{ label: 'Kick member' }] });
    expect(f.calls.propose).toEqual([[[{ kind: 'member.kick', member: TARGET }], { userId: ADMIN, namedIds: [TARGET] }]]);
    expect(x.port.posts).toHaveLength(1);
    const fields = x.port.posts[0]!.payload.fields!;
    expect(fields.map((q) => q.name)).toContain('⚠ Warning');
    expect(x.port.posts[0]!.payload.title).toContain('Server change');
    const card = await x.cards.get((r as { cardId: string }).cardId);
    expect(card).toMatchObject({ kind: 'server', via: 'praw', status: 'pending' });
  });

  it('is refused (and audited) when the executor is off, refuses the proposal, or is not configured', async () => {
    const off = await rigUp({ server: fakePort({ readiness: 'the executor (LW Admin) is not running or not reachable' }).p });
    expect(await off.c.proposeServer(P, [{}])).toMatchObject({ ok: false, error: expect.stringContaining('not running') });
    const no = await rigUp({ server: fakePort({ proposeError: 'operation 1 (member.kick) refused: nope' }).p });
    expect(await no.c.proposeServer(P, [{}])).toMatchObject({ ok: false, error: expect.stringContaining('refused: nope') });
    const none = await rigUp();
    expect(await none.c.proposeServer(P, [{}])).toMatchObject({ ok: false, error: expect.stringContaining('not configured') });
    expect(no.port.posts).toHaveLength(0);
  });

  it('Confirm applies through the executor by card id with the card\'s via; the reply and the closed card say what happened', async () => {
    const f = fakePort();
    const x = await rigUp({ server: f.p });
    const r = await x.c.proposeServer(P, [{ kind: 'member.kick', member: TARGET }]);
    if (!r.ok) throw new Error(r.error);
    const reply = await x.click(r.cardId!, 'confirm');
    expect(JSON.stringify(reply)).toContain('done: Kick member');
    expect(f.calls.apply).toEqual([{ userId: ADMIN, cardId: r.cardId!, via: 'praw' }]);
    expect((await x.cards.get(r.cardId!))!.outcome).toBe('applied');
    expect(x.port.closed.at(-1)!.note).toContain('1 server change applied');
  });

  it('a card is single-use and only its proposer can confirm it (the executor is never called twice)', async () => {
    const f = fakePort();
    const x = await rigUp({ server: f.p });
    const r = await x.c.proposeServer(P, [{}]);
    if (!r.ok) throw new Error(r.error);
    await x.click(r.cardId!, 'confirm', { userId: OTHER });
    await x.click(r.cardId!, 'confirm');
    await x.click(r.cardId!, 'confirm');
    expect(f.calls.apply).toHaveLength(1);
  });
});

describe('executor timeout (G2SM-07)', () => {
  it('unknown + claimed: reported as "result unknown", outcome stored as unknown, never "Nothing was changed"; unknown + never claimed: refused as not taken', async () => {
    const f = fakePort();
    f.p.apply = async () => ({ kind: 'unknown', why: 'timeout' });
    const x = await rigUp({ server: f.p });
    const r = await x.c.proposeServer(P, [{}]);
    if (!r.ok) throw new Error(r.error);
    await db.pool.query('UPDATE admin_cards SET executed_at = now() WHERE id = $1', [r.cardId!]);
    const reply = await x.click(r.cardId!, 'confirm');
    expect(JSON.stringify(reply)).toContain('result unknown');
    expect(JSON.stringify(reply)).not.toContain('Nothing was changed');
    expect((await x.cards.get(r.cardId!))!.outcome).toBe('unknown');
    expect(x.port.closed.at(-1)!.note).toContain('result is unknown');
    const y = await rigUp({ server: f.p });
    const r2 = await y.c.proposeServer(P, [{}]);
    if (!r2.ok) throw new Error(r2.error);
    expect(JSON.stringify(await y.click(r2.cardId!, 'confirm'))).toContain('did not take the card');
  });
});

describe('invite links (Gate 1 S25)', () => {
  it('the link is in the confirming admin\'s reply only: not in the public card note, not in the audit rows', async () => {
    const f = fakePort();
    f.p.apply = async () => ({ kind: 'done', ok: true, lines: ['invite link (shown only to you, not stored): https://discord.gg/abc123', 'done: Create invite'], applied: 1, total: 1 });
    const x = await rigUp({ server: f.p });
    const r = await x.c.proposeServer(P, [{ kind: 'invite.create', channel: '700000000000000001', maxAgeSeconds: 3600, maxUses: 1 }]);
    if (!r.ok) throw new Error(r.error);
    const reply = await x.click(r.cardId!, 'confirm');
    expect(JSON.stringify(reply)).toContain('https://discord.gg/abc123');
    expect(reply.ephemeral).toBe(true);
    expect(x.port.closed.at(-1)!.note).not.toContain('abc123');
    expect(JSON.stringify(x.t.audits)).not.toContain('abc123');
    expect(JSON.stringify((await x.cards.get(r.cardId!))!)).not.toContain('abc123');
  });
});

describe('dashboard and panel callers (Gate 1 S46, S37d)', () => {
  it('a dashboard card is not posted to Discord; the same admin applies it once by id, with actor "via dashboard"', async () => {
    const f = fakePort();
    const x = await rigUp({ server: f.p });
    const r = await x.c.proposeServer({ ...P, via: 'dashboard' }, [{}]);
    if (!r.ok) throw new Error(r.error);
    expect(x.port.posts).toHaveLength(0);
    expect(await x.cards.get(r.cardId!)).toMatchObject({ via: 'dashboard', status: 'pending', messageId: null });
    const two = await Promise.all([x.c.applyFromDashboard(r.cardId!, ADMIN), x.c.applyFromDashboard(r.cardId!, ADMIN)]);
    expect(two.filter((v) => v.ok)).toHaveLength(1);
    expect(f.calls.apply).toEqual([{ userId: ADMIN, cardId: r.cardId!, via: 'dashboard' }]);
    expect(x.t.audits.find((a) => (a as { action: string; outcome: string }).action === 'admin.card' && (a as { outcome: string }).outcome.startsWith('applied'))).toMatchObject({ actor: `user:${ADMIN} via dashboard tier:bot_admin` });
  });
  it('another admin\'s card, a Discord-made card and an unknown id are refused', async () => {
    const f = fakePort();
    const x = await rigUp({ server: f.p });
    const mine = await x.c.proposeServer({ ...P, via: 'dashboard' }, [{}]);
    const discord = await x.c.proposeServer({ userId: OTHER, tainted: false }, [{}]);
    if (!mine.ok || !discord.ok) throw new Error('setup');
    expect(await x.c.applyFromDashboard(mine.cardId!, OTHER)).toMatchObject({ ok: false, why: expect.stringContaining('Only the admin') });
    expect(await x.c.applyFromDashboard(discord.cardId!, OTHER)).toMatchObject({ ok: false });
    expect(await x.c.applyFromDashboard('0'.repeat(32), ADMIN)).toMatchObject({ ok: false });
    expect(f.calls.apply).toEqual([]);
  });
  it('a panel card takes the normal Discord card path with via "panel"', async () => {
    const f = fakePort();
    const x = await rigUp({ server: f.p });
    const r = await x.c.proposeServer({ ...P, via: 'panel', namedIds: [TARGET] }, [{ kind: 'member.kick', member: TARGET }]);
    if (!r.ok) throw new Error(r.error);
    expect(x.port.posts).toHaveLength(1);
    await x.click(r.cardId!, 'confirm');
    expect(f.calls.apply[0]).toMatchObject({ via: 'panel' });
  });
});

describe('welcome_set (Gate 1 S14)', () => {
  const R1 = '700000000000000010';
  it('is validated live (roles, channel) at propose and again at apply; a stale or newly refused setting never applies', async () => {
    let problem: string | null = null;
    const x = await rigUp({ welcome: { check: async () => problem } });
    const set = { op: 'welcome_set', enabled: true, roleIds: [R1], message: 'Welcome {user}!', channelId: '700000000000000001' };
    problem = 'default role 1: the role is held by a bot';
    expect(await x.c.proposeOp(P, set)).toMatchObject({ ok: false, error: expect.stringContaining('held by a bot') });
    problem = null;
    const r = await x.c.proposeOp(P, set);
    if (!r.ok) throw new Error(r.error);
    problem = 'default role 1: the role carries powers beyond the safe set'; // edited between propose and confirm
    const reply = await x.click(r.cardId!, 'confirm');
    expect(JSON.stringify(reply)).toContain('powers beyond the safe set');
    expect(store.get('welcome.enabled')).toBe(false);
  });
  it('applies the five keys through config compare-and-swap when everything checks out', async () => {
    const x = await rigUp({ welcome: { check: async () => null } });
    const r = await x.c.proposeOp(P, { op: 'welcome_set', enabled: true, roleIds: [R1], message: 'Welcome {user}!', channelId: '700000000000000001', raidPerMinute: 8 });
    if (!r.ok) throw new Error(r.error);
    await x.click(r.cardId!, 'confirm');
    expect(store.get('welcome.roleIds')).toEqual([R1]);
    expect(store.get('welcome.raidPerMinute')).toBe(8);
    expect(store.get('welcome.enabled')).toBe(true);
  });
  it('refuses bad templates, an out-of-range raid limit, enabling without message and channel, and the setting without an executor', async () => {
    const x = await rigUp({ welcome: { check: async () => null } });
    for (const message of ['hi @everyone', 'see https://x.example', 'hi <@123456789012345678>', 'hi {role}', 'x'.repeat(501), 'join discord.gg/abc']) {
      expect(await x.c.proposeOp(P, { op: 'welcome_set', message }), message).toMatchObject({ ok: false });
    }
    expect(await x.c.proposeOp(P, { op: 'welcome_set', raidPerMinute: 2 })).toMatchObject({ ok: false });
    expect(await x.c.proposeOp(P, { op: 'welcome_set', raidPerMinute: 31 })).toMatchObject({ ok: false });
    expect(await x.c.proposeOp(P, { op: 'welcome_set', enabled: true })).toMatchObject({ ok: false, error: expect.stringContaining('needs a message and a channel') });
    const none = await rigUp();
    expect(await none.c.proposeOp(P, { op: 'welcome_set', message: 'hi {user}' })).toMatchObject({ ok: false, error: expect.stringContaining('needs the executor') });
  });
  it('the welcome keys are not settable through config_propose', async () => {
    const x = await rigUp({ welcome: { check: async () => null } });
    expect(await x.c.proposeConfig(P, { changes: [{ key: 'welcome.enabled', value: true }] })).toMatchObject({ ok: false });
  });
});
