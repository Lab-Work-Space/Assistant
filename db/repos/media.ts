import type { ActorRef } from '../../company/types.js';
import type { Pool } from '../pool.js';

export type MediaKind = 'image' | 'video';
/** The caps for one take: company and per-person, in images (or videos). */
export type MediaCaps = { company: number; person: number };
export type MediaJob = {
  id: string; opName: string; requesterId: string | null; actor: ActorRef;
  channelId: string; threadId: string | null; taskId: string | null; reservedUsd: number; seconds: number; tainted: boolean;
  status: 'running' | 'posting' | 'posted' | 'failed' | 'blocked' | 'cancelled'; createdAt: Date;
};
export type NewMediaJob = Omit<MediaJob, 'id' | 'status' | 'createdAt'>;
const COLS = `id, op_name AS "opName", requester_id AS "requesterId", actor, channel_id AS "channelId", thread_id AS "threadId", task_id AS "taskId",
  reserved_usd::float8 AS "reservedUsd", seconds, tainted, status, created_at AS "createdAt"`;

/**
 * RF30: durable daily counters. `take` locks the company row and then the person's row (a fixed order, so concurrent takes never deadlock) in one
 * transaction, checks both caps and adds `n` to both; it returns which cap refused, if any. `giveBack` undoes a take when the budget reserve was refused or the provider
 * clearly never started work.
 */
export class MediaUsageRepo {
  constructor(private readonly pool: Pool, private readonly now: () => Date = () => new Date()) {}

  async take(kind: MediaKind, personId: string, n: number, caps: MediaCaps): Promise<{ ok: true } | { ok: false; scope: 'company' | 'person' }> {
    const day = this.now().toISOString().slice(0, 10);
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const keys: [string, string][] = [['company', ''], ['user', personId]];
      for (const [s, id] of keys) await c.query('INSERT INTO media_usage (day, scope, scope_id, kind) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [day, s, id, kind]);
      const used: number[] = [];
      for (const [s, id] of keys)
        used.push((await c.query<{ used: number }>('SELECT used FROM media_usage WHERE day=$1 AND scope=$2 AND scope_id=$3 AND kind=$4 FOR UPDATE', [day, s, id, kind])).rows[0]!.used);
      const refused = used[0]! + n > caps.company ? 'company' : used[1]! + n > caps.person ? 'person' : null;
      if (refused) { await c.query('ROLLBACK'); return { ok: false, scope: refused }; }
      for (const [s, id] of keys) await c.query('UPDATE media_usage SET used = used + $5 WHERE day=$1 AND scope=$2 AND scope_id=$3 AND kind=$4', [day, s, id, kind, n]);
      await c.query('COMMIT');
      return { ok: true };
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  async giveBack(kind: MediaKind, personId: string, n: number, day?: string): Promise<void> {
    const d = day ?? this.now().toISOString().slice(0, 10);
    await this.pool.query(`UPDATE media_usage SET used = GREATEST(used - $4, 0) WHERE day=$1 AND kind=$2 AND ((scope='company' AND scope_id='') OR (scope='user' AND scope_id=$3))`, [d, kind, personId, n]);
  }
}

export class MediaJobRepo {
  constructor(private readonly pool: Pool) {}

  async add(j: NewMediaJob): Promise<string> {
    return (await this.pool.query<{ id: string }>(
      `INSERT INTO media_jobs (op_name, requester_id, actor, channel_id, thread_id, task_id, reserved_usd, seconds, tainted) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [j.opName, j.requesterId, JSON.stringify(j.actor), j.channelId, j.threadId, j.taskId, j.reservedUsd, j.seconds, j.tainted],
    )).rows[0]!.id;
  }
  async get(id: string): Promise<MediaJob | null> {
    return (await this.pool.query<MediaJob>(`SELECT ${COLS} FROM media_jobs WHERE id=$1`, [id])).rows[0] ?? null;
  }
  async open(): Promise<MediaJob[]> {
    return (await this.pool.query<MediaJob>(`SELECT ${COLS} FROM media_jobs WHERE status IN ('running','posting') ORDER BY created_at`)).rows;
  }
  /** At-most-once: only one caller moves running -> posting. */
  async claimPost(id: string): Promise<boolean> {
    return (await this.pool.query(`UPDATE media_jobs SET status='posting' WHERE id=$1 AND status='running'`, [id])).rowCount === 1;
  }
  /** Ends a job from `from` (default running); false when it was already ended by someone else. */
  async finish(id: string, status: 'posted' | 'failed' | 'blocked' | 'cancelled', from: 'running' | 'posting' = 'running'): Promise<boolean> {
    return (await this.pool.query(`UPDATE media_jobs SET status=$2, finished_at=now() WHERE id=$1 AND status=$3`, [id, status, from])).rowCount === 1;
  }
}
