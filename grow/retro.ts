import { randomUUID } from 'node:crypto';
import type { Calendar } from '../company/calendar.js';
import { localDay } from '../company/calendar.js';
import type { ConfigStore } from '../config/store.js';
import type { Org } from '../company/org.js';
import { addDays, isoWeekKey, localTime } from '../governance/spend/spend.js';
import type { RetroKind, RetroRepo } from '../db/repos/grow.js';
import type { AuditFn } from '../governance/audit.js';

const DAY_MS = 86_400_000;

/**
 * The retro slot that is due at `now`, or null (SA-1 3.1). The weekday setting is ISO (1 = Monday .. 7 = Sunday; `localDay` counts 0 = Sunday). The slot day is the latest
 * day on or before today that has that weekday. On the slot day it is due from the hour on. On a later day it is a CATCH-UP, due only when the slot day and every
 * day since were off days (today is the first workday after the slot): a Friday holiday plus the weekend runs on Monday, under the previous week's key. A workday that
 * was simply missed (the app was down, the head offline) is not caught up. The week key is the ISO week-year key of the slot date (2027-01-01 is `2026-W53`).
 */
export function retroSlot(now: number, cfg: Pick<ConfigStore, 'get'>, isOff: (at: number) => boolean): { week: string; slotDate: string } | null {
  const tz = cfg.get('schedule.timezone');
  const { date, weekday } = localDay(now, tz);
  const iso = weekday === 0 ? 7 : weekday;
  const W = cfg.get('grow.retro.weekday');
  const H = cfg.get('grow.retro.hour');
  const k = (iso - W + 7) % 7;
  if (Number(localTime(now, tz).slice(0, 2)) < H) return null;
  for (let j = 1; j <= k; j++) if (!isOff(now - j * DAY_MS)) return null;
  const slotDate = addDays(date, -k);
  return { week: isoWeekKey(slotDate), slotDate };
}

/** LEARN-1 (D4a): what `/retro run` gets back. A bare string is a refusal of the whole request. */
export type RequestResult = { dept: string; result: 'queued' | 'exists' | 'not_eligible' }[] | 'halted' | 'off' | 'unknown';
const DEPT_ID = /^[a-z_]{1,32}$/;

export interface WeeklyRetroDeps {
  cfg: Pick<ConfigStore, 'get'>;
  calendar: Pick<Calendar, 'isOffDay'>;
  org: Pick<Org, 'heads' | 'dept'>;
  repo: Pick<RetroRepo, 'claim' | 'claimed' | 'finish' | 'request' | 'nextRequested' | 'assign' | 'expireRequested' | 'incidentsSinceLastRetro'>;
  /** LEARN-1: the audit row of a request (`grow.retro.request`). Absent in tests that do not look at it. */
  audit?: AuditFn;
  /** Whether the company may run (not halted, not paused, provider ready). */
  canRun: () => boolean;
  /** LEARN-1: the halt flag alone, for the `/retro run` reply 'halted'. Absent: `!canRun()` stands in for it. */
  isHalted?: () => boolean;
  /** A head that is not online starts no retro. */
  online?: (dept: string) => boolean;
  limits: { checkOpenTasks(): Promise<boolean> };
  /** Scheduler.retroStart. 'skipped' = the task or the run could not start; the claim is then marked failed. */
  start: (a: { dept: string; week: string; taskId: string; kind?: RetroKind }) => Promise<'started' | 'skipped'>;
  now?: () => number;
  log: { error(o: unknown, m?: string): void };
}

/**
 * GROW-1 (SA-1 3.1): the weekly retro timer, ticked every 60 s. One retro per department per ISO week (the claim row decides, restart safe), at most one department
 * starts per tick. A failed run keeps its claim and is not retried that week. Praw and departments without an online head never run.
 */
export class WeeklyRetro {
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;

  constructor(private readonly d: WeeklyRetroDeps) {}

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch((err: unknown) => this.d.log.error({ errName: err instanceof Error ? err.name : 'error' }, 'weekly retro tick failed')), intervalMs);
    this.timer.unref?.();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** The day key shared by every on-demand retro (manual and incident): one claim per department per local day. */
  private dayKey(now: number): string {
    return `D${localDay(now, this.d.cfg.get('schedule.timezone')).date}`;
  }

  /**
   * LEARN-1 (D4a, LL-C7): queue an on-demand retro. Called only by the `/retro run` command after `decide()` (Bot Admin, #setting). Nothing starts here: the tick starts it on a workday.
   * A repo error propagates to the caller (the command replies with its fixed failure text). Every target is audited.
   */
  async request(dept: string | null, by: string): Promise<RequestResult> {
    if (this.d.isHalted ? this.d.isHalted() : !this.d.canRun()) return 'halted';
    let on = false;
    try {
      on = this.d.cfg.get('grow.retro.enabled') === true;
    } catch {
      on = false;
    }
    if (!on) return 'off';
    if (dept !== null && (!DEPT_ID.test(dept) || !this.d.org.dept(dept))) return 'unknown';
    const heads = this.d.org.heads().filter((h) => h.enabled && h.id !== 'praw');
    const targets = dept === null ? heads.map((h) => h.id) : [dept];
    const key = this.dayKey((this.d.now ?? Date.now)());
    const out: { dept: string; result: 'queued' | 'exists' | 'not_eligible' }[] = [];
    for (const t of targets) {
      if (!heads.some((h) => h.id === t)) { out.push({ dept: t, result: 'not_eligible' }); continue; }
      const queued = await this.d.repo.request(t, key, 'manual');
      out.push({ dept: t, result: queued ? 'queued' : 'exists' });
      await this.d.audit?.({ actor: by, action: 'grow.retro.request', tool: t, outcome: queued ? 'manual queued' : 'manual exists' }).catch(() => undefined);
    }
    return out;
  }

  /** One check; returns the department that started, or null. Never throws on the gate (a config read error counts as off). At most one start per tick. */
  async tick(): Promise<string | null> {
    if (this.busy) return null;
    this.busy = true;
    try {
      const now = (this.d.now ?? Date.now)();
      let slot: ReturnType<typeof retroSlot>;
      try {
        if (this.d.cfg.get('grow.retro.enabled') !== true || !this.d.canRun() || this.d.calendar.isOffDay(now).off) return null;
        slot = retroSlot(now, this.d.cfg, (at) => this.d.calendar.isOffDay(at).off);
      } catch {
        return null;
      }
      if (slot) {
        for (const dept of this.d.org.heads()) {
          if (!dept.enabled || dept.id === 'praw' || (this.d.online && !this.d.online(dept.id))) continue;
          if (await this.d.repo.claimed(dept.id, slot.week)) continue;
          if (!(await this.d.limits.checkOpenTasks())) return null; // no claim written: the next tick retries
          const taskId = randomUUID();
          try {
            if (!(await this.d.repo.claim(dept.id, slot.week, taskId))) continue;
          } catch (err) {
            this.d.log.error({ errName: err instanceof Error ? err.name : 'error' }, 'retro claim failed');
            return null;
          }
          await this.begin(dept.id, slot.week, taskId, 'weekly');
          return dept.id;
        }
      }
      return await this.onDemand(now);
    } finally {
      this.busy = false;
    }
  }

  /** `start` plus the claim bookkeeping shared by every kind: a skipped or thrown start marks the claim failed. */
  private async begin(dept: string, key: string, taskId: string, kind: RetroKind): Promise<void> {
    let r: 'started' | 'skipped' = 'skipped';
    try {
      r = await this.d.start({ dept, week: key, taskId, kind });
    } catch (err) {
      this.d.log.error({ errName: err instanceof Error ? err.name : 'error' }, 'retro start failed');
    }
    if (r === 'skipped') await this.d.repo.finish(dept, key, 'failed').catch(() => undefined);
  }

  /** LEARN-1 steps 3 to 5: expire old requests, queue incident retros, start the oldest queued one. Any store error logs `errName` and ends the step. */
  private async onDemand(now: number): Promise<string | null> {
    try {
      await this.d.repo.expireRequested();
      let threshold = 0;
      try {
        const v = this.d.cfg.get('grow.retro.incidentThreshold');
        threshold = typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0;
      } catch {
        threshold = 0;
      }
      if (threshold > 0) {
        const key = this.dayKey(now);
        for (const dept of this.d.org.heads()) {
          if (!dept.enabled || dept.id === 'praw') continue;
          if ((await this.d.repo.incidentsSinceLastRetro(dept.id)) < threshold) continue;
          if (await this.d.repo.request(dept.id, key, 'incident')) await this.d.audit?.({ actor: 'system:retro', action: 'grow.retro.request', tool: dept.id, outcome: 'incident queued' }).catch(() => undefined);
        }
      }
      for (const row of await this.d.repo.nextRequested()) {
        const dept = this.d.org.dept(row.deptId);
        if (!dept || !dept.enabled || dept.id === 'praw' || (this.d.online && !this.d.online(dept.id))) continue; // stays queued until it expires
        if (!(await this.d.limits.checkOpenTasks())) return null; // stays queued
        const taskId = randomUUID();
        if (!(await this.d.repo.assign(row.deptId, row.week, taskId))) continue; // CAS lost: skip this row this tick
        await this.begin(row.deptId, row.week, taskId, row.kind);
        return row.deptId;
      }
      return null;
    } catch (err) {
      this.d.log.error({ errName: err instanceof Error ? err.name : 'error' }, 'on-demand retro step failed');
      return null;
    }
  }
}
