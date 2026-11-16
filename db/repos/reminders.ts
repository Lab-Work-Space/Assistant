import type { Pool } from '../pool.js';
import { addCapped, type Caps } from './praw.js';

export interface Reminder {
  id: number; guildId: string; channelId: string; userId: string; text: string;
  remindAt: Date; everyMinutes: number | null; advanceMinutes: number | null; notifyVia: 'dm' | 'channel';
  claimedAt: Date | null; retried: boolean; advanceClaimedFor: Date | null; firedAt: Date | null; cancelled: boolean; legacyId: number | null; createdAt: Date;
}
/** A claimed reminder; `dueAt` is the time it was due (recurring rows have already moved on). */
export type ClaimedReminder = Reminder & { dueAt: Date };
export interface NewReminder {
  guildId: string; channelId: string; userId: string; text: string; remindAt: Date;
  everyMinutes?: number | null; advanceMinutes?: number | null; notifyVia?: 'dm' | 'channel'; legacyId?: number | null;
}

const cols = (a = ''): string => `${a}id, ${a}guild_id AS "guildId", ${a}channel_id AS "channelId", ${a}user_id AS "userId", ${a}text, ${a}remind_at AS "remindAt",
  ${a}every_minutes AS "everyMinutes", ${a}advance_minutes AS "advanceMinutes", ${a}notify_via AS "notifyVia", ${a}claimed_at AS "claimedAt", ${a}retried, ${a}advance_claimed_for AS "advanceClaimedFor",
  ${a}fired_at AS "firedAt", ${a}cancelled, ${a}legacy_id AS "legacyId", ${a}created_at AS "createdAt"`;
const COLS = cols();
/** Rows that still count toward caps: not cancelled, and recurring or not yet fired. */
const LIVE = 'NOT cancelled AND (every_minutes IS NOT NULL OR fired_at IS NULL)';

export class ReminderRepo {
  constructor(private readonly pool: Pool) {}

  /** Null when legacyId already exists. Throws CapError past the caps (counted atomically with the insert). */
  async add(r: NewReminder, caps: Caps | 'unlimited'): Promise<Reminder | null> {
    return addCapped<Reminder>(this.pool, 'reminders', LIVE, r.userId, caps, async (q) =>
      (await q(
        `INSERT INTO reminders (guild_id, channel_id, user_id, text, remind_at, every_minutes, advance_minutes, notify_via, legacy_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (legacy_id) DO NOTHING RETURNING ${COLS}`,
        [r.guildId, r.channelId, r.userId, r.text, r.remindAt, r.everyMinutes ?? null, r.advanceMinutes ?? null, r.notifyVia ?? 'channel', r.legacyId ?? null],
      )).rows[0] ?? null);
  }

  async list(userId: string): Promise<Reminder[]> {
    return (await this.pool.query<Reminder>(`SELECT ${COLS} FROM reminders WHERE user_id = $1 AND ${LIVE} ORDER BY remind_at, id`, [userId])).rows;
  }

  /** Owner only (P14); false when the id is not the user's, already cancelled or does not exist. */
  async cancel(id: number, userId: string): Promise<boolean> {
    return (await this.pool.query('UPDATE reminders SET cancelled = true WHERE id = $1 AND user_id = $2 AND NOT cancelled', [id, userId])).rowCount === 1;
  }

  async get(id: number): Promise<Reminder | null> {
    return (await this.pool.query<Reminder>(`SELECT ${COLS} FROM reminders WHERE id = $1`, [id])).rows[0] ?? null;
  }

  /** Admin removal of any reminder (the slash command checks the role and audits); false when absent or already cancelled. */
  async cancelAny(id: number): Promise<boolean> {
    return (await this.pool.query('UPDATE reminders SET cancelled = true WHERE id = $1 AND NOT cancelled', [id])).rowCount === 1;
  }

  /**
   * Task 16: a one-off claimed more than `olderThanMs` ago and never marked fired (the process died, or the post failed) is
   * claimed again, once (`retried`). Recurring rows are not retried (their claim already moved remind_at on).
   */
  async reclaimStale(at: Date, olderThanMs: number, limit: number): Promise<ClaimedReminder[]> {
    return (await this.pool.query<ClaimedReminder>(
      `WITH stale AS (
         SELECT id FROM reminders
         WHERE NOT cancelled AND every_minutes IS NULL AND claimed_at IS NOT NULL AND fired_at IS NULL AND NOT retried
           AND claimed_at <= $1::timestamptz - $2 * interval '1 millisecond'
         ORDER BY claimed_at, id LIMIT $3 FOR UPDATE SKIP LOCKED)
       UPDATE reminders r SET claimed_at = $1, retried = true FROM stale WHERE r.id = stale.id
       RETURNING ${cols('r.')}, r.remind_at AS "dueAt"`,
      [at, olderThanMs, limit])).rows;
  }

  /**
   * R11/PF12: one statement claims due rows. One-off rows set claimed_at; recurring rows advance remind_at to the first
   * slot after `at` (no catch-up burst). Fire-once caveat (M6): a claimed row whose delivery crashes is re-sent once by reclaimStale. SKIP LOCKED + the guards mean concurrent callers never get the same row.
   */
  async claimDue(at: Date, limit: number): Promise<ClaimedReminder[]> {
    return (await this.pool.query<ClaimedReminder>(
      `WITH due AS (
         SELECT id, remind_at AS due_at FROM reminders
         WHERE NOT cancelled AND remind_at <= $1 AND (every_minutes IS NOT NULL OR (claimed_at IS NULL AND fired_at IS NULL))
         ORDER BY remind_at, id LIMIT $2 FOR UPDATE SKIP LOCKED)
       UPDATE reminders r SET
         claimed_at = CASE WHEN r.every_minutes IS NULL THEN $1::timestamptz ELSE r.claimed_at END,
         remind_at = CASE WHEN r.every_minutes IS NULL THEN r.remind_at
           ELSE r.remind_at + (floor(extract(epoch FROM ($1::timestamptz - r.remind_at)) / 60 / r.every_minutes) + 1) * r.every_minutes * interval '1 minute' END
       FROM due WHERE r.id = due.id
       RETURNING ${cols('r.')}, due.due_at AS "dueAt"`,
      [at, limit],
    )).rows;
  }

  /**
   * R9 advance notice: claims rows whose remind_at - advance_minutes has passed, once per occurrence (advance_claimed_for
   * is set to remind_at in the same locked UPDATE). Fire-once caveat (M6): a claim whose delivery then crashes is not
   * retried here; an advance notice is not retried.
   */
  async claimAdvanceDue(at: Date, limit: number): Promise<Reminder[]> {
    return (await this.pool.query<Reminder>(
      `WITH due AS (
         SELECT id FROM reminders
         WHERE NOT cancelled AND advance_minutes IS NOT NULL AND remind_at > $1
           AND remind_at - advance_minutes * interval '1 minute' <= $1
           AND advance_claimed_for IS DISTINCT FROM remind_at
           AND (every_minutes IS NOT NULL OR (claimed_at IS NULL AND fired_at IS NULL))
         ORDER BY remind_at, id LIMIT $2 FOR UPDATE SKIP LOCKED)
       UPDATE reminders r SET advance_claimed_for = r.remind_at FROM due WHERE r.id = due.id RETURNING ${cols('r.')}`,
      [at, limit])).rows;
  }

  /** After delivery: stamps fired_at. With `next`, the row stays live and moves to that time (claim and fired cleared). */
  async markFired(id: number, next?: Date): Promise<void> {
    if (next) await this.pool.query('UPDATE reminders SET claimed_at = NULL, fired_at = NULL, remind_at = $2 WHERE id = $1', [id, next]);
    else await this.pool.query('UPDATE reminders SET fired_at = now() WHERE id = $1', [id]);
  }
}
