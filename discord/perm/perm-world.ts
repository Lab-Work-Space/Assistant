/**
 * What the permission ops know about the guild: live data, fetched fresh, through the `praw` client (discord/guild-read.ts). A port, so the
 * hard limits (perm-limits.ts) are tested against fakes. Anything that cannot be read is null (the limits then refuse: fail closed).
 */
export interface RoleInfo {
  id: string;
  name: string;
  position: number;
  managed: boolean;
  /** `tags.botId` of an integration role: the bot application it belongs to. */
  botId: string | null;
  permissions: bigint;
}
export interface OverwriteInfo {
  id: string;
  type: 'role' | 'member';
  allow: bigint;
  deny: bigint;
}
export interface ChannelInfo {
  id: string;
  name: string;
  /** discord.js ChannelType number (4 = category). */
  type: number;
  parentId: string | null;
  isThread: boolean;
  overwrites: OverwriteInfo[];
  /** Phase 2 (server ops): the editable fields, filled by the executor's world only. */
  topic?: string | null;
  slowmode?: number;
  nsfw?: boolean;
  position?: number;
  /** Threads only. */
  archived?: boolean;
  locked?: boolean;
}
export interface MemberInfo {
  id: string;
  isBot: boolean;
  roleIds: string[];
  isOwner: boolean;
  /** Phase 2: shown on cards (live, escaped by the card renderer). */
  username?: string;
  nick?: string | null;
  timeoutUntil?: number | null;
}
export const CATEGORY_TYPE = 4;

export interface PermWorld {
  /** @everyone's role id is the guild id. */
  guildId: string;
  /** Praw's own member (fresh) and the position of her highest role. */
  me(): Promise<(MemberInfo & { topPosition: number }) | null>;
  roles(): Promise<RoleInfo[] | null>;
  /** One channel, or null when it cannot be read (unknown, hidden, error). */
  channel(id: string): Promise<ChannelInfo | null>;
  /** Every non-thread guild channel visible to Praw, fresh. */
  channels(): Promise<ChannelInfo[] | null>;
  /** One member by id (needs no privileged intent), or null when it cannot be fetched. */
  member(id: string): Promise<MemberInfo | null>;
  /** User ids of the bot applications this process runs (online clients). */
  knownBotIds(): string[] | Promise<string[]>;
  /** Optional: every bot member with its roles in one fresh read (the executor pages the REST member list). Without it the limits fetch each
   * id from knownBotIds() with member(), one request per bot, which Discord rate-limits enough to push the executor's status past its timeout. */
  knownBotMembers?(): Promise<MemberInfo[]>;
  /** For the boot check: does this channel id exist or is it confirmed hidden? 'error' = unknown. */
  probeChannel(id: string): Promise<'visible' | 'hidden' | 'error'>;
}

export interface PermWriter {
  assignRole(memberId: string, roleId: string, reason: string): Promise<void>;
  removeRole(memberId: string, roleId: string, reason: string): Promise<void>;
  setOverwrite(channelId: string, target: { type: 'role' | 'member'; id: string }, allow: bigint, deny: bigint, reason: string): Promise<void>;
  clearOverwrite(channelId: string, target: { type: 'role' | 'member'; id: string }, reason: string): Promise<void>;
  createChannel(o: { name: string; parentId: string | null; type: 'text' | 'voice' | 'forum'; sync: boolean }, reason: string): Promise<string>;
  createRole(o: { name: string; color: number; hoist: boolean; permissions: bigint }, reason: string): Promise<string>;
  editRolePermissions(roleId: string, permissions: bigint, reason: string): Promise<void>;
}
