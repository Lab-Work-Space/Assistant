import { AI_WARROOM_CHANNEL_ID } from '../../company/channels.js';
import {
  chainDepts, cleanCardText, discordLink, FORWARDS_PER_ROOT, inertName, REROUTE_DUP_WINDOW_MS, REROUTE_REFUSALS, REROUTE_ROOTS_PER_PERSON, REROUTES_PER_MESSAGE_HUMAN,
  rerouteDescription, rerouteTitle, type RerouteRefusal,
} from '../../company/forward.js';
import type { Org } from '../../company/org.js';
import type { Route } from '../../company/router.js';
import type { ActorRef, IncomingMessage } from '../../company/types.js';
import type { ConfigStore } from '../../config/store.js';
import type { ErrorSink } from '../../core/events.js';
import type { IncidentSink } from '../../core/incidents.js';
import type { DeptId } from '../../core/index.js';
import type { NewTask, Task, TaskRepo } from '../../db/repos/tasks.js';
import type { DiscordPort } from '../../discord/port.js';
import type { Limits } from '../../governance/limits.js';
import type { OutboundPayload } from '../loop/payload.js';
import type { RootTaskGate } from '../../tools/types.js';
import { sameActor } from '../../tools/types.js';
import { runStartsTainted } from '../context.js';
import type { Conversation } from '../conversation.js';
import type { KeyedLock } from '../scheduler/jobs.js';

/**
 * REROUTE-1: a mention of a department head in a channel the head's own bot cannot work in becomes a task in that department's own work room, with a short
 * notice in the source; results roll back through the mentioner (the CEO's conversation). Pure code: no model call, $0. The router stays unchanged: the
 * scheduler calls `split` after routing and admission, and `run` for the routes that moved. Gate 1 conditions RR-C1 to RR-C20 are cited where they bind.
 */

type Target = { channelId: string; threadId?: string };
type Head = Extract<ActorRef, { kind: 'head' }>;
type Prov = { tainted: boolean; userId: string | null; answer?: boolean };
type ProvRow = { tainted: boolean; userId: string | null; answer?: boolean };

/** The message's own channel or thread: where a notice goes and where the source link points. */
export const sourceOf = (m: IncomingMessage): Target =>
  m.threadId ? { channelId: m.parentChannelId ?? m.channelId, threadId: m.threadId } : { channelId: m.channelId };

const REAL_ID = /^\d{17,20}$/;
const ACCESS_TTL_MS = 60_000;
const ACCESS_MAX = 1000;
const NOTES_MAX = 200;
const REFUSAL_EVERY_MS = 10 * 60_000;
const POLL_ATTEMPTS = 6;
const QUOTE_MAX = 1500;
const WARN_MAX = 500;

export interface RerouteDeps {
  port: Pick<DiscordPort, 'botCanWork' | 'canMemberView' | 'canMemberPost' | 'canStartThread' | 'channelIsPublic' | 'categoryOf' | 'fetchMessage' | 'history'>;
  org: Pick<Org, 'dept' | 'persona' | 'deptOfChannel' | 'canDelegate'>;
  tasks: Pick<TaskRepo, 'get' | 'create' | 'update' | 'findByThread'> &
    Partial<Pick<TaskRepo, 'findOpenConversation' | 'createUnderOpenParent' | 'rerouteExists' | 'recentRerouteOpen' | 'countOpenRerouteRoots' | 'takeForward'>>;
  limits?: Pick<Limits, 'checkDepth' | 'checkChildren' | 'checkOpenTasks'> | undefined;
  botRoots?: RootTaskGate | undefined;
  conversation?: Conversation | undefined;
  provenance?: { lookup?(ids: string[]): Promise<Map<string, ProvRow>> } | undefined;
  cfg: Pick<ConfigStore, 'get'>;
  log: ErrorSink;
  incidents?: IncidentSink | undefined;
  secrets?: readonly string[] | undefined;
  guildId?: string | undefined;
  online?: ((dept: string) => boolean) | undefined;
  locks: KeyedLock;
  now: () => number;
  /** Milliseconds between the provenance polls (default 500; six tries). A test seam. */
  pollMs?: number | undefined;
  canRun(): boolean;
  isPraw(a: ActorRef): boolean;
  /** The scheduler's own post (provenance, persona rule, incident on failure); null when it did not send. */
  post(actor: ActorRef, target: Target, p: OutboundPayload, prov: Prov, replyToId: string): Promise<string | null>;
  emitCreated(task: Task): Promise<void>;
  emitChanged(e: { task: Task; from: Task['status']; to: Task['status'] }): Promise<void>;
  afterRun(task: Task): Promise<void>;
  /** Whether the tree of `task` is held for the next workday (an off day without usable overtime). */
  held(task: Task): Promise<boolean>;
  /** Whether H1 (the handoff line in the parent thread) will announce this child, so the notice would be a second line. */
  handoffWillRun(task: Task): Promise<boolean>;
  /** The thread-reading context size (config `context.messages`). */
  contextMessages(): number;
}

type Context = {
  msg: IncomingMessage;
  src: string;
  human: boolean;
  mentioner: ActorRef | null;
  tainted: boolean;
  triggerUserId: string | null;
  answer: boolean;
  label: string;
  requester: Task['requester'];
  poster: ActorRef | null;
  threadTask: Task | null;
  quote: string;
  link: string | null;
  origin?: Promise<string | null>;
};

type Plan = {
  path: 'thread' | 'conv' | 'root' | 'human';
  work: string;
  channelId: string;
  card: 'full' | 'link';
  category: string | null;
  /** path `conv`: the person's message the roll-up replies to (RR-C1), already verified. */
  origin: string | null;
};

/** `settle`: a conversation adopted for this child; it is moved to review (open child) after the child exists. */
type Made = { child: Task; settle: Task | null };
type Outcome = Made | RerouteRefusal | null;
type Notice = { target: Target; poster: ActorRef; replyToId: string; userId: string | null };

export class Rerouter {
  private readonly access = new Map<string, { v: 'yes' | 'no'; at: number }>();
  private readonly warned = new Set<string>();
  private readonly refused = new Map<string, number>();
  private readonly notes = new Map<string, Notice>();

  constructor(private readonly d: RerouteDeps) {}

  /** /resume and every halt change: the access answers are read again. */
  clearAccess(): void {
    this.access.clear();
  }

  // ---- A. split ------------------------------------------------------------------------------------------------------------------

  /**
   * Splits the admitted routes into those that run as today and those that move. Only a head route that was reached by a mention (`mention` or `warroom`)
   * AND names the head in `msg.mentionedHeads` is checked (RR-C7); a TW2 continuation, a reply, a task-owner route or a persona is never rerouted.
   * `unknown` access (a transient error) keeps the route (RR-C9).
   */
  async split(msg: IncomingMessage, routes: Route[]): Promise<{ keep: Route[]; moved: Route[] }> {
    const src = msg.threadId ?? msg.channelId;
    const keep: Route[] = [];
    const moved: Route[] = [];
    let enabled: boolean | undefined;
    for (const r of routes) {
      const a = r.actor;
      if (a.kind !== 'head' || (r.reason !== 'mention' && r.reason !== 'warroom') || !msg.mentionedHeads.includes(a.dept)) {
        keep.push(r);
        continue;
      }
      if ((await this.canWork(a.dept, src)) !== 'no') {
        keep.push(r);
        continue;
      }
      if (a.dept === 'praw') {
        this.warnOnce(a.dept, src, 'praw cannot work here and is never rerouted; the mention is dropped');
        continue;
      }
      enabled ??= this.enabled();
      if (!enabled) {
        this.warnOnce(a.dept, src, 'reroute is off; the mention of a head that cannot work here is dropped');
        continue;
      }
      moved.push(r);
    }
    return { keep, moved };
  }

  /** RR-C20: read live; an error reading it counts as off. */
  private enabled(): boolean {
    try {
      return this.d.cfg.get('reroute.enabled') === true;
    } catch {
      return false;
    }
  }

  /** The cached tri-state answer: only definite answers are kept (60 s, at most 1000); an error or `unknown` is never cached. */
  private async canWork(dept: DeptId, src: string): Promise<'yes' | 'no' | 'unknown'> {
    const key = `${dept}|${src}`;
    const hit = this.access.get(key);
    const now = this.d.now();
    if (hit && now - hit.at < ACCESS_TTL_MS) return hit.v;
    let v: 'yes' | 'no' | 'unknown';
    try {
      v = await this.d.port.botCanWork(dept, src);
    } catch {
      return 'unknown';
    }
    if (v === 'yes' || v === 'no') {
      if (this.access.size >= ACCESS_MAX) this.access.delete(this.access.keys().next().value as string);
      this.access.delete(key);
      this.access.set(key, { v, at: now });
    }
    return v === 'yes' || v === 'no' ? v : 'unknown';
  }

  private warnOnce(dept: string, src: string, what: string): void {
    const key = `${dept}|${src}|${what}`;
    if (this.warned.has(key)) return;
    if (this.warned.size >= WARN_MAX) this.warned.clear();
    this.warned.add(key);
    (this.d.log.warn ?? this.d.log.error).call(this.d.log, { dept, channelId: src }, `reroute: ${what}`);
  }

  // ---- C. run --------------------------------------------------------------------------------------------------------------------

  /** Turns the moved routes into tasks, in route order. Never throws: a fault on one department is reported and the next is tried. */
  async run(msg: IncomingMessage, moved: Route[]): Promise<void> {
    const d = this.d;
    const src = msg.threadId ?? msg.channelId;
    const ready = !!(d.tasks.createUnderOpenParent && d.tasks.rerouteExists && d.tasks.recentRerouteOpen && d.tasks.countOpenRerouteRoots && d.tasks.takeForward && d.limits);
    if (!REAL_ID.test(msg.id)) return this.warnOnce('-', src, 'the message id is not a snowflake; nothing is rerouted');
    if (!ready) return this.warnOnce('-', src, 'reroute is not wired here; nothing is rerouted');
    if (!d.canRun()) return;
    const human = msg.author.kind === 'human';
    const mentioner = human ? null : msg.author.actor ?? null;
    if (!human && !mentioner) return;
    let depts = [...new Set(moved.flatMap((r) => (r.actor.kind === 'head' ? [r.actor.dept] : [])))];
    if (human) depts = depts.slice(0, REROUTES_PER_MESSAGE_HUMAN);
    if (!depts.length) return;
    let c: Context | null;
    try {
      c = await this.context(msg, src, human, mentioner, depts[0]!);
    } catch (err) {
      this.fault('context', err);
      return;
    }
    if (!c) return;
    if (!d.canRun()) return; // RR-C15: a /halt during the provenance poll
    for (const dept of depts) {
      try {
        const out = await this.one(c, dept);
        if (typeof out === 'string') await this.refuse(c, dept, out);
      } catch (err) {
        this.fault(`create ${dept}`, err);
      }
    }
  }

  /** Ids and codes only: a database error can carry the failing row (the quote) in its detail, so the error object itself is never logged (S15). */
  private fault(stage: string, err: unknown): void {
    const e = err as { code?: unknown; constraint?: unknown } | null;
    this.d.log.error({ stage, ...(typeof e?.code === 'string' || typeof e?.code === 'number' ? { code: e.code } : {}), ...(typeof e?.constraint === 'string' ? { constraint: e.constraint } : {}) }, 'reroute step failed');
    this.d.incidents?.report({ source: 'scheduler', stage: `reroute ${stage}`, err });
  }

  /** Mentioner, taint, thread task, poster, quote: everything read before any lock. Null = nothing is rerouted (already logged). */
  private async context(msg: IncomingMessage, src: string, human: boolean, mentioner: ActorRef | null, firstDept: string): Promise<Context | null> {
    const d = this.d;
    const threadTask = msg.threadId ? await d.tasks.findByThread(msg.threadId) : null; // a failed read throws: nothing is rerouted (fail closed)
    const label = human ? 'member' : mentioner!.kind === 'head' ? mentioner!.dept : d.org.persona(mentioner!.personaId)?.deptId ?? 'member';
    const base = {
      msg, src, human, mentioner, label, threadTask, link: discordLink(d.guildId, src, msg.id),
      quote: cleanCardText(msg.content, QUOTE_MAX, d.secrets ?? []), // RR-C17: masked, normalised, neutralised and capped; never the replied-to text
    };
    if (!human) {
      // RR-C2: provenance or nothing. The poll runs outside any lock.
      const row = await this.provenanceOf(msg.id);
      if (!row) {
        this.warnOnce(firstDept, src, 'no provenance row for the mentioning message; the mention is dropped');
        return null;
      }
      // A persona is posted for by its head, which must itself be able to work in the source now; otherwise the notice is only logged (G2RR-03).
      const head = mentioner!.kind === 'persona' ? this.headOfActor(mentioner!) : mentioner!;
      const headOk = mentioner!.kind === 'head' || (head.kind === 'head' && (await this.canWork(head.dept, src)) === 'yes');
      const poster = this.neutral(this.postable(msg) && headOk ? head : null, threadTask);
      return { ...base, tainted: !!msg.forward || row.tainted, triggerUserId: row.userId, answer: row.answer === true, requester: mentioner as ActorRef, poster };
    }
    const poster = await this.humanPoster(msg, src, threadTask);
    let tainted = true; // a failed or impossible read counts as tainted
    if (poster) {
      try {
        const history = await d.port.history(src, d.contextMessages(), poster);
        tainted = await runStartsTainted({ msg, task: threadTask, history }, d.provenance?.lookup && ((ids) => d.provenance!.lookup!(ids)));
      } catch {
        tainted = true;
      }
    }
    return { ...base, tainted, triggerUserId: msg.author.id, answer: false, requester: { kind: 'human', userId: msg.author.id }, poster };
  }

  private async provenanceOf(id: string): Promise<ProvRow | null> {
    const prov = this.d.provenance;
    if (!prov?.lookup) return null;
    const lookup = (ids: string[]) => prov.lookup!(ids); // bound call: BotMessageRepo.lookup uses `this` (tester DEFECT-001)
    for (let i = 0; i < POLL_ATTEMPTS; i++) {
      try {
        const row = (await lookup([id])).get(id);
        if (row) return row;
      } catch {
        return null; // a lookup error is "unknown": the mention is dropped
      }
      if (i < POLL_ATTEMPTS - 1) await new Promise<void>((r) => setTimeout(r, this.d.pollMs ?? 500));
    }
    return null;
  }

  private headOfActor(a: ActorRef): ActorRef {
    if (a.kind === 'head') return a;
    const dept = this.d.org.persona(a.personaId)?.deptId;
    return dept ? { kind: 'head', dept: dept as DeptId } : a;
  }

  /** The warroom is excluded: a no-mention bot post there routes to the previous speaker (TW2), so a code-made notice is never posted in it. */
  private postable(msg: IncomingMessage): boolean {
    return (msg.parentChannelId ?? msg.channelId) !== AI_WARROOM_CHANNEL_ID;
  }

  /**
   * RR-C16: a notice must be inert when it comes back through the gateway. In a task thread the router sends a post by the task's REQUESTER (not its owner)
   * to the owner as input, so such a poster posts nothing.
   */
  private neutral(poster: ActorRef | null, task: Task | null): ActorRef | null {
    if (!poster || !task) return poster;
    return task.requester.kind !== 'human' && sameActor(poster, task.requester) && !sameActor(poster, task.owner) ? null : poster;
  }

  /** The bot that posts for a human mentioner: the head of the source channel, hq, then Praw; the first that can work in the source now. None = log only. */
  private async humanPoster(msg: IncomingMessage, src: string, task: Task | null): Promise<ActorRef | null> {
    if (!this.postable(msg)) return null;
    const own = this.d.org.deptOfChannel(msg.parentChannelId ?? msg.channelId);
    const seen = new Set<string>();
    for (const dept of [own, 'hq', 'praw']) {
      if (!dept || seen.has(dept)) continue;
      seen.add(dept);
      const cand = this.neutral({ kind: 'head', dept: dept as DeptId }, task);
      if (cand && (await this.canWork(dept as DeptId, src)) === 'yes') return cand;
    }
    return null;
  }

  // ---- per department -------------------------------------------------------------------------------------------------------------

  private async one(c: Context, dept: DeptId): Promise<Outcome> {
    const d = this.d;
    const { msg } = c;
    if (dept === 'praw') return null; // never rerouted (split already dropped it)
    const target = d.org.dept(dept);
    if (!target?.enabled || d.online?.(dept) === false) return 'disabled';
    const work = target.workChannelId;
    if (!work) return 'no_room';

    // Authorisation: no widening. Each class is gated exactly as its existing tasking power.
    if (c.human) {
      if (!(await d.port.canMemberPost(msg.author.id, work).catch(() => false))) return 'no_access'; // RR-C11
    } else {
      const m = c.mentioner!;
      if (!d.org.canDelegate(m, { kind: 'head', dept })) return 'not_allowed';
      if (d.isPraw(m) && !(c.triggerUserId && (await this.view(c.triggerUserId, work)))) return 'not_allowed';
    }
    if (await d.tasks.rerouteExists!(msg.id, dept)) return null; // RR-C14: before any slot is taken

    // Path and parent (bots). RR-C8: in a task thread only the task's owner reroutes, as a child of that task.
    let path: Plan['path'] = c.human ? 'human' : 'root';
    let origin: string | null = null;
    if (!c.human) {
      if (c.threadTask) {
        if (!sameActor(c.mentioner!, c.threadTask.owner)) return 'not_allowed';
        if ((await chainDepts({ actor: c.mentioner!, task: c.threadTask }, (id) => d.tasks.get(id))).has(dept)) return 'chain';
        path = 'thread';
      } else if (msg.threadId === null && c.mentioner!.kind === 'head' && c.answer && c.triggerUserId && d.conversation?.adopt && d.conversation.exclusive && d.tasks.findOpenConversation) {
        origin = await (c.origin ??= this.originOf(c)); // RR-C1
        if (origin) {
          if (!(await this.view(c.triggerUserId, work))) return 'not_allowed'; // RR-C3 (iv): for every head mentioner, not only Praw
          path = 'conv';
        }
      }
    }

    // Everything that reads Discord happens here, before any lock (RR-C6).
    const startable = await d.port.canStartThread(dept, work).catch(() => false);
    const channelId = startable ? work : !c.human ? AI_WARROOM_CHANNEL_ID : null;
    if (!channelId) return 'no_room';
    const plan: Plan = {
      path, work, channelId, origin, card: await this.cardMode(msg, work),
      category: path === 'root' || path === 'human' ? await d.port.categoryOf(work).catch(() => null) : path === 'conv' ? await d.port.categoryOf(msg.channelId).catch(() => null) : null,
    };

    const key = `reroute:${dept}|${c.human ? msg.author.id : actorKey(c.mentioner!)}|${c.src}`;
    const made = await d.locks.run(key, () => this.create(c, dept, plan));
    if (typeof made === 'string' || !made) return made;
    this.notes.delete(made.child.id);
    if (c.poster && this.postable(msg)) {
      if (this.notes.size >= NOTES_MAX) this.notes.delete(this.notes.keys().next().value as string);
      this.notes.set(made.child.id, { target: sourceOf(msg), poster: c.poster, replyToId: msg.id, userId: c.triggerUserId });
    }
    await d.emitCreated(made.child);
    // The adopted conversation waits in review while its child works; closeConversation counts and updates, so it runs under the task's lock like every other closer (no lock is held here).
    if (made.settle) await d.locks.run(made.settle.id, () => d.afterRun(made.settle!));
    return null;
  }

  private async view(userId: string, channelId: string): Promise<boolean> {
    return this.d.port.canMemberView(userId, channelId).catch(() => false);
  }

  /** RR-C1: the person's message this answer replies to, read live as the mentioning bot: same channel, written by the person the row names. */
  private async originOf(c: Context): Promise<string | null> {
    const id = c.msg.replyToId;
    if (!id || !REAL_ID.test(id) || !c.mentioner) return null;
    const got = await this.d.port.fetchMessage(c.msg.channelId, id, c.mentioner).catch(() => null);
    if (!got || got.id !== id || got.channelId !== c.msg.channelId || got.author.kind !== 'human' || got.author.id !== c.triggerUserId) return null;
    return id;
  }

  /** RR-C10: exactly forward_to's order. A thread: the public check on the thread only. Top-level: the same room, then the public check. Any doubt = link. */
  private async cardMode(msg: IncomingMessage, work: string): Promise<'full' | 'link'> {
    try {
      if (msg.threadId) return (await this.d.port.channelIsPublic(msg.threadId)) ? 'full' : 'link';
      if (msg.channelId === work) return 'full';
      return (await this.d.port.channelIsPublic(msg.channelId)) ? 'full' : 'link';
    } catch {
      return 'link';
    }
  }

  // ---- inside the locks: database work only -------------------------------------------------------------------------------------

  private child(c: Context, dept: DeptId, plan: Plan, parent: Task | null): NewTask & { rerouteSourceId: string } {
    return {
      title: rerouteTitle(c.label), description: rerouteDescription({ link: c.link, from: c.label, quote: c.quote }),
      deptId: dept, owner: { kind: 'head', dept }, requester: c.requester, origin: c.human ? 'chat' : 'delegated', status: 'todo', estCostUsd: 0,
      tainted: c.tainted, channelId: plan.channelId, forwardCard: plan.card, rerouteSourceId: c.msg.id, rerouteWhere: c.src,
      ...(parent ? { parentId: parent.id } : plan.category ? { originCategoryId: plan.category } : {}),
    };
  }

  private async create(c: Context, dept: DeptId, plan: Plan): Promise<Outcome> {
    const d = this.d;
    if (!d.canRun()) return null; // RR-C15: after the lock wait
    // RR-C4: parent-independent duplicate guard (the same mentioner, department and source within 15 minutes).
    const since = new Date(d.now() - REROUTE_DUP_WINDOW_MS);
    // (A person's own message is not chunked and a redelivery is caught by the unique index and `rerouteExists`, so a second request from the same person is not swallowed.)
    if (plan.path !== 'human' && (await d.tasks.recentRerouteOpen!({ deptId: dept, requester: c.requester, where: c.src, since }))) return null;
    try {
      switch (plan.path) {
        case 'human': return await this.createHuman(c, dept, plan);
        case 'root': return await this.createRoot(c, dept, plan);
        case 'thread': {
          const parent = await d.tasks.get(c.threadTask!.id);
          if (!parent) return null;
          const r = await this.attach(c, dept, plan, parent, since);
          return r === 'stale' ? 'not_allowed' : r;
        }
        case 'conv': return await this.createInConversation(c, dept, plan, since);
      }
    } catch (err) {
      if (isDuplicate(err)) return null; // RR-C14: only a violation of tasks_reroute_once; any other database error is reported by the caller
      throw err;
    }
  }

  private async createHuman(c: Context, dept: DeptId, plan: Plan): Promise<Outcome> {
    const d = this.d;
    // One person's count and insert run one at a time across every channel and department, so the cap of 3 cannot overshoot (RR-C12).
    return d.locks.run(`reroute-person:${c.msg.author.id}`, async () => {
      if ((await d.tasks.countOpenRerouteRoots!(c.msg.author.id)) >= REROUTE_ROOTS_PER_PERSON) return 'limit';
      if (!(await d.limits!.checkOpenTasks())) return 'limit';
      if (!d.canRun()) return null;
      return { child: await d.tasks.create(this.child(c, dept, plan, null)), settle: null };
    });
  }

  private async createRoot(c: Context, dept: DeptId, plan: Plan): Promise<Outcome> {
    const d = this.d;
    if (!(await d.limits!.checkOpenTasks())) return 'limit';
    const release = d.botRoots ? await d.botRoots.acquire() : null; // TW6: the daily cap on tasks started from bot talk (no gate wired = refuse)
    if (!release) return 'limit';
    try {
      if (!d.canRun()) return null;
      return { child: await d.tasks.create(this.child(c, dept, plan, null)), settle: null };
    } finally {
      release();
    }
  }

  /**
   * Attaches the child to an open parent, under the parent's own lock: the run that is still closing it holds that lock, and so does the sweep that closes quiet
   * conversations (settleReview), so neither can close the parent between the checks and the insert. The insert itself only succeeds while the parent is
   * `doing` or `review` (RR-C5). Refusals first, then the duplicate guard, then the per-root slot, then the insert. `stale` = the parent was not open any more.
   */
  private async attach(c: Context, dept: DeptId, plan: Plan, parent: Task, since: Date): Promise<Made | RerouteRefusal | 'stale' | null> {
    const d = this.d;
    return d.locks.run(parent.id, async () => {
      const cur = await d.tasks.get(parent.id);
      if (!cur || (cur.status !== 'doing' && cur.status !== 'review')) return 'stale';
      if (!d.limits!.checkDepth(cur.depth) || !(await d.limits!.checkChildren(cur.id)) || !(await d.limits!.checkOpenTasks())) return 'limit';
      if (await d.tasks.recentRerouteOpen!({ deptId: dept, requester: c.requester, where: c.src, parentId: cur.id, since })) return null; // the mentioner's own create_task
      if (!d.canRun()) return null;
      if (!(await d.tasks.takeForward!(cur.rootId, FORWARDS_PER_ROOT))) return 'limit'; // RR-C18: every child counts, in every tree
      const made = await d.tasks.createUnderOpenParent!({ ...this.child(c, dept, plan, cur), parentId: cur.id });
      return made ? { child: made, settle: null } : 'stale';
    });
  }

  /** Path (b): the head's open conversation in this channel (one per head, person and channel), else a new one adopted. All of it under one key (RR-C4). */
  private async createInConversation(c: Context, dept: DeptId, plan: Plan, since: Date): Promise<Outcome> {
    const d = this.d;
    const conv = d.conversation!;
    const head = c.mentioner as Head;
    const userId = c.triggerUserId!;
    const where = c.msg.channelId;
    return conv.exclusive!({ dept: head.dept, userId, where }, async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const existing = await d.tasks.findOpenConversation!({ deptId: head.dept, userId, where });
        if (existing && (existing.status === 'doing' || existing.status === 'review')) {
          const r = await this.attach(c, dept, plan, existing, since);
          if (r !== 'stale') return r;
          continue; // closed meanwhile: look again, then adopt
        }
        break;
      }
      // Every refusal runs before the adoption (RR-C5); two open slots are needed: the conversation and its child.
      if (!(await d.limits!.checkOpenTasks(2))) return 'limit';
      if (!d.canRun()) return null;
      const adopted = await conv.adopt!({ actor: head, userId, channelId: where, originMessageId: plan.origin, tainted: c.tainted, categoryId: plan.category });
      let made: Task | null = null;
      try {
        if (!(await d.tasks.takeForward!(adopted.rootId, FORWARDS_PER_ROOT))) return 'limit'; // RR-C18: the first child of an adopted root counts too
        made = await d.tasks.createUnderOpenParent!({ ...this.child(c, dept, plan, adopted), parentId: adopted.id });
        return made ? { child: made, settle: adopted } : 'limit';
      } finally {
        if (!made) await this.closeOrphan(adopted); // no child: the conversation must not stay doing (nothing would ever close it)
      }
    });
  }

  private async closeOrphan(task: Task): Promise<void> {
    try {
      const moved = await this.d.tasks.update(task.id, { status: 'cancelled' }, 'doing');
      if (moved) await this.d.emitChanged({ task: moved, from: 'doing', to: 'cancelled' });
    } catch (err) {
      this.fault('orphan close', err);
    }
  }

  // ---- notices -------------------------------------------------------------------------------------------------------------------

  /** A refusal notice in the source: fixed words by code, at most one per source and department per 10 minutes, posted by a bot that can reach it. */
  private async refuse(c: Context, dept: DeptId, code: RerouteRefusal): Promise<void> {
    const d = this.d;
    if (!c.poster || !this.postable(c.msg) || !d.canRun()) return;
    const key = `${c.src}|${dept}`;
    const now = d.now();
    const last = this.refused.get(key);
    if (last !== undefined && now - last < REFUSAL_EVERY_MS) return;
    if (this.refused.size >= WARN_MAX) this.refused.clear();
    this.refused.set(key, now);
    const name = inertName(d.org.dept(dept)?.name ?? dept);
    await d.post(c.poster, sourceOf(c.msg), { type: 'chat', body: `➜ ส่งต่อให้ ${name} ไม่ได้: ${REROUTE_REFUSALS[code]}`, noHandles: true }, { tainted: c.tainted, userId: c.triggerUserId, answer: false }, c.msg.id);
  }

  /**
   * The short notice in the source, posted from the scheduler's task.created handler once the thread exists. Skipped when H1 will announce the child in the
   * parent thread, when the post could not be inert, or when the company is halted (RR-C15). A new post, never an edit of a reply preview.
   */
  async notice(task: Task): Promise<void> {
    const d = this.d;
    const n = this.notes.get(task.id);
    if (!n) return;
    this.notes.delete(task.id);
    if (!d.canRun() || (await d.handoffWillRun(task))) return;
    const name = inertName(d.org.dept(task.deptId)?.name ?? task.deptId);
    const link = discordLink(d.guildId, task.threadId);
    const held = await d.held(task).catch(() => false);
    const body = `➜ ส่งต่อให้ ${name} ในห้องงานของแผนก${link ? `: ${link}` : ''}${held ? ' (เริ่มวันทำงานถัดไป)' : ''}`;
    await d.post(n.poster, n.target, { type: 'chat', body, noHandles: true }, { tainted: task.tainted, userId: n.userId, answer: false }, n.replyToId);
  }
}

const actorKey = (a: ActorRef): string => (a.kind === 'head' ? `head:${a.dept}` : `persona:${a.personaId}`);

/** RR-C14: only a violation of tasks_reroute_once is a duplicate; every other database error is a fault. */
function isDuplicate(err: unknown): boolean {
  const e = err as { code?: unknown; constraint?: unknown } | null;
  return e?.code === '23505' && e.constraint === 'tasks_reroute_once';
}
