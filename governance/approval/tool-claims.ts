import type { Pool } from '../../db/pool.js';
import type { AuditFn } from '../audit.js';
import { canonicalJson, inputDigest } from '../canonical.js';

/**
 * R4 tool approval rows after the decision: the single-use claim (executed_at), the stored outcome (tool_result) and its
 * delivery to the owner's model turn (result_delivered_at). Used through Approvals.
 */

/**
 * One claimed tool approval. `run`: approved and its stored input still hashes to input_sha256. `refused`: nothing may
 * run (rejected, expired, or a digest mismatch). `claimedAt` is the executed_at this claim wrote (text, full precision).
 */
export type ToolClaim =
  | { kind: 'run'; approvalId: number; name: string; input: unknown; claimedAt: string }
  | { kind: 'refused'; approvalId: number; name: string; why: 'rejected' | 'expired' | 'digest_mismatch'; claimedAt: string };

/**
 * A settled tool approval the owner's model has not seen yet. `result`: the stored outcome text. `interrupted`: claimed
 * but no outcome was recorded (the process stopped mid-call); it is never re-run.
 */
export type ToolDelivery = {
  approvalId: number; name: string; state: 'result' | 'rejected' | 'expired' | 'digest_mismatch' | 'interrupted'; text: string | null;
};

const digestOk = (input: unknown, sha: string): boolean => {
  try {
    return inputDigest(canonicalJson(input)) === sha;
  } catch {
    return false;
  }
};

/** Atomic claim of the task's decided, unclaimed tool approvals, in approval order; a tampered row is consumed and audited. */
export async function claimTools(pool: Pool, taskId: string, audit: AuditFn): Promise<ToolClaim[]> {
  const r = await pool.query<{ id: number; name: string; input: unknown; sha: string; status: 'approved' | 'rejected' | 'expired'; at: string }>(
    `UPDATE approvals SET executed_at = now()
     WHERE kind = 'tool' AND status IN ('approved','rejected','expired') AND executed_at IS NULL AND task_id = $1
     RETURNING id, tool_name AS name, tool_input AS input, input_sha256 AS sha, status, executed_at::text AS at`,
    [taskId],
  );
  const out: ToolClaim[] = [];
  for (const row of r.rows.sort((a, b) => a.id - b.id)) {
    const base = { approvalId: row.id, name: row.name, claimedAt: row.at };
    if (row.status !== 'approved') out.push({ ...base, kind: 'refused', why: row.status });
    else if (digestOk(row.input, row.sha)) out.push({ ...base, kind: 'run', input: row.input });
    else {
      out.push({ ...base, kind: 'refused', why: 'digest_mismatch' });
      await audit({ actor: 'system', action: 'approval.claim', taskId, tool: row.name, outcome: 'digest_mismatch' });
    }
  }
  return out;
}

/**
 * Gives back a `run` claim that did not run (/halt refused it). Conditional on this claim's executed_at, no stored outcome,
 * and the row's digest still equal to the digest of the verified input: a tampered row or a refused claim is never released.
 */
export async function unclaimTool(pool: Pool, c: ToolClaim): Promise<boolean> {
  if (c.kind !== 'run') return false;
  let sha: string;
  try {
    sha = inputDigest(canonicalJson(c.input));
  } catch {
    return false;
  }
  const r = await pool.query(
    `UPDATE approvals SET executed_at = NULL
     WHERE id = $1 AND kind = 'tool' AND status = 'approved' AND executed_at = $2::timestamptz AND input_sha256 = $3
       AND tool_result IS NULL AND result_delivered_at IS NULL`,
    [c.approvalId, c.claimedAt, sha],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Records the outcome of the claimed call (once, only on this claim). */
export async function storeToolResult(pool: Pool, c: Pick<ToolClaim, 'approvalId' | 'claimedAt'>, text: string): Promise<boolean> {
  const r = await pool.query(
    "UPDATE approvals SET tool_result = $3 WHERE id = $1 AND kind = 'tool' AND executed_at = $2::timestamptz AND tool_result IS NULL",
    [c.approvalId, c.claimedAt, text],
  );
  return (r.rowCount ?? 0) > 0;
}

type Row = { id: number; name: string; status: string; result: string | null; input: unknown; sha: string; task_id: string };
const ROW = 'id, tool_name AS name, status, tool_result AS result, tool_input AS input, input_sha256 AS sha, task_id';

function deliveryOf(r: Row): ToolDelivery {
  const base = { approvalId: r.id, name: r.name };
  if (r.status === 'rejected' || r.status === 'expired') return { ...base, state: r.status, text: null };
  if (r.result !== null) return { ...base, state: 'result', text: r.result };
  return { ...base, state: digestOk(r.input, r.sha) ? 'interrupted' : 'digest_mismatch', text: null };
}

/** The task's claimed tool approvals whose outcome the owner's model has not seen, in approval order. */
export async function pendingToolDeliveries(pool: Pool, taskId: string): Promise<ToolDelivery[]> {
  const r = await pool.query<Row>(
    `SELECT ${ROW} FROM approvals WHERE task_id = $1 AND kind = 'tool' AND executed_at IS NOT NULL AND result_delivered_at IS NULL ORDER BY id`,
    [taskId],
  );
  return r.rows.map(deliveryOf);
}

/** Called once the owner's model turn that carried these outcomes has started (its provider call was made). */
export async function markToolsDelivered(pool: Pool, ids: number[]): Promise<void> {
  if (!ids.length) return;
  await pool.query("UPDATE approvals SET result_delivered_at = now() WHERE id = ANY($1) AND kind = 'tool' AND result_delivered_at IS NULL", [ids]);
}

/**
 * Boot check: approved calls claimed with no recorded outcome and not yet told (a crash mid-call). They are never re-run.
 * Only rows of a task that is still open: a done or cancelled task's owner never runs again to be told, so its row would
 * otherwise raise the boot alert on every restart.
 */
export async function interruptedToolCalls(pool: Pool): Promise<{ approvalId: number; taskId: string; name: string }[]> {
  const r = await pool.query<Row>(
    `SELECT ${ROW.split(', ').map((c) => `a.${c}`).join(', ')} FROM approvals a JOIN tasks t ON t.id = a.task_id
     WHERE a.kind = 'tool' AND a.status = 'approved' AND a.executed_at IS NOT NULL AND a.tool_result IS NULL
       AND a.result_delivered_at IS NULL AND t.status NOT IN ('done', 'cancelled') ORDER BY a.id`,
  );
  return r.rows.filter((x) => deliveryOf(x).state === 'interrupted').map((x) => ({ approvalId: x.id, taskId: x.task_id, name: x.name }));
}
