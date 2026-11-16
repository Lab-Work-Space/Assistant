import type { Pool } from '../pool.js';
import type { Approval, AuditEntry } from './ledger.js';

/** Start of the current calendar day in the zone bound as parameter `n`, as a timestamptz (the expression HealRepo and Approvals.decideAi use). */
const dayStart = (n: number): string => `(date_trunc('day', now() AT TIME ZONE $${n}) AT TIME ZONE $${n})`;

const COLS = `a.id, a.task_id AS "taskId", a.reason, a.est_cost_usd AS "estCostUsd", a.requested_by AS "requestedBy",
  a.status, a.decided_by AS "decidedBy", a.created_at AS "createdAt", a.decided_at AS "decidedAt",
  a.tool_name AS "toolName", a.tool_input AS "toolInput", a.input_sha256 AS "inputSha256", a.executed_at AS "executedAt", a.kind, a.batch_id AS "batchId", a.ai_review AS "aiReview"`;

/** What the daily digest reads (BE3): counts and codes only; reasons are raw here and are escaped by the digest. */
export interface AiDay {
  approvals: { tool: string; n: number }[];
  escalations: { code: string; n: number }[];
  reasons: string[];
  capHit: boolean;
  reviews: number;
}

/**
 * AI-APPROVE-1: everything the AI approver reads or counts, from audit rows. The rows that carry a cap or a recovery fact are written by
 * `claim`, which THROWS (the swallowing audit helper would undercount). Free text in an outcome is a code or a sanitised reason, never raw model text.
 */
export class AiApproverRepo {
  constructor(private readonly pool: Pool) {}

  /** An awaited insert that throws on error. */
  async claim(e: AuditEntry): Promise<void> {
    await this.pool.query(
      'INSERT INTO audit_log (actor, action, task_id, tool, outcome) VALUES ($1,$2,$3,$4,$5)',
      [e.actor, e.action, e.taskId ?? null, e.tool ?? null, e.outcome ?? null],
    );
  }

  private async n(sql: string, args: unknown[]): Promise<number> {
    return (await this.pool.query<{ n: number }>(sql, args)).rows[0]!.n;
  }

  /** AI approvals of the task tree rooted at `rootId` (every approve row of every task in it). */
  countTree(rootId: string): Promise<number> {
    return this.n("SELECT count(*)::int AS n FROM audit_log l JOIN tasks t ON t.id = l.task_id WHERE l.action = 'approval.ai.approve' AND t.root_id = $1", [rootId]);
  }

  /** AI approvals today (the calendar day in `tz`). */
  countDay(tz: string): Promise<number> {
    return this.n(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'approval.ai.approve' AND ts >= ${dayStart(1)}`, [tz]);
  }

  /** AA-C5: judge starts today (`approval.ai.review` rows); bounds the number of judge calls. */
  reviewsDay(tz: string): Promise<number> {
    return this.n(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'approval.ai.review' AND ts >= ${dayStart(1)}`, [tz]);
  }

  /**
   * AA-C18: whether AI approvals are paused today. Reads only `approval.ai.pause` / `approval.ai.resume` rows written by a Discord user
   * (actor `user:<snowflake>`) since the day start in `tz`; the newest row wins. Throws on a read error (the caller counts that as paused). `q` is the transaction client when called inside one (G2-01).
   */
  async pausedToday(tz: string, q: Pick<Pool, 'query'> = this.pool): Promise<boolean> {
    const r = await q.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE action IN ('approval.ai.pause','approval.ai.resume') AND actor ~ '^user:[0-9]{17,20}$' AND ts >= ${dayStart(1)}
       ORDER BY ts DESC, id DESC LIMIT 1`, [tz]);
    return r.rows[0]?.action === 'approval.ai.pause';
  }

  /** AA-C18: a Bot Admin's pause or resume as an audit row (actor `user:<id>`, outcome `ok`); the newest row of the day wins. Throws on a write error. */
  async setPause(userId: string, on: boolean): Promise<void> {
    await this.claim({ actor: `user:${userId}`, action: on ? 'approval.ai.pause' : 'approval.ai.resume', outcome: 'ok' });
  }

  /** Best effort: the card text of an escalated pending approval. */
  async setAiReview(id: number, text: string): Promise<void> {
    await this.pool.query("UPDATE approvals SET ai_review = $2 WHERE id = $1 AND status = 'pending'", [id, text.slice(0, 200)]);
  }

  /** SA-1 restart recovery: pending solo tool approvals whose review started inside the expiry window and has no outcome row. Up to 50. */
  async interrupted(hours: number): Promise<Approval[]> {
    const r = await this.pool.query<Approval>(
      `SELECT ${COLS} FROM approvals a
       WHERE a.kind = 'tool' AND a.status = 'pending' AND a.batch_id IS NULL
         AND a.created_at + $1 * interval '1 hour' > now()
         AND EXISTS (SELECT 1 FROM audit_log l WHERE l.action = 'approval.ai.review' AND l.outcome = '#' || a.id || ' start' AND l.ts > now() - $1 * interval '1 hour')
         AND NOT EXISTS (SELECT 1 FROM audit_log l WHERE l.action IN ('approval.ai.approve','approval.ai.escalate') AND l.outcome LIKE '#' || a.id || ' %')
       ORDER BY a.id LIMIT 50`, [hours]);
    return r.rows;
  }

  /** The digest's read (BE3): today's approve and escalate rows. */
  async day(tz: string): Promise<AiDay> {
    const rows = (await this.pool.query<{ action: string; tool: string | null; outcome: string | null }>(
      `SELECT action, tool, outcome FROM audit_log WHERE action IN ('approval.ai.approve','approval.ai.escalate') AND ts >= ${dayStart(1)} ORDER BY ts, id`, [tz])).rows;
    const tools = new Map<string, number>();
    const codes = new Map<string, number>();
    const reasons: string[] = [];
    let reviews = 0;
    for (const x of rows) {
      reviews++;
      if (x.action === 'approval.ai.approve') {
        const t = x.tool ?? '?';
        tools.set(t, (tools.get(t) ?? 0) + 1);
        continue;
      }
      const m = /^#\d+ (.*)$/.exec(x.outcome ?? '');
      const body = m?.[1] ?? '?';
      if (body.startsWith('judge ')) {
        codes.set('judge', (codes.get('judge') ?? 0) + 1);
        reasons.push(body.slice(6));
      } else codes.set(body, (codes.get(body) ?? 0) + 1);
    }
    const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return {
      approvals: top(tools).slice(0, 10).map(([tool, n]) => ({ tool, n })),
      escalations: top(codes).map(([code, n]) => ({ code, n })),
      reasons: reasons.slice(-5).reverse(),
      capHit: codes.has('cap_tree') || codes.has('cap_day'),
      reviews,
    };
  }
}
