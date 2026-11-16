/**
 * Dev-job limits (Gate 1 self-code X24): at most 1 running job, 10 per day (failed and refused count), 3 per requester per day, the monthly
 * budget, a rate limit on bursts of refused proposals, the halt switch and off-days (jobs queue). Pure decisions over counts read from the
 * database; the counts include every job row ever created, so a refused or failed job still uses up the day.
 */
export const MAX_RUNNING = 1;
export const MAX_PER_DAY = 10;
export const MAX_PER_REQUESTER_PER_DAY = 3;
export const REFUSED_BURST = 5;
export const REFUSED_WINDOW_MS = 10 * 60_000;

export interface LimitCounts { day: number; requesterDay: number; monthSpendUsd: number }
export const utcDayStart = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
export const utcMonthStart = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/** A reason to refuse the request now, or null. */
export function admission(c: LimitCounts, o: { budgetUsd: number }): string | null {
  if (c.day >= MAX_PER_DAY) return `at most ${MAX_PER_DAY} dev jobs per day (failed and refused ones count)`;
  if (c.requesterDay >= MAX_PER_REQUESTER_PER_DAY) return `at most ${MAX_PER_REQUESTER_PER_DAY} dev jobs per person per day`;
  if (c.monthSpendUsd >= o.budgetUsd) return 'the monthly dev-job budget is used up';
  return null;
}

/** Whether a queued job may start now: not halted, not an off day, nothing else running. */
export function mayStart(o: { running: number; halted: boolean; offDay: boolean }): { start: true } | { start: false; why: 'halted' | 'off day' | 'busy' } {
  if (o.halted) return { start: false, why: 'halted' };
  if (o.offDay) return { start: false, why: 'off day' };
  if (o.running >= MAX_RUNNING) return { start: false, why: 'busy' };
  return { start: true };
}

/** Per-requester burst limiter for refused proposals. */
export class RefusalGate {
  private readonly at = new Map<string, number[]>();
  constructor(private readonly now: () => number = Date.now) {}
  /** True when this requester is already over the burst limit (the request is dropped without more work). */
  blocked(user: string): boolean {
    const t = this.now();
    const l = (this.at.get(user) ?? []).filter((x) => t - x < REFUSED_WINDOW_MS);
    this.at.set(user, l);
    return l.length >= REFUSED_BURST;
  }
  noteRefused(user: string): void {
    const l = this.at.get(user) ?? [];
    l.push(this.now());
    this.at.set(user, l);
  }
}
