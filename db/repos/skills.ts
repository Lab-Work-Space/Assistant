import type { PoolClient } from 'pg';
import type { SkillBody, SkillTemplate } from '../../skills/render.js';
import type { AttachmentRow, SkillRow, SkillSnapshot, SkillStatus, TargetKind } from '../../skills/types.js';
import type { Pool } from '../pool.js';

export type SkillProposalStatus = 'open' | 'card' | 'applied' | 'rejected' | 'stale' | 'withdrawn';
export interface SkillProposal {
  id: number; deptId: string; kind: 'create' | 'edit'; skillId: string; baseVersion: number;
  targetKind: TargetKind | null; targetId: string | null;
  payload: { title: string; instructions: string; templates: SkillTemplate[]; tools: string[]; reason: string };
  verdict: unknown; proposer: string; status: SkillProposalStatus; cardId: string | null; reviewedBy: string | null; outcome: string | null; createdAt: Date; decidedAt: Date | null;
  /** GROW-1: the sanitised AI judge note (<= 200), set only on an escalation. Never read by any prompt. */
  aiReview: string | null;
}
export interface SkillVersionRow { skillId: string; version: number; instructions: string; templates: SkillTemplate[]; tools: string[]; bodyBytes: number; bodySha256: string; source: string; restoredFrom: number | null; createdBy: string; createdAt: Date }
export interface PersonaFact { id: string; deptId: string; enabled: boolean }

const ACTIVE_SQL = `SELECT s.id, s.title, s.status, s.active_version AS "activeVersion", s.owner_dept AS "ownerDept", v.instructions, v.templates, v.tools,
  v.body_bytes AS "bodyBytes", v.body_sha256 AS "bodySha256"
  FROM skills s JOIN skill_versions v ON v.skill_id = s.id AND v.version = s.active_version`;
const ATT_SQL = `SELECT skill_id AS "skillId", target_kind AS "targetKind", target_id AS "targetId", priority FROM skill_attachments`;
export const PROP_COLS = `id, dept_id AS "deptId", kind, skill_id AS "skillId", base_version AS "baseVersion", target_kind AS "targetKind", target_id AS "targetId", payload, verdict,
  proposer, status, card_id AS "cardId", reviewed_by AS "reviewedBy", outcome, created_at AS "createdAt", decided_at AS "decidedAt", ai_review AS "aiReview"`;

/** One advisory lock serialises every skill write (a budget check reads other skills too). Plain transaction-scoped. */
const WRITE_LOCK = 7_311_031;

/**
 * GROW-1 (GW-C12): one SQL for the AI skill cap, shared by the peek (SkillAiRepo.counts, pool) and the claim (SkillTx.aiApplyClaim, tx client).
 * `$1` = timezone, `$2` = department. Counts the claim rows of the current local ISO week (Monday start).
 */
export const AI_WEEK_COUNT_SQL = `SELECT count(*) FILTER (WHERE tool = $2)::int AS dept, count(*)::int AS week FROM audit_log
  WHERE action = 'skill.ai.apply' AND outcome LIKE 'claim %' AND ts >= (date_trunc('week', now() AT TIME ZONE $1) AT TIME ZONE $1)`;
export const AI_ACTOR = 'system:ai-approver';

/** The statements of one skill transaction. Every mutating method states the state it expects (SK9) and reports a lost race as false. */
export class SkillTx {
  constructor(readonly c: PoolClient) {}

  async snapshot(): Promise<SkillSnapshot> {
    return { skills: (await this.c.query<SkillRow>(ACTIVE_SQL)).rows, attachments: (await this.c.query<AttachmentRow>(ATT_SQL)).rows };
  }
  /** Locks the skill row (and so its attachments' owner); null when absent. */
  async lockSkill(id: string): Promise<SkillRow | null> {
    await this.c.query('SELECT 1 FROM skills WHERE id = $1 FOR UPDATE', [id]);
    return (await this.c.query<SkillRow>(`${ACTIVE_SQL} WHERE s.id = $1`, [id])).rows[0] ?? null;
  }
  async attachmentsOf(skillId: string): Promise<AttachmentRow[]> {
    return (await this.c.query<AttachmentRow>(`${ATT_SQL} WHERE skill_id = $1`, [skillId])).rows;
  }
  /** Read inside the transaction, never from the Org cache (SK6 d/e). */
  async personas(): Promise<PersonaFact[]> {
    return (await this.c.query<PersonaFact>('SELECT id, dept_id AS "deptId", enabled FROM personas')).rows;
  }
  async deptEnabled(id: string): Promise<boolean | null> {
    return (await this.c.query<{ enabled: boolean }>('SELECT enabled FROM departments WHERE id = $1', [id])).rows[0]?.enabled ?? null;
  }
  async versionRow(skillId: string, version: number): Promise<SkillVersionRow | null> {
    return (await this.c.query<SkillVersionRow>(`SELECT skill_id AS "skillId", version, instructions, templates, tools, body_bytes AS "bodyBytes", body_sha256 AS "bodySha256", source, restored_from AS "restoredFrom", created_by AS "createdBy", created_at AS "createdAt" FROM skill_versions WHERE skill_id = $1 AND version = $2`, [skillId, version])).rows[0] ?? null;
  }
  async skillCount(): Promise<number> {
    return Number((await this.c.query<{ n: number }>('SELECT count(*)::int AS n FROM skills')).rows[0]!.n);
  }

  async insertSkill(s: { id: string; title: string; ownerDept: string | null; createdBy: string }): Promise<boolean> {
    // active_version 1 now; the deferred foreign key is checked at COMMIT, after insertVersion.
    const r = await this.c.query('INSERT INTO skills (id, title, active_version, owner_dept, created_by) VALUES ($1,$2,1,$3,$4) ON CONFLICT (id) DO NOTHING', [s.id, s.title, s.ownerDept, s.createdBy]);
    return r.rowCount === 1;
  }
  async insertVersion(v: { body: SkillBody; tools: string[]; bytes: number; sha256: string; source: 'admin' | 'proposal' | 'rollback' | 'seed'; proposalId?: number; restoredFrom?: number; by: string }): Promise<void> {
    await this.c.query(
      `INSERT INTO skill_versions (skill_id, version, instructions, templates, tools, body_bytes, body_sha256, source, proposal_id, restored_from, created_by)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11)`,
      [v.body.id, v.body.version, v.body.instructions, JSON.stringify(v.body.templates), v.tools, v.bytes, v.sha256, v.source, v.proposalId ?? null, v.restoredFrom ?? null, v.by],
    );
  }
  /** Moves the active version only while it is still `expected`. */
  async setActive(id: string, expected: number, next: number, title: string): Promise<boolean> {
    const r = await this.c.query('UPDATE skills SET active_version = $3, title = $4, updated_at = now() WHERE id = $1 AND active_version = $2', [id, expected, next, title]);
    return r.rowCount === 1;
  }
  async setStatus(id: string, expected: SkillStatus, expectedVersion: number, next: SkillStatus): Promise<boolean> {
    const r = await this.c.query('UPDATE skills SET status = $4, updated_at = now() WHERE id = $1 AND status = $2 AND active_version = $3', [id, expected, expectedVersion, next]);
    return r.rowCount === 1;
  }
  async insertAttachment(a: { skillId: string; kind: TargetKind; target: string; priority: number; by: string }): Promise<boolean> {
    const r = await this.c.query('INSERT INTO skill_attachments (skill_id, target_kind, target_id, priority, attached_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [a.skillId, a.kind, a.target, a.priority, a.by]);
    return r.rowCount === 1;
  }
  async deleteAttachment(skillId: string, kind: TargetKind, target: string): Promise<boolean> {
    return (await this.c.query('DELETE FROM skill_attachments WHERE skill_id = $1 AND target_kind = $2 AND target_id = $3', [skillId, kind, target])).rowCount === 1;
  }

  // proposals (inside a transaction)
  async lockProposal(id: number): Promise<SkillProposal | null> {
    return (await this.c.query<SkillProposal>(`SELECT ${PROP_COLS} FROM skill_proposals WHERE id = $1 FOR UPDATE`, [id])).rows[0] ?? null;
  }
  async closeProposal(id: number, status: 'applied' | 'stale' | 'rejected', by: string | null, outcome: string): Promise<void> {
    await this.c.query('UPDATE skill_proposals SET status = $2, reviewed_by = $3, outcome = $4, decided_at = now() WHERE id = $1', [id, status, by, outcome]);
  }
  /**
   * GROW-1 (GW-C12, C14): the AI cap claim. Runs on the transaction client, so it is under the skill WRITE_LOCK and rolls back with the apply.
   * Counts first, then writes the claim row; a null result means the claim is written. A max of 0 always refuses.
   */
  async aiApplyClaim(dept: string, proposalId: number, tz: string, maxDept: number, maxWeek: number): Promise<'cap_dept' | 'cap_week' | null> {
    const r = (await this.c.query<{ dept: number; week: number }>(AI_WEEK_COUNT_SQL, [tz, dept])).rows[0]!;
    if (r.dept >= maxDept) return 'cap_dept';
    if (r.week >= maxWeek) return 'cap_week';
    await this.c.query("INSERT INTO audit_log (actor, action, tool, outcome) VALUES ($1,'skill.ai.apply',$2,$3)", [AI_ACTOR, dept, `claim proposal:${proposalId}`]);
    return null;
  }
  async reopenProposal(id: number): Promise<void> {
    await this.c.query("UPDATE skill_proposals SET status = 'open', card_id = NULL WHERE id = $1 AND status = 'card'", [id]);
  }
}

export class SkillRepo {
  constructor(private readonly pool: Pool) {}

  /** Runs `fn` in one transaction under the global skill write lock. `commit: false` is a dry run: everything is rolled back. */
  async tx<T>(fn: (t: SkillTx) => Promise<T>, o: { commit?: boolean } = {}): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock($1)', [WRITE_LOCK]);
      const out = await fn(new SkillTx(c));
      await c.query(o.commit === false ? 'ROLLBACK' : 'COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  /** The org cache source: active versions of every skill and every attachment, read together. */
  async loadAll(): Promise<SkillSnapshot> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const out = await new SkillTx(c).snapshot();
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  async get(id: string): Promise<SkillRow | null> {
    return (await this.pool.query<SkillRow>(`${ACTIVE_SQL} WHERE s.id = $1`, [id])).rows[0] ?? null;
  }
  async list(): Promise<SkillRow[]> {
    return (await this.pool.query<SkillRow>(`${ACTIVE_SQL} ORDER BY s.id`)).rows;
  }
  async attachmentsOf(skillId: string): Promise<AttachmentRow[]> {
    return (await this.pool.query<AttachmentRow>(`${ATT_SQL} WHERE skill_id = $1 ORDER BY target_kind, target_id`, [skillId])).rows;
  }
  async attachments(): Promise<AttachmentRow[]> {
    return (await this.pool.query<AttachmentRow>(`${ATT_SQL} ORDER BY target_kind, target_id, priority, skill_id`)).rows;
  }
  async version(skillId: string, version: number): Promise<SkillVersionRow | null> {
    const c = await this.pool.connect();
    try { return await new SkillTx(c).versionRow(skillId, version); } finally { c.release(); }
  }
  async versionNumbers(skillId: string): Promise<number[]> {
    return (await this.pool.query<{ version: number }>('SELECT version FROM skill_versions WHERE skill_id = $1 ORDER BY version', [skillId])).rows.map((r) => r.version);
  }

  // ---- proposals ----

  async createProposal(p: { deptId: string; kind: 'create' | 'edit'; skillId: string; baseVersion: number; target?: { kind: TargetKind; id: string }; payload: SkillProposal['payload']; verdict: unknown; proposer: string }): Promise<{ ok: true; id: number } | { ok: false; reason: 'pending_exists' }> {
    try {
      const r = await this.pool.query<{ id: number }>(
        `INSERT INTO skill_proposals (dept_id, kind, skill_id, base_version, target_kind, target_id, payload, verdict, proposer) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9) RETURNING id`,
        [p.deptId, p.kind, p.skillId, p.baseVersion, p.target?.kind ?? null, p.target?.id ?? null, JSON.stringify(p.payload), JSON.stringify(p.verdict), p.proposer],
      );
      return { ok: true, id: r.rows[0]!.id };
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return { ok: false, reason: 'pending_exists' };
      throw e;
    }
  }
  async getProposal(id: number): Promise<SkillProposal | null> {
    return (await this.pool.query<SkillProposal>(`SELECT ${PROP_COLS} FROM skill_proposals WHERE id = $1`, [id])).rows[0] ?? null;
  }
  async listProposals(statuses: readonly SkillProposalStatus[] = ['open', 'card'], limit = 25): Promise<SkillProposal[]> {
    return (await this.pool.query<SkillProposal>(`SELECT ${PROP_COLS} FROM skill_proposals WHERE status = ANY($1) ORDER BY id DESC LIMIT $2`, [statuses, limit])).rows;
  }
  async countOpen(deptId: string): Promise<number> {
    return Number((await this.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM skill_proposals WHERE dept_id = $1 AND status IN ('open','card')", [deptId])).rows[0]!.n);
  }
  async pendingFor(skillId: string): Promise<boolean> {
    return (await this.pool.query("SELECT 1 FROM skill_proposals WHERE skill_id = $1 AND status IN ('open','card')", [skillId])).rowCount === 1;
  }
  /** open -> card, bound to the admin card; false when the proposal is not open (taken by another card, rejected, ...). */
  async attachCard(id: number, cardId: string, by: string): Promise<boolean> {
    return (await this.pool.query("UPDATE skill_proposals SET status = 'card', card_id = $2, reviewed_by = $3 WHERE id = $1 AND status = 'open'", [id, cardId, by])).rowCount === 1;
  }
  /** card -> open again, only when this very card is still the bound one (SK2: every ending of a card calls this). */
  async releaseCard(cardId: string): Promise<boolean> {
    return (await this.pool.query("UPDATE skill_proposals SET status = 'open', card_id = NULL WHERE card_id = $1 AND status = 'card'", [cardId])).rowCount === 1;
  }
  async reject(id: number, by: string): Promise<boolean> {
    return (await this.pool.query("UPDATE skill_proposals SET status = 'rejected', reviewed_by = $2, outcome = 'rejected', decided_at = now() WHERE id = $1 AND status IN ('open','card')", [id, by])).rowCount === 1;
  }
}
