import { PermissionFlagsBits } from 'discord.js';

/** One permission overwrite as the room check needs it (discord.js `PermissionOverwrites` mapped to plain values). type 0 = role, 1 = member. */
export interface OverwriteLike { id: string; type: number; allow: bigint; deny: bigint }

export interface RoomAllow {
  /** Roles that may see the room: the Bot Admin role. */
  roleIds: readonly string[];
  /** Members that may see it: the category head bot, Praw and LW Admin. */
  userIds: readonly string[];
}

/**
 * Gate 1 WS8: the live overwrite check of an approvals room. `@everyone` (its role id equals the guild id) must be denied View Channel, and
 * every other overwrite that allows View Channel must be the Bot Admin role or one of the allowed bots. Returns why not, or null.
 * Roles with the Administrator permission see everything whatever the overwrites say; that is a server setting this cannot judge.
 */
export function roomOverwriteProblem(overwrites: readonly OverwriteLike[], guildId: string, allow: RoomAllow): string | null {
  const view = PermissionFlagsBits.ViewChannel;
  const everyone = overwrites.find((o) => o.id === guildId && o.type === 0);
  if (!everyone || (everyone.deny & view) === 0n) return '@everyone is not denied View Channel';
  if ((everyone.allow & view) !== 0n) return '@everyone is allowed View Channel';
  for (const o of overwrites) {
    if (o === everyone || (o.allow & view) === 0n) continue;
    const ok = o.type === 0 ? allow.roleIds.includes(o.id) : allow.userIds.includes(o.id);
    if (!ok) return `${o.type === 0 ? 'role' : 'member'} ${o.id} may see the room but is not on the allowed list`;
  }
  return null;
}
