import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../db/migrate.js';
import { freshDb, type TestDb } from '../db/test-helpers.js';
import { makeFixtureDir } from '../tests/fixtures/discord-bot/make-fixtures.js';
import { formatReport, importDiscordBot } from './import-discord-bot.js';

const GUILD = '1565649426943442944';
const NOW = new Date('2026-11-01T00:00:00Z');
const E = NOW.getTime() / 1000;
const row = (o: Record<string, unknown>) => ({ guild_id: BigInt(GUILD), channel_id: 1100000000000000001n, user_id: 1200000000000000002n, created_at: E, ...o });
let db: TestDb;
beforeAll(async () => { db = await freshDb(); await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations'), 'up'); });
afterAll(async () => { await db.close(); });

const opts = (from: string, apply: boolean) => ({ from, pool: db.pool, apply, tz: 'Asia/Bangkok', now: () => NOW, guildId: GUILD, resolver: async () => ['93.184.216.34'] });
const fixture = () => makeFixtureDir({
  reminders: [row({ text: 'SECRET-REMINDER-TEXT', remind_at: E + 600, advance_minutes: 5, notify_via: 'dm' })],
  tasks: [row({ prompt: 'SECRET-PROMPT', schedule_kind: 'daily', daily_hhmm: '08:30', next_run_at: E + 900 })],
  watches: [row({ kind: 'url', target: 'https://example.com/SECRET-URL', interval_minutes: 30, next_check_at: E + 60 }), row({ kind: 'url', target: 'http://127.0.0.1:8080/private', interval_minutes: 30, next_check_at: E + 60 })],
  lessons: [{ text: 'SECRET-LESSON', source: 'manual', created_at: E, active: 1 }],
});

describe('import (postgres)', () => {
  it('dry-run output has counts only', async () => {
    const dir = fixture();
    const out = formatReport(await importDiscordBot(opts(dir, false)), false);
    expect(out).toMatch(/reminders\s+read=1\s+would_insert=1/);
    expect(out).not.toMatch(/SECRET|example\.com|127\.0\.0\.1|1100000000000000001|1200000000000000002/);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM reminders')).rows[0].n).toBe(0);
  });

  it('lesson imported disabled', async () => {
    await importDiscordBot(opts(fixture(), true));
    const l = (await db.pool.query('SELECT source, origin, active FROM lessons')).rows;
    expect(l).toEqual([{ source: 'import', origin: 'import', active: false }]);
  });

  it('private watch URL imported disabled', async () => {
    await importDiscordBot(opts(fixture(), true));
    const w = (await db.pool.query('SELECT target, enabled FROM watches ORDER BY legacy_id')).rows;
    expect(w.map((x) => x.enabled)).toEqual([true, false]);
    const j = (await db.pool.query('SELECT origin, tz, kind FROM scheduled_jobs')).rows;
    expect(j).toEqual([{ origin: 'import', tz: 'Asia/Bangkok', kind: 'daily' }]);
    const r = (await db.pool.query('SELECT advance_minutes, notify_via, channel_id FROM reminders')).rows;
    expect(r).toEqual([{ advance_minutes: 5, notify_via: 'dm', channel_id: '1100000000000000001' }]);
  });
});
