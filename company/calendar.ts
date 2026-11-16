import type { ConfigStore } from '../config/store.js';

/**
 * Whether a day is off: a weekly off day (`schedule.offDays`) or a listed holiday (`schedule.holidays`, which carries its name).
 * A listed extra workday (`schedule.workDays`, set with /holiday workday) wins over both.
 */
export type OffDay = { off: boolean; reason?: 'weekday' | 'holiday' | 'workday'; name?: string };

export interface Calendar {
  isOffDay(now: number): OffDay;
}

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const FULL = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
const formats = new Map<string, Intl.DateTimeFormat>();

/** The calendar date (YYYY-MM-DD) and weekday (0 = Sunday) of instant `now` on the wall clock of `tz`. */
export function localDay(now: number, tz: string): { date: string; weekday: number } {
  let f = formats.get(tz);
  if (!f) formats.set(tz, (f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' })));
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, Number(x.value)]));
  const pad = (n: number) => String(n).padStart(2, '0');
  return { date: `${p.year}-${pad(p.month!)}-${pad(p.day!)}`, weekday: new Date(Date.UTC(p.year!, p.month! - 1, p.day!)).getUTCDay() };
}

/** Reads `schedule.timezone`, `schedule.offDays`, `schedule.holidays` and `schedule.workDays` on every call, so a config change applies without a restart. */
export function createCalendar(cfg: Pick<ConfigStore, 'get'>): Calendar {
  return {
    isOffDay(now) {
      const { date, weekday } = localDay(now, cfg.get('schedule.timezone'));
      if (cfg.get('schedule.workDays').includes(date)) return { off: false, reason: 'workday' };
      const h = cfg.get('schedule.holidays').find((x) => x.date === date);
      if (h) return { off: true, reason: 'holiday', ...(h.name ? { name: h.name } : {}) };
      return cfg.get('schedule.offDays').includes(weekday) ? { off: true, reason: 'weekday' } : { off: false };
    },
  };
}

/** `sat,sun`, `Fri Sat`, `monday` → sorted weekday numbers; `` or `none` → []; any unknown name → null. */
export function parseWeekdays(s: string): number[] | null {
  const words = s.trim().toLowerCase().split(/[\s,]+/).filter(Boolean);
  if (words.length === 1 && words[0] === 'none') return [];
  const out = new Set<number>();
  for (const w of words) {
    const i = Math.max(DAYS.indexOf(w as never), FULL.indexOf(w as never));
    if (i < 0) return null;
    out.add(i);
  }
  return [...out].sort((a, b) => a - b);
}

/** [0, 6] → `Sun, Sat`; [] → `none`. */
export const weekdayNames = (days: readonly number[]): string =>
  days.length ? [...days].sort((a, b) => a - b).map((d) => DAYS[d]![0]!.toUpperCase() + DAYS[d]!.slice(1)).join(', ') : 'none';

export interface OffDayWatchDeps {
  calendar: Calendar;
  clock: () => number;
  log: { info(o: unknown, m?: string): void; error?(o: unknown, m?: string): void };
  /** Called when an off day ends (the scheduler releases held work and the pending queue is re-checked). */
  onWorkday: () => void | Promise<void>;
  intervalMs?: number;
}

/**
 * Notices the day turning: one info log at the first check (boot) and one each time an off day starts or ends. Polls on a timer
 * rather than sleeping until midnight, so an injected clock, a time zone change and an edited holiday list are all picked up.
 */
export class OffDayWatch {
  private timer: NodeJS.Timeout | null = null;
  private last: boolean | null = null;
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly d: OffDayWatchDeps) {}

  start(): void {
    if (this.timer) return;
    this.check();
    this.timer = setInterval(() => void this.check(), this.d.intervalMs ?? 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Re-evaluates today; returns the current state. */
  check(): OffDay {
    const day = this.d.calendar.isOffDay(this.d.clock());
    const fields = { offDay: day.off, ...(day.reason ? { reason: day.reason } : {}), ...(day.name ? { name: day.name } : {}) };
    if (this.last === null) this.d.log.info(fields, day.off ? 'calendar: today is an off day' : 'calendar: today is a workday');
    else if (day.off !== this.last) this.d.log.info(fields, day.off ? 'off day started' : 'off day ended');
    const ended = this.last === true && !day.off;
    this.last = day.off;
    if (ended) {
      const failed = (err: unknown) => this.d.log.error?.({ err }, 'workday release failed');
      try {
        this.pending = Promise.resolve(this.d.onWorkday()).catch(failed);
      } catch (err) {
        failed(err);
      }
    }
    return day;
  }

  /** Resolves once the last workday release has finished (tests, shutdown). */
  idle(): Promise<void> {
    return this.pending;
  }
}
