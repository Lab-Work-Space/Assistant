import type { PoolClient } from 'pg';
import type { Pool } from '../pool.js';

/**
 * WEBGRANT-1 (migration 027): the task web grant. One row per grant, keyed by the root of the task tree. The caps are snapshotted
 * into the row; `consume` is ONE conditional UPDATE, so under concurrency the fetch, host and character caps cannot be overshot
 * (the row CHECKs are a second line). Nothing here throws out of `consume`: a database fault is `why: 'error'`, and the call then gets a card.
 */
export type ConsumeMiss = 'none' | 'revoked' | 'expired' | 'cap_fetches' | 'cap_hosts' | 'cap_chars' | 'root_ended' | 'halted' | 'disabled' | 'error';
export type ConsumeResult = { ok: true; grantId: number; used: number; max: number } | { ok: false; why: ConsumeMiss };
export type RevokeReason = 'admin' | 'halt' | 'superseded';
type Queryable = Pick<PoolClient, 'query'>;

export interface WebGrant {
  id: number; rootId: string; approvalId: number; grantedBy: string; requestedBy: string;
  maxFetches: number; maxHosts: number; maxUrlChars: number; used: number; urlCharsUsed: number; hosts: string[];
  cardMessageId: string | null; createdAt: Date; expiresAt: Date; revokedAt: Date | null; revokeReason: RevokeReason | null;
}

const cols = (a = ''): string => `${a}id, ${a}root_id AS "rootId", ${a}approval_id AS "approvalId", ${a}granted_by AS "grantedBy", ${a}requested_by AS "requestedBy",
  ${a}max_fetches AS "maxFetches", ${a}max_hosts AS "maxHosts", ${a}max_url_chars AS "maxUrlChars", ${a}used, ${a}url_chars_used AS "urlCharsUsed", ${a}hosts,
  ${a}card_message_id AS "cardMessageId", ${a}created_at AS "createdAt", ${a}expires_at AS "expiresAt", ${a}revoked_at AS "revokedAt", ${a}revoke_reason AS "revokeReason"`;
const COLS = cols();

/** W-C8: every unrevoked row of the tree (live or not) is superseded, inside the caller's transaction after the root lock. */
export async function supersedeAll(c: Queryable, rootId: string, by: string): Promise<void> {
  await c.query(
    "UPDATE web_grants SET revoked_at = now(), revoked_by = $2, revoke_reason = 'superseded' WHERE root_id = $1 AND revoked_at IS NULL",
    [rootId, by],
  );
}

/** Inserts a grant (expires_at is computed on the DB clock, so the 24 h CHECK always holds). */
export async function insertGrant(
  c: Queryable,
  g: { rootId: string; approvalId: number; grantedBy: string; requestedBy: string; maxFetches: number; maxHosts: number; maxUrlChars: number; hours: number;
    /** G2W-03: the card message the grant is made on, written in the same transaction (null/absent: none, or not a snowflake). */
    cardMessageId?: string | null },
): Promise<WebGrant> {
  const r = await c.query<WebGrant>(
    `INSERT INTO web_grants (root_id, approval_id, granted_by, requested_by, max_fetches, max_hosts, max_url_chars, expires_at, card_message_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now() + $8::float8 * interval '1 hour', $9) RETURNING ${COLS}`,
    [g.rootId, g.approvalId, g.grantedBy, g.requestedBy, g.maxFetches, g.maxHosts, g.maxUrlChars, g.hours, g.cardMessageId && /^[0-9]{17,20}$/.test(g.cardMessageId) ? g.cardMessageId : null],
  );
  return r.rows[0]!;
}

export interface WebGrantOptions {
  /** Read live on every consume (W-C3a halted, W-C7 enabled): a non-null answer refuses before any SQL. */
  gate?: () => 'halted' | 'disabled' | null;
  /** A database fault in consume, already reduced to a fixed text (no host, no url); the caller reports it as a #bot-log incident. */
  onFault?: (err: unknown) => void;
}

export class WebGrantRepo {
  /**
   * G2W-01 (Gate 2): a halt-revoke that failed (a database fault: the same outage that made the process read as halted) is still owed.
   * When the database is back the effective `halted` can drop to false with no row write, so nothing else would revoke; the next consume
   * pays the debt first and refuses (`error`) while it cannot. Process memory only: a restart is covered by the boot revoke (W-C3d) only
   * when the `halted` row was written.
   */
  private revokeOwed = false;

  constructor(private readonly pool: Pool, private readonly o: WebGrantOptions = {}) {}

  async consume(r: { rootId: string; host: string; chars: number }): Promise<ConsumeResult> {
    try {
      const gate = this.o.gate?.() ?? null;
      if (gate) {
        // a halt whose revokeAll failed (a database fault) is retried by every consume attempt made while it lasts
        if (gate === 'halted') void this.revokeAll('halt').catch(() => undefined);
        return { ok: false, why: gate };
      }
      if (this.revokeOwed) await this.revokeAll('halt'); // G2W-01: out of the halt with the revoke still owed; a throw is `error` (a card)
      const u = await this.pool.query<{ id: number; used: number; max: number }>(
        `UPDATE web_grants g SET used = g.used + 1, url_chars_used = g.url_chars_used + $3::int,
           hosts = CASE WHEN $2::text = ANY(g.hosts) THEN g.hosts ELSE array_append(g.hosts, $2::text) END
         FROM tasks t
         WHERE g.root_id = $1 AND t.id = g.root_id AND t.status NOT IN ('done','cancelled')
           AND g.revoked_at IS NULL AND g.expires_at > now() AND g.used < g.max_fetches
           AND g.url_chars_used + $3::int <= g.max_url_chars
           AND ($2::text = ANY(g.hosts) OR cardinality(g.hosts) < g.max_hosts)
         RETURNING g.id, g.used, g.max_fetches AS max`,
        [r.rootId, r.host, r.chars],
      );
      const row = u.rows[0];
      if (row) return { ok: true, grantId: Number(row.id), used: row.used, max: row.max };
      return { ok: false, why: await this.classify(r) };
    } catch (err) {
      // W9: what is reported never holds the host or the url: a fixed text plus the SQLSTATE code at most (the raw driver error stays here)
      const code = (err as { code?: unknown } | null)?.code;
      try { this.o.onFault?.(new Error(`web grant consume failed (${typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : 'error'})`)); } catch { /* reporting never throws */ }
      return { ok: false, why: 'error' };
    }
  }

  /** Why a consume found nothing (read only, for the audit line): the newest grant of the tree decides. */
  private async classify(r: { rootId: string; host: string; chars: number }): Promise<ConsumeMiss> {
    const q = await this.pool.query<{
      revoked: boolean; ended: boolean; expired: boolean; fetches: boolean; chars: boolean; hosts: boolean;
    }>(
      `SELECT g.revoked_at IS NOT NULL AS revoked, t.status IN ('done','cancelled') AS ended, g.expires_at <= now() AS expired,
         g.used >= g.max_fetches AS fetches, g.url_chars_used + $3::int > g.max_url_chars AS chars,
         NOT ($2::text = ANY(g.hosts)) AND cardinality(g.hosts) >= g.max_hosts AS hosts
       FROM web_grants g JOIN tasks t ON t.id = g.root_id WHERE g.root_id = $1 ORDER BY g.id DESC LIMIT 1`,
      [r.rootId, r.host, r.chars],
    );
    const x = q.rows[0];
    if (!x) return 'none';
    if (x.revoked) return 'revoked';
    if (x.ended) return 'root_ended';
    if (x.expired) return 'expired';
    if (x.fetches) return 'cap_fetches';
    if (x.chars) return 'cap_chars';
    if (x.hosts) return 'cap_hosts';
    return 'none';
  }

  /** The live grant of a task tree (revoked_at null, unexpired, not exhausted, tree not ended), or null. */
  async live(rootId: string): Promise<WebGrant | null> {
    const q = await this.pool.query<WebGrant>(
      `SELECT ${cols('g.')}
       FROM web_grants g JOIN tasks t ON t.id = g.root_id
       WHERE g.root_id = $1 AND g.revoked_at IS NULL AND g.expires_at > now() AND g.used < g.max_fetches AND t.status NOT IN ('done','cancelled')`,
      [rootId],
    );
    return q.rows[0] ?? null;
  }

  async get(id: number): Promise<WebGrant | null> {
    return (await this.pool.query<WebGrant>(`SELECT ${COLS} FROM web_grants WHERE id = $1`, [id])).rows[0] ?? null;
  }

  /** The unrevoked grant whose card is this message (the card shows its revoke button), or null. */
  async unrevokedOfMessage(messageId: string): Promise<WebGrant | null> {
    return (await this.pool.query<WebGrant>(`SELECT ${COLS} FROM web_grants WHERE card_message_id = $1 AND revoked_at IS NULL ORDER BY id DESC LIMIT 1`, [messageId])).rows[0] ?? null;
  }

  /** Records the card the grant was made on (W-C11b). Only the first value is kept. */
  async setCard(id: number, messageId: string): Promise<void> {
    if (!/^[0-9]{17,20}$/.test(messageId)) return;
    await this.pool.query('UPDATE web_grants SET card_message_id = $2 WHERE id = $1 AND card_message_id IS NULL', [id, messageId]);
  }

  /** D10: admin revoke; true when this call revoked it, false when it was already revoked (or unknown). */
  async revoke(id: number, by: string, reason: RevokeReason): Promise<boolean> {
    const r = await this.pool.query('UPDATE web_grants SET revoked_at = now(), revoked_by = $2, revoke_reason = $3 WHERE id = $1 AND revoked_at IS NULL', [id, by, reason]);
    return (r.rowCount ?? 0) > 0;
  }

  /**
   * TASKADMIN-1: housekeeping when a Bot Admin cancels (or accepts) the root of a tree: every unrevoked grant of `rootId`, reason `admin` (the only reason
   * the 027 CHECK allows for this). Returns the revoked ids (for the audit rows). `consume` already refuses an ended root; this is not the boundary.
   */
  async revokeRoot(rootId: string, by: string): Promise<number[]> {
    const r = await this.pool.query<{ id: number }>("UPDATE web_grants SET revoked_at = now(), revoked_by = $2, revoke_reason = 'admin' WHERE root_id = $1 AND revoked_at IS NULL RETURNING id", [rootId, by]);
    return r.rows.map((x) => x.id);
  }

  /** Revokes every unrevoked grant (halt). Returns how many. */
  async revokeAll(reason: RevokeReason, by = 'system'): Promise<number> {
    try {
      const r = await this.pool.query('UPDATE web_grants SET revoked_at = now(), revoked_by = $1, revoke_reason = $2 WHERE revoked_at IS NULL', [by, reason]);
      if (reason === 'halt') this.revokeOwed = false;
      return r.rowCount ?? 0;
    } catch (err) {
      if (reason === 'halt') this.revokeOwed = true; // G2W-01: paid by the next consume
      throw err;
    }
  }

  /**
   * W-C3d, boot: a grant made before the `halted` config row last changed lived through a halt (and maybe a resume) while this process
   * was down, so it is revoked. A grant made after it is untouched.
   */
  async revokeBeforeHaltedRow(): Promise<number> {
    const r = await this.pool.query(
      `UPDATE web_grants SET revoked_at = now(), revoked_by = 'system', revoke_reason = 'halt'
       WHERE revoked_at IS NULL AND created_at < (SELECT updated_at FROM config WHERE key = 'halted')`,
    );
    return r.rowCount ?? 0;
  }
}
