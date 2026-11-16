import type { Pool } from '../pool.js';

/** TEAMTALK-1: what a persona room recorded. Only code paths write these rows (never a Discord read); `tainted` is the producing run's taint. */
export type RoomKind = 'assigned' | 'done' | 'blocked' | 'cancelled' | 'idea' | 'decision';
export const LIFECYCLE_KINDS: readonly RoomKind[] = ['assigned', 'done', 'blocked', 'cancelled'];
/** DEFECT-1: only these count toward ROOM_LIFECYCLE_MAX; the terminal kinds are reserved (one line per task each) so a task blocked often still records its end. */
export const COUNTED_LIFECYCLE_KINDS: readonly RoomKind[] = ['assigned', 'blocked'];
export const TERMINAL_KINDS: readonly RoomKind[] = ['done', 'cancelled'];
export const ROOM_TERMINAL_MAX = 1;
export const NOTE_KINDS: readonly RoomKind[] = ['idea', 'decision'];
/** T12: per task, counted in the database so a restart does not reset it. */
export const ROOM_LIFECYCLE_MAX = 4;
export const ROOM_NOTES_MAX = 6;
/** Rows kept per persona; older ones are pruned on insert. */
export const ROOM_RETAIN = 200;
export const ROOM_BODY_MAX = 400;

export interface RoomEntry {
  id: number;
  personaId: string;
  deptId: string;
  kind: RoomKind;
  taskId: string | null;
  body: string;
  tainted: boolean;
  messageId: string | null;
  createdAt: Date;
}
export type NewRoomEntry = Pick<RoomEntry, 'personaId' | 'deptId' | 'kind' | 'taskId' | 'body' | 'tainted'>;

export interface RoomEntryStore {
  /** Inserts the row unless `cap` kinds already have `cap.max` rows for the same task (then null). `body` is cut to ROOM_BODY_MAX here. */
  add(e: NewRoomEntry, cap?: { kinds: readonly RoomKind[]; max: number }): Promise<RoomEntry | null>;
  setMessage(id: number, messageId: string): Promise<void>;
  /** The newest `limit` rows of these personas, oldest first (the newest fact reads last). */
  recent(personaIds: readonly string[], limit: number): Promise<RoomEntry[]>;
  /** The newest `limit` rows of one persona with one of `kinds`, newest first. */
  last(personaId: string, kinds: readonly RoomKind[], limit: number): Promise<RoomEntry[]>;
}

const COLS = `id, persona_id AS "personaId", dept_id AS "deptId", kind, task_id AS "taskId", body, tainted, message_id AS "messageId", created_at AS "createdAt"`;
const SNOWFLAKE = /^[0-9]{17,20}$/;

export class RoomEntryRepo implements RoomEntryStore {
  constructor(private readonly pool: Pool) {}

  async add(e: NewRoomEntry, cap?: { kinds: readonly RoomKind[]; max: number }): Promise<RoomEntry | null> {
    const body = e.body.slice(0, ROOM_BODY_MAX);
    if (body.trim() === '') return null;
    const vals: unknown[] = [e.personaId, e.deptId, e.kind, e.taskId, body, e.tainted];
    let guard = '';
    if (cap && e.taskId !== null) {
      vals.push(cap.kinds, cap.max);
      guard = ' WHERE (SELECT count(*) FROM room_entries WHERE task_id = $4 AND kind = ANY($7)) < $8';
    }
    const r = await this.pool.query<RoomEntry>(
      `INSERT INTO room_entries (persona_id, dept_id, kind, task_id, body, tainted) SELECT $1,$2,$3,$4,$5,$6${guard} RETURNING ${COLS}`, vals,
    );
    const row = r.rows[0] ?? null;
    if (row) {
      await this.pool.query(
        `DELETE FROM room_entries WHERE persona_id = $1 AND id NOT IN (SELECT id FROM room_entries WHERE persona_id = $1 ORDER BY id DESC LIMIT $2)`,
        [e.personaId, ROOM_RETAIN],
      );
    }
    return row;
  }

  async setMessage(id: number, messageId: string): Promise<void> {
    if (!SNOWFLAKE.test(messageId)) return;
    await this.pool.query('UPDATE room_entries SET message_id = $2 WHERE id = $1', [id, messageId]);
  }

  async recent(personaIds: readonly string[], limit: number): Promise<RoomEntry[]> {
    if (!personaIds.length) return [];
    const r = await this.pool.query<RoomEntry>(`SELECT ${COLS} FROM room_entries WHERE persona_id = ANY($1) ORDER BY id DESC LIMIT $2`, [personaIds, Math.max(1, Math.floor(limit))]);
    return r.rows.reverse();
  }

  async last(personaId: string, kinds: readonly RoomKind[], limit: number): Promise<RoomEntry[]> {
    return (await this.pool.query<RoomEntry>(`SELECT ${COLS} FROM room_entries WHERE persona_id = $1 AND kind = ANY($2) ORDER BY id DESC LIMIT $3`, [personaId, kinds, Math.max(1, Math.floor(limit))])).rows;
  }
}
