import type { DeptId } from '../core/index.js';

export type ActorRef = { kind: 'head'; dept: DeptId } | { kind: 'persona'; personaId: string };

export interface DeptSeed {
  id: DeptId;
  name: string;
  /** RegExp source, matched case-insensitively against Discord category names. */
  categoryNamePattern: string;
  /** Null for a department without a work channel (praw). */
  workChannelId: string | null;
  color: number;
  /** Seeded model routing; null/absent means the global default. */
  provider?: string | null;
  model?: string | null;
}

export interface PersonaSeed {
  dept: DeptId;
  directChannelId: string;
}

export interface GuildChannelInfo {
  id: string;
  name: string;
  parentId: string | null;
  type: number;
}

/** RF13: a Discord attachment object of a replied-to message or a forward snapshot; read only through read_image by index. `contentType` is untrusted. */
export type MediaRef = { name: string; url: string; size: number; contentType?: string };

export interface IncomingMessage {
  id: string;
  channelId: string;
  /** Parent channel when the message is in a thread, otherwise null. */
  parentChannelId: string | null;
  threadId: string | null;
  author: { id: string; name: string; kind: 'human' | 'head' | 'persona' | 'foreign_bot'; actor?: ActorRef };
  content: string;
  /** P1-B: a person's message explicitly mentions someone who is not one of our bots (a person, a non-bot role, @everyone/@here); the implicit reply ping is excluded. */
  otherMentions?: boolean;
  /** Departments whose head bot user is mentioned (resolved upstream). */
  mentionedHeads: DeptId[];
  isAdmin: boolean;
  /** Role ids of the author's member as sent with the message (humans only; absent for history and synthetic messages). Delegated tiers read it, never a cache. */
  memberRoleIds?: readonly string[];
  /**
   * The id of the message this one replies to: a real Discord reply (reference type Default) in this same channel and guild only (RF1). A mod-room reply can
   * point at the message to delete or pin (T15). A forward never sets it.
   */
  replyToId?: string;
  /** VULN-006: the department of OUR bot (head or persona) that wrote the replied-to message, read from the gateway reference; absent for a human or foreign author. Limits who may fetch it. */
  repliedDept?: DeptId;
  /**
   * RF4/RF5: the message `replyToId` points at, fetched live from the same channel by the scheduler (never by the mapper) and attributed with the same
   * rules as any author. Absent = not fetched or failed (no reply route). `content` is capped; its text is untrusted unless provenance says otherwise.
   */
  replied?: { id: string; author: IncomingMessage['author']; content: string; attachmentCount: number; attachments?: MediaRef[] };
  /**
   * RF1/RF8: a Discord forward (reference type Forward with message snapshots). The snapshot is inert data: never in `content`, `mentionedHeads`,
   * `attachments` or any url list. `sourceChannelId` is null when the source is another guild or unknown (always refused, RF7).
   */
  forward?: { sourceChannelId: string | null; sourceMessageId: string | null; text: string; attachmentCount: number; attachments?: MediaRef[] };
  /** `contentType` is what Discord declared (untrusted; the bytes are sniffed before anything reads them). */
  attachments: { name: string; url: string; size: number; contentType?: string }[];
  /** How this message reached us, set by the creating path: gateway message -> chat, interaction -> slash, voice -> voice. */
  origin: 'chat' | 'slash' | 'voice';
}
