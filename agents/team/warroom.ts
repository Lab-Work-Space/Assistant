import type { Route } from '../../company/router.js';
import { AI_WARROOM_CHANNEL_ID } from '../../company/channels.js';
import type { ActorRef, IncomingMessage } from '../../company/types.js';

/**
 * Gate 1 TW1-TW4, TW14, WS2-WS4: the guard on bot-to-bot talk on EVERY route a bot author can start (the warroom, department rooms, forum
 * posts, task threads). The owner asked for no conversation size limit; what this bounds is concurrency and consecutive bot turns, not length.
 *
 * WS2: the key is `threadId ?? channelId` (see `warroomKey`), never one shared key: two channels do not serialise against each other and a
 * person's message in channel A cannot lift a stall in channel B.
 * WS3: a person's message resets a key. A code-observed task write resets it at most ONCE per stall window (until a person speaks), so a pair
 * of heads that create a task every N-1 turns still stalls within 2 x stallTurns. `stallTurns` has min 1 and cannot be switched off.
 * WS4 (replaces the TW18 ruling for the stall state): the stall counters are written through to `guard_state` and loaded before a key is
 * used, so a restart does not lift a stall. The hourly rate windows stay in memory (they are lifted for local calls and a restart gives
 * up at most one extra hour of rate window).
 */
const HOUR = 3_600_000;
const IDLE_PRUNE_MS = 6 * HOUR;
const MAX_KEYS = 500;
const MAX_AUTHORS = 500;

export interface WarroomLimits { turnsPerThreadPerHour: number; turnsPerHour: number; stallTurns: number; heldMax: number }
export type Pending = { route: Route; msg: IncomingMessage };
export type Rate = 'ok' | 'thread_rate' | 'warroom_rate';

/**
 * HEAL-1 (Gate 1 HL-C1..C4, HL-C17): how a stall on the #ai-warroom key can be lifted without a person typing there. Every getter returns null
 * (or throws, which the scheduler maps to null) when `heal.enabled` is off; null switches the path off. A cap of 0 also switches its path off.
 */
export interface LiftOpts {
  quietMs(): number | null;
  quietCap(): number | null;
  personCap(): number | null;
  /** The calendar day of `ms` in schedule.timezone (the day the two caps count in). */
  day(ms: number): string;
  onLift?(e: { reason: 'quiet' | 'person_run'; detail?: string }): void;
}

type Stalled = { ceoTurn: boolean };
type Thread = {
  /** Runs started since the last reset, over any set of heads (TW3). NO_REPLY turns count: it is runs, not posts. */
  count: number;
  participants: Set<string>;
  stalled: Stalled | null;
  /** WS3: the one task-write reset of this stall window has been used; only a person's message gives it back. */
  resetUsed: boolean;
  /** WS4: the last write-through, awaited by `flush` before a run starts. */
  writing: Promise<void>;
  inFlight: boolean;
  pending: Map<string, Pending>;
  speakers: string[];
  starts: number[];
  touched: number;
  /** HEAL-1: the quiet clock (ms epoch; null = not stamped, the load time counts), when this state was created, and the per-day lift counters. */
  lastBotTurnAt: number | null;
  loadedAt: number;
  quietLifts: number;
  personLifts: number;
  liftDay: string | null;
};

export const actorKeyOf = (a: ActorRef): string => (a.kind === 'head' ? a.dept : `persona:${a.personaId}`);
/** WS2: the guard key of a message: its thread, else its (top-level) channel. */
export const warroomKey = (m: { threadId: string | null; channelId: string }): string => m.threadId ?? m.channelId;

/** WS4: the persisted part of one key's state. */
export type GuardRow = {
  count: number; stalled: boolean; ceoTurn: boolean; resetUsed: boolean;
  /** HEAL-1 (migration 037): the quiet clock (ms epoch) and the per-day lift counters (HL-C2). Absent or null = not stored yet. */
  lastBotTurnAt?: number | null; quietLifts?: number; personLifts?: number; liftDay?: string | null;
};
export interface GuardStore {
  get(key: string): Promise<GuardRow | null>;
  put(key: string, row: GuardRow): Promise<void>;
  /** Drops keys not touched since `before`. */
  prune(before: Date): Promise<void>;
}

export class WarroomGuard {
  private readonly states = new Map<string, Thread>();
  private readonly authors = new Map<string, string>(); // message id -> author key (for replyTo), bounded
  private readonly all: number[] = [];
  private readonly alerted = new Set<string>();
  /** TW14: the held start per thread key, with (OT-C5) the task tree it belongs to: the DB root id of the TARGET task, never the sender's tree; absent = no task. */
  private readonly held = new Map<string, { start: () => void; rootId?: string }>();
  private pausedDay: string | null = null;

  constructor(
    private readonly limits: () => WarroomLimits,
    private readonly now: () => number = Date.now,
    private readonly store?: GuardStore,
    private readonly log?: { error(o: unknown, m?: string): void },
    private readonly lifts?: LiftOpts,
  ) {}

  private thread(key: string): Thread {
    let t = this.states.get(key);
    if (!t) {
      if (this.states.size >= MAX_KEYS) this.prune();
      t = { count: 0, participants: new Set(), stalled: null, resetUsed: false, writing: Promise.resolve(), inFlight: false, pending: new Map(), speakers: [], starts: [], touched: 0, lastBotTurnAt: null, loadedAt: this.now(), quietLifts: 0, personLifts: 0, liftDay: null };
      this.states.set(key, t);
    }
    t.touched = this.now();
    return t;
  }

  private prune(): void {
    const old = this.now() - IDLE_PRUNE_MS;
    // HL-C2: the warroom row is never pruned (it carries the day's lift counters and the quiet clock).
    for (const [k, t] of this.states) if (k !== AI_WARROOM_CHANNEL_ID && !t.inFlight && !t.pending.size && t.touched < old) this.states.delete(k);
    if (this.states.size >= MAX_KEYS) for (const [k, t] of this.states) if (k !== AI_WARROOM_CHANNEL_ID && !t.inFlight && !t.pending.size) { this.states.delete(k); if (this.states.size < MAX_KEYS) break; }
    void this.store?.prune(new Date(old)).catch(() => undefined);
  }

  /**
   * WS4: loads a key's stored state once, before any other call for that key. Always call this (and await it) first in a request path that
   * will use the key. A failed read leaves the key empty, which is the old in-memory behaviour.
   */
  async ensure(key: string): Promise<void> {
    if (this.states.has(key) || !this.store) {
      this.thread(key);
      return;
    }
    let row: GuardRow | null = null;
    try {
      row = await this.store.get(key);
    } catch (err) {
      this.log?.error({ err }, 'guard state could not be read; starting empty');
    }
    if (this.states.has(key)) return; // another caller loaded it while this one waited
    const t = this.thread(key);
    if (row) {
      t.count = row.count;
      t.resetUsed = row.resetUsed;
      t.stalled = row.stalled ? { ceoTurn: row.ceoTurn } : null;
      t.lastBotTurnAt = row.lastBotTurnAt ?? null;
      t.quietLifts = row.quietLifts ?? 0;
      t.personLifts = row.personLifts ?? 0;
      t.liftDay = row.liftDay ?? null;
    }
  }

  /** WS4: write-through; failures are logged and the in-memory state still holds. */
  private persist(key: string, t: Thread): void {
    if (!this.store) return;
    const row: GuardRow = { count: t.count, stalled: !!t.stalled, ceoTurn: !!t.stalled?.ceoTurn, resetUsed: t.resetUsed,
      lastBotTurnAt: t.lastBotTurnAt, quietLifts: t.quietLifts, personLifts: t.personLifts, liftDay: t.liftDay };
    const store = this.store;
    t.writing = t.writing.then(() => store.put(key, row)).catch((err: unknown) => this.log?.error({ err }, 'guard state could not be written'));
  }

  /** WS4: resolves when every write for this key has finished (awaited before a run starts). */
  async flush(key: string): Promise<void> {
    await this.states.get(key)?.writing;
  }

  private reset(t: Thread): void {
    t.count = 0;
    t.participants.clear();
    t.stalled = null;
  }

  /** TW3 / WS3: a person wrote in this thread (or channel). Always resets, and gives back the one task-write reset. */
  humanMessage(key: string): void {
    const t = this.thread(key);
    if (!t.count && !t.stalled && !t.resetUsed) return; // nothing to lift: no write
    this.reset(t);
    t.resetUsed = false;
    this.persist(key, t);
  }

  /**
   * TW3 / WS3: a tool of a run for this key created or changed a task row (observed by code, not claimed by the model). Resets the count at
   * most once per stall window; further writes change nothing until a person speaks.
   */
  taskWrite(key: string): void {
    const t = this.thread(key);
    if (t.resetUsed) return;
    t.resetUsed = true;
    this.reset(t);
    this.persist(key, t);
  }

  /**
   * A head's post was seen in this thread. Records who spoke (for TW2) and returns the ONE continuation target for a post with no mention:
   * the author of the message it replies to, else the previous speaker other than the author; null when neither is known.
     */
  observeBot(key: string, msg: IncomingMessage): ActorRef | null {
    const t = this.thread(key);
    const me = msg.author.actor ? actorKeyOf(msg.author.actor) : null;
    if (!me) return null;
    const replied = msg.replyToId ? this.authors.get(msg.replyToId) : undefined;
    const prev = [...t.speakers].reverse().find((s) => s !== me);
    const target = replied && replied !== me ? replied : prev;
    if (t.speakers.at(-1) !== me) t.speakers.push(me);
    if (t.speakers.length > 6) t.speakers.shift();
    this.authors.delete(msg.id);
    this.authors.set(msg.id, me);
    if (this.authors.size > MAX_AUTHORS) this.authors.delete(this.authors.keys().next().value as string);
    return target && !target.startsWith('persona:') ? { kind: 'head', dept: target as never } : null;
  }

  isStalled(key: string): boolean {
    this.liftIfQuiet(key);
    return !!this.states.get(key)?.stalled;
  }

  private opt<T>(f: (() => T) | undefined): T | null {
    try {
      return f ? f() : null;
    } catch {
      return null; // HL-C17: a read error counts as off
    }
  }

  /** HL-C2: the per-day counters roll over when the day in schedule.timezone changes. */
  private rollDay(t: Thread): void {
    const day = this.lifts?.day(this.now()) ?? null;
    if (day !== null && t.liftDay !== day) {
      t.liftDay = day;
      t.quietLifts = 0;
      t.personLifts = 0;
    }
  }

  /** HL-C2: a cap from the options; null (off) when heal is off, and 0 switches the path off. */
  private cap(which: 'quiet' | 'person'): number | null {
    if (!this.lifts || this.opt(() => this.lifts!.quietMs()) === null) return null;
    return this.opt(() => (which === 'quiet' ? this.lifts!.quietCap() : this.lifts!.personCap()));
  }

  /**
   * HL-C5: can an H3a lift happen now on this key? Only the warroom key, only when heal is on and the key is stalled; a Bot Admin's lift is
   * never capped (and never counted), a non-admin's is capped per day. A cap of 0 switches the path off.
   */
  canLift(key: string, admin: boolean): boolean {
    if (key !== AI_WARROOM_CHANNEL_ID) return false;
    const t = this.states.get(key);
    if (!t?.stalled) return false;
    const cap = this.cap('person');
    if (cap === null || cap <= 0) return false;
    if (admin) return true;
    this.rollDay(t);
    return t.personLifts < cap;
  }

  /**
   * HL-C3: lifts a stall on the warroom key without a person typing there: count 0, participants cleared, stalled null, resetUsed TRUE (so the
   * next stall is exactly stallTurns turns away, not 2x). Counts against its day cap (a Bot Admin's person lift counts for nothing). Returns
   * whether it lifted.
   */
  lift(key: string, reason: 'quiet' | 'person_run', o: { admin?: boolean; detail?: string } = {}): boolean {
    if (key !== AI_WARROOM_CHANNEL_ID) return false;
    const t = this.states.get(key);
    if (!t?.stalled) return false;
    const cap = this.cap(reason === 'quiet' ? 'quiet' : 'person');
    if (cap === null || cap <= 0) return false;
    this.rollDay(t);
    if (reason === 'quiet') {
      if (t.quietLifts >= cap) return false;
      t.quietLifts++;
    } else if (!o.admin) {
      if (t.personLifts >= cap) return false;
      t.personLifts++;
    }
    this.reset(t);
    t.resetUsed = true;
    this.persist(key, t);
    try {
      this.lifts?.onLift?.({ reason, ...(o.detail ? { detail: o.detail } : {}) });
    } catch (err) {
      this.log?.error({ errName: err instanceof Error ? err.name : 'unknown' }, 'warroom lift callback failed');
    }
    return true;
  }

  /** HL-C4: H3b. A stalled warroom key with no bot turn for `quietMs` lifts itself (unless paused or capped). Called from isStalled and start. */
  liftIfQuiet(key: string): boolean {
    if (key !== AI_WARROOM_CHANNEL_ID || !this.lifts) return false;
    const t = this.states.get(key);
    if (!t?.stalled) return false;
    const quietMs = this.opt(() => this.lifts!.quietMs());
    if (quietMs === null || this.paused()) return false;
    if (this.now() - (t.lastBotTurnAt ?? t.loadedAt) < quietMs) return false;
    return this.lift(key, 'quiet');
  }

  /** HL-C4: a bot's post in this key went out (the say path); the quiet clock moves. Never called for a refused post. */
  noteBotPost(key: string): void {
    const t = this.thread(key);
    t.lastBotTurnAt = this.now();
    this.persist(key, t);
  }

  /** TW4: bot-to-bot routing is off for the rest of this UTC day. */
  pauseToday(): void {
    this.pausedDay = new Date(this.now()).toISOString().slice(0, 10);
  }
  paused(): boolean {
    return this.pausedDay === new Date(this.now()).toISOString().slice(0, 10);
  }

  /**
   * TW1: a run for `dept` in this thread. 'run' = the caller starts it (the thread is now in flight); 'queued' = one run is already in
   * flight there, so this trigger waits as the single pending entry for that head (a newer trigger replaces an older one).
   */
  admit(key: string, dept: string, p: Pending): 'run' | 'queued' {
    const t = this.thread(key);
    if (t.inFlight) {
      t.pending.set(dept, p);
      return 'queued';
    }
    t.inFlight = true;
    return 'run';
  }

  /** The run for this thread ended: the next pending trigger (the caller runs it, the thread stays in flight), or null (the thread is free). */
  finish(key: string): Pending | null {
    const t = this.thread(key);
    const next = t.pending.entries().next();
    if (next.done) {
      t.inFlight = false;
      return null;
    }
    t.pending.delete(next.value[0]);
    return next.value[1];
  }

  /** Drops everything waiting in this thread and frees it (stall, halt, pause). */
  clearPending(key: string): void {
    const t = this.thread(key);
    t.pending.clear();
    t.inFlight = false;
  }

  /**
   * TW3 + TW1, checked just before a bot-triggered run starts. `stall` = this start would be the (limit+1)th consecutive bot turn: the
   * thread is marked stalled with the set of heads seen, and `ceoTurn` says whether the single CEO "stalled" turn is still owed.
   * Otherwise the hourly rates (per thread, per warroom) decide.
   */
  start(key: string, dept: string, liftRates = false): { kind: 'ok' } | { kind: 'stalled'; ceoTurn: boolean } | { kind: 'limited'; scope: 'thread_rate' | 'warroom_rate'; first: boolean } {
    const t = this.thread(key);
    const lim = this.limits();
    this.liftIfQuiet(key); // H3b: a stall that has been quiet long enough lifts before it is checked
    if (t.stalled) return { kind: 'stalled', ceoTurn: false };
    if (t.count >= Math.max(1, lim.stallTurns)) {
      t.stalled = { ceoTurn: true };
      this.persist(key, t);
      return { kind: 'stalled', ceoTurn: true };
    }
    const cut = this.now() - HOUR;
    t.starts = t.starts.filter((x) => x > cut);
    while (this.all.length && this.all[0]! <= cut) this.all.shift();
    const hour = Math.floor(this.now() / HOUR);
    // WS1: the two hourly rates are lifted for a local call (`liftRates`, decided by the caller from the resolved provider); the stall check above never is.
    if (!liftRates && t.starts.length >= lim.turnsPerThreadPerHour) return { kind: 'limited', scope: 'thread_rate', first: this.firstAlert(`${key}|${hour}|t`) };
    if (!liftRates && this.all.length >= lim.turnsPerHour) return { kind: 'limited', scope: 'warroom_rate', first: this.firstAlert(`${hour}|w`) };
    t.starts.push(this.now());
    this.all.push(this.now());
    t.count++;
    t.participants.add(dept);
    t.lastBotTurnAt = this.now(); // HL-C4: the ok path only
    this.persist(key, t);
    return { kind: 'ok' };
  }

  /** A meeting turn counts towards the warroom hourly total (it is bounded elsewhere and never refused here). */
  noteMeetingTurn(): void {
    this.all.push(this.now());
  }

  /** The stall turn is taken once per stall. */
  takeCeoTurn(key: string): boolean {
    const t = this.states.get(key);
    if (!t?.stalled?.ceoTurn) return false;
    t.stalled.ceoTurn = false;
    this.persist(key, t);
    return true;
  }

  private firstAlert(k: string): boolean {
    if (this.alerted.has(k)) return false;
    if (this.alerted.size > 1000) this.alerted.clear();
    this.alerted.add(k);
    return true;
  }

  /** TW14: off-day starts wait here, at most one per thread (the newest), and at most `heldMax` threads; false = dropped. */
  hold(key: string, start: () => void, rootId?: string): boolean {
    if (!this.held.has(key) && this.held.size >= this.limits().heldMax) return false;
    // OT-C5: the start and its tag are stored together and replaced together: a newer start never inherits an older entry's tree.
    this.held.set(key, rootId === undefined ? { start } : { start, rootId });
    return true;
  }
  /** G2OT-02: puts a released start back only when the thread has no (newer) entry; 'present' = a newer start is kept and this one is dropped, 'full' = no room. */
  holdIfAbsent(key: string, start: () => void, rootId?: string): 'held' | 'present' | 'full' {
    if (this.held.has(key)) return 'present';
    return this.hold(key, start, rootId) ? 'held' : 'full';
  }
  releaseHeld(): (() => void)[] {
    const out = [...this.held.values()].map((h) => h.start);
    this.held.clear();
    return out;
  }
  /** OT-C5: removes and returns only the entries tagged with `rootId` (untagged entries and other trees' entries stay held). */
  releaseHeldFor(rootId: string): { key: string; start: () => void }[] {
    const out: { key: string; start: () => void }[] = [];
    for (const [key, h] of [...this.held]) {
      if (h.rootId !== rootId) continue;
      out.push({ key, start: h.start });
      this.held.delete(key);
    }
    return out;
  }
  /** OT-1: how many held starts belong to this tree (the card's "bot messages" count). */
  heldCountFor(rootId: string): number {
    let n = 0;
    for (const h of this.held.values()) if (h.rootId === rootId) n++;
    return n;
  }
  heldCount(): number {
    return this.held.size;
  }
}
