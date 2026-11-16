import type { Pool } from '../pool.js';
import { normalizeForDedup, screenText, sha256 } from '../../knowledge/screen.js';

export type NoteSource = 'task' | 'reflect' | 'manual';
/** `tainted`: written in a run that had read outside content (sticky; shown to the model as unverified). `taskId` is the source task. */
export interface DeptNote { id: number; deptId: string; taskId: string | null; body: string; pinned: boolean; tainted: boolean; source: NoteSource; createdAt: Date }
export interface ConfigRow { key: string; value: unknown; version: number; updatedBy: string | null; updatedAt: Date }
/** Append-only (K10): the newest row of a ref is the active one; a `tombstone` row means the file default. `active` is legacy and always true. */
export interface PromptOverride { id: number; ref: string; body: string; version: number; createdBy: string | null; createdAt: Date; active: boolean; tombstone: boolean; restoredFrom: number | null }
export interface ProviderKey { provider: string; ciphertext: Buffer; iv: Buffer; tag: Buffer }
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';
export interface Approval {
  id: number; taskId: string; reason: string; estCostUsd: number | null; requestedBy: string;
  status: ApprovalStatus; decidedBy: string | null; createdAt: Date; decidedAt: Date | null;
  /** Tool approvals only (R4): the validated call the approver sees; `toolInput` is the canonical JSON as stored. */
  toolName?: string | null; toolInput?: unknown; inputSha256?: string | null; executedAt?: Date | null;
  /** Set on the approval.requested event only (WS7 card routing): 'estimate' | 'tool' | 'tree_cap' | 'local_cap'. */
  kind?: string;
  /** The approval batch this tool approval is shown in (migration 026); null or absent for a solo card. */
  batchId?: number | null;
  /** AI-APPROVE-1: fixed text or a sanitised judge reason (<= 200), set only by AiApproverRepo.setAiReview; rendered only through escapeCardText; never enters a model prompt. */
  aiReview?: string | null;
}
export interface AuditEntry {
  actor: string; action: string; taskId?: string | null; provider?: string | null; model?: string | null;
  tokensIn?: number | null; tokensOut?: number | null; costUsd?: number | null; tool?: string | null; outcome?: string | null;
}
/** `calls` counts claude-code-local calls (scope `local`, and per root on `task` rows; Gate 1 L8). */
export interface BudgetDay { day: string; scope: string; scopeId: string; reservedUsd: number; spentUsd: number; calls?: number }

export const NOTE_CAP_PER_DEPT = 200;
const NOTE_COLS = 'id, dept_id AS "deptId", task_id AS "taskId", body, pinned, tainted, source, created_at AS "createdAt"';
const tokens = (s: string): Set<string> => new Set(normalizeForDedup(s).split(' ').filter((w) => w.length > 1));
/** Token overlap (Jaccard) of two note texts, for the near-duplicate check. */
export function overlap(a: string, b: string): number {
  const x = tokens(a);
  const y = tokens(b);
  if (!x.size || !y.size) return 0;
  let n = 0;
  for (const w of x) if (y.has(w)) n++;
  return n / (x.size + y.size - n);
}
export type NoteAdd = 'added' | 'duplicate' | 'refused';

export class DeptNoteRepo {
  constructor(private readonly pool: Pool, private readonly opts: { secrets?: readonly string[] } = {}) {}

  /**
   * K13: screened first (a secret-shaped text is refused, PII is masked, invisible characters are refused), then the duplicate check
   * (same normalised text, or token overlap >= 0.9 with a recent note of the department), then the insert and the roll-off of the oldest
   * unpinned notes beyond 200. `tainted` defaults to true: a writer that does not say counts as tainted (fail safe).
   */
  async add(deptId: string, taskId: string | null, body: string, o: { tainted?: boolean; source?: NoteSource; pinned?: boolean; max?: number } = {}): Promise<NoteAdd> {
    const s = screenText(body, { max: o.max ?? 500, ...(this.opts.secrets ? { secrets: this.opts.secrets } : {}) });
    if (!s.ok) return 'refused';
    const hash = sha256(normalizeForDedup(s.text));
    const recent = (await this.pool.query<{ body: string; norm_hash: string | null }>('SELECT body, norm_hash FROM dept_notes WHERE dept_id = $1 ORDER BY id DESC LIMIT 60', [deptId])).rows;
    if (recent.some((r) => r.norm_hash === hash || overlap(r.body, s.text) >= 0.9)) return 'duplicate';
    await this.pool.query(
      'INSERT INTO dept_notes (dept_id, task_id, body, pinned, tainted, source, norm_hash) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [deptId, taskId, s.text, o.pinned ?? false, o.tainted ?? true, o.source ?? 'task', hash]);
    await this.pool.query(
      `DELETE FROM dept_notes WHERE dept_id = $1 AND NOT pinned AND id IN (
         SELECT id FROM dept_notes WHERE dept_id = $1 AND NOT pinned ORDER BY created_at DESC, id DESC
         OFFSET GREATEST($2 - (SELECT count(*) FROM dept_notes WHERE dept_id = $1 AND pinned), 0))`, [deptId, NOTE_CAP_PER_DEPT]);
    return 'added';
  }
  async latest(deptId: string, limit: number): Promise<DeptNote[]> {
    return (await this.pool.query<DeptNote>(`SELECT ${NOTE_COLS} FROM dept_notes WHERE dept_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`, [deptId, limit])).rows;
  }
  /** What a run is shown: the pinned notes (newest 10) and the `recent` newest others, oldest first. Department scope only (K11). */
  async forContext(deptId: string, recent: number): Promise<DeptNote[]> {
    const rows = (await this.pool.query<DeptNote>(
      `(SELECT ${NOTE_COLS} FROM dept_notes WHERE dept_id = $1 AND pinned ORDER BY id DESC LIMIT 10)
       UNION ALL (SELECT ${NOTE_COLS} FROM dept_notes WHERE dept_id = $1 AND NOT pinned ORDER BY id DESC LIMIT $2)`, [deptId, recent])).rows;
    return rows.sort((a, b) => a.id - b.id);
  }
  /** Notes by id, only of the given departments (null = every department, Praw), and never another department's tainted note for Praw (K11). */
  async byIds(ids: number[], viewer: { dept: string; praw: boolean }): Promise<DeptNote[]> {
    if (!ids.length) return [];
    return (await this.pool.query<DeptNote>(
      `SELECT ${NOTE_COLS} FROM dept_notes WHERE id = ANY($1::bigint[]) AND (dept_id = $2 OR ($3::boolean AND NOT tainted))`, [ids, viewer.dept, viewer.praw])).rows;
  }
  async get(id: number): Promise<DeptNote | null> {
    return (await this.pool.query<DeptNote>(`SELECT ${NOTE_COLS} FROM dept_notes WHERE id = $1`, [id])).rows[0] ?? null;
  }
  /** Notes of one department written after `since` (the weekly review input). */
  async since(deptId: string, since: Date, limit: number): Promise<DeptNote[]> {
    return (await this.pool.query<DeptNote>(`SELECT ${NOTE_COLS} FROM dept_notes WHERE dept_id = $1 AND created_at > $2 ORDER BY id DESC LIMIT $3`, [deptId, since, limit])).rows;
  }
  async setPinned(id: number, pinned: boolean): Promise<boolean> {
    return (await this.pool.query('UPDATE dept_notes SET pinned = $2 WHERE id = $1', [id, pinned])).rowCount === 1;
  }
  /** K15: notes the reflect step wrote for a department since the start of the UTC day. */
  async reflectedToday(deptId: string): Promise<number> {
    return (await this.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM dept_notes WHERE dept_id = $1 AND source = 'reflect' AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`, [deptId])).rows[0]!.n;
  }
  /** Dashboard: every department's notes, newest first, capped. */
  async listAll(limit: number): Promise<DeptNote[]> {
    return (await this.pool.query<DeptNote>(`SELECT ${NOTE_COLS} FROM dept_notes ORDER BY id DESC LIMIT $1`, [limit])).rows;
  }
}

export class ConfigRepo {
  constructor(private readonly pool: Pool) {}
  async get(key: string): Promise<ConfigRow | null> {
    return (
      (
        await this.pool.query<ConfigRow>(
          'SELECT key, value, version, updated_by AS "updatedBy", updated_at AS "updatedAt" FROM config WHERE key = $1',
          [key],
        )
      ).rows[0] ?? null
    );
  }
  async list(): Promise<ConfigRow[]> {
    return (
      await this.pool.query<ConfigRow>(
        'SELECT key, value, version, updated_by AS "updatedBy", updated_at AS "updatedAt" FROM config ORDER BY key',
      )
    ).rows;
  }
  async upsert(key: string, value: unknown, updatedBy: string | null): Promise<void> {
    await this.pool.query(
      `INSERT INTO config (key, value, updated_by) VALUES ($1,$2::jsonb,$3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, version = config.version + 1,
         updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [key, JSON.stringify(value), updatedBy],
    );
  }
  async delete(key: string): Promise<void> {
    await this.pool.query('DELETE FROM config WHERE key = $1', [key]);
  }
}

const OVR_COLS = 'id, ref, body, version, created_by AS "createdBy", created_at AS "createdAt", active, tombstone, restored_from AS "restoredFrom"';

/** K10: append-only (a trigger rejects UPDATE and DELETE). The newest row of a ref is the active one; a tombstone row is "the file default". */
export class PromptOverrideRepo {
  constructor(private readonly pool: Pool) {}
  /** The newest row of the ref whatever it is (a tombstone included): the version the compare-and-swap is taken against. */
  async newest(ref: string): Promise<PromptOverride | null> {
    return (await this.pool.query<PromptOverride>(`SELECT ${OVR_COLS} FROM prompt_overrides WHERE ref = $1 ORDER BY version DESC LIMIT 1`, [ref])).rows[0] ?? null;
  }
  async getActive(ref: string): Promise<PromptOverride | null> {
    const n = await this.newest(ref);
    return n && !n.tombstone ? n : null;
  }
  async history(ref: string): Promise<PromptOverride[]> {
    return (await this.pool.query<PromptOverride>(`SELECT ${OVR_COLS} FROM prompt_overrides WHERE ref = $1 ORDER BY version DESC`, [ref])).rows;
  }
  async byId(id: number): Promise<PromptOverride | null> {
    return (await this.pool.query<PromptOverride>(`SELECT ${OVR_COLS} FROM prompt_overrides WHERE id = $1`, [id])).rows[0] ?? null;
  }
  /** Every ref that has a row, with its newest version (dashboard). */
  async refs(): Promise<{ ref: string; version: number; tombstone: boolean }[]> {
    return (await this.pool.query<{ ref: string; version: number; tombstone: boolean }>(
      'SELECT DISTINCT ON (ref) ref, version, tombstone FROM prompt_overrides ORDER BY ref, version DESC')).rows;
  }
  /**
   * Appends the next version only if the newest one is still `expectedVersion` (0 = none): the compare-and-swap that refuses a stale
   * card. A concurrent insert loses on the unique (ref, version) index and is also reported as stale.
   */
  async append(ref: string, body: string, createdBy: string | null, expectedVersion: number, o: { tombstone?: boolean; restoredFrom?: number } = {}): Promise<{ ok: true; row: PromptOverride } | { ok: false; reason: 'stale' }> {
    try {
      const r = await this.pool.query<PromptOverride>(
        `INSERT INTO prompt_overrides (ref, body, version, created_by, tombstone, restored_from)
         SELECT $1, $2, $3::int + 1, $4, $5, $6 WHERE COALESCE((SELECT max(version) FROM prompt_overrides WHERE ref = $1), 0) = $3::int
         RETURNING ${OVR_COLS}`, [ref, body, expectedVersion, createdBy, o.tombstone ?? false, o.restoredFrom ?? null]);
      return r.rows[0] ? { ok: true, row: r.rows[0] } : { ok: false, reason: 'stale' };
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return { ok: false, reason: 'stale' };
      throw e;
    }
  }
  /** Admin path (slash commands): the next version, whatever is newest. */
  async upsert(ref: string, body: string, createdBy: string | null): Promise<void> {
    for (let i = 0; i < 3; i++) {
      const v = (await this.newest(ref))?.version ?? 0;
      if ((await this.append(ref, body, createdBy, v)).ok) return;
    }
    throw new Error('prompt override changed concurrently');
  }
  /** Back to the file default: appends a tombstone (nothing is deleted). */
  async delete(ref: string): Promise<void> {
    const n = await this.newest(ref);
    if (n && !n.tombstone) await this.append(ref, '', null, n.version, { tombstone: true });
  }
}

export class ProviderKeyRepo {
  constructor(private readonly pool: Pool) {}
  async get(provider: string): Promise<ProviderKey | null> {
    return (await this.pool.query<ProviderKey>('SELECT provider, ciphertext, iv, tag FROM provider_keys WHERE provider = $1', [provider])).rows[0] ?? null;
  }
  async list(): Promise<string[]> {
    return (await this.pool.query<{ provider: string }>('SELECT provider FROM provider_keys ORDER BY provider')).rows.map((r) => r.provider);
  }
  async upsert(k: ProviderKey): Promise<void> {
    await this.pool.query(
      `INSERT INTO provider_keys (provider, ciphertext, iv, tag) VALUES ($1,$2,$3,$4)
       ON CONFLICT (provider) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv, tag = EXCLUDED.tag`,
      [k.provider, k.ciphertext, k.iv, k.tag],
    );
  }
  async delete(provider: string): Promise<void> {
    await this.pool.query('DELETE FROM provider_keys WHERE provider = $1', [provider]);
  }
}

export interface AuditRow { id: number; ts: Date; actor: string; action: string; tool: string | null; outcome: string | null }

export class AuditRepo {
  constructor(private readonly pool: Pool) {}
  async append(e: AuditEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_log (actor, action, task_id, provider, model, tokens_in, tokens_out, cost_usd, tool, outcome)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [e.actor, e.action, e.taskId ?? null, e.provider ?? null, e.model ?? null, e.tokensIn ?? null,
       e.tokensOut ?? null, e.costUsd ?? null, e.tool ?? null, e.outcome ?? null],
    );
  }

  /** HEAL-1 (H5, HL-C19): the outcome text of the newest row of `action`, or null when there is none. Uses audit_log_action_ts_idx. */
  async latestOutcome(action: string): Promise<string | null> {
    return (await this.pool.query<{ outcome: string | null }>('SELECT outcome FROM audit_log WHERE action = $1 ORDER BY ts DESC, id DESC LIMIT 1', [action])).rows[0]?.outcome ?? null;
  }

  /**
   * Gate 1 S48: the dashboard's audit page. Filters are bound parameters, the sort is picked from a fixed list, and the page size is capped.
   * Rows are already masked and capped by `createAudit`.
   */
  async query(q: { actor?: string; action?: string; sort?: 'ts' | 'actor' | 'action'; dir?: 'asc' | 'desc'; limit: number; offset: number }): Promise<AuditRow[]> {
    const col = q.sort === 'actor' ? 'actor' : q.sort === 'action' ? 'action' : 'ts';
    const dir = q.dir === 'asc' ? 'ASC' : 'DESC';
    return (await this.pool.query<AuditRow>(
      `SELECT id, ts, actor, action, tool, outcome FROM audit_log
       WHERE ($1::text IS NULL OR actor = $1) AND ($2::text IS NULL OR starts_with(action, $2))
       ORDER BY ${col} ${dir}, id ${dir} LIMIT $3 OFFSET $4`,
      [q.actor ?? null, q.action ?? null, Math.min(Math.max(q.limit, 1), 200), Math.max(q.offset, 0)],
    )).rows;
  }
}

const APPROVAL = `SELECT id, task_id AS "taskId", reason, est_cost_usd AS "estCostUsd", requested_by AS "requestedBy",
  status, decided_by AS "decidedBy", created_at AS "createdAt", decided_at AS "decidedAt",
  tool_name AS "toolName", tool_input AS "toolInput", input_sha256 AS "inputSha256", executed_at AS "executedAt" FROM approvals`;

/** Atomic decide/expire logic is Task 9's concern; this is plain CRUD. */
export class ApprovalRepo {
  constructor(private readonly pool: Pool) {}
  async create(a: { taskId: string; reason: string; estCostUsd: number | null; requestedBy: string }): Promise<Approval> {
    return (
      await this.pool.query<Approval>(
        `WITH i AS (INSERT INTO approvals (task_id, reason, est_cost_usd, requested_by) VALUES ($1,$2,$3,$4) RETURNING *)
         SELECT id, task_id AS "taskId", reason, est_cost_usd AS "estCostUsd", requested_by AS "requestedBy",
         status, decided_by AS "decidedBy", created_at AS "createdAt", decided_at AS "decidedAt",
         tool_name AS "toolName", tool_input AS "toolInput", input_sha256 AS "inputSha256", executed_at AS "executedAt" FROM i`,
        [a.taskId, a.reason, a.estCostUsd, a.requestedBy],
      )
    ).rows[0]!;
  }
  async get(id: number): Promise<Approval | null> {
    return (await this.pool.query<Approval>(`${APPROVAL} WHERE id = $1`, [id])).rows[0] ?? null;
  }
  async listByStatus(status: ApprovalStatus): Promise<Approval[]> {
    return (await this.pool.query<Approval>(`${APPROVAL} WHERE status = $1 ORDER BY id`, [status])).rows;
  }
}

export class BudgetDayRepo {
  constructor(private readonly pool: Pool) {}
  async get(day: string, scope: string, scopeId: string): Promise<BudgetDay | null> {
    return (
      (
        await this.pool.query<BudgetDay>(
          `SELECT to_char(day,'YYYY-MM-DD') AS day, scope, scope_id AS "scopeId", reserved_usd AS "reservedUsd",
           spent_usd AS "spentUsd" FROM budget_days WHERE day = $1 AND scope = $2 AND scope_id = $3`,
          [day, scope, scopeId],
        )
      ).rows[0] ?? null
    );
  }
}
