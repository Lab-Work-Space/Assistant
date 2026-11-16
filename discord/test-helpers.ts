import { PermissionFlagsBits } from 'discord.js';
import type { PermConsts } from './perm/perm-limits.js';
import { CATEGORY_TYPE, type ChannelInfo, type MemberInfo, type PermWorld, type PermWriter, type RoleInfo } from './perm/perm-world.js';
import { SAFE_BITS } from './perm/perm-bits.js';

export const F = PermissionFlagsBits;
export const GUILD_ID = '1565649426943442944';
export const id = (n: number) => String(700_000_000_000_000_000n + BigInt(n));
export const R = { everyone: GUILD_ID, founder: id(1), botAdmin: id(2), mod: id(3), staff: id(4), prawTop: id(5), botRole: id(6), managedOther: id(7), high: id(8), extra: id(9), powerful: id(10) };
export const U = { praw: id(20), owner: id(21), alice: id(22), bob: id(23), admin: id(24), founder: id(25), botHq: id(26), botSw: id(27), eve: id(28) };
export const C = { general: id(40), cat: id(41), deniedCat: id(42), inDeniedCat: id(43), deniedCh: '1565715069969502310', setting: '1565667791938387969', botLog: '1566454343820124352', thread: id(44), unreadable: id(45), orphan: id(46), voice: id(47) };

export const consts = (over: Partial<PermConsts> = {}): PermConsts => ({
  deniedChannelIds: ['1565715069969502310', '1565649677280485457'], deniedCategoryIds: [C.deniedCat], founderRoleId: R.founder,
  privilegedRoleIds: [R.founder, R.mod], systemChannelIds: [C.setting, C.botLog, '1565671253803794494', '1565671325597700157', '1566366032094961705'],
  botAdminRoleId: R.botAdmin, expectedBotCount: 2, ...over,
});

const role = (r: Partial<RoleInfo> & { id: string; name: string; position: number }): RoleInfo => ({ managed: false, botId: null, permissions: 0n, ...r });
const SAFE = SAFE_BITS.reduce((a, b) => a | b, 0n);

export function worldData() {
  const roles: RoleInfo[] = [
    role({ id: R.everyone, name: '@everyone', position: 0, permissions: F.ViewChannel | F.SendMessages }),
    role({ id: R.staff, name: 'Staff', position: 2, permissions: SAFE }),
    role({ id: R.extra, name: 'Extra', position: 3, permissions: F.ViewChannel }),
    role({ id: R.powerful, name: 'Powerful', position: 3, permissions: F.KickMembers }),
    role({ id: R.botRole, name: 'Bot stuff', position: 4 }),
    role({ id: R.managedOther, name: 'Integration', position: 4, managed: true, botId: id(99) }),
    role({ id: R.prawTop, name: 'Assistant', position: 10, managed: true, botId: U.praw, permissions: F.ManageRoles | F.ManageChannels }),
    role({ id: R.mod, name: 'Moderator', position: 20 }),
    role({ id: R.botAdmin, name: 'Bot Admin', position: 30 }),
    role({ id: R.founder, name: 'Founder', position: 40 }),
    role({ id: R.high, name: 'High', position: 50 }),
  ];
  const members = new Map<string, MemberInfo>([
    [U.praw, { id: U.praw, isBot: true, roleIds: [R.prawTop], isOwner: false }],
    [U.botHq, { id: U.botHq, isBot: true, roleIds: [R.botRole], isOwner: false }],
    [U.botSw, { id: U.botSw, isBot: true, roleIds: [], isOwner: false }],
    [U.alice, { id: U.alice, isBot: false, roleIds: [], isOwner: false }],
    [U.bob, { id: U.bob, isBot: false, roleIds: [R.staff], isOwner: false }],
    [U.admin, { id: U.admin, isBot: false, roleIds: [R.botAdmin], isOwner: false }],
    [U.founder, { id: U.founder, isBot: false, roleIds: [R.founder], isOwner: false }],
    [U.owner, { id: U.owner, isBot: false, roleIds: [], isOwner: true }],
    [U.eve, { id: U.eve, isBot: true, roleIds: [], isOwner: false }],
  ]);
  const ch = (c: Partial<ChannelInfo> & { id: string; name: string }): ChannelInfo => ({ type: 0, parentId: null, isThread: false, overwrites: [], ...c });
  const channels = new Map<string, ChannelInfo>([
    [C.cat, ch({ id: C.cat, name: 'Team', type: CATEGORY_TYPE })],
    [C.general, ch({ id: C.general, name: 'general', parentId: C.cat, overwrites: [{ id: R.staff, type: 'role', allow: F.ViewChannel, deny: 0n }] })],
    [C.voice, ch({ id: C.voice, name: 'talk', type: 2, parentId: C.cat })],
    [C.setting, ch({ id: C.setting, name: 'setting', parentId: C.cat, overwrites: [{ id: R.everyone, type: 'role', allow: 0n, deny: F.ViewChannel }] })],
    [C.botLog, ch({ id: C.botLog, name: 'bot-log', parentId: C.cat })],
    ...['1565671253803794494', '1565671325597700157', '1566366032094961705'].map((sid) => [sid, ch({ id: sid, name: `sys-${sid.slice(-4)}`, parentId: C.cat })] as const),
    [C.thread, ch({ id: C.thread, name: 'a thread', parentId: C.general, isThread: true })],
    [C.inDeniedCat, ch({ id: C.inDeniedCat, name: 'in-denied-cat', parentId: C.deniedCat })],
    [C.orphan, ch({ id: C.orphan, name: 'orphan', parentId: C.unreadable })],
  ]);
  return { roles, members, channels };
}

export type WorldData = ReturnType<typeof worldData>;

/** A PermWorld over plain data; `fail` makes the named reads return null (an unfetchable member, an unreadable channel). */
export function fakeWorld(data: WorldData = worldData(), o: { botIds?: string[]; probe?: Record<string, 'visible' | 'hidden' | 'error'>; noRoles?: boolean } = {}): PermWorld & { data: WorldData } {
  return {
    data, guildId: GUILD_ID,
    knownBotIds: () => o.botIds ?? [U.praw, U.botHq],
    async me() {
      const m = data.members.get(U.praw)!;
      const top = Math.max(...m.roleIds.map((r) => data.roles.find((x) => x.id === r)?.position ?? 0));
      return { ...m, topPosition: top };
    },
    async roles() { return o.noRoles ? null : data.roles.map((r) => ({ ...r })); },
    async channel(cid) { return data.channels.get(cid) ?? null; },
    async channels() { return [...data.channels.values()]; },
    async member(mid) { return data.members.get(mid) ?? null; },
    async probeChannel(cid) { return o.probe?.[cid] ?? 'hidden'; },
  };
}

/** A writer that records calls; `failAt` makes the n-th call (0-based) throw a Discord-like error. */
export function fakeWriter(failAt = -1) {
  const calls: string[] = [];
  const hit = (s: string) => {
    if (calls.length === failAt) { calls.push(`FAIL ${s}`); throw Object.assign(new Error('Missing Permissions secret text'), { code: 50013 }); }
    calls.push(s);
  };
  const w: PermWriter & { calls: string[] } = {
    calls,
    async assignRole(m, r) { hit(`assign ${m} ${r}`); },
    async removeRole(m, r) { hit(`remove ${m} ${r}`); },
    async setOverwrite(c, t, a, d) { hit(`set ${c} ${t.type}:${t.id} ${a}/${d}`); },
    async clearOverwrite(c, t) { hit(`clear ${c} ${t.type}:${t.id}`); },
    async createChannel(o) { hit(`channel ${o.name} ${o.parentId} ${o.type} ${o.sync}`); return 'new-channel'; },
    async createRole(o) { hit(`role ${o.name} ${o.permissions}`); return 'new-role'; },
    async editRolePermissions(r, p) { hit(`editrole ${r} ${p}`); },
  };
  return w;
}
