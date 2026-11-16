import type { Calendar } from '../../company/calendar.js';
import { localDay } from '../../company/calendar.js';
import type { ActorRef } from '../../company/types.js';
import type { ConfigStore } from '../../config/store.js';
import type { BlockedCandidate, HealDay, HealRepo } from '../../db/repos/heal.js';
import type { BlockReason, Task, TaskRepo } from '../../db/repos/tasks.js';
import { escapeCardText } from '../../discord/embeds/approval.js';
import type { OutboundPayload } from '../loop/payload.js';
import { deciderOf } from './heal-actions.js';
import type { RetryResult } from './retry.js';

const MIN = 60_000;
const HOUR = 3_600_000;
/** HEAL-1 (spec 2.1): the first automatic retry comes this long after the block, every later one after RETRY_LATER. */
export const RETRY_FIRST_MS = 30 * MIN;
export const RETRY_LATER_MS = 2 * HOUR;
/** A transient block older than this is never retried blindly: it goes to the wake path. */
export const TRANSIENT_MAX_MS = 24 * HOUR;
/** No second wake for the same task inside this window. */
export const WAKE_GAP_MS = 30 * MIN;
/** At most this many tasks are acted on in one tick, so a backlog never bursts. */
export const PER_TICK = 3;
const CANDIDATES = 50;
/** The daily heal summary is posted at the first tick at or after this local hour (schedule.timezone). */
export const SUMMARY_HOUR = 18;
const LIST_MAX = 15;

export interface HealerDeps {
  repo: Pick<HealRepo, 'blockedCandidates' | 'claim' | 'autoretries' | 'wakes' | 'lastWakeAt' | 'deciderToday' | 'day'>;
  tasks: Pick<TaskRepo, 'get' | 'countOpenChildren'>;
  /** The shared `retryBlocked`, bound to its deps. */
  retry(taskId: string, o: { resetTurns: boolean }): Promise<RetryResult>;
  /** `Scheduler.healWake`. */
  wake(a: { blocked: Task; decider: ActorRef; runTask: Task | null; why?: string; n: number }): Promise<'started' | 'open_tasks' | 'skipped'>;
  isHealing(blockedId: string): boolean;
  canRun(): boolean;
  cfg: Pick<ConfigStore, 'get'>;
  calendar: Pick<Calendar, 'isOffDay'>;
  /** OPS-HOLD: whether the actor is held by the Claude quota hold (`Scheduler.isHeld`). A held owner is not retried, a held decider not woken (no claim is written; the next tick asks again). Absent: never held. */
  held?(actor: ActorRef): Promise<boolean>;
  /** OPS-HOLD: open, review and blocked task counts for the daily summary (`TaskRepo.dashboardCounts`). Absent: no line. */
  openCounts?(): Promise<{ open: number; review: number; blocked: number }>;
  /** OPS-HOLD: until when (epoch ms) the Claude quota hold lasts, or null. Absent: none. */
  holdUntil?(): number | null;
  /** Pending approvals of a task (TASKADMIN-1 `pendingApprovalCount`). */
  pendingApprovals(taskId: string): Promise<number>;
  daily: { claim(day: string, kind: 'heal'): Promise<boolean> };
  /** Posts the summary (hq to #bot-log). */
  post(p: OutboundPayload): Promise<unknown>;
  secrets?: readonly string[];
  now?: () => number;
  log: { error(o: unknown, msg: string): void };
}

type Plan =
  | { kind: 'retry'; n: number; reason: 'error' | 'turns' }
  | { kind: 'wake'; why?: string }
  | { kind: 'wait' }
  | { kind: 'none' };
export type Need = { id: string; title: string; reason: string; why: string };

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'unknown');

/**
 * HEAL-1 (spec 2.1, SA-1 3.1 to 3.3, Gate 1 HL-C10, HL-C16, HL-C17): the 60 s healer. Per tick: pre-conditions, the oldest 50 blocked rows, at most 3 acted on.
 * Retry (error, turns): by code, 30 min then 2 h after the block. Wake (owner, NULL, retries used up, older than 24 h, tree ended): the head that decides is woken.
 * Every cap is a claim row written BEFORE the action (awaited; a failed write skips the action). No model reaches this class.
 */
export class Healer {
  private running = false;
  /** The local day whose summary was already posted or claimed by this process (saves the queries; the claim row is the real guard). */
  private summarised: string | null = null;
  /** Tasks the last scan could not wake because the open-task limit was full (listed in the summary). */
  private readonly deferred = new Map<string, string>();

  constructor(private readonly d: HealerDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  /** HL-C17: switch on (a read error counts as off), the company running, not an off day. */
  private open(): boolean {
    try {
      if (this.d.cfg.get('heal.enabled') !== true) return false;
    } catch {
      return false;
    }
    return this.d.canRun() && !this.d.calendar.isOffDay(this.now()).off;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (!this.open()) return;
      await this.step('heal scan', () => this.scan());
      await this.step('heal summary', () => this.summary());
    } finally {
      this.running = false;
    }
  }

  private async step(what: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.d.log.error({ errName: errName(err) }, `${what} failed`);
    }
  }

  private limit(key: 'heal.maxRetries' | 'heal.maxWakesPerTask' | 'heal.maxWakesPerDeciderDay'): number {
    return this.d.cfg.get(key);
  }

  /** The decision for one row, from its reason, its age and the attempt count (SA-1 3.2 step 3). */
  private async classify(c: BlockedCandidate): Promise<Plan> {
    const t = c.task;
    const r: BlockReason = t.blockedReason ?? 'owner';
    if (r !== 'owner' && r !== 'error' && r !== 'turns') return { kind: 'none' }; // halt, budget, approval: never the healer's
    if ((await this.d.pendingApprovals(t.id)) > 0) return { kind: 'none' };
    const parent = t.parentId ? await this.d.tasks.get(t.parentId) : null;
    const root = t.rootId !== t.id ? await this.d.tasks.get(t.rootId) : null;
    const ended = (x: Task | null): boolean => !!x && (x.status === 'done' || x.status === 'cancelled');
    if (ended(parent) || ended(root)) return { kind: 'wake', why: 'its parent or root task has ended' };
    if (r === 'owner') return { kind: 'wake' };
    const maxRetries = this.limit('heal.maxRetries');
    const cap = r === 'turns' ? Math.min(1, maxRetries) : maxRetries;
    const n = await this.d.repo.autoretries(t.id);
    if (n >= cap) return { kind: 'wake', why: 'gave up after automatic retries' };
    const age = this.now() - c.updatedAt.getTime();
    if (age > TRANSIENT_MAX_MS) return { kind: 'wake', why: 'blocked for more than 24 hours' };
    return age >= (n === 0 ? RETRY_FIRST_MS : RETRY_LATER_MS) ? { kind: 'retry', n, reason: r } : { kind: 'wait' };
  }

  /** The wake gate (SA-1 3.2 step 5). `needs` = a task the owner must look at (listed in the summary); `wait` = later, or nothing to do. */
  private async wakePlan(c: BlockedCandidate): Promise<{ go: { decider: ActorRef; runTask: Task | null; n: number } } | { wait: true } | { needs: string }> {
    const t = c.task;
    const dec = await deciderOf(t, this.d);
    if (dec.path === 'none') return { needs: 'the CEO owns it' };
    if (dec.path === 'parent' && !dec.runnable) return { wait: true }; // the parent waits for an approval (SA-1 C3): no row, tried again later
    const wakes = await this.d.repo.wakes(t.id);
    if (wakes >= this.limit('heal.maxWakesPerTask')) return { needs: 'wake limit reached' };
    if (this.d.isHealing(t.id)) return { wait: true };
    const last = await this.d.repo.lastWakeAt(t.id);
    if (last && this.now() - last.getTime() < WAKE_GAP_MS) return { wait: true };
    const key = dec.actor.kind === 'head' ? `head:${dec.actor.dept}` : `persona:${dec.actor.personaId}`;
    if ((await this.d.repo.deciderToday(key, this.d.cfg.get('schedule.timezone'))) >= this.limit('heal.maxWakesPerDeciderDay')) return { needs: 'daily wake limit reached' };
    return { go: { decider: dec.actor, runTask: dec.path === 'parent' ? dec.runTask : null, n: wakes + 1 } };
  }

  private async scan(): Promise<void> {
    const rows = await this.d.repo.blockedCandidates(CANDIDATES);
    let acted = 0;
    for (const c of rows) {
      if (acted >= PER_TICK || !this.d.canRun()) break;
      const plan = await this.classify(c);
      if (plan.kind === 'retry') {
        if (await this.isHeld(c.task.owner)) continue; // OPS-HOLD: no claim, no attempt burned while the owner's provider is held
        acted++;
        await this.retry(c, plan);
      } else if (plan.kind === 'wake') {
        const g = await this.wakePlan(c);
        if ('go' in g) {
          if (await this.isHeld(g.go.decider)) continue; // OPS-HOLD: a held decider is not woken (it could not run)
          const res = await this.d.wake({ blocked: c.task, decider: g.go.decider, runTask: g.go.runTask, ...(plan.why ? { why: plan.why } : {}), n: g.go.n });
          if (res === 'open_tasks') this.deferred.set(c.task.id, 'open-task limit full');
          else this.deferred.delete(c.task.id);
          if (res === 'started') acted++;
        }
      }
    }
  }

  /** OPS-HOLD: a fault in the check reads as not held (the scheduler's own gate still applies). */
  private async isHeld(a: ActorRef): Promise<boolean> {
    try {
      return (await this.d.held?.(a)) === true;
    } catch {
      return false;
    }
  }

  /** HL-C10: the claim row first (awaited); a failed write skips the retry. A refused retry keeps its row. */
  private async retry(c: BlockedCandidate, p: Extract<Plan, { kind: 'retry' }>): Promise<void> {
    const reset = p.reason === 'turns';
    try {
      await this.d.repo.claim({ actor: 'system:healer', action: 'task.autoretry', taskId: c.task.id, tool: p.reason, outcome: `claim #${p.n + 1} ${p.reason}${reset ? ' reset_turns' : ''}` });
    } catch (err) {
      this.d.log.error({ errName: errName(err) }, 'heal retry claim failed');
      return;
    }
    await this.d.retry(c.task.id, { resetTurns: reset });
  }

  // ---- the daily summary (spec 2.5, HL-C20) --------------------------------------------------------------------------------------------------------

  private localHour(): number {
    const tz = this.d.cfg.get('schedule.timezone');
    return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(this.now()));
  }

  /** The tasks that need the owner: rows the healer will not act on again (the CEO's own, over a cap, no room for a decide task), and every R_TAINTED refusal of today. */
  async needs(day: HealDay): Promise<Need[]> {
    const out = new Map<string, Need>();
    for (const c of await this.d.repo.blockedCandidates(CANDIDATES)) {
      const t = c.task;
      const plan = await this.classify(c);
      let why: string | null = null;
      if (plan.kind === 'none') why = 'waiting for an approval';
      else if (plan.kind === 'wake') {
        const g = await this.wakePlan(c);
        if ('needs' in g) why = g.needs;
        else if (this.deferred.has(t.id)) why = this.deferred.get(t.id)!;
      }
      if (why) out.set(t.id, { id: t.id, title: t.title, reason: t.blockedReason ?? 'owner', why });
    }
    for (const x of day.tainted) if (!out.has(x.taskId)) out.set(x.taskId, { id: x.taskId, title: x.title, reason: 'owner', why: 'a person asked for it; a run that read outside text may not cancel it' });
    return [...out.values()];
  }

  /** Fixed text plus counts, ids and escaped titles. Never any note text (HL-C20). Null when nothing happened. */
  summaryPayload(day: HealDay, needs: Need[], status: { open?: string; hold?: string } = {}): OutboundPayload | null {
    const secrets = this.d.secrets ?? [];
    if (!day.retries && !day.wakes && !day.resolveRetry && !day.resolveCancel && !day.autoclosed && !needs.length && !status.hold) return null;
    const t = (s: string): string => escapeCardText(s.replace(/\s+/g, ' ').trim(), 60, secrets);
    const id8 = (id: string): string => id.slice(0, 8);
    const lines: string[] = [
      `Automatic retries: ${day.retries} (${day.unblocked} no longer blocked).`,
      `Heads woken to decide: ${day.wakes}. Decisions: ${day.resolveRetry} retried, ${day.resolveCancel} cancelled.`,
    ];
    const list = <T>(title: string, rows: T[], line: (r: T) => string): void => {
      if (!rows.length) return;
      lines.push('', title, ...rows.slice(0, LIST_MAX).map(line), ...(rows.length > LIST_MAX ? [`- and ${rows.length - LIST_MAX} more`] : []));
    };
    lines.push(`Reviews closed by code today: ${day.autoclosed}`);
    if (status.open) lines.push(status.open);
    if (status.hold) lines.push(status.hold);
    list('Cancelled by a head:', day.cancels, (r) => `- \`${id8(r.taskId)}\` "${t(r.title)}" by ${r.decider.replace(/[^a-z:_-]/gi, '').slice(0, 40)}`);
    list('Needs the owner:', needs, (r) => `- \`${id8(r.id)}\` "${t(r.title)}" (${r.reason}: ${r.why})`);
    return { type: 'alert', origin: 'governance', title: 'Heal summary', body: lines.join('\n') };
  }

  /** OPS-HOLD: the capacity and hold lines of the summary (counts and a timestamp only). A fault leaves the line out. */
  private async status(): Promise<{ open?: string; hold?: string }> {
    const out: { open?: string; hold?: string } = {};
    try {
      const c = await this.d.openCounts?.();
      if (c) out.open = `Open tasks: ${c.open}/${this.d.cfg.get('limits.openTasks')} (review ${c.review}, blocked ${c.blocked})`;
    } catch (err) {
      this.d.log.error({ errName: errName(err) }, 'heal summary counts failed');
    }
    const until = this.d.holdUntil?.() ?? null;
    if (until !== null) out.hold = `Claude quota hold: Claude-backed bots wait until <t:${Math.floor(until / 1000)}:R>.`;
    return out;
  }

  /** At or after 18:00 local: build first, claim only when there is something to say (an empty 18:00 must not use up the day), then post. */
  private async summary(): Promise<void> {
    const tz = this.d.cfg.get('schedule.timezone');
    const today = localDay(this.now(), tz).date;
    if (this.summarised === today || this.localHour() < SUMMARY_HOUR) return;
    const day = await this.d.repo.day(tz);
    const payload = this.summaryPayload(day, await this.needs(day), await this.status());
    if (!payload) return;
    if (!(await this.d.daily.claim(today, 'heal'))) {
      this.summarised = today;
      return;
    }
    this.summarised = today;
    await this.d.post(payload).catch((err: unknown) => this.d.log.error({ errName: errName(err) }, 'heal summary post failed'));
  }
}
