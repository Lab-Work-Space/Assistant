import type { Pool } from '../pool.js';
import type { MusicState, MusicStore } from '../../voice/music/queue.js';

/** music_state (migration 010): one row per guild. The queue validates rows again when it restores them. */
export class MusicStateRepo implements MusicStore {
  constructor(private readonly pool: Pool, private readonly guildId: string) {}

  async load(): Promise<MusicState | null> {
    const r = await this.pool.query<{ queue: MusicState['queue']; volume: number; paused: boolean }>(
      'SELECT queue, volume, paused FROM music_state WHERE guild_id = $1', [this.guildId]);
    const row = r.rows[0];
    return row ? { queue: row.queue, volume: row.volume, paused: row.paused } : null;
  }

  async save(s: MusicState): Promise<void> {
    await this.pool.query(
      `INSERT INTO music_state (guild_id, queue, volume, paused, updated_at) VALUES ($1, $2::jsonb, $3, $4, now())
       ON CONFLICT (guild_id) DO UPDATE SET queue = EXCLUDED.queue, volume = EXCLUDED.volume, paused = EXCLUDED.paused, updated_at = now()`,
      [this.guildId, JSON.stringify(s.queue), s.volume, s.paused]);
  }
}
