import { describe, expect, it, vi } from 'vitest';
import type { AdminCard } from '../db/repos/adminCards.js';
import { SAFE_BITS } from '../discord/perm/perm-bits.js';
import type { ChannelInfo, RoleInfo } from '../discord/perm/perm-world.js';
import { fakeServerWorld, fakeServerWriter, NOW, S, serverConsts, serverData } from '../discord/server/server-fixture.js';
import { C, F, R, U, fakeWriter, id } from '../discord/test-helpers.js';
import { ExecutorService } from './service.js';
import { autoClick, fakeConfirm } from './test-helpers.js';
import type { TierConfig } from './tiers.js';

/** Delegated tiers (Gate 1 delta T1-T22) against the executor's own live view: fake guild, fake config, recording writers. */
const CARD_ID = 'b'.repeat(32);
const T = {
  mgrRole: id(60), modRole: id(61), mgr: id(62), mod: id(63), mod2: id(64), mgr2: id(65), both: id(66), nobody: id(67),
  room: id(70), staffCat: id(71), openCat: id(72), lockedCat: id(73), openCh: id(74), lockedCh: id(75), msgMgr: id(80), msgMod: id(81), msgMod2: id(82),
};
const SAFE = SAFE_BITS.reduce((a, b) => a | b, 0n);
const CFG: TierConfig = { managerId: T.mgrRole, moderatorId: T.modRole, modRoomId: T.room };

function world() {
  const d = serverData();
  const role = (r: Partial<RoleInfo> & { id: string; name: string; position: number }): RoleInfo => ({ managed: false, botId: null, permissions: SAFE, ...r });
  d.roles.push(role({ id: T.mgrRole, name: 'Manager', position: 6 }), role({ id: T.modRole, name: 'Moderator-tier', position: 5 }));
  const mem = (mid: string, roleIds: string[]) => d.members.set(mid, { id: mid, isBot: false, roleIds, isOwner: false, username: `u${mid.slice(-3)}`, nick: null, timeoutUntil: null });
  mem(T.mgr, [T.mgrRole]); mem(T.mod, [T.modRole]); mem(T.mod2, [T.modRole]); mem(T.mgr2, [T.mgrRole]); mem(T.both, [T.modRole, T.mgrRole]); mem(T.nobody, []);
  const ch = (c: Partial<ChannelInfo> & { id: string; name: string }) =>
    d.channels.set(c.id, { type: 0, parentId: null, isThread: false, overwrites: [], ...c });
  ch({ id: T.staffCat, name: 'Staff', type: 4 });
  ch({ id: T.room, name: '🛡️-mod-room', parentId: T.staffCat });
  ch({ id: T.openCat, name: 'Open', type: 4 });
  ch({ id: T.lockedCat, name: 'Locked', type: 4, overwrites: [{ id: T.mgrRole, type: 'role', allow: F.ManageMessages, deny: 0n }] });
  ch({ id: T.openCh, name: 'open-chat', parentId: T.openCat, topic: '', slowmode: 0, nsfw: false, position: 1 });
  ch({ id: T.lockedCh, name: 'locked-chat', parentId: T.lockedCat, topic: '', slowmode: 0, nsfw: false, position: 1 });
  const m = d.messages.get(S.plain)!;
  m.push({ id: T.msgMgr, authorId: T.mgr, authorBot: false, createdAt: NOW - 3600_000, pinned: false }, { id: T.msgMod, authorId: T.mod, authorBot: false, createdAt: NOW - 3600_000, pinned: false },
    { id: T.msgMod2, authorId: T.mod2, authorBot: false, createdAt: NOW - 3600_000, pinned: false });
  return d;
}

function card(over: Partial<AdminCard> & { payload: unknown; snapshot: unknown }): AdminCard {
  return {
    seq: 1, id: CARD_ID, proposerId: U.admin, kind: 'server', tainted: false, channelId: (over.proposerId ?? U.admin) === U.admin ? C.setting : T.room, messageId: 'm', status: 'confirmed', outcome: null,
    createdAt: new Date(NOW), expiresAt: new Date(NOW + 900_000), via: 'praw', origin: 'discord', decidedBy: U.admin, executedAt: null, ...over,
  };
}

function rig(o: { stored?: AdminCard | null; data?: ReturnType<typeof world>; cfg?: TierConfig; welcome?: string[]; failMember?: string[]; tiersFail?: boolean } = {}) {
  const data = o.data ?? world();
  const writer = fakeServerWriter();
  const permWriter = fakeWriter();
  const audits: { actor: string; action: string; tool?: string | null; outcome?: string | null }[] = [];
  const pushed: { kind: string; payload: unknown }[] = [];
  const rate = { check: vi.fn(async (..._a: unknown[]) => null as string | null) };
  const fc = fakeConfirm();
  const svc = new ExecutorService({
    confirm: fc.confirm,
    world: fakeServerWorld(data, { failMemberFetch: o.failMember ?? [] }), permWriter, serverWriter: writer, cards: { claimForExecution: async () => o.stored ?? null },
    exec: { push: async (kind: string, payload: unknown) => void pushed.push({ kind, payload }), getState: async () => null, setState: async () => undefined, clearState: async () => undefined, recordArchive: async () => undefined } as never,
    rate, consts: () => serverConsts(), recheck: async () => [], disabled: () => null, welcomeRoleIds: async () => o.welcome ?? [],
    tiers: async () => { if (o.tiersFail) throw new Error('db down'); return o.cfg ?? CFG; },
    audit: async (e) => void audits.push(e), log: { error() {} }, now: () => NOW,
  });
  autoClick(svc, fc);
  return { svc, fc, writer, permWriter, audits, pushed, rate, data };
}

/** Proposes through a fresh rig and returns the stored card for `proposer` (decided by `decider`). */
async function stored(ops: unknown[], proposer: string, named: string[] = [], over: Partial<AdminCard> = {}, data = world()) {
  const r = await rig({ data }).svc.propose('server', ops, { userId: proposer, namedIds: named });
  if (!r.ok) throw new Error(r.error);
  return card({ payload: r.payload, snapshot: r.snapshot, proposerId: proposer, decidedBy: proposer, ...over });
}
const propose = (x: ReturnType<typeof rig>, ops: unknown[], user: string, named: string[] = []) => x.svc.propose('server', ops, { userId: user, namedIds: named });
const refusedWith = (re: RegExp) => ({ ok: false, error: expect.stringMatching(re) });

describe('T1/T3: the executor derives the tier itself and checks it at propose and at apply', () => {
  it('a Moderator proposes a named delete and a Manager a kick; the snapshot records the tier for display only', async () => {
    const x = rig();
    const a = await propose(x, [{ kind: 'msg.delete', channel: S.plain, message: S.msgAlice }], T.mod, [S.msgAlice]);
    expect(a).toMatchObject({ ok: true, snapshot: { tier: 'moderator' } });
    const b = await propose(x, [{ kind: 'member.kick', member: U.alice }], T.mgr, [U.alice]);
    expect(b).toMatchObject({ ok: true, snapshot: { tier: 'manager' } });
    expect(x.rate.check).toHaveBeenCalledWith(T.mod, 1, 0, 'moderator');
    expect(x.rate.check).toHaveBeenCalledWith(T.mgr, 1, 1, 'manager');
  });
  it('T3: a Bot Admin only op or family, bypassing any tool filter, is refused at propose for a Moderator and a Manager', async () => {
    const x = rig();
    expect(await propose(x, [{ kind: 'member.ban', member: U.alice, deleteDays: 0 }], T.mgr, [U.alice])).toMatchObject(refusedWith(/member\.ban needs the bot admin role/));
    expect(await propose(x, [{ kind: 'member.kick', member: U.alice }], T.mod, [U.alice])).toMatchObject(refusedWith(/member\.kick needs the manager role/));
    expect(await propose(x, [{ kind: 'guild.edit', name: 'Nope' }], T.mgr)).toMatchObject(refusedWith(/guild\.edit needs the bot admin/));
    expect(await propose(x, [{ kind: 'automod.delete', rule: S.rule }], T.mgr)).toMatchObject(refusedWith(/automod\.delete needs/));
    expect(await propose(x, [{ kind: 'channel.delete', channel: S.emptyCh }], T.mgr)).toMatchObject(refusedWith(/channel\.delete needs/));
    expect(await x.svc.propose('perm', [{ kind: 'role.assign', member: U.alice, role: R.staff }], { userId: T.mgr, namedIds: [] })).toMatchObject(refusedWith(/Bot Admins only/));
    expect(x.rate.check).not.toHaveBeenCalled();
  });
  it('a member with no tier role, a bot, or one who cannot be fetched cannot propose (fail closed)', async () => {
    expect(await propose(rig(), [{ kind: 'welcome.resume' }], T.nobody)).toMatchObject(refusedWith(/holds no Bot Admin, Manager or Moderator role/));
    expect(await propose(rig(), [{ kind: 'welcome.resume' }], U.botHq)).toMatchObject(refusedWith(/holds no/));
    expect(await propose(rig({ failMember: [T.mod] }), [{ kind: 'msg.pin', channel: S.plain, message: S.msgAlice }], T.mod)).toMatchObject(refusedWith(/could not be fetched/));
    expect(await propose(rig({ tiersFail: true }), [{ kind: 'welcome.resume' }], U.admin)).toMatchObject(refusedWith(/could not be determined/));
  });
  it('a card row forged with member.ban and a Manager proposer is refused at apply, nothing is written, the row names the executor-evaluated tier', async () => {
    const forged = card({ proposerId: T.mgr, decidedBy: T.mgr, payload: { ops: [{ kind: 'member.ban', member: U.alice, deleteDays: 0 }], named: [U.alice] }, snapshot: { snaps: [{ member: true, roles: [] }], tier: 'manager' } });
    const x = rig({ stored: forged });
    expect(await x.svc.apply(CARD_ID)).toMatchObject({ kind: 'refused', why: expect.stringContaining('member.ban needs the bot admin') });
    expect(x.writer.calls).toEqual([]);
    expect(x.audits.at(-1)).toMatchObject({ action: 'admin.exec', actor: `user:${T.mgr} via praw tier:manager` });
  });
  it('T6: editing the stored tier to bot_admin in the database does not let a Manager card apply (tier mismatch refused, both tiers named)', async () => {
    const c = await stored([{ kind: 'member.kick', member: U.alice }], T.mgr, [U.alice]);
    const x = rig({ stored: { ...c, snapshot: { ...(c.snapshot as object), tier: 'bot_admin' } } });
    const r = await x.svc.apply(CARD_ID);
    expect(r).toMatchObject({ kind: 'refused', why: expect.stringContaining('proposed as bot_admin, now manager') });
    expect(x.writer.calls).toEqual([]);
    // and a forged ban under that edited tier is refused by the table
    const ban = card({ proposerId: T.mgr, decidedBy: T.mgr, payload: { ops: [{ kind: 'member.ban', member: U.alice, deleteDays: 0 }], named: [U.alice] }, snapshot: { snaps: [{}], tier: 'bot_admin' } });
    expect(await rig({ stored: ban }).svc.apply(CARD_ID)).toMatchObject({ kind: 'refused' });
  });
  it('T1/T22: a Moderator whose role is removed between propose and confirm is refused; one promoted to Manager is refused too (both tiers in the row)', async () => {
    const c = await stored([{ kind: 'msg.pin', channel: S.plain, message: S.msgAlice }], T.mod, [S.msgAlice]);
    const gone = world();
    gone.members.get(T.mod)!.roleIds = [];
    const x = rig({ stored: c, data: gone });
    expect(await x.svc.apply(CARD_ID)).toMatchObject({ kind: 'refused', why: expect.stringContaining('holds no Bot Admin, Manager or Moderator role') });
    expect(x.writer.calls).toEqual([]);
    const up = world();
    up.members.get(T.mod)!.roleIds = [T.mgrRole];
    const y = rig({ stored: c, data: up });
    expect(await y.svc.apply(CARD_ID)).toMatchObject({ kind: 'refused', why: expect.stringContaining('proposed as moderator, now manager') });
    expect(y.audits.at(-1)!.actor).toBe(`user:${T.mod} via praw tier:manager`);
  });
  it('T1: the decider is checked live too: no recorded decider, a decider who lost every role, or a tier decider who is not the proposer are refused', async () => {
    const c = await stored([{ kind: 'msg.pin', channel: S.plain, message: S.msgAlice }], T.mod, [S.msgAlice]);
    expect(await rig({ stored: { ...c, decidedBy: null } }).svc.apply(CARD_ID)).toMatchObject({ kind: 'refused', why: expect.stringContaining('no recorded decider') });
    const x = rig({ stored: { ...c, decidedBy: T.nobody } });
    expect(await x.svc.apply(CARD_ID)).toMatchObject({ kind: 'refused', why: expect.stringContaining('decider') });
    expect(await rig({ stored: { ...c, decidedBy: U.admin } }).svc.apply(CARD_ID)).toMatchObject({ kind: 'refused', why: expect.stringContaining('only the proposer can confirm') });
    expect(await rig({ stored: c, failMember: [T.mod] }).svc.apply(CARD_ID)).toMatchObject({ kind: 'refused', why: expect.stringContaining('could not be fetched') });
    expect(await rig({ stored: c, tiersFail: true }).svc.apply(CARD_ID)).toMatchObject({ kind: 'refused' });
  });
  it('the existing Bot Admin path is hardened too: a Bot Admin whose role is gone cannot get a stored card applied', async () => {
    const c = await stored([{ kind: 'welcome.resume' }].length ? [{ kind: 'channel.edit', channel: S.plain, topic: 'x' }] : [], U.admin);
    const d = world();
    d.members.get(U.admin)!.roleIds = [];
    const x = rig({ stored: c, data: d });
    expect(await x.svc.apply(CARD_ID)).toMatchObject({ kind: 'refused', why: expect.stringContaining('proposer') });
    expect(x.writer.calls).toEqual([]);
    expect(await rig({ stored: c }).svc.apply(CARD_ID)).toMatchObject({ kind: 'done', ok: true });
  });
  it('G2T-02/03: a tier card must sit in the mod room; a #setting card needs a Bot Admin proposer and decider', async () => {
    const mgr = await stored([{ kind: 'channel.edit', channel: T.openCh, topic: 'hi' }], T.mgr);
    expect(await rig({ stored: { ...mgr, channelId: C.setting } }).svc.apply(CARD_ID)).toMatchObject({ kind: 'refused', why: expect.stringContaining('channel does not match') });
    expect(await rig({ stored: { ...mgr, channelId: T.room }, cfg: { ...CFG, modRoomId: null } }).svc.apply(CARD_ID)).toMatchObject({ kind: 'refused' });
    expect(await rig({ stored: mgr }).svc.apply(CARD_ID)).toMatchObject({ kind: 'done' });
    const adm = await stored([{ kind: 'channel.edit', channel: T.openCh, topic: 'hi' }], U.admin, [], { channelId: C.setting });
    expect(await rig({ stored: adm }).svc.apply(CARD_ID)).toMatchObject({ kind: 'done' });
    expect(await rig({ stored: { ...adm, channelId: T.room } }).svc.apply(CARD_ID)).toMatchObject({ kind: 'refused' });
    expect(await rig({ stored: { ...adm, decidedBy: T.mgr } }).svc.apply(CARD_ID)).toMatchObject({ kind: 'refused' });
  });
  it('T21: a Manager apply writes server.* rows whose actor carries tier:manager, evaluated by the executor; the rate gate sees the same tier', async () => {
    const c = await stored([{ kind: 'channel.edit', channel: T.openCh, topic: 'hello' }], T.mgr);
    const x = rig({ stored: c });
    expect(await x.svc.apply(CARD_ID)).toMatchObject({ kind: 'done', ok: true });
    expect(x.audits.map((a) => a.actor)).toEqual([`user:${T.mgr} via praw tier:manager`]);
    expect(x.rate.check).toHaveBeenLastCalledWith(T.mgr, 1, 0, 'manager');
  });
});

describe('T7/T8/T9: the tier roles are re-validated at every apply', () => {
  it('adding ManageMessages to the Moderator role makes the next Moderator propose and apply refuse, alerts #bot-log, and Bot Admin cards still work', async () => {
    const c = await stored([{ kind: 'msg.pin', channel: S.plain, message: S.msgAlice }], T.mod, [S.msgAlice]);
    const d = world();
    d.roles.find((r) => r.id === T.modRole)!.permissions = SAFE | F.ManageMessages;
    const x = rig({ stored: c, data: d });
    expect(await x.svc.apply(CARD_ID)).toMatchObject({ kind: 'refused', why: expect.stringContaining('not safe') });
    expect(x.pushed.some((p) => p.kind === 'alert')).toBe(true);
    expect(x.writer.calls).toEqual([]);
    expect(await propose(rig({ data: d }), [{ kind: 'msg.pin', channel: S.plain, message: S.msgAlice }], T.mod, [S.msgAlice])).toMatchObject(refusedWith(/not safe/));
    // a Manager is refused too (all tier cards), a Bot Admin is not
    expect(await propose(rig({ data: d }), [{ kind: 'channel.edit', channel: T.openCh, topic: 'x' }], T.mgr)).toMatchObject(refusedWith(/not safe/));
    expect(await propose(rig({ data: d }), [{ kind: 'channel.edit', channel: T.openCh, topic: 'x' }], U.admin)).toMatchObject({ ok: true });
  });
  it('each rule fails the tier cards: managed, @everyone, privileged, at or above the executor, held by a bot, same role twice, a welcome default role', async () => {
    // the proposer holds the tier role that is NOT being broken, so the tier is still derived and the other role is the one judged
    const run = async (mut: (d: ReturnType<typeof world>) => void, cfg: TierConfig = CFG, welcome: string[] = [], by: string = T.mod) => {
      const d = world();
      mut(d);
      return propose(rig({ data: d, cfg, welcome }), [{ kind: 'msg.pin', channel: S.plain, message: S.msgAlice }], by, [S.msgAlice]);
    };
    expect(await run((d) => void (d.roles.find((r) => r.id === T.modRole)!.managed = true))).toMatchObject(refusedWith(/managed/));
    expect(await run(() => undefined, { ...CFG, moderatorId: GUILD_EVERYONE }, [], T.mgr)).toMatchObject(refusedWith(/everyone/));
    expect(await run(() => undefined, { ...CFG, managerId: R.founder })).toMatchObject(refusedWith(/Bot Admin or Founder/));
    expect(await run(() => undefined, { ...CFG, managerId: R.botAdmin })).toMatchObject(refusedWith(/Bot Admin or Founder/));
    expect(await run(() => undefined, { ...CFG, managerId: R.mod })).toMatchObject(refusedWith(/privileged/));
    expect(await run((d) => void (d.roles.find((r) => r.id === T.modRole)!.position = 10))).toMatchObject(refusedWith(/at or above/));
    expect(await run(() => undefined, { ...CFG, moderatorId: R.botRole }, [], T.mgr)).toMatchObject(refusedWith(/held by a bot/));
    expect(await run(() => undefined, { ...CFG, managerId: T.modRole })).toMatchObject(refusedWith(/same role/));
    expect(await run(() => undefined, CFG, [T.modRole])).toMatchObject(refusedWith(/welcome default role/));
    expect(await run(() => undefined, { ...CFG, moderatorId: id(999) }, [], T.mgr)).toMatchObject(refusedWith(/was not found/));
  });
  it('T9/T24: no Praw role operation can grant, remove or edit the Bot Admin, Manager or Moderator role, not even for a Bot Admin; a welcome config naming a tier role is refused', async () => {
    const x = rig();
    for (const role of [T.modRole, T.mgrRole, R.botAdmin]) {
      expect(await x.svc.propose('perm', [{ kind: 'role.assign', member: U.alice, role }], { userId: U.admin, namedIds: [] }), role).toMatchObject({ ok: false });
      expect(await x.svc.propose('perm', [{ kind: 'role.remove', member: U.bob, role }], { userId: U.admin, namedIds: [] }), role).toMatchObject({ ok: false });
      expect(await x.svc.propose('perm', [{ kind: 'role.edit.permissions', role, permissions: '1024' }], { userId: U.admin, namedIds: [] }), role).toMatchObject({ ok: false });
    }
    expect(await x.svc.propose('perm', [{ kind: 'role.assign', member: U.alice, role: T.modRole }], { userId: U.admin, namedIds: [] })).toMatchObject(refusedWith(/assign them in Discord/));
    expect(await x.svc.checkWelcome([T.mgrRole], null)).toContain('tier role');
    expect(await x.svc.checkWelcome([T.modRole], null)).toContain('tier role');
    // the same forged perm card is refused at apply
    const forged = card({ kind: 'perm', proposerId: U.admin, decidedBy: U.admin, payload: { ops: [{ kind: 'role.assign', member: U.alice, role: T.modRole }] }, snapshot: {} });
    const y = rig({ stored: forged });
    expect(await y.svc.apply(CARD_ID)).toMatchObject({ kind: 'refused', why: expect.stringContaining('assign them in Discord') });
    expect(y.permWriter.calls).toEqual([]);
  });
  it('T10: the config-time check applies the same rules plus a sane mod room', async () => {
    const x = rig();
    expect(await x.svc.checkTierConfig(CFG)).toBeNull();
    expect(await x.svc.checkTierConfig({ ...CFG, modRoomId: C.setting })).toContain('protected or system');
    expect(await x.svc.checkTierConfig({ ...CFG, modRoomId: id(998) })).toContain('could not be read');
    expect(await x.svc.checkTierConfig({ ...CFG, modRoomId: T.staffCat })).toContain('text channel');
    expect(await x.svc.checkTierConfig({ ...CFG, managerId: T.modRole })).toContain('same role');
    expect(await x.svc.checkTierConfig({ managerId: null, moderatorId: null, modRoomId: null })).toBeNull();
  });
});

describe('T11/T12: channels', () => {
  it('a Manager cannot rename, archive, move or edit the mod room, a system channel, the archive or a category holding them', async () => {
    const x = rig();
    for (const op of [
      { kind: 'channel.edit', channel: T.room, topic: 'x' }, { kind: 'channel.archive', channel: T.room }, { kind: 'channel.move', channel: T.room, category: T.openCat },
      { kind: 'channel.edit', channel: T.staffCat, name: 'renamed' }, { kind: 'channel.edit', channel: S.archive, name: 'renamed' }, { kind: 'channel.edit', channel: C.botLog, topic: 'x' },
    ]) expect(await propose(x, [op], T.mgr), JSON.stringify(op)).toMatchObject({ ok: false });
    expect(await propose(x, [{ kind: 'channel.edit', channel: T.room, topic: 'x' }], T.mgr)).toMatchObject(refusedWith(/mod room/));
    expect(await propose(x, [{ kind: 'channel.edit', channel: T.openCh, topic: 'ok' }], T.mgr)).toMatchObject({ ok: true });
  });
  it('T12: a Manager cannot move a channel into or out of a category with a tier overwrite, create under one, or create or rename to the mod room name', async () => {
    const x = rig();
    expect(await propose(x, [{ kind: 'channel.move', channel: T.openCh, category: T.lockedCat }], T.mgr)).toMatchObject(refusedWith(/overwrites for a staff or tier role/));
    expect(await propose(x, [{ kind: 'channel.move', channel: T.lockedCh, category: T.openCat }], T.mgr)).toMatchObject(refusedWith(/overwrites|out of reach/));
    expect(await propose(x, [{ kind: 'channel.make', name: 'new-room', type: 'text', category: T.lockedCat }], T.mgr)).toMatchObject(refusedWith(/inherit/));
    for (const name of ['🛡-mod-room', 'Mod Room', 'MOD_ROOM', 'setting']) {
      expect(await propose(x, [{ kind: 'channel.make', name, type: 'text', category: T.openCat }], T.mgr), name).toMatchObject(refusedWith(/reserved/));
    }
    expect(await propose(x, [{ kind: 'channel.edit', channel: T.openCh, name: 'mod-room' }], T.mgr)).toMatchObject(refusedWith(/reserved/));
    expect(await propose(x, [{ kind: 'channel.make', name: 'fresh-channel', type: 'text', category: T.openCat }], T.mgr)).toMatchObject({ ok: true });
    expect(await propose(x, [{ kind: 'channel.move', channel: T.openCh, category: null }], T.mgr)).toMatchObject({ ok: true });
    // a Bot Admin keeps today's rules (the Open category is fine, a name check does not apply)
    expect(await propose(x, [{ kind: 'channel.make', name: 'mod-room-2', type: 'text', category: T.openCat }], U.admin)).toMatchObject({ ok: true });
  });
  it('a Manager cannot touch a department-mapped channel or set NSFW; a Moderator cannot do channel structure at all', async () => {
    const x = rig();
    expect(await propose(x, [{ kind: 'channel.edit', channel: S.mapped, topic: 'x' }], T.mgr)).toMatchObject({ ok: false });
    expect(await propose(x, [{ kind: 'channel.edit', channel: T.openCh, nsfw: true }], T.mgr)).toMatchObject(refusedWith(/NSFW/));
    expect(await propose(x, [{ kind: 'channel.edit', channel: T.openCh, topic: 'x' }], T.mod)).toMatchObject(refusedWith(/needs the manager role/));
    expect(await propose(x, [{ kind: 'thread.lock', thread: S.threadOk }], T.mod)).toMatchObject({ ok: true });
    expect(await propose(x, [{ kind: 'thread.unlock', thread: S.threadOk }], T.mod)).toMatchObject(refusedWith(/needs the manager role/));
    expect(await propose(x, [{ kind: 'thread.delete', thread: S.threadOk }], T.mgr)).toMatchObject(refusedWith(/needs the bot admin role/));
  });
  it('a mod room the executor cannot see refuses every tier op (it could not protect its name or category), and a Bot Admin is unaffected', async () => {
    const d = world();
    d.channels.delete(T.room);
    const x = rig({ data: d });
    expect(await propose(x, [{ kind: 'channel.make', name: 'mod-room', type: 'text', category: T.openCat }], T.mgr)).toMatchObject(refusedWith(/mod room is not visible to the executor/));
    expect(await propose(x, [{ kind: 'msg.pin', channel: S.plain, message: S.msgAlice }], T.mod, [S.msgAlice])).toMatchObject(refusedWith(/not visible to the executor/));
    expect(await x.svc.checkTierConfig(CFG)).toContain('LW Admin needs View Channel');
    expect(await propose(x, [{ kind: 'channel.make', name: 'mod-room', type: 'text', category: T.openCat }], U.admin)).toMatchObject({ ok: true });
  });
  it('a Moderator cannot delete, pin or bulk-delete in the mod room or a system channel (the messages there are out of reach)', async () => {
    const d = world();
    d.messages.set(T.room, [{ id: id(90), authorId: U.alice, authorBot: false, createdAt: NOW - 1000, pinned: false }]);
    const x = rig({ data: d });
    expect(await propose(x, [{ kind: 'msg.delete', channel: T.room, message: id(90) }], T.mod, [id(90)])).toMatchObject(refusedWith(/mod room/));
    expect(await propose(x, [{ kind: 'msg.bulk', channel: T.room, count: 5 }], T.mod)).toMatchObject(refusedWith(/mod room/));
    expect(await propose(x, [{ kind: 'msg.bulk', channel: C.botLog, count: 5 }], T.mod)).toMatchObject({ ok: false });
  });
});

describe('T15/T16/T17/T18: named targets and the hierarchy, from live roles', () => {
  it('T15: kick, timeout, untimeout and nick need a target named in the proposer\'s own message; a message needs its id', async () => {
    const x = rig();
    expect(await propose(x, [{ kind: 'member.timeout', member: U.alice, minutes: 10 }], T.mod)).toMatchObject(refusedWith(/not named/));
    expect(await propose(x, [{ kind: 'member.kick', member: U.alice }], T.mgr)).toMatchObject(refusedWith(/not named/));
    expect(await propose(x, [{ kind: 'member.nick', member: U.alice, nick: 'Al' }], T.mgr)).toMatchObject(refusedWith(/not named/));
    expect(await propose(x, [{ kind: 'msg.delete', channel: S.plain, message: S.msgAlice }], T.mod)).toMatchObject(refusedWith(/named in your own message/));
    expect(await propose(x, [{ kind: 'msg.pin', channel: S.plain, message: S.msgAlice }], T.mod)).toMatchObject(refusedWith(/named in your own message/));
    expect(await propose(x, [{ kind: 'member.timeout', member: U.alice, minutes: 10 }], T.mod, [U.alice])).toMatchObject({ ok: true });
    // a Bot Admin is unchanged: an unnamed timeout is only a card warning
    expect(await propose(x, [{ kind: 'member.timeout', member: U.alice, minutes: 10 }], U.admin)).toMatchObject({ ok: true });
  });
  it('T16: never your own tier or higher, never yourself, including a member holding both tier roles; a Manager may act on a Moderator, a Moderator not on a Manager', async () => {
    const x = rig();
    const named = [T.mgr2, T.mod2, T.both, T.mod, T.mgr, U.admin];
    expect(await propose(x, [{ kind: 'member.timeout', member: T.mgr2, minutes: 5 }], T.mod, named)).toMatchObject(refusedWith(/at your tier or above/));
    expect(await propose(x, [{ kind: 'member.timeout', member: T.mod2, minutes: 5 }], T.mod, named)).toMatchObject(refusedWith(/at your tier or above/));
    expect(await propose(x, [{ kind: 'member.kick', member: T.both }], T.mgr, named)).toMatchObject(refusedWith(/at your tier or above/));
    expect(await propose(x, [{ kind: 'member.kick', member: T.mgr2 }], T.mgr, named)).toMatchObject(refusedWith(/at your tier or above/));
    expect(await propose(x, [{ kind: 'member.timeout', member: U.admin, minutes: 5 }], T.mgr, named)).toMatchObject({ ok: false });
    expect(await propose(x, [{ kind: 'member.untimeout', member: T.mod }], T.mod, named)).toMatchObject(refusedWith(/yourself/));
    expect(await propose(x, [{ kind: 'member.nick', member: T.mgr, nick: 'x' }], T.mgr, named)).toMatchObject(refusedWith(/yourself/));
    expect(await propose(x, [{ kind: 'member.timeout', member: T.mod, minutes: 5 }], T.mgr, named)).toMatchObject({ ok: true });
  });
  it('T17: a Moderator bulk delete leaves out the messages of a Manager, a Moderator and themselves; the frozen list is filtered again at apply', async () => {
    const x = rig();
    const r = await propose(x, [{ kind: 'msg.bulk', channel: S.plain, count: 50 }], T.mod);
    if (!r.ok) throw new Error(r.error);
    const ids = (r.payload as { ops: { ids: string[] }[] }).ops[0]!.ids;
    expect(ids).toContain(S.msgAlice);
    expect(ids).not.toContain(T.msgMgr);
    expect(ids).not.toContain(T.msgMod);
    expect(ids).not.toContain(T.msgMod2);
    // a message by a member promoted to Manager after propose is spared at apply
    const c = card({ proposerId: T.mod, decidedBy: T.mod, payload: r.payload, snapshot: r.snapshot });
    const d = world();
    d.members.get(U.alice)!.roleIds = [T.mgrRole];
    const y = rig({ stored: c, data: d });
    const done = await y.svc.apply(CARD_ID);
    expect(done).toMatchObject({ kind: 'done', ok: true });
    expect(y.writer.calls.join(' ')).not.toContain(S.msgAlice);
    // a single delete of a Manager's message is refused for a Moderator
    expect(await propose(x, [{ kind: 'msg.delete', channel: S.plain, message: T.msgMgr }], T.mod, [T.msgMgr])).toMatchObject(refusedWith(/own tier or above/));
  });
  it('T18: a Moderator can neither end nor shorten a timeout longer than a Moderator could set; the caps are 50 messages, 1 day and 28 days', async () => {
    const d = world();
    d.members.get(U.alice)!.timeoutUntil = NOW + 7 * 24 * 3600_000;
    d.members.get(U.bob)!.timeoutUntil = NOW + 3600_000;
    const x = rig({ data: d });
    const named = [U.alice, U.bob];
    expect(await propose(x, [{ kind: 'member.untimeout', member: U.alice }], T.mod, named)).toMatchObject(refusedWith(/longer than your role could set/));
    expect(await propose(x, [{ kind: 'member.timeout', member: U.alice, minutes: 10 }], T.mod, named)).toMatchObject(refusedWith(/longer than your role could set/));
    expect(await propose(x, [{ kind: 'member.untimeout', member: U.alice }], T.mgr, named)).toMatchObject({ ok: true });
    expect(await propose(x, [{ kind: 'member.untimeout', member: U.bob }], T.mod, named)).toMatchObject({ ok: true });
    expect(await propose(x, [{ kind: 'msg.bulk', channel: S.plain, count: 51 }], T.mod)).toMatchObject(refusedWith(/at most 50/));
    expect(await propose(x, [{ kind: 'member.timeout', member: U.alice, minutes: 1441 }], T.mod, named)).toMatchObject(refusedWith(/at most 1440/));
    expect(await propose(rig(), [{ kind: 'member.timeout', member: U.alice, minutes: 40_320 }], T.mgr, named)).toMatchObject({ ok: true });
    expect(await propose(rig(), [{ kind: 'member.timeout', member: U.alice, minutes: 40_321 }], T.mgr, named)).toMatchObject({ ok: false });
    expect(await propose(rig(), Array.from({ length: 6 }, (_, i) => ({ kind: 'member.nick', member: U.alice, nick: `n${i}` })), T.mgr, named)).toMatchObject(refusedWith(/at most 5 member operations/));
  });
});

const GUILD_EVERYONE = R.everyone;
