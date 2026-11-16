import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../../db/migrate.js';
import { ClickUpSeenRepo } from '../../../db/repos/praw.js';
import { freshDb, type TestDb } from '../../../db/test-helpers.js';
import { createHttpClient } from '../../../services/http.js';
import { FakeDiscordPort } from '../../../tests/fakes/discordPort.js';
import { workspaceFetch, ws } from '../../../tests/fakes/clickup-workspace.js';
import { createClickUpClient } from './client.js';
import { teamB } from './multi-helpers.js';
import { ClickUpPoller } from './poller.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'db', 'migrations');
let db: TestDb, seen: ClickUpSeenRepo;
beforeAll(async () => { db = await freshDb(); await migrate(db.pool, dir, 'up'); seen = new ClickUpSeenRepo(db.pool); });
beforeEach(async () => { await db.pool.query('TRUNCATE clickup_seen'); });
afterAll(async () => { await db.close(); });

describe('CLICKUP-ALL-1 per-list baselines in clickup_seen (no migration)', () => {
  it('each list has its own baseline row; the legacy list-mode row (fingerprint 1) is a different thing', async () => {
    expect(await seen.baselineAt()).toBeNull();
    expect(await seen.baselineAt('7001')).toBeNull();
    await seen.claim('*', 'baseline', '7001', new Date('2026-11-01T00:00:00Z'));
    expect((await seen.baselineAt('7001'))?.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(await seen.baselineAt('7002')).toBeNull();
    expect(await seen.baselineAt()).toBeNull(); // list mode does not see a workspace row
    await seen.claim('*', 'baseline', '1', new Date('2026-11-02T00:00:00Z'));
    expect((await seen.baselineAt())?.toISOString()).toBe('2026-11-02T00:00:00.000Z'); // today's call, unchanged
    expect((await seen.baselineAt('7001'))?.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  it('forgetBaseline drops that list\'s row only, so watching it again baselines it silently', async () => {
    await seen.claim('*', 'baseline', '7001', new Date());
    await seen.claim('*', 'baseline', '7002', new Date());
    await seen.claim('*', 'baseline', '1', new Date());
    await seen.forgetBaseline('7001');
    expect(await seen.baselineAt('7001')).toBeNull();
    expect(await seen.baselineAt('7002')).not.toBeNull();
    expect(await seen.baselineAt()).not.toBeNull();
    expect(await seen.claim('*', 'baseline', '7001', new Date())).toBe(true); // a fresh baseline can be taken again
  });
});


describe('CLICKUP-MULTI-1 two workspaces against the real clickup_seen table', () => {
  it('each list of each workspace has its own baseline row; a new task of the second workspace is announced exactly once across ticks and a second poller', async () => {
    const state = ws({ teamName: 'Core', more: [teamB()] });
    const f = workspaceFetch(state);
    let now = Date.parse('2026-11-01T10:00:00Z');
    const mk = (port: FakeDiscordPort) => new ClickUpPoller({
      client: createClickUpClient({ http: createHttpClient({ fetch: f }), token: state.token, allTeams: true, now: () => now, sleep: async (ms) => void (now += ms) }),
      seen: seen, port, channel: async () => '1569000000000000001', intervalSec: () => 120, canRun: () => true, clock: () => now,
      log: { warn: () => undefined, error: () => undefined }, watched: () => ['7001', '8001'],
    });
    const port = new FakeDiscordPort();
    const poller = mk(port);
    await poller.tick();
    expect(port.posts).toHaveLength(0);
    expect(await seen.baselineAt('7001')).not.toBeNull();
    expect(await seen.baselineAt('8001')).not.toBeNull();
    state.more![0]!.tasks.push({ id: 'bn1', name: 'Acme news', listId: '8001', spaceId: '601', status: { status: 'to do', type: 'open' }, date_updated: String(now + 1000) });
    now += 120_000;
    await poller.tick();
    await poller.tick();
    const second = new FakeDiscordPort();
    await mk(second).tick(); // another poller on the same table claims nothing new
    expect(port.posts).toHaveLength(1);
    expect(second.posts).toHaveLength(0);
  });
});
