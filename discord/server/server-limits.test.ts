import { describe, expect, it } from 'vitest';
import { PermissionFlagsBits } from 'discord.js';
import { checkServerOps, locationProblem, welcomeRoleProblem, type ServerChecked } from './server-limits.js';
import { ServerOp, ServerProposal } from './server-ops.js';
import { fakeServerWorld, NOW, S, serverConsts, serverData, serverIn, type ServerData } from './server-fixture.js';
import { C, R, U, id } from '../test-helpers.js';

/** Runs the ops through the real schema and the hard limits. Propose and apply share this function (Gate 1 S1, S36); the apply half is `again`. */
async function run(ops: unknown[], o: { data?: ServerData; named?: string[]; paused?: boolean } = {}): Promise<ServerChecked> {
  const parsed = ServerProposal.safeParse({ ops });
  if (!parsed.success) return { ok: false, error: `schema: ${parsed.error.issues[0]?.message}` };
  const world = fakeServerWorld(o.data ?? serverData());
  return checkServerOps(parsed.data.ops, world, serverConsts(), serverIn({ named: o.named ?? [], welcomePaused: async () => o.paused ?? false }));
}
const refused = async (ops: unknown[], re: RegExp, o: Parameters<typeof run>[1] = {}) => {
  const r = await run(ops, o);
  expect(r.ok, JSON.stringify(ops)).toBe(false);
  if (!r.ok) expect(r.error).toMatch(re);
};
const happy = async (ops: unknown[], o: Parameters<typeof run>[1] = {}) => {
  const r = await run(ops, o);
  if (!r.ok) throw new Error(r.error);
  return r;
};

describe('channels (S15, S16, S17)', () => {
  it('edit: a happy path shows old and new', async () => {
    const r = await happy([{ kind: 'channel.edit', channel: S.plain, name: 'chat-2', topic: 'new', slowmode: 10, nsfw: true }]);
    expect(r.resolved[0]!.item).toMatchObject({ label: 'Edit channel', old: expect.stringContaining('"chat"'), neu: expect.stringContaining('slowmode 10s') });
  });
  it.each([
    ['a DENIED channel', C.deniedCh], ['a channel in a DENIED category', C.inDeniedCat], ['a system channel', C.setting], ['bot-log', C.botLog], ['the rules channel', S.rules],
    ['a thread', S.threadOk], ['a channel with an unreadable parent', C.orphan], ['an unknown channel', id(999)],
  ])('edit refuses %s', async (_n, channel) => {
    await refused([{ kind: 'channel.edit', channel, topic: 'x' }], /off limits|never changed|thread|could not be read|protected/);
  });
  it('edit with nothing to change, or a bad name, is refused', async () => {
    await refused([{ kind: 'channel.edit', channel: S.plain, name: 'chat' }], /nothing would change/);
    await refused([{ kind: 'channel.edit', channel: S.plain, name: '<@123>' }], /name may use/);
  });
  it('move: a category and a position; never into or out of a DENIED category; lockPermissions is not an op field', async () => {
    const r = await happy([{ kind: 'channel.move', channel: S.plain, category: S.archive, position: 2 }]);
    expect(r.resolved[0]!.item.neu).toContain('permissions are kept');
    await refused([{ kind: 'channel.move', channel: S.plain, category: C.deniedCat }], /off limits/);
    await refused([{ kind: 'channel.move', channel: C.inDeniedCat, category: C.cat }], /off limits|protected/);
    await refused([{ kind: 'channel.move', channel: S.plain, category: S.logs }], /Logs category|never changed/);
    await refused([{ kind: 'channel.move', channel: S.plain, category: C.general }], /not a category/);
    await refused([{ kind: 'channel.move', channel: S.plain, category: C.cat }], /already there/);
    expect(ServerOp.safeParse({ kind: 'channel.move', channel: S.plain, category: C.cat, lockPermissions: true }).success).toBe(false);
  });
  it('make: every type; refuses the Logs and DENIED categories and odd names', async () => {
    for (const type of ['text', 'voice', 'forum', 'stage', 'announcement']) await happy([{ kind: 'channel.make', name: 'new-room', type, category: C.cat }]);
    await happy([{ kind: 'channel.make', name: 'New Group', type: 'category', category: null }]);
    await refused([{ kind: 'channel.make', name: 'x', type: 'text', category: S.logs }], /Logs category|never changed/);
    await refused([{ kind: 'channel.make', name: 'x', type: 'text', category: C.deniedCat }], /off limits/);
    await refused([{ kind: 'channel.make', name: 'x', type: 'category', category: C.cat }], /inside a category/);
    await refused([{ kind: 'channel.make', name: '@everyone', type: 'text', category: null }], /name may use/);
  });
  it('archive: moves to the Archive category; refuses mapped, protected, already-archived and a missing or doubled Archive category', async () => {
    const r = await happy([{ kind: 'channel.archive', channel: S.plain }]);
    expect(r.resolved[0]!.item.neu).toContain('@everyone cannot send');
    await refused([{ kind: 'channel.archive', channel: S.mapped }], /mapped to a department/);
    await refused([{ kind: 'channel.archive', channel: S.archivedCh }], /already archived/);
    await refused([{ kind: 'channel.archive', channel: S.rules }], /never changed/);
    await refused([{ kind: 'channel.archive', channel: C.setting }], /never changed/);
    await refused([{ kind: 'channel.archive', channel: C.cat }], /category cannot be archived/);
    const none = serverData();
    none.channels.delete(S.archive);
    await refused([{ kind: 'channel.archive', channel: S.plain }], /exactly one category/, { data: none });
    const two = serverData();
    two.channels.set(id(900), { id: id(900), name: '📦 Archive', type: 4, parentId: null, isThread: false, overwrites: [] });
    await refused([{ kind: 'channel.archive', channel: S.plain }], /exactly one category/, { data: two });
  });
  it('delete: only empty, or archived by this application 7+ days ago and still in Archive', async () => {
    await happy([{ kind: 'channel.delete', channel: S.emptyCh }]);
    await refused([{ kind: 'channel.delete', channel: S.busyCh }], /only an empty channel/);
    const ok = await happy([{ kind: 'channel.delete', channel: S.archivedCh }]);
    expect(ok.resolved[0]!.item.neu).toContain('archived 8 days ago');
    expect(ok.resolved[0]!.destructive).toBe(true);
    const young = serverData();
    young.archived.set(S.archivedCh, NOW - 6 * 24 * 3600_000);
    await refused([{ kind: 'channel.delete', channel: S.archivedCh }], /archived 6 day/, { data: young });
    const dragged = serverData();
    dragged.archived.delete(S.archivedCh); // dragged into Archive by hand: no row of ours
    await refused([{ kind: 'channel.delete', channel: S.archivedCh }], /only an empty channel/, { data: dragged });
    const moved = serverData();
    moved.channels.get(S.archivedCh)!.parentId = C.cat; // archived, then moved out again
    await refused([{ kind: 'channel.delete', channel: S.archivedCh }], /only an empty channel/, { data: moved });
  });
  it('delete never touches the Archive category, mapped, protected, DENIED or unknown-state channels', async () => {
    const d = serverData();
    d.empty.set(S.archive, true);
    d.empty.set(S.mapped, true);
    d.empty.set(S.rules, true);
    await refused([{ kind: 'channel.delete', channel: S.archive }], /Archive category is never deleted/, { data: d });
    await refused([{ kind: 'channel.delete', channel: S.mapped }], /mapped to a department/, { data: d });
    await refused([{ kind: 'channel.delete', channel: S.rules }], /never changed/, { data: d });
    await refused([{ kind: 'channel.delete', channel: C.setting }], /never changed/, { data: d });
    await refused([{ kind: 'channel.delete', channel: C.deniedCat }], /off limits/, { data: d });
    await refused([{ kind: 'channel.delete', channel: C.inDeniedCat }], /off limits|protected/, { data: d });
    d.empty.delete(S.plain);
    await refused([{ kind: 'channel.delete', channel: S.plain }], /could not be read/, { data: d });
  });
  it('threads: archive, lock, unlock, delete; never a card thread under #setting or a thread under a DENIED channel', async () => {
    await happy([{ kind: 'thread.archive', thread: S.threadOk }, { kind: 'thread.lock', thread: S.threadOk }, { kind: 'thread.delete', thread: S.threadOk }]);
    await refused([{ kind: 'thread.archive', thread: S.threadUnderSetting }], /system threads are never changed/);
    await refused([{ kind: 'thread.delete', thread: S.threadUnderDenied }], /protected channel|off limits/);
    await refused([{ kind: 'thread.archive', thread: S.plain }], /not a thread/);
    await refused([{ kind: 'thread.unlock', thread: S.threadOk }], /not locked/);
    const d = serverData();
    d.channels.get(S.threadOk)!.archived = true;
    await refused([{ kind: 'thread.archive', thread: S.threadOk }], /already archived/, { data: d });
  });
});

describe('members (S18, S19, S20, S25)', () => {
  it('nickname: shown verbatim with the live name; an unnamed target is a warning; never-act-on members are refused', async () => {
    const r = await happy([{ kind: 'member.nick', member: U.alice, nick: 'Al' }]);
    expect(r.resolved[0]!.item).toMatchObject({ old: expect.stringContaining('Ally'), neu: '"Al"', warn: expect.stringContaining('chosen by Praw') });
    const named = await happy([{ kind: 'member.nick', member: U.alice, nick: null }], { named: [U.alice] });
    expect(named.resolved[0]!.item.warn).toBeUndefined();
    await refused([{ kind: 'member.nick', member: U.founder, nick: 'x' }], /Founder, Bot Admin|privileged/);
    await refused([{ kind: 'member.nick', member: U.admin, nick: 'x' }], /Bot Admin/);
    await refused([{ kind: 'member.nick', member: U.owner, nick: 'x' }], /server owner/);
    await refused([{ kind: 'member.nick', member: U.eve, nick: 'x' }], /is a bot/);
    await refused([{ kind: 'member.nick', member: U.praw, nick: 'x' }], /does not change herself/);
    await refused([{ kind: 'member.nick', member: id(998), nick: 'x' }], /could not be fetched/);
    await refused([{ kind: 'member.nick', member: U.alice, nick: '<@123456789012345678>' }], /mention syntax/);
    await refused([{ kind: 'member.nick', member: U.alice, nick: 'a'.repeat(33) }], /schema/);
    const high = serverData();
    high.members.set(id(700), { id: id(700), isBot: false, roleIds: [R.high], isOwner: false });
    await refused([{ kind: 'member.nick', member: id(700), nick: 'x' }], /at or above the executor/, { data: high });
  });
  it('timeout: at most 28 days; over a day is a warning; end a timeout only when one is running', async () => {
    const r = await happy([{ kind: 'member.timeout', member: U.alice, minutes: 2000, reason: 'spamming' }], { named: [U.alice] });
    expect(r.resolved[0]!.item).toMatchObject({ warn: expect.stringContaining('longer than 1 day'), neu: expect.stringContaining('reason: "spamming"') });
    await refused([{ kind: 'member.timeout', member: U.alice, minutes: 40_321 }], /schema/);
    await refused([{ kind: 'member.timeout', member: U.founder, minutes: 5 }], /privileged|Founder/);
    await refused([{ kind: 'member.untimeout', member: U.alice }], /not timed out/);
    const d = serverData();
    d.members.get(U.alice)!.timeoutUntil = NOW + 60_000;
    await happy([{ kind: 'member.untimeout', member: U.alice }], { data: d });
  });
  it('kick and ban need a target the admin named (injection refused); at most 5 per card', async () => {
    await refused([{ kind: 'member.kick', member: U.alice }], /not named by the admin/);
    await refused([{ kind: 'member.ban', member: U.alice }], /not named by the admin/);
    const k = await happy([{ kind: 'member.kick', member: U.alice, reason: 'rude' }], { named: [U.alice] });
    expect(k.resolved[0]!.destructive).toBe(true);
    const six = [U.alice, U.bob, id(701), id(702), id(703), id(704)];
    await refused(six.map((member) => ({ kind: 'member.kick', member })), /at most 5/, { named: six });
  });
  it('kick, ban and timeout refuse the server owner, Founder, Bot Admin, privileged holders, bots, the executor and higher roles', async () => {
    for (const member of [U.owner, U.founder, U.admin, S.mod2, U.eve, U.botHq, U.praw]) {
      await refused([{ kind: 'member.kick', member }], /./, { named: [member] });
      await refused([{ kind: 'member.ban', member }], /./, { named: [member] });
      await refused([{ kind: 'member.timeout', member, minutes: 5 }], /./, { named: [member] });
    }
  });
  it('ban: delete window default 0, 1 day is a loud warning, more is refused, bots and already-banned users are refused', async () => {
    const def = await happy([{ kind: 'member.ban', member: U.alice }], { named: [U.alice] });
    expect(def.resolved[0]!.op).toMatchObject({ deleteDays: 0 });
    expect(def.resolved[0]!.item.warn).toBeUndefined();
    const one = await happy([{ kind: 'member.ban', member: U.alice, deleteDays: 1 }], { named: [U.alice] });
    expect(one.resolved[0]!.item.warn).toContain('EVERY channel, including channels this application cannot see');
    await refused([{ kind: 'member.ban', member: U.alice, deleteDays: 2 }], /at most 1 day/, { named: [U.alice] });
    await refused([{ kind: 'member.ban', member: S.botUser }], /is a bot/, { named: [S.botUser] });
    await refused([{ kind: 'member.ban', member: S.bannedUser }], /already banned/, { named: [S.bannedUser] });
    await happy([{ kind: 'member.ban', member: S.leaver }], { named: [S.leaver] }); // not a member any more: the user is fetched
    await refused([{ kind: 'member.ban', member: id(997) }], /could not be fetched/, { named: [id(997)] });
  });
  it('unban: only a banned human user', async () => {
    await happy([{ kind: 'member.unban', user: S.bannedUser }]);
    await refused([{ kind: 'member.unban', user: U.alice }], /not banned/);
    await refused([{ kind: 'member.unban', user: S.botUser }], /is a bot/);
  });
  it('S22: a reason with a secret shape or mention syntax is refused; an over-long one fails the schema', async () => {
    await refused([{ kind: 'member.kick', member: U.alice, reason: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' }], /secret/, { named: [U.alice] });
    await refused([{ kind: 'member.kick', member: U.alice, reason: 'bad <@123456789012345678>' }], /mention syntax/, { named: [U.alice] });
    await refused([{ kind: 'member.kick', member: U.alice, reason: 'x'.repeat(201) }], /schema/, { named: [U.alice] });
  });
  it('invites: bounded age and uses (never 0), no DENIED or system channel, revoke only our own', async () => {
    const r = await happy([{ kind: 'invite.create', channel: C.general, maxAgeSeconds: 3600, maxUses: 1 }]);
    expect(r.resolved[0]!.item.neu).toContain('shown only to you');
    await refused([{ kind: 'invite.create', channel: C.general, maxAgeSeconds: 0, maxUses: 1 }], /schema/);
    await refused([{ kind: 'invite.create', channel: C.general, maxAgeSeconds: 3600, maxUses: 0 }], /schema/);
    await refused([{ kind: 'invite.create', channel: C.general, maxAgeSeconds: 604_801, maxUses: 1 }], /schema/);
    await refused([{ kind: 'invite.create', channel: C.deniedCh, maxAgeSeconds: 3600, maxUses: 1 }], /off limits/);
    await refused([{ kind: 'invite.create', channel: C.setting, maxAgeSeconds: 3600, maxUses: 1 }], /never changed/);
    const mine = await happy([{ kind: 'invite.revoke', code: S.inviteMine }]);
    expect(JSON.stringify(mine.resolved[0]!.item)).not.toContain(S.inviteMine); // the card shows a hash, not the capability
    await refused([{ kind: 'invite.revoke', code: S.inviteOther }], /only invites this application created/);
  });
});

describe('moderation messages (S21)', () => {
  const propose = (o: object = {}) => ({ kind: 'msg.bulk', channel: S.plain, count: 100, ...o });
  it('selects by code: not bots, the owner, Founder/Bot Admin holders, pinned or old messages; the card shows count, range and authors but no bodies', async () => {
    const r = await happy([propose()]);
    const op = r.resolved[0]!.op as { ids: string[] };
    expect(op.ids.sort()).toEqual([S.msgAlice, S.msgBob].sort());
    expect(r.resolved[0]!.item.neu).toMatch(/2 message\(s\) from .* to .*; authors: .* \(the text is never shown\)/);
    expect(r.resolved[0]!.item.refs).toEqual([{ kind: 'channel', id: S.plain }]);
    expect(r.resolved[0]!.destructive).toBe(true);
  });
  it('an author filter and a count narrow the selection; nothing eligible is refused', async () => {
    const r = await happy([propose({ author: U.bob })]);
    expect((r.resolved[0]!.op as { ids: string[] }).ids).toEqual([S.msgBob]);
    const one = await happy([propose({ count: 1 })]);
    expect((one.resolved[0]!.op as { ids: string[] }).ids).toHaveLength(1);
    await refused([propose({ author: U.founder })], /no message qualifies/);
    await refused([propose({ author: U.eve })], /no message qualifies/);
  });
  it('apply deletes the stored ids only: a message posted after propose is not in the list, and a now-protected author is dropped', async () => {
    const first = await happy([propose()]);
    const stored = first.resolved[0]!.op;
    const d = serverData();
    d.messages.get(S.plain)!.unshift({ id: id(321), authorId: U.alice, authorBot: false, createdAt: NOW - 1000, pinned: false }); // posted after propose
    const again = await happy([stored], { data: d });
    expect((again.resolved[0]!.op as { ids: string[] }).ids).toEqual((stored as { ids: string[] }).ids); // still exactly the stored ones
    const promoted = serverData();
    promoted.members.get(U.bob)!.roleIds = [R.founder]; // bob became privileged in between
    const r = await happy([stored], { data: promoted });
    expect(r.resolved[0]!.item.old).toBe('1 of 2 stored message(s) can be deleted');
    promoted.members.get(U.alice)!.roleIds = [R.founder];
    await refused([stored], /none of the stored messages/, { data: promoted });
  });
  it('is refused in DENIED and system channels, in threads, and for an unreadable channel', async () => {
    for (const channel of [C.deniedCh, C.inDeniedCat, C.setting, C.botLog, S.rules, S.threadOk]) await refused([propose({ channel })], /off limits|never changed|thread|protected/);
    await refused([propose({ channel: id(996) })], /could not be read/);
    const r = await checkServerOps([propose() as never], fakeServerWorld(serverData(), { failMessages: true }), serverConsts(), serverIn());
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('could not be read') });
  });
  it('single delete, pin and unpin follow the same author rules', async () => {
    await happy([{ kind: 'msg.delete', channel: S.plain, message: S.msgAlice, reason: 'spam' }]);
    for (const message of [S.msgBot, S.msgFounder, S.msgOwner, S.msgAdmin]) {
      await refused([{ kind: 'msg.delete', channel: S.plain, message }], /protected member/);
      await refused([{ kind: 'msg.pin', channel: S.plain, message }], /protected member/);
    }
    await refused([{ kind: 'msg.delete', channel: C.setting, message: S.msgAlice }], /never changed/);
    await refused([{ kind: 'msg.pin', channel: S.plain, message: S.msgPinned }], /already pinned/);
    await happy([{ kind: 'msg.unpin', channel: S.plain, message: S.msgPinned }]);
    await refused([{ kind: 'msg.unpin', channel: S.plain, message: S.msgAlice }], /not pinned/);
    await refused([{ kind: 'msg.delete', channel: S.plain, message: id(995) }], /could not be read/);
  });
});

describe('AutoMod (S28, S29)', () => {
  const create = (o: object = {}) => ({ kind: 'automod.create', name: 'no links', trigger: { type: 'keyword', keywords: ['free nitro'] }, actions: { block: {}, alert: true }, ...o });
  it('creates a rule with the patterns shown in full; the alert channel is fixed to bot-log', async () => {
    const r = await happy([create()]);
    expect(r.resolved[0]!.item.detail).toContain('free nitro');
    expect(r.resolved[0]!.item.neu).toContain('alert to #🧾-bot-log');
    expect(ServerOp.safeParse(create({ actions: { alert: true, alertChannel: C.general } })).success).toBe(false);
  });
  it('refuses: timeout over a day, a URL or mention in the custom message, no action, no patterns, a duplicate name, an unknown trigger', async () => {
    await refused([create({ actions: { timeoutSeconds: 86_401 } })], /schema/);
    await refused([create({ actions: { block: { customMessage: 'see https://evil.example' } } })], /URL, mention/);
    await refused([create({ actions: { block: { customMessage: 'ping @everyone' } } })], /URL, mention/);
    await refused([create({ actions: {} })], /at least one action/);
    await refused([create({ trigger: { type: 'keyword', keywords: [] } })], /needs keywords/);
    await refused([create({ name: 'Bad Words' })], /already exists/);
    await refused([create({ trigger: { type: 'memberProfile', keywords: ['x'] } })], /schema/);
    await happy([create({ trigger: { type: 'spam' }, actions: { block: {} } }), create({ name: 'm', trigger: { type: 'mentionSpam', mentionLimit: 4 }, actions: { timeoutSeconds: 3600 } }), create({ name: 'p', trigger: { type: 'preset', presets: [1, 2] }, actions: { block: {} } })]);
  });
  it('exempting @everyone or every role is refused; one real role is fine', async () => {
    await refused([create({ exemptRoles: [R.everyone] })], /@everyone cannot be exempt/);
    const d = serverData();
    const normal = d.roles.filter((r) => r.id !== R.everyone).map((r) => r.id).slice(0, 20);
    d.roles = d.roles.filter((r) => normal.includes(r.id) || r.id === R.everyone);
    await refused([create({ exemptRoles: normal })], /every role/, { data: d });
    await happy([create({ exemptRoles: [R.staff] })]);
    await refused([create({ exemptChannels: [C.deniedCh] })], /off limits/);
  });
  it('weakening is flagged: disable, delete, an added exemption, an allow entry with *, a raised mention limit', async () => {
    const dis = await happy([{ kind: 'automod.disable', rule: S.rule }]);
    expect(dis.resolved[0]!.item.warn).toContain('switches an AutoMod rule off');
    expect(dis.resolved[0]!.destructive).toBe(true);
    const del = await happy([{ kind: 'automod.delete', rule: S.rule }]);
    expect(del.resolved[0]!.item.warn).toContain('deletes');
    const ex = await happy([{ kind: 'automod.edit', rule: S.rule, exemptRoles: [R.staff] }]);
    expect(ex.resolved[0]!.item.warn).toContain('adds an exemption');
    const wild = await happy([{ kind: 'automod.edit', rule: S.rule, trigger: { type: 'keyword', keywords: ['spam'], allow: ['*ok*'] } }]);
    expect(wild.resolved[0]!.item.warn).toContain('wildcard');
    const up = await happy([{ kind: 'automod.edit', rule: S.ruleMention, trigger: { type: 'mentionSpam', mentionLimit: 20 } }]);
    expect(up.resolved[0]!.item.warn).toContain('mention limit');
    const en = await happy([{ kind: 'automod.enable', rule: S.rule }].slice(0, 0).concat([{ kind: 'automod.disable', rule: S.ruleMention }]));
    expect(en.ok).toBe(true);
  });
  it('edit/enable/delete refuse unknown rules, an already-set state and a changed trigger type', async () => {
    await refused([{ kind: 'automod.enable', rule: S.rule }], /already enabled/);
    await refused([{ kind: 'automod.delete', rule: id(990) }], /no such AutoMod rule/);
    await refused([{ kind: 'automod.edit', rule: S.rule, trigger: { type: 'spam' } }], /trigger type of a rule cannot change/);
    await refused([{ kind: 'automod.edit', rule: S.rule }], /nothing would change/);
    const d = serverData();
    d.rules[0]!.triggerType = 6;
    await refused([{ kind: 'automod.disable', rule: S.rule }], /not managed here/, { data: d });
  });
});

describe('server settings and events (S23, S26)', () => {
  it('guild.edit: only name, description, system and rules channel; any other key fails the strict schema', async () => {
    const r = await happy([{ kind: 'guild.edit', name: 'Lab Two', description: 'new', systemChannel: S.plain, rulesChannel: null }]);
    expect(r.resolved[0]!.item.old).toContain('name "Lab"');
    for (const k of ['verificationLevel', 'explicitContentFilter', 'mfaLevel', 'ownerId', 'vanityURLCode', 'widgetEnabled', 'icon', 'banner']) {
      expect(ServerOp.safeParse({ kind: 'guild.edit', [k]: 1 }).success, k).toBe(false);
    }
    await refused([{ kind: 'guild.edit', systemChannel: C.deniedCh }], /off limits/);
    await refused([{ kind: 'guild.edit', systemChannel: C.setting }], /never changed/);
    await refused([{ kind: 'guild.edit', rulesChannel: S.logs }], /Logs category|never changed/);
    await refused([{ kind: 'guild.edit', systemChannel: C.voice }], /must be a text channel/);
    await refused([{ kind: 'guild.edit', name: 'Lab' }], /nothing would change/);
    await refused([{ kind: 'guild.edit', description: 'x'.repeat(121) }], /schema/);
  });
  it('event location: https only, no userinfo, <= 100 chars, syntactic (an IDN host is shown as punycode); no resolver is involved', async () => {
    expect(locationProblem('https://example.org/a')).toEqual({ host: 'example.org' });
    expect(locationProblem('https://bücher.example/x')).toEqual({ host: 'xn--bcher-kva.example' });
    for (const bad of ['http://example.org', 'javascript:alert(1)', 'https://user:pw@example.org', 'https://u@example.org', 'ftp://x.y', 'not a url', `https://example.org/${'a'.repeat(100)}`]) expect('problem' in locationProblem(bad), bad).toBe(true);
    const start = new Date(NOW + 86_400_000).toISOString();
    const end = new Date(NOW + 90_000_000).toISOString();
    const r = await happy([{ kind: 'event.create', name: 'Meetup', type: 'external', location: 'https://bücher.example/x', start, end }]);
    expect(r.resolved[0]!.item.neu).toContain('host xn--bcher-kva.example');
    await refused([{ kind: 'event.create', name: 'M', type: 'external', location: 'http://example.org', start, end }], /https/);
    await refused([{ kind: 'event.create', name: 'M', type: 'external', location: 'https://example.org', start }], /needs an end time/);
  });
  it('voice and stage events need a matching, non-system channel and a sane time; edit and cancel only for scheduled events', async () => {
    const start = new Date(NOW + 86_400_000).toISOString();
    await happy([{ kind: 'event.create', name: 'Talk', type: 'voice', channel: C.voice, start }, { kind: 'event.create', name: 'Stage', type: 'stage', channel: S.stage, start }]);
    await refused([{ kind: 'event.create', name: 'T', type: 'voice', channel: C.setting, start }], /never changed/);
    await refused([{ kind: 'event.create', name: 'T', type: 'voice', channel: C.deniedCh, start }], /off limits/);
    await refused([{ kind: 'event.create', name: 'T', type: 'stage', channel: C.voice, start }], /not a stage/);
    await refused([{ kind: 'event.create', name: 'T', type: 'voice', start }], /needs a channel/);
    await refused([{ kind: 'event.create', name: 'T', type: 'voice', channel: C.voice, start: new Date(NOW + 1000).toISOString() }], /at least a minute/);
    await happy([{ kind: 'event.edit', event: S.event, name: 'Demo 2' }, { kind: 'event.cancel', event: S.event }]);
    await refused([{ kind: 'event.cancel', event: S.eventStarted }], /only a scheduled/);
    await refused([{ kind: 'event.edit', event: id(989), name: 'x' }], /no such scheduled event/);
  });
});

describe('welcome.resume and the card as a whole', () => {
  it('resume works only while the flow is paused', async () => {
    await refused([{ kind: 'welcome.resume' }], /not paused/);
    await happy([{ kind: 'welcome.resume' }], { paused: true });
  });
  it('1 to 20 ops per card; the first refused op refuses the whole card and names its number', async () => {
    expect((await run([])).ok).toBe(false);
    const ops = Array.from({ length: 21 }, () => ({ kind: 'channel.edit', channel: S.plain, topic: 't' }));
    expect((await run(ops)).ok).toBe(false);
    await refused([{ kind: 'channel.edit', channel: S.plain, topic: 'ok' }, { kind: 'channel.edit', channel: C.setting, topic: 'x' }], /operation 2 \(channel\.edit\) refused/);
  });
  it('the constants must be filled in (fail closed)', async () => {
    const r = await checkServerOps([{ kind: 'welcome.resume' }], fakeServerWorld(), serverConsts({ founderRoleId: '' }), serverIn({ welcomePaused: async () => true }));
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('not filled in') });
  });
  it('an unreadable guild, channel list or Logs category refuses (fail closed)', async () => {
    const w = fakeServerWorld(serverData(), { noGuild: true });
    expect(await checkServerOps([{ kind: 'welcome.resume' }], w, serverConsts(), serverIn({ welcomePaused: async () => true }))).toMatchObject({ ok: false, error: expect.stringContaining('server could not be read') });
    const d = serverData();
    d.channels.delete(C.botLog);
    expect((await run([{ kind: 'welcome.resume' }], { data: d, paused: true }))).toMatchObject({ ok: false, error: expect.stringContaining('Logs category') });
  });
});

describe('welcome default roles (S12)', () => {
  const check = (roleId: string, mutate: (d: ServerData) => void = () => undefined) => {
    const d = serverData();
    mutate(d);
    return welcomeRoleProblem(roleId, fakeServerWorld(d), serverConsts());
  };
  it('a safe, unmanaged role below the executor passes', async () => {
    expect(await check(R.staff)).toBeNull();
  });
  it('is refused: missing, @everyone, managed, privileged, Founder, Bot Admin, at or above the executor, held by a bot, carrying power, allowed into a system channel', async () => {
    expect(await check(id(880))).toMatch(/not found/);
    expect(await check(R.everyone)).toMatch(/@everyone/);
    expect(await check(R.managedOther)).toMatch(/managed/);
    for (const r of [R.mod, R.founder, R.botAdmin]) expect(await check(r)).toMatch(/privileged/);
    expect(await check(R.high)).toMatch(/at or above/);
    expect(await check(R.botRole)).toMatch(/held by a bot/);
    expect(await check(R.powerful)).toMatch(/powers beyond the safe set/);
    // a role edited after config to carry Manage Messages is no longer assignable
    expect(await check(R.staff, (d) => { d.roles.find((r) => r.id === R.staff)!.permissions |= PermissionFlagsBits.ManageMessages; })).toMatch(/powers beyond/);
    expect(await check(R.extra, (d) => { d.channels.get(C.setting)!.overwrites.push({ id: R.extra, type: 'role', allow: PermissionFlagsBits.ViewChannel, deny: 0n }); })).toMatch(/system channel/);
  });
});

describe('Gate 2 fixes (G2SM-03, -04, -05, -06)', () => {
  const SECRET = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
  it('G2SM-03: a value the masker would change is refused in every free-text family (card would show it redacted, Discord would get it raw)', async () => {
    const start = new Date(NOW + 86_400_000).toISOString();
    for (const op of [
      { kind: 'automod.create', name: 'r', trigger: { type: 'keyword', keywords: [SECRET] }, actions: { block: {} } },
      { kind: 'automod.create', name: SECRET, trigger: { type: 'keyword', keywords: ['a'] }, actions: { block: {} } },
      { kind: 'automod.create', name: 'r', trigger: { type: 'keyword', keywords: ['a'], regex: [SECRET] }, actions: { block: {} } },
      { kind: 'automod.create', name: 'r', trigger: { type: 'keyword', keywords: ['a'], allow: [SECRET] }, actions: { block: {} } },
      { kind: 'automod.edit', rule: S.rule, trigger: { type: 'keyword', keywords: [SECRET] } },
      { kind: 'channel.edit', channel: S.plain, topic: SECRET },
      { kind: 'channel.make', name: 'ok', type: 'text', category: null, topic: SECRET },
      { kind: 'guild.edit', name: SECRET },
      { kind: 'guild.edit', description: SECRET },
      { kind: 'event.create', name: SECRET, type: 'voice', channel: C.voice, start },
      { kind: 'event.create', name: 'e', type: 'voice', channel: C.voice, start, description: SECRET },
      { kind: 'event.edit', event: S.event, description: SECRET },
      { kind: 'member.nick', member: U.alice, nick: 'sk-ant-api03-abcdefghij' },
    ]) await refused([op], /secret/);
  });
  it('G2SM-04: a failed member fetch never skips the never-act-on checks on a ban; the server owner is refused', async () => {
    const d = serverData();
    const w = fakeServerWorld(d, { failMemberFetch: [U.founder, U.alice] });
    const r = await checkServerOps([{ kind: 'member.ban', member: U.founder, deleteDays: 0 }], w, serverConsts(), serverIn({ named: [U.founder] }));
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('could not be checked') });
    expect(await checkServerOps([{ kind: 'member.ban', member: U.alice, deleteDays: 0 }], w, serverConsts(), serverIn({ named: [U.alice] }))).toMatchObject({ ok: false });
    await refused([{ kind: 'member.ban', member: U.founder }], /privileged|Founder/, { named: [U.founder] }); // and with a healthy fetch the Founder is refused too
    d.users.set(U.owner, { id: U.owner, isBot: false, username: 'owner' });
    await refused([{ kind: 'member.ban', member: U.owner }], /server owner/, { named: [U.owner], data: d });
  });
  it('G2SM-06: the block message refuses bare domains, markdown links and spaced-out invites', async () => {
    const mk = (customMessage: string) => ({ kind: 'automod.create', name: 'm', trigger: { type: 'keyword', keywords: ['a'] }, actions: { block: { customMessage } } });
    for (const m of ['login at evil.example/verify', '[discord](evil.example)', 'discord . gg / abc', 'visit evil.example', 'a](b']) await refused([mk(m)], /URL, mention/);
    await happy([mk('That word is not allowed here.')]);
  });
  it('G2SM-05: the create card names the exemptions (mention + id) and warns like an edit would', async () => {
    const r = await happy([{ kind: 'automod.create', name: 'm', trigger: { type: 'keyword', keywords: ['a'], allow: ['*ok*'] }, actions: { block: {} }, exemptRoles: [R.staff], exemptChannels: [S.plain] }]);
    expect(r.resolved[0]!.item.refs).toEqual([{ kind: 'role', id: R.staff }, { kind: 'channel', id: S.plain }]);
    expect(r.resolved[0]!.item.warn).toMatch(/exemption.*wildcard/);
  });
});
