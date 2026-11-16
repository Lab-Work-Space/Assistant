import { PermissionFlagsBits } from 'discord.js';

const F = PermissionFlagsBits;

/** Gate 1 C15: the only bits Praw may ever grant (role permissions or allow overwrites). An allowlist: unknown future bits are refused. */
export const SAFE_BITS: readonly bigint[] = [
  F.ViewChannel, F.SendMessages, F.SendMessagesInThreads, F.CreatePublicThreads, F.ReadMessageHistory, F.EmbedLinks,
  F.AttachFiles, F.AddReactions, F.Connect, F.Speak, F.UseApplicationCommands, F.PinMessages,
];

/**
 * Gate 1 C19 Step 0: benign bits an ordinary Discord server gives @everyone (and so every bot member), reviewed one by one.
 * None of them moderates, manages or mentions. The owner confirms this set against the live guild with
 * `scripts/dump-bot-permissions.ts`; a bit found there that is not here is an owner decision, never a quiet widening.
 */
export const REVIEWED_DEFAULT_BITS: readonly bigint[] = [
  F.CreateInstantInvite, F.ChangeNickname, F.UseExternalEmojis, F.UseExternalStickers, F.UseExternalApps, F.SendPolls,
  F.UseEmbeddedActivities, F.UseVAD, F.Stream, F.SendVoiceMessages, F.RequestToSpeak, F.CreateEvents, F.CreateGuildExpressions,
  F.SendTTSMessages, F.CreatePrivateThreads, F.UseSoundboard, F.UseExternalSounds, F.SetVoiceChannelStatus,
  // Bit 47: set on the live @everyone (owner dump 2026-11-01), unnamed in discord.js 14.28; reviewed and accepted by the controller.
  1n << 47n,
];

/**
 * Gate 1 S4 (phase 2): the guild-wide bits ONLY the executor "LW Admin" may hold, exactly the spec's list. Send Messages is not among them (N8);
 * it reaches the executor only through @everyone like every bot. Never Administrator, guild-wide Manage Webhooks or Mention Everyone.
 */
export const ADMIN_EXTRA_BITS: readonly bigint[] = [
  F.ManageChannels, F.ManageRoles, F.ManageGuild, F.KickMembers, F.BanMembers, F.ModerateMembers, F.ManageNicknames, F.ManageMessages, F.ManageThreads,
  F.ManageEvents, F.ViewAuditLog, F.CreateInstantInvite, F.ViewChannel, F.ReadMessageHistory,
  // Manage / Create Expressions return with the image ops (Gate 1 S24, S27); until then holding them disables the executor (G2SM-09).
];

/** Never allowed guild-wide on any bot; kept as a list for the tests and for the owner's reading (the allowlist alone decides). */
export const HARD_FORBIDDEN_NAMES = [
  'Administrator', 'ManageGuild', 'BanMembers', 'KickMembers', 'ModerateMembers', 'MentionEveryone', 'ManageNicknames', 'ManageEvents',
  'ManageGuildExpressions', 'ViewAuditLog', 'ManageMessages', 'ManageWebhooks',
] as const satisfies readonly (keyof typeof PermissionFlagsBits)[];

export const orBits = (bits: readonly bigint[]): bigint => bits.reduce((a, b) => a | b, 0n);

/** Names of the defined flags set in `bits`; bits Discord defines but discord.js does not know are named `unknown(1<<n)`. */
export function bitNames(bits: bigint): string[] {
  const out: string[] = [];
  let rest = bits;
  for (const [name, bit] of Object.entries(F)) {
    if ((bits & bit) === bit && bit !== 0n) {
      out.push(name);
      rest &= ~bit;
    }
  }
  for (let n = 0n; rest > 0n; n++, rest >>= 1n) if (rest & 1n) out.push(`unknown(1<<${n})`);
  return out;
}

export const labelOf = (name: string): string => name.replace(/([a-z])([A-Z])/g, '$1 $2');

/**
 * Gate 1 S4/S5: the bits that make a role "powerful" for the executor's hierarchy check. They may sit only on the executor's own managed
 * integration role: never on @everyone and never on a role a bot holds. (View, read history, create invite and the expression bits are
 * left out: @everyone legitimately carries them.)
 */
export const ADMIN_POWER_BITS: bigint = orBits([
  F.ManageChannels, F.ManageRoles, F.ManageGuild, F.KickMembers, F.BanMembers, F.ModerateMembers, F.ManageNicknames, F.ManageMessages, F.ManageThreads,
  F.ManageEvents, F.ManageGuildExpressions, F.ViewAuditLog,
]);
