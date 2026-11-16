import type { Pool } from '../pool.js';
import { addCapped, type Caps } from './praw.js';

export interface Watch {
  id: number; guildId: string; channelId: string; userId: string; enabled: boolean; kind: 'url' | 'topic'; target: string;
  intervalMinutes: number; nextCheckAt: Date; lastSnapshot: string | null; lastHrefs: string[] | null; hasBaseline: boolean;
  failCount: number; legacyId: number | null; createdAt: Date;
}
export interface NewWatch {
  guildId: string; channelId: string; userId: string; kind: 'url' | 'topic'; target: string; intervalMinutes: number;
  nextCheckAt?: Date; legacyId?: number | null;
  /** Import only (Task 22): an imported watch can start disabled and carry its old baseline. */
  enabled?: boolean; lastSnapshot?: string | null; lastHrefs?: string[] | null; hasBaseline?: boolean;
}

const cols = (a = ''): string => `${a}id, ${a}guild_id AS "guildId", ${a}channel_id AS "channelId", ${a}user_id AS "userId", ${a}enabled, ${a}kind, ${a}target,
  ${a}interval_minutes AS "intervalMinutes", ${a}next_check_at AS "nextCheckAt", ${a}last_snapshot AS "lastSnapshot", ${a}last_hrefs AS "lastHrefs",
  ${a}has_baseline AS "hasBaseline", ${a}fail_count AS "failCount", ${a}legacy_id AS "legacyId", ${a}created_at AS "createdAt"`;
const COLS = cols();

export class WatchRepo {
  constructor(private readonly pool: Pool) {}

  async add(w: NewWatch, caps: Caps | 'unlimited'): Promise<Watch | null> {
    return addCapped<Watch>(this.pool, 'watches', 'enabled', w.userId, caps, async (q) =>
      (await q(
        `INSERT INTO watches (guild_id, channel_id, user_id, kind, target, interval_minutes, next_check_at, legacy_id, enabled, last_snapshot, last_hrefs, has_baseline)
         VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7, now()),$8,COALESCE($9, true),$10,$11::jsonb,COALESCE($12, false)) ON CONFLICT (legacy_id) DO NOTHING RETURNING ${COLS}`,
        [w.guildId, w.channelId, w.userId, w.kind, w.target, w.intervalMinutes, w.nextCheckAt ?? null, w.legacyId ?? null,
          w.enabled ?? null, w.lastSnapshot ?? null, w.lastHrefs ? JSON.stringify(w.lastHrefs) : null, w.hasBaseline ?? null],
      )).rows[0] ?? null);
  }

  async list(userId: string): Promise<Watch[]> {
    return (await this.pool.query<Watch>(`SELECT ${COLS} FROM watches WHERE user_id = $1 AND enabled ORDER BY id`, [userId])).rows;
  }

  async get(id: number): Promise<Watch | null> {
    return (await this.pool.query<Watch>(`SELECT ${COLS} FROM watches WHERE id = $1`, [id])).rows[0] ?? null;
  }

  /** Bot Admin removal of any watch (the caller audits it). Disables, like remove. */
  async removeAny(id: number): Promise<boolean> {
    return (await this.pool.query('UPDATE watches SET enabled = false WHERE id = $1 AND enabled', [id])).rowCount === 1;
  }

  /** Pushes the next check later (failure backoff); a disabled watch is left alone. */
  async postpone(id: number, until: Date): Promise<void> {
    await this.pool.query('UPDATE watches SET next_check_at = $2 WHERE id = $1 AND enabled', [id, until]);
  }

  /** Owner only (P14). Disables rather than deletes, so a stale in-flight check cannot resurrect it. */
  async remove(id: number, userId: string): Promise<boolean> {
    return (await this.pool.query('UPDATE watches SET enabled = false WHERE id = $1 AND user_id = $2 AND enabled', [id, userId])).rowCount === 1;
  }

  /** R11/PF12: claim by advancing next_check_at to at + interval in the same locked UPDATE; returns the claimed rows. */
  async claimDue(at: Date, limit: number): Promise<Watch[]> {
    return (await this.pool.query<Watch>(
      `WITH due AS (SELECT id FROM watches WHERE enabled AND next_check_at <= $1 ORDER BY next_check_at, id LIMIT $2 FOR UPDATE SKIP LOCKED)
       UPDATE watches w SET next_check_at = $1::timestamptz + w.interval_minutes * interval '1 minute'
       FROM due WHERE w.id = due.id RETURNING ${cols('w.')}`,
      [at, limit],
    )).rows;
  }

  /**
   * Stores the latest check result; resets the failure count and marks the baseline as taken. A column that is not passed keeps its
   * value (an empty search must not erase the stored hrefs). A disabled watch is left alone; false then.
   */
  async saveSnapshot(id: number, s: { snapshot?: string | null; hrefs?: string[] | null }): Promise<boolean> {
    return (await this.pool.query(
      'UPDATE watches SET last_snapshot = COALESCE($2, last_snapshot), last_hrefs = COALESCE($3::jsonb, last_hrefs), has_baseline = true, fail_count = 0 WHERE id = $1 AND enabled',
      [id, s.snapshot ?? null, s.hrefs ? JSON.stringify(s.hrefs) : null])).rowCount === 1;
  }

  /** Counts a failed check; disables the watch once failCount reaches maxFails. Null for a watch that is already disabled. */
  async recordFailure(id: number, maxFails: number): Promise<{ failCount: number; enabled: boolean } | null> {
    return (await this.pool.query<{ failCount: number; enabled: boolean }>(
      'UPDATE watches SET fail_count = fail_count + 1, enabled = enabled AND fail_count + 1 < $2 WHERE id = $1 AND enabled RETURNING fail_count AS "failCount", enabled', [id, maxFails])).rows[0] ?? null;
  }
}
