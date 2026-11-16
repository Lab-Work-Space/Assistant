import type { MemberInfo, PermWorld } from '../perm/perm-world.js';

/**
 * What the server ops know about the guild beyond the permission ops (PermWorld): live data read through the executor's client
 * (executor/world.ts) and its database. A port, so the hard limits (server-limits.ts) are tested against fakes. Anything that cannot be
 * read is null (the limits then refuse: fail closed).
 */
export interface MessageInfo {
  id: string;
  authorId: string;
  authorBot: boolean;
  /** ms since the epoch (from the snowflake / createdTimestamp). */
  createdAt: number;
  pinned: boolean;
}
export interface GuildInfo {
  id: string;
  name: string;
  description: string | null;
  systemChannelId: string | null;
  rulesChannelId: string | null;
  ownerId: string;
}
export interface UserInfo {
  id: string;
  isBot: boolean;
  username: string;
}
/** A rule as Discord returns it, reduced to what the limits and the card need. */
export interface AutoModInfo {
  id: string;
  name: string;
  enabled: boolean;
  /** discord-api-types AutoModerationRuleTriggerType: 1 Keyword, 3 Spam, 4 KeywordPreset, 5 MentionSpam, 6 MemberProfile. */
  triggerType: number;
  keywords: string[];
  regex: string[];
  allow: string[];
  presets: number[];
  mentionLimit: number | null;
  exemptRoles: string[];
  exemptChannels: string[];
  blockMessage: boolean;
  blockCustomMessage: string | null;
  alertChannelId: string | null;
  timeoutSeconds: number | null;
}
export interface EventInfo {
  id: string;
  name: string;
  description: string | null;
  /** discord-api-types GuildScheduledEventStatus: 1 Scheduled, 2 Active, 3 Completed, 4 Canceled. */
  status: number;
  /** 1 StageInstance, 2 Voice, 3 External. */
  entityType: number;
  channelId: string | null;
  location: string | null;
  start: number;
  end: number | null;
}
export interface InviteInfo {
  code: string;
  channelId: string | null;
  uses: number;
  maxUses: number;
  inviterId: string | null;
}

export interface ServerWorld extends PermWorld {
  guild(): Promise<GuildInfo | null>;
  /** Up to `limit` (<= 100) newest messages of a channel; null when unreadable. */
  messages(channelId: string, limit: number): Promise<MessageInfo[] | null>;
  message(channelId: string, id: string): Promise<MessageInfo | null>;
  /** Empty means: a channel with no message (fetch limit 1), a forum with no thread, a category with no child. Null = unknown. */
  channelEmpty(id: string): Promise<boolean | null>;
  user(id: string): Promise<UserInfo | null>;
  /** G2SM-04: true = a member, false = Discord says Unknown Member (10007), null = any other error (the limits then refuse). */
  isMember(id: string): Promise<boolean | null>;
  banned(userId: string): Promise<boolean | null>;
  autoModRules(): Promise<AutoModInfo[] | null>;
  events(): Promise<EventInfo[] | null>;
  invites(): Promise<InviteInfo[] | null>;
  /** Channels mapped to a department (the channel_map table): never deleted or archived. */
  mappedChannelIds(): Promise<string[]>;
  /** The executor's own record of when it archived a channel (S16), or null. */
  archivedAt(channelId: string): Promise<number | null>;
  /** S10: the newest audit-log entries, reduced to action, executor, target, time and the (untrusted) reason. */
  auditLog(limit: number): Promise<{ action: string; executorId: string | null; targetId: string | null; at: number; reason: string | null }[] | null>;
  /** Members for discovery (S9): at most `limit`, fresh. */
  memberList(limit: number): Promise<(MemberInfo & { joinedAt: number | null; displayName: string })[] | null>;
}

export interface ServerWriter {
  editChannel(id: string, o: { name?: string; topic?: string; slowmode?: number; nsfw?: boolean }, reason: string): Promise<void>;
  moveChannel(id: string, o: { parentId: string | null; position?: number }, reason: string): Promise<void>;
  makeChannel(o: { name: string; type: 'text' | 'voice' | 'forum' | 'stage' | 'announcement' | 'category'; parentId: string | null; topic?: string }, reason: string): Promise<string>;
  archiveChannel(id: string, o: { archiveCategoryId: string; everyoneRoleId: string }, reason: string): Promise<void>;
  deleteChannel(id: string, reason: string): Promise<void>;
  setThread(id: string, action: 'archive' | 'lock' | 'unlock' | 'delete', reason: string): Promise<void>;
  setNick(memberId: string, nick: string | null, reason: string): Promise<void>;
  createInvite(channelId: string, o: { maxAgeSeconds: number; maxUses: number }, reason: string): Promise<string>;
  revokeInvite(code: string, reason: string): Promise<void>;
  deleteMessage(channelId: string, messageId: string, reason: string): Promise<void>;
  bulkDelete(channelId: string, ids: string[]): Promise<number>;
  pin(channelId: string, messageId: string, on: boolean, reason: string): Promise<void>;
  timeout(memberId: string, until: Date | null, reason: string): Promise<void>;
  kick(memberId: string, reason: string): Promise<void>;
  ban(userId: string, deleteDays: number, reason: string): Promise<void>;
  unban(userId: string, reason: string): Promise<void>;
  createAutoMod(rule: AutoModWrite, reason: string): Promise<string>;
  editAutoMod(id: string, rule: Partial<AutoModWrite>, reason: string): Promise<void>;
  deleteAutoMod(id: string, reason: string): Promise<void>;
  editGuild(o: { name?: string; description?: string | null; systemChannelId?: string | null; rulesChannelId?: string | null }, reason: string): Promise<void>;
  createEvent(o: EventWrite, reason: string): Promise<string>;
  editEvent(id: string, o: Partial<EventWrite> & { cancel?: boolean }, reason: string): Promise<void>;
  /** S12 / the welcome handler: the one role-add that does not come from a card. */
  addRole(memberId: string, roleId: string, reason: string): Promise<void>;
}

export interface AutoModWrite {
  name: string;
  enabled: boolean;
  triggerType: 1 | 3 | 4 | 5;
  keywords?: string[];
  regex?: string[];
  allow?: string[];
  presets?: number[];
  mentionLimit?: number;
  exemptRoles: string[];
  exemptChannels: string[];
  block: boolean;
  blockCustomMessage?: string;
  alertChannelId?: string;
  timeoutSeconds?: number;
}
export interface EventWrite {
  name: string;
  description?: string;
  type: 'voice' | 'stage' | 'external';
  channelId?: string;
  location?: string;
  start: Date;
  end?: Date;
}
