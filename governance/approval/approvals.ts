import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { ActorRef } from '../../company/types.js';
import type { ConfigStore } from '../../config/store.js';
import type { AppEvents, EventBus } from '../../core/events.js';
import { redactText } from '../../core/logger.js';
import type { Pool } from '../../db/pool.js';
import type { Approval } from '../../db/repos/ledger.js';
import { openSubtree, taskCols, type BlockReason, type SubtreeRow, type TaskChange, type TaskRepo, type TaskStatus } from '../../db/repos/tasks.js';
import { actorKey } from '../budget.js';
import { canonicalJson, inputDigest, itemsDigest } from '../canonical.js';
import {
  claimTools, interruptedToolCalls, markToolsDelivered, pendingToolDeliveries, storeToolResult, unclaimTool, type ToolClaim, type ToolDelivery,
} from './tool-claims.js';
import type { AuditFn } from '../audit.js';
import { insertGrant, supersedeAll } from '../../db/repos/web-grants.js';
import { insertTaskGrant, liveGrantOf, supersedeAllTaskGrants } from '../../db/repos/task-grants.js';
import { grantUrlCheck } from '../../tools/plugins/web/grant-url.js';
import type { ToolKind } from '../../tools/policy-approval.js';
import { treeGrantEligible } from '../../tools/tree-grant-scope.js';
import type { Task } from '../../db/repos/tasks.js';

type Cfg = Pick<ConfigStore, 'get'>;
type Queryable = Pick<PoolClient, 'query'>;
type Halting = { isHalted(): boolean };
export type Decision = 'approved' | 'rejected' | 'ask';
/** AI-APPROVE-1: the lock id of the AI approval caps (used nowhere else; a grep test pins it), and the `decided_by` the AI approver writes. */
export const AI_CAP_LOCK = 1095323713;
export const AI_DECIDER = 'ai-approver';
export type DecideAiResult =
  | { ok: true; approval: Approval; tree: number; day: number }
  | { ok: false; error: 'halted' | 'not_pending' | 'expired' | 'not_tool' | 'input_mismatch' | 'cap_tree' | 'cap_day' | 'not_enabled' };
export type DecideResult = { ok: true; approval: Approval } | { ok: false; error: 'not_admin' | 'not_pending' | 'expired' };
/** WEBGRANT-1: the grant a successful decideGrant (or a batch 'approve all and allow web reading') created; the caps are the snapshot stored in its row. */
export type GrantInfo = { id: number; rootId: string; expiresAt: Date; maxFetches: number; maxHosts: number; maxUrlChars: number };
/** `halted_after_commit` (G2W-07): the decision committed, then a halt landed and the grant was revoked: the call IS approved, web reading is not allowed. */
export type GrantError = 'not_grantable' | 'root_ended' | 'halted' | 'halted_after_commit';
export type GrantResult =
  | { ok: true; approval: Approval; grant: GrantInfo }
  | { ok: false; error: 'halted_after_commit'; approval: Approval }
  | { ok: false; error: 'not_admin' | 'not_pending' | 'expired' | Exclude<GrantError, 'halted_after_commit'> };
/**
 * TREEGRANT-1: the task-tree grant a successful decideTaskGrant (or a batch 'approve all + whole task') created; the caps are the snapshot stored in its row.
 * `web` is the companion web grant made on the same click (only when `web.taskGrant.enabled`), `conversation` says the shorter conversation expiry applied.
 */
export type TaskGrantInfo = { id: number; rootId: string; expiresAt: Date; maxCalls: number; conversation: boolean; web: GrantInfo | null };
export type TaskGrantResult =
  | { ok: true; approval: Approval; grant: TaskGrantInfo }
  | { ok: false; error: 'halted_after_commit'; approval: Approval }
  | { ok: false; error: 'not_admin' | 'not_pending' | 'expired' | Exclude<GrantError, 'halted_after_commit'> };
/** TG-C16 / TG-C3: what Approvals needs of the tool side: the registered kind of a tool, and the existing "is this a conversation root" predicate (injected; governance does not import agents). */
export interface TreeScope { kindOf(name: string): ToolKind | undefined; isConversation(root: Task): boolean }
/** What may be shown whole on a card (W-C4): the grant button, and decideGrant, need the url uncut on the card they sit on. Injected, like `batchable`. */
export interface GrantView { solo(a: Approval): boolean; batch(a: Approval): boolean }
/** decideBatch: `decided` in ascending id order; `skipped` rows were not pending (or had expired) and are untouched. `grant` is set only for a grant click that decided at least one row. */
export type BatchDecideResult =
  | { ok: true; decided: Approval[]; skipped: { id: number; why: 'not_pending' | 'expired' }[]; digest: string; taskId: string; grant?: GrantInfo; taskGrant?: TaskGrantInfo }
  | { ok: false; error: 'halted_after_commit'; decided: Approval[]; taskId: string }
  | { ok: false; error: 'not_admin' | 'not_found' | 'stale' | Exclude<GrantError, 'halted_after_commit'> };

/** TASKADMIN-1: the most tasks one cancel confirms (a code constant, not config). */
export const TASK_CANCEL_MAX = 50;
/** TASKADMIN-1 (TA-C6): the digest an admin confirm is bound to: sha256 over the sorted `id:status` lines of the open subtree plus the cascade flag, first 12 hex. */
export function cancelDigest(rows: readonly Pick<SubtreeRow, 'id' | 'status'>[], cascade: boolean): string {
  const lines = rows.map((r) => `${r.id}:${r.status}`).sort();
  return createHash('sha256').update(`${lines.join('\n')}\ncascade=${cascade}`).digest('hex').slice(0, 12);
}
export type AdminCancelResult =
  | { ok: true; ids: string[]; rootId: string; rootEnded: boolean; expired: { id: number; taskId: string; kind: string; toolName: string | null }[]; batches: { id: number; state: 'dissolved' | 'closed'; channelId: string | null; messageId: string | null }[] }
  | { ok: false; error: 'not_found' | 'ended' | 'too_many' | 'too_deep' | 'stale' }
  | { ok: false; error: 'open_children'; open: number };

/** Same fixed day Budget uses for the lifetime per-tree task rows. */
const TASK_DAY = '1970-01-01';
const EPS = 1e-9;
const COLS = `id, task_id AS "taskId", reason, est_cost_usd AS "estCostUsd", requested_by AS "requestedBy",
  status, decided_by AS "decidedBy", created_at AS "createdAt", decided_at AS "decidedAt",
  tool_name AS "toolName", tool_input AS "toolInput", input_sha256 AS "inputSha256", executed_at AS "executedAt", batch_id AS "batchId", ai_review AS "aiReview"`;

function assertEst(est: unknown): asserts est is number {
  if (typeof est !== 'number' || !Number.isFinite(est) || est < 0) throw new Error('estCostUsd must be a finite non-negative number');
}

/** Cap approvals: a waiter of the same tree joins a pending one; the decision releases or blocks the waiters. */
type CapKind = 'tree_cap' | 'local_cap';
const isCapKind = (k: string): k is CapKind => k === 'tree_cap' || k === 'local_cap';
/**
 * The task joined the cap approval(s) `cond` (e.g. `= $1`). A waiter from before migration 005 (no recorded approval)
 * keeps the old rule: any awaiting task of the same tree.
 */
const JOINED = (cond: string) =>
  `(t.awaiting_approval_id ${cond} OR (t.awaiting_approval_id IS NULL AND t.root_id IN (
     SELECT r.root_id FROM approvals x JOIN tasks r ON r.id = x.task_id WHERE x.id ${cond})))`;
/** The task waits on approval `ref` (a SQL param); rows from before migration 005 have no recorded approval. */
const WAITS_ON = (ref: string) => `(t.awaiting_approval_id = ${ref} OR t.awaiting_approval_id IS NULL)`;

export type { ToolClaim, ToolDelivery } from './tool-claims.js';
type ToolCall = { name: string; canonical: string; sha256: string };
/** Every task status change in a transaction is collected here and mirrored as task.changed only after COMMIT. */
type Changes = TaskChange[];

/**
 * Human approval for large spend. Approval and task status changes share one transaction; decide() is a single
 * conditional UPDATE so concurrent admins cannot both win (Gate 1 D15). Approved amounts raise the tree's cap (R16, R33).
 */
/** Shortest literal prefix treated as a cut-off secret at the end of a reason. */
const TAIL_MIN = 6;
/**
 * The literal and pattern pass, plus the cut-off case: reasons are capped upstream (REASON_MAX, the 300-char summary), so a
 * literal can end the text half-written, where an exact match cannot find it. A tail that is a prefix of a literal is masked too.
 */
export function maskReason(reason: string, secrets: readonly string[]): string {
  const s = redactText(reason, secrets);
  for (const lit of secrets) {
    for (let k = Math.min(lit.length - 1, s.length); k >= TAIL_MIN; k--) {
      if (s.endsWith(lit.slice(0, k))) return `${s.slice(0, s.length - k)}[REDACTED]`;
    }
  }
  return s;
}

export class Approvals {
  constructor(
    private readonly pool: Pool,
    private readonly tasks: Pick<TaskRepo, 'get'>,
    private readonly cfg: Cfg,
    private readonly bus: EventBus<AppEvents>,
    private readonly halt: Halting,
    private readonly audit: AuditFn,
    /** The literal secret list (shared, may grow); every stored reason is masked with it and the generic patterns. */
    private readonly secrets: readonly string[] = [],
    /** B7: whether a tool may be decided in a batch (the caller passes the ApprovalRooms predicate, never a copy of SENSITIVE_TOOL). Absent: decideBatch refuses. */
    private readonly batchable?: (toolName: string) => boolean,
    /** WEBGRANT-1 (W-C4): whether the stored url is shown whole on the solo card / the batch card. Absent: decideGrant refuses (fail closed). */
    private readonly grantView?: GrantView,
    /** TREEGRANT-1 (TG-C3): the tool-side facts the task-grant decision needs. Absent: decideTaskGrant refuses (fail closed). */
    private readonly treeScope?: TreeScope,
  ) {}

  needsApproval(estUsd: number): boolean {
    return !Number.isFinite(estUsd) || estUsd > this.cfg.get('approval.thresholdUsd'); // fail closed
  }

  /**
   * Spend cap of the tree rooted at rootId (never decreases): the larger of the highest approved tree cap (R18) and
   * budget.taskUsd plus every approved estimate in the tree (R33: a large task is approved once, not again at $0.50).
   */
  async treeCap(rootId: string, db: Queryable = this.pool): Promise<number> {
    const r = await db.query<{ cap: number | null; est: number }>(
      `SELECT max(a.est_cost_usd) FILTER (WHERE a.kind = 'tree_cap') AS cap,
              coalesce(sum(a.est_cost_usd) FILTER (WHERE a.kind = 'estimate'), 0) AS est
       FROM approvals a JOIN tasks t ON t.id = a.task_id
       WHERE t.root_id = $1 AND a.status = 'approved'`,
      [rootId],
    );
    const row = r.rows[0];
    const base = this.cfg.get('budget.taskUsd') + Number(row?.est ?? 0);
    return Math.max(row?.cap ?? 0, base);
  }

  /**
   * Asks for approval. A `kind: 'tool'` request stores the validated call (R4): `tool.input` as canonical JSON and its
   * sha256, so the approver approves exactly what later runs. Both are computed here, from the value the registry validated.
   */
  async request(r: {
    taskId: string; reason: string; estCostUsd: number; requestedBy: ActorRef;
    kind?: 'estimate' | 'tool'; tool?: { name: string; input: unknown };
  }): Promise<Approval> {
    assertEst(r.estCostUsd);
    let call: ToolCall | undefined;
    if (r.kind === 'tool' || r.tool) {
      if (r.kind !== 'tool' || !r.tool || r.tool.name === '') throw new Error('a tool approval needs kind "tool" and a tool name');
      const canonical = canonicalJson(r.tool.input);
      call = { name: r.tool.name, canonical, sha256: inputDigest(canonical) };
    }
    const changes: Changes = [];
    const a = await this.inTx(async (c) => {
      const ins = await this.insert(c, r.taskId, maskReason(r.reason, this.secrets), r.estCostUsd, actorKey(r.requestedBy), call ? 'tool' : 'estimate', null, call);
      const t = await move(c, changes, 'awaiting_approval', "t.id = $1 AND t.status NOT IN ('done','cancelled')", [r.taskId], null, ins.id);
      if (!t) throw new Error(`task ${r.taskId} not found or already finished`); // rolls the insert back
      return ins;
    });
    await this.emitChanges(changes);
    await this.bus.emit('approval.requested', a);
    return a;
  }

  /**
   * Claims the decided, unclaimed tool approvals of `taskId` (R4/P3) in approval order: one conditional UPDATE sets
   * executed_at, so a digest runs at most once even under concurrent claimers. Approved rows come back as `run`; rejected,
   * expired and tampered rows (input no longer hashes to input_sha256; audited) as `refused`. Nothing is claimed while
   * halted (D9; rows stay claimable after /resume).
   */
  async claimToolOutcomes(taskId: string): Promise<ToolClaim[]> {
    if (this.halt.isHalted()) return [];
    return claimTools(this.pool, taskId, this.audit);
  }

  /** Gives back a `run` claim that /halt refused before it ran (R4 contract a); see tool-claims.unclaimTool. */
  unclaimTool(c: ToolClaim): Promise<boolean> {
    return unclaimTool(this.pool, c);
  }

  /** Stores the (redacted, capped) outcome of a claimed call; it stays pending until the owner's model turn sees it. */
  storeToolResult(c: Pick<ToolClaim, 'approvalId' | 'claimedAt'>, text: string): Promise<boolean> {
    return storeToolResult(this.pool, c, text);
  }

  pendingToolDeliveries(taskId: string): Promise<ToolDelivery[]> {
    return pendingToolDeliveries(this.pool, taskId);
  }

  markToolsDelivered(ids: number[]): Promise<void> {
    return markToolsDelivered(this.pool, ids);
  }

  interruptedToolCalls(): Promise<{ approvalId: number; taskId: string; name: string }[]> {
    return interruptedToolCalls(this.pool);
  }

  /**
   * Local call cap of the tree rooted at rootId (Gate 1 L8; never decreases, like R18): the larger of the highest
   * approved local cap and `limits.localCallsPerTask`.
   */
  async localCap(rootId: string, db: Queryable = this.pool): Promise<number> {
    const r = await db.query<{ cap: number | null }>(
      `SELECT max(a.cap_calls) AS cap FROM approvals a JOIN tasks t ON t.id = a.task_id
       WHERE t.root_id = $1 AND a.status = 'approved' AND a.kind = 'local_cap'`,
      [rootId],
    );
    return Math.max(r.rows[0]?.cap ?? 0, this.cfg.get('limits.localCallsPerTask'));
  }

  /**
   * Budget refused with scope 'task' for `taskId` (default: the root): ask for a new tree cap
   * max(spent+reserved+est, currentCap + threshold). The approval attaches to the requesting task; the root is untouched (R19).
   * Returns the existing pending tree-cap approval if any, or null (requester blocked) when the root is finished
   * or the newest decided tree-cap request was rejected or expired.
   */
  async onTreeCapHit(r: { rootId: string; taskId?: string; est: number; requestedBy: ActorRef }): Promise<Approval | null> {
    assertEst(r.est);
    return this.capHit('tree_cap', r, async (c) => {
      const row = await c.query<{ used: number }>(
        "SELECT spent_usd + reserved_usd AS used FROM budget_days WHERE day = $1 AND scope = 'task' AND scope_id = $2",
        [TASK_DAY, r.rootId],
      );
      const used = row.rows[0]?.used ?? 0;
      const cap = await this.treeCap(r.rootId, c);
      const newCap = Math.ceil(Math.max(used + r.est, cap + this.cfg.get('approval.thresholdUsd')) * 1e6 - EPS) / 1e6;
      return { reason: `tree spend reached cap ${cap.toFixed(2)} USD`, est: newCap, capCalls: null };
    });
  }

  /**
   * Budget refused with scope 'local_task' (Gate 1 L8): the tree used its claude-code-local call cap. Same flow as
   * onTreeCapHit (waiters, rejection blocks), with its own approval kind; approval raises the cap by
   * `limits.localCallsPerTask` calls above the larger of the current cap and the calls already used.
   */
  async onLocalCapHit(r: { rootId: string; taskId?: string; requestedBy: ActorRef }): Promise<Approval | null> {
    return this.capHit('local_cap', r, async (c) => {
      const row = await c.query<{ calls: number }>("SELECT calls FROM budget_days WHERE day = $1 AND scope = 'task' AND scope_id = $2", [TASK_DAY, r.rootId]);
      const cap = await this.localCap(r.rootId, c);
      const newCap = Math.max(cap, row.rows[0]?.calls ?? 0) + this.cfg.get('limits.localCallsPerTask');
      return { reason: `local call cap reached ${cap} calls; approve to raise it to ${newCap}`, est: null, capCalls: newCap };
    });
  }

  /** Shared cap-hit flow; pending and decided lookups are per kind, so a USD cap request never absorbs a call-cap hit. */
  private async capHit(
    kind: CapKind,
    r: { rootId: string; taskId?: string; requestedBy: ActorRef },
    next: (c: PoolClient) => Promise<{ reason: string; est: number | null; capCalls: number | null }>,
  ): Promise<Approval | null> {
    const taskId = r.taskId ?? r.rootId;
    const changes: Changes = [];
    const { approval, created } = await this.inTx(async (c) => {
      const root = await c.query<{ status: string }>('SELECT status FROM tasks WHERE id = $1 FOR UPDATE', [r.rootId]); // serialises concurrent hits
      if (!root.rows[0]) throw new Error(`task ${r.rootId} not found`);
      const live = "t.id = $1 AND t.status NOT IN ('done','cancelled')";
      const block = () => move(c, changes, 'blocked', live, [taskId], 'budget');
      if (root.rows[0].status === 'done' || root.rows[0].status === 'cancelled') {
        await block();
        return { approval: null, created: false };
      }
      const open = await c.query<Approval>(
        `SELECT ${COLS} FROM approvals WHERE kind = $2 AND status = 'pending' AND task_id IN (SELECT id FROM tasks WHERE root_id = $1) ORDER BY id LIMIT 1 FOR UPDATE`,
        [r.rootId, kind],
      );
      if (open.rows[0]) {
        // Another task of this tree already asked: this one waits on the same approval (R20), and only on it.
        await move(c, changes, 'awaiting_approval', live, [taskId], null, open.rows[0].id);
        return { approval: open.rows[0], created: false };
      }
      const last = await c.query<{ status: string }>(
        `SELECT status FROM approvals WHERE kind = $2 AND status <> 'pending' AND task_id IN (SELECT id FROM tasks WHERE root_id = $1)
         ORDER BY decided_at DESC, id DESC LIMIT 1`,
        [r.rootId, kind],
      );
      if (last.rows[0] && last.rows[0].status !== 'approved') {
        await block();
        return { approval: null, created: false };
      }
      const n = await next(c);
      const a = await this.insert(c, taskId, n.reason, n.est, actorKey(r.requestedBy), kind, n.capCalls);
      if (!(await move(c, changes, 'awaiting_approval', live, [taskId], null, a.id))) throw new Error(`task ${taskId} not found or already finished`);
      return { approval: a, created: true };
    });
    await this.emitChanges(changes);
    if (created && approval) await this.bus.emit('approval.requested', approval);
    return approval;
  }

  async decide(id: number, decision: Decision, user: { id: string; isAdmin: boolean }): Promise<DecideResult> {
    if (!user.isAdmin) return { ok: false, error: 'not_admin' };
    const hours = this.cfg.get('approval.expiryHours');
    if (decision === 'ask') {
      const r = await this.pool.query<Approval & { live: boolean }>(
        `SELECT ${COLS}, created_at + $2 * interval '1 hour' > now() AS live FROM approvals WHERE id = $1`,
        [id, hours],
      );
      const a = r.rows[0];
      if (!a || a.status !== 'pending') return { ok: false, error: 'not_pending' };
      return a.live ? { ok: true, approval: a } : { ok: false, error: 'expired' };
    }
    const halted = this.halt.isHalted();
    const changes: Changes = [];
    const res = await this.inTx(async (c) => {
      // Lock order root -> approval -> tasks, same as onTreeCapHit, so a waiter cannot enrol after the decision commits.
      await c.query(
        'SELECT id FROM tasks WHERE id = (SELECT t.root_id FROM approvals a JOIN tasks t ON t.id = a.task_id WHERE a.id = $1) FOR UPDATE',
        [id],
      );
      return this.decideRow(c, id, decision, user.id, hours, halted, changes);
    });
    if (!res.ok) return res;
    await this.emitChanges(changes);
    return { ok: true, approval: res.approval };
  }

  /**
   * AI-APPROVE-1 (SA-1 5, AA-C11/C14): the AI approver's decision. Lock order root -> AI_CAP_LOCK -> approval row. Both counts are read
   * inside the transaction, after the lock, and the two audit rows (the cap claim and the approve line) are THROWING inserts on the
   * transaction client, so a swallowed write can never undercount a cap and a failed one rolls the approve back. Only AiApprover calls this.
   * `stillOn` is the enabled/pause re-check (AA-C14): a throw or false counts as off. It gets the transaction client and must read through it:
   * a read through the pool needs a second connection while this tx holds the root row and AI_CAP_LOCK, which deadlocks the pool at N = pool max (G2-01).
   */
  async decideAi(id: number, r: { sha: string; reason: string; maxPerTree: number; maxPerDay: number; tz: string; stillOn: (q: Queryable) => Promise<boolean> }): Promise<DecideAiResult> {
    if (this.halt.isHalted()) return { ok: false, error: 'halted' };
    const hours = this.cfg.get('approval.expiryHours');
    const changes: Changes = [];
    const res = await this.inTx(async (c): Promise<DecideAiResult> => {
      await c.query('SELECT id FROM tasks WHERE id = (SELECT t.root_id FROM approvals a JOIN tasks t ON t.id = a.task_id WHERE a.id = $1) FOR UPDATE', [id]);
      await c.query('SELECT pg_advisory_xact_lock($1)', [AI_CAP_LOCK]);
      const cur = await c.query<Approval & { kind: string; live: boolean; rootId: string | null }>(
        `SELECT ${COLS}, kind, created_at + $2 * interval '1 hour' > now() AS live, (SELECT root_id FROM tasks WHERE id = task_id) AS "rootId" FROM approvals WHERE id = $1 FOR UPDATE`, [id, hours]);
      const a = cur.rows[0];
      if (!a || a.status !== 'pending') return { ok: false, error: 'not_pending' };
      if (!a.live) return { ok: false, error: 'expired' };
      if (a.kind !== 'tool' || a.batchId != null) return { ok: false, error: 'not_tool' };
      if (a.inputSha256 !== r.sha) return { ok: false, error: 'input_mismatch' };
      const tree = (await c.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM audit_log l JOIN tasks t ON t.id = l.task_id WHERE l.action = 'approval.ai.approve' AND t.root_id = $1", [a.rootId])).rows[0]!.n;
      const day = (await c.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM audit_log WHERE action = 'approval.ai.approve' AND ts >= (date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1)", [r.tz])).rows[0]!.n;
      if (tree >= r.maxPerTree) return { ok: false, error: 'cap_tree' };
      if (day >= r.maxPerDay) return { ok: false, error: 'cap_day' };
      let on = false;
      try { on = await r.stillOn(c); } catch { on = false; }
      if (!on) return { ok: false, error: 'not_enabled' };
      if (this.halt.isHalted()) return { ok: false, error: 'halted' }; // last check before anything is written
      const tool = a.toolName ?? null;
      await c.query(
        'INSERT INTO audit_log (actor, action, task_id, tool, outcome) VALUES ($1,$2,$3,$4,$5)',
        ['system:ai-approver', 'approval.ai.approve', a.taskId, tool, redactText(`#${id} ${r.reason}`, this.secrets).slice(0, 200)]);
      await c.query(
        'INSERT INTO audit_log (actor, action, task_id, tool, outcome) VALUES ($1,$2,$3,$4,$5)',
        ['user:ai-approver', 'approval.approve', a.taskId, tool, `ok #${id}`]);
      const d = await this.decideRow(c, id, 'approved', AI_DECIDER, hours, false, changes);
      if (!d.ok) throw new Error('decideAi: decideRow refused after the row lock'); // rolls everything back
      return { ok: true, approval: d.approval, tree: tree + 1, day: day + 1 };
    });
    if (!res.ok) return res;
    await this.emitChanges(changes);
    return res;
  }

  /** WEBGRANT-1 (D4): the snapshot of the config caps, with maxHosts clamped to maxFetches (the startup check refuses the reverse; a live edit cannot widen it). */
  private grantCaps() {
    const maxFetches = this.cfg.get('web.taskGrant.maxFetches');
    return { hours: this.cfg.get('web.taskGrant.hours'), maxFetches, maxHosts: Math.min(this.cfg.get('web.taskGrant.maxHosts'), maxFetches), maxUrlChars: this.cfg.get('web.taskGrant.maxUrlChars') };
  }

  private grantEnabled(): boolean {
    try { return this.cfg.get('web.taskGrant.enabled') === true; } catch { return false; }
  }

  /**
   * W4/W-C4/W-C6: whether a stored approval may carry a web grant, recomputed from the stored call: a pending-or-not `fetch_page` tool row
   * whose input still hashes to input_sha256, whose url passes grantUrlCheck, and whose url the card shows whole (injected predicate).
   */
  private grantable(a: Approval & { kind?: string }, mode: 'solo' | 'batch'): boolean {
    if (a.kind !== 'tool' || a.toolName !== 'fetch_page' || !a.inputSha256) return false;
    const input = a.toolInput;
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof (input as { url?: unknown }).url !== 'string') return false;
    let sha: string;
    try { sha = inputDigest(canonicalJson(input)); } catch { return false; }
    if (sha !== a.inputSha256) return false;
    if (!grantUrlCheck((input as { url: string }).url).ok) return false;
    return this.grantView?.[mode](a) === true;
  }

  /** D6/W-C8: inside the decision transaction, after the root lock: supersede every unrevoked grant of the tree, then insert the new one. */
  private async makeGrant(c: PoolClient, rootId: string, approvalId: number, userId: string, requestedBy: string, cardMessageId: string | null): Promise<GrantInfo> {
    const caps = this.grantCaps();
    await supersedeAll(c, rootId, userId);
    const g = await insertGrant(c, { rootId, approvalId, grantedBy: userId, requestedBy, cardMessageId, ...caps });
    return { id: Number(g.id), rootId, expiresAt: g.expiresAt, maxFetches: g.maxFetches, maxHosts: g.maxHosts, maxUrlChars: g.maxUrlChars };
  }

  /** G2W-02: a halt that landed after the last in-transaction check but before COMMIT: the committed grant is revoked at once (the revoke hook could not see the uncommitted row). */
  private async haltedAfterCommit(grantId: number): Promise<boolean> {
    if (!this.halt.isHalted()) return false;
    await this.pool.query("UPDATE web_grants SET revoked_at = now(), revoked_by = 'system', revoke_reason = 'halt' WHERE id = $1 AND revoked_at IS NULL", [grantId]);
    return true;
  }

  /**
   * WEBGRANT-1 (D6): approve one `fetch_page` approval AND allow web reading for its task tree, in one transaction (lock order root ->
   * approval). The approval is decided exactly as decide() does (the url replays through runApproved, which never consumes the grant).
   * Refused with nothing changed when halted (W-C3b), when the feature is off, or when the stored row does not qualify (`not_grantable`):
   * the card then stays pending and can still be decided with Approve or Reject.
   */
  async decideGrant(id: number, user: { id: string; isAdmin: boolean }, opts: { messageId?: string } = {}): Promise<GrantResult> {
    if (!user.isAdmin) return { ok: false, error: 'not_admin' };
    if (this.halt.isHalted()) return { ok: false, error: 'halted' };
    const hours = this.cfg.get('approval.expiryHours');
    const changes: Changes = [];
    const res = await this.inTx(async (c): Promise<GrantResult> => {
      const root = await c.query<{ id: string; status: string }>(
        `SELECT r.id, r.status FROM tasks r WHERE r.id = (SELECT t.root_id FROM approvals a JOIN tasks t ON t.id = a.task_id WHERE a.id = $1) FOR UPDATE`, [id]);
      const cur = await c.query<Approval & { kind: string; live: boolean }>(
        `SELECT ${COLS}, kind, created_at + $2 * interval '1 hour' > now() AS live FROM approvals WHERE id = $1 FOR UPDATE`, [id, hours]);
      const a = cur.rows[0];
      // G2W-03: the clicked message is the grant's card; on a batch member it must be that batch's card (or the batch has none recorded yet)
      let card: string | null = opts.messageId ?? null;
      if (a?.batchId != null) {
        const b = await c.query<{ message_id: string | null }>('SELECT message_id FROM approval_batches WHERE id = $1', [a.batchId]);
        if (b.rows[0]?.message_id != null && b.rows[0].message_id !== card) card = null;
      }
      if (!a || !root.rows[0]) return { ok: false, error: 'not_pending' };
      if (a.status !== 'pending') return { ok: false, error: 'not_pending' };
      if (!a.live) return { ok: false, error: 'expired' };
      if (!this.grantEnabled() || !this.grantable(a, 'solo')) return { ok: false, error: 'not_grantable' };
      if (['done', 'cancelled'].includes(root.rows[0].status)) return { ok: false, error: 'root_ended' };
      if (this.halt.isHalted()) return { ok: false, error: 'halted' }; // last check before anything is written (W-C3b)
      const d = await this.decideRow(c, id, 'approved', user.id, hours, false, changes);
      if (!d.ok) return d;
      const grant = await this.makeGrant(c, root.rows[0].id, id, user.id, d.approval.requestedBy, card);
      return { ok: true, approval: d.approval, grant };
    });
    if (!res.ok) return res;
    await this.emitChanges(changes);
    if (await this.haltedAfterCommit(res.grant.id)) return { ok: false, error: 'halted_after_commit', approval: res.approval };
    return res;
  }

  private taskGrantEnabled(): boolean {
    try { return this.cfg.get('taskGrant.enabled') === true; } catch { return false; }
  }

  /** TG-C3: the ONE stored-input predicate (shared with the card renderers through tools/tree-grant-scope). */
  private treeEligible(a: Approval & { kind?: string }): boolean {
    return this.treeScope !== undefined && treeGrantEligible(a, (n) => this.treeScope!.kindOf(n));
  }

  /** TG-C16: hours of the new grant, computed in config here and applied on the DB clock; a conversation root gets the shorter of the two. */
  private taskCaps(root: Task): { hours: number; maxCalls: number; conversation: boolean } {
    const hours = this.cfg.get('taskGrant.hours');
    const conversation = this.treeScope?.isConversation(root) === true;
    return { hours: conversation ? Math.min(hours, this.cfg.get('taskGrant.conversationHours')) : hours, maxCalls: this.cfg.get('taskGrant.maxCalls'), conversation };
  }

  /**
   * Inside the decision transaction, after the root lock and after the approvals were decided: supersede every non-live unrevoked row, make the
   * companion web grant when it is on (no card id of its own: TG-C10), then insert the task grant.
   */
  private async makeTaskGrant(c: PoolClient, root: Task, approvalId: number, userId: string, requestedBy: string, card: { messageId: string | null; channelId: string | null }): Promise<TaskGrantInfo> {
    const caps = this.taskCaps(root);
    await supersedeAllTaskGrants(c, root.id, userId);
    const web = this.grantEnabled() ? await this.makeGrant(c, root.id, approvalId, userId, requestedBy, null) : null;
    const g = await insertTaskGrant(c, { rootId: root.id, approvalId, grantedBy: userId, requestedBy, maxCalls: caps.maxCalls, hours: caps.hours, webGrantId: web?.id ?? null, cardMessageId: card.messageId, cardChannelId: card.channelId });
    return { id: Number(g.id), rootId: root.id, expiresAt: g.expiresAt, maxCalls: g.maxCalls, conversation: caps.conversation, web };
  }

  /** TG-C12: the same live predicate as the card render and consume (unrevoked, unexpired, under the cap, root open); a live grant refuses a second one. */
  private async hasLiveTaskGrant(c: PoolClient, rootId: string): Promise<boolean> {
    return (await liveGrantOf(c, rootId)) !== null;
  }

  /** A halt that landed after the last in-transaction check but before COMMIT: the committed task grant and its companion are revoked at once (twin of haltedAfterCommit). */
  private async haltedAfterCommitTask(g: TaskGrantInfo): Promise<boolean> {
    if (!this.halt.isHalted()) return false;
    await this.pool.query("UPDATE task_grants SET revoked_at = now(), revoked_by = 'system', revoke_reason = 'halt' WHERE id = $1 AND revoked_at IS NULL", [g.id]);
    if (g.web) await this.pool.query("UPDATE web_grants SET revoked_at = now(), revoked_by = 'system', revoke_reason = 'halt' WHERE id = $1 AND revoked_at IS NULL", [g.web.id]).catch(() => undefined);
    return true;
  }

  /**
   * TREEGRANT-1 (spec 3.3): approve one covered tool approval AND grant the whole task tree, in one transaction (lock order root -> approval). The card's own call is
   * approved exactly as decide() does (it replays through runApproved, which never consumes). Refused with nothing changed when halted (before and last in the
   * transaction), when the feature is off, when the stored row does not qualify, when the tree already has a live grant (TG-C12) or its root ended.
   */
  async decideTaskGrant(id: number, user: { id: string; isAdmin: boolean }, opts: { messageId?: string; channelId?: string } = {}): Promise<TaskGrantResult> {
    if (!user.isAdmin) return { ok: false, error: 'not_admin' };
    if (this.halt.isHalted()) return { ok: false, error: 'halted' };
    const hours = this.cfg.get('approval.expiryHours');
    const changes: Changes = [];
    const res = await this.inTx(async (c): Promise<TaskGrantResult> => {
      const root = await c.query<Task>(
        `SELECT ${taskCols('r.')} FROM tasks r WHERE r.id = (SELECT t.root_id FROM approvals a JOIN tasks t ON t.id = a.task_id WHERE a.id = $1) FOR UPDATE`, [id]);
      const cur = await c.query<Approval & { kind: string; live: boolean }>(
        `SELECT ${COLS}, kind, created_at + $2 * interval '1 hour' > now() AS live FROM approvals WHERE id = $1 FOR UPDATE`, [id, hours]);
      const a = cur.rows[0];
      const r0 = root.rows[0];
      if (!a || !r0) return { ok: false, error: 'not_pending' };
      if (a.status !== 'pending') return { ok: false, error: 'not_pending' };
      if (!a.live) return { ok: false, error: 'expired' };
      // G2W-03 twin: on a batch member the clicked message must be that batch's card; otherwise the grant records no card
      let card: string | null = opts.messageId ?? null;
      if (a.batchId != null) {
        const b = await c.query<{ message_id: string | null }>('SELECT message_id FROM approval_batches WHERE id = $1', [a.batchId]);
        if (b.rows[0]?.message_id != null && b.rows[0].message_id !== card) card = null;
      }
      if (!this.taskGrantEnabled() || !this.treeEligible(a)) return { ok: false, error: 'not_grantable' };
      if (['done', 'cancelled'].includes(r0.status)) return { ok: false, error: 'root_ended' };
      if (await this.hasLiveTaskGrant(c, r0.id)) return { ok: false, error: 'not_grantable' };
      if (this.halt.isHalted()) return { ok: false, error: 'halted' }; // last check before anything is written
      const d = await this.decideRow(c, id, 'approved', user.id, hours, false, changes);
      if (!d.ok) return d;
      const grant = await this.makeTaskGrant(c, r0, id, user.id, d.approval.requestedBy, { messageId: card, channelId: card ? opts.channelId ?? null : null });
      return { ok: true, approval: d.approval, grant };
    });
    if (!res.ok) return res;
    await this.emitChanges(changes);
    if (await this.haltedAfterCommitTask(res.grant)) return { ok: false, error: 'halted_after_commit', approval: res.approval };
    return res;
  }

  /**
   * The body of one decision (the root is already locked by the caller): one conditional UPDATE on a pending, unexpired row, then
   * the task move (only the row the task waits on moves it) and the cap-waiter release or block.
   */
  private async decideRow(
    c: PoolClient, id: number, status: 'approved' | 'rejected', userId: string, hours: number, halted: boolean, changes: Changes,
  ): Promise<{ ok: true; approval: Approval } | { ok: false; error: 'not_pending' | 'expired' }> {
    const u = await c.query<Approval & { kind: string }>(
      `UPDATE approvals SET status = $2, decided_by = $3, decided_at = now()
       WHERE id = $1 AND status = 'pending' AND created_at + $4 * interval '1 hour' > now()
       RETURNING ${COLS}, kind`,
      [id, status, userId, hours],
    );
    if (!u.rows[0]) {
      const cur = await c.query<{ status: string }>('SELECT status FROM approvals WHERE id = $1', [id]);
      return { ok: false as const, error: cur.rows[0]?.status === 'pending' ? ('expired' as const) : ('not_pending' as const) };
    }
    const { kind, ...a } = u.rows[0];
    const isCap = isCapKind(kind);
    if (status === 'rejected') {
      await move(c, changes, 'cancelled', `t.id = $1 AND t.status = 'awaiting_approval' AND ${WAITS_ON('$2')}`, [a.taskId, a.id]);
      if (isCap) await this.blockWaiters(c, changes, [a.id]);
    } else if (!halted) {
      // While halted the tasks stay awaiting_approval; resumeApproved() releases them (Gate 1 D9).
      await move(c, changes, 'todo', `t.id = $1 AND t.status = 'awaiting_approval' AND ${WAITS_ON('$2')}`, [a.taskId, a.id]);
      if (isCap) await this.releaseWaiters(c, changes, a.id);
    }
    return { ok: true as const, approval: a };
  }

  /**
   * Approve all / Deny all of a posted batch card in ONE transaction (B5, B6). Lock order root -> batch -> members (ascending id).
   * Refused as `stale` unless the stored digest, the digest recomputed from the members now and the digest on the clicked card agree,
   * or when any member is no longer a non-sensitive tool approval of the batch's task. Members that are not pending (or expired by the
   * DB clock) are skipped and reported; an expired row stays pending for expireOld, exactly as decide() leaves it.
   */
  async decideBatch(
    batchId: number, digest: string, decision: 'approved' | 'rejected', user: { id: string; isAdmin: boolean },
    /** WEBGRANT-1: approve all AND allow web reading for the task tree; only with decision 'approved'. */
    opts: { grant?: boolean; /** TREEGRANT-1 (TG-C13): approve all AND grant the whole task tree; never together with `grant`. */ task?: boolean; /** G2W-03: the clicked card message, recorded as the grant's card when it is this batch's card. */ messageId?: string; channelId?: string } = {},
  ): Promise<BatchDecideResult> {
    if (!user.isAdmin) return { ok: false, error: 'not_admin' };
    const wantGrant = opts.grant === true;
    const wantTask = opts.task === true;
    if (wantGrant && wantTask) return { ok: false, error: 'not_found' }; // exclusive (TG-C13)
    if ((wantGrant || wantTask) && decision !== 'approved') return { ok: false, error: 'not_found' };
    if ((wantGrant || wantTask) && this.halt.isHalted()) return { ok: false, error: 'halted' }; // W-C3b: nothing is decided, plain Approve all stays available
    if (!Number.isSafeInteger(batchId) || batchId < 1 || !/^[0-9a-f]{12}$/.test(digest) || !this.batchable) return { ok: false, error: 'not_found' };
    const batchable = this.batchable;
    const hours = this.cfg.get('approval.expiryHours');
    const halted = this.halt.isHalted();
    const changes: Changes = [];
    const res = await this.inTx(async (c): Promise<BatchDecideResult> => {
      await c.query(
        'SELECT id FROM tasks WHERE id = (SELECT t.root_id FROM approval_batches b JOIN tasks t ON t.id = b.task_id WHERE b.id = $1) FOR UPDATE',
        [batchId],
      );
      const b = await c.query<{ state: string; digest: string | null; taskId: string; messageId: string | null }>(
        'SELECT state, items_digest AS digest, task_id AS "taskId", message_id AS "messageId" FROM approval_batches WHERE id = $1 FOR UPDATE',
        [batchId],
      );
      const batch = b.rows[0];
      if (!batch) return { ok: false, error: 'not_found' };
      if ((batch.state !== 'posted' && batch.state !== 'closed') || batch.digest !== digest) return { ok: false, error: 'stale' };
      // G2AB-03: FOR UPDATE only on the pending members, ascending (claimTools never touches pending rows, so the two cannot deadlock).
      // Then a plain read of every member for the digest, AFTER the locks: its READ COMMITTED snapshot is taken now, so the rows that
      // will be decided are exactly the locked rows the digest was computed from.
      await c.query("SELECT id FROM approvals WHERE batch_id = $1 AND status = 'pending' ORDER BY id FOR UPDATE", [batchId]);
      const m = await c.query<Approval & { kind: string }>(
        `SELECT ${COLS}, kind FROM approvals WHERE batch_id = $1 ORDER BY id`, [batchId],
      );
      const members = m.rows;
      if (!members.length || itemsDigest(members.map((x) => ({ id: x.id, inputSha256: x.inputSha256 ?? '' }))) !== digest) return { ok: false, error: 'stale' };
      // B6: re-checked at decision time; anything else refuses the whole click.
      if (members.some((x) => x.kind !== 'tool' || !x.toolName || !batchable(x.toolName) || x.taskId !== batch.taskId)) return { ok: false, error: 'stale' };
      let rootId = '';
      let taskRoot: Task | null = null;
      if (wantTask) {
        // TG-C13: every solo check plus B5/B6 above and TG-C3 for every member; any member that fails refuses the whole click and decides nothing.
        if (!this.taskGrantEnabled() || members.some((x) => !this.treeEligible(x))) return { ok: false, error: 'not_grantable' };
        const root = await c.query<Task>(`SELECT ${taskCols('r.')} FROM tasks t JOIN tasks r ON r.id = t.root_id WHERE t.id = $1`, [batch.taskId]);
        const r0 = root.rows[0];
        if (!r0 || ['done', 'cancelled'].includes(r0.status)) return { ok: false, error: 'root_ended' };
        if (await this.hasLiveTaskGrant(c, r0.id)) return { ok: false, error: 'not_grantable' }; // TG-C12
        taskRoot = r0;
        if (this.halt.isHalted()) return { ok: false, error: 'halted' };
      }
      if (wantGrant) {
        // D6/B6: every member is re-checked from its stored input; any member that does not qualify refuses the whole click, deciding nothing.
        if (!this.grantEnabled() || members.some((x) => !this.grantable(x, 'batch'))) return { ok: false, error: 'not_grantable' };
        const root = await c.query<{ id: string; status: string }>(
          'SELECT r.id, r.status FROM tasks t JOIN tasks r ON r.id = t.root_id WHERE t.id = $1', [batch.taskId]);
        if (!root.rows[0] || ['done', 'cancelled'].includes(root.rows[0].status)) return { ok: false, error: 'root_ended' };
        rootId = root.rows[0].id;
        if (this.halt.isHalted()) return { ok: false, error: 'halted' }; // last check before anything is written (W-C3b)
      }
      const decided: Approval[] = [];
      const skipped: { id: number; why: 'not_pending' | 'expired' }[] = [];
      for (const row of members) {
        const r = await this.decideRow(c, row.id, decision, user.id, hours, halted, changes);
        if (r.ok) decided.push(r.approval);
        else skipped.push({ id: row.id, why: r.error });
      }
      if (wantTask && taskRoot && decided.length > 0) {
        const own = batch.messageId === null || batch.messageId === opts.messageId ? opts.messageId ?? null : null; // G2W-03: the batch's own message
        const taskGrant = await this.makeTaskGrant(c, taskRoot, decided[0]!.id, user.id, decided[0]!.requestedBy, { messageId: own, channelId: own ? opts.channelId ?? null : null });
        return { ok: true, decided, skipped, digest, taskId: batch.taskId, taskGrant };
      }
      if (wantGrant && decided.length > 0) {
        const grant = await this.makeGrant(c, rootId, decided[0]!.id, user.id, decided[0]!.requestedBy, batch.messageId === null || batch.messageId === opts.messageId ? opts.messageId ?? null : null);
        return { ok: true, decided, skipped, digest, taskId: batch.taskId, grant };
      }
      return { ok: true, decided, skipped, digest, taskId: batch.taskId };
    });
    if (!res.ok) return res;
    await this.emitChanges(changes);
    if (res.grant && (await this.haltedAfterCommit(res.grant.id))) return { ok: false, error: 'halted_after_commit', decided: res.decided, taskId: res.taskId };
    if (res.taskGrant && (await this.haltedAfterCommitTask(res.taskGrant))) return { ok: false, error: 'halted_after_commit', decided: res.decided, taskId: res.taskId };
    return res;
  }

  /**
   * TASKADMIN-1: a Bot Admin cancels `target` (and, with `cascade`, every open task under it) in ONE transaction. Lock order (TA-C6): root, the subtree walk,
   * the rows of S `ORDER BY id`, the walk again (set and digest must still match the admin's confirm, else `stale`), the batches of S, the pending approvals
   * of S (expired), S -> cancelled, the waiters of expired cap approvals outside S -> blocked, then the batches. The S row locks also hold off new child inserts
   * (FK key-share) until COMMIT. After COMMIT `beforeEmit(ids)` runs FIRST (the caller aborts the running loops, TA-C9), then task.changed per row carrying
   * `admin.cascadeIds`; no task.ready (nothing became todo). Halt does not matter: cancelling only reduces work.
   */
  async adminCancel(
    a: { target: string; cascade: boolean; digest: string; userId: string; /** TA-C12: the admin's reason, already masked and cut by the caller; display only (it rides on the event for the parent notice and nowhere else). */ reason?: string | null },
    beforeEmit?: (ids: string[]) => void | Promise<void>,
  ): Promise<AdminCancelResult> {
    const changes: Changes = [];
    const done = await this.inTx(async (c): Promise<AdminCancelResult> => {
      const rootQ = await c.query<{ root: string }>('SELECT root_id AS root FROM tasks WHERE id = $1', [a.target]);
      const rootId = rootQ.rows[0]?.root;
      if (!rootId) return { ok: false, error: 'not_found' };
      await c.query('SELECT id FROM tasks WHERE id = $1 FOR UPDATE', [rootId]);
      const refuse = (w: { rows: SubtreeRow[]; tooDeep: boolean }): Extract<AdminCancelResult, { ok: false }> | null => {
        if (w.tooDeep) return { ok: false, error: 'too_deep' };
        if (w.rows.length === 0) return { ok: false, error: 'ended' };
        if (!a.cascade && w.rows.length > 1) return { ok: false, error: 'open_children', open: w.rows.length - 1 };
        if (w.rows.length > TASK_CANCEL_MAX) return { ok: false, error: 'too_many' };
        return null;
      };
      const first = await openSubtree(c, a.target);
      const no = refuse(first);
      if (no) return no;
      await c.query('SELECT id FROM tasks WHERE id = ANY($1) ORDER BY id FOR UPDATE', [first.rows.map((r) => r.id)]);
      const second = await openSubtree(c, a.target); // after the locks: nothing can be added under S now
      const no2 = refuse(second);
      if (no2) return no2.error === 'ended' ? { ok: false, error: 'stale' } : no2;
      if (cancelDigest(second.rows, a.cascade) !== a.digest) return { ok: false, error: 'stale' };
      const ids = second.rows.map((r) => r.id);
      // TA-C7: the batches of S before any approval row (the join path locks batch then approval)
      const locked = await c.query<{ id: number; state: string }>(
        "SELECT id, state FROM approval_batches WHERE task_id = ANY($1) AND state IN ('open','sealed','posted') ORDER BY id FOR UPDATE", [ids]);
      const exp = await c.query<{ id: number; task_id: string; kind: string; tool_name: string | null }>(
        `UPDATE approvals SET status = 'expired', decided_at = now(), decided_by = $2
         WHERE task_id = ANY($1) AND status = 'pending'
         RETURNING id, task_id, kind, tool_name`, [ids, a.userId]);
      await move(c, changes, 'cancelled', "t.id = ANY($1) AND t.status NOT IN ('done','cancelled')", [ids]);
      const caps = exp.rows.filter((x) => isCapKind(x.kind)).map((x) => x.id);
      if (caps.length) await this.blockWaiters(c, changes, caps); // only waiters outside S: S is already cancelled
      const batches: Extract<AdminCancelResult, { ok: true }>['batches'] = [];
      for (const b of locked.rows) {
        if (b.state === 'open') {
          // F-1: an open batch has no items_digest and the CHECK needs one for every other state: computed as sealIn does, over the members under the batch lock
          const m = await c.query<{ id: number; sha: string | null }>('SELECT id, input_sha256 AS sha FROM approvals WHERE batch_id = $1 ORDER BY id', [b.id]);
          const digest = itemsDigest(m.rows.map((r) => ({ id: r.id, inputSha256: r.sha ?? '' })));
          const u = await c.query<{ id: number; channelId: string | null; messageId: string | null }>(
            `UPDATE approval_batches SET state = 'dissolved', items_digest = $2 WHERE id = $1 AND state = 'open' RETURNING id, channel_id AS "channelId", message_id AS "messageId"`, [b.id, digest]);
          if (u.rows[0]) batches.push({ ...u.rows[0], state: 'dissolved' });
        } else {
          const u = await c.query<{ id: number; state: 'dissolved' | 'closed'; channelId: string | null; messageId: string | null }>(
            `UPDATE approval_batches SET state = CASE WHEN state = 'posted' THEN 'closed' ELSE 'dissolved' END
             WHERE id = $1 AND state IN ('sealed','posted') RETURNING id, state, channel_id AS "channelId", message_id AS "messageId"`, [b.id]);
          if (u.rows[0]) batches.push(u.rows[0]);
        }
      }
      return {
        ok: true, ids, rootId, rootEnded: ids.includes(rootId), batches,
        expired: exp.rows.map((x) => ({ id: x.id, taskId: x.task_id, kind: x.kind, toolName: x.tool_name })),
      };
    });
    if (!done.ok) return done;
    await beforeEmit?.(done.ids); // TA-C9: the running loops are told FIRST
    await this.emitChanges(changes, (t) => (done.ids.includes(t.id) ? { admin: { cascadeIds: done.ids, ...(a.reason ? { reason: a.reason } : {}) } } : {}));
    return done;
  }

  /** Cancels tasks of pending approvals older than approval.expiryHours (DB clock). Returns how many expired. */
  async expireOld(): Promise<number> {
    const hours = this.cfg.get('approval.expiryHours');
    const changes: Changes = [];
    const n = await this.inTx(async (c) => {
      // Lock the roots first (sorted, so concurrent callers cannot deadlock), like decide() and onTreeCapHit.
      await c.query(
        `SELECT id FROM tasks WHERE id IN (SELECT t.root_id FROM approvals a JOIN tasks t ON t.id = a.task_id
           WHERE a.status = 'pending' AND a.created_at + $1 * interval '1 hour' <= now()) ORDER BY id FOR UPDATE`,
        [hours],
      );
      const r = await c.query<{ id: number; task_id: string; kind: string }>(
        `UPDATE approvals SET status = 'expired', decided_at = now()
         WHERE status = 'pending' AND created_at + $1 * interval '1 hour' <= now() RETURNING id, task_id, kind`,
        [hours],
      );
      if (r.rows.length) {
        await move(c, changes, 'cancelled', `t.id = ANY($1) AND t.status = 'awaiting_approval' AND ${WAITS_ON('ANY($2)')}`,
          [r.rows.map((x) => x.task_id), r.rows.map((x) => x.id)]);
        const caps = r.rows.filter((x) => isCapKind(x.kind)).map((x) => x.id);
        if (caps.length) await this.blockWaiters(c, changes, caps);
      }
      return r.rows.length;
    });
    await this.emitChanges(changes);
    return n;
  }

  /** After /resume: releases tasks whose approval was granted while halted. No-op while halted. Returns the count. */
  async resumeApproved(): Promise<number> {
    if (this.halt.isHalted()) return 0;
    const changes: Changes = [];
    await this.inTx((c) =>
      move(c, changes, 'todo',
        // A task waits on exactly the approval recorded in awaiting_approval_id; rows from before migration 005 have
        // none and keep the old rule (their own newest approval, else the tree's newest decided cap approval).
        `t.status = 'awaiting_approval' AND NOT EXISTS (SELECT 1 FROM approvals p WHERE p.task_id = t.id AND p.status = 'pending')
           AND CASE WHEN t.awaiting_approval_id IS NOT NULL
             THEN (SELECT a.status FROM approvals a WHERE a.id = t.awaiting_approval_id) = 'approved'
             ELSE COALESCE(
               (SELECT a.status FROM approvals a WHERE a.task_id = t.id ORDER BY a.id DESC LIMIT 1),
               (SELECT a.status FROM approvals a JOIN tasks r ON r.id = a.task_id
                  WHERE r.root_id = t.root_id AND a.kind IN ('tree_cap','local_cap') AND a.status <> 'pending' ORDER BY a.decided_at DESC, a.id DESC LIMIT 1)
             ) = 'approved' END`,
        []),
    );
    await this.emitChanges(changes);
    return changes.length;
  }

  /** Tasks that joined this cap approval (awaiting it, no pending approval of their own) -> todo. */
  private async releaseWaiters(c: PoolClient, changes: Changes, approvalId: number): Promise<void> {
    await move(c, changes, 'todo',
      `t.status = 'awaiting_approval' AND ${JOINED('= $1')}
         AND NOT EXISTS (SELECT 1 FROM approvals p WHERE p.task_id = t.id AND p.status = 'pending')`,
      [approvalId]);
  }

  /** Tasks that joined these (rejected or expired) cap approvals -> blocked; waiters of any other approval are untouched. */
  private async blockWaiters(c: PoolClient, changes: Changes, approvalIds: number[]): Promise<void> {
    await move(c, changes, 'blocked',
      `t.status = 'awaiting_approval' AND ${JOINED('= ANY($1)')}
         AND NOT EXISTS (SELECT 1 FROM approvals p WHERE p.task_id = t.id AND p.status = 'pending')`,
      [approvalIds], 'approval');
  }

  /** After COMMIT only: mirror each change (from != to), then wake every task that became todo. */
  private async emitChanges(changes: Changes, extra?: (t: Task) => Partial<AppEvents['task.changed']>): Promise<void> {
    for (const { task, from } of changes) if (from !== task.status) await this.bus.emit('task.changed', { task, from, to: task.status, ...(extra?.(task) ?? {}) });
    for (const { task, from } of changes) if (task.status === 'todo' && from !== 'todo') await this.bus.emit('task.ready', { taskId: task.id });
  }

  private async insert(
    c: PoolClient, taskId: string, reason: string, est: number | null, by: string, kind: 'estimate' | 'tool' | CapKind,
    capCalls: number | null = null, call?: ToolCall,
  ): Promise<Approval> {
    const r = await c.query<Approval>(
      `WITH i AS (INSERT INTO approvals (task_id, reason, est_cost_usd, requested_by, kind, cap_calls, tool_name, tool_input, input_sha256)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) RETURNING *)
       SELECT ${COLS} FROM i`,
      [taskId, reason, est, by, kind, capCalls, call?.name ?? null, call?.canonical ?? null, call?.sha256 ?? null],
    );
    return { ...r.rows[0]!, kind };
  }

  private async inTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
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
}

/**
 * Sets `to` (and the block reason, cleared otherwise; and the awaited approval, cleared otherwise) on the rows matching
 * `where` (over alias t), records each moved row with its previous status in `changes`, and returns the first one.
 * The self-join `o` reads the pre-update row.
 */
async function move(
  c: Queryable, changes: Changes, to: TaskStatus, where: string, params: unknown[], reason: BlockReason | null = null, awaiting: number | null = null,
): Promise<TaskChange | null> {
  const r = await c.query<TaskChange['task'] & { prev: TaskStatus }>(
    `UPDATE tasks t SET status = '${to}', blocked_reason = $${params.length + 1}, blocked_note = NULL, awaiting_approval_id = $${params.length + 2}, updated_at = now()
     FROM tasks o WHERE o.id = t.id AND ${where} RETURNING ${taskCols('t.')}, o.status AS prev`,
    [...params, reason, awaiting],
  );
  const out = r.rows.map(({ prev, ...task }) => ({ task, from: prev }));
  changes.push(...out);
  return out[0] ?? null;
}
