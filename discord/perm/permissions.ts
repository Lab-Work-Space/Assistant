import { PermissionFlagsBits, type Client, type Guild, type PermissionsBitField } from 'discord.js';
import { DENIED_CHANNEL_IDS } from '../../company/denylist.js';
import type { DeptId } from '../../core/index.js';
import { ADMIN_EXTRA_BITS, bitNames, labelOf, orBits, REVIEWED_DEFAULT_BITS, SAFE_BITS } from './perm-bits.js';

/**
 * Gate 1 C19: the guild-wide permission bits a bot member may hold (what @everyone and its roles add up to). Everything else disables the client.
 * Every department bot, Praw included: SAFE plus the reviewed @everyone defaults. Phase 2 (S4) reverts the phase-1 Part B exception: Praw holding
 * Manage Roles or Manage Channels is flagged again. Only the separate executor "LW Admin" gets the management bits (ADMIN_GUILD_ALLOWED_BITS).
 */
export const GUILD_ALLOWED_BITS: bigint = orBits([...SAFE_BITS, ...REVIEWED_DEFAULT_BITS]);
/** Gate 1 S4: the executor's allowlist, exactly the spec's permission list. Never Administrator, guild-wide Manage Webhooks or Mention Everyone. */
export const ADMIN_GUILD_ALLOWED_BITS: bigint = GUILD_ALLOWED_BITS | orBits(ADMIN_EXTRA_BITS);
/** The id the executor is checked under (it is not a department, S3). */
export const ADMIN_EXECUTOR_ID = 'admin';
export const allowedGuildBits = (who: string): bigint => (who === ADMIN_EXECUTOR_ID ? ADMIN_GUILD_ALLOWED_BITS : GUILD_ALLOWED_BITS);

/**
 * Per-channel permissions each head bot needs (Gate 1 D19; README, Task 15). Granted as channel/category
 * overwrites, never guild-wide. Manage Webhooks only where the dept's personas speak. Attach Files is not here: Praw gets it per channel (PRAW_EXTRA_PERMISSIONS).
 */
export const REQUIRED_CHANNEL_PERMISSIONS: readonly { name: keyof typeof PermissionFlagsBits; why: string }[] = [
  { name: 'ViewChannel', why: 'read the dept channels' },
  { name: 'SendMessages', why: 'post replies' },
  { name: 'SendMessagesInThreads', why: 'post in task threads' },
  { name: 'CreatePublicThreads', why: 'open a thread per task' },
  { name: 'ReadMessageHistory', why: 'short-term context' },
  { name: 'EmbedLinks', why: 'embed replies' },
  { name: 'ManageWebhooks', why: 'persona webhook (channel overwrite only)' },
];

/**
 * Extra permissions Praw may be given on top of REQUIRED_CHANNEL_PERMISSIONS (P17). They are per-channel or per-category
 * overwrites on her mapped channels only, never guild-wide, and none is needed before M2 (pins), M4 (attachments) or M5
 * (voice). Pins use Discord's dedicated Pin Messages permission (bit 1 << 51; T20 Step 0, verified 2026-11-01 against the
 * Discord permissions and message docs and discord.js 14.28), so Praw never needs Manage Messages; the startup check
 * still flags a guild-wide Manage Messages on her client.
 */
export const PRAW_EXTRA_PERMISSIONS: readonly { name: keyof typeof PermissionFlagsBits; why: string }[] = [
  { name: 'PinMessages', why: 'pin and unpin (M2); channel overwrite only' },
  { name: 'AttachFiles', why: 'send files and images (M4); channel overwrite only' },
  { name: 'Connect', why: 'join a voice channel (M5)' },
  { name: 'Speak', why: 'speak in a voice channel (M5)' },
];

const VOICE_NEEDS = [
  { bit: PermissionFlagsBits.ViewChannel, label: 'View Channel' },
  { bit: PermissionFlagsBits.Connect, label: 'Connect' },
  { bit: PermissionFlagsBits.Speak, label: 'Speak' },
] as const;

/**
 * P17: checked on the target voice channel itself (overwrites included) before every join. Null when Praw may join and speak,
 * else a message naming what is missing and where to grant it.
 */
export function voiceChannelPermissionError<M>(channel: { id: string; permissionsFor(member: M): Readonly<PermissionsBitField> | null }, me: M): string | null {
  const perms = channel.permissionsFor(me);
  const missing = VOICE_NEEDS.filter((n) => !perms?.has(n.bit)).map((n) => n.label);
  if (!missing.length) return null;
  return `Praw cannot join <#${channel.id}>: missing ${missing.join(', ')}. Grant them on this voice channel or its category (never guild-wide).`;
}

/**
 * Fail-closed checks (Gate 1 D8, D19): any warning means the dept client must be disabled.
 * `client` finds the bot member when `guild.members.me` is not cached, and confirms a denied channel is gone.
 * A denied channel missing from the guild cache is unverifiable, so it warns unless a fetch answers Unknown Channel (10003) or Missing Access/Permissions (50001/50013: the bot cannot view it).
 */
export async function checkGuildPermissions(client: Client, dept: DeptId | typeof ADMIN_EXECUTOR_ID, guild: Guild, opts: { fresh?: boolean } = {}): Promise<string[]> {
  let me = guild.members.me ?? (client.user ? guild.members.cache?.get(client.user.id) : undefined) ?? null;
  if (opts.fresh) {
    // C21: a live re-check reads Discord, not the gateway cache (roles and the bot member may have changed a moment ago).
    try {
      await guild.roles.fetch();
      me = await guild.members.fetchMe({ force: true });
    } catch (e) {
      return [`${dept}: could not re-read the bot's permissions (${typeof (e as { code?: unknown }).code === 'number' ? `code ${(e as { code: number }).code}` : 'error'}); cannot verify`];
    }
  }
  if (!me) return [`${dept}: bot member not found in guild ${guild.id}; cannot verify permissions`];
  const warnings: string[] = [];
  // An allowlist (C19): any guild-wide bit outside it is named. Administrator, Manage Guild, Ban, Kick, Moderate, Mention Everyone,
  // Manage Nicknames/Events/Expressions, View Audit Log, Manage Messages/Webhooks, and Manage Roles/Channels on a non-praw bot all fall out here.
  const extra = me.permissions.bitfield & ~allowedGuildBits(dept);
  if (extra !== 0n) {
    const names = bitNames(extra).map(labelOf).join(', ');
    const per = extra & (PermissionFlagsBits.ManageWebhooks | PermissionFlagsBits.ManageMessages) ? '; grant Manage Webhooks and Manage Messages per channel instead' : '';
    warnings.push(`${dept}: bot has guild-wide ${names}, which is not allowed${per}`);
  }
  for (const id of DENIED_CHANNEL_IDS) {
    const ch = opts.fresh ? await client.channels.fetch(id, { force: true }).catch((e: unknown) => ({ failed: e })) : guild.channels.cache.get(id);
    if (opts.fresh && ch && 'failed' in ch) {
      if (!HIDDEN_CODES.has((ch.failed as { code?: number } | null)?.code ?? -1)) warnings.push(`${dept}: denied channel ${id} could not be re-read and is not confirmed deleted or hidden; cannot verify`);
      continue;
    }
    if (!ch) {
      if (!(await confirmedHidden(client, id))) warnings.push(`${dept}: denied channel ${id} is not in the guild cache and is not confirmed deleted or hidden; cannot verify`);
      continue;
    }
    if ('permissionsFor' in ch && ch.permissionsFor(me)?.has(PermissionFlagsBits.ViewChannel)) {
      warnings.push(`${dept}: bot can view denied channel ${id}`);
    }
  }
  return warnings;
}

// Unknown Channel, Missing Access, Missing Permissions: the channel is gone or the bot cannot see it.
const HIDDEN_CODES = new Set([10003, 50001, 50013]);

/** True only when Discord answers that the channel is gone or off-limits to the bot; success (viewable) or any other error is not proof. */
async function confirmedHidden(client: Client, id: string): Promise<boolean> {
  try {
    await client.channels.fetch(id);
    return false;
  } catch (e) {
    return typeof e === 'object' && e !== null && HIDDEN_CODES.has((e as { code?: number }).code ?? -1);
  }
}
