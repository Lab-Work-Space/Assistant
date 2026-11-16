import type { PoolClient } from 'pg';
import { itemsDigest } from '../../governance/canonical.js';
import type { Pool } from '../pool.js';
import type { Approval } from './ledger.js';

/** APPROVAL-BATCH-1 (migration 026): one card for several tool approvals of one task and one requester. */
export const BATCH_MAX_ITEMS = 8;

export type BatchState = 'open' | 'sealed' | 'posted' | 'dissolved' | 'closed';
export interface ApprovalBatch {
  id: number; taskId: string; requestedBy: string; state: BatchState; itemCount: number; digest: string | null;
  channelId: string | null; messageId: string | null;
}
/** A member as the card shows it; `live` = pending and not expired by the DB clock. */
export type BatchMember = Approval & { live: boolean };

const BATCH_COLS = `id, task_id AS "taskId", requested_by AS "requestedBy", state, item_count AS "itemCount", items_digest AS digest,
  channel_id AS "channelId", message_id AS "messageId"`;
const MEMBER_COLS = `id, task_id AS "taskId", reason, est_cost_usd AS "estCostUsd", requested_by AS "requestedBy",
  status, decided_by AS "decidedBy", created_at AS "createdAt", decided_at AS "decidedAt",
  tool_name AS "toolName", tool_input AS "toolInput", input_sha256 AS "inputSha256", executed_at AS "executedAt", kind, batch_id AS "batchId", ai_review AS "aiReview"`;

export type JoinOptions = {
  /** Window length; compared against the DB clock (opened_at + window <= now() means the window is over). */
  windowMs: number;
  /** B2: whether the card still fits (1 message, 1 embed, 6000 chars) with `next` added to `members`. Pure and synchronous. */
  fits: (members: Approval[], next: Approval) => boolean;
};
export type JoinResult =
  /** Not batched: the caller posts today's solo card. `sealed` batches (sealed by this call) still have to be published. */
  | { kind: 'solo'; sealed: number[] }
  | { kind: 'joined'; batchId: number; opened: boolean; sealed: number[] };

/**
 * SQL for the batches. Lock order: a join takes its own task row FOR KEY SHARE (G2-01, task before batch, as adminCancel), then the batch row FOR UPDATE, then approval rows; it takes no root lock. The digest is
 * always computed in application code AFTER the batch row is locked and its state re-checked, from a fresh SELECT of the members
 * (B5), never in a subquery of the sealing UPDATE.
 */
export class ApprovalBatchRepo {
  constructor(private readonly pool: Pool) {}

  async get(id: number): Promise<ApprovalBatch | null> {
    return (await this.pool.query<ApprovalBatch>(`SELECT ${BATCH_COLS} FROM approval_batches WHERE id = $1`, [id])).rows[0] ?? null;
  }

  /** The batch an approval was put in, in any state (a dissolved batch is told apart by the caller, B1). */
  async ofApproval(approvalId: number): Promise<ApprovalBatch | null> {
    return (await this.pool.query<ApprovalBatch>(
      `SELECT b.id, b.task_id AS "taskId", b.requested_by AS "requestedBy", b.state, b.item_count AS "itemCount", b.items_digest AS digest,
         b.channel_id AS "channelId", b.message_id AS "messageId"
       FROM approval_batches b JOIN approvals a ON a.batch_id = b.id WHERE a.id = $1`,
      [approvalId],
    )).rows[0] ?? null;
  }

  /** The members in ascending id order (the digest order). */
  async members(batchId: number, expiryHours: number): Promise<BatchMember[]> {
    return (await this.pool.query<BatchMember>(
      `SELECT ${MEMBER_COLS}, (status = 'pending' AND created_at + $2 * interval '1 hour' > now()) AS live
       FROM approvals WHERE batch_id = $1 ORDER BY id`,
      [batchId, expiryHours],
    )).rows;
  }

  async pendingIds(batchId: number): Promise<number[]> {
    return (await this.pool.query<{ id: number }>("SELECT id FROM approvals WHERE batch_id = $1 AND status = 'pending' ORDER BY id", [batchId])).rows.map((r) => r.id);
  }

  async listOpen(): Promise<number[]> {
    return (await this.pool.query<{ id: number }>("SELECT id FROM approval_batches WHERE state = 'open' ORDER BY id")).rows.map((r) => r.id);
  }

  /** Sealed batches that no card was recorded for (a crash between seal and post). */
  async listUnposted(): Promise<number[]> {
    return (await this.pool.query<{ id: number }>("SELECT id FROM approval_batches WHERE state = 'sealed' AND message_id IS NULL ORDER BY id")).rows.map((r) => r.id);
  }

  /** Open batches whose window is over by the DB clock (their timer was lost or its seal failed). */
  async listDue(windowMs: number): Promise<number[]> {
    return (await this.pool.query<{ id: number }>(
      "SELECT id FROM approval_batches WHERE state = 'open' AND opened_at + $1 * interval '1 millisecond' <= now() ORDER BY id", [windowMs],
    )).rows.map((r) => r.id);
  }

  /** Sealed batches with no recorded card that have been sealed for at least `minAgeMs` (a publish that never finished). */
  async listStaleSealed(minAgeMs: number): Promise<number[]> {
    return (await this.pool.query<{ id: number }>(
      "SELECT id FROM approval_batches WHERE state = 'sealed' AND message_id IS NULL AND sealed_at + $1 * interval '1 millisecond' <= now() ORDER BY id", [minAgeMs],
    )).rows.map((r) => r.id);
  }

  /** open -> sealed in its own transaction; true for the single winner (only the winner publishes). */
  async seal(batchId: number): Promise<boolean> {
    return this.tx((c) => this.sealIn(c, batchId));
  }

  private async sealIn(c: PoolClient, batchId: number): Promise<boolean> {
    const b = await c.query<{ state: string }>('SELECT state FROM approval_batches WHERE id = $1 FOR UPDATE', [batchId]);
    if (b.rows[0]?.state !== 'open') return false;
    // A separate SELECT after the lock: a join that committed before it is in the digest; one that waits on the lock is refused (state is no longer open).
    const m = await c.query<{ id: number; sha: string | null }>('SELECT id, input_sha256 AS sha FROM approvals WHERE batch_id = $1 ORDER BY id', [batchId]);
    const digest = itemsDigest(m.rows.map((r) => ({ id: r.id, inputSha256: r.sha ?? '' })));
    const u = await c.query("UPDATE approval_batches SET state = 'sealed', sealed_at = now(), items_digest = $2, item_count = $3 WHERE id = $1 AND state = 'open'", [batchId, digest, m.rows.length]);
    return u.rowCount === 1;
  }

  /** Puts the new tool approval into the open batch of its (task, requester), or opens one. See the spec's state machine (join tx). */
  async join(a: Approval, o: JoinOptions): Promise<JoinResult> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const c = await this.pool.connect();
      try {
        await c.query('BEGIN');
        const r = await this.joinIn(c, a, o);
        await c.query(r.keep ? 'COMMIT' : 'ROLLBACK');
        return r.result;
      } catch (err) {
        await c.query('ROLLBACK').catch(() => undefined);
        if ((err as { code?: string }).code === '23505' && attempt === 0) continue; // another join opened the batch first: retry once in a new tx
        if ((err as { code?: string }).code === '23505') return { kind: 'solo', sealed: [] };
        throw err;
      } finally {
        c.release();
      }
    }
    return { kind: 'solo', sealed: [] };
  }

  /** `keep` false: nothing of this attempt may stay (rolled back, not committed). */
  private async joinIn(c: PoolClient, a: Approval, o: JoinOptions): Promise<{ result: JoinResult; keep: boolean }> {
    const sealed: number[] = [];
    // G2-01: lock order task -> batch, as Approvals.adminCancel takes it. Without this, a join that seals an aged batch and then INSERTs the next one
    // (its FK check waits on the task row) can deadlock with a cancel that holds the task row and wants the batch (40P01).
    await c.query('SELECT id FROM tasks WHERE id = $1 FOR KEY SHARE', [a.taskId]);
    const open = await c.query<{ id: number; itemCount: number; over: boolean }>(
      `SELECT id, item_count AS "itemCount", opened_at + $3 * interval '1 millisecond' <= now() AS over
       FROM approval_batches WHERE task_id = $1 AND requested_by = $2 AND state = 'open' FOR UPDATE`,
      [a.taskId, a.requestedBy, o.windowMs],
    );
    let batchId: number | null = null;
    let opened = false;
    const cur = open.rows[0];
    if (cur) {
      if (cur.over || cur.itemCount >= BATCH_MAX_ITEMS) {
        if (await this.sealIn(c, cur.id)) sealed.push(cur.id);
      } else {
        const members = (await c.query<Approval>(`SELECT ${MEMBER_COLS} FROM approvals WHERE batch_id = $1 ORDER BY id`, [cur.id])).rows;
        if (!o.fits(members, a)) {
          // B2: it fits the item test but not the card total: the batch seals first and the item goes solo.
          if (await this.sealIn(c, cur.id)) sealed.push(cur.id);
          return { result: { kind: 'solo', sealed }, keep: true };
        }
        batchId = cur.id;
      }
    }
    if (batchId === null) {
      batchId = (await c.query<{ id: number }>('INSERT INTO approval_batches (task_id, requested_by) VALUES ($1, $2) RETURNING id', [a.taskId, a.requestedBy])).rows[0]!.id;
      opened = true;
    }
    const m = await c.query("UPDATE approvals SET batch_id = $1 WHERE id = $2 AND batch_id IS NULL AND status = 'pending' AND kind = 'tool'", [batchId, a.id]);
    if (m.rowCount !== 1) {
      return { result: { kind: 'solo', sealed: [] }, keep: false }; // nothing of this attempt stays (not even a seal): the item is posted solo
    }
    const n = await c.query<{ n: number }>(
      "UPDATE approval_batches SET item_count = item_count + 1 WHERE id = $1 AND state = 'open' AND item_count < $2 RETURNING item_count AS n",
      [batchId, BATCH_MAX_ITEMS],
    );
    if (n.rowCount !== 1) throw new Error('approval batch is not open or is full'); // cannot happen under the lock; rolls the join back
    if (n.rows[0]!.n >= BATCH_MAX_ITEMS && (await this.sealIn(c, batchId))) sealed.push(batchId);
    return { result: { kind: 'joined', batchId, opened, sealed }, keep: true };
  }

  /** sealed -> posted, with the message the card actually went to. */
  async markPosted(batchId: number, channelId: string, messageId: string): Promise<boolean> {
    const r = await this.pool.query(
      "UPDATE approval_batches SET state = 'posted', channel_id = $2, message_id = $3, posted_at = now() WHERE id = $1 AND state = 'sealed'",
      [batchId, channelId, messageId],
    );
    return r.rowCount === 1;
  }

  /** sealed -> dissolved: a batch of one (posted as today's card) or a failed post (B9). The members keep their batch_id (it is immutable). */
  async dissolve(batchId: number): Promise<boolean> {
    return ((await this.pool.query("UPDATE approval_batches SET state = 'dissolved' WHERE id = $1 AND state = 'sealed'", [batchId])).rowCount ?? 0) === 1;
  }

  /** sealed or posted -> closed: no pending member is left, so there is nothing to show buttons for. */
  async close(batchId: number): Promise<boolean> {
    return ((await this.pool.query("UPDATE approval_batches SET state = 'closed' WHERE id = $1 AND state IN ('sealed','posted')", [batchId])).rowCount ?? 0) === 1;
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
}
