import type { Pool } from '../pool.js';

export interface DeployJobRow { job: string; cardId: string; op: string; channelId: string; createdAt: Date }

/**
 * Migration 016. `deploy_uploads`: the main application stores a packed static site (content-addressed), the executor reads and deletes it.
 * `deploy_jobs`: the executor's own record of jobs it queued on the VPS, so a restart resumes polling. Ids and digests only; no secret.
 */
export class DeployRepo {
  constructor(private readonly pool: Pool) {}

  async putUpload(sha256: string, data: Buffer, proposerId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO deploy_uploads (sha256, size, data, proposer_id) VALUES ($1, $2, $3, $4) ON CONFLICT (sha256) DO NOTHING`,
      [sha256, data.length, data, proposerId],
    );
  }
  async getUpload(sha256: string): Promise<{ size: number; data: Buffer } | null> {
    const r = await this.pool.query<{ size: number; data: Buffer }>('SELECT size, data FROM deploy_uploads WHERE sha256 = $1', [sha256]);
    return r.rows[0] ?? null;
  }
  async deleteUpload(sha256: string): Promise<void> {
    await this.pool.query('DELETE FROM deploy_uploads WHERE sha256 = $1', [sha256]);
  }

  async addJob(job: string, cardId: string, op: string, channelId: string): Promise<void> {
    await this.pool.query('INSERT INTO deploy_jobs (job, card_id, op, channel_id) VALUES ($1, $2, $3, $4) ON CONFLICT (job) DO NOTHING', [job, cardId, op, channelId]);
  }
  async finishJob(job: string, status: 'done' | 'failed' | 'lost'): Promise<void> {
    await this.pool.query(`UPDATE deploy_jobs SET status = $2, finished_at = now() WHERE job = $1 AND status = 'queued'`, [job, status]);
  }
  async openJobs(): Promise<DeployJobRow[]> {
    return (await this.pool.query<DeployJobRow>(`SELECT job, card_id AS "cardId", op, channel_id AS "channelId", created_at AS "createdAt" FROM deploy_jobs WHERE status = 'queued' ORDER BY created_at`)).rows;
  }
  /** Old uploads (a card lives 15 minutes) and finished jobs. */
  async purge(): Promise<void> {
    await this.pool.query(`DELETE FROM deploy_uploads WHERE created_at < now() - interval '1 day'`);
    await this.pool.query(`DELETE FROM deploy_jobs WHERE status <> 'queued' AND finished_at < now() - interval '7 days'`);
  }
}
