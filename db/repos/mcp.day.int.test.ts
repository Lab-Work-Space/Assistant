import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../migrate.js';
import { freshDb, type TestDb } from '../test-helpers.js';
import { McpRepo } from './mcp.js';

/** R6 MCP-1 BE2 (spec 5.12): the digest counts come from today's audit rows in the schedule timezone, and from nothing else. */
let db: TestDb;
let repo: McpRepo;
beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations'), 'up');
  repo = new McpRepo(db.pool);
});
beforeEach(async () => { await db.pool.query('DELETE FROM audit_log'); });
afterAll(async () => { await db.close(); });

const row = (action: string, outcome: string, ts: string) => db.pool.query('INSERT INTO audit_log (actor, action, outcome, ts) VALUES ($1,$2,$3,$4::timestamptz)', ['system:mcp', action, outcome, ts]);

describe('McpRepo.day', () => {
  it('counts calls started, calls that ended in anything but ok, and quarantines, for the local day only', async () => {
    const TZ = 'Asia/Bangkok';
    const today = (await db.pool.query<{ t: string }>("SELECT (date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1 + interval '1 minute')::text AS t", [TZ])).rows[0]!.t;
    const yesterday = (await db.pool.query<{ t: string }>("SELECT (date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1 - interval '1 minute')::text AS t", [TZ])).rows[0]!.t;
    await row('mcp.call', 'start', today);
    await row('mcp.call', 'start', today);
    await row('mcp.call', 'start', today);
    await row('mcp.call.end', 'ok', today);
    await row('mcp.call.end', 'tool_error', today);
    await row('mcp.call.end', 'E_TIMEOUT', today);
    await row('mcp.quarantine', 'srv snapshot_changed', today);
    await row('mcp.call', 'start', yesterday);
    await row('mcp.call.end', 'E_EXIT', yesterday);
    await row('mcp.quarantine', 'srv snapshot_changed', yesterday);
    await row('mcp.add', 'pending srv abc 2', today);
    await row('tool', 'ok', today);
    expect(await repo.day(TZ)).toEqual({ calls: 3, failed: 2, quarantined: 1 });
  });
  it('an empty day is all zeros', async () => {
    expect(await repo.day('UTC')).toEqual({ calls: 0, failed: 0, quarantined: 0 });
  });
});
