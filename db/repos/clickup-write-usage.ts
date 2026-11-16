import type { Pool } from 'pg';

/**
 * CLICKUP-ALL-1 (C9): the durable daily cap on ClickUp writes (workspace mode only; list mode is not counted).
 * `day` is the calendar date in schedule.timezone, computed by the caller. `take` is one atomic upsert: the row lock serialises
 * concurrent takes, so the cap is never over-run. There is no give-back: a write that fails after `take` stays counted.
 */
export class ClickUpWriteUsage {
  constructor(private readonly pool: Pool) {}

  /** True when this call took one write of the day; false when the cap is reached or is 0 (writes off). A database error throws (the caller fails closed). */
  async take(day: string, cap: number): Promise<boolean> {
    if (!Number.isInteger(cap) || cap <= 0) return false;
    const r = await this.pool.query(
      `INSERT INTO clickup_write_usage(day, used) VALUES ($1, 1)
       ON CONFLICT (day) DO UPDATE SET used = clickup_write_usage.used + 1 WHERE clickup_write_usage.used < $2
       RETURNING used`, [day, cap]);
    return r.rowCount === 1;
  }

  async used(day: string): Promise<number> {
    return (await this.pool.query<{ used: number }>('SELECT used FROM clickup_write_usage WHERE day = $1', [day])).rows[0]?.used ?? 0;
  }
}
