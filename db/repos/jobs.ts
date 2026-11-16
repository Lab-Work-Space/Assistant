import type { Pool } from '../pool.js';
import { addCapped, type Caps } from './praw.js';

export type JobKind = 'daily' | 'interval' | 'once';
export interface ScheduledJob {
  id: number; guildId: string; channelId: string; userId: string; prompt: string; origin: 'schedule' | 'import';
  kind: JobKind; hhmm: string | null; tz: string | null; intervalMinutes: number | null;
  nextRunAt: Date; lastClaim: Date | null; active: boolean; legacyId: number | null; createdAt: Date;
}
export interface NewJob {
  guildId: string; channelId: string; userId: string; prompt: string; origin: 'schedule' | 'import'; kind: JobKind;
  hhmm?: string | null; tz?: string | null; intervalMinutes?: number | null; nextRunAt: Date; legacyId?: number | null;
}

const cols = (a = ''): string => `${a}id, ${a}guild_id AS "guildId", ${a}channel_id AS "channelId", ${a}user_id AS "userId", ${a}prompt, ${a}origin,
  ${a}kind, ${a}hhmm, ${a}tz, ${a}interval_minutes AS "intervalMinutes", ${a}next_run_at AS "nextRunAt", ${a}last_claim AS "lastClaim",
  ${a}active, ${a}legacy_id AS "legacyId", ${a}created_at AS "createdAt"`;

/** Offset (ms) of `tz` from UTC at instant `t`. */
function offsetMs(t: Date, tz: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    .formatToParts(t).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - Math.floor(t.getTime() / 1000) * 1000;
}

/** The instant at which the wall clock in `tz` reads `wallMs` (given as UTC fields); a second pass settles DST edges. */
export function wallToUtc(wallMs: number, tz: string): Date {
  const first = new Date(wallMs - offsetMs(new Date(wallMs), tz));
  return new Date(wallMs - offsetMs(first, tz));
}

/** First instant strictly after `after` whose wall clock in `tz` reads hh:mm. */
export function nextDaily(hhmm: string, tz: string, after: Date): Date {
  const zone = tz;
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const base = new Date(after.getTime() + offsetMs(after, zone));
  for (let d = 0; d < 3; d++) {
    const wall = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + d, h, m);
    let t = new Date(wall - offsetMs(new Date(wall), zone));
    t = new Date(wall - offsetMs(t, zone)); // second pass settles DST edges
    if (t.getTime() > after.getTime()) return t;
  }
  throw new Error(`cannot compute next run for ${hhmm} ${zone}`);
}

/** Next run after a claim at `at`, or null when the job is finished (once). */
export function nextRun(j: Pick<ScheduledJob, 'kind' | 'hhmm' | 'tz' | 'intervalMinutes'>, at: Date): Date | null {
  if (j.kind === 'once') return null;
  if (j.kind === 'interval') return new Date(at.getTime() + j.intervalMinutes! * 60_000);
  if (!j.tz) throw new Error('daily job without tz');
  return nextDaily(j.hhmm!, j.tz, at);
}

export class JobRepo {
  constructor(private readonly pool: Pool) {}

  async add(j: NewJob, caps: Caps | 'unlimited'): Promise<ScheduledJob | null> {
    return addCapped<ScheduledJob>(this.pool, 'scheduled_jobs', 'active', j.userId, caps, async (q) =>
      (await q(
        `INSERT INTO scheduled_jobs (guild_id, channel_id, user_id, prompt, origin, kind, hhmm, tz, interval_minutes, next_run_at, legacy_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (legacy_id) DO NOTHING RETURNING ${cols()}`,
        [j.guildId, j.channelId, j.userId, j.prompt, j.origin, j.kind, j.hhmm ?? null, j.tz ?? null, j.intervalMinutes ?? null, j.nextRunAt, j.legacyId ?? null],
      )).rows[0] ?? null);
  }

  async list(userId: string): Promise<ScheduledJob[]> {
    return (await this.pool.query<ScheduledJob>(`SELECT ${cols()} FROM scheduled_jobs WHERE user_id = $1 AND active ORDER BY next_run_at, id`, [userId])).rows;
  }

  async get(id: number): Promise<ScheduledJob | null> {
    return (await this.pool.query<ScheduledJob>(`SELECT ${cols()} FROM scheduled_jobs WHERE id = $1`, [id])).rows[0] ?? null;
  }

  /** Bot Admin removal of any job (the caller audits it). Hard delete. */
  async removeAny(id: number): Promise<boolean> {
    return (await this.pool.query('DELETE FROM scheduled_jobs WHERE id = $1', [id])).rowCount === 1;
  }

  /** Owner only (P14). Hard delete. */
  async remove(id: number, userId: string): Promise<boolean> {
    return (await this.pool.query('DELETE FROM scheduled_jobs WHERE id = $1 AND user_id = $2', [id, userId])).rowCount === 1;
  }

  /**
   * R11/PF12: claim by atomically advancing next_run_at (once jobs: deactivate). Rows are locked SKIP LOCKED and each
   * UPDATE is guarded by `next_run_at = <old>`, so concurrent callers never both win. Returns the pre-claim rows.
   */
  async claimDue(at: Date, limit: number): Promise<ScheduledJob[]> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const due = (await c.query<ScheduledJob>(
        `SELECT ${cols()} FROM scheduled_jobs WHERE active AND next_run_at <= $1 ORDER BY next_run_at, id LIMIT $2 FOR UPDATE SKIP LOCKED`, [at, limit])).rows;
      const won: ScheduledJob[] = [];
      for (const j of due) {
        const next = nextRun(j, at);
        const r = await c.query(
          'UPDATE scheduled_jobs SET next_run_at = COALESCE($3, next_run_at), active = ($3::timestamptz IS NOT NULL), last_claim = $4 WHERE id = $1 AND next_run_at = $2 AND active',
          [j.id, j.nextRunAt, next, at]);
        if (r.rowCount) won.push(j);
      }
      await c.query('COMMIT');
      return won;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  /** Explicit reschedule (e.g. after an edit). Owner-scoped when userId is given. */
  async reschedule(id: number, next: Date, userId?: string): Promise<boolean> {
    return (await this.pool.query(
      'UPDATE scheduled_jobs SET next_run_at = $2, active = true WHERE id = $1 AND ($3::text IS NULL OR user_id = $3)', [id, next, userId ?? null])).rowCount === 1;
  }
}
