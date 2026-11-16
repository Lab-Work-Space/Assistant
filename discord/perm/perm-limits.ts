import { PermissionFlagsBits } from 'discord.js';
import { AI_WARROOM_CHANNEL_ID } from '../../company/channels.js';
import { DENIED_CATEGORY_IDS, DENIED_CHANNEL_IDS, FOUNDER_ROLE_ID, PRIVILEGED_ROLE_IDS } from '../../company/denylist.js';
import { IGNORED_CHANNEL_IDS } from '../../company/router.js';
import type { Item } from '../commands/plans.js';
import { bitNames, orBits, SAFE_BITS } from './perm-bits.js';
import { ALL_DEFINED_BITS, bitsOf, type PermOp } from './perm-ops.js';
import { GUILD_ALLOWED_BITS } from './permissions.js';
import { CATEGORY_TYPE, type ChannelInfo, type MemberInfo, type PermWorld, type RoleInfo } from './perm-world.js';

/** The hard limits of the Discord permission ops (spec B, Gate 1 C15-C18, C20). Pure over a PermWorld; run at propose AND at apply. */

const SAFE = orBits(SAFE_BITS);
export const SAFE_CHECK = SAFE;
const F = PermissionFlagsBits;
/** C18: allowing any of these on a system channel would widen who can see or use it. */
export const WIDENING = F.ViewChannel | F.SendMessages | F.UseApplicationCommands;

export interface PermConsts {
  deniedChannelIds: readonly string[];
  deniedCategoryIds: readonly string[];
  founderRoleId: string;
  /** Includes Founder; the Bot Admin role is added below. */
  privilegedRoleIds: readonly string[];
  systemChannelIds: readonly string[];
  botAdminRoleId: string;
  /** How many bot applications are configured (one token each); fewer known user ids than this makes role-targeting ops fail closed (C16). */
  expectedBotCount: number;
}

export const SYSTEM_CHANNEL_IDS: readonly string[] = [...IGNORED_CHANNEL_IDS, AI_WARROOM_CHANNEL_ID];

export const permConsts = (botAdminRoleId: string, expectedBotCount: number): PermConsts => ({
  deniedChannelIds: DENIED_CHANNEL_IDS, deniedCategoryIds: DENIED_CATEGORY_IDS, founderRoleId: FOUNDER_ROLE_ID, privilegedRoleIds: PRIVILEGED_ROLE_IDS,
  systemChannelIds: SYSTEM_CHANNEL_IDS, botAdminRoleId, expectedBotCount,
});

export const privileged = (c: PermConsts): Set<string> => new Set([c.founderRoleId, c.botAdminRoleId, ...c.privilegedRoleIds].filter(Boolean));
export const snowflake = /^\d{17,20}$/;

/** An empty or half-filled constant would pass every check vacuously, so permission ops stay off until the owner has filled them in. */
export function constantsProblem(c: PermConsts): string | null {
  if (![c.founderRoleId, ...c.privilegedRoleIds, ...c.deniedCategoryIds, c.botAdminRoleId].every((id) => snowflake.test(id))) {
    return 'the owner-maintained constants (FOUNDER_ROLE_ID, PRIVILEGED_ROLE_IDS, DENIED_CATEGORY_IDS in company/denylist.ts) are not filled in with Discord ids';
  }
  if (!c.privilegedRoleIds.includes(c.founderRoleId)) return 'PRIVILEGED_ROLE_IDS must include FOUNDER_ROLE_ID';
  if (c.deniedCategoryIds.length === 0) return 'DENIED_CATEGORY_IDS is empty';
  return null;
}

export const names = (bits: bigint): string => (bits === 0n ? 'none' : bitNames(bits).join(', '));
const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
export const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f\u2028\u2029\p{Cf}]/gu, '?').slice(0, 64);

// A channel or role name that Praw may create: letters, digits, pictographs, space, hyphen, underscore; no mentions, markup or hidden characters.
export const NAME = /^[\p{L}\p{N}\p{Extended_Pictographic}][\p{L}\p{N}\p{Extended_Pictographic}\-_ ]{0,99}$/u;
const TYPE_CODE = { text: 0, voice: 2, forum: 15 } as const;

export interface ResolvedOp {
  op: PermOp;
  /** The card line, built from live data (names are Discord's, ids are validated). */
  item: Item;
  /** The live state of this op's targets now; apply compares it with the one stored at propose (C7). */
  snap: unknown;
}
export type Checked = { ok: true; resolved: ResolvedOp[] } | { ok: false; error: string };

export interface Ctx {
  c: PermConsts;
  world: PermWorld;
  roles: Map<string, RoleInfo>;
  me: MemberInfo & { topPosition: number };
  botIds: Set<string>;
  /** Roles held by a bot application (its member's roles, and integration roles). */
  botRoleIds: Set<string>;
  priv: Set<string>;
  channelCache: Map<string, ChannelInfo | null>;
}

export class Refuse extends Error {}
export const no = (why: string): never => {
  throw new Refuse(why);
};

/** The bot set and every role a bot holds, fresh: one list read when the world offers it, else one member() per bot. A string = why not. */
async function botRoleSets(world: PermWorld): Promise<{ ids: Set<string>; roleIds: Set<string> } | string> {
  if (world.knownBotMembers) {
    const ms = await world.knownBotMembers();
    return { ids: new Set(ms.map((m) => m.id)), roleIds: new Set(ms.flatMap((m) => m.roleIds)) };
  }
  const ids = new Set(await world.knownBotIds());
  const roleIds = new Set<string>();
  for (const id of ids) {
    const m = await world.member(id);
    if (!m) return `the member of bot ${id} could not be fetched`;
    for (const r of m.roleIds) roleIds.add(r);
  }
  return { ids, roleIds };
}

export async function context(world: PermWorld, c: PermConsts): Promise<Ctx> {
  const [roleList, me] = await Promise.all([world.roles(), world.me()]);
  if (!roleList || !me) return no('Discord roles or Praw\'s own member could not be read');
  const bots = await botRoleSets(world);
  if (typeof bots === 'string') return no(bots);
  const { ids: botIds, roleIds: held } = bots;
  if (botIds.size < c.expectedBotCount) no('not every configured bot is online, so the roles bots hold cannot be ruled out');
  const botRoleIds = new Set([...roleList.filter((r) => r.managed && r.botId).map((r) => r.id), ...held]);
  return { c, world, roles: new Map(roleList.map((r) => [r.id, r])), me, botIds, botRoleIds, priv: privileged(c), channelCache: new Map() };
}

export async function readChannel(x: Ctx, id: string): Promise<ChannelInfo | null> {
  if (!x.channelCache.has(id)) x.channelCache.set(id, await x.world.channel(id));
  return x.channelCache.get(id)!;
}

/** C17: denied channels and categories, threads under them, and any channel whose parent cannot be read. */
export async function channelOf(x: Ctx, id: string, what = 'channel'): Promise<ChannelInfo> {
  const { c } = x;
  if (c.deniedChannelIds.includes(id) || c.deniedCategoryIds.includes(id)) no(`${what} ${id} is off limits`);
  const ch = await readChannel(x, id);
  if (!ch) return no(`${what} ${id} could not be read (refused to be safe)`);
  if (ch.isThread) no(`${what} ${id} is a thread; permission ops work on channels and categories`);
  if (ch.parentId) {
    if (c.deniedChannelIds.includes(ch.parentId) || c.deniedCategoryIds.includes(ch.parentId)) no(`${what} ${id} is in a protected category`);
    const parent = await readChannel(x, ch.parentId);
    if (!parent) no(`the category of ${what} ${id} could not be read (refused to be safe)`);
  }
  return ch;
}

/** C16/C17: roles that are never touched. `forOverwrite` lets @everyone be named in a channel overwrite (its guild permissions stay untouchable). */
export function roleOf(x: Ctx, id: string, forOverwrite = false): RoleInfo {
  const r = x.roles.get(id);
  if (!r) return no(`role ${id} was not found`);
  if (id === x.world.guildId) {
    if (!forOverwrite) no('the @everyone role\'s guild permissions are never changed');
    return r;
  }
  if (r.managed) no(`role ${id} is managed by an integration`);
  if (x.priv.has(id)) no(`role ${id} is Founder, Bot Admin or another privileged role`);
  if (r.position >= x.me.topPosition) no(`role ${id} is at or above Praw's own top role`);
  if (x.botRoleIds.has(id)) no(`role ${id} is held by a bot`);
  if (x.me.roleIds.includes(id)) no(`role ${id} is one of Praw's own roles`);
  return r;
}

/** C16: members that are never targets. Fetched by id per op; an unfetchable member is refused. */
export async function memberOf(x: Ctx, id: string): Promise<MemberInfo> {
  if (id === x.me.id) no('Praw does not change herself');
  if (x.botIds.has(id)) no(`member ${id} is a bot`);
  const m = await x.world.member(id);
  if (!m) return no(`member ${id} could not be fetched (refused to be safe)`);
  if (m.isBot) no(`member ${id} is a bot`);
  if (m.isOwner) no(`member ${id} is the server owner`);
  if (m.roleIds.some((r) => x.priv.has(r))) no(`member ${id} holds Founder, Bot Admin or another privileged role`);
  return m;
}

export const mention = (kind: 'user' | 'role' | 'channel', id: string) => ({ kind, id });
const bitText = (a: bigint, d: bigint) => `allow: ${names(a)}; deny: ${names(d)}`;

async function checkOne(op: PermOp, x: Ctx): Promise<ResolvedOp> {
  switch (op.kind) {
    case 'role.assign':
    case 'role.remove': {
      const role = roleOf(x, op.role);
      const m = await memberOf(x, op.member);
      const holds = m.roleIds.includes(op.role);
      if (op.kind === 'role.assign') {
        if (holds) no('the member already holds that role');
        // G2A-03: a role that is allowed into a system channel would open it to whoever gets the role.
        for (const sid of x.c.systemChannelIds) {
          const sc = await readChannel(x, sid);
          if (!sc) no(`system channel ${sid} could not be read (refused to be safe)`);
          if (sc!.overwrites.some((o) => o.type === 'role' && o.id === op.role && (o.allow & WIDENING) !== 0n)) no(`role ${op.role} is allowed into a system channel; assigning it would open that channel`);
        }
        const extra = role.permissions & ~GUILD_ALLOWED_BITS;
        if (extra !== 0n) no(`role ${op.role} carries powers beyond the safe set (${names(extra)}); it cannot be handed out`);
      } else if (!holds) no('the member does not hold that role');
      return {
        op, snap: { held: holds }, item: {
          label: op.kind === 'role.assign' ? 'Assign role' : 'Remove role', refs: [mention('user', op.member), mention('role', op.role)],
          old: holds ? `holds "${clean(role.name)}"` : `does not hold "${clean(role.name)}"`, neu: holds ? `no longer holds "${clean(role.name)}"` : `holds "${clean(role.name)}"`,
        },
      };
    }
    case 'overwrite.set':
    case 'overwrite.clear': {
      const ch = await channelOf(x, op.channel);
      if (op.target.type === 'role') roleOf(x, op.target.id, true);
      else await memberOf(x, op.target.id);
      const cur = ch.overwrites.find((o) => o.id === op.target.id && o.type === op.target.type);
      const system = x.c.systemChannelIds.includes(ch.id);
      let allow = 0n;
      let deny = 0n;
      if (op.kind === 'overwrite.set') {
        allow = bitsOf(op.allow);
        deny = bitsOf(op.deny);
        if ((allow & ~SAFE) !== 0n) no(`allow bits outside the safe set: ${names(allow & ~SAFE)}`);
        if ((deny & ~ALL_DEFINED_BITS) !== 0n) no(`deny names a bit Discord does not define: ${names(deny & ~ALL_DEFINED_BITS)}`);
        if ((allow & deny) !== 0n) no('the same bit is both allowed and denied');
        if (system && (allow & WIDENING) !== 0n) no('this system channel (setting, bot-log, tasks, direct, ai-warroom) is never opened to more people or roles');
        // G2A-01: replacing an existing deny with a neutral or smaller one opens the channel exactly like clearing it.
        if (system && cur && (cur.deny & WIDENING & ~deny) !== 0n) no('this would remove a deny on a system channel and open it to more people');
        // G2A-04: a new deny of View/Send on @everyone could lock the admins and hq out.
        if (system && op.target.id === x.world.guildId && (deny & WIDENING & ~(cur?.deny ?? 0n)) !== 0n) no('denying View, Send or commands to @everyone on a system channel could lock the admins out');
        if (cur && cur.allow === allow && cur.deny === deny) no('that overwrite is already in place');
      } else {
        if (!cur) no('there is no such overwrite to clear');
        if (system && (cur!.deny & WIDENING) !== 0n) no('clearing this deny would open a system channel to more people');
      }
      return {
        op, snap: { allow: String(cur?.allow ?? 0n), deny: String(cur?.deny ?? 0n), present: !!cur },
        item: {
          label: op.kind === 'overwrite.set' ? 'Set channel overwrite' : 'Clear channel overwrite',
          refs: [mention('channel', op.channel), mention(op.target.type === 'role' ? 'role' : 'user', op.target.id)],
          old: cur ? bitText(cur.allow, cur.deny) : 'none', neu: op.kind === 'overwrite.set' ? bitText(allow, deny) : 'none',
        },
      };
    }
    case 'channel.create': {
      if (!NAME.test(op.name.trim())) no('the channel name may use letters, digits, pictographs, spaces, hyphens and underscores only');
      let cat: ChannelInfo | null = null;
      if (op.category !== null) {
        cat = await channelOf(x, op.category, 'category');
        if (cat.type !== CATEGORY_TYPE) no(`${op.category} is not a category`);
      }
      return {
        op, snap: { category: cat?.id ?? null },
        item: {
          label: 'Create channel', refs: cat ? [mention('channel', cat.id)] : [],
          old: '(none)', neu: `${op.type} "${op.name.trim()}"${cat ? ` in "${clean(cat.name)}"` : ' at the top level'}${op.sync ? ', permissions synced with the category' : ''}`,
        },
      };
    }
    case 'role.create': {
      const perms = bitsOf(op.permissions);
      if ((perms & ~SAFE) !== 0n) no(`permissions outside the safe set: ${names(perms & ~SAFE)}`);
      const nm = op.name.trim();
      if (!NAME.test(nm)) no('the role name may use letters, digits, pictographs, spaces, hyphens and underscores only');
      if ([...x.roles.values()].some((r) => r.name.trim().toLowerCase() === nm.toLowerCase())) no('a role with that name already exists');
      return { op, snap: { exists: false }, item: { label: 'Create role', old: '(none)', neu: `"${nm}" colour ${hex(op.color)}, hoist ${op.hoist ? 'yes' : 'no'}, permissions: ${names(perms)}` } };
    }
    case 'role.edit.permissions': {
      const role = roleOf(x, op.role);
      const perms = bitsOf(op.permissions);
      if ((perms & ~SAFE) !== 0n) no(`permissions outside the safe set: ${names(perms & ~SAFE)}`);
      if (perms === role.permissions) no('the role already has exactly those permissions');
      return { op, snap: { permissions: String(role.permissions) }, item: { label: 'Edit role permissions', refs: [mention('role', op.role)], old: names(role.permissions), neu: names(perms) } };
    }
  }
}

/**
 * Validates every op against live data. All or nothing: the first refused op refuses the proposal (and, at apply, the card). Returns the
 * card lines and the per-target snapshot. Never writes.
 */
export async function checkPermOps(ops: readonly PermOp[], world: PermWorld, c: PermConsts): Promise<Checked> {
  try {
    const problem = constantsProblem(c);
    if (problem) return { ok: false, error: problem };
    if (ops.length === 0 || ops.length > 20) return { ok: false, error: 'a proposal has 1 to 20 operations' };
    const x = await context(world, c);
    const resolved: ResolvedOp[] = [];
    for (const [i, op] of ops.entries()) {
      try {
        resolved.push(await checkOne(op, x));
      } catch (e) {
        if (e instanceof Refuse) return { ok: false, error: `operation ${i + 1} (${op.kind}) refused: ${e.message}` };
        throw e;
      }
    }
    return { ok: true, resolved };
  } catch (e) {
    if (e instanceof Refuse) return { ok: false, error: e.message };
    throw e;
  }
}

/**
 * C17/C20, at boot and before every apply: null when permission ops may run. The constants are filled in and every id is real, Praw's top role
 * sits strictly below Founder and Bot Admin, and Manage Roles / Manage Channels live only on Praw's own integration role (no other role that
 * carries them is held by Praw or by any other bot).
 */
export async function permsProblem(world: PermWorld, c: PermConsts, opts: { power?: bigint; belowAllPrivileged?: boolean } = {}): Promise<string | null> {
  const consts = constantsProblem(c);
  if (consts) return consts;
  const [roleList, me] = await Promise.all([world.roles(), world.me()]);
  if (!roleList || !me) return 'Discord roles or Praw\'s own member could not be read';
  const roles = new Map(roleList.map((r) => [r.id, r]));
  for (const id of privileged(c)) if (!roles.has(id)) return `role ${id} from the owner constants does not exist in the guild`;
  for (const id of c.deniedCategoryIds) if ((await world.probeChannel(id)) === 'error') return `category ${id} from DENIED_CATEGORY_IDS could not be checked`;
  const top = me.topPosition;
  // S5: the executor's top role sits strictly below Founder, Bot Admin and (opts.belowAllPrivileged) every privileged role.
  for (const id of opts.belowAllPrivileged ? privileged(c) : [c.founderRoleId, c.botAdminRoleId]) if (roles.get(id)!.position <= top) return `the executor's top role is not strictly below role ${id}; move its role under Founder, Bot Admin and every privileged role`;
  const bots = await botRoleSets(world);
  if (typeof bots === 'string') return bots;
  if (bots.ids.size < c.expectedBotCount) return 'not every configured bot is online, so the roles bots hold cannot be ruled out';
  const heldByBots = new Set<string>([...me.roleIds, ...bots.roleIds]);
  const power = opts.power ?? (F.ManageRoles | F.ManageChannels);
  for (const r of roleList) {
    if ((r.permissions & power) === 0n) continue;
    const prawOwn = r.managed && r.botId === me.id;
    if (prawOwn) continue;
    if (r.id === world.guildId || heldByBots.has(r.id)) return `role ${r.id} carries Manage Roles or Manage Channels and a bot holds it; only the executor's own integration role may`;
  }
  return null;
}
