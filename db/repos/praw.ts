import type { Pool } from '../pool.js';

/** Per-user and company-wide caps for one table (P14); callers pass limits.*PerUser / limits.*Total from config. */
export interface Caps { perUser: number; total: number }

export class CapError extends Error {
  override readonly name = 'CapError';
  constructor(readonly scope: 'user' | 'total', readonly limit: number) {
    super(scope === 'user' ? `per-user limit of ${limit} reached` : `company limit of ${limit} reached`);
  }
}

/**
 * Count-then-insert under one transaction and a per-table advisory lock, so two concurrent adds cannot both pass the
 * boundary. `live` is the SQL predicate for rows that count toward the caps. `insert` runs on the locked client and
 * returns the new row, or null when the legacy_id already exists (import idempotency). 'unlimited' skips the check and must be passed visibly (imports only).
 */
export async function addCapped<T>(
  pool: Pool, table: string, live: string, userId: string, caps: Caps | 'unlimited',
  insert: (q: (sql: string, vals: unknown[]) => Promise<{ rows: T[] }>) => Promise<T | null>,
): Promise<T | null> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    if (caps !== 'unlimited') {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`praw:${table}`]);
      const n = (await c.query<{ u: number; t: number }>(
        `SELECT count(*) FILTER (WHERE user_id = $1)::int AS u, count(*)::int AS t FROM ${table} WHERE ${live}`, [userId])).rows[0]!;
      if (n.u >= caps.perUser) throw new CapError('user', caps.perUser);
      if (n.t >= caps.total) throw new CapError('total', caps.total);
    }
    const row = await insert((sql, vals) => c.query(sql, vals as never[]) as never);
    await c.query('COMMIT');
    return row;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

export type SeenKind = 'baseline' | 'tick' | 'created' | 'status_changed' | 'assigned' | 'comment';

/** Task 27: once-only ClickUp notices. `claim` is insert-or-skip, so a restart or an overlapping poller cannot announce a fact twice. */
export class ClickUpSeenRepo {
  constructor(private readonly pool: Pool) {}

  /** True when this call recorded the fact (it is new); false when it was already there. */
  async claim(taskId: string, kind: SeenKind, fingerprint: string, at: Date = new Date()): Promise<boolean> {
    return (await this.pool.query(
      'INSERT INTO clickup_seen (task_id, kind, fingerprint, seen_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [taskId, kind, fingerprint, at])).rowCount === 1;
  }

  /** Records many facts silently (the baseline); existing rows are left alone. */
  async claimMany(rows: { taskId: string; kind: SeenKind; fingerprint: string }[], at: Date): Promise<void> {
    for (let i = 0; i < rows.length; i += 500) {
      const part = rows.slice(i, i + 500);
      await this.pool.query(
        `INSERT INTO clickup_seen (task_id, kind, fingerprint, seen_at)
         SELECT t, k, f, $4 FROM unnest($1::text[], $2::text[], $3::text[]) AS x(t, k, f) ON CONFLICT DO NOTHING`,
        [part.map((r) => r.taskId), part.map((r) => r.kind), part.map((r) => r.fingerprint), at]);
    }
  }

  /** Gives a claim back when its notice could not be posted, so the next tick retries it. */
  async release(taskId: string, kind: SeenKind, fingerprint: string): Promise<void> {
    await this.pool.query('DELETE FROM clickup_seen WHERE task_id = $1 AND kind = $2 AND fingerprint = $3', [taskId, kind, fingerprint]);
  }

  async has(taskId: string, kind: SeenKind, fingerprint: string): Promise<boolean> {
    return (await this.pool.query('SELECT 1 FROM clickup_seen WHERE task_id = $1 AND kind = $2 AND fingerprint = $3', [taskId, kind, fingerprint])).rowCount === 1;
  }

  /**
   * When the silent baseline was taken; null before the first run. List mode: the one legacy row (fingerprint '1'). Workspace mode (CLICKUP-ALL-1):
   * one row per watched list, its list id as the fingerprint.
   */
  async baselineAt(listId?: string): Promise<Date | null> {
    return (await this.pool.query<{ seen_at: Date }>("SELECT seen_at FROM clickup_seen WHERE task_id = '*' AND kind = 'baseline' AND fingerprint = $1", [listId ?? '1'])).rows[0]?.seen_at ?? null;
  }

  /** Workspace mode: forgets a list's baseline row (the list is no longer watched), so watching it again later baselines it silently instead of announcing its old tasks as new. */
  async forgetBaseline(listId: string): Promise<void> {
    await this.pool.query("DELETE FROM clickup_seen WHERE task_id = '*' AND kind = 'baseline' AND fingerprint = $1", [listId]);
  }

  /** The comment window the last completed tick advanced to (ms epoch); null before the first one. */
  async lastTick(): Promise<number | null> {
    const r = (await this.pool.query<{ seen_at: Date }>("SELECT seen_at FROM clickup_seen WHERE task_id = '*' AND kind = 'tick'")).rows[0];
    return r ? r.seen_at.getTime() : null;
  }

  async saveTick(ms: number): Promise<void> {
    await this.pool.query(
      "INSERT INTO clickup_seen (task_id, kind, fingerprint, seen_at) VALUES ('*','tick','1',$1) ON CONFLICT (task_id, kind, fingerprint) DO UPDATE SET seen_at = EXCLUDED.seen_at", [new Date(ms)]);
  }

  /**
   * Drops facts older than `before` to bound the table; the baseline row is kept, and so is the state of every task in `liveTaskIds`
   * (dropping it would re-announce an old task's status). Comments are always prunable: the poller ignores comments older than the cutoff.
   */
  async prune(before: Date, liveTaskIds: string[]): Promise<number> {
    return (await this.pool.query(
      "DELETE FROM clickup_seen WHERE seen_at < $1 AND kind NOT IN ('baseline','tick') AND (kind = 'comment' OR task_id <> ALL($2::text[]))", [before, liveTaskIds])).rowCount ?? 0;
  }
}
