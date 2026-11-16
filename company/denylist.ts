/** Channels the bots must never read, post to or route from (hard-coded, never configurable; Gate 1 D8). */
export const DENIED_CHANNEL_IDS: readonly string[] = ['1565715069969502310', '1565649677280485457'];

/** True for a denied channel or a thread whose parent channel is denied. */
export function isDenied(channelId: string, parentChannelId: string | null): boolean {
  return DENIED_CHANNEL_IDS.includes(channelId) || (parentChannelId !== null && DENIED_CHANNEL_IDS.includes(parentChannelId));
}

/**
 * Gate 1 C17 (admin console, Discord permission ops). Praw cannot see the DENIED channels or their overwrites (a fetch there is meant to fail),
 * so what she must never reach comes from these owner-maintained constants, never from live discovery. They are empty on purpose: permission
 * ops stay OFF (with an alert) until the owner fills all three in and the boot check confirms each id (README, "Permission ops, owner steps").
 */
/** The parent categories of every DENIED channel above. No op may name them, create a channel in them or change their overwrites. */
export const DENIED_CATEGORY_IDS: readonly string[] = ['1565714470192291970']; // 💻 IT GENERAL & INFRASTRUCTURE (parent of #🔑-system-credentials; #moderator-only has no category)
/** The Founder role: Praw's top role must sit strictly below it, and it can never be touched. */
export const FOUNDER_ROLE_ID: string = '1565650182824009828';
/**
 * Every role that has an allow overwrite on a DENIED channel or its category (the moderator role, for example), and Founder.
 * Assigning, removing, editing or naming one of them in an overwrite is refused: it would change who reads #🔑-system-credentials.
 * The Bot Admin role (env BOT_ADMIN_ROLE_ID) is added to this set by the code.
 */
export const PRIVILEGED_ROLE_IDS: readonly string[] = ['1565650182824009828']; // Founder; no other role has an allow overwrite on a DENIED channel (checked 2026-11-01)
