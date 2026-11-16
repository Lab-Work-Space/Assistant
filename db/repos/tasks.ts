import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { DeptId } from '../../core/index.js';
import { redactText } from '../../core/logger.js';
import type { ActorRef } from '../../company/types.js';
import type { Pool } from '../pool.js';

export type TaskStatus = 'todo' | 'doing' | 'review' | 'done' | 'blocked' | 'awaiting_approval' | 'cancelled';
export type Requester = ActorRef | { kind: 'human'; userId: string };
/** Where a task came from (R3): written by the creating code path only, never by tool input, prompt text or model output. */
export type TaskOrigin = 'chat' | 'slash' | 'voice' | 'delegated' | 'schedule' | 'watch' | 'reminder' | 'poll' | 'import';
/** Why a task is `blocked` (R35). Only 'halt' blocks are resumed automatically. TASKADMIN-1: 'owner' = the owner blocked its own task with update_task (migration 036). */
export type BlockReason = 'halt' | 'approval' | 'budget' | 'turns' | 'error' | 'owner';
/** TASKADMIN-1 (TA-C5): the deepest tree a cancel walks. `limits.depth` is at most 20 in the config schema (a unit test binds the two), so a tree is never deeper. */
export const TASK_TREE_MAX_DEPTH = 20;
/** TASKADMIN-1 (TA-C8): a child may not be created under a cancelled parent. A named error so the tool boundary can say so. */
export class ParentCancelledError extends Error {
  constructor() {
    super('the parent task was cancelled');
    this.name = 'ParentCancelledError';
  }
}
/** TA-C15: the stored note is at most this long, masked and folded to one line first. */
export const BLOCKED_NOTE_MAX = 300;
type Queryable = Pick<PoolClient, 'query'>;
/** A status change made outside TaskRepo.update's caller (raw SQL paths); mirrored as task.changed after COMMIT. */
export type TaskChange = { task: Task; from: TaskStatus };

export interface Task {
  id: string;
  title: string;
  description: string;
  deptId: DeptId;
  owner: ActorRef;
  requester: Requester;
  parentId: string | null;
  rootId: string;
  depth: number;
  status: TaskStatus;
  threadId: string | null;
  turnsUsed: number;
  costUsd: number;
  estCostUsd: number | null;
  blockedReason: BlockReason | null;
  origin: TaskOrigin;
  /** Channel of the task's thread when it is not the department work channel. */
  channelId: string | null;
  /** Creator of a job-run task (context only, never the requester). */
  sourceUserId: string | null;
  /** G2-04: a run on this task (or the run that created it) had read outside text, so a later run on it starts tainted. */
  tainted: boolean;
  /** The task's card in #tasks and its card in the task thread (edited in place); null until first posted. */
  logMessageId?: string | null;
  cardMessageId?: string | null;
  /** WS6: the Discord category where the root was started (set by code from the fetched channel chain, copied to children); null = none known. */
  originCategoryId?: string | null;
  /** WS13: a conversation root opened by code for a person's message to a head (or Praw). Explicit; a /goal task is not one. */
  conversation?: boolean;
  /** WS13: the person's message a conversation's roll-up replies to. */
  originMessageId?: string | null;
  /** F2 / LF7: the #ai-warroom message this conversation is waiting on (one roll-up per message, claimed with a conditional UPDATE); null = none. */
  warroomSayId?: string | null;
  /** RF11: set on a task made by `forward_to`: what its cards show ('full' = the summary, 'link' = the source link and a fixed line). Null on every other task. */
  forwardCard?: 'full' | 'link' | null;
  /** TEAMTALK-1: what "done" means (model-written, <= 300 chars, display only) and the due date (`YYYY-MM-DD`, display only, no reminder). */
  acceptance?: string | null;
  dueOn?: string | null;
  /** TEAMTALK-1: the handoff line (H1) in the parent thread and the owner's final report message; ids only, null until posted. */
  handoffMessageId?: string | null;
  resultMessageId?: string | null;
  /** REROUTE-1: the message (a snowflake) whose mention made this task, and the channel or thread that message was in; null on every other task. */
  rerouteSourceId?: string | null;
  rerouteWhere?: string | null;
}

/** Which of a task's two Discord cards. */
export type TaskMessageKind = 'log' | 'card' | 'handoff';
const MSG_COLS: Record<TaskMessageKind, string> = { log: 'log_message_id', card: 'card_message_id', handoff: 'handoff_message_id' };
const SNOWFLAKE_ID = /^[0-9]{17,20}$/;

/**
 * Taint of a new task when its creator does not say: a human message, a job the creator wrote and a reminder start clean;
 * delegation, watches, polls, imports and anything else carry outside text and start tainted (create_task passes the run's own).
 */
export const defaultTainted = (origin: TaskOrigin): boolean => !['chat', 'slash', 'voice', 'schedule', 'reminder'].includes(origin);

export interface NewTask {
  id?: string;
  title: string;
  description?: string;
  deptId: DeptId;
  owner: ActorRef;
  requester: Requester;
  /** Required, no inheritance: each creating code path states it. create_task passes 'delegated'. */
  origin: TaskOrigin;
  channelId?: string | null;
  sourceUserId?: string | null;
  parentId?: string | null;
  depth?: number;
  status?: TaskStatus;
  threadId?: string | null;
  estCostUsd?: number | null;
  /** Taint of the creating run; default by origin (see defaultTainted). */
  tainted?: boolean;
  /** WS6: roots only, set by the creating code path from the fetched channel chain; a child always copies its parent's value. */
  originCategoryId?: string | null;
  /** WS13: set by the conversation code only. */
  conversation?: boolean;
  originMessageId?: string | null;
  /** RF11: set by `forward_to` only. */
  forwardCard?: 'full' | 'link';
  /** TEAMTALK-1: create_task only (length and date range are checked there). */
  acceptance?: string | null;
  dueOn?: string | null;
  /** REROUTE-1: set by the reroute code only (snowflakes; anything else is refused by the column CHECK). */
  rerouteSourceId?: string;
  rerouteWhere?: string;
}

export type TaskPatch = Partial<
  Pick<Task, 'title' | 'description' | 'owner' | 'status' | 'threadId' | 'turnsUsed' | 'costUsd' | 'estCostUsd' | 'blockedReason' | 'tainted' | 'channelId' | 'originMessageId'>
> & {
  /** TA-C15: the model-written reason of an owner block (reason 'owner' only). Masked, folded and cut here; never part of `Task`. */
  blockedNote?: string;
};

const COLS = {
  title: 'title',
  description: 'description',
  owner: 'owner',
  status: 'status',
  threadId: 'thread_id',
  turnsUsed: 'turns_used',
  costUsd: 'cost_usd',
  estCostUsd: 'est_cost_usd',
  blockedReason: 'blocked_reason',
  tainted: 'tainted',
  channelId: 'channel_id',
  originMessageId: 'origin_message_id',
} as const;

/** Task columns as Task fields; `a` qualifies them (e.g. 't.') for UPDATE ... FROM ... RETURNING. */
export const taskCols = (a = ''): string => `${a}id, ${a}title, ${a}description, ${a}dept_id AS "deptId", ${a}owner, ${a}requester,
  ${a}parent_id AS "parentId", ${a}root_id AS "rootId", ${a}depth, ${a}status, ${a}thread_id AS "threadId", ${a}turns_used AS "turnsUsed",
  ${a}cost_usd AS "costUsd", ${a}est_cost_usd AS "estCostUsd", ${a}blocked_reason AS "blockedReason", ${a}origin, ${a}channel_id AS "channelId", ${a}source_user_id AS "sourceUserId", ${a}tainted,
  ${a}log_message_id AS "logMessageId", ${a}card_message_id AS "cardMessageId",
  ${a}origin_category_id AS "originCategoryId", ${a}conversation, ${a}origin_message_id AS "originMessageId", ${a}warroom_say_id AS "warroomSayId", ${a}forward_card AS "forwardCard",
  ${a}acceptance, to_char(${a}due_on, 'YYYY-MM-DD') AS "dueOn", ${a}handoff_message_id AS "handoffMessageId", ${a}result_message_id AS "resultMessageId",
  ${a}reroute_source_id AS "rerouteSourceId", ${a}reroute_where AS "rerouteWhere"`;

const SELECT = `SELECT ${taskCols()} FROM tasks`;

/** One row of /task list (TA-C4). TA-C15 (amended by HL-C13): with `HealRepo.blockedNote` (the wrapped heal-wake message) the only reader of `blocked_note`. */
export interface AdminTaskRow {
  id: string; deptId: string; status: TaskStatus; title: string; depth: number; blockedReason: BlockReason | null; blockedNote: string | null; updatedAt: Date; openChildren: number;
}
/** One open row of a task's subtree. */
export interface SubtreeRow { id: string; status: TaskStatus; parentId: string | null; deptId: string; depth: number }
export const TASK_OPEN_STATUSES = ['todo', 'doing', 'review', 'blocked', 'awaiting_approval'] as const;
/** The cut, at most 51 open rows so a set over 50 is detectable; `tooDeep` = a row at the depth bound still has a child (TA-C5). */
export const SUBTREE_READ = 51;

/**
 * The open (not done, not cancelled) rows of the tree under `id`, `id` included, walking at most TASK_TREE_MAX_DEPTH levels (TA-C5). Usable inside a
 * transaction (adminCancel runs it after the row locks). Done and cancelled rows are walked through, so an open grandchild below an ended child is found.
 */
export async function openSubtree(db: Queryable, id: string): Promise<{ rows: SubtreeRow[]; tooDeep: boolean }> {
  const r = await db.query<SubtreeRow>(
    `WITH RECURSIVE sub(id, lvl) AS (
       SELECT id, 0 FROM tasks WHERE id = $1
       UNION ALL
       SELECT t.id, s.lvl + 1 FROM tasks t JOIN sub s ON t.parent_id = s.id WHERE s.lvl < $2
     )
     SELECT t.id, t.status, t.parent_id AS "parentId", t.dept_id AS "deptId", sub.lvl AS depth
     FROM tasks t JOIN sub ON sub.id = t.id
     WHERE t.status NOT IN ('done','cancelled')
     ORDER BY t.id
     LIMIT ${SUBTREE_READ}`,
    [id, TASK_TREE_MAX_DEPTH],
  );
  const deep = await db.query(
    `WITH RECURSIVE sub(id, lvl) AS (
       SELECT id, 0 FROM tasks WHERE id = $1
       UNION ALL
       SELECT t.id, s.lvl + 1 FROM tasks t JOIN sub s ON t.parent_id = s.id WHERE s.lvl < $2
     )
     SELECT 1 FROM sub WHERE sub.lvl = $2 AND EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = sub.id) LIMIT 1`,
    [id, TASK_TREE_MAX_DEPTH],
  );
  return { rows: r.rows, tooDeep: (deep.rowCount ?? 0) > 0 };
}

const INSERT_SQL = `INSERT INTO tasks (id, title, description, dept_id, owner, requester, parent_id, root_id, depth, status, thread_id, est_cost_usd, origin, channel_id, source_user_id, tainted, origin_category_id, conversation, origin_message_id, forward_card, acceptance, due_on, reroute_source_id, reroute_where)
       SELECT $1::text,$2::text,$3::text,$4::text,$5::jsonb,$6::jsonb,$7::text,$8::text,$9::int,$10::text,$11::text,$12::numeric,$13::text,$14::text,$15::text,$16::boolean,$17::text,$18::boolean,$19::text,$20::text,$21::text,$22::date,$23::text,$24::text
       WHERE $26::text IS NULL OR EXISTS (SELECT 1 FROM tasks p WHERE p.id = $26::text AND p.status <> 'cancelled' AND ($25::text IS NULL OR p.status IN ('doing','review')) FOR SHARE OF p)`;
const insertArgs = (t: NewTask, id: string, rootId: string, depth: number, category: string | null, requireOpenParent: string | null): unknown[] => [
  id, t.title, t.description ?? '', t.deptId, JSON.stringify(t.owner), JSON.stringify(t.requester),
  t.parentId ?? null, rootId, depth, t.status ?? 'todo', t.threadId ?? null, t.estCostUsd ?? null,
  t.origin, t.channelId ?? null, t.sourceUserId ?? null, t.tainted ?? defaultTainted(t.origin),
  category && SNOWFLAKE_ID.test(category) ? category : null, t.conversation ?? false, t.originMessageId && SNOWFLAKE_ID.test(t.originMessageId) ? t.originMessageId : null,
  t.forwardCard ?? null, t.acceptance ?? null, t.dueOn ?? null, t.rerouteSourceId ?? null, t.rerouteWhere ?? null, requireOpenParent, t.parentId ?? null,
];

export class TaskRepo {
  /** `secrets`: the shared literal secret list (may grow); a blocked note is masked with it and the generic patterns before it is stored (TA-C15). */
  constructor(private readonly pool: Pool, private readonly secrets: readonly string[] = []) {}

  async create(t: NewTask): Promise<Task> {
    const made = await this.insert(t, null);
    if (!made) throw new ParentCancelledError(); // only a refused parent check makes no row (TA-C8)
    return made;
  }

  /**
   * REROUTE-1 (RR-C5): creates the child only while `parentId` is still `doing` or `review`, checked in the same INSERT statement. Null = no row was made
   * (the parent is gone, done, cancelled or otherwise not open). `t.parentId` must be `parentId`.
   */
  async createUnderOpenParent(t: NewTask & { parentId: string }): Promise<Task | null> {
    return this.insert(t, t.parentId);
  }

  private async insert(t: NewTask, requireOpenParent: string | null): Promise<Task | null> {
    const id = t.id ?? randomUUID();
    if (!t.parentId) {
      const r = await this.pool.query(INSERT_SQL, insertArgs(t, id, id, t.depth ?? 0, t.originCategoryId ?? null, requireOpenParent));
      return r.rowCount ? (await this.get(id))! : null;
    }
    // AUTO-1 (AP-C15): a child reads its parent's tree position under a row lock and inserts in the same transaction, so an adoption (which re-parents a whole
    // tree under row locks) can never leave a child with the old `root_id` or `depth`. Lock order: the root row, then the parent row (the adoption locks the root first too).
    const c = await this.pool.connect();
    let made = false;
    try {
      await c.query('BEGIN');
      let parent: { rootId: string; depth: number; cat: string | null } | undefined;
      for (let attempt = 0; attempt < 3 && !parent; attempt++) {
        const peek = (await c.query<{ rootId: string }>('SELECT root_id AS "rootId" FROM tasks WHERE id = $1', [t.parentId])).rows[0];
        if (!peek) break;
        await c.query('SELECT 1 FROM tasks WHERE id = $1 FOR SHARE', [peek.rootId]);
        const p = (await c.query<{ rootId: string; depth: number; cat: string | null }>(
          'SELECT root_id AS "rootId", depth, origin_category_id AS cat FROM tasks WHERE id = $1 FOR SHARE', [t.parentId])).rows[0];
        if (p?.rootId === peek.rootId) parent = p; // else the tree moved while we waited: read it again under the new root
        else if (!p) break;
      }
      if (!parent) {
        await c.query('ROLLBACK');
        if (requireOpenParent) return null;
        throw new Error(`parent task ${t.parentId} not found`);
      }
      const r = await c.query(INSERT_SQL, insertArgs(t, id, parent.rootId, t.depth ?? parent.depth + 1, parent.cat /* WS6: fixed when the root is created, inherited unchanged */, requireOpenParent));
      made = (r.rowCount ?? 0) > 0;
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
    return made ? (await this.get(id))! : null;
  }

  /** REROUTE-1 (RR-C14): whether a task already exists for this mention message and department (checked before any slot is taken). */
  async rerouteExists(messageId: string, deptId: string): Promise<boolean> {
    return ((await this.pool.query('SELECT 1 FROM tasks WHERE reroute_source_id = $1 AND dept_id = $2 LIMIT 1', [messageId, deptId])).rowCount ?? 0) > 0;
  }

  /**
   * REROUTE-1 (RR-C4): an open rerouted task of `deptId` made for the same mentioner from the same channel or thread since `since`, or (when `parentId` is
   * given) any open child of that parent owned by the department since `since` (covers the mentioner's own create_task). Parent-independent by design.
   */
  async recentRerouteOpen(a: { deptId: string; requester: Task['requester']; where: string; parentId?: string | null; since: Date }): Promise<boolean> {
    const r = await this.pool.query(
      `SELECT 1 FROM tasks WHERE dept_id = $1 AND status NOT IN ('done','cancelled') AND created_at >= $2
         AND ((reroute_source_id IS NOT NULL AND reroute_where = $3 AND requester @> $4::jsonb) OR ($5::text IS NOT NULL AND parent_id = $5::text)) LIMIT 1`,
      [a.deptId, a.since, a.where, JSON.stringify(a.requester), a.parentId ?? null],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** REROUTE-1 (RR-C12): the person's open rerouted root tasks (no parent), from the database. */
  async countOpenRerouteRoots(userId: string): Promise<number> {
    return (await this.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM tasks WHERE reroute_source_id IS NOT NULL AND parent_id IS NULL AND requester @> $1::jsonb AND status NOT IN ('done','cancelled')",
      [JSON.stringify({ kind: 'human', userId })],
    )).rows[0]!.n;
  }

  async get(id: string): Promise<Task | null> {
    return (await this.pool.query<Task>(`${SELECT} WHERE id = $1`, [id])).rows[0] ?? null;
  }

  /** Optimistic update; returns null when the row is missing or its status != expectedStatus. */
  async update(id: string, patch: TaskPatch, expectedStatus?: TaskStatus): Promise<Task | null> {
    const sets: string[] = [];
    const vals: unknown[] = [id];
    for (const [k, col] of Object.entries(COLS) as [keyof TaskPatch, string][]) {
      if (patch[k] === undefined) continue;
      vals.push(k === 'owner' ? JSON.stringify(patch[k]) : patch[k]);
      sets.push(`${col} = $${vals.length}`);
    }
    // A reason belongs to one blocked spell: any other status clears it (R35).
    if (patch.status !== undefined && patch.blockedReason === undefined) sets.push('blocked_reason = NULL');
    // TA-C14/C15: the note belongs to one owner-blocked spell. It is set only with reason 'owner' (masked, one line, cut), and cleared by every other write of status or reason.
    if (patch.blockedNote !== undefined) {
      if (patch.blockedReason !== 'owner') throw new Error("blockedNote needs blockedReason 'owner'");
      vals.push(this.maskNote(patch.blockedNote));
      sets.push(`blocked_note = $${vals.length}`);
    } else if (patch.status !== undefined || patch.blockedReason !== undefined) sets.push('blocked_note = NULL');
    sets.push('updated_at = now()');
    let where = 'id = $1';
    if (expectedStatus) {
      vals.push(expectedStatus);
      where += ` AND status = $${vals.length}`;
    }
    const r = await this.pool.query(`UPDATE tasks SET ${sets.join(', ')} WHERE ${where}`, vals);
    return r.rowCount ? this.get(id) : null;
  }

  /** TA-C15: redacted first (literals and patterns), then folded to one line, then cut, so a cut can never leave a prefix of a secret. */
  private maskNote(raw: string): string {
    const one = redactText(raw, this.secrets).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
    return one.length > BLOCKED_NOTE_MAX ? one.slice(0, BLOCKED_NOTE_MAX) : one;
  }

  /** TASKADMIN-1: the open tasks of `statuses`, stalest first (`updated_at`), with the open-children count and the note. With `HealRepo.blockedNote` the only reader of `blocked_note` (TA-C15, amended by HL-C13). */
  async listOpenAdmin(statuses: readonly TaskStatus[], limit: number): Promise<AdminTaskRow[]> {
    return (await this.pool.query<AdminTaskRow>(
      `SELECT t.id, t.dept_id AS "deptId", t.status, t.title, t.depth, t.blocked_reason AS "blockedReason", t.blocked_note AS "blockedNote", t.updated_at AS "updatedAt",
              (SELECT count(*)::int FROM tasks c WHERE c.parent_id = t.id AND c.status NOT IN ('done','cancelled')) AS "openChildren"
       FROM tasks t WHERE t.status = ANY($1) ORDER BY t.updated_at ASC, t.id LIMIT $2`,
      [statuses, Math.max(1, Math.floor(limit))],
    )).rows;
  }

  /** TASKADMIN-1: how many tasks are in each open status (the /task list header). */
  async countByStatus(): Promise<Record<(typeof TASK_OPEN_STATUSES)[number], number>> {
    const out = { todo: 0, doing: 0, review: 0, blocked: 0, awaiting_approval: 0 };
    const r = await this.pool.query<{ status: keyof typeof out; n: number }>('SELECT status, count(*)::int AS n FROM tasks WHERE status = ANY($1) GROUP BY status', [TASK_OPEN_STATUSES]);
    for (const row of r.rows) out[row.status] = row.n;
    return out;
  }

  /**
   * TASKADMIN-1 (TA-C18): the digest a /task done confirm is bound to: id, status, updated_at (to the microsecond; `Task` does not carry it) and the open-children count,
   * first 12 hex of sha256. Null when the task is gone.
   */
  async acceptDigest(id: string): Promise<string | null> {
    const r = await this.pool.query<{ s: string }>(
      `SELECT t.id || ':' || t.status || ':' || to_char(t.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') || ':' ||
              (SELECT count(*) FROM tasks c WHERE c.parent_id = t.id AND c.status NOT IN ('done','cancelled'))::text AS s
       FROM tasks t WHERE t.id = $1`, [id]);
    return r.rows[0] ? createHash('sha256').update(r.rows[0].s).digest('hex').slice(0, 12) : null;
  }

  /** TASKADMIN-1 (TA-C3): tasks whose id starts with `prefix` (the caller validated it as `[0-9a-f-]{6,36}`), oldest first. */
  async findByIdPrefix(prefix: string, limit: number): Promise<{ id: string; deptId: string; status: TaskStatus }[]> {
    return (await this.pool.query<{ id: string; deptId: string; status: TaskStatus }>(
      `SELECT id, dept_id AS "deptId", status FROM tasks WHERE id LIKE $1 || '%' ORDER BY created_at, id LIMIT $2`, [prefix, Math.max(1, Math.floor(limit))])).rows;
  }

  /** TASKADMIN-1: how many approvals of these tasks are pending (the cancel confirm shows how many will expire). */
  async pendingApprovalCount(ids: readonly string[]): Promise<number> {
    return (await this.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM approvals WHERE task_id = ANY($1) AND status = 'pending'", [ids])).rows[0]!.n;
  }

  /** TASKADMIN-1 (TA-C5): see `openSubtree`. */
  openSubtree(id: string): Promise<{ rows: SubtreeRow[]; tooDeep: boolean }> {
    return openSubtree(this.pool, id);
  }

  /** The stored card id (validated as a snowflake, else null). */
  async messageId(id: string, kind: TaskMessageKind): Promise<string | null> {
    const r = await this.pool.query<{ m: string | null }>(`SELECT ${MSG_COLS[kind]} AS m FROM tasks WHERE id = $1`, [id]);
    const m = r.rows[0]?.m ?? null;
    return m !== null && SNOWFLAKE_ID.test(m) ? m : null;
  }

  /** TW15: stores the id only while none is stored; false when another writer won (the caller edits the winner's message). */
  async claimMessage(id: string, kind: TaskMessageKind, messageId: string): Promise<boolean> {
    if (!SNOWFLAKE_ID.test(messageId)) return false;
    const col = MSG_COLS[kind];
    return ((await this.pool.query(`UPDATE tasks SET ${col} = $1 WHERE id = $2 AND ${col} IS NULL`, [messageId, id])).rowCount ?? 0) > 0;
  }

  /** TEAMTALK-1: the owner's final report message (a snowflake, else nothing is written); the last one wins. */
  async setResultMessage(id: string, messageId: string): Promise<boolean> {
    if (!SNOWFLAKE_ID.test(messageId)) return false;
    return ((await this.pool.query('UPDATE tasks SET result_message_id = $1 WHERE id = $2', [messageId, id])).rowCount ?? 0) > 0;
  }

  /** TEAMTALK-1: the persona's open tasks (not done or cancelled), newest first, for the room board. */
  async openOwnedBy(personaId: string, limit: number): Promise<Task[]> {
    return (await this.pool.query<Task>(
      `${SELECT} WHERE owner->>'kind' = 'persona' AND owner->>'personaId' = $1 AND status NOT IN ('done','cancelled') ORDER BY created_at DESC LIMIT $2`,
      [personaId, Math.max(1, Math.floor(limit))],
    )).rows;
  }

  /** LF7: records the warroom message a conversation waits on, only while none is recorded (a snowflake, else false). */
  async setWarroomSay(id: string, messageId: string): Promise<boolean> {
    if (!SNOWFLAKE_ID.test(messageId)) return false;
    return ((await this.pool.query('UPDATE tasks SET warroom_say_id = $1 WHERE id = $2 AND warroom_say_id IS NULL', [messageId, id])).rowCount ?? 0) > 0;
  }

  /** LF7: takes the right to run the one roll-up (clears the id); true for exactly one caller. */
  async claimWarroomSay(id: string): Promise<boolean> {
    return ((await this.pool.query('UPDATE tasks SET warroom_say_id = NULL WHERE id = $1 AND warroom_say_id IS NOT NULL', [id])).rowCount ?? 0) > 0;
  }

  /** RF10: takes one forward for the tree of `rootId` while it has taken fewer than `cap`; false when the cap is reached (one conditional UPDATE). */
  async takeForward(rootId: string, cap: number): Promise<boolean> {
    return ((await this.pool.query('UPDATE tasks SET forwards = forwards + 1 WHERE id = $1 AND forwards < $2', [rootId, cap])).rowCount ?? 0) > 0;
  }

  /** OFFDAY-1: takes the one off-day notice of the root `rootId` for local day `day` (YYYY-MM-DD); true for exactly one caller per day (one conditional UPDATE). */
  async claimOffdayNotice(rootId: string, day: string): Promise<boolean> {
    return ((await this.pool.query('UPDATE tasks SET offday_notice_on = $2::date WHERE id = $1 AND offday_notice_on IS DISTINCT FROM $2::date', [rootId, day])).rowCount ?? 0) > 0;
  }

  /** Replaces a stored id that Discord reports gone (10008) with the reposted one; only while it still is `oldId`. */
  async replaceMessage(id: string, kind: TaskMessageKind, oldId: string, messageId: string): Promise<boolean> {
    if (!SNOWFLAKE_ID.test(messageId)) return false;
    const col = MSG_COLS[kind];
    return ((await this.pool.query(`UPDATE tasks SET ${col} = $1 WHERE id = $2 AND ${col} = $3`, [messageId, id, oldId])).rowCount ?? 0) > 0;
  }

  /** Summary board input: per status the newest `perStatus` rows and the real count; `done` is limited to today. */
  async boardSnapshot(perStatus: number): Promise<Record<'doing' | 'blocked' | 'review' | 'todo' | 'done', { total: number; rows: { id: string; deptId: string; title: string }[] }>> {
    const r = await this.pool.query<{ id: string; deptId: string; title: string; status: string; total: number }>(
      `SELECT id, dept_id AS "deptId", title, status, total FROM (
         SELECT t.*, row_number() OVER (PARTITION BY status ORDER BY updated_at DESC, id) AS rn, count(*) OVER (PARTITION BY status)::int AS total
         FROM tasks t
         WHERE status IN ('doing','blocked','review','todo') OR (status = 'done' AND updated_at >= date_trunc('day', now()))
       ) x WHERE rn <= $1 ORDER BY status, rn`,
      [perStatus],
    );
    const out = { doing: { total: 0, rows: [] }, blocked: { total: 0, rows: [] }, review: { total: 0, rows: [] }, todo: { total: 0, rows: [] }, done: { total: 0, rows: [] } } as Awaited<ReturnType<TaskRepo['boardSnapshot']>>;
    for (const row of r.rows) {
      const bucket = out[row.status as keyof typeof out];
      bucket.total = row.total;
      bucket.rows.push({ id: row.id, deptId: row.deptId, title: row.title });
    }
    return out;
  }

  async listByStatus(s: TaskStatus): Promise<Task[]> {
    return (await this.pool.query<Task>(`${SELECT} WHERE status = $1 ORDER BY created_at, id`, [s])).rows;
  }

  /**
   * WS13: the open (not done, not cancelled) conversation root of this head and person at this thread or channel; at most one is ever kept.
   * `where` is the thread id, else the channel id.
   */
  async findOpenConversation(a: { deptId: string; userId: string; where: string }): Promise<Task | null> {
    return (await this.pool.query<Task>(
      `${SELECT} WHERE conversation AND dept_id = $1 AND thread_id = $2 AND requester @> $3::jsonb AND status NOT IN ('done','cancelled') ORDER BY created_at LIMIT 1`,
      [a.deptId, a.where, JSON.stringify({ kind: 'human', userId: a.userId })],
    )).rows[0] ?? null;
  }

  async findByThread(threadId: string): Promise<Task | null> {
    return (await this.pool.query<Task>(`${SELECT} WHERE thread_id = $1`, [threadId])).rows[0] ?? null;
  }

  /** Direct children of a task, in any status (fan-out cap, Gate 1 D2). */
  async countChildren(parentId: string): Promise<number> {
    return (await this.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM tasks WHERE parent_id = $1', [parentId])).rows[0]!.n;
  }

  /** Direct children not yet finished (everything except done and cancelled). */
  async countOpenChildren(parentId: string): Promise<number> {
    return (await this.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM tasks WHERE parent_id = $1 AND status NOT IN ('done','cancelled')", [parentId])).rows[0]!.n;
  }

  /** The direct child that most recently ended (done or cancelled, by last update); recovery of a roll-up lost on an off day. */
  async lastEndedChild(parentId: string): Promise<Task | null> {
    return (await this.pool.query<Task>(`${SELECT} WHERE parent_id = $1 AND status IN ('done','cancelled') ORDER BY updated_at DESC, id DESC LIMIT 1`, [parentId])).rows[0] ?? null;
  }

  /** Tasks not yet finished: everything except done and cancelled. */
  async countOpen(): Promise<number> {
    return (await this.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM tasks WHERE status NOT IN ('done','cancelled')")).rows[0]!.n;
  }

  /** TW6: root tasks (no parent) that bots created (delegated origin, requester not a person, not started for a person: `source_user_id` is null) since `since`. */
  async countBotRootsSince(since: Date): Promise<number> {
    return (await this.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM tasks WHERE parent_id IS NULL AND origin = 'delegated' AND requester->>'kind' <> 'human' AND source_user_id IS NULL AND created_at >= $1", [since],
    )).rows[0]!.n;
  }

  /** TW13: unfinished tasks (todo, doing, review) with no update since `before`; tasks have no due date, so this is what "overdue" means. */
  async staleOpen(before: Date, limit: number): Promise<{ id: string }[]> {
    return (await this.pool.query<{ id: string }>("SELECT id FROM tasks WHERE status IN ('todo','doing','review') AND updated_at < $1 ORDER BY updated_at LIMIT $2", [before, limit])).rows;
  }

  /**
   * OPS-HOLD: tasks in `review` untouched since `before` whose owner is finished: no open child, no pending approval, no open ASKBACK question (unanswered, unexpired) on it or a descendant, and not in the tree of an active project (a project
   * closes its own tree). Oldest first. The caller still filters conversation roots (they have their own close) and re-checks under the task's lock.
   */
  async staleReview(before: Date, limit: number): Promise<Task[]> {
    return (await this.pool.query<Task>(
      `${SELECT} WHERE status = 'review' AND updated_at < $1
         AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = tasks.id AND c.status NOT IN ('done','cancelled'))
         AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.task_id = tasks.id AND a.status = 'pending')
         AND NOT EXISTS (
           WITH RECURSIVE sub(id) AS (SELECT tasks.id UNION ALL SELECT c.id FROM tasks c JOIN sub ON c.parent_id = sub.id)
           SELECT 1 FROM task_questions q WHERE q.task_id IN (SELECT id FROM sub) AND q.status IN ('pending','asked') AND (q.expires_at IS NULL OR q.expires_at > now()))
         AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.root_task_id = tasks.root_id AND p.status = 'active')
       ORDER BY updated_at, id LIMIT $2`, [before, Math.max(1, Math.floor(limit))],
    )).rows;
  }

  /** OPS-HOLD: review -> done in one conditional statement (still in review, still untouched since `before`, still no open child); null when the task moved meanwhile. */
  async closeStaleReview(id: string, before: Date): Promise<Task | null> {
    const r = await this.pool.query(
      `UPDATE tasks SET status = 'done', blocked_reason = NULL, blocked_note = NULL, updated_at = now()
       WHERE id = $1 AND status = 'review' AND updated_at < $2 AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = tasks.id AND c.status NOT IN ('done','cancelled'))`, [id, before],
    );
    return r.rowCount ? this.get(id) : null;
  }

  /** TW7: the actor's unfinished tasks (id, status, department only; no text), oldest first. HEAL-1 (H6): a blocked task reads `blocked-<reason>` (a closed code word; a NULL reason reads as owner), never the note. */
  async openOf(owner: ActorRef, limit: number): Promise<{ id: string; status: string; deptId: string }[]> {
    return (await this.pool.query<{ id: string; status: string; deptId: string }>(
      `SELECT id, CASE WHEN status = 'blocked' THEN 'blocked-' || COALESCE(blocked_reason, 'owner') ELSE status END AS status, dept_id AS "deptId" FROM tasks WHERE owner @> $1::jsonb AND status IN ('todo','doing','review','blocked') ORDER BY created_at, id LIMIT $2`, [JSON.stringify(owner), limit],
    )).rows;
  }

  /**
   * AUTO-1 (SA-1 3.9, AP-C17): the actor's one open task whose id starts with `prefix` (hex and dashes only, 8 to 35 characters, so no LIKE wildcard can occur).
   * Null for a bad prefix, no match or more than one match. The owner filter stays: a task of someone else is never found.
   */
  async ownByPrefix(owner: ActorRef, prefix: string): Promise<Task | null> {
    if (!/^[0-9a-f-]{8,35}$/.test(prefix)) return null;
    const r = await this.pool.query<Task>(
      `${SELECT} WHERE owner @> $1::jsonb AND id LIKE $2 || '%' AND status NOT IN ('done','cancelled') ORDER BY id LIMIT 2`,
      [JSON.stringify(owner), prefix],
    );
    return r.rows.length === 1 ? r.rows[0]! : null;
  }

  /** Rhythm input (WS10, WS11): open tasks as id, status and department only, no text, oldest first. */
  async openIds(limit: number): Promise<{ id: string; status: string; deptId: string }[]> {
    return (await this.pool.query<{ id: string; status: string; deptId: string }>(
      "SELECT id, status, dept_id AS \"deptId\" FROM tasks WHERE status IN ('todo','doing','review','blocked') ORDER BY created_at, id LIMIT $1", [limit],
    )).rows;
  }

  /** WS10: counts only. Open tasks by status, tasks done today, and pending approvals per origin category (null = no category). */
  async dashboardCounts(): Promise<{ open: number; blocked: number; review: number; doneToday: number; pendingByCategory: { categoryId: string | null; n: number }[] }> {
    const c = (await this.pool.query<{ open: number; blocked: number; review: number; done: number }>(
      `SELECT count(*) FILTER (WHERE status IN ('todo','doing','review','blocked'))::int AS open, count(*) FILTER (WHERE status = 'blocked')::int AS blocked,
              count(*) FILTER (WHERE status = 'review')::int AS review,
              count(*) FILTER (WHERE status = 'done' AND updated_at >= date_trunc('day', now()))::int AS done FROM tasks`,
    )).rows[0]!;
    const p = await this.pool.query<{ categoryId: string | null; n: number }>(
      `SELECT t.origin_category_id AS "categoryId", count(*)::int AS n FROM approvals a JOIN tasks t ON t.id = a.task_id WHERE a.status = 'pending' GROUP BY 1 ORDER BY n DESC LIMIT 25`,
    );
    return { open: c.open, blocked: c.blocked, review: c.review, doneToday: c.done, pendingByCategory: p.rows };
  }

  /** Boot recovery: every `doing` task -> `todo`; returns the moved rows (the caller mirrors them as task.changed). */
  async resetDoingToTodo(): Promise<Task[]> {
    return (await this.pool.query<Task>(`UPDATE tasks SET status = 'todo', updated_at = now() WHERE status = 'doing' RETURNING ${taskCols()}`)).rows;
  }

  /** R35: tasks blocked by a halt -> `todo` (reason cleared) once the company runs again; returns the moved rows. */
  async unblockHalted(): Promise<Task[]> {
    return (await this.pool.query<Task>(
      `UPDATE tasks SET status = 'todo', blocked_reason = NULL, blocked_note = NULL, updated_at = now() WHERE status = 'blocked' AND blocked_reason = 'halt' RETURNING ${taskCols()}`,
    )).rows;
  }
}
