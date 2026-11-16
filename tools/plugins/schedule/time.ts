import { nextDaily, type JobKind } from '../../../db/repos/jobs.js';
import { parseIsoWhen } from '../reminders/index.js';

export const MIN_INTERVAL_MINUTES = 15;
const MAX_INTERVAL_MINUTES = 525_600;
const YEAR_MS = 365 * 24 * 60 * 60_000;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export type RunSpec = { kind: JobKind; hhmm?: string; tz?: string; intervalMinutes?: number; at?: Date };

/**
 * The first run at or after `from` for a spec (DST-safe: the wall clock is resolved with Intl in db/repos/jobs). A daily run is
 * strictly after `from`; an interval is `from` plus the interval; a one-off is its own instant. The repo's `nextRun` is the
 * after-a-claim variant (null for a finished one-off); this is the planning variant.
 */
export function nextRun(spec: RunSpec, from: Date): Date {
  if (spec.kind === 'once') {
    if (!spec.at) throw new Error('once job without at');
    return spec.at;
  }
  if (spec.kind === 'interval') {
    if (!spec.intervalMinutes) throw new Error('interval job without intervalMinutes');
    return new Date(from.getTime() + spec.intervalMinutes * 60_000);
  }
  if (!spec.tz || !spec.hhmm) throw new Error('daily job needs hhmm and tz');
  return nextDaily(spec.hhmm, spec.tz, from);
}

export type JobPlan = { kind: JobKind; hhmm: string | null; tz: string | null; intervalMinutes: number | null; nextRunAt: Date };

/** Shared by the tools and `/schedule add`: validates the input and computes the first run. `at` is an ISO 8601 string. */
export function planJob(i: { kind: JobKind; hhmm?: string | undefined; intervalMinutes?: number | undefined; at?: string | undefined }, now: number, tz: string): JobPlan | { error: string } {
  if (i.kind === 'daily') {
    if (!i.hhmm || !HHMM.test(i.hhmm)) return { error: 'hhmm must be a 24-hour time like 09:00' };
    return { kind: 'daily', hhmm: i.hhmm, tz, intervalMinutes: null, nextRunAt: nextRun({ kind: 'daily', hhmm: i.hhmm, tz }, new Date(now)) };
  }
  if (i.kind === 'interval') {
    const n = i.intervalMinutes;
    if (n === undefined || !Number.isInteger(n) || n < MIN_INTERVAL_MINUTES || n > MAX_INTERVAL_MINUTES) return { error: `intervalMinutes must be a whole number from ${MIN_INTERVAL_MINUTES} to ${MAX_INTERVAL_MINUTES}` };
    return { kind: 'interval', hhmm: null, tz: null, intervalMinutes: n, nextRunAt: nextRun({ kind: 'interval', intervalMinutes: n }, new Date(now)) };
  }
  const ms = i.at ? parseIsoWhen(i.at, tz) : NaN;
  if (!Number.isFinite(ms)) return { error: 'at must be an ISO 8601 date-time like 2026-11-02T09:00' };
  if (ms <= now) return { error: 'that time is in the past' };
  if (ms > now + YEAR_MS) return { error: 'a one-off can be at most 1 year ahead' };
  return { kind: 'once', hhmm: null, tz: null, intervalMinutes: null, nextRunAt: new Date(ms) };
}
