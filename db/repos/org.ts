import type { Pool } from '../pool.js';

export interface Department {
  id: string;
  name: string;
  categoryNamePattern: string;
  workChannelId: string | null;
  color: number;
  model: string | null;
  provider: string | null;
  enabled: boolean;
}

export interface Persona {
  id: string;
  deptId: string;
  name: string;
  avatarUrl: string | null;
  promptRef: string;
  model: string | null;
  provider: string | null;
  tools: string[];
  directChannelId: string | null;
  enabled: boolean;
}

export interface ChannelMapping {
  channelId: string;
  deptId: string;
  isWork: boolean;
}

const DEPT = `SELECT id, name, category_name_pattern AS "categoryNamePattern", work_channel_id AS "workChannelId",
  color, model, provider, enabled FROM departments`;
const PERSONA = `SELECT id, dept_id AS "deptId", name, avatar_url AS "avatarUrl", prompt_ref AS "promptRef", model,
  provider, tools, direct_channel_id AS "directChannelId", enabled FROM personas`;

export class DepartmentRepo {
  constructor(private readonly pool: Pool) {}
  async get(id: string): Promise<Department | null> {
    return (await this.pool.query<Department>(`${DEPT} WHERE id = $1`, [id])).rows[0] ?? null;
  }
  async list(): Promise<Department[]> {
    return (await this.pool.query<Department>(`${DEPT} ORDER BY id`)).rows;
  }
  async upsert(d: Department): Promise<void> {
    await this.pool.query(
      `INSERT INTO departments (id, name, category_name_pattern, work_channel_id, color, model, provider, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name,
       category_name_pattern = EXCLUDED.category_name_pattern, work_channel_id = EXCLUDED.work_channel_id,
       color = EXCLUDED.color, model = EXCLUDED.model, provider = EXCLUDED.provider, enabled = EXCLUDED.enabled`,
      [d.id, d.name, d.categoryNamePattern, d.workChannelId, d.color, d.model, d.provider, d.enabled],
    );
  }
}

export class PersonaRepo {
  constructor(private readonly pool: Pool) {}
  async get(id: string): Promise<Persona | null> {
    return (await this.pool.query<Persona>(`${PERSONA} WHERE id = $1`, [id])).rows[0] ?? null;
  }
  async list(deptId?: string): Promise<Persona[]> {
    return deptId
      ? (await this.pool.query<Persona>(`${PERSONA} WHERE dept_id = $1 ORDER BY id`, [deptId])).rows
      : (await this.pool.query<Persona>(`${PERSONA} ORDER BY id`)).rows;
  }
  async upsert(p: Persona): Promise<void> {
    await this.pool.query(
      `INSERT INTO personas (id, dept_id, name, avatar_url, prompt_ref, model, provider, tools, direct_channel_id, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO UPDATE SET dept_id = EXCLUDED.dept_id,
       name = EXCLUDED.name, avatar_url = EXCLUDED.avatar_url, prompt_ref = EXCLUDED.prompt_ref,
       model = EXCLUDED.model, provider = EXCLUDED.provider, tools = EXCLUDED.tools,
       direct_channel_id = EXCLUDED.direct_channel_id, enabled = EXCLUDED.enabled`,
      [p.id, p.deptId, p.name, p.avatarUrl, p.promptRef, p.model, p.provider, p.tools, p.directChannelId, p.enabled],
    );
  }
  async delete(id: string): Promise<void> {
    await this.pool.query('DELETE FROM personas WHERE id = $1', [id]);
  }
}

export class ChannelMapRepo {
  constructor(private readonly pool: Pool) {}
  async get(channelId: string): Promise<ChannelMapping | null> {
    return (
      (
        await this.pool.query<ChannelMapping>(
          'SELECT channel_id AS "channelId", dept_id AS "deptId", is_work AS "isWork" FROM channel_map WHERE channel_id = $1',
          [channelId],
        )
      ).rows[0] ?? null
    );
  }
  async list(): Promise<ChannelMapping[]> {
    return (
      await this.pool.query<ChannelMapping>(
        'SELECT channel_id AS "channelId", dept_id AS "deptId", is_work AS "isWork" FROM channel_map ORDER BY channel_id',
      )
    ).rows;
  }
  async upsert(m: ChannelMapping): Promise<void> {
    await this.pool.query(
      `INSERT INTO channel_map (channel_id, dept_id, is_work) VALUES ($1,$2,$3)
       ON CONFLICT (channel_id) DO UPDATE SET dept_id = EXCLUDED.dept_id, is_work = EXCLUDED.is_work`,
      [m.channelId, m.deptId, m.isWork],
    );
  }
  async delete(channelId: string): Promise<void> {
    await this.pool.query('DELETE FROM channel_map WHERE channel_id = $1', [channelId]);
  }
}
