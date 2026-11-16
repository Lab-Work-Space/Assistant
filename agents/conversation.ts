import { randomUUID } from 'node:crypto';
import { KeyedLock } from './scheduler/jobs.js';
import type { ActorRef, IncomingMessage } from '../company/types.js';
import type { AppEvents, EventBus } from '../core/events.js';
import type { Task, TaskRepo } from '../db/repos/tasks.js';
import type { DiscordPort } from '../discord/port.js';
import type { Limits } from '../governance/limits.js';
import { goalTask, threadName } from './scheduler/notices.js';

/**
 * R2: the root task that gives a delegation from Praw's plain chat a parent, so reports roll back to the human.
 * Work-style 1b / Gate 1 WS13: the same for a department head that a person's message routes to (`mention`, `dept_channel`, `goal_channel`):
 * `threadId` is the message's thread, or the channel itself for a top-level message (the conversation then lives in the channel and the
 * roll-up replies to the stored message id). At most one open conversation per (head, person, thread or channel).
 */
export interface Conversation {
  /** `tainted`: the opening run's taint, which the new task starts with (default by origin). `reason`: how the message routed (heads only open for the three human routes). */
  open(a: { actor: ActorRef; msg: IncomingMessage; tainted?: boolean; reason?: string }): Promise<Task>;
  /**
   * REROUTE-1 (RR-C4): runs `fn` while no other open or adopt of the same (head, person, thread or channel) runs. `open` and `adopt` use the same key.
   * Not re-entrant: `fn` may call `adopt` (which does not lock) but never `open`. Only database work belongs inside; Discord reads happen before.
   */
  exclusive?<T>(key: { dept: string; userId: string; where: string }, fn: () => Promise<T>): Promise<T>;
  /**
   * REROUTE-1: opens the conversation task of a head for a person's message the head itself answered in a top-level channel (the CEO's reply that mentions
   * another head). Code-made: status `doing`, thread id = the channel, origin chat, requester the person. `originMessageId` is the person's message the roll-up
   * replies to (already verified by the caller). The caller holds `exclusive` for the key and has checked the open-task limit for two tasks.
   */
  adopt?(a: { actor: Extract<ActorRef, { kind: 'head' }>; userId: string; channelId: string; originMessageId: string | null; tainted: boolean; categoryId: string | null }): Promise<Task>;
}

export type ConversationDeps = {
  tasks: Pick<TaskRepo, 'create'> & Partial<Pick<TaskRepo, 'findOpenConversation' | 'update'>>;
  port: Pick<DiscordPort, 'createThread'> & Partial<Pick<DiscordPort, 'categoryOf'>>;
  limits: Pick<Limits, 'checkOpenTasks'>;
  bus: EventBus<AppEvents>;
  /**
   * Hook for the Praw per-user run counter (R8, `limits.prawPerUser10Min`): called with the human's id, false refuses.
   * The triggering message's slot (Scheduler.admit) is the P3 charge; wired to the non-consuming `PrawRateLimit.within`, so this is only a re-check. Entry points that skip admit() must call `take()`.
   */
  userSlot?: (userId: string) => boolean;
};

const praw = (a: ActorRef): boolean => a.kind === 'head' && a.dept === 'praw';

/** WS13: how a person's message must have routed to a head for it to open a conversation task. Never a bot author, warroom run, meeting or daily run. */
export const HEAD_CONVERSATION_REASONS: readonly string[] = ['mention', 'reply', 'dept_channel', 'goal_channel'];

/** WS13: a top-level conversation lives in the channel itself (thread id = channel id); a Discord thread id never equals a channel id. */
export const isTopLevelConversation = (t: Pick<Task, 'threadId' | 'channelId'>): boolean => t.threadId !== null && t.threadId === t.channelId;

/** REROUTE-1: the adopted conversation's title is fixed code text: no message text reaches it. */
const ADOPTED_TITLE = 'Conversation (mention reroute)';

const VOICE_GOAL = { title: 'Voice request', description: 'A request spoken in Praw\'s voice chat. The spoken words are not stored (P20).' };

/** Created by code, never by the model: origin is the trigger's own origin (chat | slash | voice), requester the human. */
export function createConversation(d: ConversationDeps): Conversation {
  const opening = new Map<string, Promise<Task>>(); // one open per (head, person, where) even when two runs race
  const serial = new KeyedLock(); // RR-C4: open and adopt share one critical section per (head, person, where)
  const keyOf = (k: { dept: string; userId: string; where: string }): string => `${k.dept}|${k.userId}|${k.where}`;
  const category = (msg: IncomingMessage): Promise<string | null> =>
    msg.origin === 'voice' || !d.port.categoryOf ? Promise.resolve(null) : d.port.categoryOf(msg.parentChannelId ?? msg.channelId).catch(() => null);

  async function openHead(actor: Extract<ActorRef, { kind: 'head' }>, msg: IncomingMessage, tainted: boolean | undefined): Promise<Task> {
    const userId = msg.author.id;
    const where = msg.threadId ?? msg.channelId;
    const existing = await d.tasks.findOpenConversation?.({ deptId: actor.dept, userId, where });
    if (existing) {
      // The same person speaking again to the same head in the same place continues the one conversation; the roll-up now answers this message.
      return (await d.tasks.update?.(existing.id, { originMessageId: msg.id }).catch(() => null)) ?? existing;
    }
    if (!(await d.limits.checkOpenTasks())) throw new Error('the company has too many open tasks; finish or close some first');
    const id = randomUUID();
    const goal = goalTask(msg.content.trim() ? msg.content : msg.forward?.text ?? '');
    const task = await d.tasks.create({
      id, ...goal, deptId: actor.dept, owner: actor, requester: { kind: 'human', userId }, status: 'doing', depth: 0,
      origin: msg.origin, threadId: where, channelId: msg.parentChannelId ?? msg.channelId, tainted,
      conversation: true, originMessageId: msg.id, originCategoryId: await category(msg),
    });
    await d.bus.emit('task.created', { task });
    return task;
  }

  return {
    exclusive: (key, fn) => serial.run(keyOf(key), fn),
    async adopt(a) {
      const id = randomUUID();
      const task = await d.tasks.create({
        id, title: ADOPTED_TITLE, description: '', deptId: a.actor.dept, owner: a.actor, requester: { kind: 'human', userId: a.userId }, status: 'doing', depth: 0,
        origin: 'chat', threadId: a.channelId, channelId: a.channelId, tainted: a.tainted,
        conversation: true, originMessageId: a.originMessageId, originCategoryId: a.categoryId,
      });
      await d.bus.emit('task.created', { task });
      return task;
    },
    async open({ actor, msg, tainted, reason }) {
      if (actor.kind !== 'head' || msg.author.kind !== 'human') throw new Error('only a human message to a head opens a conversation task');
      if (!praw(actor)) {
        // WS13: other heads open only for a person's typed or slash message that routed by mention, dept channel or goal channel.
        if (!reason || !HEAD_CONVERSATION_REASONS.includes(reason) || (msg.origin !== 'chat' && msg.origin !== 'slash')) throw new Error('this message does not open a conversation task');
        const key = `${actor.dept}|${msg.author.id}|${msg.threadId ?? msg.channelId}`;
        const running = opening.get(key);
        if (running) return running;
        const p = serial.run(key, () => openHead(actor, msg, tainted)).finally(() => opening.delete(key));
        opening.set(key, p);
        return p;
      }
      if (msg.origin !== 'chat' && msg.origin !== 'slash' && msg.origin !== 'voice') throw new Error('unsupported message origin');
      const userId = msg.author.id;
      // P3 / D2: counts like any task. Both checks run before anything is created.
      if (!(await d.limits.checkOpenTasks())) throw new Error('the company has too many open tasks; finish or close some first');
      if (d.userSlot && !d.userSlot(userId)) throw new Error('too many requests from you right now; try again later');
      const id = randomUUID();
      // P20 (T37): a voice transcript stays in memory: never the task title/description, its thread name or the task-log card.
      const goal = msg.origin === 'voice' ? VOICE_GOAL : goalTask(msg.content.trim() ? msg.content : msg.forward?.text ?? '');
      // F5: a typed top-level message to Praw lives in the channel itself (thread id = channel id, as for the heads, WS13): no thread is made
      // (it stayed empty while the answer went to the channel) and the answer replies to the message. An existing thread is used as it is.
      // Slash and voice have no real message to reply to, so they keep a thread of their own.
      const inChannel = msg.threadId === null && msg.origin === 'chat';
      const threadId = msg.threadId ?? (inChannel ? msg.channelId : await d.port.createThread('praw', msg.channelId, threadName({ id, title: goal.title })));
      const task = await d.tasks.create({
        id, ...goal, deptId: 'praw', owner: actor, requester: { kind: 'human', userId }, status: 'doing', depth: 0,
        origin: msg.origin, threadId, channelId: msg.parentChannelId ?? msg.channelId, sourceUserId: userId, tainted,
        conversation: true, originCategoryId: await category(msg),
        // The reply target must be where the roll-up posts: the thread, or the channel itself (F5). A slash or voice request that got a new thread has none.
        ...(msg.threadId || inChannel ? { originMessageId: msg.id } : {}),
      });
      await d.bus.emit('task.created', { task });
      return task;
    },
  };
}

/** The lazy `ctx.ensureConversationTask` for one run: only praw, only a human message, only without a task; one task per run. */
export function conversationHook(actor: ActorRef, t: { msg?: IncomingMessage; task: Task | null; route?: { reason: string } }, conv?: Conversation, tainted: () => boolean = () => true): (() => Promise<Task>) | undefined {
  const msg = t.msg;
  if (!conv || t.task || actor.kind !== 'head' || !msg || msg.author.kind !== 'human') return undefined;
  if (!praw(actor) && !(t.route && HEAD_CONVERSATION_REASONS.includes(t.route.reason))) return undefined; // WS13
  const reason = t.route?.reason;
  let opened: Promise<Task> | undefined;
  return () => (opened ??= conv.open({ actor, msg, tainted: tainted(), ...(reason ? { reason } : {}) }));
}

/**
 * Whether a task is a Praw conversation root (human requester, depth 0, owned by praw, started by typing/slash/voice).
 * Note: this also matches a praw-owned /goal task (origin slash), and one delegation then consumes two D2 slots
 * (the conversation root plus the child). Accepted: both are real open work.
 */
export const isConversationTask = (t: Task): boolean =>
  // WS13: a head's conversation root is marked explicitly by the code that opened it (a /goal task is never one).
  (t.conversation === true && t.depth === 0 && !t.parentId && t.owner.kind === 'head' && t.requester.kind === 'human') ||
  t.deptId === 'praw' && t.depth === 0 && !t.parentId && praw(t.owner) &&
  ((t.requester.kind === 'human' && (t.origin === 'chat' || t.origin === 'slash' || t.origin === 'voice')) ||
    // Task 17: a scheduled/imported job's root task (requester Praw, never the creator) closes the same way after its run.
    ((t.origin === 'schedule' || t.origin === 'import') && praw(t.requester as ActorRef)));

/**
 * After a Praw run on a conversation task (PF6): only a task still `doing` moves (awaiting_approval, blocked and cancelled are
 * left alone). Open children, or a roll-up that is still queued, keep it in `review`; otherwise it is done.
 */
export async function closeConversation(
  task: Task, d: { tasks: Pick<TaskRepo, 'get' | 'update' | 'countOpenChildren'>; bus: EventBus<AppEvents> }, queuedRollups: number,
): Promise<void> {
  const cur = await d.tasks.get(task.id);
  if (!cur || cur.status !== 'doing') return;
  const to = (await d.tasks.countOpenChildren(cur.id)) > 0 || queuedRollups > 0 ? 'review' : 'done';
  const moved = await d.tasks.update(cur.id, { status: to }, 'doing');
  if (moved) await d.bus.emit('task.changed', { task: moved, from: 'doing', to });
}
