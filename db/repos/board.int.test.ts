import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../migrate.js';
import { freshDb, type TestDb } from '../test-helpers.js';
import { BoardMessageRepo, DailyRunRepo } from './board.js';

let db: TestDb;
beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations'), 'up');
});
afterAll(async () => { await db.close(); });

describe('WS11 DailyRunRepo', () => {
  it('claims a (day, kind) exactly once, even from two repos at once; another kind or day is free', async () => {
    const a = new DailyRunRepo(db.pool);
    const b = new DailyRunRepo(db.pool);
    const [x, y] = await Promise.all([a.claim('2026-11-02', 'goal'), b.claim('2026-11-02', 'goal')]);
    expect([x, y].filter(Boolean)).toHaveLength(1);
    expect(await a.claim('2026-11-02', 'report')).toBe(true);
    expect(await a.claim('2026-11-03', 'goal')).toBe(true);
  });

  it('keeps the report body (bounded) and returns the newest report of an earlier day only', async () => {
    const r = new DailyRunRepo(db.pool);
    await r.claim('2026-10-30', 'report');
    await r.save('2026-10-30', 'report', 'Friday report');
    await r.claim('2026-11-02', 'report');
    await r.save('2026-11-02', 'report', 'x'.repeat(9000));
    expect(await r.lastReport('2026-11-02')).toBe('Friday report'); // today's own report is not yesterday's
    expect((await r.lastReport('2026-11-03'))?.length).toBe(4000);
    expect(await r.lastReport('2026-10-01')).toBeNull();
  });
});

describe('TEAMTALK T8 board key length', () => {
  it('the key column takes up to 64 characters and refuses 65; a room key (room: + 32 hex) fits for any persona id', async () => {
    const b = new BoardMessageRepo(db.pool);
    const m = { channelId: '1570000000000000001', messageId: '1570000000000000002', digest: null };
    await b.set(`room:${'f'.repeat(32)}`, m);
    await b.set('k'.repeat(64), m);
    await expect(b.set('k'.repeat(65), m)).rejects.toThrow(/check/i);
  });
});
