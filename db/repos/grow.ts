import type { Pool } from '../pool.js';
import { taskCols, type Task } from './tasks.js';
import { FORGE_FAILED_CODES as BUILD_CODES } from './dept-incidents.js';
import type { RetroRows } from '../../grow/retro-facts.js';

export type RetroOutcome = 'done' | 'failed' | 'interrupted';
export type RetroSkillSlot = 'claimed' | 'used' | 'not_retro';
/** LEARN-1 (D4a): a weekly retro keeps its week key; manual and incident retros share one `D<YYYY-MM-DD>` claim per department per local day. */
export type RetroKind = 'weekly' | 'manual' | 'incident';
export interface RequestedRetro { deptId: string; week: string; kind: RetroKind }

/**
 * GROW-1 (SA-1 3.1): the weekly retro's claim row per (department, ISO week), the one-skill-per-retro claim, the boot cleanup and the facts queries.
 * The claim is an INSERT ... ON CONFLICT DO NOTHING (awaited; a failed write starts nothing). Every facts query takes the department as `$1` and reads only
 * the sources listed in Gate 1 GW-C5; model-written text comes from untainted, non-outside-origin rows only.
 */
export class RetroRepo {
  constructor(private readonly pool: Pool) {}

  /** True when this call wrote the claim row. A second claim of the same (dept, week) is a no-op (false); a database error throws. */
  async claim(dept: string, week: string, taskId: string): Promise<boolean> {
    const r = await this.pool.query('INSERT INTO retro_runs (dept_id, week, task_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [dept, week, taskId]);
    return (r.rowCount ?? 0) === 1;
  }

  /** LEARN-1: queue an on-demand retro (task_id NULL until the tick assigns one). true = queued; false = the day key already exists for that department (manual or incident, any outcome). */
  async request(dept: string, key: string, kind: Exclude<RetroKind, 'weekly'>): Promise<boolean> {
    const r = await this.pool.query('INSERT INTO retro_runs (dept_id, week, kind) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [dept, key, kind]);
    return (r.rowCount ?? 0) === 1;
  }

  /** The oldest queued requests (task_id NULL, no outcome). */
  async nextRequested(): Promise<RequestedRetro[]> {
    return (await this.pool.query<RequestedRetro>('SELECT dept_id AS "deptId", week, kind FROM retro_runs WHERE task_id IS NULL AND outcome IS NULL ORDER BY claimed_at LIMIT 20')).rows;
  }

  /** CAS on `task_id IS NULL`: true when this call took the row. */
  async assign(dept: string, key: string, taskId: string): Promise<boolean> {
    const r = await this.pool.query('UPDATE retro_runs SET task_id = $3 WHERE dept_id = $1 AND week = $2 AND task_id IS NULL AND outcome IS NULL', [dept, key, taskId]);
    return (r.rowCount ?? 0) === 1;
  }

  /** Requests older than 24 hours are dropped (outcome failed). Returns how many. */
  async expireRequested(): Promise<number> {
    const r = await this.pool.query("UPDATE retro_runs SET outcome = 'failed', finished_at = now() WHERE task_id IS NULL AND outcome IS NULL AND claimed_at < now() - interval '24 hours'");
    return r.rowCount ?? 0;
  }

  /**
   * S8: task_blocked, tool_errors and forge_failed incidents of the last 7 days that are newer than the department's latest retro claim of any kind. forge_failed (Gate 2 answer 10) is counted only
   * by `kind` and `code`, only with a code of the closed build list ($2); its department is the release's (S9). No text column is read.
   */
  async incidentsSinceLastRetro(dept: string): Promise<number> {
    return (await this.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM dept_incidents WHERE dept_id = $1 AND kind IN ('task_blocked','tool_errors','forge_failed') AND (kind <> 'forge_failed' OR code = ANY($2::text[])) AND created_at >= now() - interval '7 days'
         AND created_at > COALESCE((SELECT max(claimed_at) FROM retro_runs WHERE dept_id = $1), '-infinity'::timestamptz)`, [dept, BUILD_CODES])).rows[0]?.n ?? 0;
  }

  async claimed(dept: string, week: string): Promise<boolean> {
    return (await this.pool.query('SELECT 1 FROM retro_runs WHERE dept_id = $1 AND week = $2', [dept, week])).rowCount === 1;
  }

  /** Records the outcome once (a row that already has one keeps it). */
  async finish(dept: string, week: string, outcome: RetroOutcome): Promise<void> {
    await this.pool.query('UPDATE retro_runs SET outcome = $3, finished_at = now() WHERE dept_id = $1 AND week = $2 AND outcome IS NULL', [dept, week, outcome]);
  }

  /** One skill per retro: a single conditional UPDATE. 'used' = the retro already claimed its skill; 'not_retro' = no retro row names this task. */
  async claimSkill(taskId: string): Promise<RetroSkillSlot> {
    const r = await this.pool.query('UPDATE retro_runs SET skill_claimed_at = now() WHERE task_id = $1 AND skill_claimed_at IS NULL', [taskId]);
    if ((r.rowCount ?? 0) === 1) return 'claimed';
    return (await this.pool.query('SELECT 1 FROM retro_runs WHERE task_id = $1', [taskId])).rowCount ? 'used' : 'not_retro';
  }

  /** The proposal was refused or threw after the claim: give the slot back (only while no proposal is recorded). */
  async releaseSkill(taskId: string): Promise<void> {
    await this.pool.query('UPDATE retro_runs SET skill_claimed_at = NULL WHERE task_id = $1 AND skill_proposal_id IS NULL', [taskId]);
  }

  async setSkillProposal(taskId: string, proposalId: number): Promise<void> {
    await this.pool.query('UPDATE retro_runs SET skill_proposal_id = $2 WHERE task_id = $1', [taskId, proposalId]);
  }

  /**
   * GW-C6 (boot): cancels EVERY non-terminal task a retro_runs row names, whatever the row's outcome (a task whose closeRetro failed stays `doing` with outcome
   * `done`; the boot reset would turn it into a plain full-tool owner run). Then marks the rows that never finished `interrupted`. Returns the moved tasks.
   */
  async closeOpenRetroTasks(): Promise<Task[]> {
    const moved = (await this.pool.query<Task>(
      `UPDATE tasks SET status = 'cancelled', updated_at = now()
       WHERE status NOT IN ('done','cancelled') AND id IN (SELECT task_id FROM retro_runs WHERE task_id IS NOT NULL)
       RETURNING ${taskCols()}`,
    )).rows;
    // LEARN-1: a queued request (task_id NULL) survives a restart; weekly claims always write task_id, so GW-C6 is unchanged for them
    await this.pool.query("UPDATE retro_runs SET outcome = 'interrupted', finished_at = now() WHERE outcome IS NULL AND task_id IS NOT NULL");
    return moved;
  }

  /** F1-F8 (SA-1 3.1, window 7 days). The retro's own tasks never count. Tool errors come from audit rows by code only (no error text exists). */
  async facts(dept: string): Promise<RetroRows> {
    const q = async <T>(sql: string, extra: unknown[] = []): Promise<T[]> => (await this.pool.query(sql, [dept, ...extra])).rows as T[];
    const WIN = `dept_id = $1 AND status IN ('done','blocked','cancelled') AND updated_at >= now() - interval '7 days' AND id NOT IN (SELECT task_id FROM retro_runs WHERE task_id IS NOT NULL)`;
    const [counts, titles, toolErrors, heal, escalations, skills, proposals, notes, incidents] = await Promise.all([
      q<RetroRows['counts'][number]>(`SELECT status, count(*)::int AS n FROM tasks WHERE ${WIN} GROUP BY status`),
      // F2 / GW-C5: untainted AND not an outside origin (a caller can pass tainted=false for a watch/import/poll task)
      q<RetroRows['titles'][number]>(`SELECT status, title FROM tasks WHERE ${WIN} AND tainted = false AND origin NOT IN ('watch','import','poll') ORDER BY updated_at DESC LIMIT 15`),
      q<RetroRows['toolErrors'][number]>(
        `SELECT a.tool, a.outcome, count(*)::int AS n FROM audit_log a LEFT JOIN personas p ON a.actor = 'persona:' || p.id
         WHERE a.action = 'tool' AND a.ts >= now() - interval '7 days'
           AND a.outcome IN ('tool_error','error','invalid_input','refused','denied','unknown_tool','approval_not_owner','approval_needs_task')
           AND (a.actor = 'head:' || $1 OR p.dept_id = $1)
         GROUP BY a.tool, a.outcome ORDER BY n DESC, a.tool, a.outcome LIMIT 15`),
      q<RetroRows['heal'][number]>(
        `SELECT a.action, CASE WHEN a.action = 'task.heal.resolve' THEN a.outcome END AS outcome, count(*)::int AS n
         FROM audit_log a JOIN tasks t ON t.id = a.task_id
         WHERE a.action IN ('task.autoretry','task.heal.wake','task.heal.resolve') AND a.ts >= now() - interval '7 days' AND t.dept_id = $1
           AND (a.action <> 'task.heal.wake' OR a.outcome LIKE 'claim %')
         GROUP BY 1, 2 ORDER BY 1, 2`),
      q<RetroRows['escalations'][number]>(
        `SELECT substring(a.outcome from '^#[0-9]+ ([a-z_:]+)') AS code, count(*)::int AS n FROM audit_log a JOIN tasks t ON t.id = a.task_id
         WHERE a.action = 'approval.ai.escalate' AND a.ts >= now() - interval '7 days' AND t.dept_id = $1 GROUP BY 1 ORDER BY n DESC LIMIT 10`),
      q<RetroRows['skills'][number]>(
        `SELECT s.id, s.title, s.active_version AS version FROM skills s
         WHERE s.status = 'active' AND (s.owner_dept = $1 OR EXISTS (
           SELECT 1 FROM skill_attachments a LEFT JOIN personas p ON a.target_kind = 'persona' AND p.id = a.target_id
           WHERE a.skill_id = s.id AND ((a.target_kind = 'dept' AND a.target_id = $1) OR p.dept_id = $1)))
         ORDER BY s.id LIMIT 20`),
      q<RetroRows['proposals'][number]>(`SELECT id, kind, skill_id AS "skillId", status FROM skill_proposals WHERE dept_id = $1 AND status IN ('open','card') ORDER BY id LIMIT 10`),
      q<RetroRows['notes'][number]>('SELECT body FROM dept_notes WHERE dept_id = $1 AND tainted = false ORDER BY created_at DESC LIMIT 10'),
      // F9 (LEARN-1 S7): code-built incident counts only (kind, code, count). forge_failed (Gate 2 answer 10) only with a code of the closed build list ($2); the retro-facts renderer checks the list again.
      q<RetroRows['incidents'][number]>(`SELECT kind, code, sum(n)::int AS n FROM dept_incidents WHERE dept_id = $1 AND kind IN ('task_blocked','task_cancelled','forge_failed') AND (kind <> 'forge_failed' OR code = ANY($2::text[])) AND created_at >= now() - interval '7 days' GROUP BY 1, 2`, [BUILD_CODES]),
    ]);
    return { counts, titles, toolErrors, heal, escalations, skills, proposals, notes, incidents };
  }
}

// ---- GROW-1 tool_request and tool_idea (SA-1 3.3, 3.4; Gate 1 GW-C16..C24) ----------------------------------------------------------------

export type ToolRequestStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'void';
export interface ToolRequestRow {
  id: number;
  token: string;
  deptId: string;
  tool: string;
  reason: string;
  taskId: string | null;
  status: ToolRequestStatus;
  channelId: string | null;
  messageId: string | null;
  createdAt: Date;
  expiresAt: Date;
  decidedBy: string | null;
  outcome: string | null;
  /** Computed by the database clock: `expires_at > now()`. */
  live: boolean;
}
const TR_COLS = `id, token, dept_id AS "deptId", tool, reason, task_id AS "taskId", status, channel_id AS "channelId", message_id AS "messageId",
  created_at AS "createdAt", expires_at AS "expiresAt", decided_by AS "decidedBy", outcome, (expires_at > now()) AS live`;

/** Advisory lock keys (Gate 1 GW-C23, C24). */
export const TOOL_REQUEST_LOCK = 7_311_040;
export const TOOL_IDEA_LOCK = 7_311_041;
export const TOOL_REQUEST_OPEN_MAX = 3;
export const TOOL_IDEA_OPEN_MAX = 5;

export type ToolRequestCreate = { ok: true; id: number; token: string; expiresAt: Date } | { ok: false; code: 'open_cap' | 'pending_exists' | 'recently_rejected' };

export class ToolRequestRepo {
  constructor(private readonly pool: Pool) {}

  /**
   * One transaction under `pg_advisory_xact_lock(7311040)`: more than 3 pending for the department -> open_cap; a pending row for the pair (also the unique index,
   * 23505) -> pending_exists; a rejection of the pair in the last 7 days -> recently_rejected (GW-C21); else the insert with a 128-bit token and a 7 day expiry.
   */
  async create(dept: string, tool: string, reason: string, taskId: string | null, token: string): Promise<ToolRequestCreate> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock($1)', [TOOL_REQUEST_LOCK]);
      const n = (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM tool_requests WHERE dept_id = $1 AND status = 'pending'", [dept])).rows[0]!.n;
      if (n >= TOOL_REQUEST_OPEN_MAX) { await c.query('ROLLBACK'); return { ok: false, code: 'open_cap' }; }
      if ((await c.query("SELECT 1 FROM tool_requests WHERE dept_id = $1 AND tool = $2 AND status = 'pending'", [dept, tool])).rowCount) { await c.query('ROLLBACK'); return { ok: false, code: 'pending_exists' }; }
      if ((await c.query("SELECT 1 FROM tool_requests WHERE dept_id = $1 AND tool = $2 AND status = 'rejected' AND decided_at > now() - interval '7 days'", [dept, tool])).rowCount) { await c.query('ROLLBACK'); return { ok: false, code: 'recently_rejected' }; }
      const r = await c.query<{ id: number; expiresAt: Date }>(
        "INSERT INTO tool_requests (token, dept_id, tool, reason, task_id, expires_at) VALUES ($1,$2,$3,$4,$5, now() + interval '7 days') RETURNING id, expires_at AS \"expiresAt\"",
        [token, dept, tool, reason, taskId]);
      await c.query('COMMIT');
      return { ok: true, id: r.rows[0]!.id, token, expiresAt: r.rows[0]!.expiresAt };
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      if ((e as { code?: string }).code === '23505') return { ok: false, code: 'pending_exists' };
      throw e;
    } finally {
      c.release();
    }
  }

  async byToken(token: string): Promise<ToolRequestRow | null> {
    return (await this.pool.query<ToolRequestRow>(`SELECT ${TR_COLS} FROM tool_requests WHERE token = $1`, [token])).rows[0] ?? null;
  }

  async byId(id: number): Promise<ToolRequestRow | null> {
    return (await this.pool.query<ToolRequestRow>(`SELECT ${TR_COLS} FROM tool_requests WHERE id = $1`, [id])).rows[0] ?? null;
  }

  /** The card was posted: store where, so a click is checked against it (GW-C19). */
  async setCard(id: number, channelId: string, messageId: string): Promise<boolean> {
    return ((await this.pool.query("UPDATE tool_requests SET channel_id = $2, message_id = $3 WHERE id = $1 AND status = 'pending'", [id, channelId, messageId])).rowCount ?? 0) === 1;
  }

  /** Reject: one conditional UPDATE; null = someone else decided first or it expired. */
  async reject(token: string, by: string): Promise<ToolRequestRow | null> {
    const r = await this.pool.query<{ id: number }>(
      "UPDATE tool_requests SET status = 'rejected', decided_by = $2, decided_at = now(), outcome = 'rejected' WHERE token = $1 AND status = 'pending' AND expires_at > now() RETURNING id", [token, by]);
    return r.rows[0] ? this.byId(r.rows[0].id) : null;
  }

  /** Approve claim (GW-C20): status approved with outcome 'applying' until the write is confirmed. */
  async claim(token: string, by: string): Promise<ToolRequestRow | null> {
    const r = await this.pool.query<{ id: number }>(
      "UPDATE tool_requests SET status = 'approved', decided_by = $2, decided_at = now(), outcome = 'applying' WHERE token = $1 AND status = 'pending' AND expires_at > now() RETURNING id", [token, by]);
    return r.rows[0] ? this.byId(r.rows[0].id) : null;
  }

  /** The claimed row's final outcome: `ok` / `already` stay approved; anything else is void. Only touches a row that is still the claim. */
  async settle(id: number, outcome: 'ok' | 'already' | string, status: 'approved' | 'void' = 'approved'): Promise<boolean> {
    return ((await this.pool.query("UPDATE tool_requests SET status = $3, outcome = $2 WHERE id = $1 AND status = 'approved' AND outcome = 'applying'", [id, outcome.slice(0, 64), status])).rowCount ?? 0) === 1;
  }

  /** CAS lost (or a failure before the write): back to pending. */
  async revert(id: number): Promise<boolean> {
    return ((await this.pool.query("UPDATE tool_requests SET status = 'pending', decided_by = NULL, decided_at = NULL, outcome = NULL WHERE id = $1 AND status = 'approved' AND outcome = 'applying'", [id])).rowCount ?? 0) === 1;
  }

  /** The 7 day sweep: one UPDATE, returns what it expired. */
  async expire(): Promise<ToolRequestRow[]> {
    const r = await this.pool.query<{ id: number }>("UPDATE tool_requests SET status = 'expired' WHERE status = 'pending' AND expires_at <= now() RETURNING id");
    return (await Promise.all(r.rows.map((x) => this.byId(x.id)))).filter((x): x is ToolRequestRow => x !== null);
  }

  /** Boot (GW-C20): claims a crash left half done. */
  async applying(): Promise<ToolRequestRow[]> {
    return (await this.pool.query<ToolRequestRow>(`SELECT ${TR_COLS} FROM tool_requests WHERE status = 'approved' AND outcome = 'applying' ORDER BY id`)).rows;
  }

  async listPending(limit = 25): Promise<ToolRequestRow[]> {
    return (await this.pool.query<ToolRequestRow>(`SELECT ${TR_COLS} FROM tool_requests WHERE status = 'pending' ORDER BY id LIMIT $1`, [limit])).rows;
  }
}

export interface ToolIdeaRow {
  id: number;
  deptId: string;
  name: string;
  problem: string;
  example: string;
  tainted: boolean;
  createdAt: Date;
}
export type ToolIdeaCreate = { ok: true; id: number } | { ok: false; code: 'open_cap' | 'duplicate' };

export class ToolIdeaRepo {
  constructor(private readonly pool: Pool) {}

  /** One transaction under `pg_advisory_xact_lock(7311041)`: 5 open for the department -> open_cap; the partial unique index (23505) -> duplicate. */
  async create(i: { dept: string; name: string; problem: string; example: string; tainted: boolean; taskId: string | null }): Promise<ToolIdeaCreate> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock($1)', [TOOL_IDEA_LOCK]);
      const n = (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM tool_ideas WHERE dept_id = $1 AND status = 'open'", [i.dept])).rows[0]!.n;
      if (n >= TOOL_IDEA_OPEN_MAX) { await c.query('ROLLBACK'); return { ok: false, code: 'open_cap' }; }
      const r = await c.query<{ id: number }>(
        'INSERT INTO tool_ideas (dept_id, name, problem, example, tainted, task_id, proposer) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [i.dept, i.name, i.problem, i.example, i.tainted, i.taskId, `head:${i.dept}`]);
      await c.query('COMMIT');
      return { ok: true, id: r.rows[0]!.id };
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      if ((e as { code?: string }).code === '23505') return { ok: false, code: 'duplicate' };
      throw e;
    } finally {
      c.release();
    }
  }

  async listOpen(limit = 25): Promise<ToolIdeaRow[]> {
    return (await this.pool.query<ToolIdeaRow>(
      `SELECT id, dept_id AS "deptId", name, problem, example, tainted, created_at AS "createdAt" FROM tool_ideas WHERE status = 'open' ORDER BY id LIMIT $1`, [limit])).rows;
  }

  async close(id: number, by: string, reason: string | null): Promise<boolean> {
    return ((await this.pool.query("UPDATE tool_ideas SET status = 'closed', closed_by = $2, closed_at = now(), close_reason = $3 WHERE id = $1 AND status = 'open'", [id, by, reason])).rowCount ?? 0) === 1;
  }
}
