import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigStore } from '../config/store.js';
import { EventBus, type AppEvents } from '../core/events.js';
import { migrate } from '../db/migrate.js';
import { AdminCardRepo } from '../db/repos/adminCards.js';
import { freshDb, type TestDb } from '../db/test-helpers.js';
import { ADMIN_ROLE, GUILD, makeDeps } from '../discord/commands/test-helpers.js';
import { CONFIG_CHANNEL_ID, type Reply } from '../discord/commands/types.js';
import { FakeDiscordPort } from '../tests/fakes/discordPort.js';
import { AdminConsole, type Click, type PermPort } from './console.js';

/** Delegated tiers in the main process (Gate 1 delta T3-T5, T10, T20, T21): the mod-room card path against a real database. */
const MGR_ROLE = '1565000000000000011';
const MOD_ROLE = '1565000000000000012';
const ROOM = '1565000000000000020';
const MOD = '900000000000000011';
const MOD2 = '900000000000000012';
const MGR = '900000000000000013';
const ADMIN = '900000000000000001';
const HQ = '800000000000000001';
const TARGET = '900000000000000077';

let db: TestDb;
let store: ConfigStore;
beforeAll(async () => { db = await freshDb(); await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations'), 'up'); });
afterAll(async () => { await store?.close(); await db.close(); });
beforeEach(async () => {
  await store?.close();
  await db.pool.query('TRUNCATE admin_cards, audit_log RESTART IDENTITY');
  await db.pool.query('DELETE FROM config');
  store = await ConfigStore.open(db.pool, new EventBus<AppEvents>());
  await store.set('roles.managerId', MGR_ROLE, 't');
  await store.set('roles.moderatorId', MOD_ROLE, 't');
  await store.set('roles.modRoomId', ROOM, 't');
});

const OP = { kind: 'msg.delete', channel: '700000000000000001', message: '700000000000000002' };
function fakePort() {
  const calls = { propose: [] as unknown[], apply: [] as unknown[] };
  const p: PermPort = {
    readiness: async () => null,
    propose: async (ops, ctx) => {
      calls.propose.push([ops, ctx]);
      return { ok: true, payload: { ops, named: ctx?.namedIds ?? [] }, snapshot: { snaps: [{}] }, items: [{ label: 'Delete message', refs: [], old: 'message', neu: 'deleted' }] };
    },
    apply: async (_p, _s, who) => { calls.apply.push(who); return { kind: 'done', ok: true, lines: ['done'], applied: 1, total: 1 }; },
    read: async () => ({ ok: true, text: '[]' }),
  };
  return { p, calls };
}

async function rigUp(tiers?: { check(n: { managerId: string | null; moderatorId: string | null; modRoomId: string | null }): Promise<string | null> }) {
  const t = await makeDeps({ cfg: store as never });
  const port = new FakeDiscordPort();
  const cards = new AdminCardRepo(db.pool);
  const f = fakePort();
  const records: unknown[] = [];
  const c = new AdminConsole({
    guildId: GUILD, adminRoleId: ADMIN_ROLE, cards, cfg: store, cmd: t.deps, port, audit: t.deps.audit, log: { error() {} }, hqUserId: () => HQ,
    server: f.p, perms: f.p, provenance: { record: async (...a) => void records.push(a) }, ...(tiers ? { tiers } : {}),
  });
  const click = (cardId: string, action: 'confirm' | 'cancel', over: Partial<Click> = {}) =>
    c.click({ cardId, action, guildId: GUILD, channelId: ROOM, userId: MOD, memberRoleIds: [MOD_ROLE], messageId: 'msg-1', messageAuthorId: HQ, ...over });
  return { c, t, port, cards, f, click, records };
}
const MODP = { userId: MOD, tainted: false, tier: 'moderator' as 'moderator' | 'manager', channelId: ROOM, namedIds: ['700000000000000002'] };
const body = (r: Reply) => JSON.stringify(r.embeds ?? []) + (r.content ?? '');
const aud = (x: { t: { audits: unknown[] } }) => x.t.audits as { actor: string; action: string; outcome: string; tool?: string }[];

async function modCard(x: Awaited<ReturnType<typeof rigUp>>, p = MODP, op: unknown = OP) {
  const r = await x.c.proposeServer(p, [op]);
  if (!r.ok) throw new Error(r.error);
  await x.cards.setMessage(r.cardId!, 'msg-1');
  return r.cardId!;
}

describe('the mod room card path', () => {
  it('a tier proposal is posted to the mod room (never #setting), stored with that channel, and passes the tier-less ids to the executor', async () => {
    const x = await rigUp();
    const r = await x.c.proposeServer(MODP, [OP]);
    expect(r).toMatchObject({ ok: true });
    expect(x.port.posts[0]!.target).toEqual({ channelId: ROOM });
    expect(await x.cards.get((r as { cardId: string }).cardId)).toMatchObject({ channelId: ROOM, kind: 'server', proposerId: MOD });
    expect(x.f.calls.propose[0]).toEqual([[OP], { userId: MOD, namedIds: ['700000000000000002'] }]); // no tier travels to the executor
    expect(x.records[0]).toMatchObject([expect.any(String), ROOM, false, MOD]);
    expect((r as { text: string }).text).toContain('the person who asked');
  });
  it('T3: a tier run reaching config, admin_op or perm is refused at propose, and audited with the tier', async () => {
    const x = await rigUp();
    expect(await x.c.proposeConfig(MODP, { changes: [{ key: 'budget.taskUsd', value: 3 }] })).toMatchObject({ ok: false, error: expect.stringContaining('Bot Admins') });
    expect(await x.c.proposeOp(MODP, { op: 'bot_toggle', dept: 'hq', enabled: false })).toMatchObject({ ok: false, error: expect.stringContaining('Bot Admins') });
    expect(await x.c.proposePerm(MODP, [{ kind: 'role.assign' }])).toMatchObject({ ok: false, error: expect.stringContaining('Bot Admins') });
    expect(x.port.posts).toHaveLength(0);
    expect(aud(x).filter((a) => a.action === 'admin.propose').every((a) => a.actor.endsWith(' tier:moderator') && a.outcome.startsWith('refused:'))).toBe(true);
  });
  it('T10: a mod-room run proposing roles.* is refused; a Bot Admin run may, the executor check judges the result, and the card is high risk', async () => {
    const x = await rigUp({ check: async (n) => (n.managerId === n.moderatorId ? 'the Manager and Moderator roles are the same role' : null) });
    expect(await x.c.proposeConfig({ ...MODP, tier: 'manager' }, { changes: [{ key: 'roles.managerId', value: null }] })).toMatchObject({ ok: false });
    const ok = await x.c.proposeConfig({ userId: ADMIN, tainted: false }, { changes: [{ key: 'roles.modRoomId', value: '1565000000000000099' }] });
    expect(ok).toMatchObject({ ok: true, items: [{ label: 'roles.modRoomId', risk: true }] });
    expect(x.port.posts[0]!.target).toEqual({ channelId: CONFIG_CHANNEL_ID });
    const bad = await x.c.proposeConfig({ userId: ADMIN, tainted: false }, { changes: [{ key: 'roles.managerId', value: MOD_ROLE }] });
    expect(bad).toMatchObject({ ok: false, error: expect.stringContaining('same role') });
    const none = await (await rigUp()).c.proposeConfig({ userId: ADMIN, tainted: false }, { changes: [{ key: 'roles.moderatorId', value: null }] });
    expect(none).toMatchObject({ ok: false, error: expect.stringContaining('need the executor') });
  });
  it('T22: confirming a roles.* change audits old -> new, and re-runs the executor check at apply', async () => {
    let allow = true;
    const x = await rigUp({ check: async () => (allow ? null : 'the Moderator role: managed by an integration') });
    const r = await x.c.proposeConfig({ userId: ADMIN, tainted: false }, { changes: [{ key: 'roles.modRoomId', value: '1565000000000000099' }] });
    await x.cards.setMessage((r as { cardId: string }).cardId, 'msg-1');
    const click = await x.c.click({ cardId: (r as { cardId: string }).cardId, action: 'confirm', guildId: GUILD, channelId: CONFIG_CHANNEL_ID, userId: ADMIN, memberRoleIds: [ADMIN_ROLE], messageId: 'msg-1', messageAuthorId: HQ });
    expect(body(click)).toContain('roles.modRoomId');
    expect(aud(x).find((a) => a.action === 'config.set')).toMatchObject({ tool: 'roles.modRoomId', outcome: expect.stringContaining(`old=${ROOM} new=1565000000000000099`) });
    allow = false;
    const r2 = await x.c.proposeConfig({ userId: ADMIN, tainted: false }, { changes: [{ key: 'roles.modRoomId', value: ROOM }] }).catch(() => null);
    expect(r2).toMatchObject({ ok: false });
  });
  it('T4: only the proposer confirms: another Moderator, a Manager and a Bot Admin are refused; the proposer is applied with tier:moderator in the rows', async () => {
    const x = await rigUp();
    const id = await modCard(x);
    expect(body(await x.click(id, 'confirm', { userId: MOD2, memberRoleIds: [MOD_ROLE] }))).toContain('Only the admin whose request');
    expect(body(await x.click(id, 'confirm', { userId: MGR, memberRoleIds: [MGR_ROLE] }))).toContain('Only the admin whose request');
    expect(body(await x.click(id, 'confirm', { userId: ADMIN, memberRoleIds: [ADMIN_ROLE] }))).toContain('Only the admin whose request');
    expect((await x.cards.get(id))!.status).toBe('pending');
    expect(x.f.calls.apply).toEqual([]);
    const done = await x.click(id, 'confirm');
    expect(body(done)).toContain('Server changed');
    expect(x.f.calls.apply).toEqual([{ userId: MOD, cardId: id, via: 'praw' }]);
    const rows = aud(x);
    expect(rows.filter((a) => a.action === 'admin.click').every((a) => /tier:(moderator|manager|bot_admin)$/.test(a.actor))).toBe(true);
    expect(rows.find((a) => a.action === 'admin.card' && a.outcome.startsWith('applied'))!.actor).toBe(`user:${MOD} via praw tier:moderator`);
    expect(rows.find((a) => a.action === 'admin.propose')!.actor).toBe(`user:${MOD} via praw tier:moderator`);
  });
  it('T4: the click payload roles decide: a Moderator who lost the role, or whose role no longer allows the card, is refused', async () => {
    const x = await rigUp();
    const id = await modCard(x);
    expect(body(await x.click(id, 'confirm', { memberRoleIds: [] }))).toContain('no longer hold');
    const kick = await modCard(x, { ...MODP, tier: 'manager', userId: MGR, namedIds: [TARGET] }, { kind: 'member.kick', member: TARGET });
    expect(body(await x.click(kick, 'confirm', { userId: MGR, memberRoleIds: [MOD_ROLE] }))).toContain('no longer allows');
    expect((await x.cards.get(kick))!.status).toBe('pending');
    // a forged mod-room row carrying a non-server kind is never applied by the main process
    const forged = (await x.cards.create({ proposerId: MOD, kind: 'config', payload: { changes: [{ key: 'budget.taskUsd', value: 99 }] }, snapshot: { old: {} }, tainted: false, channelId: ROOM, via: 'praw' })).card;
    await x.cards.setMessage(forged.id, 'msg-1');
    expect(body(await x.click(forged.id, 'confirm'))).toContain('does not belong to an active mod room');
    expect(store.get('budget.taskUsd')).not.toBe(99);
  });
  it('T4: cancel by the proposer or by a Bot Admin; not by another Moderator', async () => {
    const x = await rigUp();
    const a = await modCard(x);
    expect(body(await x.click(a, 'cancel', { userId: MOD2, memberRoleIds: [MOD_ROLE] }))).toContain('Only the admin whose request');
    expect(body(await x.click(a, 'cancel', { userId: ADMIN, memberRoleIds: [ADMIN_ROLE] }))).toContain('Cancelled');
    expect(await x.cards.get(a)).toMatchObject({ status: 'cancelled', decidedBy: ADMIN });
    const b = await modCard(x);
    expect(body(await x.click(b, 'cancel'))).toContain('Cancelled');
    expect((await x.cards.get(b))!.status).toBe('cancelled');
    expect(x.f.calls.apply).toEqual([]);
  });
  it('T5: a mod-room card clicked from #setting is refused, and a #setting card clicked in the mod room too; the consume itself binds the channel', async () => {
    const x = await rigUp();
    const id = await modCard(x);
    expect(body(await x.click(id, 'confirm', { channelId: CONFIG_CHANNEL_ID, memberRoleIds: [MOD_ROLE, ADMIN_ROLE] }))).toContain('where it was posted');
    expect((await x.cards.get(id))!.status).toBe('pending');
    const cfg = await x.c.proposeConfig({ userId: ADMIN, tainted: false }, { changes: [{ key: 'budget.taskUsd', value: 3 }] });
    await x.cards.setMessage((cfg as { cardId: string }).cardId, 'msg-1');
    expect(body(await x.click((cfg as { cardId: string }).cardId, 'confirm', { userId: ADMIN, channelId: ROOM, memberRoleIds: [ADMIN_ROLE] }))).toContain('#⚙️-setting');
    expect(await x.cards.consume(id, 'confirmed', MOD, 'msg-1', { channelId: CONFIG_CHANNEL_ID })).toEqual({ ok: false, reason: 'wrong_channel' });
    expect((await x.cards.get(id))!.status).toBe('pending');
    // the room that is configured now is what counts: re-pointing the mod room strands the old room's cards
    await store.set('roles.modRoomId', '1565000000000000098', 't');
    expect(body(await x.click(id, 'confirm'))).toContain('active mod room');
  });
  it('T20: the 11th proposal in 10 minutes is refused and audited; the proposals of another user are counted separately', async () => {
    const x = await rigUp();
    for (let i = 0; i < 10; i++) expect(await x.c.proposeServer(MODP, [OP])).toMatchObject({ ok: true });
    expect(await x.c.proposeServer(MODP, [OP])).toMatchObject({ ok: false, error: expect.stringContaining('at most 10 proposals') });
    expect(await x.c.proposeServer({ ...MODP, userId: MOD2 }, [OP])).toMatchObject({ ok: true });
    expect(aud(x).filter((a) => a.outcome.startsWith('refused: at most 10'))).toHaveLength(1);
  });
  it('a tier proposal outside the mod room, or with no mod room configured, is refused', async () => {
    const x = await rigUp();
    expect(await x.c.proposeServer({ ...MODP, channelId: CONFIG_CHANNEL_ID }, [OP])).toMatchObject({ ok: false, error: expect.stringContaining('only in the mod room') });
    await store.set('roles.modRoomId', null, 't');
    expect(await x.c.proposeServer(MODP, [OP])).toMatchObject({ ok: false });
    expect(x.port.posts).toHaveLength(0);
  });
  it('a Bot Admin card in #setting is unchanged: the Bot Admin role in the payload, audited with tier:bot_admin', async () => {
    const x = await rigUp();
    const r = await x.c.proposeServer({ userId: ADMIN, tainted: false, namedIds: [] }, [OP]);
    await x.cards.setMessage((r as { cardId: string }).cardId, 'msg-1');
    expect(x.port.posts[0]!.target).toEqual({ channelId: CONFIG_CHANNEL_ID });
    expect(body(await x.click((r as { cardId: string }).cardId, 'confirm', { userId: ADMIN, channelId: CONFIG_CHANNEL_ID, memberRoleIds: [MOD_ROLE] }))).toContain('Only Bot Admins');
    expect(body(await x.click((r as { cardId: string }).cardId, 'confirm', { userId: ADMIN, channelId: CONFIG_CHANNEL_ID, memberRoleIds: [ADMIN_ROLE] }))).toContain('Server changed');
    expect(aud(x).find((a) => a.action === 'admin.card' && a.outcome.startsWith('applied'))!.actor).toBe(`user:${ADMIN} via praw tier:bot_admin`);
  });
});
