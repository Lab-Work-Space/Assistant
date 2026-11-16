import { mkdirSync, readFileSync, renameSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FILES, makeFixtureDir, type FixtureSpec } from '../tests/fixtures/discord-bot/make-fixtures.js';

const opened: { path: string; opts: unknown }[] = [];
vi.mock('node:sqlite', async (orig) => {
  const actual = await orig<typeof import('node:sqlite')>();
  class Spy extends actual.DatabaseSync {
    constructor(path: string, opts?: Record<string, unknown>) { super(...((opts ? [path, opts] : [path]) as [string])); opened.push({ path: String(path), opts }); }
  }
  return { ...actual, DatabaseSync: Spy };
});
const { importDiscordBot } = await import('./import-discord-bot.js');

const GUILD = '1565649426943442944';
const CH = '1100000000000000001'; // > 2^53: must survive as text
const USER = '1200000000000000002';
const DENIED = '1565715069969502310';
const NOW = new Date('2026-11-01T00:00:00Z');
const EPOCH = NOW.getTime() / 1000;
const publicResolver = async () => ['93.184.216.34'];

type Row = Record<string, unknown>;
/** In-memory pg stand-in: records INSERTs by their column list, dedupes on legacy_id, answers the legacy_id existence SELECT. */
function fakePool() {
  const tables: Record<string, Row[]> = {};
  const writes: string[] = [];
  const q = async (sql: string, vals: unknown[] = []) => {
    const ins = /^\s*INSERT INTO (\w+) \(([^)]*)\)/s.exec(sql);
    if (ins) {
      const row: Row = {};
      ins[2]!.split(',').map((c) => c.trim()).forEach((c, i) => { row[c] = vals[i]; });
      const rows = (tables[ins[1]!] ??= []);
      writes.push(ins[1]!);
      if (rows.some((r) => r.legacy_id === row.legacy_id)) return { rows: [], rowCount: 0 };
      rows.push(row);
      return { rows: [{ id: rows.length }], rowCount: 1 };
    }
    const sel = /SELECT legacy_id FROM (\w+)/.exec(sql);
    if (sel) return { rows: (tables[sel[1]!] ?? []).map((r) => ({ legacy_id: r.legacy_id })), rowCount: 0 };
    return { rows: [], rowCount: 0 };
  };
  return { tables, writes, query: q, connect: async () => ({ query: q, release() {} }) } as never as import('../db/pool.js').Pool & { tables: typeof tables; writes: string[] };
}

const base = (o: Row = {}) => ({ guild_id: BigInt(GUILD), channel_id: BigInt(CH), user_id: BigInt(USER), created_at: EPOCH - 100, ...o });
const spec = (): FixtureSpec => ({
  reminders: [
    base({ text: 'ping me', remind_at: EPOCH + 3600, advance_minutes: 10, notify_via: 'dm' }),
    base({ text: 'already done', remind_at: EPOCH - 3600, fired: 1 }),
    base({ text: 'denied', remind_at: EPOCH + 60, channel_id: BigInt(DENIED) }),
    base({ text: 'foreign', remind_at: EPOCH + 60, guild_id: 42 }),
  ],
  tasks: [
    base({ prompt: 'daily brief', schedule_kind: 'daily', daily_hhmm: '09:00', next_run_at: EPOCH + 7200 }),
    base({ prompt: 'fast', schedule_kind: 'interval', interval_minutes: 5, next_run_at: EPOCH + 300 }),
    base({ prompt: 'once', schedule_kind: 'once', daily_hhmm: '10:00', next_run_at: EPOCH + 5000 }),
    base({ prompt: 'off', schedule_kind: 'interval', interval_minutes: 60, next_run_at: EPOCH + 5, active: 0 }),
  ],
  watches: [
    base({ kind: 'url', target: 'https://example.com/a#frag', interval_minutes: 60, next_check_at: EPOCH + 60, last_snapshot: 'x'.repeat(7000), has_baseline: 1 }),
    base({ kind: 'url', target: 'http://127.0.0.1/admin', interval_minutes: 30, next_check_at: EPOCH + 60 }),
    base({ kind: 'topic', target: 'rust news', interval_minutes: 5, next_check_at: EPOCH + 60, last_hrefs_json: '["https://a.example/1"]' }),
    base({ kind: 'topic', target: 'stopped', interval_minutes: 60, next_check_at: EPOCH, active: 0 }),
  ],
  lessons: [
    { text: 'be brief', source: 'manual', created_at: EPOCH, active: 1 },
    { text: 'retired', source: 'auto', created_at: EPOCH, active: 0 },
  ],
  history: [{ body: 'private chat' }],
});
const run = (from: string, pool = fakePool(), over: Record<string, unknown> = {}) =>
  (opened.length = 0, importDiscordBot)({ from, pool, apply: true, tz: 'Asia/Bangkok', now: () => NOW, guildId: GUILD, resolver: publicResolver, ...over } as never).then((r) => ({ r, pool }));
const by = (r: { table: string }[], t: string) => r.find((x) => x.table === t)! as { table: string; read: number; wouldInsert: number; inserted: number; skippedFields: string[]; error?: string };

beforeEach(() => { opened.length = 0; });

describe('import', () => {
  it('reads the old file names pinned in Step 0 (from DB_PATH in storage/*.py)', async () => {
    expect(FILES).toEqual({ reminders: 'reminders.sqlite3', tasks: 'scheduled_tasks.sqlite3', watches: 'watches.sqlite3', lessons: 'lessons.sqlite3', history: 'chat_history.sqlite3' });
    const dir = makeFixtureDir(spec());
    await run(dir);
    expect(opened.map((o) => o.path.split('/').pop()).sort()).toEqual(['lessons.sqlite3', 'reminders.sqlite3', 'scheduled_tasks.sqlite3', 'watches.sqlite3']);
  });

  it('history_store never opened', async () => {
    await run(makeFixtureDir(spec()));
    expect(opened.some((o) => /history/.test(o.path))).toBe(false);
  });

  it('symlink or non-regular --from file refused; database opened read-only', async () => {
    const dir = makeFixtureDir(spec());
    const real = join(dir, 'real');
    mkdirSync(real);
    renameSync(join(dir, FILES.lessons), join(real, FILES.lessons));
    symlinkSync(join(real, FILES.lessons), join(dir, FILES.lessons));
    renameSync(join(dir, FILES.watches), join(real, FILES.watches));
    mkdirSync(join(dir, FILES.watches)); // a directory where the file should be
    const before = readFileSync(join(dir, FILES.reminders));
    const { r } = await run(dir);
    expect(by(r, 'lessons').error).toMatch(/symlink|regular/i);
    expect(by(r, 'watches').error).toMatch(/regular/i);
    expect(by(r, 'reminders').inserted).toBe(1);
    expect(opened.every((o) => (o.opts as { readOnly?: boolean }).readOnly === true)).toBe(true);
    expect(opened.length).toBeGreaterThan(0);
    expect(readFileSync(join(dir, FILES.reminders)).equals(before)).toBe(true);
  });

  it('dry-run lists per-table counts, writes nothing', async () => {
    const pool = fakePool();
    const { r } = await run(makeFixtureDir(spec()), pool, { apply: false });
    expect(pool.writes).toEqual([]);
    expect(r.map((x) => x.table)).toEqual(['reminders', 'scheduled_tasks', 'watches', 'lessons']);
    expect(by(r, 'reminders')).toMatchObject({ read: 4, wouldInsert: 1, inserted: 0 });
    expect(by(r, 'scheduled_tasks')).toMatchObject({ read: 4, wouldInsert: 3, inserted: 0 });
    expect(by(r, 'watches')).toMatchObject({ read: 4, wouldInsert: 3, inserted: 0 });
    expect(by(r, 'lessons')).toMatchObject({ read: 2, wouldInsert: 1, inserted: 0 });
  });

  it('--apply inserts; second --apply inserts 0 (AC7)', async () => {
    const dir = makeFixtureDir(spec());
    const pool = fakePool();
    const first = (await run(dir, pool)).r;
    expect(first.map((x) => x.inserted)).toEqual([1, 3, 3, 1]);
    const second = (await run(dir, pool)).r;
    expect(second.map((x) => x.inserted)).toEqual([0, 0, 0, 0]);
    expect(second.map((x) => x.wouldInsert)).toEqual([0, 0, 0, 0]);
    expect(pool.tables.reminders).toHaveLength(1);
  });

  it('fired reminders and inactive rows skipped and counted', async () => {
    const { r } = await run(makeFixtureDir(spec()));
    expect(by(r, 'reminders').skippedFields).toEqual(expect.arrayContaining(['fired:1']));
    expect(by(r, 'scheduled_tasks').skippedFields).toContain('inactive:1');
    expect(by(r, 'watches').skippedFields).toContain('inactive:1');
    expect(by(r, 'lessons').skippedFields).toContain('inactive:1');
  });

  it('channel in a denied or foreign-guild channel skipped and counted', async () => {
    const { r, pool } = await run(makeFixtureDir(spec()));
    expect(by(r, 'reminders').skippedFields).toEqual(expect.arrayContaining(['denied_channel:1', 'foreign_guild:1']));
    expect(pool.tables.reminders!.map((x) => x.text)).toEqual(['ping me']);
  });

  it('advance_minutes and notify_via are imported (R9)', async () => {
    const { pool } = await run(makeFixtureDir(spec()));
    expect(pool.tables.reminders![0]).toMatchObject({ advance_minutes: 10, notify_via: 'dm', channel_id: CH, guild_id: GUILD, user_id: USER, legacy_id: 1 });
    expect((pool.tables.reminders![0]!.remind_at as Date).getTime()).toBe((EPOCH + 3600) * 1000);
    expect(pool.tables.reminders![0]!.every_minutes).toBeNull();
  });

  it('interval <15 raised to 15 and reported', async () => {
    const { r, pool } = await run(makeFixtureDir(spec()));
    expect(pool.tables.scheduled_jobs!.find((j) => j.kind === 'interval')!.interval_minutes).toBe(15);
    expect(pool.tables.watches!.find((j) => j.kind === 'topic')!.interval_minutes).toBe(15);
    expect(by(r, 'scheduled_tasks').skippedFields).toContain('interval_raised:1');
    expect(by(r, 'watches').skippedFields).toContain('interval_raised:1');
  });

  it('imported schedule has origin import', async () => {
    const { pool } = await run(makeFixtureDir(spec()));
    expect(pool.tables.scheduled_jobs!.every((j) => j.origin === 'import')).toBe(true);
  });

  it('daily rows keep epoch next_run_at and use --tz for later runs (R10)', async () => {
    const { pool } = await run(makeFixtureDir(spec()), fakePool(), { tz: 'America/New_York' });
    const daily = pool.tables.scheduled_jobs!.find((j) => j.kind === 'daily')!;
    expect(daily).toMatchObject({ hhmm: '09:00', tz: 'America/New_York' });
    expect((daily.next_run_at as Date).getTime()).toBe((EPOCH + 7200) * 1000);
    const once = pool.tables.scheduled_jobs!.find((j) => j.kind === 'once')!;
    expect(once).toMatchObject({ hhmm: null, tz: null });
  });

  it('missing sqlite file → clear error, others still import', async () => {
    const s = spec();
    delete s.watches;
    const { r } = await run(makeFixtureDir(s));
    expect(by(r, 'watches')).toMatchObject({ read: 0, inserted: 0, error: expect.stringContaining('watches.sqlite3') });
    expect(by(r, 'reminders').inserted).toBe(1);
    expect(by(r, 'lessons').inserted).toBe(1);
  });

  it('keeps ids as text, truncates snapshot to 6000, raises nothing for valid rows', async () => {
    const { pool } = await run(makeFixtureDir(spec()));
    const w = pool.tables.watches!.find((x) => x.target === 'https://example.com/a')!;
    expect((w.last_snapshot as string).length).toBe(6000);
    expect(w).toMatchObject({ enabled: true, has_baseline: true, guild_id: GUILD });
    const t = pool.tables.watches!.find((x) => x.kind === 'topic')!;
    expect(t.last_hrefs).toBe('["https://a.example/1"]');
  });

  it('T22: a failing INSERT is counted insert_failed per row and its pg message (row values) is never echoed', async () => {
    const pool = fakePool();
    const q = pool.query.bind(pool);
    (pool as unknown as { query: typeof q }).query = (async (sql: string, vals?: unknown[]) => {
      if (/^\s*INSERT INTO reminders/.test(sql)) throw new Error('duplicate key value violates unique constraint: Key (text)=(ping me SECRET-ROW)');
      return q(sql, vals);
    }) as typeof q;
    (pool as unknown as { connect: () => Promise<unknown> }).connect = async () => ({ query: pool.query, release() {} });
    const { r } = await run(makeFixtureDir(spec()), pool);
    const rem = by(r, 'reminders');
    expect(rem.error).toBeUndefined();
    expect(rem.inserted).toBe(0);
    expect(rem.skippedFields).toContain('insert_failed:1');
    expect(by(r, 'lessons').inserted).toBe(1); // the other tables still import
    expect(JSON.stringify(r)).not.toMatch(/SECRET-ROW|ping me|duplicate key/);
  });

  it('T22: a database error outside a row is reported generically, never with the pg message', async () => {
    const pool = fakePool();
    const q = pool.query.bind(pool);
    (pool as unknown as { query: typeof q }).query = (async (sql: string, vals?: unknown[]) => {
      if (/SELECT legacy_id FROM watches/.test(sql)) throw new Error('relation "watches" does not exist near SECRET-DETAIL');
      return q(sql, vals);
    }) as typeof q;
    const { r } = await run(makeFixtureDir(spec()), pool);
    expect(by(r, 'watches').error).toBe('import failed (database error)');
    expect(JSON.stringify(r)).not.toContain('SECRET-DETAIL');
  });

  it('T22: a disabled watch url is stored without user:pass', async () => {
    const s = spec();
    s.watches = [base({ kind: 'url', target: 'http://admin:hunter2-SECRET@127.0.0.1:8080/x', interval_minutes: 30, next_check_at: EPOCH + 60 })];
    const { r, pool } = await run(makeFixtureDir(s));
    const w = by(r, 'watches');
    expect(w.inserted).toBe(1);
    expect(w.skippedFields).toEqual(expect.arrayContaining(['credentials_stripped:1', 'disabled_url:1']));
    const stored = pool.tables.watches!;
    expect(JSON.stringify(stored)).not.toMatch(/hunter2|admin:/);
    expect(stored[0]!.target).toBe('http://127.0.0.1:8080/x');
  });
});
