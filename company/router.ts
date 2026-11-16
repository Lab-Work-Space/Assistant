import type { DeptId } from '../core/index.js';
import type { Task } from '../db/repos/tasks.js';
import { AI_WARROOM_CHANNEL_ID, GOAL_FORUM_CHANNEL_ID, GOAL_TEXT_CHANNEL_ID } from './channels.js';
export { GOAL_FORUM_CHANNEL_ID, GOAL_TEXT_CHANNEL_ID } from './channels.js';
import { isExcludedChannel, IGNORED_CHANNEL_IDS, type LiveExclusions } from './exclusion.js';
import type { ActorRef, IncomingMessage } from './types.js';
export { IGNORED_CHANNEL_IDS } from './exclusion.js';

export type Route = {
  actor: ActorRef;
  reason: 'mention' | 'reply' | 'warroom' | 'persona_mention' | 'direct_channel' | 'task_owner' | 'dept_channel' | 'goal_channel' | 'admin_console';
  /** Thread context only, not ownership. */
  taskId?: string;
};

type RouterDept = { id: string; enabled: boolean };
type RouterPersona = { id: string; deptId: string; name: string; enabled: boolean };
/** The slice of `Org` the router reads; a real `Org` satisfies it. */
export interface RouterOrg {
  dept(id: string): RouterDept | null;
  persona(id: string): RouterPersona | null;
  personasOf(dept: string): RouterPersona[];
  deptOfChannel(channelId: string): DeptId | null;
  personaByDirectChannel(channelId: string): RouterPersona | null;
}
export interface RouterCtx {
  org: RouterOrg;
  taskByThread: (threadId: string) => Promise<Task | null>;
  /** Whether a department's Discord client is connected; an offline department cannot post, so it gets no route. Default: online. */
  online?: (dept: string) => boolean;
  /**
   * TW2: where a bot post in a warroom thread with no mention goes: ONE actor (the author of the message it replies to, else the previous bot
   * speaker other than the author) or null. Supplied by the scheduler from what it saw; absent = a no-mention post routes nowhere.
   */
  continuation?: (msg: IncomingMessage) => ActorRef | null;
  /** WS6: the live exclusions (the current `roles.modRoomId`, the post-only rooms), read at every call. */
  live?: () => LiveExclusions;
  /** WS13: a task by id, to find the root requester of a task thread. Absent = only a Bot Admin steers a task thread. */
  taskById?: (id: string) => Promise<Task | null>;
  /**
   * RF4: whether the message with this id was recorded (provenance) as one of our runs' answers. Absent or false = a reply to it does not route.
   * Cards, notices, task logs and approval cards are never answers.
   */
  isAnswer?: (messageId: string) => Promise<boolean>;
}

/** TW2: head mentions one bot post may route to in the warroom, counted after de-duplication (the CEO gets more). */
export const WARROOM_MENTION_CAP = 3;
export const WARROOM_MENTION_CAP_CEO = 5;

/** A new goal: a post in the goals text channel, or the starter post of a goals forum thread (its id is the thread id). */
const isGoalPost = (msg: IncomingMessage): boolean =>
  (!msg.threadId && msg.channelId === GOAL_TEXT_CHANNEL_ID) ||
  (msg.threadId !== null && msg.parentChannelId === GOAL_FORUM_CHANNEL_ID && msg.id === msg.threadId);

const sameActor = (a: ActorRef, b: ActorRef): boolean =>
  a.kind === 'head' ? b.kind === 'head' && a.dept === b.dept : b.kind === 'persona' && a.personaId === b.personaId;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Persona of `dept` whose id or display name is the FIRST token after the leading mention markup. */
function mentionedPersona(org: RouterOrg, dept: string, content: string): string | null {
  const rest = content.replace(/^(?:\s*<@!?\d+>)+\s*/, '');
  for (const p of org.personasOf(dept)) {
    if (!p.enabled) continue;
    for (const needle of [p.id, p.name]) {
      const n = needle.trim();
      if (!n) continue;
      if (new RegExp(`^${escapeRe(n)}(?![\\w-])`, 'i').test(rest)) return p.id;
    }
  }
  return null;
}

/**
 * WS13: the people who started the task tree: its root requester, and the creator of a job-run root (`sourceUserId`, R12: a scheduled or
 * imported task has Praw as requester and the person who wrote the job as its creator). Nobody else's message continues the tree.
 */
async function rootPeople(task: Task, ctx: RouterCtx): Promise<string[]> {
  const root = task.id === task.rootId ? task : await ctx.taskById?.(task.rootId).catch(() => null);
  if (!root) return [];
  return [root.requester.kind === 'human' ? root.requester.userId : null, root.sourceUserId].filter((x): x is string => !!x);
}

async function mayCommand(msg: IncomingMessage, task: Task, ctx: RouterCtx): Promise<boolean> {
  if (msg.isAdmin) return true;
  return (await rootPeople(task, ctx)).includes(msg.author.id);
}

/** Enabled and able to post: the actor (and its department) are enabled and the department client is online. */
function isEnabled(org: RouterOrg, actor: ActorRef, online: (dept: string) => boolean): boolean {
  if (actor.kind === 'head') return !!org.dept(actor.dept)?.enabled && online(actor.dept);
  const p = org.persona(actor.personaId);
  return !!p && p.enabled && !!org.dept(p.deptId)?.enabled && online(p.deptId);
}

/** A persona speaks only in its own direct room (and threads under it); a head or Praw speaks anywhere. */
function postsHere(org: RouterOrg, actor: ActorRef, channel: string): boolean {
  return actor.kind === 'head' || org.personaByDirectChannel(channel)?.id === actor.personaId;
}

export async function route(msg: IncomingMessage, ctx: RouterCtx): Promise<Route[]> {
  const { org } = ctx;
  // TW11: a thread whose parent is unknown (a partial channel that was not completed) is never routed: every check below reads the parent.
  if (msg.threadId !== null && msg.parentChannelId === null) return [];
  const channel = msg.parentChannelId ?? msg.channelId;
  if (isExcludedChannel(msg.channelId, msg.parentChannelId, ctx.live?.())) return []; // WS6: the one exclusion predicate, live
  if (msg.author.kind === 'foreign_bot') return [];
  if (msg.author.kind !== 'human' && !msg.author.actor) return []; // fail closed: unattributed bot

  const isHuman = msg.author.kind === 'human';
  if (isHuman && channel === AI_WARROOM_CHANNEL_ID) return []; // the bot-to-bot room: humans do not command in it
  const task = msg.threadId ? await ctx.taskByThread(msg.threadId) : null;
  // WS13: outside the warroom a person steers a task thread only as its root requester or a Bot Admin. Anyone else's message there is ignored
  // (never an ordinary message to the department, never a continuation of the task), so a member cannot steer another department's child task.
  if (task && isHuman && !(await mayCommand(msg, task, ctx))) return [];
  const taskId = task?.id;
  const routes: Route[] = [];
  const add = (actor: ActorRef, reason: Route['reason']) => routes.push(taskId ? { actor, reason, taskId } : { actor, reason });

  // R31: bots address each other only inside a task thread, where the route carries taskId and the turn limit applies.
  // Teamwork C: in #💬-ai-warroom (outside a task thread) a head's mention also routes, under the caps and the scheduler's warroom guard (TW1-TW4).
  const warroomTalk = !isHuman && !task && channel === AI_WARROOM_CHANNEL_ID;
  const selfActor = msg.author.actor;
  const warroomCap = selfActor?.kind === 'head' && selfActor.dept === 'hq' ? WARROOM_MENTION_CAP_CEO : WARROOM_MENTION_CAP;
  // WS2/W2: a bot's @handle routes in every readable channel and thread (not only the warroom), after de-duplication, never to itself, capped (3, CEO 5)
  // also in task threads. The scheduler's guard (serialisation, stall) applies to every one of these routes. Humans' mentions are unchanged.
  const mentions = isHuman ? msg.mentionedHeads
    : [...new Set(msg.mentionedHeads)].filter((d) => !(selfActor?.kind === 'head' && selfActor.dept === d)).slice(0, warroomCap);
  for (const dept of mentions) {
    const personaId = mentionedPersona(org, dept, msg.content);
    // A persona named outside its own direct room is not heard there: the department head handles the message instead.
    if (personaId && postsHere(org, { kind: 'persona', personaId }, channel)) add({ kind: 'persona', personaId }, 'persona_mention');
    else add({ kind: 'head', dept }, warroomTalk ? 'warroom' : 'mention');
  }
  if (warroomTalk && msg.threadId !== null && routes.length === 0) {
    const next = ctx.continuation?.(msg);
    if (next) add(next, 'warroom');
  }

  // RF1-RF4: a person's reply to the message of one of our bots goes to that bot, in any readable channel (even one mapped to another department).
  // Placed after every early return above (exclusions, foreign bot, warroom, WS13 mayCommand). Human authors only (RF2); never for a forward (RF1).
  // The replied-to message was fetched live in this channel by the scheduler and attributed with the mapper's author rules; it must be a recorded answer.
  // The persona fallback is not used: a persona outside its own room is dropped by the postsHere filter below, not turned into its head.
  if (isHuman && !msg.forward && msg.replyToId && msg.replied?.id === msg.replyToId && msg.replied.author.kind !== 'human' && msg.replied.author.kind !== 'foreign_bot') {
    const target = msg.replied.author.actor;
    if (target && (await ctx.isAnswer?.(msg.replied.id).catch(() => false))) add(target, 'reply');
  }

  // P1-B addressing rules (human messages). Narrowing only: a person talking to someone else is not answered by the channel's default head.
  if (isHuman && !msg.forward) {
    const addressed = routes.length > 0; // our bots named by mention, or the bot replied to
    if (!addressed && (msg.otherMentions || msg.replyToId)) return []; // mentions only others, or replies to a non-bot / non-answer message
    if (addressed) return finish(routes);
  }

  if (isHuman) {
    const direct = org.personaByDirectChannel(channel);
    if (direct) add({ kind: 'persona', personaId: direct.id }, 'direct_channel');
  }

  if (task) {
    const author = msg.author.actor;
    const authorIsOwner = !!author && sameActor(author, task.owner);
    const authorIsRequester = !!author && task.requester.kind !== 'human' && sameActor(author, task.requester);
    if (!authorIsOwner && (isHuman || authorIsRequester)) add(task.owner, 'task_owner');
  }

  if (isHuman && !task && routes.length === 0 && isGoalPost(msg)) add({ kind: 'head', dept: 'hq' }, 'goal_channel');

  if (isHuman && routes.length === 0 && !org.personaByDirectChannel(channel)) {
    const dept = org.deptOfChannel(channel);
    if (dept) add({ kind: 'head', dept: dept as DeptId }, 'dept_channel');
  }

  return finish(routes);

  function finish(list: Route[]): Route[] {
    const self = msg.author.actor;
    const online = ctx.online ?? (() => true);
    const seen: ActorRef[] = [];
    return list.filter((r) => {
      if ((self && sameActor(self, r.actor)) || !isEnabled(org, r.actor, online) || !postsHere(org, r.actor, channel)) return false;
      if (seen.some((a) => sameActor(a, r.actor))) return false;
      seen.push(r.actor);
      return true;
    });
  }
}
