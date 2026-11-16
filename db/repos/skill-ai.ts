import type { Pool } from '../pool.js';
import { AI_ACTOR, AI_WEEK_COUNT_SQL, PROP_COLS, type SkillProposal } from './skills.js';

/** Start of the current calendar day in the zone bound as parameter `n` (the expression AiApproverRepo uses). */
const dayStart = (n: number): string => `(date_trunc('day', now() AT TIME ZONE $${n}) AT TIME ZONE $${n})`;

export interface SkillAiDay {
  applied: { skillId: string; deptId: string; version: number }[];
  escalations: { code: string; n: number }[];
}

/**
 * GROW-1 (SA-1 3.2): everything the AI skill judge reads or counts. The `start` row is a THROWING insert; free text in an outcome is a code,
 * never model text. The cap CLAIM is not here: it is SkillTx.aiApplyClaim, inside the apply transaction.
 */
export class SkillAiRepo {
  constructor(private readonly pool: Pool) {}

  /** The offer marker (the caller treats a failure as best effort): lets boot recovery find an offered proposal that never reached `start`. */
  async offered(proposalId: number, dept: string, off = false): Promise<void> {
    await this.pool.query("INSERT INTO audit_log (actor, action, tool, outcome) VALUES ($1,'skill.ai.offer',$2,$3)", [AI_ACTOR, dept, `proposal:${proposalId}${off ? ' off' : ''}`]);
  }

  /** The judge-start row. Throws on error: no start row, no judge call. */
  async start(proposalId: number, dept: string): Promise<void> {
    await this.pool.query("INSERT INTO audit_log (actor, action, tool, outcome) VALUES ($1,'skill.ai.review',$2,$3)", [AI_ACTOR, dept, `proposal:${proposalId} start`]);
  }

  /** The cap peek (no lock): claims this local ISO week, for the department and in all. */
  async counts(dept: string, tz: string): Promise<{ dept: number; week: number }> {
    const r = (await this.pool.query<{ dept: number; week: number }>(AI_WEEK_COUNT_SQL, [tz, dept])).rows[0]!;
    return { dept: r.dept, week: r.week };
  }

  /** The note shown on `/skill review` and the #setting notice; only while the proposal still waits for a person. */
  async setAiReview(id: number, text: string): Promise<void> {
    await this.pool.query("UPDATE skill_proposals SET ai_review = $2 WHERE id = $1 AND status IN ('open','card')", [id, text.slice(0, 200)]);
  }

  /** GW-C10: the status of a skill and the source of its active version (admin, rollback, seed, proposal). Null: no such skill. */
  async activeSource(skillId: string): Promise<{ status: string; source: string } | null> {
    return (await this.pool.query<{ status: string; source: string }>(
      'SELECT s.status, v.source FROM skills s JOIN skill_versions v ON v.skill_id = s.id AND v.version = s.active_version WHERE s.id = $1', [skillId])).rows[0] ?? null;
  }

  /** GW-C10: a proposal for this skill id was rejected in the last 30 days. */
  async rejectedBefore(skillId: string): Promise<boolean> {
    return (await this.pool.query("SELECT 1 FROM skill_proposals WHERE skill_id = $1 AND status = 'rejected' AND decided_at > now() - interval '30 days' LIMIT 1", [skillId])).rowCount === 1;
  }

  /**
   * Boot recovery (SA-1 3.2, GW-C14): open proposals with no AI review text, made in the last 24 h, that either have a `start` row (the judge was cut short)
   * or were offered but never reached `start` (and the offer was not the "switch off" path). One that already has an escalate row is skipped: its notice is out.
   */
  async interrupted(bootTime?: Date): Promise<SkillProposal[]> {
    const r = await this.pool.query<SkillProposal>(
      `SELECT ${PROP_COLS} FROM skill_proposals p
       WHERE p.status = 'open' AND p.ai_review IS NULL AND p.created_at > now() - interval '24 hours'
         AND ($1::timestamptz IS NULL OR p.created_at < $1::timestamptz)
         AND NOT EXISTS (SELECT 1 FROM audit_log l WHERE l.action = 'skill.ai.escalate' AND l.outcome LIKE 'proposal:' || p.id || ' %')
         AND (EXISTS (SELECT 1 FROM audit_log l WHERE l.action = 'skill.ai.review' AND l.outcome = 'proposal:' || p.id || ' start')
           OR (EXISTS (SELECT 1 FROM audit_log l WHERE l.action = 'skill.ai.offer' AND l.outcome = 'proposal:' || p.id)
               AND NOT EXISTS (SELECT 1 FROM audit_log l WHERE l.action = 'skill.ai.offer' AND l.outcome = 'proposal:' || p.id || ' off')))
       ORDER BY p.id LIMIT 50`, [bootTime ?? null]);
    return r.rows;
  }

  /** The digest's read: today's AI-applied skills and the escalations per code. */
  async day(tz: string): Promise<SkillAiDay> {
    const applied = (await this.pool.query<{ skillId: string; deptId: string; outcome: string | null }>(
      `SELECT skill_id AS "skillId", dept_id AS "deptId", outcome FROM skill_proposals WHERE status = 'applied' AND reviewed_by = $2 AND decided_at >= ${dayStart(1)} ORDER BY decided_at LIMIT 20`, [tz, AI_ACTOR])).rows;
    const esc = (await this.pool.query<{ code: string | null; n: number }>(
      `SELECT substring(outcome from '^proposal:[0-9]+ ([a-z_:]+)') AS code, count(*)::int AS n FROM audit_log WHERE action = 'skill.ai.escalate' AND ts >= ${dayStart(1)} GROUP BY 1 ORDER BY n DESC, 1`, [tz])).rows;
    return {
      applied: applied.map((a) => ({ skillId: a.skillId, deptId: a.deptId, version: Number(/^version:(\d+)$/.exec(a.outcome ?? '')?.[1] ?? 0) })),
      escalations: esc.map((e) => ({ code: e.code ?? '?', n: e.n })),
    };
  }
}
