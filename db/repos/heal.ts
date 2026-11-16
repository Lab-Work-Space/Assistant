import type { QueryResultRow } from 'pg';
import { redactText } from '../../core/logger.js';
import type { Pool } from '../pool.js';
import { taskCols, type Task } from './tasks.js';
import type { AuditEntry } from './ledger.js';

/** HEAL-1: a blocked row with the time it was blocked (the healer's windows read `updated_at`; `Task` carries no timestamps). */
export interface BlockedCandidate { task: Task; updatedAt: Date }
/** HEAL-1 (HL-C20): what the daily summary counts and lists. Titles are raw here; the summary escapes and cuts them. */
export interface HealDay {
  retries: number; unblocked: number; wakes: number; resolveRetry: number; resolveCancel: number;
  /** R1-02: reviews closed by code (`task.review.autoclose` audit rows) today. */
  autoclosed: number;
  cancels: { taskId: string; title: string; decider: string }[];
  tainted: { taskId: string; title: string }[];
}

const BLOCKED_NOTE_MAX = 300;
/** Start of the current calendar day in the zone bound as parameter `n`, as a timestamptz (the same expression the decider-day count uses). */
const dayStart = (n: number): string => `(date_trunc('day', now() AT TIME ZONE $${n}) AT TIME ZONE $${n})`;

/**
 * HEAL-1: everything the healer, `resolve_blocked` and the daily summary read or count. Every cap is counted from audit rows
 * (`task.autoretry`, `task.heal.wake`, `task.heal.resolve`); the rows that carry a cap are written by `claim`, which THROWS (Gate 1 HL-C10: the swallowing
 * audit helper would undercount a cap). Rows of a claim have the outcome `claim #n ...`.
 */
export class HealRepo {
  /** `secrets`: the shared literal secret list; the note is masked with it again when it is read (HL-C13). */
  constructor(private readonly pool: Pool, private readonly secrets: readonly string[] = []) {}

  /** The oldest blocked rows that the healer may act on (reason error, turns, owner or NULL). Never selects the note. */
  async blockedCandidates(limit: number): Promise<BlockedCandidate[]> {
    const r = await this.pool.query<Task & { updatedAt: Date }>(
      `SELECT ${taskCols()}, updated_at AS "updatedAt" FROM tasks
       WHERE status = 'blocked' AND (blocked_reason IN ('error','turns','owner') OR blocked_reason IS NULL)
       ORDER BY updated_at, id LIMIT $1`,
      [Math.max(1, Math.floor(limit))],
    );
    return r.rows.map(({ updatedAt, ...task }) => ({ task: task as Task, updatedAt }));
  }

  /** HL-C13: the second and last reader of `blocked_note` (the first is TaskRepo.listOpenAdmin). Masked again, folded to one line, cut to 300. Null when there is none. */
  async blockedNote(id: string): Promise<string | null> {
    const raw = (await this.pool.query<{ note: string | null }>('SELECT blocked_note AS note FROM tasks WHERE id = $1', [id])).rows[0]?.note;
    if (!raw) return null;
    const one = redactText(raw, this.secrets).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
    return (one.length > BLOCKED_NOTE_MAX ? one.slice(0, BLOCKED_NOTE_MAX) : one) || null;
  }

  /** HL-C10: an awaited insert that throws on error. Free text is code-made (ids, codes), never model text. */
  async claim(e: AuditEntry): Promise<void> {
    await this.pool.query(
      'INSERT INTO audit_log (actor, action, task_id, tool, outcome) VALUES ($1,$2,$3,$4,$5)',
      [e.actor, e.action, e.taskId ?? null, e.tool ?? null, e.outcome ?? null],
    );
  }

  private async n(sql: string, args: unknown[]): Promise<number> {
    return (await this.pool.query<{ n: number }>(sql, args)).rows[0]!.n;
  }

  /** Lifetime count of the task's automatic retries (claim rows). */
  autoretries(taskId: string): Promise<number> {
    return this.n("SELECT count(*)::int AS n FROM audit_log WHERE action = 'task.autoretry' AND task_id = $1", [taskId]);
  }

  /** Lifetime count of decider wakes of the task (claim rows). */
  wakes(taskId: string): Promise<number> {
    return this.n("SELECT count(*)::int AS n FROM audit_log WHERE action = 'task.heal.wake' AND task_id = $1 AND outcome LIKE 'claim %'", [taskId]);
  }

  /** The time of the newest wake claim of the task, or null. */
  async lastWakeAt(taskId: string): Promise<Date | null> {
    return (await this.pool.query<{ ts: Date }>("SELECT ts FROM audit_log WHERE action = 'task.heal.wake' AND task_id = $1 AND outcome LIKE 'claim %' ORDER BY ts DESC, id DESC LIMIT 1", [taskId])).rows[0]?.ts ?? null;
  }

  /** HL-C16: wakes claimed for this decider (`head:<dept>`) today, the calendar day in `tz`. */
  deciderToday(decider: string, tz: string): Promise<number> {
    return this.n(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'task.heal.wake' AND tool = $1 AND outcome LIKE 'claim %' AND ts >= ${dayStart(2)}`, [decider, tz]);
  }

  /** HL-C8: the retries a head made with resolve_blocked on this task over its lifetime (the claim rows). */
  resolveRetries(taskId: string): Promise<number> {
    return this.n("SELECT count(*)::int AS n FROM audit_log WHERE action = 'task.heal.resolve' AND task_id = $1 AND outcome = 'retry'", [taskId]);
  }

  /** Brief 3.4 rule 7: the run-task ids named in this task's wake claims (`claim #n <runTaskId>`). */
  async wakeRunTasks(taskId: string): Promise<string[]> {
    const r = await this.pool.query<{ outcome: string | null }>("SELECT outcome FROM audit_log WHERE action = 'task.heal.wake' AND task_id = $1 AND outcome LIKE 'claim %'", [taskId]);
    return r.rows.map((x) => /^claim #\d+ ([0-9a-f-]{36})$/.exec(x.outcome ?? '')?.[1]).filter((x): x is string => !!x);
  }

  /**
   * G2-03: boot recovery. Closes (cancelled) every open code-made decide task whose id a `task.heal.wake` claim names, so the boot reset never turns it into a plain
   * owner run. Only decide tasks (hq, no parent, the code-made title): a parent-path claim names a real parent task, which must stay. Returns the moved rows.
   */
  async closeOpenDecideTasks(): Promise<Task[]> {
    return (await this.pool.query<Task>(
      `UPDATE tasks SET status = 'cancelled', updated_at = now()
       WHERE status IN ('doing','todo') AND dept_id = 'hq' AND parent_id IS NULL AND title LIKE 'Decide on blocked task %'
         AND id::text IN (SELECT substring(outcome from '^claim #[0-9]+ ([0-9a-f-]{36})$') FROM audit_log WHERE action = 'task.heal.wake' AND outcome LIKE 'claim %')
       RETURNING ${taskCols()}`,
    )).rows;
  }

  /** HL-C20: today's counts and the lists the summary must show. "Unblocked" comes from task state (a retried task that is no longer blocked), never from rows. */
  async day(tz: string): Promise<HealDay> {
    const start = dayStart(1);
    const q = async <T extends QueryResultRow>(sql: string): Promise<T[]> => (await this.pool.query<T>(sql, [tz])).rows;
    const [retries] = await q<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'task.autoretry' AND ts >= ${start}`);
    const [unblocked] = await q<{ n: number }>(
      `SELECT count(DISTINCT a.task_id)::int AS n FROM audit_log a JOIN tasks t ON t.id = a.task_id WHERE a.action = 'task.autoretry' AND a.ts >= ${start} AND t.status <> 'blocked'`);
    const [wakes] = await q<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'task.heal.wake' AND outcome LIKE 'claim %' AND ts >= ${start}`);
    const [rr] = await q<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'task.heal.resolve' AND outcome = 'retry' AND ts >= ${start}`);
    const [rc] = await q<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'task.heal.resolve' AND outcome = 'cancel' AND ts >= ${start}`);
    const [ac] = await q<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'task.review.autoclose' AND ts >= ${start}`);
    const cancels = await q<{ taskId: string; title: string; decider: string }>(
      `SELECT a.task_id AS "taskId", COALESCE(t.title, '') AS title, a.actor AS decider FROM audit_log a LEFT JOIN tasks t ON t.id = a.task_id
       WHERE a.action = 'task.heal.resolve' AND a.outcome = 'cancel' AND a.ts >= ${start} ORDER BY a.id LIMIT 50`);
    const tainted = await q<{ taskId: string; title: string }>(
      `SELECT DISTINCT ON (a.task_id) a.task_id AS "taskId", COALESCE(t.title, '') AS title FROM audit_log a LEFT JOIN tasks t ON t.id = a.task_id
       WHERE a.action = 'task.heal.resolve' AND a.outcome = 'refused:R_TAINTED' AND a.ts >= ${start} ORDER BY a.task_id LIMIT 50`);
    return { retries: retries!.n, unblocked: unblocked!.n, wakes: wakes!.n, resolveRetry: rr!.n, resolveCancel: rc!.n, autoclosed: ac!.n, cancels, tainted };
  }
}
