import type { Pool } from '../pool.js';

export type ProvenanceRow = { tainted: boolean; userId: string | null; /** RF4: posted as a run's answer (deliver), so a reply to it routes back to its bot. */ answer?: boolean };

/** Rows older than this are dropped: they are past any history window the loop reads. */
const KEEP_DAYS = 14;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

/** G2-04: which bot messages came from a tainted run. Written by the scheduler after a post, read by the loop for the history. */
export class BotMessageRepo {
  private prunedAt = 0;
  constructor(private readonly pool: Pool, private readonly now: () => number = Date.now) {}

  async record(messageId: string, channelId: string, tainted: boolean, triggerUserId: string | null = null, answer = false): Promise<void> {
    await this.pool.query(
      'INSERT INTO bot_messages (message_id, channel_id, tainted, trigger_user_id, answer) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (message_id) DO UPDATE SET tainted = bot_messages.tainted OR EXCLUDED.tainted, answer = bot_messages.answer OR EXCLUDED.answer',
      [messageId, channelId, tainted, triggerUserId, answer],
    );
    if (this.now() - this.prunedAt > PRUNE_EVERY_MS) {
      this.prunedAt = this.now();
      await this.prune();
    }
  }

  /** Message id -> taint and trigger user, for the ids that have a row; an id missing from the map is unknown. */
  async lookup(ids: string[]): Promise<Map<string, ProvenanceRow>> {
    if (!ids.length) return new Map();
    const r = await this.pool.query<{ id: string; tainted: boolean; userId: string | null; answer: boolean }>('SELECT message_id AS id, tainted, trigger_user_id AS "userId", answer FROM bot_messages WHERE message_id = ANY($1::text[])', [ids]);
    return new Map(r.rows.map((x) => [x.id, { tainted: x.tainted, userId: x.userId, answer: x.answer }]));
  }

  async prune(): Promise<number> {
    return (await this.pool.query(`DELETE FROM bot_messages WHERE created_at < now() - interval '${KEEP_DAYS} days'`)).rowCount ?? 0;
  }
}
