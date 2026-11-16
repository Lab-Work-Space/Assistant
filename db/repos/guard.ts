import type { GuardRow, GuardStore } from '../../agents/team/warroom.js';
import { AI_WARROOM_CHANNEL_ID } from '../../company/channels.js';
import type { Pool } from '../pool.js';

const SNOWFLAKE = /^[0-9]{17,20}$/;

/**
 * Gate 1 WS4: the stall counters of the bot-talk guard per channel or thread, so a restart does not lift a stall. Counters and flags only,
 * never message text. A key that is not a snowflake (a synthetic id) is not stored.
 */
export class GuardStateRepo implements GuardStore {
  constructor(private readonly pool: Pool) {}

  async get(key: string): Promise<GuardRow | null> {
    if (!SNOWFLAKE.test(key)) return null;
    const r = (await this.pool.query<GuardRow>(
      `SELECT run_count AS count, stalled, ceo_turn AS "ceoTurn", reset_used AS "resetUsed",
              (extract(epoch FROM last_bot_turn_at) * 1000)::float8 AS "lastBotTurnAt", quiet_lifts AS "quietLifts", person_lifts AS "personLifts", lift_day AS "liftDay"
         FROM guard_state WHERE key = $1`, [key],
    )).rows[0];
    return r ?? null;
  }

  async put(key: string, row: GuardRow): Promise<void> {
    if (!SNOWFLAKE.test(key)) return;
    await this.pool.query(
      `INSERT INTO guard_state (key, run_count, stalled, ceo_turn, reset_used, touched_at, last_bot_turn_at, quiet_lifts, person_lifts, lift_day)
       VALUES ($1,$2,$3,$4,$5, now(), CASE WHEN $6::float8 IS NULL THEN NULL ELSE to_timestamp($6::float8 / 1000) END, $7, $8, $9)
       ON CONFLICT (key) DO UPDATE SET run_count = EXCLUDED.run_count, stalled = EXCLUDED.stalled, ceo_turn = EXCLUDED.ceo_turn, reset_used = EXCLUDED.reset_used, touched_at = now(),
         last_bot_turn_at = EXCLUDED.last_bot_turn_at, quiet_lifts = EXCLUDED.quiet_lifts, person_lifts = EXCLUDED.person_lifts, lift_day = EXCLUDED.lift_day`,
      [key, row.count, row.stalled, row.ceoTurn, row.resetUsed, row.lastBotTurnAt ?? null, row.quietLifts ?? 0, row.personLifts ?? 0, row.liftDay ?? null],
    );
  }

  /** HL-C2: the #ai-warroom row is never pruned, so its lift counters survive an idle night. */
  async prune(before: Date): Promise<void> {
    await this.pool.query('DELETE FROM guard_state WHERE touched_at < $1 AND key <> $2', [before, AI_WARROOM_CHANNEL_ID]);
  }
}
