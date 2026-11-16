import { randomBytes } from 'node:crypto';
import type { Pool } from '../pool.js';

/** SK10: the one list of card kinds; the migration that lands last writes exactly this union into admin_cards_kind_check (a test compares them). */
export const ADMIN_CARD_KINDS = ['config', 'admin_op', 'perm', 'server', 'knowledge', 'deploy', 'code', 'skill'] as const;
export type AdminCardKind = (typeof ADMIN_CARD_KINDS)[number];
/** Which front end proposed a card; set by code, never by the model. The Discord click audits it as `user:<id> via <via>`. */
export type AdminVia = 'praw' | 'panel' | 'dashboard';
export type AdminCardStatus = 'pending' | 'confirmed' | 'cancelled' | 'expired' | 'superseded';

export interface AdminCard {
  seq: number;
  id: string;
  proposerId: string;
  kind: AdminCardKind;
  payload: unknown;
  snapshot: unknown;
  tainted: boolean;
  channelId: string;
  messageId: string | null;
  status: AdminCardStatus;
  /** 'dashboard': proposed from the local dashboard, no Discord message, applied only from there (Gate 1 S46). */
  origin: 'discord' | 'dashboard';
  outcome: string | null;
  createdAt: Date;
  expiresAt: Date;
  via: AdminVia;
  decidedBy: string | null;
  /** Set by the executor's claim: the card ran (or started to run) exactly once. */
  executedAt: Date | null;
}

const COLS = `seq, id, proposer_id AS "proposerId", kind, payload, snapshot, tainted, channel_id AS "channelId", message_id AS "messageId",
  status, origin, outcome, created_at AS "createdAt", expires_at AS "expiresAt", via, decided_by AS "decidedBy", executed_at AS "executedAt"`;

export const CARD_TTL_MINUTES = 15;

/** Why a click did not consume a card (the handler maps these to fixed ephemeral texts). */
export type Refusal = 'not_found' | 'not_pending' | 'expired' | 'not_proposer' | 'wrong_message' | 'superseded' | 'wrong_channel';

/** Gate 1 C6: single-use, SQL-enforced expiry, newest-pending-per-proposer. Cards survive a restart with their own expires_at. */
export class AdminCardRepo {
  constructor(private readonly pool: Pool) {}

  /** Inserts a pending card; every older pending card of the same proposer becomes `superseded` first (returned, so their buttons can be closed). */
  async create(c: { proposerId: string; kind: AdminCardKind; payload: unknown; snapshot: unknown; tainted: boolean; channelId: string; origin?: 'discord' | 'dashboard'; via?: AdminVia }): Promise<{ card: AdminCard; superseded: AdminCard[] }> {
    const id = randomBytes(16).toString('hex'); // 128 bits
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const sup = await client.query<AdminCard>(
        `UPDATE admin_cards SET status = 'superseded', decided_at = now() WHERE proposer_id = $1 AND status = 'pending' RETURNING ${COLS}`,
        [c.proposerId],
      );
      const ins = await client.query<AdminCard>(
        `INSERT INTO admin_cards (id, proposer_id, kind, payload, snapshot, tainted, channel_id, expires_at, origin, via)
         VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7, now() + $8 * interval '1 minute', $9, $10) RETURNING ${COLS}`,
        [id, c.proposerId, c.kind, JSON.stringify(c.payload), JSON.stringify(c.snapshot), c.tainted, c.channelId, CARD_TTL_MINUTES, c.origin ?? 'discord', c.via ?? 'praw'],
      );
      await client.query('COMMIT');
      return { card: ins.rows[0]!, superseded: sup.rows };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async setMessage(id: string, messageId: string): Promise<void> {
    await this.pool.query('UPDATE admin_cards SET message_id = $2 WHERE id = $1', [id, messageId]);
  }

  async get(id: string): Promise<AdminCard | null> {
    return (await this.pool.query<AdminCard>(`SELECT ${COLS} FROM admin_cards WHERE id = $1`, [id])).rows[0] ?? null;
  }

  /**
   * C5 steps 4-6 and C6 in ONE conditional UPDATE (the D15 pattern): the card is consumed only when it is pending, unexpired, the
   * proposer's own, on this very message, and the newest pending card of that proposer. Two parallel clicks yield one winner.
   */
  async consume(id: string, to: 'confirmed' | 'cancelled', by: string, messageId: string | null, opts: { channelId?: string; anyProposer?: boolean } = {}): Promise<{ ok: true; card: AdminCard } | { ok: false; reason: Refusal }> {
    // T5: `channelId` (the channel the click came from) must be the one stored on the card, inside the same atomic UPDATE.
    // T4: `anyProposer` (a Bot Admin cancelling a mod-room card; never set for a confirm) lifts only the proposer match.
    const r = await this.pool.query<AdminCard>(
      `UPDATE admin_cards c SET status = $2, decided_at = now(), decided_by = $3
       WHERE c.id = $1 AND c.status = 'pending' AND c.expires_at > now() AND ($6::boolean OR c.proposer_id = $3)
         AND c.message_id IS NOT NULL AND c.message_id = $4 AND ($5::text IS NULL OR c.channel_id = $5)
         AND NOT EXISTS (SELECT 1 FROM admin_cards n WHERE n.proposer_id = c.proposer_id AND n.status = 'pending' AND n.seq > c.seq)
       RETURNING ${COLS}`,
      [id, to, by, messageId, opts.channelId ?? null, opts.anyProposer === true && to === 'cancelled'],
    );
    if (r.rows[0]) return { ok: true, card: r.rows[0] };
    // Why not: a separate read, only to word the refusal (the decision above already was atomic).
    const cur = await this.pool.query<{ status: AdminCardStatus; proposer_id: string; message_id: string | null; channel_id: string; live: boolean }>(
      'SELECT status, proposer_id, message_id, channel_id, expires_at > now() AS live FROM admin_cards WHERE id = $1', [id]);
    const row = cur.rows[0];
    if (!row) return { ok: false, reason: 'not_found' };
    if (row.status === 'superseded') return { ok: false, reason: 'superseded' };
    if (row.status !== 'pending') return { ok: false, reason: 'not_pending' };
    if (!row.live) return { ok: false, reason: 'expired' };
    if (opts.channelId !== undefined && row.channel_id !== opts.channelId) return { ok: false, reason: 'wrong_channel' };
    if (row.proposer_id !== by && !(opts.anyProposer === true && to === 'cancelled')) return { ok: false, reason: 'not_proposer' };
    if (row.message_id === null || row.message_id !== messageId) return { ok: false, reason: 'wrong_message' };
    return { ok: false, reason: 'superseded' }; // a newer pending card of this proposer exists
  }

  /**
   * Gate 1 S46: the dashboard's Apply. The same single-use UPDATE as `consume` (pending, unexpired, the proposer's own, the newest of
   * theirs), with `origin = 'dashboard'` in place of the message-id match: a Discord-created card is never consumable here.
   */
  async consumeDashboard(id: string, by: string): Promise<{ ok: true; card: AdminCard } | { ok: false; reason: Refusal }> {
    const r = await this.pool.query<AdminCard>(
      `UPDATE admin_cards c SET status = 'confirmed', decided_at = now(), decided_by = $2
       WHERE c.id = $1 AND c.status = 'pending' AND c.expires_at > now() AND c.proposer_id = $2 AND c.origin = 'dashboard'
         AND NOT EXISTS (SELECT 1 FROM admin_cards n WHERE n.proposer_id = c.proposer_id AND n.status = 'pending' AND n.seq > c.seq)
       RETURNING ${COLS}`, [id, by]);
    if (r.rows[0]) return { ok: true, card: r.rows[0] };
    const cur = await this.pool.query<{ status: AdminCardStatus; proposer_id: string; origin: string; live: boolean }>(
      'SELECT status, proposer_id, origin, expires_at > now() AS live FROM admin_cards WHERE id = $1', [id]);
    const row = cur.rows[0];
    if (!row) return { ok: false, reason: 'not_found' };
    if (row.status === 'superseded') return { ok: false, reason: 'superseded' };
    if (row.status !== 'pending') return { ok: false, reason: 'not_pending' };
    if (!row.live) return { ok: false, reason: 'expired' };
    if (row.proposer_id !== by) return { ok: false, reason: 'not_proposer' };
    if (row.origin !== 'dashboard') return { ok: false, reason: 'wrong_message' };
    return { ok: false, reason: 'superseded' };
  }

  /** Cancel from the dashboard: the proposer's own pending dashboard card, once. */
  async cancelDashboard(id: string, by: string): Promise<boolean> {
    const r = await this.pool.query(`UPDATE admin_cards SET status = 'cancelled', decided_at = now(), decided_by = $2 WHERE id = $1 AND status = 'pending' AND proposer_id = $2 AND origin = 'dashboard'`, [id, by]);
    return (r.rowCount ?? 0) === 1;
  }

  /** T20: how many cards this proposer created in `channelId` in the last `minutes` (every status counts, so superseding does not reset the window). */
  async countRecent(proposerId: string, channelId: string, minutes: number): Promise<number> {
    const r = await this.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM admin_cards WHERE proposer_id = $1 AND channel_id = $2 AND created_at > now() - $3 * interval '1 minute'`, [proposerId, channelId, minutes]);
    return r.rows[0]?.n ?? 0;
  }

  /** The cards still pending (unexpired), newest first; for the dashboard's read-only list. */
  async listPending(limit = 50): Promise<AdminCard[]> {
    return (await this.pool.query<AdminCard>(`SELECT ${COLS} FROM admin_cards WHERE status = 'pending' AND expires_at > now() ORDER BY seq DESC LIMIT $1`, [limit])).rows;
  }

  /**
   * S2/S46: the executor's claim. A confirmed card of the perm/server/deploy families, decided by its own proposer in the last 2 minutes, runs exactly
   * once: the conditional UPDATE sets `executed_at` and two parallel applies get one winner. Null = nothing to run (the executor refuses).
   */
  async claimForExecution(id: string): Promise<AdminCard | null> {
    const r = await this.pool.query<AdminCard>(
      `UPDATE admin_cards SET executed_at = now()
       WHERE id = $1 AND status = 'confirmed' AND executed_at IS NULL AND kind IN ('perm', 'server', 'deploy', 'code')
         AND decided_by IS NOT NULL AND decided_by = proposer_id AND decided_at > now() - interval '2 minutes'
       RETURNING ${COLS}`,
      [id],
    );
    return r.rows[0] ?? null;
  }

  /** A card whose message could not be posted: withdrawn so nothing stays pending that no one can see. */
  async abandon(id: string): Promise<void> {
    await this.pool.query(`UPDATE admin_cards SET status = 'cancelled', outcome = 'not posted', decided_at = now() WHERE id = $1 AND status = 'pending'`, [id]);
  }

  async setOutcome(id: string, outcome: string): Promise<void> {
    await this.pool.query('UPDATE admin_cards SET outcome = $2 WHERE id = $1', [id, outcome.slice(0, 500)]);
  }

  /** Marks every overdue pending card expired and returns them (for the audit rows and to close their buttons). Idempotent. */
  async expireOverdue(): Promise<AdminCard[]> {
    return (await this.pool.query<AdminCard>(
      `UPDATE admin_cards SET status = 'expired', decided_at = now() WHERE status = 'pending' AND expires_at <= now() RETURNING ${COLS}`)).rows;
  }

  /** Message ids of the cards (any state) in a set: lets the admin run's history keep hq's card messages and nothing else from hq (C9). */
  async messageIds(ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const r = await this.pool.query<{ message_id: string }>('SELECT message_id FROM admin_cards WHERE message_id = ANY($1::text[])', [ids]);
    return new Set(r.rows.map((x) => x.message_id));
  }
}
