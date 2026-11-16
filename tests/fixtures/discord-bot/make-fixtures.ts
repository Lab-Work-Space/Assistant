import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Builds the old Discord_bot SQLite files in a temp dir from the DDL in Discord_bot/storage/*.py (no committed binaries).
 * File names are the DB_PATH values pinned in Task 22 Step 0.
 */
export const FILES = { reminders: 'reminders.sqlite3', tasks: 'scheduled_tasks.sqlite3', watches: 'watches.sqlite3', lessons: 'lessons.sqlite3', history: 'chat_history.sqlite3' } as const;

const DDL = {
  reminders: `CREATE TABLE reminders (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id INTEGER NOT NULL, channel_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
    text TEXT NOT NULL, remind_at REAL NOT NULL, created_at REAL NOT NULL, fired INTEGER NOT NULL DEFAULT 0,
    advance_minutes INTEGER NOT NULL DEFAULT 0, advance_fired INTEGER NOT NULL DEFAULT 0, notify_via TEXT NOT NULL DEFAULT 'channel')`,
  tasks: `CREATE TABLE scheduled_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id INTEGER NOT NULL, channel_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
    prompt TEXT NOT NULL, schedule_kind TEXT NOT NULL, daily_hhmm TEXT, interval_minutes INTEGER, next_run_at REAL NOT NULL, created_at REAL NOT NULL, active INTEGER NOT NULL DEFAULT 1)`,
  watches: `CREATE TABLE watches (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id INTEGER NOT NULL, channel_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
    kind TEXT NOT NULL, target TEXT NOT NULL, interval_minutes INTEGER NOT NULL, next_check_at REAL NOT NULL, last_snapshot TEXT, last_hrefs_json TEXT,
    has_baseline INTEGER NOT NULL DEFAULT 0, created_at REAL NOT NULL, active INTEGER NOT NULL DEFAULT 1)`,
  lessons: `CREATE TABLE lessons (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, source TEXT NOT NULL, created_at REAL NOT NULL, active INTEGER NOT NULL DEFAULT 1)`,
  history: `CREATE TABLE history (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL)`,
} as const;

export type FixtureRow = Record<string, string | number | bigint | null>;
export type FixtureSpec = Partial<Record<keyof typeof FILES, FixtureRow[]>>;

export function makeFixtureDir(spec: FixtureSpec): string {
  const dir = mkdtempSync(join(tmpdir(), 'discord-bot-'));
  for (const name of Object.keys(spec) as (keyof typeof FILES)[]) {
    const db = new DatabaseSync(join(dir, FILES[name]));
    db.exec(DDL[name]);
    const table = name === 'tasks' ? 'scheduled_tasks' : name === 'history' ? 'history' : name;
    for (const r of spec[name]!) {
      const cols = Object.keys(r);
      db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...(Object.values(r) as never[]));
    }
    db.close();
  }
  return dir;
}
