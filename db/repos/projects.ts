import { randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { OUTSIDE_ORIGINS } from '../../agents/context.js';
import { localDay } from '../../company/calendar.js';
import type { ConfigStore } from '../../config/store.js';
import { FORGES_OPEN_MAX } from '../../forge/caps.js';
import { taskBudgetKey } from '../../governance/budget.js';
import type { Pool } from '../pool.js';
import { taskCols, type Task } from './tasks.js';

/**
 * AUTO-1 (SA-1 5.1, 5.2; Gate 1 AP-C4..AP-C15): projects (one confirmation per project) and the project-scoped tool grants.
 *
 * Rules held here:
 * - Postgres is the source of truth; nothing is cached.
 * - Every read inside a transaction uses the tx client. Every audit row that carries a count or a claim is a THROWING insert on the tx client, in the same transaction.
 * - Lock order everywhere: the root task row, then the projects row. (`decide` is the one exception: the new root does not exist yet, so it locks the projects row first; nobody else
 *   can see that root until COMMIT.)
 * - Advisory lock 7311042 serialises the proposal open cap and the project_tools cap. The GROW locks (7311040, 7311041) and the AI approver's lock are never reused.
 * - Nothing here logs; a caller that catches an error logs `errName` only.
 */

export const PROJECT_LOCK = 7311042;
export const PROJECT_TOOLS_MAX = 10;
export const PROJECT_OPEN_MAX = 3;
export const PROJECT_ADOPT_MAX = 20;
/** The imported `OUTSIDE_ORIGINS` of agents/context.ts, never a copy (AC-C1): recurring outside feeds are never adopted (AP-C4) and never company trees (AUTO-2). */
export const ADOPT_OUTSIDE_ORIGINS: readonly string[] = OUTSIDE_ORIGINS;
export const TREE_TOOLS_MAX = 5;

export type ProjectStatus = 'proposed' | 'active' | 'done' | 'cancelled';
export type AdoptCode = 'not_found' | 'not_root' | 'project_root' | 'ended' | 'outside_origin' | 'conversation' | 'running' | 'pending_approval' | 'has_grant' | 'too_deep' | 'children_cap';

export interface Project {
  id: number; token: string; title: string; goal: string; ownerDept: string; deadline: string;
  maxLocalCalls: number; maxUsd: number; maxApprovals: number; baseLocalCalls: number; baseUsd: number; baseApprovals: number; approvalsUsed: number;
  status: ProjectStatus; paused: boolean; exhaustedAt: Date | null; budgetToken: string | null; budgetChannelId: string | null; budgetMessageId: string | null; deadlineNoticedAt: Date | null;
  rootTaskId: string | null; adoptIds: string[]; proposer: string; tainted: boolean; channelId: string | null; messageId: string | null;
  createdAt: Date; expiresAt: Date; approvedBy: string | null; approvedAt: Date | null; closedBy: string | null; closedAt: Date | null;
}

const cols = (a = ''): string => `${a}id, ${a}token, ${a}title, ${a}goal, ${a}owner_dept AS "ownerDept", to_char(${a}deadline,'YYYY-MM-DD') AS deadline,
  ${a}max_local_calls AS "maxLocalCalls", ${a}max_usd AS "maxUsd", ${a}max_approvals AS "maxApprovals", ${a}base_local_calls AS "baseLocalCalls", ${a}base_usd AS "baseUsd", ${a}base_approvals AS "baseApprovals",
  ${a}approvals_used AS "approvalsUsed", ${a}status, ${a}paused, ${a}exhausted_at AS "exhaustedAt", ${a}budget_token AS "budgetToken", ${a}budget_channel_id AS "budgetChannelId", ${a}budget_message_id AS "budgetMessageId",
  ${a}deadline_noticed_at AS "deadlineNoticedAt", ${a}root_task_id AS "rootTaskId", ${a}adopt_ids AS "adoptIds", ${a}proposer, ${a}tainted, ${a}channel_id AS "channelId", ${a}message_id AS "messageId",
  ${a}created_at AS "createdAt", ${a}expires_at AS "expiresAt", ${a}approved_by AS "approvedBy", ${a}approved_at AS "approvedAt", ${a}closed_by AS "closedBy", ${a}closed_at AS "closedAt"`;
const COLS = cols();

export interface ProjectDeps {
  /** Read live: `autopilot.*`, `limits.depth`, `limits.childrenPerTask`, `schedule.timezone`. A read error on `autopilot.enabled` counts as off. */
  cfg: Pick<ConfigStore, 'get'>;
  halt: { isHalted(): boolean };
  now?: () => number;
}

/** `adopt` = the proposer's raw entries (exact ids or unique prefixes of 8 or more); `create` resolves them (SA-1 3.2) and stores only the eligible full ids. */
export type ProjectCreate = { title: string; goal: string; deadline: string; maxLocalCalls: number; maxUsd: number; proposer: string; tainted: boolean; adopt?: string[]; /** R7: the tool idea this proposal builds as a plugin; the forge row is inserted in the same transaction. */ ideaId?: number };
export type AdoptResolution = { ids: string[]; skipped: { id8: string; code: AdoptCode }[] };
/** R7: the forge a proposal created (the card line and the reply read it). */
export interface ForgeLink { id: number; ideaId: number; ideaName: string; deptId: string }
export type CreateResult = { ok: true; project: Project; adopt: AdoptResolution; forge?: ForgeLink } | { ok: false; code: 'halted' | 'off' | 'open_cap' | 'duplicate' | 'idea_invalid' | 'idea_busy' | 'forge_cap' };
export type DecideResult =
  | { ok: true; project: Project; root: Task; adopted: string[]; skipped: { id: string; code: AdoptCode }[] }
  | { ok: false; code: 'halted' | 'off' | 'not_found' | 'not_pending' | 'expired' };
export type ClaimResult = { kind: 'run'; used: number; max: number } | { kind: 'budget' } | { kind: 'not_active' };
export type SimpleResult = { ok: true; project: Project } | { ok: false; code: 'not_found' | 'not_active' | 'unchanged' };
export type CloseResult = { ok: true; project: Project; rootClosed: { task: Task; from: Task['status'] } | null } | { ok: false; code: 'not_found' | 'not_active' };
export type RaiseResult =
  | { ok: true; project: Project; unblocked: Task[] }
  | { ok: false; code: 'halted' | 'not_found' | 'not_active' | 'not_exhausted' | 'wrong_card' | 'raise_max' };
export type GrantResult = { ok: true } | { ok: false; code: 'not_active' | 'exists' | 'cap' | 'mcp' };
export type CompanyClaim = { kind: 'run'; day: number; tree: number } | { kind: 'cap'; which: 'day' | 'tree' | 'person' } | { kind: 'not_company' };
export type TreeGrantResult = { ok: true; rootId: string } | { ok: false; code: 'not_company' | 'exists' | 'cap' | 'mcp' };
export type ExtendResult = { ok: true; project: Project } | { ok: false; code: 'halted' | 'not_found' | 'not_active' | 'bad_date' };
export interface ProjectRow extends Project { calls: number; usd: number; pastDeadline: boolean }
export interface ProjectDay {
  /** Auto approvals today per project, then per tool (top 10), refusals per code, projects whose budget ran out today, grants made today. Raw titles: the digest escapes them. */
  projects: { id: number; title: string; n: number }[];
  tools: { tool: string; n: number }[];
  refused: { code: string; n: number }[];
  exhausted: { id: number; title: string }[];
  grants: { projectId: number; dept: string; tool: string }[];
  /** AUTO-2: company autopilot facts of today (codes, counts and root8 ids only). */
  company?: { total: number; tools: { tool: string; n: number }[]; capHit: 'day' | 'tree' | 'person' | null; treeGrants: { root8: string; dept: string; tool: string }[] };
}

interface TreeRow { id: string; parentId: string | null; rootId: string; status: string; conversation: boolean; depth: number; origin: string }
const newToken = (): string => randomBytes(16).toString('hex');
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const dayStart = (n: number): string => `(date_trunc('day', now() AT TIME ZONE $${n}) AT TIME ZONE $${n})`;
const id8 = (id: string): string => id.slice(0, 8);
const DB_COUNT_UP = `INSERT INTO autopilot_company_counts (scope, scope_key, used) VALUES ($1,$2,1)
  ON CONFLICT (scope, scope_key) DO UPDATE SET used = autopilot_company_counts.used + 1, updated_at = now() WHERE autopilot_company_counts.used < $3 RETURNING used`;
class CompanyCap extends Error { constructor(readonly which: 'day' | 'person') { super('company cap'); } }
class NotCompany extends Error { constructor() { super('not company'); } }
/** AC-C16: the person a root belongs to (its human `sourceUserId`, else a human requester), as a short numeric id; null when the root has no person (no person counter then). */
const personKey = (sourceUserId: string | null, requester: { kind?: string; userId?: string } | null): string | null => {
  const u = sourceUserId ?? (requester?.kind === 'human' ? (requester.userId ?? null) : null);
  return u !== null && /^[0-9]{1,32}$/.test(u) ? u : null;
};

export class ProjectRepo {
  constructor(private readonly pool: Pool, private readonly d: ProjectDeps) {}

  // ---- gates -----------------------------------------------------------------------------------------------------------------------------------------------------------

  /** Switch on (a read error counts as off). */
  private on(): boolean {
    try { return this.d.cfg.get('autopilot.enabled') === true; } catch { return false; }
  }

  /** Halted, or a halt state that cannot be read, both read as halted. */
  private halted(): boolean {
    try { return this.d.halt.isHalted(); } catch { return true; }
  }

  /** AUTO-2: the scope is 'company' (a read error counts as 'project'). */
  private companyScope(): boolean {
    try { return this.d.cfg.get('autopilot.scope') === 'company'; } catch { return false; }
  }

  /** Today's date in `schedule.timezone` (AP-C9). */
  private today(): string {
    return localDay((this.d.now ?? Date.now)(), this.d.cfg.get('schedule.timezone')).date;
  }

  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }

  private async audit(c: PoolClient, e: { actor: string; action: string; taskId?: string | null; tool?: string | null; outcome: string }): Promise<void> {
    await c.query('INSERT INTO audit_log (actor, action, task_id, tool, outcome) VALUES ($1,$2,$3,$4,$5)', [e.actor, e.action, e.taskId ?? null, e.tool ?? null, e.outcome]); // throws: no claim without its row
  }

  // ---- reads -----------------------------------------------------------------------------------------------------------------------------------------------------------

  async get(id: number): Promise<Project | null> {
    if (!Number.isSafeInteger(id) || id < 1) return null;
    return (await this.pool.query<Project>(`SELECT ${COLS} FROM projects WHERE id = $1`, [id])).rows[0] ?? null;
  }

  async getByToken(token: string): Promise<Project | null> {
    if (!/^[0-9a-f]{32}$/.test(token)) return null;
    return (await this.pool.query<Project>(`SELECT ${COLS} FROM projects WHERE token = $1`, [token])).rows[0] ?? null;
  }

  async getByBudgetToken(token: string): Promise<Project | null> {
    if (!/^[0-9a-f]{32}$/.test(token)) return null;
    return (await this.pool.query<Project>(`SELECT ${COLS} FROM projects WHERE budget_token = $1`, [token])).rows[0] ?? null;
  }

  /** `/project list` (SA-1 3.6, AP-C9): newest first, at most 25 rows, with the tree's spend and calls from its budget row. */
  async list(limit = 25): Promise<ProjectRow[]> {
    return this.rows('', [], Math.min(25, Math.max(1, Math.trunc(limit))));
  }

  /** One row with its usage (the exhaustion notice). */
  async getRow(id: number): Promise<ProjectRow | null> {
    if (!Number.isSafeInteger(id) || id < 1) return null;
    return (await this.rows('WHERE p.id = $1', [id], 1))[0] ?? null;
  }

  /** The project whose root task is `rootId`, whatever its status (the budget notice needs the row of a tree that may already be paused, exhausted or past its deadline). */
  async byRoot(rootId: string): Promise<Project | null> {
    return (await this.pool.query<Project>(`SELECT ${COLS} FROM projects WHERE root_task_id = $1`, [rootId])).rows[0] ?? null;
  }

  private async rows(where: string, params: unknown[], limit: number): Promise<ProjectRow[]> {
    const k = taskBudgetKey('x');
    const i = params.length;
    return (await this.pool.query<ProjectRow>(
      `SELECT ${cols('p.')},
         COALESCE(b.calls, 0) AS calls, COALESCE(b.spent_usd + b.reserved_usd, 0) AS usd, (p.deadline < $${i + 2}::date) AS "pastDeadline"
       FROM projects p LEFT JOIN budget_days b ON b.day = $${i + 3} AND b.scope = 'task' AND b.scope_id = p.root_task_id
       ${where} ORDER BY p.id DESC LIMIT $${i + 1}`,
      [...params, limit, this.today(), k.day],
    )).rows;
  }

  // ---- proposal --------------------------------------------------------------------------------------------------------------------------------------------------------

  /**
   * A proposal row (status proposed), under lock 7311042: at most 3 unexpired proposals wait (`open_cap`) and the same title (any case) may not wait twice (`duplicate`).
   * The caller has already screened the text and checked the deadline range. `max_approvals` and `base_approvals` come from `autopilot.maxApprovalsPerProject`.
   */
  async create(p: ProjectCreate): Promise<CreateResult> {
    if (this.halted()) return { ok: false, code: 'halted' };
    if (!this.on()) return { ok: false, code: 'off' };
    const approvals = Math.trunc(Number(this.d.cfg.get('autopilot.maxApprovalsPerProject')));
    const adopt = await this.resolveAdopt(p.adopt ?? []);
    let out: CreateResult;
    try {
      out = await this.createTx(p, approvals, adopt);
    } catch (err) {
      const e = err as { code?: string; constraint?: string };
      if (p.ideaId === undefined || e.code !== '23505' || e.constraint !== 'plugin_forges_one_live_per_idea') throw err;
      out = { ok: false, code: 'idea_busy' }; // the whole transaction rolled back: no project row either
    }
    // R7: a refusal of the idea link is audited after the (rolled back or empty) transaction; the success row is a throwing insert inside it
    if (!out.ok && (out.code === 'idea_invalid' || out.code === 'idea_busy' || out.code === 'forge_cap')) {
      await this.pool.query('INSERT INTO audit_log (actor, action, outcome) VALUES ($1,$2,$3)', [p.proposer, 'forge.link', `refused:${out.code}`]).catch(() => undefined);
    }
    return out;
  }

  private async createTx(p: ProjectCreate, approvals: number, adopt: AdoptResolution): Promise<CreateResult> {
    return this.tx(async (c): Promise<CreateResult> => {
      await c.query('SELECT pg_advisory_xact_lock($1)', [PROJECT_LOCK]);
      const open = (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM projects WHERE status = 'proposed' AND expires_at > now()")).rows[0]!.n;
      if (open >= PROJECT_OPEN_MAX) return { ok: false as const, code: 'open_cap' as const };
      const dup = await c.query("SELECT 1 FROM projects WHERE status = 'proposed' AND expires_at > now() AND lower(title) = lower($1)", [p.title]);
      if (dup.rowCount) return { ok: false as const, code: 'duplicate' as const };
      // R7 (spec 5.2): the idea is locked and must be open and untainted (GW-C24: bot text from a run that read outside content never feeds a build); live or staged forges are capped at 3
      let idea: { name: string; dept_id: string } | null = null;
      if (p.ideaId !== undefined) {
        idea = (await c.query<{ name: string; dept_id: string }>("SELECT name, dept_id FROM tool_ideas WHERE id = $1 AND status = 'open' AND tainted = false FOR UPDATE", [p.ideaId])).rows[0] ?? null;
        if (!idea) return { ok: false as const, code: 'idea_invalid' as const };
        if ((await c.query("SELECT 1 FROM plugin_forges WHERE idea_id = $1 AND status IN ('live','staged')", [p.ideaId])).rowCount) return { ok: false as const, code: 'idea_busy' as const };
        if ((await c.query<{ n: number }>("SELECT count(*)::int AS n FROM plugin_forges WHERE status IN ('live','staged')")).rows[0]!.n >= FORGES_OPEN_MAX) return { ok: false as const, code: 'forge_cap' as const };
      }
      const ins = await c.query<Project>(
        `INSERT INTO projects (token, title, goal, deadline, max_local_calls, max_usd, max_approvals, base_local_calls, base_usd, base_approvals, adopt_ids, proposer, tainted, expires_at)
         VALUES ($1,$2,$3,$4::date,$5,$6,$7,$5,$6,$7,$8,$9,$10, now() + interval '7 days') RETURNING ${COLS}`,
        [newToken(), p.title, p.goal, p.deadline, p.maxLocalCalls, p.maxUsd, approvals, adopt.ids, p.proposer, p.tainted],
      );
      const row = ins.rows[0]!;
      await this.audit(c, { actor: p.proposer, action: 'project.propose', outcome: `#${row.id} proposed` });
      if (idea && p.ideaId !== undefined) {
        const f = await c.query<{ id: number }>('INSERT INTO plugin_forges (idea_id, project_id, dept_id, proposer) VALUES ($1,$2,$3,$4) RETURNING id', [p.ideaId, row.id, idea.dept_id, p.proposer]);
        await this.audit(c, { actor: p.proposer, action: 'forge.link', outcome: `#${f.rows[0]!.id} idea #${p.ideaId} project #${row.id}` });
        return { ok: true as const, project: row, adopt, forge: { id: f.rows[0]!.id, ideaId: p.ideaId, ideaName: idea.name, deptId: idea.dept_id } };
      }
      return { ok: true as const, project: row, adopt };
    });
  }

  /** The card was posted: keep its channel and message (the click must match them). Best effort for the caller. */
  async setCard(id: number, channelId: string, messageId: string): Promise<boolean> {
    const r = await this.pool.query("UPDATE projects SET channel_id = $2, message_id = $3 WHERE id = $1 AND status = 'proposed'", [id, channelId, messageId]);
    return (r.rowCount ?? 0) === 1;
  }

  async setBudgetCard(id: number, channelId: string, messageId: string): Promise<boolean> {
    const r = await this.pool.query('UPDATE projects SET budget_channel_id = $2, budget_message_id = $3 WHERE id = $1 AND budget_token IS NOT NULL', [id, channelId, messageId]);
    return (r.rowCount ?? 0) === 1;
  }

  /** Reject: CAS from proposed to cancelled. Null = it was not pending. */
  async reject(id: number, by: string): Promise<Project | null> {
    return this.tx(async (c) => {
      const r = (await c.query<Project>(`UPDATE projects SET status = 'cancelled', closed_by = $2, closed_at = now() WHERE id = $1 AND status = 'proposed' RETURNING ${COLS}`, [id, by])).rows[0] ?? null;
      if (r) await this.audit(c, { actor: /^\d{17,20}$/.test(by) ? `user:${by}` : 'system:autopilot', action: 'project.decide', outcome: `#${id} rejected` });
      return r;
    });
  }

  /** An expired proposal becomes cancelled (closed_by system). Null = nothing to expire. */
  async expire(id: number): Promise<Project | null> {
    return (await this.pool.query<Project>(`UPDATE projects SET status = 'cancelled', closed_by = 'system', closed_at = now() WHERE id = $1 AND status = 'proposed' AND expires_at <= now() RETURNING ${COLS}`, [id])).rows[0] ?? null;
  }

  // ---- decide (approve) with adoption ------------------------------------------------------------------------------------------------------------------------------------

  /**
   * Approve (SA-1 3.2). One transaction on the tx client: the proposal row is locked and re-checked (the CAS: a double click gives exactly one `ok`, the other `not_pending`),
   * the root task is inserted as `todo`, the project becomes active with its root in ONE update (the CHECK and the foreign key forbid an active row without a root), then each
   * adopt id is checked in id order after the row locks and re-parented, or skipped with a code. The audit row is a throwing insert in the same transaction.
   */
  async decide(a: { token: string; by: string }): Promise<DecideResult> {
    if (!/^[0-9a-f]{32}$/.test(a.token) || !/^[0-9]{17,20}$/.test(a.by)) return { ok: false, code: 'not_found' };
    if (this.halted()) return { ok: false, code: 'halted' };
    if (!this.on()) return { ok: false, code: 'off' };
    const approvals = Math.trunc(Number(this.d.cfg.get('autopilot.maxApprovalsPerProject')));
    const out = await this.tx(async (c): Promise<DecideResult & { rootId?: string }> => {
      const cur = (await c.query<{ id: number; status: ProjectStatus; live: boolean }>('SELECT id, status, expires_at > now() AS live FROM projects WHERE token = $1 FOR UPDATE', [a.token])).rows[0];
      if (!cur) return { ok: false, code: 'not_found' };
      if (cur.status !== 'proposed') return { ok: false, code: 'not_pending' };
      if (!cur.live) return { ok: false, code: 'expired' };
      const p0 = (await c.query<Project>(`SELECT ${COLS} FROM projects WHERE id = $1`, [cur.id])).rows[0]!;
      const rootId = randomUUID();
      const desc = `Project #${p0.id}, approved by a Bot Admin.\nGoal: ${p0.goal}\nDeadline: ${p0.deadline}. Budget: ${p0.maxLocalCalls} local model calls, ${p0.maxUsd} USD.\nPlan the work, delegate it with create_task, decide inside the goal, and close this task with a summary when the goal is met.`;
      await c.query(
        `INSERT INTO tasks (id, title, description, dept_id, owner, requester, parent_id, root_id, depth, status, origin, tainted)
         VALUES ($1,$2,$3,'hq',$4::jsonb,$5::jsonb,NULL,$1,0,'todo','delegated',$6)`,
        [rootId, `Project: ${p0.title}`.slice(0, 200), desc, JSON.stringify({ kind: 'head', dept: 'hq' }), JSON.stringify({ kind: 'human', userId: a.by }), p0.tainted],
      );
      const act = (await c.query<Project>(
        `UPDATE projects SET status = 'active', approved_by = $2, approved_at = now(), root_task_id = $3, max_approvals = $4, base_approvals = $4
         WHERE id = $1 AND status = 'proposed' AND expires_at > now() RETURNING ${COLS}`,
        [cur.id, a.by, rootId, approvals],
      )).rows[0];
      if (!act) throw new Error('project CAS lost under its own row lock'); // cannot happen; rolls the root back
      const adopted: string[] = [];
      const skipped: { id: string; code: AdoptCode }[] = [];
      const depthMax = Number(this.d.cfg.get('limits.depth'));
      const capMax = Math.min(PROJECT_ADOPT_MAX, Number(this.d.cfg.get('limits.childrenPerTask')));
      for (const cand of [...new Set(act.adoptIds)].sort()) {
        const code = await this.adoptOne(c, cand, rootId, adopted.length, depthMax, capMax);
        if (code === null) adopted.push(cand);
        else skipped.push({ id: cand, code });
      }
      await this.audit(c, { actor: `user:${a.by}`, action: 'project.decide', taskId: rootId, outcome: `#${act.id} approved root ${id8(rootId)} adopted ${adopted.length} skipped ${skipped.length}` });
      const root = (await c.query<Task>(`SELECT ${taskCols()} FROM tasks WHERE id = $1`, [rootId])).rows[0]!;
      return { ok: true, project: act, root, adopted, skipped };
    });
    return out;
  }

  /**
   * Proposal-time resolution of the adopt entries (SA-1 3.2, read only, no locks): each entry is an exact id or a unique prefix of 8 or more characters among the open ROOT tasks.
   * Eligible full ids are returned; every other entry is returned as `{id8, code}` for the card (an unknown or ambiguous prefix is `not_found`). The same predicate `adoptCode`
   * that `decide` runs under the row locks decides eligibility, so the two cannot drift. At most 20 entries are looked at; duplicates count once.
   */
  async resolveAdopt(entries: readonly string[]): Promise<AdoptResolution> {
    const ids: string[] = [];
    const skipped: { id8: string; code: AdoptCode }[] = [];
    const seen = new Set<string>();
    const depthMax = Number(this.d.cfg.get('limits.depth'));
    const capMax = Math.min(PROJECT_ADOPT_MAX, Number(this.d.cfg.get('limits.childrenPerTask')));
    for (const raw of entries.slice(0, PROJECT_ADOPT_MAX)) {
      const e = String(raw).trim().toLowerCase();
      const label = e.replace(/[^0-9a-f-]/g, '').slice(0, 8) || 'invalid';
      if (!/^[0-9a-f-]{8,36}$/.test(e)) { skipped.push({ id8: label, code: 'not_found' }); continue; }
      // an exact id may be any task (so it can say why it is refused); a prefix is matched among open roots only
      const m = (await this.pool.query<{ id: string }>(
        e.length === 36 ? 'SELECT id FROM tasks WHERE id = $1 LIMIT 2' : "SELECT id FROM tasks WHERE parent_id IS NULL AND root_id = id AND status NOT IN ('done','cancelled') AND id LIKE $1 || '%' ORDER BY id LIMIT 2",
        [e])).rows;
      if (m.length !== 1) { skipped.push({ id8: label, code: 'not_found' }); continue; }
      const id = m[0]!.id;
      if (seen.has(id)) continue;
      seen.add(id);
      const code = await this.adoptCode(this.pool, id, await this.treeRows(this.pool, id, false), ids.length, depthMax, capMax);
      if (code === null) ids.push(id);
      else skipped.push({ id8: id8(id), code });
    }
    return { ids, skipped };
  }

  /** The rows of the tree under `cand` (at most 20 levels), root first then by id. `lock` takes them FOR UPDATE in that order (decide's transaction). */
  private async treeRows(q: Pick<PoolClient, 'query'>, cand: string, lock: boolean): Promise<TreeRow[]> {
    return (await q.query<TreeRow>(
      `WITH RECURSIVE sub(id, lvl) AS (
         SELECT id, 0 FROM tasks WHERE id = $1
         UNION ALL
         SELECT t.id, s.lvl + 1 FROM tasks t JOIN sub s ON t.parent_id = s.id WHERE s.lvl < 20
       )
       SELECT t.id, t.parent_id AS "parentId", t.root_id AS "rootId", t.status, t.conversation, t.depth, t.origin FROM tasks t JOIN sub ON sub.id = t.id
       ORDER BY (t.id = $1) DESC, t.id${lock ? ' FOR UPDATE OF t' : ''}`,
      [cand],
    )).rows;
  }

  /**
   * THE eligibility predicate (SA-1 3.2a, AP-C4): a skip code, or null when `cand` can be adopted. `rows` is the candidate's tree (locked in decide, unlocked at proposal time).
   * The tree is locked root first, then by id (the order a child insert and adminCancel take), so an insert and an adoption can never deadlock.
   */
  private async adoptCode(q: Pick<PoolClient, 'query'>, cand: string, rows: TreeRow[], adoptedSoFar: number, depthMax: number, capMax: number): Promise<AdoptCode | null> {
    const top = rows.find((r) => r.id === cand);
    if (!top) return 'not_found';
    if (top.parentId !== null || top.rootId !== top.id) return 'not_root';
    if ((await q.query('SELECT 1 FROM projects WHERE root_task_id = $1', [cand])).rowCount) return 'project_root'; // AP-C4: a project root is a root too, whatever its status
    if (top.status === 'done' || top.status === 'cancelled') return 'ended';
    if (ADOPT_OUTSIDE_ORIGINS.includes(top.origin)) return 'outside_origin'; // AP-C4: recurring outside feeds are never adopted
    if (rows.some((r) => r.conversation)) return 'conversation';
    if (rows.some((r) => r.status === 'doing')) return 'running'; // scheduler maps are keyed by root in memory
    if ((await q.query("SELECT 1 FROM approvals a JOIN tasks t ON t.id = a.task_id WHERE t.root_id = $1 AND a.status = 'pending' LIMIT 1", [cand])).rowCount) return 'pending_approval';
    const grant = await q.query(
      `SELECT 1 FROM task_grants WHERE root_id = $1 AND revoked_at IS NULL AND expires_at > now()
       UNION ALL SELECT 1 FROM web_grants WHERE root_id = $1 AND revoked_at IS NULL AND expires_at > now()
       UNION ALL SELECT 1 FROM ot_requests WHERE root_id = $1 AND (status = 'pending' OR (status = 'approved' AND revoked_at IS NULL))
       LIMIT 1`,
      [cand],
    );
    if (grant.rowCount) return 'has_grant';
    if (Math.max(...rows.map((r) => r.depth)) + 1 > depthMax) return 'too_deep';
    if (adoptedSoFar >= capMax) return 'children_cap';
    return null;
  }

  /** One adopt candidate, inside decide's transaction, after the row locks. Returns a skip code, or null after the tree was moved under `newRoot`. */
  private async adoptOne(c: PoolClient, cand: string, newRoot: string, adoptedSoFar: number, depthMax: number, capMax: number): Promise<AdoptCode | null> {
    if (!/^[0-9a-f-]{8,36}$/.test(cand)) return 'not_found';
    if (!(await c.query('SELECT id FROM tasks WHERE id = $1', [cand])).rows[0]) return 'not_found';
    const rows = await this.treeRows(c, cand, true);
    const code = await this.adoptCode(c, cand, rows, adoptedSoFar, depthMax, capMax);
    if (code !== null) return code;
    await c.query(
      `WITH RECURSIVE sub(id) AS (
         SELECT id FROM tasks WHERE id = $1
         UNION ALL
         SELECT t.id FROM tasks t JOIN sub s ON t.parent_id = s.id
       )
       UPDATE tasks t SET root_id = $2, depth = t.depth + 1, parent_id = CASE WHEN t.id = $1 THEN $2 ELSE t.parent_id END
       FROM sub WHERE t.id = sub.id`,
      [cand, newRoot],
    );
    return null;
  }

  // ---- "in a project" and the caps ---------------------------------------------------------------------------------------------------------------------------------------

  /**
   * SA-1 3.1 + AP-C9: the active, unpaused, not exhausted, in-time project the task's tree belongs to. A DB join, never an in-memory root. Null when the switch is off,
   * the company is halted, the deadline has passed or anything throws (today's rules apply).
   */
  async projectOf(taskId: string): Promise<{ id: number; rootTaskId: string; deadline: string } | null> {
    try {
      if (!this.on() || this.halted()) return null;
      const r = await this.pool.query<{ id: number; rootTaskId: string; deadline: string }>(
        `SELECT p.id, p.root_task_id AS "rootTaskId", to_char(p.deadline,'YYYY-MM-DD') AS deadline
         FROM projects p JOIN tasks t ON t.root_id = p.root_task_id
         WHERE t.id = $1 AND p.status = 'active' AND NOT p.paused AND p.exhausted_at IS NULL AND p.deadline >= $2::date`,
        [taskId, this.today()],
      );
      return r.rows[0] ?? null;
    } catch {
      return null;
    }
  }

  /**
   * SA-1 3.4: the budget's project cap for a root, read on the reserving transaction's client. Null unless `autopilot.enabled` is true; exhausted and past-deadline projects are
   * still capped. A paused project is not capped here (its tree falls back to the ordinary caps). A throw is the caller's: the reservation fails closed.
   */
  async capFor(rootId: string, client: Pick<PoolClient, 'query'>): Promise<{ maxUsd: number; maxCalls: number } | null> {
    if (!this.on()) return null;
    const r = await client.query<{ maxUsd: number; maxCalls: number }>(
      "SELECT max_usd::float8 AS \"maxUsd\", max_local_calls AS \"maxCalls\" FROM projects WHERE root_task_id = $1 AND status = 'active' AND NOT paused", [rootId]);
    return r.rows[0] ?? null;
  }

  // ---- claim -----------------------------------------------------------------------------------------------------------------------------------------------------------

  /**
   * SA-1 5.2: spend one auto approval of the project, claim-first. The root task row is locked, then the project row (the one lock order). `budget` when the approvals, the tree's USD
   * or its local calls are used up; `not_active` for anything else (paused, exhausted, past deadline, moved tree, halted, off). The audit row commits with the counter.
   */
  async claimApproval(projectId: number, taskId: string, tool: string): Promise<ClaimResult> {
    if (!this.on() || this.halted()) return { kind: 'not_active' };
    const today = this.today();
    return this.tx(async (c): Promise<ClaimResult> => {
      const root = (await c.query<{ root_id: string }>('SELECT root_id FROM tasks WHERE id = $1', [taskId])).rows[0]?.root_id;
      if (!root) return { kind: 'not_active' };
      await c.query('SELECT id FROM tasks WHERE id = $1 FOR UPDATE', [root]);
      const again = (await c.query<{ root_id: string }>('SELECT root_id FROM tasks WHERE id = $1', [taskId])).rows[0]?.root_id;
      if (again !== root) return { kind: 'not_active' };
      const p = (await c.query<{ status: string; paused: boolean; exhausted: boolean; rootTaskId: string | null; inTime: boolean; maxUsd: number; maxCalls: number; maxApprovals: number; used: number }>(
        `SELECT status, paused, exhausted_at IS NOT NULL AS exhausted, root_task_id AS "rootTaskId", deadline >= $2::date AS "inTime", max_usd::float8 AS "maxUsd",
                max_local_calls AS "maxCalls", max_approvals AS "maxApprovals", approvals_used AS used
         FROM projects WHERE id = $1 FOR UPDATE`, [projectId, today])).rows[0];
      if (!p || p.status !== 'active' || p.paused || p.exhausted || p.rootTaskId !== root || !p.inTime) return { kind: 'not_active' };
      const k = taskBudgetKey(root); // AP-C5: the key budget.reserve writes, never a literal
      const b = (await c.query<{ usd: number; calls: number }>('SELECT spent_usd + reserved_usd AS usd, calls FROM budget_days WHERE day = $1 AND scope = $2 AND scope_id = $3', [k.day, k.scope, k.scopeId])).rows[0];
      const usd = Number(b?.usd ?? 0);
      const calls = Number(b?.calls ?? 0);
      if (p.used >= p.maxApprovals || (p.maxUsd > 0 && usd >= p.maxUsd - 1e-9) || calls >= p.maxCalls) return { kind: 'budget' };
      if (!this.on() || this.halted()) return { kind: 'not_active' };
      await c.query('UPDATE projects SET approvals_used = approvals_used + 1 WHERE id = $1', [projectId]);
      await this.audit(c, { actor: 'system:autopilot', action: 'approval.autopilot.approve', taskId, tool, outcome: `ok p${projectId} ${p.used + 1}/${p.maxApprovals}` });
      return { kind: 'run', used: p.used + 1, max: p.maxApprovals };
    });
  }

  /** SA-1 3.5: the budget notice is owed once. A claim-first CAS; the row (with its fresh token) means this caller posts the card, null means it was already sent. */
  async exhaust(projectId: number): Promise<Project | null> {
    return (await this.pool.query<Project>(
      `UPDATE projects SET exhausted_at = now(), budget_token = $2 WHERE id = $1 AND status = 'active' AND exhausted_at IS NULL RETURNING ${COLS}`,
      [projectId, newToken()],
    )).rows[0] ?? null;
  }

  /**
   * Raise (SA-1 3.5): adds the base amounts, clears the exhausted mark and unblocks only the root's tasks that are blocked for the budget. `by` is the Bot Admin id; `token` is the budget card token when it came from the button. A CHECK overflow gives `raise_max` and changes nothing.
   */
  async raise(a: { id: number; by: string; token?: string }): Promise<RaiseResult> {
    if (this.halted()) return { ok: false, code: 'halted' };
    const rootId = (await this.pool.query<{ r: string | null }>('SELECT root_task_id AS r FROM projects WHERE id = $1', [a.id])).rows[0]?.r;
    try {
      return await this.tx(async (c): Promise<RaiseResult> => {
        if (rootId) await c.query('SELECT id FROM tasks WHERE id = $1 FOR UPDATE', [rootId]);
        const cur = (await c.query<{ status: string; exhausted: boolean; budgetToken: string | null; rootTaskId: string | null }>(
          'SELECT status, exhausted_at IS NOT NULL AS exhausted, budget_token AS "budgetToken", root_task_id AS "rootTaskId" FROM projects WHERE id = $1 FOR UPDATE', [a.id])).rows[0];
        if (!cur) return { ok: false, code: 'not_found' };
        if (cur.status !== 'active' || cur.rootTaskId !== rootId) return { ok: false, code: 'not_active' };
        if (!cur.exhausted) return { ok: false, code: 'not_exhausted' };
        if (a.token !== undefined && a.token !== cur.budgetToken) return { ok: false, code: 'wrong_card' };
        const up = (await c.query<Project>(
          `UPDATE projects SET max_usd = max_usd + base_usd, max_local_calls = max_local_calls + base_local_calls, max_approvals = max_approvals + base_approvals, exhausted_at = NULL
           WHERE id = $1 AND status = 'active' AND exhausted_at IS NOT NULL AND ($2::text IS NULL OR budget_token = $2) RETURNING ${COLS}`,
          [a.id, a.token ?? null])).rows[0];
        if (!up) return { ok: false, code: 'not_exhausted' };
        const unblocked = (await c.query<Task>(
          `UPDATE tasks SET status = 'todo', blocked_reason = NULL, blocked_note = NULL, updated_at = now() WHERE root_id = $1 AND status = 'blocked' AND blocked_reason = 'budget' RETURNING ${taskCols()}`,
          [rootId])).rows;
        await this.audit(c, { actor: `user:${a.by}`, action: 'project.raise', taskId: rootId, outcome: `#${a.id} ok unblocked ${unblocked.length}` });
        return { ok: true, project: up, unblocked };
      });
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === '23514') return { ok: false, code: 'raise_max' }; // the row CHECK refused the bigger numbers; the tx rolled back
      throw err;
    }
  }

  // ---- lifecycle -------------------------------------------------------------------------------------------------------------------------------------------------------

  /** pause / resume (SA-1 3.6): one conditional update plus its audit row, in one transaction. */
  async setPaused(a: { id: number; paused: boolean; by: string }): Promise<SimpleResult> {
    return this.tx(async (c): Promise<SimpleResult> => {
      const rootId = (await c.query<{ r: string | null }>('SELECT root_task_id AS r FROM projects WHERE id = $1', [a.id])).rows[0]?.r;
      if (rootId) await c.query('SELECT id FROM tasks WHERE id = $1 FOR UPDATE', [rootId]);
      const row = (await c.query<Project>(`UPDATE projects SET paused = $2 WHERE id = $1 AND status = 'active' AND paused <> $2 RETURNING ${COLS}`, [a.id, a.paused])).rows[0];
      if (!row) {
        const s = (await c.query<{ status: string }>('SELECT status FROM projects WHERE id = $1', [a.id])).rows[0];
        return { ok: false, code: !s ? 'not_found' : s.status !== 'active' ? 'not_active' : 'unchanged' };
      }
      await this.audit(c, { actor: `user:${a.by}`, action: a.paused ? 'project.pause' : 'project.resume', taskId: rootId ?? null, outcome: `#${a.id} ok` });
      return { ok: true, project: row };
    });
  }

  /**
   * close (SA-1 3.6): active to done. When the root is open and the tree holds only the root, the root is set to done in the same transaction (`rootClosed` carries it so the
   * caller can emit task.changed); otherwise the tree is left as it is, under today's rules.
   */
  async close(a: { id: number; by: string }): Promise<CloseResult> {
    if (!/^[0-9]{17,20}$/.test(a.by)) return { ok: false, code: 'not_active' };
    return this.tx(async (c): Promise<CloseResult> => {
      const rootId = (await c.query<{ r: string | null }>('SELECT root_task_id AS r FROM projects WHERE id = $1', [a.id])).rows[0]?.r ?? null;
      if (rootId) await c.query('SELECT id FROM tasks WHERE id = $1 FOR UPDATE', [rootId]);
      const row = (await c.query<Project>(`UPDATE projects SET status = 'done', closed_by = $2, closed_at = now() WHERE id = $1 AND status = 'active' RETURNING ${COLS}`, [a.id, a.by])).rows[0];
      if (!row) return { ok: false, code: (await c.query('SELECT 1 FROM projects WHERE id = $1', [a.id])).rowCount ? 'not_active' : 'not_found' };
      let rootClosed: { task: Task; from: Task['status'] } | null = null;
      if (rootId) {
        const open = (await c.query<{ id: string; status: Task['status'] }>(
          `WITH RECURSIVE sub(id, lvl) AS (SELECT id, 0 FROM tasks WHERE id = $1 UNION ALL SELECT t.id, s.lvl + 1 FROM tasks t JOIN sub s ON t.parent_id = s.id WHERE s.lvl < 20)
           SELECT t.id, t.status FROM tasks t JOIN sub ON sub.id = t.id WHERE t.status NOT IN ('done','cancelled') ORDER BY t.id LIMIT 2`, [rootId])).rows;
        if (open.length === 1 && open[0]!.id === rootId) {
          const done = (await c.query<Task>(`UPDATE tasks SET status = 'done', updated_at = now() WHERE id = $1 AND status = $2 RETURNING ${taskCols()}`, [rootId, open[0]!.status])).rows[0];
          if (done) rootClosed = { task: done, from: open[0]!.status };
        }
      }
      await this.audit(c, { actor: `user:${a.by}`, action: 'project.close', taskId: rootId, outcome: `#${a.id} ok${rootClosed ? ' root done' : ''}` });
      return { ok: true, project: row, rootClosed };
    });
  }

  /** Root-end sync (SA-1 3.6): the project's root task reached done or cancelled, so the project ends (closed_by system). Returns the project id, or null when none was active. */
  async rootEnded(rootTaskId: string, to: 'done' | 'cancelled'): Promise<number | null> {
    if (to !== 'done' && to !== 'cancelled') return null;
    return this.tx(async (c) => {
      await c.query('SELECT id FROM tasks WHERE id = $1 FOR UPDATE', [rootTaskId]);
      const r = (await c.query<{ id: number }>("UPDATE projects SET status = $2, closed_by = 'system', closed_at = now() WHERE root_task_id = $1 AND status = 'active' RETURNING id", [rootTaskId, to])).rows[0];
      if (!r) return null;
      await this.audit(c, { actor: 'system:autopilot', action: 'project.end', taskId: rootTaskId, outcome: `#${r.id} ${to}` });
      return r.id;
    });
  }

  // ---- deadline (AP-C9) ------------------------------------------------------------------------------------------------------------------------------------------------

  /** Active projects past their deadline whose one notice is still owed (oldest first, at most `limit`). */
  async deadlineOwed(limit = 10): Promise<Project[]> {
    return (await this.pool.query<Project>(
      `SELECT ${COLS} FROM projects WHERE status = 'active' AND deadline < $1::date AND deadline_noticed_at IS NULL ORDER BY id LIMIT $2`, [this.today(), Math.min(50, Math.max(1, Math.trunc(limit)))])).rows;
  }

  /** The deadline notice is owed once: claim-first CAS on `deadline_noticed_at`. The row means this caller posts the notice. */
  async claimDeadlineNotice(projectId: number): Promise<Project | null> {
    return (await this.pool.query<Project>(
      `UPDATE projects SET deadline_noticed_at = now() WHERE id = $1 AND status = 'active' AND deadline < $2::date AND deadline_noticed_at IS NULL RETURNING ${COLS}`, [projectId, this.today()])).rows[0] ?? null;
  }

  /** `/project extend`: a CAS on an active project, clearing the notice mark so a later pass is announced again. The caller has checked the date range (`dueOk`). */
  async extend(a: { id: number; deadline: string; by: string }): Promise<ExtendResult> {
    if (this.halted()) return { ok: false, code: 'halted' };
    if (!DATE.test(a.deadline) || Number.isNaN(Date.parse(`${a.deadline}T00:00:00Z`))) return { ok: false, code: 'bad_date' };
    return this.tx(async (c): Promise<ExtendResult> => {
      const row = (await c.query<Project>(`UPDATE projects SET deadline = $2::date, deadline_noticed_at = NULL WHERE id = $1 AND status = 'active' RETURNING ${COLS}`, [a.id, a.deadline])).rows[0];
      if (!row) return { ok: false, code: (await c.query('SELECT 1 FROM projects WHERE id = $1', [a.id])).rowCount ? 'not_active' : 'not_found' };
      await this.audit(c, { actor: `user:${a.by}`, action: 'project.extend', taskId: row.rootTaskId, outcome: `#${a.id} ok ${a.deadline}` });
      return { ok: true, project: row };
    });
  }

  // ---- project tools (C2, C10, AP-C7) --------------------------------------------------------------------------------------------------------------------------------------

  /**
   * The tools granted to `deptId` in an active, unpaused, not exhausted project (the one `projectOf` returned): used where the offer and the dispatch list are built.
   * Empty on any doubt; never throws.
   */
  async toolsFor(projectId: number, deptId: string): Promise<string[]> {
    try {
      const r = await this.pool.query<{ tool: string }>(
        `SELECT pt.tool FROM project_tools pt JOIN projects p ON p.id = pt.project_id
         WHERE pt.project_id = $1 AND pt.dept_id = $2 AND NOT starts_with(pt.tool, 'mcp_') AND p.status = 'active' AND NOT p.paused AND p.exhausted_at IS NULL ORDER BY pt.tool`, [projectId, deptId]);
      return r.rows.map((x) => x.tool);
    } catch {
      return [];
    }
  }

  /**
   * Replay (AP-C7): the grants of the project the task's tree belongs to, while that project is `active` (paused or exhausted projects still replay a card a human approved;
   * after done or cancelled the list is empty and the replay fails closed at the allowlist). Empty on any error.
   */
  async toolsForTask(taskId: string, deptId: string): Promise<string[]> {
    try {
      const r = await this.pool.query<{ tool: string }>(
        `SELECT pt.tool FROM project_tools pt JOIN projects p ON p.id = pt.project_id JOIN tasks t ON t.root_id = p.root_task_id
         WHERE t.id = $1 AND pt.dept_id = $2 AND NOT starts_with(pt.tool, 'mcp_') AND p.status = 'active' ORDER BY pt.tool`, [taskId, deptId]);
      return r.rows.map((x) => x.tool);
    } catch {
      return [];
    }
  }

  /** One grant, under lock 7311042 (SA-1 3.8): 10 per project, one row per (project, dept, tool). The caller has already checked who may ask (AP-C7). */
  async grantTool(a: { projectId: number; deptId: string; tool: string; taskId: string | null }): Promise<GrantResult> {
    if (a.tool.startsWith('mcp_')) return { ok: false, code: 'mcp' }; // R6 MC-C1: an external tool is granted only with /mcp depts, never through a project row
    return this.tx(async (c): Promise<GrantResult> => {
      await c.query('SELECT pg_advisory_xact_lock($1)', [PROJECT_LOCK]);
      const p = (await c.query<{ status: string }>('SELECT status FROM projects WHERE id = $1 FOR SHARE', [a.projectId])).rows[0];
      if (!p || p.status !== 'active') return { ok: false, code: 'not_active' };
      if ((await c.query('SELECT 1 FROM project_tools WHERE project_id = $1 AND dept_id = $2 AND tool = $3', [a.projectId, a.deptId, a.tool])).rowCount) return { ok: false, code: 'exists' };
      const n = (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM project_tools WHERE project_id = $1', [a.projectId])).rows[0]!.n;
      if (n >= PROJECT_TOOLS_MAX) return { ok: false, code: 'cap' };
      const ins = await c.query('INSERT INTO project_tools (project_id, dept_id, tool, task_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [a.projectId, a.deptId, a.tool, a.taskId]);
      return (ins.rowCount ?? 0) === 1 ? { ok: true } : { ok: false, code: 'exists' };
    });
  }

  // ---- company autopilot (AUTO-2, Gate 1 AC-C1, AC-C2, AC-C9, AC-C16) -------------------------------------------------------------------------------------------------------

  /**
   * AUTO-2 5.3 + AC-C1/AC-C2: the root of a company tree. The root is open, its origin is not an outside feed (the imported OUTSIDE_ORIGINS), and NO projects row of any status
   * points at it (a closed project with open children is not a company tree). Null on any error; never throws.
   */
  async companyRoot(taskId: string): Promise<string | null> {
    try {
      const r = await this.pool.query<{ rootId: string }>(
        `SELECT t.root_id AS "rootId" FROM tasks t JOIN tasks r ON r.id = t.root_id
         WHERE t.id = $1 AND r.status NOT IN ('done','cancelled') AND r.origin <> ALL($2::text[])
           AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.root_task_id = t.root_id)`,
        [taskId, [...OUTSIDE_ORIGINS]]);
      return r.rows[0]?.rootId ?? null;
    } catch {
      return null;
    }
  }

  /** The conditions of a company tree on the tx client, after the root lock (the same test as companyRoot, for one root). */
  private async companyRootTx(c: PoolClient, root: string): Promise<boolean> {
    const r = await c.query(
      `SELECT 1 FROM tasks r WHERE r.id = $1 AND r.status NOT IN ('done','cancelled') AND r.origin <> ALL($2::text[])
         AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.root_task_id = r.id)`, [root, [...OUTSIDE_ORIGINS]]);
    return r.rowCount === 1;
  }

  private companyUp(): boolean {
    return this.on() && !this.halted() && this.companyScope();
  }

  /**
   * AUTO-2 5.3: spend one company approval, claim-first, in one tx. Lock order: root row, tree counter, person counter, day counter (AC-C16 adds the person row between the two
   * counters; every caller takes them in this order). A refused cap rolls every counter back. The audit row is a throwing insert in the same tx. Rethrows other errors (decide: card).
   */
  async claimCompany(taskId: string, tool: string): Promise<CompanyClaim> {
    if (!this.companyUp()) return { kind: 'not_company' };
    const today = this.today();
    const maxDay = this.d.cfg.get('autopilot.company.maxApprovalsPerDay');
    const maxTree = this.d.cfg.get('autopilot.company.maxApprovalsPerTree');
    const maxPerson = this.d.cfg.get('autopilot.company.maxApprovalsPerPersonDay');
    try {
      return await this.tx(async (c): Promise<CompanyClaim> => {
        const root = (await c.query<{ root_id: string }>('SELECT root_id FROM tasks WHERE id = $1', [taskId])).rows[0]?.root_id;
        if (!root) return { kind: 'not_company' };
        const st = (await c.query<{ status: string; origin: string; sourceUserId: string | null; requester: { kind?: string; userId?: string } }>(
          'SELECT status, origin, source_user_id AS "sourceUserId", requester FROM tasks WHERE id = $1 FOR UPDATE', [root])).rows[0];
        if (!st || st.status === 'done' || st.status === 'cancelled') return { kind: 'not_company' };
        const again = (await c.query<{ root_id: string }>('SELECT root_id FROM tasks WHERE id = $1', [taskId])).rows[0]?.root_id;
        if (again !== root) return { kind: 'not_company' };
        if (!(await this.companyRootTx(c, root))) return { kind: 'not_company' }; // an active (or any) project, or an outside origin
        const tree = await c.query<{ used: number }>(DB_COUNT_UP, ['tree', root, maxTree]);
        if (tree.rowCount !== 1) return { kind: 'cap', which: 'tree' };
        const person = personKey(st.sourceUserId, st.requester);
        if (person !== null) {
          const pr = await c.query(DB_COUNT_UP, ['person', `${today}:${person}`, maxPerson]);
          if (pr.rowCount !== 1) throw new CompanyCap('person');
        }
        const day = await c.query<{ used: number }>(DB_COUNT_UP, ['day', today, maxDay]);
        if (day.rowCount !== 1) throw new CompanyCap('day');
        if (!this.companyUp()) throw new NotCompany();
        const d = day.rows[0]!.used;
        const t = tree.rows[0]!.used;
        await this.audit(c, { actor: 'system:autopilot', action: 'approval.autopilot.company', taskId, tool, outcome: `ok d${d}/${maxDay} t${t}/${maxTree}` });
        return { kind: 'run', day: d, tree: t };
      });
    } catch (err) {
      if (err instanceof CompanyCap) return { kind: 'cap', which: err.which };
      if (err instanceof NotCompany) return { kind: 'not_company' };
      throw err;
    }
  }

  /** AUTO-2 3.8: true exactly once per local day (daily_runs kind `autopilot_cap`); the winner also writes the throwing audit row in the same tx. */
  async claimCapNotice(which: 'day' | 'tree' | 'person'): Promise<boolean> {
    if (which !== 'day' && which !== 'tree' && which !== 'person') return false;
    const today = this.today();
    return this.tx(async (c) => {
      const r = await c.query("INSERT INTO daily_runs (day, kind) VALUES ($1,'autopilot_cap') ON CONFLICT DO NOTHING", [today]);
      if (r.rowCount !== 1) return false;
      await this.audit(c, { actor: 'system:autopilot', action: 'autopilot.company.cap', outcome: which });
      return true;
    });
  }

  /** AUTO-2 5.3: one task-tree tool grant (cap 5 per root). The root is locked, then the company conditions are re-read on the tx client. The caller has checked who may ask. */
  async grantTreeTool(a: { taskId: string; deptId: string; tool: string }): Promise<TreeGrantResult> {
    if (a.tool.startsWith('mcp_')) return { ok: false, code: 'mcp' }; // R6 MC-C1
    if (!/^[a-z_]{1,32}$/.test(a.deptId) || !/^[a-z0-9_]{1,64}$/.test(a.tool) || !this.companyUp()) return { ok: false, code: 'not_company' };
    return this.tx(async (c): Promise<TreeGrantResult> => {
      const root = (await c.query<{ root_id: string }>('SELECT root_id FROM tasks WHERE id = $1', [a.taskId])).rows[0]?.root_id;
      if (!root) return { ok: false, code: 'not_company' };
      await c.query('SELECT id FROM tasks WHERE id = $1 FOR UPDATE', [root]);
      const again = (await c.query<{ root_id: string }>('SELECT root_id FROM tasks WHERE id = $1', [a.taskId])).rows[0]?.root_id;
      if (again !== root || !(await this.companyRootTx(c, root))) return { ok: false, code: 'not_company' };
      if ((await c.query('SELECT 1 FROM tree_tools WHERE root_task_id = $1 AND dept_id = $2 AND tool = $3', [root, a.deptId, a.tool])).rowCount) return { ok: false, code: 'exists' };
      const n = (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM tree_tools WHERE root_task_id = $1', [root])).rows[0]!.n;
      if (n >= TREE_TOOLS_MAX) return { ok: false, code: 'cap' };
      const ins = await c.query('INSERT INTO tree_tools (root_task_id, dept_id, tool, task_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [root, a.deptId, a.tool, a.taskId]);
      if ((ins.rowCount ?? 0) !== 1) return { ok: false, code: 'exists' };
      await this.audit(c, { actor: 'system:autopilot', action: 'tool.tree_grant', taskId: a.taskId, tool: a.tool, outcome: `ok ${a.deptId} ${a.tool}` });
      return { ok: true, rootId: root };
    });
  }

  /**
   * AUTO-2: the tree grants of `deptId` for the task's tree, read at call time: only while the root is open, has no projects row (any status) and is not an outside origin
   * (AC-C9: rows are kept and filtered here). Empty on any error.
   */
  async treeToolsFor(taskId: string, deptId: string): Promise<string[]> {
    try {
      const r = await this.pool.query<{ tool: string }>(
        `SELECT tt.tool FROM tree_tools tt JOIN tasks t ON t.root_id = tt.root_task_id JOIN tasks r ON r.id = tt.root_task_id
         WHERE t.id = $1 AND tt.dept_id = $2 AND NOT starts_with(tt.tool, 'mcp_') AND r.status NOT IN ('done','cancelled') AND r.origin <> ALL($3::text[])
           AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.root_task_id = tt.root_task_id) ORDER BY tt.tool`,
        [taskId, deptId, [...OUTSIDE_ORIGINS]]);
      return r.rows.map((x) => x.tool);
    } catch {
      return [];
    }
  }

  // ---- digest (SA-1 3.10) ----------------------------------------------------------------------------------------------------------------------------------------------

  /** Today's autopilot facts (the calendar day in `tz`): codes, ids and counts, plus raw project titles that the digest escapes. */
  async day(tz: string): Promise<ProjectDay> {
    const appr = (await this.pool.query<{ id: number; title: string; tool: string | null }>(
      `SELECT p.id, p.title, l.tool FROM audit_log l JOIN tasks t ON t.id = l.task_id JOIN projects p ON p.root_task_id = t.root_id
       WHERE l.action = 'approval.autopilot.approve' AND l.ts >= ${dayStart(1)} ORDER BY l.ts, l.id`, [tz])).rows;
    const byProject = new Map<number, { id: number; title: string; n: number }>();
    const byTool = new Map<string, number>();
    for (const r of appr) {
      const e = byProject.get(r.id) ?? { id: r.id, title: r.title, n: 0 };
      e.n++;
      byProject.set(r.id, e);
      const t = r.tool ?? '?';
      byTool.set(t, (byTool.get(t) ?? 0) + 1);
    }
    const refusedRows = (await this.pool.query<{ outcome: string | null }>(
      `SELECT outcome FROM audit_log WHERE action = 'tool' AND outcome LIKE 'autopilot_refused:%' AND ts >= ${dayStart(1)}`, [tz])).rows;
    const codes = new Map<string, number>();
    for (const r of refusedRows) {
      const code = (r.outcome ?? '').slice('autopilot_refused:'.length).replace(/[^a-z_]/g, '').slice(0, 32) || '?';
      codes.set(code, (codes.get(code) ?? 0) + 1);
    }
    const top = <K>(m: Map<K, number>) => [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
    const exhausted = (await this.pool.query<{ id: number; title: string }>(
      `SELECT id, title FROM projects WHERE exhausted_at >= ${dayStart(1)} ORDER BY id`, [tz])).rows;
    const grants = (await this.pool.query<{ projectId: number; dept: string; tool: string }>(
      `SELECT project_id AS "projectId", dept_id AS dept, tool FROM project_tools WHERE granted_at >= ${dayStart(1)} ORDER BY granted_at, project_id, dept_id, tool LIMIT 50`, [tz])).rows;
    const coRows = (await this.pool.query<{ tool: string | null }>(
      `SELECT tool FROM audit_log WHERE action = 'approval.autopilot.company' AND ts >= ${dayStart(1)}`, [tz])).rows;
    const coTools = new Map<string, number>();
    for (const r of coRows) coTools.set(r.tool ?? '?', (coTools.get(r.tool ?? '?') ?? 0) + 1);
    const cap = (await this.pool.query<{ outcome: string | null }>(
      `SELECT outcome FROM audit_log WHERE action = 'autopilot.company.cap' AND ts >= ${dayStart(1)} ORDER BY ts, id LIMIT 1`, [tz])).rows[0]?.outcome;
    const treeGrants = (await this.pool.query<{ root: string; dept: string; tool: string }>(
      `SELECT root_task_id AS root, dept_id AS dept, tool FROM tree_tools WHERE granted_at >= ${dayStart(1)} ORDER BY granted_at, root_task_id, dept_id, tool LIMIT 25`, [tz])).rows;
    return {
      company: {
        total: coRows.length,
        tools: top(coTools).slice(0, 10).map(([tool, n]) => ({ tool, n })),
        capHit: cap === 'day' || cap === 'tree' || cap === 'person' ? cap : null,
        treeGrants: treeGrants.map((g) => ({ root8: id8(g.root), dept: g.dept, tool: g.tool })),
      },
      projects: [...byProject.values()].sort((a, b) => b.n - a.n || a.id - b.id),
      tools: top(byTool).slice(0, 10).map(([tool, n]) => ({ tool, n })),
      refused: top(codes).map(([code, n]) => ({ code, n })),
      exhausted,
      grants,
    };
  }
}
