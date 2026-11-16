import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { fakeData, http } from './test-helpers.js';

const ADMIN = '900000000000000001';
const OTHER = '900000000000000002';
let db: TestDb;
let store: ConfigStore;
let dash: RunningDashboard | null = null;
let admins: Set<string>;

beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations'), 'up');
});
afterAll(async () => { await store?.close(); await db.close(); });
beforeEach(async () => {
  await store?.close();
  await db.pool.query('TRUNCATE admin_cards, dash_login_tokens, dash_sessions, audit_log RESTART IDENTITY');
  await db.pool.query('DELETE FROM config');
  store = await ConfigStore.open(db.pool, new EventBus<AppEvents>());
  admins = new Set([ADMIN, OTHER]);
});
afterEach(async () => { await dash?.close(); dash = null; });

async function start() {
  const t = await makeDeps({ cfg: store as never });
  const port = new FakeDiscordPort();
  const cards = new AdminCardRepo(db.pool);
  const auditRepo = new AuditRepo(db.pool);
  const audit = createAudit(auditRepo);
  const c = new AdminConsole({
    guildId: t.deps.guildId, adminRoleId: ADMIN_ROLE, cards, cfg: store, cmd: t.deps, port, audit, log: { error: () => undefined }, hqUserId: () => 'hq1',
  });
  const settings = new SettingsRegistry();
  settings.bindConsole(c);
  dash = (await bootDashboard({
    local: true, inContainer: () => null, port: 0, store: new DashboardRepo(db.pool), audit, isAdmin: async (u) => admins.has(u), console: c, settings,
    data: fakeData({ pendingCards: () => cards.listPending(), audit: (q) => auditRepo.query(q) }), log: { info: () => undefined, error: () => undefined },
  }))!;
  const p = dash.server.address().port;
  const origin = `http://127.0.0.1:${p}`;
  const form = { 'content-type': 'application/x-www-form-urlencoded', origin };
  const login = async (user = ADMIN) => {
    const l = await dash!.link(user);
    if (!l.ok) throw new Error('rate');
    const token = new URL(l.url).searchParams.get('t')!;
    const r = await http(p, { method: 'POST', path: '/login', headers: form, body: `t=${token}` });
    const cookie = String(r.headers['set-cookie']).split(';')[0]!;
    const csrf = /name="_csrf" value="([0-9a-f]{64})"/.exec((await http(p, { path: '/', headers: { cookie } })).body)?.[1] ?? '';
    return { cookie, csrf, r };
  };
  const post = (path: string, fields: Record<string, string>, cookie: string) => http(p, { method: 'POST', path, headers: { ...form, cookie }, body: new URLSearchParams(fields).toString() });
  return { c, p, port, cards, login, post, t };
}

describe('dashboard smoke on a real database (login, propose, diff, apply, refusals)', () => {
  it('login -> propose -> the diff is shown -> Apply changes the setting through the console, audited as "via dashboard"', async () => {
    const x = await start();
    const s = await x.login();
    expect(s.r.status).toBe(303);
    const prop = await x.post('/propose', { _csrf: s.csrf, action: 'budget_set', f_scope: 'task', f_usd: '2' }, s.cookie);
    expect(prop.status).toBe(303);
    expect(x.port.posts).toEqual([]); // nothing in Discord: the dashboard's cards live in the table
    expect(store.get('budget.taskUsd')).toBe(0.5);
    const cardsPage = await http(x.p, { path: '/cards', headers: { cookie: s.cookie } });
    expect(cardsPage.body).toContain('budget.taskUsd');
    expect(cardsPage.body).toContain('0.5');
    const id = /name="card" value="([0-9a-f]{32})"/.exec(cardsPage.body)![1]!;
    const applied = await x.post('/cards/apply', { _csrf: s.csrf, card: id }, s.cookie);
    expect(applied.status).toBe(200);
    expect(store.get('budget.taskUsd')).toBe(2);
    expect((await db.pool.query("SELECT updated_by FROM config WHERE key = 'budget.taskUsd'")).rows[0].updated_by).toBe(`user:${ADMIN} via dashboard`);
    expect((await x.post('/cards/apply', { _csrf: s.csrf, card: id }, s.cookie)).status).toBe(409); // single use
    const audit = await http(x.p, { path: '/audit?action=admin.budget', headers: { cookie: s.cookie } });
    expect(audit.body).toContain(`user:${ADMIN} via dashboard`);
    await new Promise((r) => setTimeout(r, 20));
    expect((await db.pool.query("SELECT 1 FROM audit_log WHERE action = 'dashboard.session'")).rowCount).toBeGreaterThan(0);
    expect(JSON.stringify((await db.pool.query('SELECT * FROM audit_log')).rows)).not.toContain(s.csrf);
  });

  it('refuses a write without the CSRF token, from a foreign Origin, and with a foreign Host', async () => {
    const x = await start();
    const s = await x.login();
    const fields = { action: 'budget_set', f_scope: 'task', f_usd: '2' };
    expect((await x.post('/propose', fields, s.cookie)).status).toBe(403);
    expect((await http(x.p, { method: 'POST', path: '/propose', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost:3001', cookie: s.cookie }, body: new URLSearchParams({ ...fields, _csrf: s.csrf }).toString() })).status).toBe(403);
    expect((await http(x.p, { path: '/', headers: { cookie: s.cookie, host: `host.docker.internal:${x.p}` } })).status).toBe(421);
    expect((await x.cards.listPending())).toEqual([]);
    expect(store.get('budget.taskUsd')).toBe(0.5);
  });

  it('another admin cannot apply this admin\'s card, a Discord card is read only, and a role removed after login ends the sessions', async () => {
    const x = await start();
    const a = await x.login(ADMIN);
    const b = await x.login(OTHER);
    await x.post('/propose', { _csrf: a.csrf, action: 'budget_set', f_scope: 'task', f_usd: '2' }, a.cookie);
    const id = (await x.cards.listPending())[0]!.id;
    expect((await x.post('/cards/apply', { _csrf: b.csrf, card: id }, b.cookie)).status).toBe(409);
    await x.c.proposeConfig({ userId: OTHER, tainted: false }, { changes: [{ key: 'budget.botUsd', value: 2 }] }).catch(() => undefined);
    const discord = await x.c.proposeOp({ userId: OTHER, tainted: false }, { op: 'budget_set', scope: 'bot', usd: 2 });
    expect(discord.ok).toBe(true);
    const dcard = (await x.cards.listPending()).find((c) => c.origin === 'discord')!;
    expect((await x.post('/cards/apply', { _csrf: b.csrf, card: dcard.id }, b.cookie)).status).toBe(409);
    admins.delete(ADMIN);
    expect((await x.post('/cards/apply', { _csrf: a.csrf, card: id }, a.cookie)).status).toBe(401);
    expect(store.get('budget.taskUsd')).toBe(0.5);
    expect((await db.pool.query('SELECT 1 FROM dash_sessions WHERE user_id = $1', [ADMIN])).rowCount).toBe(0);
  });
});
