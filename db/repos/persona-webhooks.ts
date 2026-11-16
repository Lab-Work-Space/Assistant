import type { DeptId } from '../../core/index.js';
import type { Pool } from '../pool.js';

export interface PersonaWebhook {
  channelId: string;
  webhookId: string;
  applicationId: string;
  deptId: DeptId;
}

const SELECT = `SELECT channel_id AS "channelId", webhook_id AS "webhookId", application_id AS "applicationId",
  dept_id AS "deptId" FROM persona_webhooks`;

export class PersonaWebhookRepo {
  constructor(private readonly pool: Pool) {}

  async getByChannel(channelId: string): Promise<PersonaWebhook | null> {
    return (await this.pool.query<PersonaWebhook>(`${SELECT} WHERE channel_id = $1`, [channelId])).rows[0] ?? null;
  }

  async getByWebhookId(webhookId: string): Promise<PersonaWebhook | null> {
    return (await this.pool.query<PersonaWebhook>(`${SELECT} WHERE webhook_id = $1`, [webhookId])).rows[0] ?? null;
  }

  async upsert(w: PersonaWebhook): Promise<void> {
    await this.pool.query(
      `INSERT INTO persona_webhooks (channel_id, webhook_id, application_id, dept_id) VALUES ($1,$2,$3,$4)
       ON CONFLICT (channel_id) DO UPDATE SET webhook_id = EXCLUDED.webhook_id,
         application_id = EXCLUDED.application_id, dept_id = EXCLUDED.dept_id`,
      [w.channelId, w.webhookId, w.applicationId, w.deptId],
    );
  }
}
