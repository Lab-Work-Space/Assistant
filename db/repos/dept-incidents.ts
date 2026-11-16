import { BUILD_CODES } from '../../forge/texts.js';
import type { Pool } from '../pool.js';

/** The closed build-code list, re-exported for the retro queries (S7, S8) so that no other module imports `forge/texts` (forge/boundary.test.ts pins its importers). */
export const FORGE_FAILED_CODES: readonly string[] = BUILD_CODES;

/** LEARN-1 (D2): one summary row for a department's prompt block (S6). Every value is a closed code, a registry tool name or a count (CHECKs of migration 044). */
export type IncidentKind = 'task_blocked' | 'task_cancelled' | 'tool_errors' | 'heal_resolve' | 'forge_failed';
export interface IncidentRow { kind: IncidentKind; code: string; tool: string | null; n: number }

/** Spec §5 S1 to S3: the sweep statements, verbatim. $1 is `schedule.timezone` in S3 only. No column ever receives a title, summary, note, reason or model text. */
const S1 = `INSERT INTO dept_incidents (dept_id, kind, code, task_id, ikey)
SELECT t.dept_id, CASE WHEN t.status = 'blocked' THEN 'task_blocked' ELSE 'task_cancelled' END,
       CASE WHEN t.status = 'blocked' THEN COALESCE(t.blocked_reason, 'owner') ELSE 'cancelled' END, t.id,
       'task:' || t.id || ':' || t.status || ':' || CASE WHEN t.status = 'blocked' THEN COALESCE(t.blocked_reason, 'owner') ELSE 'cancelled' END
FROM tasks t
WHERE t.status IN ('blocked','cancelled') AND t.updated_at >= now() - interval '2 days'
  AND t.id ~ '^[0-9a-f-]{36}$' AND t.dept_id <> 'praw'
  AND NOT (t.status = 'blocked' AND COALESCE(t.blocked_reason, 'owner') IN ('halt','approval'))
  AND t.id NOT IN (SELECT task_id FROM retro_runs WHERE task_id IS NOT NULL)
  AND NOT (t.dept_id = 'hq' AND t.parent_id IS NULL AND t.title LIKE 'Decide on blocked task %')
ORDER BY t.updated_at DESC LIMIT 200
ON CONFLICT (dept_id, ikey) DO NOTHING`;
const S2 = `INSERT INTO dept_incidents (dept_id, kind, code, task_id, ikey)
SELECT t.dept_id, 'heal_resolve', CASE WHEN a.outcome IN ('retry','cancel') THEN a.outcome ELSE 'refused' END, t.id, 'audit:' || a.id
FROM audit_log a JOIN tasks t ON t.id = a.task_id
WHERE a.action = 'task.heal.resolve' AND a.ts >= now() - interval '2 days'
  AND (a.outcome IN ('retry','cancel') OR a.outcome LIKE 'refused:%')
  AND t.dept_id <> 'praw' AND t.id ~ '^[0-9a-f-]{36}$'
ON CONFLICT (dept_id, ikey) DO NOTHING`;
const S3 = `INSERT INTO dept_incidents (dept_id, kind, code, tool, n, ikey)
SELECT x.dept, 'tool_errors', x.outcome, x.tool, x.n, 'tool:' || x.day || ':' || x.tool || ':' || x.outcome
FROM (
  SELECT COALESCE(p.dept_id, substring(a.actor from '^head:([a-z_]{1,32})$')) AS dept, a.tool, a.outcome,
         to_char((a.ts AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS day, count(*)::int AS n
  FROM audit_log a LEFT JOIN personas p ON a.actor = 'persona:' || p.id
  WHERE a.action = 'tool' AND a.ts >= now() - interval '2 days'
    AND a.outcome IN ('tool_error','error','invalid_input','refused','denied','approval_not_owner','approval_needs_task')
    AND a.tool ~ '^[a-z0-9_]{1,64}$'
  GROUP BY 1, 2, 3, 4 HAVING count(*) >= 3
) x JOIN departments d ON d.id = x.dept
WHERE x.dept <> 'praw'
ON CONFLICT (dept_id, ikey) DO UPDATE SET n = EXCLUDED.n WHERE dept_incidents.n < EXCLUDED.n`;
/** R7 spec 5.11 S9, verbatim: a failed plugin build, by closed code (`$1` is the closed list). The dept comes from the release; no column receives text. */
const S9 = `INSERT INTO dept_incidents (dept_id, kind, code, task_id, ikey)
SELECT r.dept_id, 'forge_failed', b.code, r.task_id, 'forge:' || b.id
FROM plugin_builds b JOIN releases r ON r.id = b.release_id
WHERE b.status = 'failed' AND b.finished_at >= now() - interval '2 days'
  AND b.code = ANY($1::text[]) AND r.task_id ~ '^[0-9a-f-]{36}$'
ON CONFLICT (dept_id, ikey) DO NOTHING`;
const S4 = "DELETE FROM dept_incidents WHERE created_at < now() - interval '30 days'";
const S5 = 'DELETE FROM dept_incidents WHERE id IN (SELECT id FROM (SELECT id, row_number() OVER (PARTITION BY dept_id ORDER BY created_at DESC, id DESC) AS rn FROM dept_incidents) z WHERE rn > 500)';
const S6 = `SELECT kind, code, tool, sum(n)::int AS n FROM dept_incidents WHERE dept_id = $1 AND created_at >= now() - interval '7 days' GROUP BY 1, 2, 3 ORDER BY n DESC, kind, code LIMIT 20`;
/** The statement names the sweep reports by (never SQL text, never row content). */
export type SweepStep = 'tasks' | 'heal' | 'tools' | 'retention' | 'cap' | 'forge';

/**
 * LEARN-1 (D2): the code-built mistake log. Rows hold closed codes, integers, UUIDs and registry tool names only (CHECKs plus the source filters above); there is no taint column
 * because nothing here is model text. The writers are the five sweep statements; the readers are the head prompt (S6), the retro facts (S7) and the threshold scan (S8), both in RetroRepo.
 */
export class DeptIncidentRepo {
  constructor(private readonly pool: Pool) {}

  /** One sweep statement (S1 to S5). A failure throws to the caller, which logs `errName` and goes on with the next statement. */
  async step(step: SweepStep, tz: string): Promise<void> {
    switch (step) {
      case 'tasks': await this.pool.query(S1); break;
      case 'heal': await this.pool.query(S2); break;
      case 'tools': await this.pool.query(S3, [tz]); break;
      case 'retention': await this.pool.query(S4); break;
      case 'cap': await this.pool.query(S5); break;
      case 'forge': await this.pool.query(S9, [BUILD_CODES]); break;
    }
  }

  /** S6: the department's last 7 days, at most 20 rows. */
  async summary(dept: string): Promise<IncidentRow[]> {
    return (await this.pool.query<IncidentRow>(S6, [dept])).rows;
  }
}
