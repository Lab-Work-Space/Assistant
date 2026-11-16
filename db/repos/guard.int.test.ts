import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AI_WARROOM_CHANNEL_ID } from '../../company/channels.js';
import { migrate } from '../migrate.js';
import { freshDb, type TestDb } from '../test-helpers.js';
import { DailyRunRepo } from './board.js';
import { GuardStateRepo } from './guard.js';

let db: TestDb;
beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations'), 'up');
});
afterAll(async () => { await db.close(); });

describe('HEAL-1 GuardStateRepo', () => {
  it('round-trips the quiet clock and the lift counters; a legacy row reads null and zero', async () => {
    const r = new GuardStateRepo(db.pool);
    await db.pool.query("INSERT INTO guard_state (key, run_count) VALUES ('1570000000000000010', 2)");
    expect(await r.get('1570000000000000010')).toEqual({ count: 2, stalled: false, ceoTurn: false, resetUsed: false, lastBotTurnAt: null, quietLifts: 0, personLifts: 0, liftDay: null });
    const at = Date.UTC(2026, 10, 9, 10, 0, 0);
    await r.put('1570000000000000010', { count: 5, stalled: true, ceoTurn: true, resetUsed: true, lastBotTurnAt: at, quietLifts: 2, personLifts: 1, liftDay: '2026-11-09' });
    expect(await r.get('1570000000000000010')).toEqual({ count: 5, stalled: true, ceoTurn: true, resetUsed: true, lastBotTurnAt: at, quietLifts: 2, personLifts: 1, liftDay: '2026-11-09' });
    await r.put('1570000000000000010', { count: 0, stalled: false, ceoTurn: false, resetUsed: false });
    expect(await r.get('1570000000000000010')).toMatchObject({ lastBotTurnAt: null, quietLifts: 0, personLifts: 0, liftDay: null });
  });

  it('prune keeps the #ai-warroom row (HL-C2) and deletes other idle rows', async () => {
    const r = new GuardStateRepo(db.pool);
    await db.pool.query("INSERT INTO guard_state (key, touched_at) VALUES ($1, now() - interval '9 hours'), ('1570000000000000011', now() - interval '9 hours')", [AI_WARROOM_CHANNEL_ID]);
    await r.prune(new Date(Date.now() - 6 * 3_600_000));
    expect((await db.pool.query('SELECT key FROM guard_state ORDER BY key')).rows.map((x) => x.key)).toContain(AI_WARROOM_CHANNEL_ID);
    expect((await db.pool.query("SELECT 1 FROM guard_state WHERE key = '1570000000000000011'")).rowCount).toBe(0);
  });

  it('the heal daily kind is claimable once per day', async () => {
    const d = new DailyRunRepo(db.pool);
    expect(await d.claim('2026-11-09', 'heal')).toBe(true);
    expect(await d.claim('2026-11-09', 'heal')).toBe(false);
  });
});
