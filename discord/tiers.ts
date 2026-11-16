import type { ServerOp } from './server/server-ops.js';

/**
 * Delegated tiers (Gate 1 delta T1-T24). Authority comes only through Praw and the confirmation card: the tier roles carry no Discord
 * management bits. This module is pure: the tier of a member from role ids, the single op-to-minimum-tier table, and the numeric limits.
 * Both processes use it; the executor additionally derives every tier from ITS OWN live reads and config (T1), never from a card field (T6).
 */
export type Tier = 'bot_admin' | 'manager' | 'moderator';
export const TIER_RANK: Record<Tier, number> = { moderator: 1, manager: 2, bot_admin: 3 };
export const rankOf = (t: Tier | null): number => (t ? TIER_RANK[t] : 0);
export const isTier = (v: unknown): v is Tier => v === 'bot_admin' || v === 'manager' || v === 'moderator';

/** The three role ids a tier is computed from. `managerId` / `moderatorId` come from `roles.*` config (null = tier switched off). */
export interface TierRoles {
  botAdminRoleId: string;
  managerId: string | null;
  moderatorId: string | null;
}

/** The highest tier held, or null. A bot or an unknown member is the caller's concern (the executor refuses them before this). */
export function tierOf(roleIds: readonly string[], r: TierRoles): Tier | null {
  if (r.botAdminRoleId && roleIds.includes(r.botAdminRoleId)) return 'bot_admin';
  if (r.managerId && roleIds.includes(r.managerId)) return 'manager';
  if (r.moderatorId && roleIds.includes(r.moderatorId)) return 'moderator';
  return null;
}

/**
 * T2: ONE table, `ServerOp` kind -> minimum tier. Typed as a Record so a new kind is a compile error until it has an entry. Unknown kinds
 * (and every card kind other than `server`) are Bot Admin only. Used by tool filtering, propose, click and the executor's apply.
 */
export const MIN_TIER: Record<ServerOp['kind'], Tier> = {
  // Moderator
  'msg.delete': 'moderator', 'msg.bulk': 'moderator', 'msg.pin': 'moderator', 'msg.unpin': 'moderator',
  'member.timeout': 'moderator', 'member.untimeout': 'moderator', 'thread.archive': 'moderator', 'thread.lock': 'moderator',
  // Manager (on top of the Moderator set)
  'member.kick': 'manager', 'member.nick': 'manager', 'invite.create': 'manager', 'invite.revoke': 'manager',
  'channel.edit': 'manager', 'channel.move': 'manager', 'channel.make': 'manager', 'channel.archive': 'manager', 'thread.unlock': 'manager',
  'event.create': 'manager', 'event.edit': 'manager', 'event.cancel': 'manager',
  // Bot Admin only
  'member.ban': 'bot_admin', 'member.unban': 'bot_admin', 'channel.delete': 'bot_admin', 'thread.delete': 'bot_admin',
  'automod.create': 'bot_admin', 'automod.edit': 'bot_admin', 'automod.enable': 'bot_admin', 'automod.disable': 'bot_admin', 'automod.delete': 'bot_admin',
  'guild.edit': 'bot_admin', 'welcome.resume': 'bot_admin',
};

/** The card families other than `server` (config, admin_op, perm, knowledge, deploy) are Bot Admin only; `server` is judged per op with MIN_TIER. */
export const CARD_KIND_MIN_TIER: Record<'config' | 'admin_op' | 'perm' | 'server' | 'knowledge' | 'deploy' | 'code' | 'skill', Tier | 'per_op'> = { config: 'bot_admin', admin_op: 'bot_admin', perm: 'bot_admin', server: 'per_op', knowledge: 'bot_admin', deploy: 'bot_admin', code: 'bot_admin', skill: 'bot_admin' };
export const cardKindMinTier = (kind: string): Tier | 'per_op' => (CARD_KIND_MIN_TIER as Record<string, Tier | 'per_op'>)[kind] ?? 'bot_admin';

export const opMinTier = (kind: string): Tier => (MIN_TIER as Record<string, Tier | undefined>)[kind] ?? 'bot_admin';

/** T2: per-tier numeric limits of the delegated tiers. Bot Admin keeps the existing hard limits. */
export const TIER_LIMITS = {
  moderator: { bulkMax: 50, timeoutMaxMinutes: 24 * 60 },
  manager: { bulkMax: 50, timeoutMaxMinutes: 28 * 24 * 60 },
  /** Named member ops (kick, timeout, untimeout, nick) per card. */
  memberOpsMax: 5,
} as const;
export const timeoutMaxMinutes = (t: Tier): number => (t === 'moderator' ? TIER_LIMITS.moderator.timeoutMaxMinutes : TIER_LIMITS.manager.timeoutMaxMinutes);

const MEMBER_OPS: readonly string[] = ['member.kick', 'member.timeout', 'member.untimeout', 'member.nick'];

type LooseOp = { kind: string; count?: unknown; minutes?: unknown; nsfw?: unknown };

/**
 * T1/T2: null when `tier` may propose and confirm every op, else why not. Pure. For a Bot Admin it only checks the table (always allowed).
 * Unknown kinds need Bot Admin. A tier cap is checked on the numbers the op carries.
 */
export function opsTierProblem(tier: Tier, ops: readonly LooseOp[]): string | null {
  if (tier === 'bot_admin') return null;
  let members = 0;
  for (const op of ops) {
    const need = opMinTier(op.kind);
    if (rankOf(tier) < rankOf(need)) return `${op.kind} needs the ${need.replace('_', ' ')} role; you are a ${tier}`;
    if (MEMBER_OPS.includes(op.kind)) members++;
    if (op.kind === 'msg.bulk' && (typeof op.count !== 'number' || op.count > TIER_LIMITS[tier].bulkMax)) return `a bulk delete is at most ${TIER_LIMITS[tier].bulkMax} messages for a ${tier}`;
    if (op.kind === 'member.timeout' && (typeof op.minutes !== 'number' || op.minutes > timeoutMaxMinutes(tier))) return `a ${tier} may time out for at most ${timeoutMaxMinutes(tier)} minutes`;
    if (op.kind === 'channel.edit' && op.nsfw !== undefined) return 'the NSFW flag of a channel is a Bot Admin setting';
  }
  if (members > TIER_LIMITS.memberOpsMax) return `at most ${TIER_LIMITS.memberOpsMax} member operations per card`;
  return null;
}

/** The kinds a tier may use (the tier-filtered tool description and the exhaustiveness test). */
export const kindsFor = (tier: Tier): string[] => Object.entries(MIN_TIER).filter(([, t]) => rankOf(tier) >= rankOf(t)).map(([k]) => k);

/** T12: channel names compared with emoji, spacing and punctuation stripped, so "🛡️ Mod-Room" and "modroom" collide. */
export const normalizeChannelName = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** Audit actor suffix: the tier as evaluated by code at that step (T21). Anchored at the end of the actor, which holds only ids and enums. */
export const tierTag = (t: Tier): string => ` tier:${t}`;
