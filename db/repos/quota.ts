import type { Pool } from 'pg';
import type { QuotaSnapshot, QuotaWindowName } from '../../providers/claude-code-local/quota.js';

export type StoredQuota = { snapshot: QuotaSnapshot; observedAt: Date };
export type AlertKind = 'high' | 'rejected';
export type ActorUsage = { actor: string; calls: number; tokensIn: number; tokensOut: number; costUsd: number };

/** USAGE-1: the one-row snapshot and the posted-alert claims (survive a restart). */
export class QuotaRepo {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async load(): Promise<StoredQuota | null> {
    const r = await this.pool.query<{ snapshot: QuotaSnapshot; observed_at: Date }>('SELECT snapshot, observed_at FROM quota_snapshot WHERE id = 1');
    const row = r.rows[0];
    return row ? { snapshot: row.snapshot, observedAt: new Date(row.observed_at) } : null;
  }

  async save(snapshot: QuotaSnapshot, observedAt: Date): Promise<void> {
    await this.pool.query(
      `INSERT INTO quota_snapshot(id, snapshot, observed_at) VALUES (1, $1::jsonb, $2)
       ON CONFLICT (id) DO UPDATE SET snapshot = EXCLUDED.snapshot, observed_at = EXCLUDED.observed_at`, [JSON.stringify(snapshot), observedAt]);
  }

  /** True when this call claimed the alert (first for this window, reset period and kind). Old claims (reset over 30 days ago) are pruned. */
  async claimAlert(win: QuotaWindowName, resetsAt: number, kind: AlertKind, nowMs: number): Promise<boolean> {
    await this.pool.query('DELETE FROM quota_alerts WHERE resets_at < $1', [Math.floor(nowMs / 1000) - 30 * 86_400]);
    const r = await this.pool.query('INSERT INTO quota_alerts(win, resets_at, kind) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [win, resetsAt, kind]);
    return r.rowCount === 1;
  }

  async releaseAlert(win: QuotaWindowName, resetsAt: number, kind: AlertKind): Promise<void> {
    await this.pool.query('DELETE FROM quota_alerts WHERE win = $1 AND resets_at = $2 AND kind = $3', [win, resetsAt, kind]);
  }
}

/** USAGE-1: model calls and tokens per actor from the `llm.call` audit rows since `since` (uses audit_log_action_ts_idx). */
export class LlmUsageRepo {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async byActor(since: Date, limit = 40): Promise<ActorUsage[]> {
    const r = await this.pool.query<{ actor: string; calls: string; tin: string; tout: string; cost: string }>(
      `SELECT actor, count(*) AS calls, coalesce(sum(tokens_in), 0) AS tin, coalesce(sum(tokens_out), 0) AS tout, coalesce(sum(cost_usd), 0) AS cost
       FROM audit_log WHERE action = 'llm.call' AND ts >= $1 GROUP BY actor ORDER BY count(*) DESC, actor LIMIT $2`, [since, limit]);
    return r.rows.map((x) => ({ actor: x.actor, calls: Number(x.calls), tokensIn: Number(x.tin), tokensOut: Number(x.tout), costUsd: Number(x.cost) }));
  }
}
