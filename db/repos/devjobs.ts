import { randomBytes } from 'node:crypto';
import type { Pool } from '../pool.js';

export type DevJobStatus = 'queued' | 'planning' | 'coding' | 'testing' | 'reviewing' | 'ready' | 'failed' | 'refused' | 'cancelled' | 'confirmed' | 'applied' | 'rolled_back';
export const OPEN_STATUSES: readonly DevJobStatus[] = ['queued', 'planning', 'coding', 'testing', 'reviewing'];
export const RUNNING_STATUSES: readonly DevJobStatus[] = ['planning', 'coding', 'testing', 'reviewing'];

export interface DevJob {
  id: string;
  repo: string;
  kind: 'assistant' | 'pr';
  requesterId: string;
  channelId: string | null;
  status: DevJobStatus;
  /** Tainted data (Gate 1 self-code X22): never put into a prompt as an instruction. */
  request: string;
  tainted: boolean;
  baseSha: string | null;
  headSha: string | null;
  bundleSha256: string | null;
  facts: unknown;
  verdicts: unknown;
  report: string | null;
  /** The full diff of the head against the base, written by code from git objects (dashboard only). */
  diff: string | null;
  cardId: string | null;
  spendUsd: number;
  outcome: string | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}

const COLS = `id, repo, kind, requester_id AS "requesterId", channel_id AS "channelId", status, request, tainted, base_sha AS "baseSha", head_sha AS "headSha",
  bundle_sha256 AS "bundleSha256", facts, verdicts, report, diff, card_id AS "cardId", spend_usd::float8 AS "spendUsd", outcome, created_at AS "createdAt", updated_at AS "updatedAt", finished_at AS "finishedAt"`;

export const newJobId = (): string => `J-${randomBytes(8).toString('hex')}`;

/** Migration 017. The main application writes and reads everything; the executor role can only read and stamp the outcome (db/executor-role.ts). */
export class DevJobRepo {
  constructor(private readonly pool: Pool) {}

  async create(j: { repo: string; kind: 'assistant' | 'pr'; requesterId: string; channelId: string | null; request: string; status?: 'queued' | 'refused'; outcome?: string }): Promise<DevJob> {
    const r = await this.pool.query<DevJob>(
      `INSERT INTO dev_jobs (id, repo, kind, requester_id, channel_id, request, status, outcome, finished_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $7 = 'refused' THEN now() END) RETURNING ${COLS}`,
      [newJobId(), j.repo, j.kind, j.requesterId, j.channelId, j.request.slice(0, 4000), j.status ?? 'queued', j.outcome?.slice(0, 500) ?? null],
    );
    return r.rows[0]!;
  }

  async get(id: string): Promise<DevJob | null> {
    return (await this.pool.query<DevJob>(`SELECT ${COLS} FROM dev_jobs WHERE id = $1`, [id])).rows[0] ?? null;
  }

  /** The dashboard page is keyed by the exact head sha (X21). */
  async getByHead(head: string): Promise<DevJob | null> {
    if (!/^[0-9a-f]{40}$/.test(head)) return null;
    return (await this.pool.query<DevJob>(`SELECT ${COLS} FROM dev_jobs WHERE head_sha = $1 ORDER BY created_at DESC LIMIT 1`, [head])).rows[0] ?? null;
  }

  async list(limit = 50): Promise<DevJob[]> {
    return (await this.pool.query<DevJob>(`SELECT ${COLS} FROM dev_jobs ORDER BY created_at DESC LIMIT $1`, [limit])).rows;
  }

  /** Moves a job to `to` only from one of `from` (a lost race returns false). */
  async transition(id: string, from: readonly DevJobStatus[], to: DevJobStatus, patch: { outcome?: string; baseSha?: string; headSha?: string; bundleSha256?: string; facts?: unknown; verdicts?: unknown; report?: string; diff?: string; cardId?: string } = {}): Promise<boolean> {
    const done = to === 'ready' || to === 'failed' || to === 'refused' || to === 'cancelled' || to === 'applied' || to === 'rolled_back';
    const r = await this.pool.query(
      `UPDATE dev_jobs SET status = $3, updated_at = now(), finished_at = CASE WHEN $4 THEN now() ELSE finished_at END,
         outcome = COALESCE($5, outcome), base_sha = COALESCE($6, base_sha), head_sha = COALESCE($7, head_sha), bundle_sha256 = COALESCE($8, bundle_sha256),
         facts = COALESCE($9::jsonb, facts), verdicts = COALESCE($10::jsonb, verdicts), report = COALESCE($11, report), card_id = COALESCE($12, card_id), diff = COALESCE($13, diff)
       WHERE id = $1 AND status = ANY($2::text[])`,
      [id, from, to, done, patch.outcome?.slice(0, 500) ?? null, patch.baseSha ?? null, patch.headSha ?? null, patch.bundleSha256 ?? null,
        patch.facts === undefined ? null : JSON.stringify(patch.facts), patch.verdicts === undefined ? null : JSON.stringify(patch.verdicts), patch.report?.slice(0, 65536) ?? null, patch.cardId ?? null, patch.diff ?? null],
    );
    return (r.rowCount ?? 0) === 1;
  }

  /** The executor's only write (column grant, db/executor-role.ts): the end state of a job it applied or rolled back. */
  async finish(id: string, status: 'applied' | 'rolled_back' | 'failed', outcome: string): Promise<void> {
    await this.pool.query(`UPDATE dev_jobs SET status = $2, outcome = $3, finished_at = now(), updated_at = now() WHERE id = $1 AND status IN ('ready', 'confirmed')`, [id, status, outcome.slice(0, 500)]);
  }

  async addSpend(id: string, usd: number): Promise<number> {
    const r = await this.pool.query<{ s: number }>(`UPDATE dev_jobs SET spend_usd = spend_usd + $2, updated_at = now() WHERE id = $1 RETURNING spend_usd::float8 AS s`, [id, usd]);
    return r.rows[0]?.s ?? 0;
  }

  /** Oldest queued job, claimed into `planning` in one statement (a second runner gets nothing: the running count is checked in the same statement). */
  async claimNext(maxRunning: number): Promise<DevJob | null> {
    const r = await this.pool.query<DevJob>(
      `UPDATE dev_jobs SET status = 'planning', updated_at = now()
       WHERE id = (SELECT id FROM dev_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
         AND (SELECT count(*) FROM dev_jobs WHERE status = ANY($1::text[])) < $2
       RETURNING ${COLS}`,
      [RUNNING_STATUSES, maxRunning],
    );
    return r.rows[0] ?? null;
  }

  async runningCount(): Promise<number> {
    return Number((await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM dev_jobs WHERE status = ANY($1::text[])`, [RUNNING_STATUSES])).rows[0]!.n);
  }

  /** X24: failed and refused jobs count. `since` is the start of the window (UTC day). */
  async countSince(since: Date, requesterId?: string): Promise<number> {
    const r = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM dev_jobs WHERE created_at >= $1 AND ($2::text IS NULL OR requester_id = $2)`, [since, requesterId ?? null]);
    return Number(r.rows[0]!.n);
  }

  /** The month's spend over all jobs (the proxy's own metering is written here per job). */
  async spendSince(since: Date): Promise<number> {
    return (await this.pool.query<{ s: number }>(`SELECT COALESCE(sum(spend_usd), 0)::float8 AS s FROM dev_jobs WHERE created_at >= $1`, [since])).rows[0]!.s;
  }

  /** After a crash: a job that was running cannot be resumed; it becomes failed. */
  async failRunning(why: string): Promise<number> {
    const r = await this.pool.query(`UPDATE dev_jobs SET status = 'failed', outcome = $2, finished_at = now(), updated_at = now() WHERE status = ANY($1::text[])`, [RUNNING_STATUSES, why.slice(0, 500)]);
    return r.rowCount ?? 0;
  }

  async putBundle(job: string, sha256: string, data: Buffer): Promise<void> {
    await this.pool.query(`INSERT INTO dev_job_bundles (job, sha256, size, data) VALUES ($1, $2, $3, $4) ON CONFLICT (job) DO UPDATE SET sha256 = $2, size = $3, data = $4, created_at = now()`, [job, sha256, data.length, data]);
  }
  async getBundle(job: string): Promise<{ sha256: string; size: number; data: Buffer } | null> {
    return (await this.pool.query<{ sha256: string; size: number; data: Buffer }>('SELECT sha256, size, data FROM dev_job_bundles WHERE job = $1', [job])).rows[0] ?? null;
  }

  /** Old jobs and their bundles go after `days` (retention limit, X25). */
  async purge(days = 30): Promise<number> {
    const r = await this.pool.query(`DELETE FROM dev_jobs WHERE created_at < now() - ($1::int * interval '1 day') AND status NOT IN ('queued', 'planning', 'coding', 'testing', 'reviewing', 'ready', 'confirmed')`, [days]);
    return r.rowCount ?? 0;
  }
}
