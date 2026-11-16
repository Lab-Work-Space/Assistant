import { randomBytes } from 'node:crypto';
import { taskBudgetKey } from '../../governance/budget.js';
import type { Pool } from '../pool.js';

/**
 * OT-1 (migration 030): overtime requests. A row is a request (pending), a decision (denied / workday / approved) or an end (expired / moot).
 * An approved row IS the grant for one task tree for one local day: the caps are snapshotted into it and `consume` is ONE conditional UPDATE,
 * so under concurrency the run cap cannot be overshot (the row CHECKs are a second line). Nothing here throws out of `usable`, `unexpired`
 * or `consume`: a database fault is reported (fixed text plus a SQLSTATE, OT-C15) and reads as "no overtime" (fail closed).
 * Lock order matches approvals.decide (root task row, then the OT row); consume and the sweeps take only OT rows and never lock budget_days.
 */
export type OtStatus = 'pending' | 'approved' | 'denied' | 'workday' | 'expired' | 'moot';
export type OtRevokeReason = 'admin' | 'halt' | 'superseded' | 'root_ended';

export interface OtRequest {
  id: number; rootId: string; localDay: string; seq: number; requestedBy: string; digest: string; status: OtStatus;
  cardChannelId: string | null; cardMessageId: string | null; createdAt: Date; expiresAt: Date;
  decidedBy: string | null; decidedAt: Date | null; grantExpiresAt: Date | null;
  maxRuns: number | null; runsUsed: number; maxUsd: number | null; usdBase: number | null;
  revokedAt: Date | null; revokedBy: string | null; revokeReason: OtRevokeReason | null;
}

const COLS = `id::int AS id, root_id AS "rootId", local_day::text AS "localDay", seq::int AS seq, requested_by AS "requestedBy", digest, status,
  card_channel_id AS "cardChannelId", card_message_id AS "cardMessageId", created_at AS "createdAt", expires_at AS "expiresAt",
  decided_by AS "decidedBy", decided_at AS "decidedAt", grant_expires_at AS "grantExpiresAt", max_runs AS "maxRuns", runs_used AS "runsUsed",
  max_usd::float8 AS "maxUsd", usd_base::float8 AS "usdBase", revoked_at AS "revokedAt", revoked_by AS "revokedBy", revoke_reason AS "revokeReason"`;

/** Local midnight that ends the current local day, computed on the database clock (OT-C14). $tz = the timezone parameter's index. */
const MIDNIGHT = (tz: string): string => `((date_trunc('day', now() AT TIME ZONE ${tz}::text) + interval '1 day') AT TIME ZONE ${tz}::text)`;
const TODAY = (tz: string): string => `((now() AT TIME ZONE ${tz}::text)::date)`;

/** The terms every use of a grant shares (status, revoke, window, day, root alive). `o` = the ot_requests alias, $d = the day parameter. */
const LIVE_TERMS = (o: string, d: string): string => `${o}.status = 'approved' AND ${o}.revoked_at IS NULL AND ${o}.grant_expires_at > now() AND ${o}.local_day = ${d}::date
  AND EXISTS (SELECT 1 FROM tasks r WHERE r.id = ${o}.root_id AND r.status NOT IN ('done','cancelled'))`;
/** The run and USD terms (OT-C13: settled spend only, minus the base taken at approval; the key comes from budget.ts). */
const CAP_TERMS = (o: string, day: string, scope: string): string => `${o}.runs_used < ${o}.max_runs
  AND COALESCE((SELECT b.spent_usd FROM budget_days b WHERE b.day = ${day}::date AND b.scope = ${scope} AND b.scope_id = ${o}.root_id), 0) - ${o}.usd_base < ${o}.max_usd`;

export type OtGate = 'halted' | 'disabled';
export interface OtRepoOptions {
  /** Read live on every call (OT-C7 enabled, halted): a non-null answer refuses before any SQL. A throw counts as 'disabled'. */
  gate?: () => OtGate | null;
  /** A database fault, already reduced to a fixed text (no title, no thread content); the caller reports it as a #bot-log incident. */
  onFault?: (err: unknown) => void;
  /** G2OT-01: rows revoked by this repository on its own (the halt revoke started by a refused call, an owed revoke paid by a check); the caller closes their cards. */
  onRevoked?: (rows: OtRequest[]) => void;
}

export type RaiseResult =
  | { ok: true; row: OtRequest; expired: { channelId: string; messageId: string }[] }
  | { ok: false; why: 'pending' | 'usable' | 'denied' | 'ended' | 'cap_root' | 'cap_day' | 'cap_person'; expired: { channelId: string; messageId: string }[] };

export type ApproveError = 'not_found' | 'wrong_card' | 'not_pending' | 'expired' | 'halted' | 'root_ended' | 'moot' | 'disabled';
export type ApproveResult = { ok: true; row: OtRequest; /** G2OT-01: the grants this approval superseded (their cards must be closed). */ superseded: OtRequest[] } | { ok: false; error: ApproveError };
export type ConsumeResult =
  | { ok: true; id: number; runsUsed: number; maxRuns: number; grantExpiresAt: Date }
  | { ok: false; why: 'none' | 'exhausted' | 'halted' | 'disabled' | 'error' };

export interface CardRef { digest: string; messageId: string | null; channelId: string | null; userId: string }

const SNOWFLAKE = /^[0-9]{17,20}$/;
/** Serialises raises (and nothing else): the caps are counts, so a count-then-insert must not interleave. */
const RAISE_LOCK = 7_030_001;

export class OtRequestRepo {
  /**
   * A halt or switch-off revoke that failed (a database fault) is still owed: when the database is back the effective `halted` can drop with no row write, so
   * nothing else would revoke. `usable`, `unexpired` and `consume` pay it first and refuse while they cannot (OT-C15). Process memory only:
   * a restart is covered by `revokeBeforeHaltedRow` when the `halted` row was written.
   */
  private revokeOwed: OtRevokeReason | null = null;

  constructor(private readonly pool: Pool, private readonly o: OtRepoOptions = {}) {}

  // ---- the gates ----------------------------------------------------------------------------------------------------------------------

  private gate(): OtGate | null {
    try { return this.o.gate?.() ?? null; } catch { return 'disabled'; }
  }

  private fault(err: unknown): void {
    const code = (err as { code?: unknown } | null)?.code;
    try { this.o.onFault?.(new Error(`overtime check failed (${typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : 'error'})`)); } catch { /* reporting never throws */ }
  }

  /** The refusal (a gate, or a halt revoke still owed and not payable now) or null; a throw is a database fault for the caller to catch. */
  private async precheck(): Promise<'halted' | 'disabled' | null> {
    const gate = this.gate();
    if (gate) {
      // a revoke that failed (a database fault) is retried by every call made while the gate lasts
      if (gate === 'halted') void this.revokeAndReport('halt').catch(() => undefined);
      else if (this.revokeOwed === 'admin') void this.revokeAndReport('admin').catch(() => undefined);
      return gate;
    }
    if (this.revokeOwed) await this.revokeAndReport(this.revokeOwed); // out of the halt (or the switch is back on) with the revoke still owed; a throw is a fault (fail closed)
    return null;
  }

  private async revokeAndReport(reason: OtRevokeReason): Promise<void> {
    try {
      const rows = await this.revokeAll(reason);
      if (rows.length) try { this.o.onRevoked?.(rows); } catch { /* the card close never throws into a check */ }
    } catch (err) {
      if (!this.gate()) throw err;
    }
  }

  // ---- reads --------------------------------------------------------------------------------------------------------------------------

  /** OT-C12 `usable`: every consume term (read only). Fails closed: a gate or a fault is false. */
  async usable(rootId: string, day: string): Promise<boolean> {
    try {
      if (await this.precheck()) return false;
      const k = taskBudgetKey(rootId);
      const q = await this.pool.query(
        `SELECT 1 FROM ot_requests o WHERE o.root_id = $1 AND ${LIVE_TERMS('o', '$2')} AND ${CAP_TERMS('o', '$3', '$4')} LIMIT 1`,
        [rootId, day, k.day, k.scope],
      );
      return (q.rowCount ?? 0) > 0;
    } catch (err) {
      this.fault(err);
      return false;
    }
  }

  /** OT-C12 `unexpired`: the approved, unrevoked, unexpired grant of the day on a live tree (runs and USD not looked at), or null. Fails closed. */
  async unexpired(rootId: string, day: string): Promise<OtRequest | null> {
    try {
      if (await this.precheck()) return null;
      const q = await this.pool.query<OtRequest>(`SELECT ${COLS} FROM ot_requests o WHERE o.root_id = $1 AND ${LIVE_TERMS('o', '$2')} ORDER BY o.id DESC LIMIT 1`, [rootId, day]);
      return q.rows[0] ?? null;
    } catch (err) {
      this.fault(err);
      return null;
    }
  }

  /**
   * ONE indexed read for the hot path (the off-day notice runs on every recovery pass): whether a request of this tree is pending, a usable grant
   * exists, a request was denied today, and how many requests the tree had today. The full raise (a transaction) runs only when none of these decide.
   * No gate here: the caller has checked them. A fault is thrown.
   */
  async peek(rootId: string, day: string): Promise<{ pending: boolean; orphan: boolean; usable: boolean; denied: boolean; today: number }> {
    const k = taskBudgetKey(rootId);
    const q = await this.pool.query<{ pending: boolean; orphan: boolean; usable: boolean; denied: boolean; today: number }>(
      `SELECT EXISTS (SELECT 1 FROM ot_requests WHERE root_id = $1 AND status = 'pending' AND expires_at > now()) AS pending,
              EXISTS (SELECT 1 FROM ot_requests WHERE root_id = $1 AND status = 'pending' AND expires_at > now() AND card_message_id IS NULL) AS orphan,
              EXISTS (SELECT 1 FROM ot_requests o WHERE o.root_id = $1 AND ${LIVE_TERMS('o', '$2')} AND ${CAP_TERMS('o', '$3', '$4')}) AS usable,
              EXISTS (SELECT 1 FROM ot_requests WHERE root_id = $1 AND local_day = $2::date AND status = 'denied') AS denied,
              (SELECT count(*)::int FROM ot_requests WHERE root_id = $1 AND local_day = $2::date) AS today`,
      [rootId, day, k.day, k.scope],
    );
    return q.rows[0]!;
  }

  async get(id: number): Promise<OtRequest | null> {
    return (await this.pool.query<OtRequest>(`SELECT ${COLS} FROM ot_requests WHERE id = $1`, [id])).rows[0] ?? null;
  }

  /** The row whose card is this message (any status), or null. */
  async ofMessage(messageId: string): Promise<OtRequest | null> {
    if (!SNOWFLAKE.test(messageId)) return null;
    return (await this.pool.query<OtRequest>(`SELECT ${COLS} FROM ot_requests WHERE card_message_id = $1 ORDER BY id DESC LIMIT 1`, [messageId])).rows[0] ?? null;
  }

  /** Settled spend of the tree so far (the task budget row, read only, no lock), for the card. */
  async spentOf(rootId: string): Promise<number> {
    const k = taskBudgetKey(rootId);
    const q = await this.pool.query<{ s: number }>('SELECT COALESCE((SELECT spent_usd FROM budget_days WHERE day = $1::date AND scope = $2 AND scope_id = $3), 0)::float8 AS s', [k.day, k.scope, rootId]);
    return q.rows[0]?.s ?? 0;
  }

  // ---- raise --------------------------------------------------------------------------------------------------------------------------

  /**
   * One transaction under an advisory lock: this root's stale pending row is expired (OT-C6), then the preconditions and the three daily caps are
   * checked (OT-C9; a card that failed to post still counts: its row is only ended, never deleted, OT-C11), then the row is inserted with its
   * expiry and day computed on the database clock (OT-C14). The caller has already checked enabled, off day, halt and the origin of the tree.
   */
  async raise(a: { rootId: string; requestedBy: string; tz: string; perRoot: number; perDay: number; perPerson: number }): Promise<RaiseResult> {
    const client = await this.pool.connect();
    const expired: { channelId: string; messageId: string }[] = [];
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [RAISE_LOCK]);
      const stale = await client.query<{ c: string | null; m: string | null }>(
        "UPDATE ot_requests SET status = 'expired' WHERE root_id = $1 AND status = 'pending' AND expires_at <= now() RETURNING card_channel_id AS c, card_message_id AS m",
        [a.rootId],
      );
      for (const r of stale.rows) if (r.c && r.m) expired.push({ channelId: r.c, messageId: r.m });
      const fail = async (why: Extract<RaiseResult, { ok: false }>['why']): Promise<RaiseResult> => { await client.query('COMMIT'); return { ok: false, why, expired }; };
      const day = (await client.query<{ d: string }>(`SELECT ${TODAY('$1')}::text AS d`, [a.tz])).rows[0]!.d;
      const alive = await client.query("SELECT 1 FROM tasks WHERE id = $1 AND status NOT IN ('done','cancelled')", [a.rootId]);
      if (!alive.rowCount) return fail('ended');
      if ((await client.query("SELECT 1 FROM ot_requests WHERE root_id = $1 AND status = 'pending'", [a.rootId])).rowCount) return fail('pending');
      const k = taskBudgetKey(a.rootId);
      if ((await client.query(`SELECT 1 FROM ot_requests o WHERE o.root_id = $1 AND ${LIVE_TERMS('o', '$2')} AND ${CAP_TERMS('o', '$3', '$4')}`, [a.rootId, day, k.day, k.scope])).rowCount) return fail('usable');
      if ((await client.query("SELECT 1 FROM ot_requests WHERE root_id = $1 AND local_day = $2::date AND status = 'denied'", [a.rootId, day])).rowCount) return fail('denied');
      const n = await client.query<{ root: number; total: number; person: number }>(
        `SELECT count(*) FILTER (WHERE root_id = $1)::int AS root, count(*)::int AS total, count(*) FILTER (WHERE requested_by = $3)::int AS person
         FROM ot_requests WHERE local_day = $2::date`,
        [a.rootId, day, a.requestedBy],
      );
      const c = n.rows[0]!;
      if (c.root >= a.perRoot) return fail('cap_root');
      if (c.total >= a.perDay) return fail('cap_day');
      if (c.person >= a.perPerson) return fail('cap_person');
      const ins = await client.query<OtRequest>(
        `INSERT INTO ot_requests (root_id, local_day, seq, requested_by, digest, expires_at)
         VALUES ($1, $2::date, $3, $4, $5, ${MIDNIGHT('$6')}) RETURNING ${COLS}`,
        [a.rootId, day, c.root + 1, a.requestedBy, randomBytes(6).toString('hex'), a.tz],
      );
      await client.query('COMMIT');
      return { ok: true, row: ins.rows[0]!, expired };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Stores the card the request was posted as (only the first value is kept); false when the row already has one or the ids are not snowflakes. */
  async setCard(id: number, channelId: string, messageId: string): Promise<boolean> {
    if (!SNOWFLAKE.test(channelId) || !SNOWFLAKE.test(messageId)) return false;
    const r = await this.pool.query('UPDATE ot_requests SET card_channel_id = $2, card_message_id = $3 WHERE id = $1 AND card_message_id IS NULL', [id, channelId, messageId]);
    return (r.rowCount ?? 0) > 0;
  }

  /** OT-C11: a card that could not be posted (or whose id could not be stored) ends the request; the row stays and still counts toward the caps. */
  async endUnposted(id: number): Promise<void> {
    await this.pool.query("UPDATE ot_requests SET status = 'expired' WHERE id = $1 AND status = 'pending'", [id]);
  }

  // ---- decisions ----------------------------------------------------------------------------------------------------------------------

  /**
   * Approve OT (spec approve tx; OT-C6, OT-C13, OT-C16): root row then the OT row locked, then every gate, then the supersede of earlier
   * unrevoked grants of the tree, then the grant. `gates` are read inside the transaction (the live calendar, halt and switch).
   */
  async approve(c: CardRef & { id: number; tz: string; hours: number; maxRuns: number; maxUsd: number; gates: { offDay(): boolean; halted(): boolean; enabled(): boolean } }): Promise<ApproveResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const peek = await client.query<{ root_id: string }>('SELECT root_id FROM ot_requests WHERE id = $1', [c.id]);
      if (!peek.rows[0]) { await client.query('ROLLBACK'); return { ok: false, error: 'not_found' }; }
      const root = await client.query<{ status: string }>('SELECT status FROM tasks WHERE id = $1 FOR UPDATE', [peek.rows[0].root_id]);
      const row = (await client.query<OtRequest & { today: string; midnightSoon: boolean; stale: boolean }>(
        `SELECT ${COLS}, ${TODAY('$2')}::text AS today, (${MIDNIGHT('$2')} <= now() + interval '1 minute') AS "midnightSoon", (expires_at <= now()) AS stale FROM ot_requests WHERE id = $1 FOR UPDATE`,
        [c.id, c.tz],
      )).rows[0];
      const refuse = async (error: ApproveError): Promise<ApproveResult> => { await client.query('ROLLBACK'); return { ok: false, error }; };
      if (!row) return refuse('not_found');
      if (!c.messageId || !c.channelId || !row.cardMessageId || !row.cardChannelId || row.digest !== c.digest || row.cardMessageId !== c.messageId || row.cardChannelId !== c.channelId) return refuse('wrong_card');
      if (row.status !== 'pending') return refuse(row.status === 'moot' ? 'moot' : 'not_pending');
      if (row.stale || row.localDay !== row.today || row.midnightSoon) return refuse('expired');
      if (!root.rows[0] || root.rows[0].status === 'done' || root.rows[0].status === 'cancelled') return refuse('root_ended');
      if (!c.gates.enabled()) return refuse('disabled');
      if (c.gates.halted()) return refuse('halted');
      if (!c.gates.offDay()) return refuse('moot');
      const k = taskBudgetKey(row.rootId);
      const superseded = await client.query<OtRequest>(`UPDATE ot_requests SET revoked_at = now(), revoked_by = $2, revoke_reason = 'superseded' WHERE root_id = $1 AND status = 'approved' AND revoked_at IS NULL RETURNING ${COLS}`, [row.rootId, c.userId]);
      const up = await client.query<OtRequest>(
        `UPDATE ot_requests SET status = 'approved', decided_by = $2, decided_at = now(),
           grant_expires_at = LEAST(now() + $3::float8 * interval '1 hour', ${MIDNIGHT('$4')}), max_runs = $5, max_usd = $6,
           usd_base = COALESCE((SELECT spent_usd FROM budget_days WHERE day = $7::date AND scope = $8 AND scope_id = $9), 0)
         WHERE id = $1 AND status = 'pending' AND expires_at > now() RETURNING ${COLS}`,
        [c.id, c.userId, c.hours, c.tz, c.maxRuns, c.maxUsd, k.day, k.scope, row.rootId],
      );
      if (!up.rows[0]) return refuse('not_pending');
      await client.query('COMMIT');
      return { ok: true, row: up.rows[0], superseded: superseded.rows };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Deny: one conditional UPDATE with the same card gates; sticky for the rest of the day (the raise reads it). Returns the row or the reason. */
  async deny(c: CardRef & { id: number }): Promise<{ ok: true; row: OtRequest } | { ok: false; error: ApproveError }> {
    if (!c.messageId || !c.channelId) return { ok: false, error: 'wrong_card' };
    const up = await this.pool.query<OtRequest>(
      `UPDATE ot_requests SET status = 'denied', decided_by = $2, decided_at = now()
       WHERE id = $1 AND status = 'pending' AND digest = $3 AND card_message_id = $4 AND card_channel_id = $5 AND expires_at > now() RETURNING ${COLS}`,
      [c.id, c.userId, c.digest, c.messageId, c.channelId],
    );
    if (up.rows[0]) return { ok: true, row: up.rows[0] };
    return { ok: false, error: await this.whyNot(c) };
  }

  /**
   * "Approve whole day", the claim (OT-C6): ONE conditional UPDATE pending -> workday carrying every gate of approve: digest, the stored card message,
   * `card_channel_id = $configChannel`, unexpired AND the request's own day is today. The caller then opens `row.localDay`, never "today".
   */
  async claimDay(c: CardRef & { id: number; tz: string; configChannelId: string }): Promise<{ ok: true; row: OtRequest } | { ok: false; error: ApproveError }> {
    if (!c.messageId || !c.channelId || c.channelId !== c.configChannelId) return { ok: false, error: 'wrong_card' };
    const up = await this.pool.query<OtRequest>(
      `UPDATE ot_requests SET status = 'workday', decided_by = $2, decided_at = now()
       WHERE id = $1 AND status = 'pending' AND digest = $3 AND card_message_id = $4 AND card_channel_id = $5 AND expires_at > now()
         AND local_day = ${TODAY('$6')} RETURNING ${COLS}`,
      [c.id, c.userId, c.digest, c.messageId, c.configChannelId, c.tz],
    );
    if (up.rows[0]) return { ok: true, row: up.rows[0] };
    return { ok: false, error: await this.whyNot(c) };
  }

  /** The day plan failed with an error other than "already a workday": the claim is given back (the card can still be decided). */
  async unclaimDay(id: number): Promise<void> {
    try {
      await this.pool.query("UPDATE ot_requests SET status = 'pending', decided_by = NULL, decided_at = NULL WHERE id = $1 AND status = 'workday'", [id]);
    } catch (err) {
      // G2OT-04: a newer pending row of the tree took the one-pending slot meanwhile: this request ends instead of staying `workday` with the day not opened
      if ((err as { code?: unknown } | null)?.code !== '23505') throw err;
      await this.pool.query("UPDATE ot_requests SET status = 'expired' WHERE id = $1 AND status = 'workday'", [id]);
    }
  }

  private async whyNot(c: CardRef & { id: number }): Promise<ApproveError> {
    const r = (await this.pool.query<OtRequest & { stale: boolean }>(`SELECT ${COLS}, (expires_at <= now()) AS stale FROM ot_requests WHERE id = $1`, [c.id])).rows[0];
    if (!r) return 'not_found';
    if (!c.messageId || !c.channelId || !r.cardMessageId || r.digest !== c.digest || r.cardMessageId !== c.messageId || r.cardChannelId !== c.channelId) return 'wrong_card';
    if (r.status === 'moot') return 'moot';
    if (r.status !== 'pending') return 'not_pending';
    return 'expired'; // pending but a gate failed: expiry or the day (a stale row of yesterday)
  }

  // ---- consume ------------------------------------------------------------------------------------------------------------------------

  /** One start's run: ONE conditional UPDATE (spec consume). Never throws: a refusal or a fault is `ok: false`. */
  async consume(rootId: string, day: string): Promise<ConsumeResult> {
    try {
      const gate = await this.precheck();
      if (gate) return { ok: false, why: gate };
      const k = taskBudgetKey(rootId);
      const u = await this.pool.query<{ id: number; runs: number; max: number; until: Date }>(
        `UPDATE ot_requests o SET runs_used = o.runs_used + 1
         WHERE o.root_id = $1 AND ${LIVE_TERMS('o', '$2')} AND ${CAP_TERMS('o', '$3', '$4')}
         RETURNING o.id::int AS id, o.runs_used AS runs, o.max_runs AS max, o.grant_expires_at AS until`,
        [rootId, day, k.day, k.scope],
      );
      const r = u.rows[0];
      if (r) return { ok: true, id: r.id, runsUsed: r.runs, maxRuns: r.max, grantExpiresAt: r.until };
      const live = await this.pool.query('SELECT 1 FROM ot_requests o WHERE o.root_id = $1 AND ' + LIVE_TERMS('o', '$2'), [rootId, day]);
      return { ok: false, why: live.rowCount ? 'exhausted' : 'none' };
    } catch (err) {
      this.fault(err);
      return { ok: false, why: 'error' };
    }
  }

  // ---- revoke, ends, sweeps -------------------------------------------------------------------------------------------------------------

  /** Admin revoke of a grant (its own card is checked by the caller); the row, or null when it was not an unrevoked approved grant. */
  async revoke(id: number, by: string, reason: OtRevokeReason): Promise<OtRequest | null> {
    const r = await this.pool.query<OtRequest>(
      `UPDATE ot_requests SET revoked_at = now(), revoked_by = $2, revoke_reason = $3 WHERE id = $1 AND status = 'approved' AND revoked_at IS NULL RETURNING ${COLS}`,
      [id, by, reason],
    );
    return r.rows[0] ?? null;
  }

  /** Revokes every unrevoked grant (halt, resume, the switch turned off). A failed halt revoke is owed to the next call. */
  async revokeAll(reason: OtRevokeReason, by = 'system'): Promise<OtRequest[]> {
    try {
      const r = await this.pool.query<OtRequest>(`UPDATE ot_requests SET revoked_at = now(), revoked_by = $1, revoke_reason = $2 WHERE status = 'approved' AND revoked_at IS NULL RETURNING ${COLS}`, [by, reason]);
      if (reason === 'halt' || reason === 'admin') this.revokeOwed = null; // this revoked every unrevoked grant, whichever reason was owed
      return r.rows;
    } catch (err) {
      if (reason === 'halt' || reason === 'admin') this.revokeOwed = reason === 'halt' || this.revokeOwed !== 'halt' ? reason : this.revokeOwed;
      throw err;
    }
  }

  /** OT-C4, boot: a grant decided before the `halted` config row last changed lived through a halt (and maybe a resume) while this process was down. */
  async revokeBeforeHaltedRow(): Promise<OtRequest[]> {
    const r = await this.pool.query<OtRequest>(
      `UPDATE ot_requests SET revoked_at = now(), revoked_by = 'system', revoke_reason = 'halt'
       WHERE status = 'approved' AND revoked_at IS NULL AND decided_at < (SELECT updated_at FROM config WHERE key = 'halted') RETURNING ${COLS}`,
    );
    return r.rows;
  }

  /** Today became a workday: every pending request is moot. The cards to close are returned. */
  async closeMoot(): Promise<{ channelId: string; messageId: string }[]> {
    return cards(await this.pool.query<{ c: string | null; m: string | null }>("UPDATE ot_requests SET status = 'moot' WHERE status = 'pending' RETURNING card_channel_id AS c, card_message_id AS m"));
  }

  /** The sweep: pending requests past their expiry end (their cards are returned to close); a grant on an ended tree is revoked `root_ended`. */
  async sweep(): Promise<{ expired: { channelId: string; messageId: string }[]; ended: OtRequest[] }> {
    const e = await this.pool.query<{ c: string | null; m: string | null }>("UPDATE ot_requests SET status = 'expired' WHERE status = 'pending' AND expires_at <= now() RETURNING card_channel_id AS c, card_message_id AS m");
    const ended = await this.pool.query<OtRequest>(
      `UPDATE ot_requests o SET revoked_at = now(), revoked_by = 'system', revoke_reason = 'root_ended'
       WHERE o.status = 'approved' AND o.revoked_at IS NULL AND EXISTS (SELECT 1 FROM tasks r WHERE r.id = o.root_id AND r.status IN ('done','cancelled')) RETURNING ${COLS}`,
    );
    return { expired: cards(e), ended: ended.rows };
  }
}

const cards = (r: { rows: { c: string | null; m: string | null }[] }): { channelId: string; messageId: string }[] =>
  r.rows.filter((x): x is { c: string; m: string } => !!x.c && !!x.m).map((x) => ({ channelId: x.c, messageId: x.m }));
