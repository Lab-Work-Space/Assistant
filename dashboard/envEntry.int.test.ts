import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AdminConsole } from '../admin/console.js';
import { SettingsRegistry } from '../admin/settings.js';
import { ConfigStore } from '../config/store.js';
import { EventBus, type AppEvents } from '../core/events.js';
import { migrate } from '../db/migrate.js';
import { AdminCardRepo } from '../db/repos/adminCards.js';
import { DashboardRepo } from '../db/repos/dashboard.js';
import { AuditRepo } from '../db/repos/ledger.js';
import { freshDb, type TestDb } from '../db/test-helpers.js';
import { ADMIN_ROLE, makeDeps } from '../discord/commands/test-helpers.js';
import { createAudit } from '../governance/audit.js';
import { FakeDiscordPort } from '../tests/fakes/discordPort.js';
import { bootDashboard, type RunningDashboard } from './boot.js';
import { BASE_ENV, envFixture, fakeData, http } from './test-helpers.js';

const ADMIN = '900000000000000001';
const SENTINEL = 'zqSENTINELzq7x9w2v';
let db: TestDb;
let dash: RunningDashboard | null = null;
let store: ConfigStore;
let fx: ReturnType<typeof envFixture>;

beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations'), 'up');
});
afterAll(async () => { await store?.close(); await db.close(); });
afterEach(async () => { await dash?.close(); dash = null; fx?.cleanup(); });

describe('env entry on a real database', () => {
  it('the sentinel is written to the temp env file and appears in no table, no log line and no Discord post', async () => {
    store = await ConfigStore.open(db.pool, new EventBus<AppEvents>());
    fx = envFixture();
    const t = await makeDeps({ cfg: store as never });
    const port = new FakeDiscordPort();
    const auditRepo = new AuditRepo(db.pool);
    const audit = createAudit(auditRepo);
    const c = new AdminConsole({ guildId: t.deps.guildId, adminRoleId: ADMIN_ROLE, cards: new AdminCardRepo(db.pool), cfg: store, cmd: t.deps, port, audit, log: { error: () => undefined }, hqUserId: () => 'hq1' });
    const settings = new SettingsRegistry();
    settings.bindConsole(c);
    const logs: unknown[] = []; const notices: string[] = [];
    dash = (await bootDashboard({
      local: true, inContainer: () => null, port: 0, store: new DashboardRepo(db.pool), audit, isAdmin: async () => true, console: c, settings, data: fakeData(),
      env: { dir: fx.dir, notify: async (x) => void notices.push(x) }, log: { info: (x) => void logs.push(x), error: (x) => void logs.push(x) },
    }))!;
    const p = dash.server.address().port;
    const origin = `http://127.0.0.1:${p}`;
    const l = await dash.link(ADMIN);
    if (!l.ok) throw new Error('rate');
    const lg = await http(p, { method: 'POST', path: '/login', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: `t=${new URL(l.url).searchParams.get('t')}` });
    const cookie = String(lg.headers['set-cookie']).split(';')[0]!;
    const csrf = /name="_csrf" value="([0-9a-f]{64})"/.exec((await http(p, { path: '/', headers: { cookie } })).body)![1]!;
    const post = (path: string, f: Record<string, string>) => http(p, { method: 'POST', path, headers: { origin, cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrf, ...f }).toString() });

    const ok = await post('/secrets/set', { key: 'GOOGLE_SHEETS_WEBAPP_SECRET', value: SENTINEL });
    expect(ok.status).toBe(200);
    expect(ok.body).toContain('Saved');
    expect(readFileSync(fx.file, 'utf8')).toBe(`${BASE_ENV}GOOGLE_SHEETS_WEBAPP_SECRET=${SENTINEL}\n`);
    await post('/secrets/set', { key: 'GOOGLE_SHEETS_WEBAPP_SECRET', value: `${SENTINEL} bad` });

    const tables = (await db.pool.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")).rows;
    for (const { table_name } of tables) {
      const rows = (await db.pool.query(`SELECT t::text AS r FROM "${table_name}" t`)).rows;
      expect(JSON.stringify(rows), table_name).not.toContain('SENTINEL');
    }
    const audits = (await db.pool.query("SELECT actor, action, tool, outcome FROM audit_log WHERE action LIKE 'env.%' ORDER BY id")).rows;
    expect(audits).toEqual([
      { actor: `user:${ADMIN} via dashboard`, action: 'env.set', tool: 'GOOGLE_SHEETS_WEBAPP_SECRET', outcome: 'ok' },
      { actor: `user:${ADMIN} via dashboard`, action: 'env.set', tool: 'GOOGLE_SHEETS_WEBAPP_SECRET', outcome: 'refused:value' },
    ]);
    expect(JSON.stringify({ logs, notices, posts: port.posts })).not.toContain('SENTINEL');
    expect(notices).toEqual([`env key GOOGLE_SHEETS_WEBAPP_SECRET was changed by <@${ADMIN}>; restart required`]);
  });
});
