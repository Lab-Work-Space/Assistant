import type { Pool } from '../pool.js';

export type OutboxKind = 'welcome.post' | 'alert' | 'summary' | 'deploy.result' | 'code.result';
export interface OutboxRow {
  id: number;
  kind: OutboxKind;
  payload: Record<string, unknown>;
  createdAt: Date;
}

/** Audit actions that carry a member id: kept for 90 days (Gate 1 S33). */
export const MEMBER_AUDIT_PREFIXES = ['welcome.', 'server.member.', 'server.msg.', 'perm.role.'] as const;
export const MEMBER_AUDIT_DAYS = 90;

/**
 * The executor's own state and its messages to the main application (migration 014): the welcome raid pause (S13), the one-welcome-per-24h
 * dedupe (S11), the executor's archive record (S16) and the outbox the main application posts from (the executor has no Send Messages).
 */
export class ExecRepo {
  constructor(private readonly pool: Pool) {}

  async getState<T = unknown>(key: string): Promise<T | null> {
    const r = await this.pool.query<{ value: T }>('SELECT value FROM exec_state WHERE key = $1', [key]);
    return r.rows[0]?.value ?? null;
  }
  async setState(key: string, value: unknown): Promise<void> {
    await this.pool.query(
      `INSERT INTO exec_state (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
  }
  async clearState(key: string): Promise<boolean> {
    return ((await this.pool.query('DELETE FROM exec_state WHERE key = $1', [key])).rowCount ?? 0) > 0;
  }

  /** S11: true only for the first welcome of a user id in 24 h (one atomic upsert). */
  async firstWelcome(userId: string): Promise<boolean> {
    const r = await this.pool.query(
      `INSERT INTO welcome_seen (user_id, at) VALUES ($1, now())
       ON CONFLICT (user_id) DO UPDATE SET at = now() WHERE welcome_seen.at < now() - interval '24 hours'
       RETURNING user_id`,
      [userId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async recordArchive(channelId: string, by: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO server_archives (channel_id, archived_by) VALUES ($1, $2) ON CONFLICT (channel_id) DO UPDATE SET archived_at = now(), archived_by = EXCLUDED.archived_by`,
      [channelId, by],
    );
  }

  async push(kind: OutboxKind, payload: Record<string, unknown>): Promise<void> {
    await this.pool.query('INSERT INTO exec_outbox (kind, payload) VALUES ($1, $2::jsonb)', [kind, JSON.stringify(payload)]);
  }
  async pending(limit = 20): Promise<OutboxRow[]> {
    return (await this.pool.query<OutboxRow>(`SELECT id, kind, payload, created_at AS "createdAt" FROM exec_outbox WHERE done_at IS NULL ORDER BY id LIMIT $1`, [limit])).rows;
  }
  /** True for the one caller that marked it done (two pumps never post twice). */
  async markDone(id: number): Promise<boolean> {
    return ((await this.pool.query('UPDATE exec_outbox SET done_at = now() WHERE id = $1 AND done_at IS NULL', [id])).rowCount ?? 0) > 0;
  }

  /** S33: removes member-id-bearing audit rows older than 90 days and nothing else; also finished outbox rows and old dedupe rows. */
  async purge(): Promise<{ audit: number }> {
    const like = MEMBER_AUDIT_PREFIXES.map((p) => `${p}%`);
    // G2SM-08: refusal rows quote member ids too (`refused card:<id> ... target <id>`).
    const a = await this.pool.query(`DELETE FROM audit_log WHERE ts < now() - $1 * interval '1 day' AND (action LIKE ANY($2::text[]) OR action = 'admin.exec' OR (action IN ('admin.card', 'admin.propose') AND outcome LIKE 'refused%'))`, [MEMBER_AUDIT_DAYS, like]);
    await this.pool.query(`DELETE FROM exec_outbox WHERE done_at IS NOT NULL AND done_at < now() - interval '7 days'`);
    await this.pool.query(`DELETE FROM welcome_seen WHERE at < now() - interval '7 days'`);
    return { audit: a.rowCount ?? 0 };
  }
}
