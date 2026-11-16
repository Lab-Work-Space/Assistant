import type { Pool } from '../db/pool.js';
import type { Tier } from '../discord/tiers.js';

/** Gate 1 S30: caps counted from audit rows (so they survive a restart), per op, not per card. */
export const RATE = { perAdmin10m: 20, global10m: 40, destructiveHour: 10 } as const;

/**
 * Delegated tiers (T19): a per-user cap of applied ops per 10 minutes and a destructive cap per hour for each tier, counted in that tier's OWN bucket
 * (so a raid of Moderator bulk deletes cannot use up the Bot Admin budget); the global 40 per 10 minutes stays a ceiling over everyone.
 */
export const TIER_RATE: Record<Tier, { perUser10m: number; destructiveHour: number }> = {
  bot_admin: { perUser10m: RATE.perAdmin10m, destructiveHour: RATE.destructiveHour },
  manager: { perUser10m: 20, destructiveHour: 10 },
  moderator: { perUser10m: 10, destructiveHour: 5 },
};

/** Audit actions of the ops that count as destructive (ban, kick, bulk delete, channel delete, AutoMod disable/delete). */
export const DESTRUCTIVE_ACTIONS = ['server.member.ban', 'server.member.kick', 'server.msg.bulk', 'server.channel.delete', 'server.automod.disable', 'server.automod.delete'] as const;

export interface RateGate {
  /** Null when `ops` more applied ops (of which `destructive` are destructive) by this admin still fit under every cap, else why not. */
  check(adminId: string, ops: number, destructive: number, tier?: Tier): Promise<string | null>;
}

export function createRateGate(pool: Pool): RateGate {
  return {
    async check(adminId, ops, destructive, tier = 'bot_admin') {
      const cap = TIER_RATE[tier];
      // The tier of a row is the anchored ` tier:<x>` suffix the executor writes on the ACTOR (ids and enums only, never user text); an untagged older row is a Bot Admin row.
      const r = await pool.query<{ mine: number; total: number; destr: number }>(
        `SELECT count(*) FILTER (WHERE actor LIKE $1 AND ts > now() - interval '10 minutes')::int AS mine,
                count(*) FILTER (WHERE ts > now() - interval '10 minutes')::int AS total,
                count(*) FILTER (WHERE action = ANY($2::text[]) AND coalesce(substring(actor from ' tier:([a-z_]+)$'), 'bot_admin') = $3)::int AS destr
         FROM audit_log
         WHERE ts > now() - interval '1 hour' AND outcome LIKE 'ok%' AND (action LIKE 'perm.%' OR action LIKE 'server.%')`,
        [`user:${adminId} %`, [...DESTRUCTIVE_ACTIONS], tier],
      );
      const c = r.rows[0]!;
      if (c.mine + ops > cap.perUser10m) return `rate limit: at most ${cap.perUser10m} applied operations per ${tier === 'bot_admin' ? 'admin' : tier} per 10 minutes (${c.mine} so far)`;
      if (c.total + ops > RATE.global10m) return `rate limit: at most ${RATE.global10m} applied operations in 10 minutes in total (${c.total} so far)`;
      if (destructive > 0 && c.destr + destructive > cap.destructiveHour) return `rate limit: at most ${cap.destructiveHour} destructive operations (ban, kick, bulk delete, channel delete, AutoMod disable or delete) per hour for ${tier === 'bot_admin' ? 'Bot Admins' : `a ${tier}`} (${c.destr} so far)`;
      return null;
    },
  };
}
