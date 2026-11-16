import type { PoolClient } from 'pg';
import type { Pool } from '../pool.js';

/**
 * TREEGRANT-1 (migration 035): the task-tree grant ("Approve the whole task"). One row per grant, keyed by the root of the task tree. The call cap is
 * snapshotted into the row; `consume` is ONE conditional UPDATE, so under concurrency the cap cannot be overshot (the row CHECK is a second line).
 * Nothing here throws out of `consume`: a database fault is `why: 'error'`, and the call then gets a card.
 */
/** The closed set a card suffix and the audit may show. `not_covered` is written by the registry (a run-time predicate said no); the repo never returns it. */
export type TaskGrantMiss = 'none' | 'revoked' | 'expired' | 'cap_calls' | 'root_ended' | 'halted' | 'disabled' | 'tainted' | 'not_covered' | 'error';
export type TaskConsumeResult = { ok: true; grantId: number; used: number; max: number } | { ok: false; why: TaskGrantMiss };
export type TaskRevokeReason = 'admin' | 'halt' | 'superseded' | 'disabled' | 'root_ended';
type Queryable = Pick<PoolClient, 'query'>;

export interface TaskGrant {
  id: number; rootId: string; approvalId: number; grantedBy: string; requestedBy: string;
  maxCalls: number; used: number; usedByTool: Record<string, number>; webGrantId: number | null;
  cardMessageId: string | null; cardChannelId: string | null;
  createdAt: Date; expiresAt: Date; revokedAt: Date | null; revokeReason: TaskRevokeReason | null;
}

const cols = (a = ''): string => `${a}id, ${a}root_id AS "rootId", ${a}approval_id AS "approvalId", ${a}granted_by AS "grantedBy", ${a}requested_by AS "requestedBy",
  ${a}max_calls AS "maxCalls", ${a}used, ${a}used_by_tool AS "usedByTool", ${a}web_grant_id AS "webGrantId",
  ${a}card_message_id AS "cardMessageId", ${a}card_channel_id AS "cardChannelId",
  ${a}created_at AS "createdAt", ${a}expires_at AS "expiresAt", ${a}revoked_at AS "revokedAt", ${a}revoke_reason AS "revokeReason"`;
const COLS = cols();
const SNOWFLAKE = /^[0-9]{17,20}$/;

/** The predicate "this row is live": the render, the decision re-check and `live()` share it (TG-C12). Alias `g` = task_grants, `t` = its root. */
export const LIVE_SQL = "g.revoked_at IS NULL AND g.expires_at > now() AND g.used < g.max_calls AND t.status NOT IN ('done','cancelled')";

/** The live grant of a task tree, or null. Takes any connection, so a decision can call it inside its transaction (after the root lock). */
export async function liveGrantOf(c: Queryable, rootId: string): Promise<TaskGrant | null> {
  const q = await c.query<TaskGrant>(`SELECT ${cols('g.')} FROM task_grants g JOIN tasks t ON t.id = g.root_id WHERE g.root_id = $1 AND ${LIVE_SQL}`, [rootId]);
  return q.rows[0] ?? null;
}

/**
 * Inside the caller's transaction after the root lock and the "no live grant" check: every unrevoked row of the tree (necessarily not live) is
 * retired as `superseded`, and so is the companion web grant each of them carries.
 */
export async function supersedeAllTaskGrants(c: Queryable, rootId: string, by: string): Promise<void> {
  const r = await c.query<{ web: number | null }>(
    "UPDATE task_grants SET revoked_at = now(), revoked_by = $2, revoke_reason = 'superseded' WHERE root_id = $1 AND revoked_at IS NULL RETURNING web_grant_id AS web",
    [rootId, by],
  );
  const webIds = r.rows.map((x) => x.web).filter((x): x is number => x !== null);
  if (webIds.length) await c.query("UPDATE web_grants SET revoked_at = now(), revoked_by = $2, revoke_reason = 'superseded' WHERE id = ANY($1) AND revoked_at IS NULL", [webIds, by]);
}

/** Inserts a grant; `expires_at` is computed on the DB clock, so the 72 h CHECK always holds. */
export async function insertTaskGrant(
  c: Queryable,
  g: { rootId: string; approvalId: number; grantedBy: string; requestedBy: string; maxCalls: number; hours: number; webGrantId?: number | null; cardMessageId?: string | null; cardChannelId?: string | null },
): Promise<TaskGrant> {
  const ok = (s: string | null | undefined) => (s && SNOWFLAKE.test(s) ? s : null);
  const r = await c.query<TaskGrant>(
    `INSERT INTO task_grants (root_id, approval_id, granted_by, requested_by, max_calls, expires_at, web_grant_id, card_message_id, card_channel_id)
     VALUES ($1,$2,$3,$4,$5, now() + $6::float8 * interval '1 hour', $7, $8, $9) RETURNING ${COLS}`,
    [g.rootId, g.approvalId, g.grantedBy, g.requestedBy, g.maxCalls, g.hours, g.webGrantId ?? null, ok(g.cardMessageId), ok(g.cardChannelId)],
  );
  return r.rows[0]!;
}

export interface TaskGrantOptions {
  /** Read live on every consume (halted, taskGrant.enabled, allowTainted): a non-null answer refuses before any SQL, so no slot is spent and then refused (F-8). */
  gate?: (r: { tainted: boolean }) => 'halted' | 'disabled' | 'tainted' | null;
  /** A database fault in consume, already reduced to a fixed text; the caller reports it as a #bot-log incident. */
  onFault?: (err: unknown) => void;
  /** A grant was spent (the usage line of its card is refreshed, debounced). Never throws into consume. */
  onUse?: (grantId: number) => void;
  /** Grants revoked by revokeAll / revoke / revokeRoot / revokeBeforeHaltedRow, so their cards can be closed. Never throws into the caller. */
  onRevoked?: (rows: TaskGrant[], reason: TaskRevokeReason) => void;
}

export class TaskGrantRepo {
  /** A halt / switch-off revoke that failed (a database fault) is still owed; the next consume that finds the gate open pays it first. */
  private revokeOwed: { halt: boolean; disabled: boolean } = { halt: false, disabled: false };

  constructor(private readonly pool: Pool, private readonly o: TaskGrantOptions = {}) {}

  async consume(r: { rootId: string; tool: string; tainted?: boolean }): Promise<TaskConsumeResult> {
    try {
      const gate = this.o.gate?.({ tainted: r.tainted === true }) ?? null;
      if (gate) {
        if (gate === 'halted') void this.revokeAll('halt').catch(() => undefined); // a halt whose revoke failed is retried by every attempt made while it lasts
        return { ok: false, why: gate };
      }
      if (this.revokeOwed.halt) await this.revokeAll('halt'); // out of the halt with the revoke still owed; a throw is `error` (a card)
      if (this.revokeOwed.disabled) await this.revokeAll('disabled'); // TG-C8: the switch is back on, the old grants must not come back
      const u = await this.pool.query<{ id: number; used: number; max: number }>(
        `UPDATE task_grants g SET used = g.used + 1,
           used_by_tool = jsonb_set(g.used_by_tool, ARRAY[$2::text], to_jsonb(coalesce((g.used_by_tool->>$2::text)::int, 0) + 1))
         FROM tasks t
         WHERE g.root_id = $1 AND t.id = g.root_id AND t.status NOT IN ('done','cancelled')
           AND g.revoked_at IS NULL AND g.expires_at > now() AND g.used < g.max_calls
         RETURNING g.id, g.used, g.max_calls AS max`,
        [r.rootId, r.tool],
      );
      const row = u.rows[0];
      if (row) {
        const grantId = Number(row.id);
        try { this.o.onUse?.(grantId); } catch { /* the usage line never blocks a call */ }
        return { ok: true, grantId, used: row.used, max: row.max };
      }
      return { ok: false, why: await this.classify(r.rootId) };
    } catch (err) {
      // what is reported holds no tool input: a fixed text plus the SQLSTATE code at most
      const code = (err as { code?: unknown } | null)?.code;
      try { this.o.onFault?.(new Error(`task grant consume failed (${typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : 'error'})`)); } catch { /* reporting never throws */ }
      return { ok: false, why: 'error' };
    }
  }

  /** Why a consume found nothing (read only, for the audit line): the newest grant of the tree decides. */
  private async classify(rootId: string): Promise<TaskGrantMiss> {
    const q = await this.pool.query<{ revoked: boolean; ended: boolean; expired: boolean; calls: boolean }>(
      `SELECT g.revoked_at IS NOT NULL AS revoked, t.status IN ('done','cancelled') AS ended, g.expires_at <= now() AS expired, g.used >= g.max_calls AS calls
       FROM task_grants g JOIN tasks t ON t.id = g.root_id WHERE g.root_id = $1 ORDER BY g.id DESC LIMIT 1`,
      [rootId],
    );
    const x = q.rows[0];
    if (!x) return 'none';
    if (x.revoked) return 'revoked';
    if (x.ended) return 'root_ended';
    if (x.expired) return 'expired';
    if (x.calls) return 'cap_calls';
    return 'none';
  }

  /** The live grant of a task tree (unrevoked, unexpired, under the cap, tree not ended), or null. */
  live(rootId: string): Promise<TaskGrant | null> {
    return liveGrantOf(this.pool, rootId);
  }

  async get(id: number): Promise<TaskGrant | null> {
    return (await this.pool.query<TaskGrant>(`SELECT ${COLS} FROM task_grants WHERE id = $1`, [id])).rows[0] ?? null;
  }

  /** The unrevoked grant whose card is this message (the card shows its revoke button), or null. */
  async unrevokedOfMessage(messageId: string): Promise<TaskGrant | null> {
    return (await this.pool.query<TaskGrant>(`SELECT ${COLS} FROM task_grants WHERE card_message_id = $1 AND revoked_at IS NULL ORDER BY id DESC LIMIT 1`, [messageId])).rows[0] ?? null;
  }

  /** Whether the grant still shows a usage line: unrevoked, unexpired, root open (TG-C17: re-read before every edit). */
  async editable(id: number): Promise<TaskGrant | null> {
    const q = await this.pool.query<TaskGrant>(
      `SELECT ${cols('g.')} FROM task_grants g JOIN tasks t ON t.id = g.root_id
       WHERE g.id = $1 AND g.revoked_at IS NULL AND g.expires_at > now() AND t.status NOT IN ('done','cancelled')`, [id]);
    return q.rows[0] ?? null;
  }

  /**
   * Revokes one grant by id (admin). The companion web grant is revoked afterwards by its own statement (TG-C9): a failure there is swallowed
   * and never undoes the task-grant revoke. True when this call revoked it.
   */
  async revoke(id: number, by: string, reason: TaskRevokeReason): Promise<boolean> {
    const r = await this.pool.query<TaskGrant>(
      `UPDATE task_grants SET revoked_at = now(), revoked_by = $2, revoke_reason = $3 WHERE id = $1 AND revoked_at IS NULL RETURNING ${COLS}`, [id, by, reason]);
    if (!r.rows.length) return false;
    await this.revokeCompanions(r.rows, reason, by);
    this.closed(r.rows, reason);
    return true;
  }

  /** Revokes the unrevoked grant of one task tree whose root ended (TG-C18). */
  async revokeRoot(rootId: string, reason: TaskRevokeReason = 'root_ended'): Promise<TaskGrant[]> {
    const r = await this.pool.query<TaskGrant>(
      `UPDATE task_grants SET revoked_at = now(), revoked_by = 'system', revoke_reason = $2 WHERE root_id = $1 AND revoked_at IS NULL RETURNING ${COLS}`, [rootId, reason]);
    await this.revokeCompanions(r.rows, reason, 'system');
    this.closed(r.rows, reason);
    return r.rows;
  }

  /** Revokes every unrevoked grant (halt, resume, switch off). Returns the rows. A failed halt / disabled revoke stays owed. */
  async revokeAll(reason: TaskRevokeReason, by = 'system'): Promise<TaskGrant[]> {
    try {
      const r = await this.pool.query<TaskGrant>(`UPDATE task_grants SET revoked_at = now(), revoked_by = $1, revoke_reason = $2 WHERE revoked_at IS NULL RETURNING ${COLS}`, [by, reason]);
      if (reason === 'halt') this.revokeOwed.halt = false;
      if (reason === 'disabled') this.revokeOwed.disabled = false;
      await this.revokeCompanions(r.rows, reason, by);
      this.closed(r.rows, reason);
      return r.rows;
    } catch (err) {
      if (reason === 'halt') this.revokeOwed.halt = true;
      if (reason === 'disabled') this.revokeOwed.disabled = true;
      throw err;
    }
  }

  /** Boot: a grant made before the `halted` config row last changed lived through a halt (and maybe a resume) while this process was down. */
  async revokeBeforeHaltedRow(): Promise<TaskGrant[]> {
    const r = await this.pool.query<TaskGrant>(
      `UPDATE task_grants SET revoked_at = now(), revoked_by = 'system', revoke_reason = 'halt'
       WHERE revoked_at IS NULL AND created_at < (SELECT updated_at FROM config WHERE key = 'halted') RETURNING ${COLS}`);
    await this.revokeCompanions(r.rows, 'halt', 'system');
    this.closed(r.rows, 'halt');
    return r.rows;
  }

  /** TG-C9: the companion web grant is revoked by id, with a reason inside the 027 CHECK, in its own statement; a failure never reaches the task-grant revoke. */
  private async revokeCompanions(rows: TaskGrant[], reason: TaskRevokeReason, by: string): Promise<void> {
    const ids = rows.map((x) => x.webGrantId).filter((x): x is number => x !== null);
    if (!ids.length) return;
    const why = reason === 'halt' ? 'halt' : reason === 'superseded' ? 'superseded' : 'admin';
    try {
      await this.pool.query('UPDATE web_grants SET revoked_at = now(), revoked_by = $2, revoke_reason = $3 WHERE id = ANY($1) AND revoked_at IS NULL', [ids, by, why]);
    } catch (err) {
      // the task grant is already revoked; the web grant is also covered by its own halt revoke and expiry. G2TG-02: a companion left live is reported (fixed text + SQLSTATE only)
      const code = (err as { code?: unknown } | null)?.code;
      try { this.o.onFault?.(new Error(`task grant companion web revoke failed (${typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : 'error'})`)); } catch { /* reporting never throws */ }
    }
  }

  private closed(rows: TaskGrant[], reason: TaskRevokeReason): void {
    if (!rows.length) return;
    try { this.o.onRevoked?.(rows, reason); } catch { /* closing a card never blocks a revoke */ }
  }
}
