import { AttachmentBuilder, ChannelType, PermissionFlagsBits, type Client, type ForumChannel, type Message, type SendableChannels } from 'discord.js';
import type { OutboundPayload } from '../agents/loop/payload.js';
import { DENIED_CATEGORY_IDS, isDenied, PRIVILEGED_ROLE_IDS } from '../company/denylist.js';
import { isExcludedChannel } from '../company/exclusion.js';
import { defangHandles, handlesIn, neutralise, toMentions } from '../company/handles.js';
import type { ActorRef, GuildChannelInfo, IncomingMessage } from '../company/types.js';
import { redactText, type DeptId } from '../core/index.js';
import type { Department, Persona, Task, TaskMessageKind } from '../db/repos/index.js';
import { createHash } from 'node:crypto';
import { revokeRow, taskRevokeRow } from './embeds/approval.js';
import { buildMessage, buildPlainMessage, isCardPayload, type BuildContext, type OutboundMessage } from './embeds/index.js';
import type { WebhookSender } from './webhooks.js';
import { cardBody } from '../company/forward.js';
import { roomOverwriteProblem, type RoomAllow } from './approval/approval-room-check.js';
import { STREAM_MAX_ACTIVE, STREAM_PER_CHANNEL } from '../agents/stream/stream-holdback.js';
import { ReplyStreamEngine, typingOnly, type ReplyStream, type StreamBuilt, type StreamIO, type StreamLogger } from './reply-stream.js';

export type { ReplyStream, StreamFinalOpts } from './reply-stream.js';

import { BOT_LOG_CHANNEL_ID } from '../company/channels.js';
export { AI_WARROOM_CHANNEL_ID, BOT_LOG_CHANNEL_ID } from '../company/channels.js';
export const TASK_LOG_CHANNEL_ID = '1565671253803794494';
export const DIRECT_LOG_CHANNEL_ID = '1565671325597700157';

/** R12: `mentionUserIds` is the only way a post pings anyone: those users, as a content prefix, and allowedMentions.users is exactly that list. */
export interface PostOptions {
  mentionUserIds?: string[];
  /** Called with the ids of every message actually sent (a long payload is split), even when a later one failed; post still returns the first id. */
  onSent?: (ids: string[]) => void;
  /** WS13: the first message replies to this message (a snowflake; the reply never pings). Ignored for persona webhooks and when the message is gone. */
  replyToId?: string;
  /** R7: sent with `enforceNonce` on the first message of a non-persona post, so the REST library's own retry of a timed-out or 5xx POST is deduplicated by Discord (the install_plugin notice). */
  nonce?: string;
}

/** STREAM-1: what `openReplyStream` needs from the run. `halted` is the agent loop's predicate (a throw counts as halted); `canCreate` is re-evaluated right before the first preview is created. */
export interface OpenReplyStreamOptions {
  replyToId?: string;
  /** Streaming is refused when any user would be pinged (S9). */
  mentionUserIds?: string[];
  halted: () => boolean;
  canCreate?: () => Promise<boolean>;
}

export type DmResult = 'sent' | 'partial' | 'failed';

/** A forum channel as the tools see it: its tags are the only ones a post may carry (ids from `availableTags`). */
export interface ForumInfo { id: string; name: string; tags: { id: string; name: string }[] }
/** One post of a forum, as listed. `first` is the starter message's text (cut at the port; the tool bounds it again). Raw human text: untrusted. */
export interface ForumPostSummary { id: string; parentId: string; name: string; tags: string[]; first: string; replies: number }
/** One post read in full, oldest message first. */
export interface ForumPostRead { id: string; parentId: string; name: string; tags: string[]; messages: { author: string; content: string; attachments: number }[] }

export interface DiscordPort {
  post(actor: ActorRef, target: { channelId: string; threadId?: string }, p: OutboundPayload, opts?: PostOptions): Promise<string>;
  /**
   * STREAM-1: a live reply preview for one run (one message created from the first committed answer text, replaced in place, never deleted). Null
   * when streaming is refused (users would be pinged, a persona outside its own room, an unknown persona). Over the caps (one stream per channel,
   * four per process) the handle shows the typing indicator only. Optional: a port without it streams nothing.
   */
  openReplyStream?(actor: ActorRef, target: { channelId: string; threadId?: string }, o: OpenReplyStreamOptions): ReplyStream | null;
  /** Task 33: posts the payload as the actor's bot with one file attached (Attach Files, channel overwrite only); never pings. Returns the first message id. */
  /** `file.nonce`: sent with `enforceNonce` so the REST library's own retry of a timed-out or 5xx POST is deduplicated by Discord (G2-RL-08). */
  postFile(actor: ActorRef, target: { channelId: string; threadId?: string }, p: OutboundPayload, file: { name: string; data: Buffer; contentType: string; nonce?: string }): Promise<string>;
  /** Sends the payload to the user's DMs as the actor's bot, never pinging. 'failed' when nothing was delivered (closed DMs); 'partial' when a first message went out and a later one failed (the caller must not resend); never throws for that. */
  dm(actor: ActorRef, userId: string, p: OutboundPayload): Promise<DmResult>;
  createThread(dept: DeptId, channelId: string, name: string): Promise<string>;
  /** The forum's name and tags, or null when the id is not a forum, is denied or cannot be fetched (fails closed). */
  forumInfo(forumId: string): Promise<ForumInfo | null>;
  /** Newest posts of a forum (active, then recently archived), at most `limit` of the most recent `FORUM_SCAN_MAX`, denied posts left out. Throws DeniedChannelError for a denied forum. */
  listForumPosts(forumId: string, limit: number): Promise<ForumPostSummary[]>;
  /** One post with up to `limit` messages, oldest first. Null when it is not a post of a forum; throws DeniedChannelError when it or its parent is denied. */
  readForumPost(postId: string, limit: number): Promise<ForumPostRead | null>;
  /**
   * TW10: a new post in a forum as `dept`'s bot. The forum goes through the denylist, the starter message through the redaction and the
   * embed builder, with `allowedMentions.parse = []`; `tagIds` must all be in the forum's `availableTags`. Returns the post id and the
   * starter message id (equal in a forum). `onSent` receives every message id sent (starter first) for provenance.
   */
  createForumPost(dept: DeptId, forumId: string, p: { title: string; body: string; tagIds: string[] }, opts?: Pick<PostOptions, 'onSent'>): Promise<{ postId: string; messageId: string }>;
  /**
   * One card per task in #📋-tasks, edited in place (status colour). Sends and stores the id when none is stored; edits only when the
   * rendered digest changed; reposts once and replaces the id only on Unknown Message (10008); any other error keeps the id and does not repost.
   */
  /** `extra.blockedBecause` (TASKADMIN-1): the owner's masked blocked reason, shown as a field on the card; event-only, never read back from the database. */
  upsertTaskLog(task: Task, extra?: { blockedBecause?: string }): Promise<void>;
  /**
   * The same upsert for the task's card in its thread (`card_message_id`), posted and edited by the same client (or persona webhook).
   * Returns the card's message id. `popts` apply to a fresh send only. `editOnly`: a task with no stored card (it predates this feature) is
   * left alone and null is returned, so a change or boot recovery never adds a card to an old thread.
   */
  upsertTaskCard(task: Pick<Task, 'id' | 'status'>, actor: ActorRef, target: { channelId: string; threadId?: string }, p: OutboundPayload, popts?: PostOptions, editOnly?: boolean): Promise<string | null>;
  /**
   * TEAMTALK-1 (H1): the handoff line of a child task in its parent's thread (`handoff_message_id`), plain text through `noHandles`. Creation sends and
   * stores the id; `editOnly` (every status change) never sends when none is stored; a 10008 reposts once. All under one serial key per task.
   */
  upsertHandoff(task: Pick<Task, 'id' | 'status'>, actor: ActorRef, target: { channelId: string; threadId?: string }, p: OutboundPayload, popts?: Pick<PostOptions, 'onSent'>, editOnly?: boolean): Promise<string | null>;
  /**
   * TEAMTALK-1: the persona room's work board: ONE message per room posted and edited by the persona webhook (plain, `noHandles`), pinned by the persona's
   * head client. Key `room:` + 32 hex of sha256(persona id). Edits only when the content changed; a 10008 reposts once; a failing board-store write after a
   * send turns this room's board off until restart (no repost loop). `pin` says what happened to the pin (a missing permission is the caller's one warning).
   */
  upsertRoomBoard(actor: ActorRef, channelId: string, p: OutboundPayload, popts?: Pick<PostOptions, 'onSent'>): Promise<{ pin: 'ok' | 'skipped' | PinFailure }>;
  /** The pinned summary board in #📋-tasks: send+pin once (id stored), later edits only when `body` changed. */
  upsertBoard(key: string, p: OutboundPayload, channelId?: string): Promise<void>;
  logDirect(from: ActorRef, to: ActorRef, text: string): Promise<void>;
  /**
   * Oldest first. Read with the client of `reader` (a persona uses its head's client): that bot can itself view the channel it answers in.
   * `reader` is required: pass the hq actor explicitly where hq is meant. Never widened to another bot's access.
   */
  history(channelOrThreadId: string, limit: number, reader: ActorRef): Promise<IncomingMessage[]>;
  listGuildChannels(): Promise<GuildChannelInfo[]>;
  /**
   * RF4: one message of `channelId` (a channel or thread, same guild), mapped like any other and read live; null when it is gone, not fetchable, or the
   * channel is denied. The caller attributes it by the mapper's author rules only.
   */
  fetchMessage(channelId: string, messageId: string, reader: ActorRef): Promise<IncomingMessage | null>;
  /**
   * RF7: what a forward's source channel is, read live: its parent channel (a thread only), its category and whether it is a private thread. Null = unknown, another guild, a DM
   * or not fetchable (the caller refuses).
   */
  sourceFacts(channelId: string): Promise<{ parentId: string | null; categoryId: string | null; privateThread: boolean } | null>;
  /** RF11: whether @everyone can view the channel (a thread: its parent), read live; false on any doubt. */
  channelIsPublic(channelId: string): Promise<boolean>;
  /** P16d: whether the guild member can see the channel (real Discord permissions); false on any doubt. */
  canMemberView(userId: string, channelId: string): Promise<boolean>;
  /** REROUTE-1 (RR-C11): whether the guild member can talk in the channel: View Channel, Send Messages and Send Messages in Threads (real permissions, read now); false on any doubt. */
  canMemberPost(userId: string, channelId: string): Promise<boolean>;
  /**
   * REROUTE-1 (RR-C9): whether `dept`'s own bot can work (read the history and reply) in a channel or thread, read live. Tri-state: `no` only for a definite
   * answer (bad id, excluded channel, Missing Access / Missing Permissions / Unknown Channel, a missing permission, a thread that is locked, archived or private
   * without membership); `unknown` for anything transient (client offline, timeout, 5xx, rate limit), which keeps today's routing and is never cached.
   */
  botCanWork(dept: DeptId, channelOrThreadId: string): Promise<BotAccess>;
  /** F2 / LF1: whether the text channel exists and hides itself from @everyone (View Channel denied), read live; false on any doubt. `warroom_say` posts only to such a room. */
  channelIsPrivate(channelId: string): Promise<boolean>;
  /** F3 / LF8: whether `dept`'s live bot can View the channel (or thread; real Discord permissions, read now); false on any doubt, or when the bot has no live id. */
  botCanView(dept: DeptId, channelId: string): Promise<boolean>;
  /**
   * WS6: the category of a channel or forum (for a thread pass its parent), read live from Discord: channel -> parent category. Null when any
   * link is unresolved, it is a DENIED category, or the channel is excluded (denied / system). Never derived from model input.
   */
  categoryOf(channelId: string): Promise<string | null>;
  /** WS6: whether `dept`'s bot may open a thread in this text channel right now (View, Send, Create Public Threads, checked live); false on any doubt, in an excluded channel or in a DENIED category. */
  canStartThread(dept: DeptId, channelId: string): Promise<boolean>;
  /**
   * WS8: why `channelId` may NOT serve as the approvals room of category `categoryId` right now (read live), or null when it may: a guild text
   * channel whose parent is that category, @everyone denied View Channel, and every other viewer in `allow`. Any failure to read is a problem.
   */
  approvalRoomProblem(channelId: string, categoryId: string, allow: RoomAllow): Promise<string | null>;
  /**
   * Gate 1 C6: closes an admin console card (the hq client's own message): removes its buttons and writes `note` as the message text,
   * so a consumed, cancelled, superseded or expired card cannot be pressed again. Never throws for a message that is gone.
   */
  closeCard(channelId: string, messageId: string, note: string, revoke?: number | { task: number }): Promise<void>;
  /** TREEGRANT-1: replaces ONLY the message content of the hq client's own card (components and embeds stay); never throws for a message that is gone. */
  noteCard?(channelId: string, messageId: string, note: string): Promise<void>;
  /**
   * APPROVAL-BATCH-1 (B1): re-renders a batched approval card in place from `payload` (one message, one embed, buttons only for what is
   * still pending). Edits only the hq client's own message (same author check as closeCard) and never throws for a message that is
   * gone: returns false then (and when the message is not the hq client's), true once edited.
   */
  updateCard(channelId: string, messageId: string, payload: OutboundPayload): Promise<boolean>;
  /** P17: pins a message of `channelId` (a channel or thread; the denylist covers both and the thread's parent) as the actor's bot. Throws PinError or DeniedChannelError. */
  pin(actor: ActorRef, channelId: string, messageId: string): Promise<void>;
}

export type PinFailure = 'missing_permission' | 'unknown_message' | 'pin_limit';
const PIN_TEXT: Record<PinFailure, string> = {
  missing_permission: 'Praw lacks the Pin Messages permission in this channel; a Bot Admin must grant it as a channel overwrite',
  unknown_message: 'that message was not found in this channel',
  pin_limit: 'this channel has reached the Discord pin limit',
};
// Discord JSON error codes: Missing Access, Missing Permissions, Unknown Message, Maximum pins reached.
const PIN_CODES: Record<number, PinFailure> = { 50001: 'missing_permission', 50013: 'missing_permission', 10008: 'unknown_message', 30003: 'pin_limit' };

export class PinError extends Error {
  constructor(readonly reason: PinFailure) {
    super(PIN_TEXT[reason]);
    this.name = 'PinError';
  }
}

export class DeniedChannelError extends Error {
  constructor(channelId: string) {
    super(`channel ${channelId} is denied`);
    this.name = 'DeniedChannelError';
  }
}

export type PortOrg = { dept(id: string): Department | null; persona(id: string): Persona | null };
export type ClientSource = { client(dept: DeptId): Client | undefined };
export interface PortOptions {
  guildId: string;
  adminRoleId: string;
  /** Maps fetched history (the inbound mapper, which also resolves persona webhooks). */
  inbound: (m: Message) => Promise<IncomingMessage | null>;
  /** Literal secrets (env keys, tokens) masked in every outbound text on top of the logger's patterns (P24). */
  secrets?: readonly string[];
  /** Stored card ids of #tasks cards and thread cards (edited in place, Part B). Absent: every call posts a new message, as before. */
  taskMessages?: TaskMessageStore;
  /** Stored id/digest of the pinned summary board. */
  boards?: BoardStore;
  /** TW8: bot user id -> department of the heads that are online (ClientManager.botUserIds); the only source of mention ids. */
  botUserIds?: () => ReadonlyMap<string, DeptId>;
  /** WS8: the post-only rooms (approvals rooms), read live. history() returns nothing for them: they never enter any model context. */
  postOnly?: () => readonly string[];
  /** STREAM-1: stream logs (outcome, Discord code/status only: never an error object, which carries the partial answer). Absent: silent. */
  log?: StreamLogger;
}

/** The stored message ids of a task's two cards; claim/replace are conditional UPDATEs (Gate 1 TW15). */
export interface TaskMessageStore {
  messageId(taskId: string, kind: TaskMessageKind): Promise<string | null>;
  claimMessage(taskId: string, kind: TaskMessageKind, messageId: string): Promise<boolean>;
  replaceMessage(taskId: string, kind: TaskMessageKind, oldId: string, messageId: string): Promise<boolean>;
}
export interface BoardStore {
  get(key: string): Promise<{ channelId: string; messageId: string; digest: string | null } | null>;
  set(key: string, m: { channelId: string; messageId: string; digest: string | null }): Promise<void>;
  setDigest(key: string, digest: string): Promise<void>;
}

/** G2LF-01: roles that are bot-only: Assistant, LW Bots, AI Employee. */
const WARROOM_BOT_ROLE_IDS: readonly string[] = ['1565650295302651955', '1566025700669001828', '1566419577053777991'];
const THREAD_NAME_MAX = 100;
const CONTENT_MAX = 2000;
const HISTORY_MAX = 100;
const SNOWFLAKE = /^\d{1,25}$/;
const UNKNOWN_MESSAGE = 10008;
const DIGESTS_MAX = 5000;
/** Posts looked at per forum listing: the newest of the active and the recently archived ones. */
export const FORUM_SCAN_MAX = 30;
const FORUM_FIRST_MAX = 2000;

/**
 * TEAMTALK-1 T1 final pass on the BUILT message (a cut or split can make a handle out of `@CFOx`): defang again, then refuse to send when any handle or
 * `<@` markup is left in the content or an embed text. `suppress`: link embeds are switched off (bare links in a relay).
 */
function defangMessage(m: OutboundMessage, suppress: boolean): OutboundMessage {
  const d = (t: string | undefined | null) => (t === undefined || t === null ? t : defangHandles(t));
  const out: OutboundMessage = {
    ...m,
    ...(m.content !== undefined ? { content: defangHandles(m.content) } : {}),
    embeds: m.embeds.map((e) => ({
      ...e, ...(e.title !== undefined ? { title: d(e.title)! } : {}), ...(e.description !== undefined ? { description: d(e.description)! } : {}),
      ...(e.fields ? { fields: e.fields.map((f) => ({ ...f, name: d(f.name)!, value: d(f.value)! })) } : {}),
      ...(e.footer ? { footer: { ...e.footer, text: d(e.footer.text)! } } : {}),
    })),
    ...(suppress ? { flags: 4 } : {}),
  };
  const text = [out.content ?? '', ...out.embeds.flatMap((e) => [e.title ?? '', e.description ?? '', e.footer?.text ?? '', ...(e.fields ?? []).flatMap((f) => [f.name, f.value])])].join('\n');
  if (handlesIn(text).length || /<@/.test(text)) throw new Error('a handle or mention survived defanging; the message was not sent');
  return out;
}

/** Gate 1 D10: every outbound text is scanned with the logger's patterns before building. */
function redactPayload(p: OutboundPayload, secrets: readonly string[] = []): OutboundPayload {
  const red = (t: string) => redactText(t, secrets);
  return {
    ...p,
    title: p.title === undefined ? undefined : red(p.title),
    body: red(p.body),
    fields: p.fields?.map((f) => ({ name: red(f.name), value: red(f.value) })),
    footer: p.footer && { ...p.footer, model: red(p.footer.model) },
  };
}

/** T8: a fixed-length `board_messages` key (the column allows 64 characters; a persona id can be as long). */
const roomBoardKey = (personaId: string): string => `room:${createHash('sha256').update(personaId).digest('hex').slice(0, 32)}`;

const label = (a: ActorRef) => (a.kind === 'head' ? a.dept : a.personaId);

type Resolved = { channel: SendableChannels; parentId: string; threadId: string | undefined };

/** REROUTE-1: the answer of DiscordPort.botCanWork. */
export type BotAccess = 'yes' | 'no' | 'unknown';

/** Discord API errors that are a definite "this bot cannot": Unknown Channel, Missing Access, Missing Permissions. */
const DEFINITE_NO = [10003, 50001, 50013];
/** Unknown Member / Unknown User: a thread member lookup that answers "not a member". */
const NOT_A_MEMBER = [10007, 10013];
const codeOf = (e: unknown): number | undefined => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'number' ? c : undefined;
};

export function createDiscordPort(cm: ClientSource, webhooks: WebhookSender, org: PortOrg, opts: PortOptions): DiscordPort {
  const clientOf = (dept: DeptId): Client => {
    const c = cm.client(dept);
    if (!c) throw new Error(`${dept} client is offline`);
    return c;
  };

  /** HIST-1: the dept whose client reads history: the reading actor's own (a persona's head). */
  const readerDept = (a: ActorRef): DeptId => {
    if (a.kind === 'head') return a.dept;
    const persona = org.persona(a.personaId);
    if (!persona) throw new Error(`unknown persona ${a.personaId}`);
    return persona.deptId as DeptId;
  };

  /** F3: whether a bot user can View `channelId`, read live; an error counts as "cannot see" (LF8). */
  async function botCanViewId(botId: string, channelId: string): Promise<boolean> {
    try {
      if (!SNOWFLAKE.test(botId)) return false;
      const hq = clientOf('hq');
      const guild = hq.guilds.cache.get(opts.guildId);
      if (!guild) return false;
      const [ch, member] = await Promise.all([hq.channels.fetch(channelId), guild.members.fetch(botId)]);
      const perms = ch && 'permissionsFor' in ch ? (ch as { permissionsFor(m: unknown): { has(b: bigint): boolean } | null }).permissionsFor(member) : null;
      return perms?.has(PermissionFlagsBits.ViewChannel) === true;
    } catch {
      return false;
    }
  }

  /**
   * Redaction, then TW8: raw mentions (`<@..>`, `<@&..>`, `@everyone`, `@here`) in model text are broken so they can neither ping nor route,
   * then a handle such as `@CTO` becomes `<@id>` for an online head (the id from the live bot-id map only). The mention stays in the embed, which
   * renders it without a ping; `allowedMentions` is never widened. System (governance) text is left alone, except task cards that quote titles.
   * F3: only the description (body) and the field values are converted; a title and a field name never render a mention, so they keep the handle text
   * (`@CTO`). When `channelId` is given, a handle is converted only for a bot that can View that channel right now (read once per bot per call; an error
   * counts as "cannot see"), otherwise the mention would show as a raw `<@id>`; it stays plain text.
   */
  const outbound = async (p: OutboundPayload, channelId?: string): Promise<OutboundPayload> => {
    const red = redactPayload(p, opts.secrets);
    if (p.origin === 'governance' && p.type !== 'task') return red;
    // TEAMTALK-1 T1/T2: a code-written relay of model text and the governance task card never carry a live handle (see defangMessage for the final pass).
    if (p.noHandles || p.origin === 'governance') {
      const d = (t: string) => defangHandles(neutralise(t));
      return {
        ...red, ...(red.title === undefined ? {} : { title: d(red.title) }), body: d(red.body),
        ...(red.fields ? { fields: red.fields.map((f) => ({ name: d(f.name), value: d(f.value) })) } : {}),
      };
    }
    const ids = new Map<DeptId, string>();
    {
      const wanted = new Set<DeptId>(handlesIn([red.body, ...(red.fields ?? []).map((f) => f.value)].join('\n')));
      for (const [id, dept] of opts.botUserIds?.() ?? []) {
        if (!wanted.has(dept) || ids.has(dept)) continue;
        if (channelId === undefined || (await botCanViewId(id, channelId))) ids.set(dept, id);
      }
    }
    const fix = (t: string) => toMentions(neutralise(t), (d) => ids.get(d));
    return {
      ...red, ...(red.title === undefined ? {} : { title: neutralise(red.title) }), body: fix(red.body),
      ...(red.fields ? { fields: red.fields.map((f) => ({ name: neutralise(f.name), value: fix(f.value) })) } : {}),
    };
  };

  /** Fetches the channel (or thread) and enforces the denylist on it and its parent (Gate 1 D8). */
  async function resolve(client: Client, channelId: string, threadId?: string): Promise<Resolved> {
    if (isDenied(channelId, null) || (threadId !== undefined && isDenied(threadId, channelId))) throw new DeniedChannelError(threadId ?? channelId);
    const ch = await client.channels.fetch(threadId ?? channelId);
    if (!ch) throw new Error(`channel ${threadId ?? channelId} not found`);
    if (ch.isThread()) {
      if (!ch.parentId || isDenied(ch.id, ch.parentId)) throw new DeniedChannelError(ch.id);
      if (threadId !== undefined && ch.parentId !== channelId) throw new Error(`thread ${ch.id} is not in channel ${channelId}`);
      return { channel: ch, parentId: ch.parentId, threadId: ch.id };
    }
    if (threadId !== undefined) throw new Error(`${threadId} is not a thread`);
    if (!ch.isSendable()) throw new Error(`channel ${channelId} is not a text channel`);
    return { channel: ch, parentId: ch.id, threadId: undefined };
  }

  /** A forum channel behind the denylist (on it and its parent); anything else, or a forum that cannot be fetched, throws. */
  async function forumOf(client: Client, forumId: string): Promise<ForumChannel> {
    if (isDenied(forumId, null)) throw new DeniedChannelError(forumId);
    const ch = await client.channels.fetch(forumId);
    if (!ch || ch.type !== ChannelType.GuildForum) throw new Error(`channel ${forumId} is not a forum`);
    if (isDenied(ch.id, ch.parentId)) throw new DeniedChannelError(ch.id);
    return ch;
  }

  /** Returns the first message id, or the LAST one when `last` (a card whose buttons sit on its last message: G2SP-05). */
  async function sendAll(channel: SendableChannels, msgs: OutboundMessage[], onSent?: (ids: string[]) => void, last = false): Promise<string> {
    const ids: string[] = [];
    try {
      for (const m of msgs) ids.push((await channel.send(m)).id);
    } finally {
      if (ids.length) onSent?.(ids);
    }
    return last ? ids.at(-1)! : ids[0]!;
  }

  type Composed = { persona: Persona | null; client: Client; where: Resolved; msgs: OutboundMessage[] };
  /** Resolves who posts where (persona only in its own direct room, denylist on channel and parent) and builds the masked messages. */
  async function compose(actor: ActorRef, target: { channelId: string; threadId?: string }, p: OutboundPayload, extra: Partial<BuildContext> = {}, plain = false): Promise<Composed> {
    const persona = actor.kind === 'persona' ? org.persona(actor.personaId) : null;
    if (actor.kind === 'persona' && !persona) throw new Error(`unknown persona ${actor.personaId}`);
    const deptId = (persona ? persona.deptId : (actor as { dept: DeptId }).dept) as DeptId;
    const client = clientOf(deptId);
    const where = await resolve(client, target.channelId, target.threadId);
    if (persona && persona.directChannelId !== where.parentId) throw new Error(`persona ${persona.id} may post only in its own direct channel`);
    const dept = org.dept(deptId);
    const footerLabel = persona ? `${dept?.name ?? deptId} · ${persona.name}` : undefined;
    const build = plain ? buildPlainMessage : buildMessage;
    let msgs = build(await outbound(p, where.channel.id), ctxFor(dept, { dept: deptId, ...(footerLabel ? { footerLabel } : {}), ...extra }));
    if (p.noHandles || (p.origin === 'governance' && p.type === 'task')) msgs = msgs.map((m) => defangMessage(m, p.noHandles === true)); // truncation and splitting run after the text pass
    return { persona, client, where, msgs };
  }

  // ---- Part B: messages edited in place -------------------------------------------------------------------------------
  const digests = new Map<string, string>(); // message id -> digest of what it shows; in memory (a restart costs one extra edit per card)
  const remember = (id: string, d: string) => {
    digests.delete(id);
    digests.set(id, d);
    if (digests.size > DIGESTS_MAX) digests.delete(digests.keys().next().value as string);
  };
  const digestOf = (m: OutboundMessage) => createHash('sha256').update(JSON.stringify({ c: m.content ?? null, e: m.embeds, k: m.components })).digest('hex');
  const tails = new Map<string, Promise<unknown>>();
  /** One upsert at a time per key, so two task.changed events cannot both see "no stored id" (TW15). */
  function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const result = (tails.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn);
    const tail = result.catch(() => undefined);
    tails.set(key, tail);
    void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
    return result;
  }
  const code = (e: unknown) => (e as { code?: unknown }).code;
  /** T8: a room board whose store write failed after the send: off until restart. */
  const disabledBoards = new Set<string>();

  /** Skips when the message already shows this digest; Unknown Message (10008) is 'gone'; any other error propagates. */
  async function editVia(id: string, m: OutboundMessage, doEdit: () => Promise<void>): Promise<'edited' | 'unchanged' | 'gone'> {
    const d = digestOf(m);
    if (digests.get(id) === d) return 'unchanged';
    try {
      await doEdit();
    } catch (e) {
      if (code(e) === UNKNOWN_MESSAGE) return 'gone';
      throw e;
    }
    remember(id, d);
    return 'edited';
  }

  /** TW17: only the client that posted the message edits it, and never pings. */
  async function editBot(client: Client, channel: SendableChannels, id: string, m: OutboundMessage): Promise<'edited' | 'unchanged' | 'gone'> {
    if (!('messages' in channel)) throw new Error('channel has no messages');
    const d = digestOf(m);
    if (digests.get(id) === d) return 'unchanged';
    return editVia(id, m, async () => {
      const msg = await channel.messages.fetch(id);
      if (msg.author.id !== client.user?.id) throw new Error(`message ${id} was not posted by this client`);
      await msg.edit({ ...(m.content !== undefined ? { content: m.content } : {}), embeds: m.embeds, components: m.components, allowedMentions: { parse: [] } });
    });
  }

  interface Poster {
    send(): Promise<string>;
    edit(id: string): Promise<'edited' | 'unchanged' | 'gone'>;
  }

  /**
   * Stored id: edit it. No stored id: send, then store it with a conditional UPDATE (TW15). Repost happens only when the edit
   * reports Unknown Message (10008), once; any other error propagates and the stored id stays.
   */
  async function upsertStored(taskId: string, kind: TaskMessageKind, m: OutboundMessage, poster: Poster): Promise<string> {
    const store = opts.taskMessages;
    if (!store) return poster.send();
    const stored = await store.messageId(taskId, kind);
    if (stored) {
      if ((await poster.edit(stored)) !== 'gone') return stored;
    }
    const id = await poster.send();
    remember(id, digestOf(m));
    const won = stored ? await store.replaceMessage(taskId, kind, stored, id) : await store.claimMessage(taskId, kind, id);
    if (won) return id;
    // Lost a race with another writer (the per-key serial lock makes this impossible inside one process): its message is the card.
    // This port never deletes messages (perm-apply static guard), so ours stays; the winner's is brought up to date.
    const winner = await store.messageId(taskId, kind);
    if (winner && winner !== id) await poster.edit(winner).catch(() => undefined);
    return winner ?? id;
  }

  const ctxFor = (dept: Department | null, extra: Partial<BuildContext> = {}): BuildContext => ({
    deptColor: dept?.color ?? 0x5865f2, adminRoleId: opts.adminRoleId, ...extra,
  });

  // ---- STREAM-1: live reply previews (Gate 1; the engine and its pacing are in discord/reply-stream.ts, every Discord write is here) ----------------
  const streamLog: StreamLogger = opts.log ?? { info: () => undefined, warn: () => undefined };
  const streamsByKey = new Map<string, number>();
  let streamsActive = 0;
  /** Text of a built message as defangMessage reads it. */
  const textOf = (m: OutboundMessage): string => [m.content ?? '', ...m.embeds.flatMap((e) => [e.title ?? '', e.description ?? '', e.footer?.text ?? '', ...(e.fields ?? []).flatMap((f) => [f.name, f.value])])].join('\n');

  function openStream(actor: ActorRef, target: { channelId: string; threadId?: string }, o: OpenReplyStreamOptions): ReplyStream | null {
    if ((o.mentionUserIds ?? []).length > 0) return null; // S9: a post that pings is never streamed
    const persona = actor.kind === 'persona' ? org.persona(actor.personaId) : null;
    if (actor.kind === 'persona' && (!persona || persona.directChannelId !== target.channelId)) return null; // post() would re-map it to its head
    const deptId = (persona ? persona.deptId : (actor as { dept: DeptId }).dept) as DeptId;
    const key = target.threadId ?? target.channelId;
    let ctx: Composed | undefined;
    const compose1 = async (p: OutboundPayload, plain: boolean): Promise<Composed> => (ctx = await compose(actor, target, p, {}, plain));
    let where: Resolved | undefined;
    const base = {
      halted: o.halted,
      secrets: () => opts.secrets ?? [], // S3: the live list (the Gemini key is pushed after decrypt), never a copy
      typingOk: !persona,
      now: () => Date.now(),
      typing: async () => {
        where ??= await resolve(clientOf(deptId), target.channelId, target.threadId); // S14: the denylist and the thread checks
        if ('sendTyping' in where.channel) await where.channel.sendTyping();
      },
    };
    const slot = streamsActive < STREAM_MAX_ACTIVE && (streamsByKey.get(key) ?? 0) < STREAM_PER_CHANNEL;
    if (!slot) return typingOnly<OutboundMessage>(base, { log: streamLog, onClose: () => undefined });
    streamsActive++;
    streamsByKey.set(key, (streamsByKey.get(key) ?? 0) + 1);
    const onClose = () => {
      streamsActive--;
      const n = (streamsByKey.get(key) ?? 1) - 1;
      if (n <= 0) streamsByKey.delete(key);
      else streamsByKey.set(key, n);
    };
    const io: StreamIO<OutboundMessage> = {
      ...base,
      // S4: every preview write goes through compose with noHandles (redaction, neutralise, defangHandles, the defangMessage throw); a throw skips the write
      preview: async (text) => (await compose1({ type: 'chat', body: text, noHandles: true }, true)).msgs[0]!,
      open: async (m) => {
        const c = ctx!;
        // RF12: a head's preview replies to the person's message (a snowflake only, never a ping, no error when it is gone); a persona webhook cannot reply
        if (!c.persona && o.replyToId && SNOWFLAKE.test(o.replyToId)) {
          m.reply = { messageReference: o.replyToId, failIfNotExists: false };
          m.allowedMentions = { parse: [], repliedUser: false };
        }
        if (c.persona) return webhooks.send(c.persona, c.client, c.where.parentId, c.where.threadId, [m]);
        return sendAll(c.where.channel, [m]);
      },
      write: async (id, m) => {
        const c = ctx!;
        const r = c.persona
          ? await editVia(id, m, () => webhooks.edit(c.persona!, c.client, c.where.parentId, c.where.threadId, id, m))
          : await editBot(c.client, c.where.channel, id, m);
        return r === 'gone' ? 'gone' : 'ok';
      },
      final: async (p): Promise<StreamBuilt<OutboundMessage>> => {
        const card = isCardPayload(p);
        const c = await compose1(p, !card);
        // S7/S8: an edit never routes or pings. A card, a `<@` mention or a literal handle in the answer goes out as a fresh post (an edit would silently drop the route)
        const text = c.msgs.map(textOf).join('\n');
        return { msgs: c.msgs, fresh: card || /<@/.test(text) || handlesIn(text).length > 0 };
      },
      fresh: (p, popts) => api.post(actor, target, p, popts),
      more: async (msgs, onSent) => {
        const c = ctx!;
        if (c.persona) await webhooks.send(c.persona, c.client, c.where.parentId, c.where.threadId, msgs, onSent);
        else await sendAll(c.where.channel, msgs, onSent);
      },
    };
    return new ReplyStreamEngine<OutboundMessage>(io, { log: streamLog, onClose, ...(o.canCreate ? { canCreate: o.canCreate } : {}) });
  }

  const api: DiscordPort = {
    openReplyStream: openStream,

    async post(actor, target, p, popts) {
      // Chat answers are plain content; only settings and requests to a person stay cards (owner rule, isCardPayload).
      const { persona, client, where, msgs } = await compose(actor, target, p, {}, !isCardPayload(p));
      // RF12: only the first message of a split answer replies, and a reply never pings its author (repliedUser:false is set in both branches below).
      const replying = !persona && !!popts?.replyToId && SNOWFLAKE.test(popts.replyToId) && !!msgs[0];
      if (replying) msgs[0]!.reply = { messageReference: popts!.replyToId!, failIfNotExists: false };
      const ids = (popts?.mentionUserIds ?? []).filter((id) => SNOWFLAKE.test(id));
      if (ids.length && msgs[0]) {
        const prefix = ids.map((id) => `<@${id}>`).join(' ');
        msgs[0].content = msgs[0].content ? `${prefix} ${msgs[0].content}`.slice(0, CONTENT_MAX) : prefix;
        msgs[0].allowedMentions = { parse: [], users: ids, ...(replying ? { repliedUser: false } : {}) };
      } else if (replying) msgs[0]!.allowedMentions = { ...msgs[0]!.allowedMentions, repliedUser: false };
      if (persona) return webhooks.send(persona, client, where.parentId, where.threadId, msgs, popts?.onSent);
      if (popts?.nonce && msgs[0]) msgs[0] = { ...msgs[0], nonce: popts.nonce, enforceNonce: true } as OutboundMessage;
      return sendAll(where.channel, msgs, popts?.onSent, p.spendOverrideId !== undefined || p.toolRequestId !== undefined || p.releaseCardId !== undefined || p.projectCardId !== undefined || p.projectBudgetId !== undefined);
    },

    async upsertTaskCard(task, actor, target, p, popts, editOnly) {
      const key = `card:${task.id}`;
      return serial(key, async () => {
        if (editOnly && !(await opts.taskMessages?.messageId(task.id, 'card'))) return null;
        const { persona, client, where, msgs } = await compose(actor, target, p, { status: task.status });
        const m = msgs[0]!; // the card is one message: a long description is cut by the embed limits, never split
        const fresh = async (): Promise<string> => {
          const ids = (popts?.mentionUserIds ?? []).filter((id) => SNOWFLAKE.test(id));
          const first = ids.length ? { ...m, content: ids.map((id) => `<@${id}>`).join(' '), allowedMentions: { parse: [], users: ids } } : m;
          if (persona) return webhooks.send(persona, client, where.parentId, where.threadId, [first], popts?.onSent);
          return sendAll(where.channel, [first], popts?.onSent);
        };
        return upsertStored(task.id, 'card', m, {
          send: fresh,
          edit: (id) => persona
            ? editVia(id, m, () => webhooks.edit(persona, client, where.parentId, where.threadId, id, m))
            : editBot(client, where.channel, id, m),
        });
      });
    },

    async upsertHandoff(task, actor, target, p, popts, editOnly) {
      return serial(`handoff:${task.id}`, async () => {
        if (editOnly && !(await opts.taskMessages?.messageId(task.id, 'handoff'))) return null;
        const { persona, client, where, msgs } = await compose(actor, target, { ...p, noHandles: true }, { status: task.status }, true);
        const m = msgs[0]!; // the handoff line is one short message
        return upsertStored(task.id, 'handoff', m, {
          send: () => (persona ? webhooks.send(persona, client, where.parentId, where.threadId, [m], popts?.onSent) : sendAll(where.channel, [m], popts?.onSent)),
          edit: (id) => persona
            ? editVia(id, m, () => webhooks.edit(persona, client, where.parentId, where.threadId, id, m))
            : editBot(client, where.channel, id, m),
        });
      });
    },

    async upsertRoomBoard(actor, channelId, p, popts) {
      const who = actor.kind === 'persona' ? org.persona(actor.personaId) : null;
      if (!who) throw new Error('a room board is posted by a persona');
      const key = roomBoardKey(who.id);
      if (disabledBoards.has(key)) return { pin: 'skipped' as const };
      return serial(`board:${key}`, async () => {
        const store = opts.boards;
        if (!store) throw new Error('no board store: the room board would repost every time');
        const { persona, client, where, msgs } = await compose(actor, { channelId }, { ...p, noHandles: true }, {}, true);
        if (msgs.length !== 1 || !persona) throw new Error('a room board is one message by a persona');
        const m = msgs[0]!;
        const digest = digestOf(m);
        const stored = await store.get(key);
        if (stored && stored.channelId === channelId) {
          if (stored.digest === digest) return { pin: 'skipped' as const };
          const r = await editVia(stored.messageId, m, () => webhooks.edit(persona, client, where.parentId, undefined, stored.messageId, m));
          if (r === 'edited') await store.setDigest(key, digest);
          if (r !== 'gone') return { pin: 'skipped' as const };
        }
        const id = await webhooks.send(persona, client, where.parentId, undefined, [m], popts?.onSent);
        remember(id, digest);
        try {
          await store.set(key, { channelId, messageId: id, digest });
        } catch (err) {
          disabledBoards.add(key); // the message exists but its id is not stored: another send on the next change would repost every time
          throw err;
        }
        try {
          if (!('messages' in where.channel)) return { pin: 'failed' as never };
          await where.channel.messages.pin(id); // the head client of the persona's department (compose resolved the channel with it)
          return { pin: 'ok' as const };
        } catch (e) {
          return { pin: PIN_CODES[(e as { code?: number }).code ?? -1] ?? 'missing_permission' };
        }
      });
    },

    async postFile(actor, target, p, file) {
      const persona = actor.kind === 'persona' ? org.persona(actor.personaId) : null;
      if (actor.kind === 'persona' && !persona) throw new Error(`unknown persona ${actor.personaId}`);
      const deptId = (persona ? persona.deptId : (actor as { dept: DeptId }).dept) as DeptId;
      const client = clientOf(deptId);
      const where = await resolve(client, target.channelId, target.threadId);
      const dept = org.dept(deptId);
      const footerLabel = persona ? `${dept?.name ?? deptId} · ${persona.name}` : undefined;
      const build = isCardPayload(p) ? buildMessage : buildPlainMessage;
      const msgs = build(await outbound(p, where.channel.id), ctxFor(dept, { dept: deptId, ...(footerLabel ? { footerLabel } : {}) }));
      // The file rides on the first message; allowedMentions stays empty (nothing in a file name or table can ping).
      // P24: a text-like file (CSV, JSON, text) is masked like any message text, and so is its name. Binary files are sent as they are.
      const textLike = /^(text\/|application\/(json|csv|xml))/i.test(file.contentType);
      const data = textLike ? Buffer.from(redactText(file.data.toString('utf8'), opts.secrets), 'utf8') : file.data;
      const first = { ...msgs[0]!, ...(file.nonce ? { nonce: file.nonce, enforceNonce: true } : {}), allowedMentions: { parse: [] }, files: [new AttachmentBuilder(data, { name: redactText(file.name, opts.secrets).replace(/[^A-Za-z0-9._-]/g, '_') })] };
      const id = (await where.channel.send(first)).id;
      for (const m of msgs.slice(1)) await where.channel.send(m);
      return id;
    },

    async dm(actor, userId, p) {
      const persona = actor.kind === 'persona' ? org.persona(actor.personaId) : null;
      const deptId = (persona ? persona.deptId : (actor as { dept: DeptId }).dept) as DeptId;
      let delivered = 0;
      try {
        const user = await clientOf(deptId).users.fetch(userId);
        for (const m of buildMessage(await outbound(p), ctxFor(org.dept(deptId), { dept: deptId }))) {
          await user.send({ embeds: m.embeds, allowedMentions: { parse: [] } });
          delivered++;
        }
        return 'sent';
      } catch {
        return delivered > 0 ? 'partial' : 'failed'; // closed DMs, blocked bot or unknown user: the caller falls back
      }
    },

    async createThread(dept, channelId, name) {
      const { channel } = await resolve(clientOf(dept), channelId);
      if (channel.isThread() || !('threads' in channel)) throw new Error(`channel ${channelId} cannot hold threads`);
      const thread = await channel.threads.create({ name: redactText(name, opts.secrets).slice(0, THREAD_NAME_MAX) });
      return thread.id;
    },

    async forumInfo(forumId) {
      try {
        const forum = await forumOf(clientOf('hq'), forumId);
        return { id: forum.id, name: forum.name, tags: forum.availableTags.map((t) => ({ id: t.id, name: t.name })) };
      } catch {
        return null;
      }
    },

    async listForumPosts(forumId, limit) {
      const forum = await forumOf(clientOf('hq'), forumId);
      const [active, archived] = await Promise.all([
        forum.threads.fetchActive(),
        forum.threads.fetchArchived({ limit: FORUM_SCAN_MAX }).catch(() => null),
      ]);
      const seen = new Map([...active.threads, ...(archived?.threads ?? [])]);
      const newest = [...seen.values()]
        .filter((t) => t.parentId === forum.id && !isDenied(t.id, t.parentId))
        .sort((a, b) => (b.createdTimestamp ?? 0) - (a.createdTimestamp ?? 0))
        .slice(0, Math.max(1, Math.min(FORUM_SCAN_MAX, Math.floor(limit))));
      const tagName = new Map(forum.availableTags.map((t) => [t.id, t.name]));
      const out: ForumPostSummary[] = [];
      for (const t of newest) {
        const starter = await t.fetchStarterMessage().catch(() => null);
        out.push({
          id: t.id, parentId: forum.id, name: t.name,
          tags: t.appliedTags.map((id) => tagName.get(id)).filter((n): n is string => !!n),
          first: starter ? starter.content.slice(0, FORUM_FIRST_MAX) : '',
          replies: Math.max(0, t.messageCount ?? 0),
        });
      }
      return out;
    },

    async readForumPost(postId, limit) {
      if (!SNOWFLAKE.test(postId)) return null;
      const hq = clientOf('hq');
      if (isDenied(postId, null)) throw new DeniedChannelError(postId);
      const t = await hq.channels.fetch(postId);
      if (!t || !t.isThread() || !t.parentId) return null;
      if (isDenied(t.id, t.parentId)) throw new DeniedChannelError(t.id);
      const forum = await forumOf(hq, t.parentId).catch(() => null);
      if (!forum) return null;
      const fetched = await t.messages.fetch({ limit: Math.max(1, Math.min(HISTORY_MAX, Math.floor(limit))), after: '0' });
      const byAge = [...fetched.values()].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      const tagName = new Map(forum.availableTags.map((x) => [x.id, x.name]));
      const messages: ForumPostRead['messages'] = [];
      for (const m of byAge) {
        const mapped = await opts.inbound(m);
        if (mapped) messages.push({ author: mapped.author.name, content: mapped.content, attachments: mapped.attachments.length });
      }
      return { id: t.id, parentId: forum.id, name: t.name, tags: t.appliedTags.map((id) => tagName.get(id)).filter((n): n is string => !!n), messages };
    },

    async createForumPost(dept, forumId, p, popts) {
      const client = clientOf(dept);
      const forum = await forumOf(client, forumId);
      const known = new Set(forum.availableTags.map((t) => t.id));
      if (p.tagIds.length > 5 || p.tagIds.some((id) => !known.has(id))) throw new Error('unknown forum tag');
      const msgs = buildMessage(await outbound({ type: 'chat', body: p.body }, forum.id), ctxFor(org.dept(dept), { dept }));
      const starter = msgs[0];
      if (!starter) throw new Error('empty post');
      const thread = await forum.threads.create({
        name: redactText(p.title, opts.secrets).slice(0, THREAD_NAME_MAX) || 'Post',
        message: { embeds: starter.embeds, allowedMentions: { parse: [] } },
        ...(p.tagIds.length ? { appliedTags: p.tagIds } : {}),
      });
      const ids = [thread.id];
      try {
        for (const m of msgs.slice(1)) ids.push((await thread.send(m)).id);
      } finally {
        popts?.onSent?.(ids);
      }
      return { postId: thread.id, messageId: thread.id };
    },

    async upsertTaskLog(task, extra) {
      await serial(`log:${task.id}`, async () => {
        const hq = clientOf('hq');
        const { channel } = await resolve(hq, TASK_LOG_CHANNEL_ID);
        const payload: OutboundPayload = {
          type: 'task',
          title: task.title,
          body: cardBody(task),
          fields: [
            { name: 'Status', value: task.status },
            ...(extra?.blockedBecause ? [{ name: 'Blocked because', value: extra.blockedBecause.slice(0, 300) }] : []),
            { name: 'Owner', value: label(task.owner) },
            { name: 'Dept', value: task.deptId },
            { name: 'Cost', value: `$${task.costUsd.toFixed(4)}` },
            { name: 'Task', value: task.id },
          ],
        };
        const m = buildMessage(await outbound(payload, TASK_LOG_CHANNEL_ID), ctxFor(org.dept(task.deptId), { status: task.status }))[0]!;
        await upsertStored(task.id, 'log', m, {
          send: () => sendAll(channel, [m]),
          edit: (id) => editBot(hq, channel, id, m),
        });
      });
    },

    async upsertBoard(key, p, channelId = TASK_LOG_CHANNEL_ID) {
      await serial(`board:${key}`, async () => {
        const hq = clientOf('hq');
        const { channel } = await resolve(hq, channelId);
        const m = buildMessage(await outbound(p, channelId), ctxFor(null))[0]!;
        const store = opts.boards;
        const stored = store ? await store.get(key) : null;
        if (stored && stored.channelId === channelId) {
          if (stored.digest === digestOf(m)) return;
          const r = await editBot(hq, channel, stored.messageId, m);
          if (r !== 'gone') {
            if (r === 'edited') await store!.setDigest(key, digestOf(m));
            return;
          }
        }
        const id = await sendAll(channel, [m]);
        remember(id, digestOf(m));
        if (!store) return;
        await store.set(key, { channelId, messageId: id, digest: digestOf(m) });
        try {
          await (await channel.messages.fetch(id)).pin(); // once: only when the board message is new; a pin failure leaves the board unpinned
        } catch {
          /* missing Pin Messages or the 50-pin limit: the board still works */
        }
      });
    },

    async logDirect(from, to, text) {
      const { channel } = await resolve(clientOf('hq'), DIRECT_LOG_CHANNEL_ID);
      const line = redactText(`${label(from)} → ${label(to)}: ${text.replace(/\s+/g, ' ').trim()}`, opts.secrets).slice(0, CONTENT_MAX);
      await channel.send({ content: line, allowedMentions: { parse: [] } });
    },

    async history(channelOrThreadId, limit, reader) {
      // Gate 1 S29: #🧾-bot-log carries copies of AutoMod-flagged user messages; it never enters any model context.
      if (channelOrThreadId === BOT_LOG_CHANNEL_ID || opts.postOnly?.().includes(channelOrThreadId)) return [];
      const { channel, parentId } = await resolve(clientOf(readerDept(reader)), channelOrThreadId);
      if (parentId === BOT_LOG_CHANNEL_ID) return []; // HIST-1-G2: a thread under #bot-log is excluded too
      if (opts.postOnly && ((channel as { parentId?: string | null }).parentId ?? null) !== null && opts.postOnly().includes((channel as { parentId: string }).parentId)) return [];
      if (!('messages' in channel)) return [];
      const fetched = await channel.messages.fetch({ limit: Math.max(1, Math.min(HISTORY_MAX, Math.floor(limit))) });
      const out: IncomingMessage[] = [];
      for (const m of [...fetched.values()].reverse()) {
        const mapped = await opts.inbound(m);
        if (mapped) out.push(mapped);
      }
      return out;
    },

    async canMemberView(userId, channelId) {
      if (isDenied(channelId, null)) return false;
      try {
        const guild = clientOf('hq').guilds.cache.get(opts.guildId);
        if (!guild) return false;
        const [channel, member] = await Promise.all([guild.channels.fetch(channelId), guild.members.fetch(userId)]);
        return channel?.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel) === true;
      } catch {
        return false;
      }
    },

    async canMemberPost(userId, channelId) {
      if (!SNOWFLAKE.test(channelId) || !SNOWFLAKE.test(userId) || isDenied(channelId, null)) return false;
      try {
        const guild = clientOf('hq').guilds.cache.get(opts.guildId);
        if (!guild) return false;
        const [channel, member] = await Promise.all([guild.channels.fetch(channelId), guild.members.fetch(userId)]);
        const perms = channel?.permissionsFor(member);
        return perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.SendMessagesInThreads]) === true;
      } catch {
        return false;
      }
    },

    async botCanWork(dept, id) {
      try {
        if (!SNOWFLAKE.test(id) || isExcludedChannel(id, null)) return 'no';
        const client = cm.client(dept);
        if (!client) return 'unknown'; // offline: transient, keep today's routing
        let ch: Awaited<ReturnType<typeof client.channels.fetch>>;
        try {
          ch = await client.channels.fetch(id);
        } catch (err) {
          const c = codeOf(err);
          return c !== undefined && DEFINITE_NO.includes(c) ? 'no' : 'unknown';
        }
        if (!ch) return 'unknown';
        if (ch.isDMBased() || !('guildId' in ch) || ch.guildId !== opts.guildId) return 'no';
        if (isExcludedChannel(ch.id, ch.isThread() ? ch.parentId : null)) return 'no';
        const guild = client.guilds.cache.get(opts.guildId);
        const me = guild?.members.me ?? (await guild?.members.fetchMe());
        if (!me) return 'unknown';
        const perms = (ch as { permissionsFor(m: unknown): { has(b: bigint | bigint[]): boolean } | null }).permissionsFor(me);
        if (!perms) return 'no';
        if (ch.isThread()) {
          if (!perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessagesInThreads])) return 'no';
          const manage = perms.has(PermissionFlagsBits.ManageThreads);
          if ((ch.locked || ch.archived) && !manage) return 'no';
          if (ch.type === ChannelType.PrivateThread && !manage) {
            try {
              await ch.members.fetch(me.id);
            } catch (err) {
              const c = codeOf(err);
              return c !== undefined && [...DEFINITE_NO, ...NOT_A_MEMBER].includes(c) ? 'no' : 'unknown';
            }
          }
          return 'yes';
        }
        if (!ch.isTextBased()) return 'no'; // a forum or a category has no messages of its own; text, announcement and voice-text channels are checked by permission
        return perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]) ? 'yes' : 'no';
      } catch {
        return 'unknown'; // anything unforeseen is not a definite answer: today's routing stays
      }
    },

    async fetchMessage(channelId, messageId, reader) {
      try {
        if (!SNOWFLAKE.test(channelId) || !SNOWFLAKE.test(messageId) || isDenied(channelId, null)) return null;
        const { channel } = await resolve(clientOf(readerDept(reader)), channelId);
        if (!('messages' in channel)) return null;
        return await opts.inbound(await channel.messages.fetch(messageId));
      } catch {
        return null;
      }
    },

    async sourceFacts(channelId) {
      try {
        if (!SNOWFLAKE.test(channelId)) return null;
        const ch = await clientOf('hq').channels.fetch(channelId);
        if (!ch || ch.isDMBased() || !('guildId' in ch) || ch.guildId !== opts.guildId) return null;
        if (ch.isThread()) return { parentId: ch.parentId, categoryId: ch.parent?.parentId ?? null, privateThread: ch.type === ChannelType.PrivateThread };
        return { parentId: null, categoryId: ch.parentId, privateThread: false };
      } catch {
        return null;
      }
    },

    async channelIsPublic(channelId) {
      try {
        const hq = clientOf('hq');
        const guild = hq.guilds.cache.get(opts.guildId);
        const ch = await hq.channels.fetch(channelId);
        if (!guild || !ch || ch.isDMBased() || !('permissionsFor' in ch)) return false;
        if (ch.isThread() && ch.type !== ChannelType.PublicThread && ch.type !== ChannelType.AnnouncementThread) return false; // G2RF-02: a private thread is never public
        return (ch as { permissionsFor(r: unknown): { has(b: bigint): boolean } | null }).permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel) === true;
      } catch {
        return false;
      }
    },

    async channelIsPrivate(channelId) {
      try {
        const ch = await clientOf('hq').channels.fetch(channelId);
        if (!ch || ch.isThread() || ch.isDMBased() || ch.type !== ChannelType.GuildText) return false;
        const bots = [...(opts.botUserIds?.().keys() ?? [])];
        // G2LF-01: an allow list, not just "@everyone denied": owner, Bot Admin, the bot-only roles, managed roles of our own bots, and our bots as members.
        const roleIds = [...PRIVILEGED_ROLE_IDS, ...WARROOM_BOT_ROLE_IDS, opts.adminRoleId];
        const guild = clientOf('hq').guilds.cache.get(opts.guildId);
        const overwrites = [...ch.permissionOverwrites.cache.values()].map((o) => ({ id: o.id, type: o.type as number, allow: o.allow.bitfield, deny: o.deny.bitfield }));
        for (const o of overwrites) {
          const botId = o.type === 0 ? (guild?.roles.cache.get(o.id) as { tags?: { botId?: string } } | undefined)?.tags?.botId : undefined;
          if (botId && bots.includes(botId)) roleIds.push(o.id);
        }
        return roomOverwriteProblem(overwrites, opts.guildId, { roleIds, userIds: bots }) === null;
      } catch {
        return false;
      }
    },

    async botCanView(dept, channelId) {
      for (const [id, d] of opts.botUserIds?.() ?? []) if (d === dept) return botCanViewId(id, channelId);
      return false;
    },

    async categoryOf(channelId) {
      try {
        if (!SNOWFLAKE.test(channelId)) return null;
        const hq = clientOf('hq');
        const ch = await hq.channels.fetch(channelId);
        if (!ch || ch.isThread() || ch.isDMBased() || ch.type === ChannelType.GuildCategory) return null; // callers pass the channel a message was posted in (a thread's parent)
        if (isExcludedChannel(ch.id, null) || !ch.parentId) return null;
        const cat = await hq.channels.fetch(ch.parentId);
        if (!cat || cat.type !== ChannelType.GuildCategory || DENIED_CATEGORY_IDS.includes(cat.id) || isDenied(cat.id, null)) return null;
        return cat.id;
      } catch {
        return null;
      }
    },

    async canStartThread(dept, channelId) {
      try {
        if (!SNOWFLAKE.test(channelId) || isExcludedChannel(channelId, null)) return false;
        const client = clientOf(dept);
        const ch = await client.channels.fetch(channelId);
        if (!ch || ch.type !== ChannelType.GuildText || ch.parentId === null || DENIED_CATEGORY_IDS.includes(ch.parentId)) return false;
        const guild = client.guilds.cache.get(opts.guildId);
        const me = guild?.members.me ?? (await guild?.members.fetchMe());
        if (!me) return false;
        return ch.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.CreatePublicThreads]) === true;
      } catch {
        return false;
      }
    },

    async approvalRoomProblem(channelId, categoryId, allow) {
      try {
        if (!SNOWFLAKE.test(channelId) || !SNOWFLAKE.test(categoryId)) return 'not a channel id';
        const hq = clientOf('hq');
        const ch = await hq.channels.fetch(channelId);
        if (!ch || ch.type !== ChannelType.GuildText) return 'not a text channel';
        if (ch.parentId !== categoryId) return 'not in that category';
        const overwrites = [...ch.permissionOverwrites.cache.values()].map((o) => ({ id: o.id, type: o.type as number, allow: o.allow.bitfield, deny: o.deny.bitfield }));
        return roomOverwriteProblem(overwrites, opts.guildId, allow);
      } catch {
        return 'the room could not be read';
      }
    },

    async pin(actor, channelId, messageId) {
      if (!SNOWFLAKE.test(messageId)) throw new Error('invalid message id');
      const persona = actor.kind === 'persona' ? org.persona(actor.personaId) : null;
      const deptId = (persona ? persona.deptId : (actor as { dept: DeptId }).dept) as DeptId;
      const { channel } = await resolve(clientOf(deptId), channelId);
      if (!('messages' in channel)) throw new Error(`channel ${channelId} has no messages`);
      try {
        await channel.messages.pin(messageId);
      } catch (e) {
        const failure = PIN_CODES[(e as { code?: number }).code ?? -1];
        throw failure ? new PinError(failure) : e;
      }
    },

    async closeCard(channelId, messageId, note, revoke) {
      const { channel } = await resolve(clientOf('hq'), channelId);
      if (!('messages' in channel)) return;
      try {
        const msg = await channel.messages.fetch(messageId);
        if (msg.author.id !== clientOf('hq').user?.id) return; // only the hq client's own card
        await msg.edit({ content: redactText(note, opts.secrets).slice(0, CONTENT_MAX), components: revoke === undefined ? [] : [typeof revoke === 'number' ? revokeRow(revoke) : taskRevokeRow(revoke.task)], allowedMentions: { parse: [] } });
      } catch (e) {
        if ((e as { code?: number }).code !== 10008) throw e; // Unknown Message: already gone
      }
    },

    async noteCard(channelId, messageId, note) {
      const { channel } = await resolve(clientOf('hq'), channelId);
      if (!('messages' in channel)) return;
      try {
        const msg = await channel.messages.fetch(messageId);
        if (msg.author.id !== clientOf('hq').user?.id) return; // only the hq client's own card
        await msg.edit({ content: redactText(note, opts.secrets).slice(0, CONTENT_MAX), allowedMentions: { parse: [] } });
      } catch (e) {
        if ((e as { code?: number }).code !== 10008) throw e; // Unknown Message: already gone
      }
    },

    async updateCard(channelId, messageId, payload) {
      const { channel } = await resolve(clientOf('hq'), channelId);
      if (!('messages' in channel)) return false;
      const msgs = buildMessage(await outbound(payload, channelId), ctxFor(org.dept('hq'), { dept: 'hq' }));
      if (msgs.length !== 1 || msgs[0]!.embeds.length > 1) throw new Error('a batch card must render as one message with one embed');
      const m = msgs[0]!;
      try {
        const msg = await channel.messages.fetch(messageId);
        if (msg.author.id !== clientOf('hq').user?.id) return false; // only the hq client's own card
        await msg.edit({ content: m.content ?? '', embeds: m.embeds, components: m.components, allowedMentions: { parse: [] } });
        return true;
      } catch (e) {
        if ((e as { code?: number }).code === 10008) return false; // Unknown Message: already gone
        throw e;
      }
    },

    async listGuildChannels() {
      const guild = clientOf('hq').guilds.cache.get(opts.guildId);
      if (!guild) throw new Error(`guild ${opts.guildId} not cached`);
      return [...guild.channels.cache.values()]
        .filter((c) => !isDenied(c.id, c.parentId))
        .map((c) => ({ id: c.id, name: c.name, parentId: c.parentId, type: c.type }));
    },
  };
  return api;
}
