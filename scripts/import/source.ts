import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** File names pinned in Task 22 Step 0 (DB_PATH in Discord_bot/storage/*.py). chat_history.sqlite3 (history_store) is deliberately absent: never opened. */
export const SOURCE_FILES = { reminders: 'reminders.sqlite3', scheduled_tasks: 'scheduled_tasks.sqlite3', watches: 'watches.sqlite3', lessons: 'lessons.sqlite3' } as const;

export type SourceRow = Record<string, unknown>;

/** A source-file problem; its message names the file and table only, so it is safe to print (P21). */
export class SourceError extends Error {
  override readonly name = 'SourceError';
}

/** P21: the path must be a regular file, not a symlink, and is opened `readOnly: true`. Errors name the file, never its content. */
export function readSource(dir: string, file: string, table: string): SourceRow[] {
  const path = join(dir, file);
  let st;
  try {
    st = lstatSync(path);
  } catch {
    throw new SourceError(`${file} not found in --from directory`);
  }
  if (st.isSymbolicLink()) throw new SourceError(`${file} is a symlink; refusing to open it`);
  if (!st.isFile()) throw new SourceError(`${file} is not a regular file`);
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const stmt = db.prepare(`SELECT * FROM ${table} ORDER BY id`);
    stmt.setReadBigInts(true); // Discord snowflakes exceed 2^53
    return stmt.all() as SourceRow[];
  } catch {
    throw new SourceError(`${file} could not be read as the old ${table} table`);
  } finally {
    db?.close();
  }
}

/** SQLite integers come back as bigint (setReadBigInts); REAL as number. */
export const num = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : NaN);
export const idText = (v: unknown): string => (typeof v === 'bigint' || typeof v === 'number' ? String(v) : '');
export const str = (v: unknown): string => (typeof v === 'string' ? v : '');
