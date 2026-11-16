import { CONFIG_DEFAULTS } from '../config/defaults.js';
import { ConfigSchema } from '../config/schema.js';
import type { Pool } from '../db/pool.js';

/** The tier config the executor reads ITSELF (T1, T10): straight from the config table, never from the main application or a card. */
export interface TierConfig {
  managerId: string | null;
  moderatorId: string | null;
  modRoomId: string | null;
}

const KEYS = ['roles.managerId', 'roles.moderatorId', 'roles.modRoomId'] as const;

/** An invalid or missing stored value reads as null (that tier is off): fail closed. A database error is thrown, and the caller refuses. */
export async function readTierConfig(pool: Pool): Promise<TierConfig> {
  const rows = await pool.query<{ key: string; value: unknown }>('SELECT key, value FROM config WHERE key = ANY($1::text[])', [[...KEYS]]);
  const raw = new Map(rows.rows.map((r) => [r.key, r.value]));
  const pick = (k: (typeof KEYS)[number]): string | null => {
    const v = raw.has(k) ? ConfigSchema[k].safeParse(raw.get(k)) : null;
    return v?.success ? v.data : (CONFIG_DEFAULTS[k] as string | null);
  };
  return { managerId: pick('roles.managerId'), moderatorId: pick('roles.moderatorId'), modRoomId: pick('roles.modRoomId') };
}

export const NO_TIERS: TierConfig = { managerId: null, moderatorId: null, modRoomId: null };
