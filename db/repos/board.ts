import type { Pool } from '../pool.js';

export interface BoardMessage {
  channelId: string;
  messageId: string;
  digest: string | null;
}

/** Ids and a digest of the pinned summary board(s); never message text (Gate 1 TW16). */
export class BoardMessageRepo {
  constructor(private readonly pool: Pool) {}

  async get(key: string): Promise<BoardMessage | null> {
    return (await this.pool.query<BoardMessage>(
      'SELECT channel_id AS "channelId", message_id AS "messageId", digest FROM board_messages WHERE key = $1', [key],
    )).rows[0] ?? null;
  }

  async set(key: string, m: BoardMessage): Promise<void> {
    await this.pool.query(
      `INSERT INTO board_messages (key, channel_id, message_id, digest) VALUES ($1,$2,$3,$4)
       ON CONFLICT (key) DO UPDATE SET channel_id = EXCLUDED.channel_id, message_id = EXCLUDED.message_id, digest = EXCLUDED.digest, updated_at = now()`,
      [key, m.channelId, m.messageId, m.digest],
    );
  }

  async setDigest(key: string, digest: string): Promise<void> {
    await this.pool.query('UPDATE board_messages SET digest = $2, updated_at = now() WHERE key = $1', [key, digest]);
  }
}

export type DailyKind = 'goal' | 'report' | 'heal' | 'ai_digest';

/** Gate 1 WS11: the claim of a daily run (one row per local date and kind) and the report text kept for the next run. */
export class DailyRunRepo {
  constructor(private readonly pool: Pool) {}

  /** True exactly once per (day, kind). */
  async claim(day: string, kind: DailyKind): Promise<boolean> {
    return (await this.pool.query('INSERT INTO daily_runs (day, kind) VALUES ($1,$2) ON CONFLICT DO NOTHING', [day, kind])).rowCount === 1;
  }

  async save(day: string, kind: DailyKind, body: string): Promise<void> {
    await this.pool.query('UPDATE daily_runs SET body = $3 WHERE day = $1 AND kind = $2', [day, kind, body.slice(0, 4000)]);
  }

  /** The newest saved report of a day before `day` (a weekend or holiday is skipped over). */
  async lastReport(day: string): Promise<string | null> {
    return (await this.pool.query<{ body: string }>("SELECT body FROM daily_runs WHERE kind = 'report' AND day < $1 AND body IS NOT NULL ORDER BY day DESC LIMIT 1", [day])).rows[0]?.body ?? null;
  }
}
