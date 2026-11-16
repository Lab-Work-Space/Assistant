import { pathToFileURL } from 'node:url';
import { CONFIG_DEFAULTS } from '../config/defaults.js';
import { createPool } from '../db/pool.js';
import type { Pool } from '../db/pool.js';
import { JobRepo } from '../db/repos/jobs.js';
import { LessonRepo } from '../db/repos/lessons.js';
import { ReminderRepo } from '../db/repos/reminders.js';
import { WatchRepo } from '../db/repos/watches.js';
import type { Resolver } from '../net/guard.js';
import { systemResolver } from '../net/system.js';
import { mapJob, mapLesson, mapReminder, mapWatch, type Ctx, type Mapped, type Repos } from './import/map.js';
import { redactText } from '../core/logger.js';
import { readSource, SourceError, SOURCE_FILES, type SourceRow } from './import/source.js';

/**
 * Task 22 / AC7 / Gate 1 P21: one-off import of the old Discord_bot SQLite files. Operator shell only (never reachable from Discord).
 * Reports counts only: row content is PII and never printed. Rows are keyed on legacy_id, so a repeat run inserts nothing.
 */
export interface TableReport { table: string; read: number; wouldInsert: number; inserted: number; skippedFields: string[]; error?: string }
export interface ImportOptions {
  from: string; pool: Pool; apply: boolean; tz?: string; now?: () => Date;
  /** Defaults to GUILD_ID. */
  guildId?: string;
  /** SSRF resolver for watch urls; defaults to the system resolver. */
  resolver?: Resolver;
}

const TABLES = ['reminders', 'scheduled_tasks', 'watches', 'lessons'] as const;
const TARGET = { reminders: 'reminders', scheduled_tasks: 'scheduled_jobs', watches: 'watches', lessons: 'lessons' } as const;

export async function importDiscordBot(o: ImportOptions): Promise<TableReport[]> {
  const tz = o.tz ?? CONFIG_DEFAULTS['schedule.timezone'];
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { throw new Error(`unknown time zone: ${tz}`); }
  const guildId = o.guildId ?? process.env.GUILD_ID;
  if (!guildId) throw new Error('GUILD_ID is required');
  const ctx: Ctx = { guildId, tz, nowMs: (o.now ?? (() => new Date()))().getTime(), resolver: o.resolver ?? systemResolver, lessonMax: CONFIG_DEFAULTS['lessons.perLessonChars'] };
  const repos: Repos = { reminders: new ReminderRepo(o.pool), jobs: new JobRepo(o.pool), watches: new WatchRepo(o.pool), lessons: new LessonRepo(o.pool) };
  const mappers: Record<(typeof TABLES)[number], (r: SourceRow) => Mapped | Promise<Mapped>> = {
    reminders: (r) => mapReminder(r, ctx), scheduled_tasks: (r) => mapJob(r, ctx), watches: (r) => mapWatch(r, ctx), lessons: (r) => mapLesson(r, ctx),
  };
  const out: TableReport[] = [];
  for (const table of TABLES) {
    const rep: TableReport = { table, read: 0, wouldInsert: 0, inserted: 0, skippedFields: [] };
    out.push(rep);
    try {
      const rows = readSource(o.from, SOURCE_FILES[table], table);
      rep.read = rows.length;
      const tally = new Map<string, number>();
      const bump = (k: string) => tally.set(k, (tally.get(k) ?? 0) + 1);
      const ok: Extract<Mapped, { add: unknown }>[] = [];
      for (const row of rows) {
        let m: Mapped;
        try {
          m = await mappers[table](row);
        } catch {
          bump('map_failed'); // one bad row never stops the table, and its content is never printed
          continue;
        }
        if ('skip' in m) bump(m.skip);
        else { ok.push(m); m.notes.forEach(bump); }
      }
      const have = new Set((await o.pool.query<{ legacy_id: string }>(`SELECT legacy_id FROM ${TARGET[table]} WHERE legacy_id IS NOT NULL`)).rows.map((r) => Number(r.legacy_id)));
      const fresh = ok.filter((m) => !have.has(m.legacyId));
      rep.wouldInsert = fresh.length;
      if (o.apply) {
        for (const m of fresh) {
          try {
            if (await m.add(repos)) rep.inserted++;
          } catch {
            bump('insert_failed'); // a pg error message can quote the row's values (P21): counted, never echoed
          }
        }
      }
      rep.skippedFields = [...tally].map(([k, n]) => `${k}:${n}`).sort();
    } catch (err) {
      // Only a source-file error names its file; anything else (a pg error can quote row values) is reported generically (P21).
      rep.error = err instanceof SourceError ? err.message : 'import failed (database error)';
    }
  }
  return out;
}

/** Counts only (P21). */
export function formatReport(reports: TableReport[], apply: boolean): string {
  const lines = reports.map((r) => r.error
    ? `${r.table.padEnd(16)} ERROR ${r.error}`
    : `${r.table.padEnd(16)} read=${r.read} ${apply ? `inserted=${r.inserted}` : `would_insert=${r.wouldInsert}`}${r.skippedFields.length ? ` ${r.skippedFields.join(' ')}` : ''}`);
  return [apply ? 'import (apply):' : 'import (dry-run, nothing written; add --apply):', ...lines].join('\n');
}

export function parseArgs(argv: string[]): { from: string; apply: boolean; tz?: string } {
  let from = '', tz: string | undefined, apply = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') apply = true;
    else if (a === '--from') from = argv[++i] ?? '';
    else if (a === '--tz') tz = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  if (!from) throw new Error('usage: import:discord-bot --from <dir> [--apply] [--tz Asia/Bangkok]');
  return { from, apply, ...(tz ? { tz } : {}) };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const pool = createPool(url, 2);
  try {
    console.log(formatReport(await importDiscordBot({ ...args, pool }), args.apply));
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(redactText(`import-discord-bot failed: ${err instanceof Error ? err.message : 'unknown error'}`, process.env.DATABASE_URL ? [process.env.DATABASE_URL] : []));
    process.exit(1);
  });
}
