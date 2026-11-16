import type { OutboundPayload } from '../../agents/loop/payload.js';
import type { ActorRef, GuildChannelInfo, IncomingMessage } from '../../company/types.js';
import { isDenied } from '../../company/denylist.js';
import type { DeptId } from '../../core/index.js';
import type { Task } from '../../db/repos/index.js';
import { DeniedChannelError, PinError, type BotAccess, type DiscordPort, type DmResult, type ForumInfo, type ForumPostRead, type ForumPostSummary, type PostOptions } from '../../discord/port.js';

/** Records every call; ids are `msg-1`, `thread-1`, ... Enforces the denylist like the real port. */
export class FakeDiscordPort implements DiscordPort {
  posts: { actor: ActorRef; target: { channelId: string; threadId?: string }; payload: OutboundPayload; id: string; opts?: PostOptions }[] = [];
  /** Every postFile() call (Task 33). */
  files: { actor: ActorRef; target: { channelId: string; threadId?: string }; payload: OutboundPayload; file: { name: string; data: Buffer; contentType: string }; id: string }[] = [];
  /** Every dm() call. */
  dms: { actor: ActorRef; userId: string; payload: OutboundPayload }[] = [];
  /** What dm() returns (false = the user's DMs are closed); `throw` makes it throw. */
  dmResult: boolean | 'partial' | 'throw' = true;
  threads: { dept: DeptId; channelId: string; name: string; id: string }[] = [];
  tasks: Task[] = [];
  directs: { from: ActorRef; to: ActorRef; text: string }[] = [];
  /** Preset history per channel/thread id, oldest first. */
  historyById = new Map<string, IncomingMessage[]>();
  channels: GuildChannelInfo[] = [];
  /** When set, every post throws this. */
  failPost: Error | null = null;
  /** `${userId}|${channelId}` -> can the member view the channel; unset entries are visible. */
  view = new Map<string, boolean>();
  /** Channels reported as hidden from @everyone; every channel is private unless listed here as false. */
  privateChannel = new Map<string, boolean>();
  async channelIsPrivate(channelId: string): Promise<boolean> {
    return this.privateChannel.get(channelId) ?? true;
  }
  /** RF4: messages fetchMessage() finds, by `${channelId}|${messageId}`; anything else is null (gone). */
  fetchable = new Map<string, IncomingMessage>();
  fetchReaders: { channelId: string; reader: ActorRef }[] = [];
  async fetchMessage(channelId: string, messageId: string, reader: ActorRef): Promise<IncomingMessage | null> {
    this.fetchReaders.push({ channelId, reader });
    return this.fetchable.get(`${channelId}|${messageId}`) ?? null;
  }
  /** RF7: what sourceFacts() reports per channel id; unset = unknown (null). */
  sourceInfo = new Map<string, { parentId: string | null; categoryId: string | null; privateThread: boolean }>();
  async sourceFacts(channelId: string): Promise<{ parentId: string | null; categoryId: string | null; privateThread: boolean } | null> {
    return this.sourceInfo.get(channelId) ?? null;
  }
  /** RF11: channels @everyone can view; unset = not public. */
  publicChannel = new Map<string, boolean>();
  async channelIsPublic(channelId: string): Promise<boolean> {
    return this.publicChannel.get(channelId) ?? false;
  }
  /** When true, message ids are snowflakes (as Discord's); otherwise `msg-N`. */
  snowflakes = false;
  /** `${dept}|${channelId}` -> can the department's bot view the channel; unset entries are visible. */
  botView = new Map<string, boolean>();
  async botCanView(dept: DeptId, channelId: string): Promise<boolean> {
    return this.botView.get(`${dept}|${channelId}`) ?? true;
  }
  /** messageId -> the channel or thread it lives in; pin() only finds a message in its own channel. */
  messages = new Map<string, string>();
  /** Channels where the bot lacks Pin Messages. */
  pinDenied = new Set<string>();
  pins: { actor: ActorRef; channelId: string; messageId: string }[] = [];
  /** Every closeCard() call (admin console cards). */
  closed: { channelId: string; messageId: string; note: string }[] = [];
  private n = 0;

  /** WS8: channel id -> the problem approvalRoomProblem reports; unset = fine. */
  roomProblems = new Map<string, string>();
  async approvalRoomProblem(channelId: string, _categoryId: string, _allow: { roleIds: readonly string[]; userIds: readonly string[] }): Promise<string | null> {
    return this.roomProblems.get(channelId) ?? null;
  }

  async closeCard(channelId: string, messageId: string, note: string): Promise<void> {
    this.closed.push({ channelId, messageId, note });
  }

  /** Every updateCard() call (batched approval cards re-rendered in place). */
  updated: { channelId: string; messageId: string; payload: OutboundPayload }[] = [];
  /** Message ids updateCard() reports as gone. */
  goneCards = new Set<string>();
  async updateCard(channelId: string, messageId: string, payload: OutboundPayload): Promise<boolean> {
    if (this.goneCards.has(messageId)) return false;
    this.updated.push({ channelId, messageId, payload });
    return true;
  }

  async pin(actor: ActorRef, channelId: string, messageId: string): Promise<void> {
    if (isDenied(channelId, null)) throw new DeniedChannelError(channelId);
    if (this.pinDenied.has(channelId)) throw new PinError('missing_permission');
    if (this.messages.get(messageId) !== channelId) throw new PinError('unknown_message');
    this.pins.push({ actor, channelId, messageId });
  }

  async post(actor: ActorRef, target: { channelId: string; threadId?: string }, payload: OutboundPayload, opts?: PostOptions): Promise<string> {
    if (isDenied(target.channelId, null) || (target.threadId && isDenied(target.threadId, target.channelId))) throw new DeniedChannelError(target.channelId);
    if (this.failPost) throw this.failPost;
    const id = this.snowflakes ? String(1570000000000000000n + BigInt(++this.n)) : `msg-${++this.n}`;
    this.posts.push({ actor, target, payload, id, ...(opts ? { opts } : {}) });
    return id;
  }

  async postFile(actor: ActorRef, target: { channelId: string; threadId?: string }, payload: OutboundPayload, file: { name: string; data: Buffer; contentType: string }): Promise<string> {
    if (isDenied(target.channelId, null) || (target.threadId && isDenied(target.threadId, target.channelId))) throw new DeniedChannelError(target.channelId);
    if (this.failPost) throw this.failPost;
    const id = `msg-${++this.n}`;
    this.files.push({ actor, target, payload, file, id });
    return id;
  }

  async dm(actor: ActorRef, userId: string, payload: OutboundPayload): Promise<DmResult> {
    if (this.dmResult === 'throw') throw new Error('Cannot send messages to this user');
    if (this.dmResult) this.dms.push({ actor, userId, payload });
    return this.dmResult === true ? 'sent' : this.dmResult === 'partial' ? 'partial' : 'failed';
  }

  async createThread(dept: DeptId, channelId: string, name: string): Promise<string> {
    if (isDenied(channelId, null)) throw new DeniedChannelError(channelId);
    const id = this.snowflakes ? String(1570000000000009000n + BigInt(this.threads.length + 1)) : `thread-${this.threads.length + 1}`; // snowflake ids give valid message links
    this.threads.push({ dept, channelId, name, id });
    return id;
  }

  /** Forums by id; unknown ids are not forums (forumInfo -> null). */
  forums = new Map<string, ForumInfo>();
  /** Posts per forum id (newest first) and the full messages per post id. */
  forumPosts = new Map<string, ForumPostSummary[]>();
  forumMessages = new Map<string, ForumPostRead['messages']>();
  /** Every createForumPost() call. */
  forumCreated: { dept: DeptId; forumId: string; title: string; body: string; tagIds: string[]; postId: string }[] = [];
  /** When set, createForumPost throws it. */
  failForum: Error | null = null;

  async forumInfo(forumId: string): Promise<ForumInfo | null> {
    if (isDenied(forumId, null)) return null;
    return this.forums.get(forumId) ?? null;
  }

  async listForumPosts(forumId: string, limit: number): Promise<ForumPostSummary[]> {
    if (isDenied(forumId, null)) throw new DeniedChannelError(forumId);
    return (this.forumPosts.get(forumId) ?? []).filter((p) => !isDenied(p.id, p.parentId)).slice(0, limit);
  }

  async readForumPost(postId: string, _limit: number): Promise<ForumPostRead | null> {
    for (const [forumId, posts] of this.forumPosts) {
      const p = posts.find((x) => x.id === postId);
      if (!p) continue;
      if (isDenied(postId, forumId)) throw new DeniedChannelError(postId);
      return { id: p.id, parentId: forumId, name: p.name, tags: p.tags, messages: this.forumMessages.get(postId) ?? [] };
    }
    return null;
  }

  async createForumPost(dept: DeptId, forumId: string, p: { title: string; body: string; tagIds: string[] }, opts?: Pick<PostOptions, 'onSent'>): Promise<{ postId: string; messageId: string }> {
    if (isDenied(forumId, null)) throw new DeniedChannelError(forumId);
    if (this.failForum) throw this.failForum;
    const forum = this.forums.get(forumId);
    if (!forum) throw new Error(`channel ${forumId} is not a forum`);
    if (p.tagIds.some((t) => !forum.tags.some((x) => x.id === t))) throw new Error('unknown forum tag');
    const postId = `post-${this.forumCreated.length + 1}`;
    this.forumCreated.push({ dept, forumId, ...p, postId });
    opts?.onSent?.([postId]);
    return { postId, messageId: postId };
  }

  /** TASKADMIN-1: the `blockedBecause` extras the scheduler handed to upsertTaskLog (only calls that had one). */
  taskLogExtras: { taskId: string; blockedBecause?: string }[] = [];
  async upsertTaskLog(task: Task, extra?: { blockedBecause?: string }): Promise<void> {
    this.tasks.push(task);
    if (extra?.blockedBecause) this.taskLogExtras.push({ taskId: task.id, blockedBecause: extra.blockedBecause });
  }

  /** taskId -> id of the thread card; the first call posts it (via post()), later calls edit it in place. */
  cardIds = new Map<string, string>();
  cardEdits: { taskId: string; id: string; status: Task['status']; payload: OutboundPayload }[] = [];

  async upsertTaskCard(task: Pick<Task, 'id' | 'status'>, actor: ActorRef, target: { channelId: string; threadId?: string }, payload: OutboundPayload, opts?: PostOptions, editOnly?: boolean): Promise<string | null> {
    const known = this.cardIds.get(task.id);
    if (!known && editOnly) return null;
    if (known) {
      this.cardEdits.push({ taskId: task.id, id: known, status: task.status, payload });
      return known;
    }
    const id = await this.post(actor, target, payload, opts);
    this.cardIds.set(task.id, id);
    return id;
  }

  /** TEAMTALK-1 H1: taskId -> id of the handoff line; the first (non edit-only) call posts it through post() (counted like any Discord send), later calls edit it. */
  handoffIds = new Map<string, string>();
  /** Called with (taskId, messageId) when a handoff line is first sent (the real store writes tasks.handoff_message_id). */
  onHandoff?: (taskId: string, messageId: string) => void;
  handoffEdits: { taskId: string; id: string; status: Task['status']; payload: OutboundPayload }[] = [];
  async upsertHandoff(task: Pick<Task, 'id' | 'status'>, actor: ActorRef, target: { channelId: string; threadId?: string }, payload: OutboundPayload, opts?: Pick<PostOptions, 'onSent'>, editOnly?: boolean): Promise<string | null> {
    const known = this.handoffIds.get(task.id);
    if (!known && editOnly) return null;
    if (known) {
      this.handoffEdits.push({ taskId: task.id, id: known, status: task.status, payload: { ...payload, noHandles: true } });
      return known;
    }
    const id = await this.post(actor, target, { ...payload, noHandles: true }, opts);
    this.handoffIds.set(task.id, id);
    this.onHandoff?.(task.id, id);
    return id;
  }

  /** TEAMTALK-1: persona id -> the room board (first call "sends", later calls edit); `onSent` gets the id of every send. */
  roomBoardSends: { actor: ActorRef; channelId: string; payload: OutboundPayload; id: string }[] = [];
  roomBoardEdits: { personaId: string; id: string; payload: OutboundPayload }[] = [];
  private readonly roomBoardIds = new Map<string, string>();
  /** What the next upsertRoomBoard reports about the pin; `throw` makes it reject. */
  roomBoardPin: 'ok' | 'missing_permission' | 'pin_limit' | 'unknown_message' | 'throw' = 'ok';
  async upsertRoomBoard(actor: ActorRef, channelId: string, payload: OutboundPayload, opts?: Pick<PostOptions, 'onSent'>): Promise<{ pin: 'ok' | 'skipped' | 'missing_permission' | 'pin_limit' | 'unknown_message' }> {
    if (actor.kind !== 'persona') throw new Error('a room board is posted by a persona');
    if (this.roomBoardPin === 'throw') throw new Error('board failed');
    const known = this.roomBoardIds.get(actor.personaId);
    if (known) {
      this.roomBoardEdits.push({ personaId: actor.personaId, id: known, payload: { ...payload, noHandles: true } });
      return { pin: 'skipped' };
    }
    const id = String(1570000000000000000n + BigInt(++this.n) + 5000n);
    this.roomBoardIds.set(actor.personaId, id);
    this.roomBoardSends.push({ actor, channelId, payload: { ...payload, noHandles: true }, id });
    opts?.onSent?.([id]);
    return { pin: this.roomBoardPin };
  }

  /** key -> every payload the board was upserted with, oldest first. */
  boards = new Map<string, OutboundPayload[]>();

  /** key -> the channel of its latest upsert (undefined = the default board channel, #📋-tasks). */
  boardChannels = new Map<string, string | undefined>();

  async upsertBoard(key: string, payload: OutboundPayload, channelId?: string): Promise<void> {
    this.boardChannels.set(key, channelId);
    this.boards.set(key, [...(this.boards.get(key) ?? []), payload]);
  }

  async logDirect(from: ActorRef, to: ActorRef, text: string): Promise<void> {
    this.directs.push({ from, to, text });
  }

  /** HIST-1: who each history() call read as (undefined = hq fallback), and a channel id -> error code to throw (e.g. 50001). */
  historyReaders: { channelId: string; reader: ActorRef }[] = [];
  historyErrors = new Map<string, number>();

  async history(channelOrThreadId: string, limit: number, reader: ActorRef): Promise<IncomingMessage[]> {
    this.historyReaders.push({ channelId: channelOrThreadId, reader });
    const code = this.historyErrors.get(channelOrThreadId);
    if (code !== undefined) throw Object.assign(new Error('Missing Access'), { code });
    if (isDenied(channelOrThreadId, null)) throw new DeniedChannelError(channelOrThreadId);
    return (this.historyById.get(channelOrThreadId) ?? []).slice(-limit);
  }

  async canMemberView(userId: string, channelId: string): Promise<boolean> {
    return this.view.get(`${userId}|${channelId}`) ?? true;
  }

  /** REROUTE-1: `${userId}|${channelId}` -> can the member post in the channel; unset entries can. */
  memberPost = new Map<string, boolean>();
  async canMemberPost(userId: string, channelId: string): Promise<boolean> {
    return this.memberPost.get(`${userId}|${channelId}`) ?? true;
  }
  /** REROUTE-1: `${dept}|${channelOrThreadId}` entries that answer `no` / `unknown` from botCanWork; everything else is `yes`. Every call is recorded. */
  workDenied = new Set<string>();
  workUnknown = new Set<string>();
  workCalls: { dept: DeptId; id: string }[] = [];
  async botCanWork(dept: DeptId, id: string): Promise<BotAccess> {
    this.workCalls.push({ dept, id });
    const k = `${dept}|${id}`;
    return this.workDenied.has(k) ? 'no' : this.workUnknown.has(k) ? 'unknown' : 'yes';
  }

  /** WS6: channel id -> category id (unset = no category). Test knob for categoryOf. */
  categories = new Map<string, string>();
  /** WS6: channels where the bot lacks View/Send/Create Public Threads (test knob for canStartThread); a channel in `startable` only is allowed when that set is non-empty. */
  noStart = new Set<string>();
  async categoryOf(channelId: string): Promise<string | null> {
    return isDenied(channelId, null) ? null : this.categories.get(channelId) ?? null;
  }
  async canStartThread(_dept: DeptId, channelId: string): Promise<boolean> {
    return !isDenied(channelId, null) && !this.noStart.has(channelId);
  }

  async listGuildChannels(): Promise<GuildChannelInfo[]> {
    return this.channels.filter((c) => !isDenied(c.id, c.parentId));
  }
}
