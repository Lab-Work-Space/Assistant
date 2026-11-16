import type { Pool } from '../pool.js';

export const LINK_TTL_MINUTES = 5;
export const LINKS_PER_WINDOW = 3;
export const LINK_WINDOW_MINUTES = 10;
export const SESSION_IDLE_HOURS = 8;
export const SESSION_ABSOLUTE_HOURS = 24;

export interface DashSession {
  userId: string;
  createdAt: Date;
  roleCheckedAt: Date;
}

/** What the dashboard keeps in the database: hashed login links and hashed sessions (Gate 1 S41-S43). Hashes only, never a raw token. */
export interface DashboardStore {
  /** Invalidates the admin's earlier unused links, then stores this one; `rate` when the admin already took 3 in 10 minutes. */
  issueLink(userId: string, tokenHash: string): Promise<{ ok: true } | { ok: false; reason: 'rate' }>;
  /** One atomic UPDATE ... RETURNING: a link is consumed once, while unexpired. */
  consumeLink(tokenHash: string): Promise<string | null>;
  createSession(sidHash: string, userId: string): Promise<void>;
  /** Null when the session is unknown, idle for 8 h or older than 24 h. A hit refreshes `last_seen`. */
  touchSession(sidHash: string): Promise<DashSession | null>;
  markRoleChecked(sidHash: string): Promise<void>;
  revokeSession(sidHash: string): Promise<void>;
  /** Returns how many sessions were deleted. */
  revokeUser(userId: string): Promise<number>;
  /** Deletes expired links and sessions; returns how many sessions expired (the caller audits the count, S51). */
  purge(): Promise<number>;
}

export class DashboardRepo implements DashboardStore {
  constructor(private readonly pool: Pool) {}

  async issueLink(userId: string, tokenHash: string): Promise<{ ok: true } | { ok: false; reason: 'rate' }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`dash-link:${userId}`]);
      const n = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM dash_login_tokens WHERE user_id = $1 AND created_at > now() - $2 * interval '1 minute'`, [userId, LINK_WINDOW_MINUTES]);
      if ((n.rows[0]?.n ?? 0) >= LINKS_PER_WINDOW) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'rate' };
      }
      await client.query('UPDATE dash_login_tokens SET used = true WHERE user_id = $1 AND NOT used', [userId]);
      await client.query(`INSERT INTO dash_login_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, now() + $3 * interval '1 minute')`, [tokenHash, userId, LINK_TTL_MINUTES]);
      await client.query('COMMIT');
      return { ok: true };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async consumeLink(tokenHash: string): Promise<string | null> {
    const r = await this.pool.query<{ user_id: string }>(
      'UPDATE dash_login_tokens SET used = true WHERE token_hash = $1 AND used = false AND expires_at > now() RETURNING user_id', [tokenHash]);
    return r.rows[0]?.user_id ?? null;
  }

  async createSession(sidHash: string, userId: string): Promise<void> {
    await this.pool.query('INSERT INTO dash_sessions (sid_hash, user_id) VALUES ($1, $2)', [sidHash, userId]);
  }

  async touchSession(sidHash: string): Promise<DashSession | null> {
    const r = await this.pool.query<{ user_id: string; created_at: Date; role_checked_at: Date }>(
      `UPDATE dash_sessions SET last_seen = now()
       WHERE sid_hash = $1 AND last_seen > now() - $2 * interval '1 hour' AND created_at > now() - $3 * interval '1 hour'
       RETURNING user_id, created_at, role_checked_at`, [sidHash, SESSION_IDLE_HOURS, SESSION_ABSOLUTE_HOURS]);
    const row = r.rows[0];
    return row ? { userId: row.user_id, createdAt: row.created_at, roleCheckedAt: row.role_checked_at } : null;
  }

  async markRoleChecked(sidHash: string): Promise<void> {
    await this.pool.query('UPDATE dash_sessions SET role_checked_at = now() WHERE sid_hash = $1', [sidHash]);
  }

  async revokeSession(sidHash: string): Promise<void> {
    await this.pool.query('DELETE FROM dash_sessions WHERE sid_hash = $1', [sidHash]);
  }

  async revokeUser(userId: string): Promise<number> {
    return (await this.pool.query('DELETE FROM dash_sessions WHERE user_id = $1', [userId])).rowCount ?? 0;
  }

  async purge(): Promise<number> {
    await this.pool.query(`DELETE FROM dash_login_tokens WHERE expires_at < now() - interval '1 day'`);
    const r = await this.pool.query(`DELETE FROM dash_sessions WHERE last_seen < now() - $1 * interval '1 hour' OR created_at < now() - $2 * interval '1 hour'`, [SESSION_IDLE_HOURS, SESSION_ABSOLUTE_HOURS]);
    return r.rowCount ?? 0;
  }
}

/** The stored panel message (S37b). */
export class PanelStateRepo {
  constructor(private readonly pool: Pool) {}
  async get(): Promise<{ channelId: string; messageId: string; postedAt: Date } | null> {
    const r = await this.pool.query<{ channel_id: string; message_id: string; posted_at: Date }>(`SELECT channel_id, message_id, posted_at FROM panel_state WHERE id = 'main'`);
    const row = r.rows[0];
    return row ? { channelId: row.channel_id, messageId: row.message_id, postedAt: row.posted_at } : null;
  }
  async set(channelId: string, messageId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO panel_state (id, channel_id, message_id) VALUES ('main', $1, $2)
       ON CONFLICT (id) DO UPDATE SET channel_id = $1, message_id = $2, posted_at = now()`, [channelId, messageId]);
  }
}
