import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { localDay } from '../../company/calendar.js';
import { migrate } from '../migrate.js';
import { freshDb, type TestDb } from '../test-helpers.js';
import { ClickUpWriteUsage } from './clickup-write-usage.js';

let db: TestDb;
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
beforeAll(async () => { db = await freshDb(); await migrate(db.pool, dir, 'up'); });
afterAll(async () => { await db.close(); });
beforeEach(async () => { await db.pool.query('DELETE FROM clickup_write_usage'); });

describe('C9 clickup_write_usage: durable daily cap under the row lock', () => {
  it('10 parallel takes with cap 2 succeed exactly twice', async () => {
    const u = new ClickUpWriteUsage(db.pool);
    const r = await Promise.all(Array.from({ length: 10 }, () => u.take('2026-11-08', 2)));
    expect(r.filter(Boolean)).toHaveLength(2);
    expect(await u.used('2026-11-08')).toBe(2);
  });
  it('cap 0 refuses and writes no row', async () => {
    const u = new ClickUpWriteUsage(db.pool);
    expect(await u.take('2026-11-08', 0)).toBe(false);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM clickup_write_usage')).rows[0].n).toBe(0);
  });
  it('the count survives a new repo instance, and a refused take adds nothing', async () => {
    expect(await new ClickUpWriteUsage(db.pool).take('2026-11-08', 2)).toBe(true);
    expect(await new ClickUpWriteUsage(db.pool).take('2026-11-08', 2)).toBe(true);
    expect(await new ClickUpWriteUsage(db.pool).take('2026-11-08', 2)).toBe(false);
    expect(await new ClickUpWriteUsage(db.pool).used('2026-11-08')).toBe(2);
  });
  it('the date rolls over at local midnight of the company timezone (the day string comes from localDay, not CURRENT_DATE)', async () => {
    const u = new ClickUpWriteUsage(db.pool);
    const before = Date.parse('2026-11-08T16:59:00Z'); // 23:59 in Bangkok (UTC+7)
    const after = Date.parse('2026-11-08T17:01:00Z'); // 00:01 next day
    const d1 = localDay(before, 'Asia/Bangkok').date;
    const d2 = localDay(after, 'Asia/Bangkok').date;
    expect([d1, d2]).toEqual(['2026-11-08', '2026-11-09']);
    expect(await u.take(d1, 1)).toBe(true);
    expect(await u.take(d1, 1)).toBe(false);
    expect(await u.take(d2, 1)).toBe(true);
  });
  it('negative or fractional caps refuse', async () => {
    const u = new ClickUpWriteUsage(db.pool);
    expect(await u.take('2026-11-08', -1)).toBe(false);
    expect(await u.take('2026-11-08', 1.5)).toBe(false);
  });
});
