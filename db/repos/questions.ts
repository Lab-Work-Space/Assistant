import type { ActorRef } from '../../company/types.js';
import type { Requester } from './tasks.js';
import type { Pool } from '../pool.js';

/**
 * ASKBACK-1 (migration 033): a task owner's clarifying question to its requester (at most 2 per task). Every state change here is ONE conditional UPDATE
 * on `status` (and on the other terms that make it legal), so two racing paths (a wake, a tick, a boot sweep) can never both win. Question and answer
 * text are redacted and defanged by the caller; nothing here reads a model-written id. Actors are stored in ONE canonical form (AB11):
 * {kind,dept} | {kind,personaId} | {kind,userId}, so the `requester = $x::jsonb` comparison is exact (jsonb equality ignores key order, not extra keys).
 */
export type QuestionStatus = 'pending' | 'asked' | 'answered' | 'expired' | 'moot';
export type ResumeKind = 'answer' | 'no_answer' | 'requester_unavailable' | 'timeout';

export interface TaskQuestion {
  id: number; taskId: string; rootId: string; parentId: string | null; seq: number; asker: ActorRef; requester: Requester;
  question: string; questionTainted: boolean; status: QuestionStatus; answer: string | null; answerTainted: boolean | null;
  questionMessageId: string | null; answerMessageId: string | null;
  createdAt: Date; askedAt: Date | null; expiresAt: Date | null; closedAt: Date | null; resumedAt: Date | null;
}

export type CreateInput = {
  taskId: string; rootId: string; parentId: string | null; asker: ActorRef; requester: Requester; question: string; questionTainted: boolean;
  /** Set for a human requester: the row is `asked` at once with this window. Absent: `pending` (a code wake follows). */
  askedForHours?: number;
};
export type CreateFail = 'cap_task' | 'cap_root' | 'cap_day' | 'open' | 'error';
export type CreateResult = { ok: true; row: TaskQuestion } | { ok: false; why: CreateFail };

/** The canonical stored form of an actor (AB11): exactly these keys. */
export function canonicalActor(a: Requester): Record<string, string> {
  if (a.kind === 'head') return { kind: 'head', dept: a.dept };
  if (a.kind === 'persona') return { kind: 'persona', personaId: a.personaId };
  return { kind: 'human', userId: a.userId };
}

const COLS = `id::int AS id, task_id AS "taskId", root_id AS "rootId", parent_id AS "parentId", seq::int AS seq, asker, requester, question,
  question_tainted AS "questionTainted", status, answer, answer_tainted AS "answerTainted", question_message_id AS "questionMessageId",
  answer_message_id AS "answerMessageId", created_at AS "createdAt", asked_at AS "askedAt", expires_at AS "expiresAt", closed_at AS "closedAt", resumed_at AS "resumedAt"`;

const LOCK = "SELECT pg_advisory_xact_lock(hashtext('task_questions'))";
const SNOWFLAKE = /^[0-9]{17,20}$/;

/** The slice the scheduler and the loop use (a fake in tests is a class with these methods). */
export interface QuestionStore {
  create(i: CreateInput, caps: { perRoot: number; perDay: number }): Promise<CreateResult>;
  get(id: number): Promise<TaskQuestion | null>;
  openFor(taskId: string): Promise<TaskQuestion | null>;
  openUnderParent(parentId: string): Promise<TaskQuestion[]>;
  markAsked(id: number, hours: number): Promise<TaskQuestion | null>;
  setQuestionMessage(id: number, messageId: string): Promise<boolean>;
  answer(id: number, requester: Requester, answer: string, tainted: boolean): Promise<TaskQuestion | null>;
  answerHuman(id: number, userId: string, answer: string, tainted: boolean, messageId: string): Promise<TaskQuestion | null>;
  setAnswerMessage(id: number, messageId: string): Promise<boolean>;
  revertAnswer(id: number): Promise<boolean>;
  close(id: number, status: 'expired' | 'moot', o?: { noResume?: boolean }): Promise<TaskQuestion | null>;
  markResumed(id: number): Promise<boolean>;
  dueExpiry(limit?: number): Promise<TaskQuestion[]>;
  stalePending(graceSeconds: number, limit?: number): Promise<TaskQuestion[]>;
  staleUnresumed(graceSeconds: number, limit?: number): Promise<TaskQuestion[]>;
  bootClose(before?: Date): Promise<{ closed: number; claimed: number }>;
}

export class QuestionRepo implements QuestionStore {
  constructor(private readonly pool: Pool) {}

  /** One transaction under an advisory lock: the per-task cap (2), the per-root cap and the per-day cap are all checked in the INSERT's own WHERE. */
  async create(i: CreateInput, caps: { perRoot: number; perDay: number }): Promise<CreateResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(LOCK);
      let row: TaskQuestion | undefined;
      try {
        const r = await client.query<TaskQuestion>(
          `INSERT INTO task_questions (task_id, root_id, parent_id, seq, asker, requester, question, question_tainted)
           SELECT $1,$2,$3, COALESCE((SELECT max(seq) FROM task_questions WHERE task_id = $1), 0) + 1, $4::jsonb, $5::jsonb, $6, $7
           WHERE (SELECT count(*) FROM task_questions WHERE task_id = $1) < 2
             AND (SELECT count(*) FROM task_questions WHERE root_id = $2) < $8
             AND (SELECT count(*) FROM task_questions WHERE created_at > now() - interval '1 day') < $9
           RETURNING ${COLS}`,
          [i.taskId, i.rootId, i.parentId, JSON.stringify(canonicalActor(i.asker)), JSON.stringify(canonicalActor(i.requester)), i.question, i.questionTainted, caps.perRoot, caps.perDay],
        );
        row = r.rows[0];
      } catch (err) {
        await client.query('ROLLBACK');
        const e = err as { code?: string; constraint?: string };
        if (e.code === '23505' && e.constraint === 'task_questions_one_open') return { ok: false, why: 'open' };
        if (e.code === '23505' && e.constraint === 'task_questions_seq_once') return { ok: false, why: 'cap_task' };
        return { ok: false, why: 'error' };
      }
      if (!row) {
        // which cap held (read inside the same locked transaction)
        const c = await client.query<{ t: number; r: number; d: number }>(
          `SELECT (SELECT count(*) FROM task_questions WHERE task_id = $1)::int AS t, (SELECT count(*) FROM task_questions WHERE root_id = $2)::int AS r,
                  (SELECT count(*) FROM task_questions WHERE created_at > now() - interval '1 day')::int AS d`,
          [i.taskId, i.rootId],
        );
        await client.query('ROLLBACK');
        const x = c.rows[0]!;
        return { ok: false, why: x.t >= 2 ? 'cap_task' : x.r >= caps.perRoot ? 'cap_root' : x.d >= caps.perDay ? 'cap_day' : 'error' };
      }
      if (i.askedForHours !== undefined) {
        const u = await client.query<TaskQuestion>(
          `UPDATE task_questions SET status = 'asked', asked_at = now(), expires_at = now() + $2::float8 * interval '1 hour' WHERE id = $1 AND status = 'pending' RETURNING ${COLS}`,
          [row.id, i.askedForHours],
        );
        row = u.rows[0]!;
      }
      await client.query('COMMIT');
      return { ok: true, row };
    } catch {
      await client.query('ROLLBACK').catch(() => undefined);
      return { ok: false, why: 'error' };
    } finally {
      client.release();
    }
  }

  async get(id: number): Promise<TaskQuestion | null> {
    return (await this.pool.query<TaskQuestion>(`SELECT ${COLS} FROM task_questions WHERE id = $1`, [id])).rows[0] ?? null;
  }

  async openFor(taskId: string): Promise<TaskQuestion | null> {
    return (await this.pool.query<TaskQuestion>(`SELECT ${COLS} FROM task_questions WHERE task_id = $1 AND status IN ('pending','asked')`, [taskId])).rows[0] ?? null;
  }

  async openUnderParent(parentId: string): Promise<TaskQuestion[]> {
    return (await this.pool.query<TaskQuestion>(`SELECT ${COLS} FROM task_questions WHERE parent_id = $1 AND status IN ('pending','asked') ORDER BY id`, [parentId])).rows;
  }

  /** pending -> asked, the wake's claim (0 rows: someone else started it, or it is no longer pending). Sets the expiry on the database clock. */
  async markAsked(id: number, hours: number): Promise<TaskQuestion | null> {
    return (await this.pool.query<TaskQuestion>(
      `UPDATE task_questions SET status = 'asked', asked_at = now(), expires_at = now() + $2::float8 * interval '1 hour' WHERE id = $1 AND status = 'pending' RETURNING ${COLS}`,
      [id, hours],
    )).rows[0] ?? null;
  }

  async setQuestionMessage(id: number, messageId: string): Promise<boolean> {
    if (!SNOWFLAKE.test(messageId)) return false;
    return ((await this.pool.query('UPDATE task_questions SET question_message_id = $2 WHERE id = $1 AND question_message_id IS NULL', [id, messageId])).rowCount ?? 0) > 0;
  }

  /** The bot answer: only while `asked`, and only by the row's own requester (canonical jsonb equality). NULL taint is never written (AB6). */
  async answer(id: number, requester: Requester, answer: string, tainted: boolean): Promise<TaskQuestion | null> {
    return (await this.pool.query<TaskQuestion>(
      `UPDATE task_questions SET status = 'answered', answer = $3, answer_tainted = $4, closed_at = now()
       WHERE id = $1 AND status = 'asked' AND requester = $2::jsonb RETURNING ${COLS}`,
      [id, JSON.stringify(canonicalActor(requester)), answer, tainted],
    )).rows[0] ?? null;
  }

  /** The human answer (AB7): the message that started the owner run; `resumed_at` is set in the same statement (that run IS the resume). */
  async answerHuman(id: number, userId: string, answer: string, tainted: boolean, messageId: string): Promise<TaskQuestion | null> {
    return (await this.pool.query<TaskQuestion>(
      `UPDATE task_questions SET status = 'answered', answer = $3, answer_tainted = $4, closed_at = now(), resumed_at = now(),
         answer_message_id = CASE WHEN $5 ~ '^[0-9]{17,20}$' THEN $5 ELSE NULL END
       WHERE id = $1 AND status = 'asked' AND requester = $2::jsonb RETURNING ${COLS}`,
      [id, JSON.stringify({ kind: 'human', userId }), answer, tainted, messageId],
    )).rows[0] ?? null;
  }

  async setAnswerMessage(id: number, messageId: string): Promise<boolean> {
    if (!SNOWFLAKE.test(messageId)) return false;
    return ((await this.pool.query("UPDATE task_questions SET answer_message_id = $2 WHERE id = $1 AND status = 'answered' AND answer_message_id IS NULL", [id, messageId])).rowCount ?? 0) > 0;
  }

  /** AB11: answered -> asked again when the 💬 line could not be posted. Clears answer, answer_tainted and closed_at (the CHECKs demand it); keeps resumed_at. */
  async revertAnswer(id: number): Promise<boolean> {
    return ((await this.pool.query(
      `UPDATE task_questions SET status = 'asked', answer = NULL, answer_tainted = NULL, closed_at = NULL WHERE id = $1 AND status = 'answered' AND answer_message_id IS NULL`,
      [id],
    )).rowCount ?? 0) > 0;
  }

  /** Ends an open row. `expired` only from `asked`; `moot` from either open state. `noResume` also claims the resume (nobody is to be woken). */
  async close(id: number, status: 'expired' | 'moot', o: { noResume?: boolean } = {}): Promise<TaskQuestion | null> {
    const from = status === 'expired' ? ['asked'] : ['pending', 'asked'];
    return (await this.pool.query<TaskQuestion>(
      `UPDATE task_questions SET status = $2, closed_at = now()${o.noResume ? ', resumed_at = now()' : ''} WHERE id = $1 AND status = ANY($3::text[]) RETURNING ${COLS}`,
      [id, status, from],
    )).rows[0] ?? null;
  }

  /** The one resume: only a closed row, only once (the claim is taken inside the child's task lock, just before the owner run). */
  async markResumed(id: number): Promise<boolean> {
    return ((await this.pool.query("UPDATE task_questions SET resumed_at = now() WHERE id = $1 AND resumed_at IS NULL AND status IN ('answered','expired','moot')", [id])).rowCount ?? 0) > 0;
  }

  async dueExpiry(limit = 20): Promise<TaskQuestion[]> {
    return (await this.pool.query<TaskQuestion>(`SELECT ${COLS} FROM task_questions WHERE status = 'asked' AND expires_at < now() ORDER BY expires_at LIMIT $1`, [limit])).rows;
  }

  /** `pending` rows older than the grace: a wake that never started (halt, a dropped hold, a pause). */
  async stalePending(graceSeconds: number, limit = 20): Promise<TaskQuestion[]> {
    return (await this.pool.query<TaskQuestion>(
      `SELECT ${COLS} FROM task_questions WHERE status = 'pending' AND created_at < now() - $1::float8 * interval '1 second' ORDER BY id LIMIT $2`,
      [graceSeconds, limit],
    )).rows;
  }

  /**
   * Closed rows (answered, expired, moot) whose owner was never resumed, older than the grace, whose child is still `doing` (Gate 2 G2AB-03: filtered here,
   * not only by the caller, so rows of ended or parked children can never fill the LIMIT and starve newer resumes).
   */
  async staleUnresumed(graceSeconds: number, limit = 20): Promise<TaskQuestion[]> {
    return (await this.pool.query<TaskQuestion>(
      `SELECT ${COLS} FROM task_questions WHERE status IN ('answered','expired','moot') AND resumed_at IS NULL AND closed_at < now() - $1::float8 * interval '1 second'
         AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = task_questions.task_id AND t.status = 'doing') ORDER BY id LIMIT $2`,
      [graceSeconds, limit],
    )).rows;
  }

  /**
   * AB2 option (b), at boot, in the same step as `resetDoingToTodo`: every open row is closed `moot` (resumed claimed) and every closed row that was never resumed
   * is claimed too. The reset owner run is then the single resume (it reads the ⏳ and 💬 lines from its thread history).
   * G2AB-04: only rows created before `before` (this process's start; default: now) are touched, so a question this process created is never closed by a late call.
   */
  async bootClose(before: Date = new Date()): Promise<{ closed: number; claimed: number }> {
    const a = await this.pool.query("UPDATE task_questions SET status = 'moot', closed_at = now(), resumed_at = now() WHERE status IN ('pending','asked') AND created_at < $1", [before]);
    const b = await this.pool.query("UPDATE task_questions SET resumed_at = now() WHERE status IN ('answered','expired','moot') AND resumed_at IS NULL AND created_at < $1", [before]);
    return { closed: a.rowCount ?? 0, claimed: b.rowCount ?? 0 };
  }
}
