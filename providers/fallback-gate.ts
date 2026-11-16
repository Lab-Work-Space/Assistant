import type { ActorRef } from '../company/types.js';
import type { FallbackMark, FallbackState } from './route.js';

/** A 429/5xx/529 on the fallback route cools the backup for this long. */
export const COOL_MS = 5 * 60_000;

const actorKeyOf = (a: ActorRef): string => (a.kind === 'head' ? `head:${a.dept}` : `persona:${a.personaId}`);

/** What a caller learns from a failed fallback call: numeric `status` only, the vendor message is never read (Gate 1 S6). */
export type ErrorMark = { kind: 'api_off'; status: number } | { kind: 'api_busy'; status: number } | { kind: 'task_400' };

/**
 * Error table by status number only: 401/402/403 -> apiOff; 408/409/429/5xx/529 -> cool 5 minutes; 400 -> a per-task mark (PV-C06,
 * never global); anything else, no status or a non-number -> null (the caller's existing failure path).
 */
export function markFromError(err: unknown): ErrorMark | null {
  const s = typeof err === 'object' && err !== null ? (err as { status?: unknown }).status : undefined;
  if (typeof s !== 'number' || !Number.isInteger(s)) return null;
  if (s === 401 || s === 402 || s === 403) return { kind: 'api_off', status: s };
  if (s === 400) return { kind: 'task_400' };
  if (s === 408 || s === 409 || s === 429 || (s >= 500 && s <= 599)) return { kind: 'api_busy', status: s };
  return null;
}

/** A refused budget reservation on the fallback route, as a mark (company, bot and dept hold the work; task, project and price keep their existing flows). */
export function markFromRefusal(scope: string, actor: ActorRef, dept: string): Extract<FallbackMark, { kind: 'budget' }> | null {
  return scope === 'company' || scope === 'bot' || scope === 'dept' ? { kind: 'budget', scope, actor, dept } : null;
}

export interface FallbackGateOptions {
  /** QuotaStore.heldUntil. */
  heldUntil: () => number | null;
  now?: () => number;
  /** Called for every mark; `first` is true when it changed the gate (for the once-per-episode alert and the audit row). A throw is ignored. */
  onMark?: (e: FallbackMark, first: boolean) => void;
  /**
   * Called (once per expiry, never throws out) when a TEMPORARY mark has ended: the 5-minute cool-down, or the UTC day of a company, bot or department
   * refusal. The work requeued by the mark is `todo` and nothing else offers it again before the hold ends, so the app re-offers it here. The block
   * for api_off and a per-task 400 lasts for the episode and has no expiry.
   */
  onExpire?: () => void;
}

/** A margin after the mark's own end, so the clock check in `usable` is true when `onExpire` runs. */
const EXPIRE_MARGIN_MS = 1000;
const DAY_MS = 86_400_000;

/**
 * R8 (spec 3.5): the in-memory block list of the Claude API backup. Nothing is persisted (a restart clears it; the next refusal sets it again,
 * and the persisted budget rows refuse the next reserve before any call). Set only from fallback-route outcomes by the loop, the judge and the
 * helper call; cleared when the hold ends. The USD marks last until the next UTC day or the end of the hold, whichever comes first.
 */
export class FallbackGate implements FallbackState {
  private apiOff: { status: number } | null = null;
  private coolUntil = 0;
  private companyOutDay: string | null = null;
  private readonly botOut = new Map<string, string>();
  private readonly deptOut = new Map<string, string>();
  private readonly taskOut = new Set<string>();
  private readonly reoffered = new Set<string>();
  private refusedAlerted = false;
  private taskRefusedAlerted = false;
  private busyAlerted = false;
  private used = false;
  private coolTimer: NodeJS.Timeout | null = null;
  private dayTimer: NodeJS.Timeout | null = null;
  private readonly clock: () => number;

  constructor(private readonly o: FallbackGateOptions) {
    this.clock = o.now ?? Date.now;
  }

  private day(): string {
    return new Date(this.clock()).toISOString().slice(0, 10);
  }

  heldUntil(): number | null {
    return this.o.heldUntil();
  }

  usable(actor: ActorRef, deptId: string, taskId?: string): boolean {
    if (this.apiOff) return false;
    if (this.clock() < this.coolUntil) return false;
    const today = this.day();
    if (this.companyOutDay === today) return false;
    if (this.botOut.get(actorKeyOf(actor)) === today) return false;
    if (this.deptOut.get(deptId) === today) return false;
    if (taskId !== undefined && this.taskOut.has(taskId)) return false;
    return true;
  }

  mark(e: FallbackMark): void {
    let first = false;
    switch (e.kind) {
      case 'api_off':
        this.apiOff = { status: e.status };
        first = !this.refusedAlerted;
        this.refusedAlerted = true;
        break;
      case 'task_400':
        // Gate 2 G2-PV-02 (rule 10): its own claim, so a 400 anyone can cause never uses up the apiOff alert
        this.taskOut.add(e.taskId);
        first = !this.taskRefusedAlerted;
        this.taskRefusedAlerted = true;
        break;
      case 'api_busy':
        this.coolUntil = this.clock() + COOL_MS;
        first = !this.busyAlerted;
        this.busyAlerted = true;
        this.coolTimer = this.schedule(this.coolTimer, COOL_MS + EXPIRE_MARGIN_MS);
        break;
      case 'budget': {
        const today = this.day();
        if (e.scope === 'company') { first = this.companyOutDay !== today; this.companyOutDay = today; }
        else if (e.scope === 'bot') { const k = actorKeyOf(e.actor); first = this.botOut.get(k) !== today; this.botOut.set(k, today); }
        else { first = this.deptOut.get(e.dept) !== today; this.deptOut.set(e.dept, today); }
        if (!this.dayTimer) this.dayTimer = this.schedule(null, DAY_MS - (this.clock() % DAY_MS) + EXPIRE_MARGIN_MS);
        break;
      }
    }
    try {
      this.o.onMark?.(e, first);
    } catch {
      // an alert or audit hook must never change a mark
    }
  }

  /** One unref'd timer that replaces `prev`; when it fires the temporary marks are over and `onExpire` runs. */
  private schedule(prev: NodeJS.Timeout | null, ms: number): NodeJS.Timeout {
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      if (t === this.coolTimer) this.coolTimer = null;
      if (t === this.dayTimer) this.dayTimer = null;
      try {
        this.o.onExpire?.();
      } catch {
        // a re-offer hook must never break the gate
      }
    }, Math.min(ms, 2_000_000_000));
    t.unref();
    return t;
  }

  /** PV-C03: true once per task per hold episode (the immediate re-offer after a quota requeue). */
  claimReoffer(taskId: string): boolean {
    if (this.reoffered.has(taskId)) return false;
    this.reoffered.add(taskId);
    return true;
  }

  /** A fallback call was made this episode (the end alert reports API spend only then). */
  noteUsed(): void {
    this.used = true;
  }

  episodeUsed(): boolean {
    return this.used;
  }

  /** The hold ended (or a restart): every mark, flag and re-offer claim is dropped. */
  clear(): void {
    this.apiOff = null;
    this.coolUntil = 0;
    this.companyOutDay = null;
    this.botOut.clear();
    this.deptOut.clear();
    this.taskOut.clear();
    this.reoffered.clear();
    this.refusedAlerted = false;
    this.taskRefusedAlerted = false;
    this.busyAlerted = false;
    this.used = false;
    if (this.coolTimer) clearTimeout(this.coolTimer);
    if (this.dayTimer) clearTimeout(this.dayTimer);
    this.coolTimer = null;
    this.dayTimer = null;
  }
}

/** The outcome of one fallback-route call, as the three callers (loop, judge, helper call) see it. Structural, so this module imports nothing from agents/. */
export type FallbackCallOutcome = { kind: 'refused'; scope: string } | { kind: 'meter' } | { kind: 'done'; failed?: unknown };

/**
 * PV-C09: ONE place that turns a fallback-route outcome into gate marks, so the loop, the judge and the helper call cannot drift apart.
 * Returns `'wait'` when the work should wait for the hold (requeue, or a fail-fast for a helper): a mark was set, or it is a 400 of a run with
 * no task (no mark, PV-C06). Anything else returns null and the caller's existing flow runs (block, card, plain failure). A clean call notes
 * that the backup was used. Never throws.
 */
export function reportFallback(fb: FallbackState | undefined, ctx: { actor: ActorRef; deptId: string; taskId?: string | undefined }, o: FallbackCallOutcome): 'wait' | null {
  if (!fb) return null;
  try {
    if (o.kind === 'refused') {
      const m = markFromRefusal(o.scope, ctx.actor, ctx.deptId);
      if (!m) return null;
      fb.mark(m);
      return 'wait';
    }
    if (o.kind === 'meter') return null;
    if (o.failed === undefined) {
      fb.noteUsed?.();
      return null;
    }
    const m = markFromError(o.failed);
    if (!m) return null;
    if (m.kind === 'task_400') {
      if (ctx.taskId !== undefined) fb.mark({ kind: 'task_400', taskId: ctx.taskId });
      return 'wait';
    }
    fb.mark(m);
    return 'wait';
  } catch {
    return null;
  }
}
