import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../../app.js';
import { ConfigRepo } from '../../db/repos/ledger.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { FakeProvider } from '../../providers/index.js';
import { installFakeClaude, type FakeClaude } from '../fakes/claudeCli.js';
import { BOT_LOG_CHANNEL, boot, humanMsg, migrateUp, resetDb } from './helpers.js';

let db: TestDb;
let app: App | null = null;
let dir: string;
let fake: FakeClaude;

beforeAll(async () => {
  db = await freshDb();
  await migrateUp(db.pool);
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccl-app-'));
  fake = installFakeClaude(dir);
  fake.scenario({ mode: 'payload', payload: { text: 'hi' } });
});
afterEach(async () => {
  await app?.stop();
  app = null;
  rmSync(dir, { recursive: true, force: true });
  await resetDb(db.pool);
});
afterAll(async () => {
  await db.close();
});

const allowed = () => async () => ({ ok: true as const, claudePath: fake.path });
const refusedGuard = async () => ({ ok: false as const, reason: 'ALLOW_LOCAL_PROVIDERS is not 1' });
const health = async (a: App) => (await fetch(`${a.services.healthUrl()}/healthz`)).json() as Promise<Record<string, unknown>>;

describe('local mode boot (spec §5, Gate 1 L9)', () => {
  it('boot with no provider available stays up idle: governance alert, no loops, health unavailable, recovers on registration (R-L10)', async () => {
    const booted = await boot(db.pool, { localGuard: refusedGuard, depts: ['hq', 'software'] });
    app = booted.app;
    const alerts = booted.port.posts.filter((p) => p.target.channelId === BOT_LOG_CHANNEL && String(p.payload.title).startsWith('Incident ') && p.payload.body.includes('where: boot · provider'));
    expect(alerts).toHaveLength(1);
    expect(app.services.scheduler.canRun()).toBe(false);
    expect(await health(app)).toMatchObject({ db: 'ok', provider: 'unavailable' });
    const provider = new FakeProvider([{ text: 'hi' }], 'claude');
    app.services.providers.register(provider);
    await app.services.cfg.set('provider.default', { provider: 'claude', model: 'claude-sonnet-5-5' }, 'owner');
    expect(app.services.scheduler.canRun()).toBe(true);
    expect(await health(app)).toMatchObject({ provider: 'ok' });
  });

  it('first local boot sets provider.default once', async () => {
    const repo = new ConfigRepo(db.pool);
    app = (await boot(db.pool, { localGuard: allowed(), start: false })).app;
    expect(app.services.cfg.get('provider.default')).toEqual({ provider: 'claude-code-local', model: 'local/claude-sonnet-5-5' });
    expect(await repo.get('provider.default')).toMatchObject({ updatedBy: 'system:first-local-boot', version: 1 });
    await app.services.cfg.set('provider.default', { provider: 'claude-code-local', model: 'local/claude-haiku-5-5' }, 'owner');
    await app.stop();
    app = (await boot(db.pool, { localGuard: allowed(), start: false })).app;
    expect(app.services.cfg.get('provider.default')).toEqual({ provider: 'claude-code-local', model: 'local/claude-haiku-5-5' });
    expect(await repo.get('provider.default')).toMatchObject({ updatedBy: 'owner', version: 2 });
  });

  // R8 PV-C01 (G5): the old assertion here (row stays null with the key set) was the hazard itself: with the key added and no row, the code
  // default `claude` applied and ALL main work ran on the API without a notice. Now the local default is seeded whenever local mode is on.
  it('G5: with an API key too, the local default is seeded and both providers register', async () => {
    const booted = await boot(db.pool, { localGuard: allowed(), env: { anthropicApiKey: 'sk-ant-test' }, start: false });
    app = booted.app;
    expect(await new ConfigRepo(db.pool).get('provider.default')).toMatchObject({ value: { provider: 'claude-code-local', model: 'local/claude-sonnet-5-5' }, updatedBy: 'system:first-local-boot' });
    expect(app.services.cfg.get('provider.default')).toEqual({ provider: 'claude-code-local', model: 'local/claude-sonnet-5-5' });
    expect(app.services.providers.has('claude')).toBe(true);
    expect(app.services.providers.has('claude-code-local')).toBe(true);
  });

  // The fake claude replaces the app's real one (a Map set), so a regression can never reach the network with a fake key.
  const spyClaude = (a: App) => {
    const claude = new FakeProvider(Array.from({ length: 5 }, () => ({ text: 'API-ANSWER' })), 'claude');
    a.services.providers.register(claude);
    return claude;
  };
  const claudeRows = async () => (await db.pool.query("SELECT 1 FROM audit_log WHERE action = 'llm.call' AND provider = 'claude'")).rowCount;

  it('G5b: first boot after a data reset, key set, the local guard failing, local mode on, no row: the row is seeded and no work runs on claude', async () => {
    const booted = await boot(db.pool, { localGuard: refusedGuard, localMode: true, env: { anthropicApiKey: 'sk-ant-test' }, depts: ['hq', 'software'] });
    app = booted.app;
    const claude = spyClaude(app);
    expect(await new ConfigRepo(db.pool).get('provider.default')).toMatchObject({ value: { provider: 'claude-code-local' }, updatedBy: 'system:first-local-boot' });
    expect(app.services.providers.has('claude-code-local')).toBe(false);
    expect(app.services.scheduler.canRun()).toBe(false); // idle: the selected provider is not registered
    await app.services.scheduler.onMessage(humanMsg('<@101> hello', { mentionedHeads: ['software'] }));
    await app.services.scheduler.idle();
    expect(claude.calls).toHaveLength(0);
    expect(await claudeRows()).toBe(0);
  });

  it('G5c: an invalid provider.default row in local mode is not read as the code default: idle, no claude call', async () => {
    await new ConfigRepo(db.pool).upsert('provider.default', { provider: 5 } as never, 'psql');
    const booted = await boot(db.pool, { localGuard: allowed(), env: { anthropicApiKey: 'sk-ant-test' }, depts: ['hq', 'software'] });
    app = booted.app;
    const claude = spyClaude(app);
    expect(await new ConfigRepo(db.pool).get('provider.default')).toMatchObject({ value: { provider: 5 }, updatedBy: 'psql' }); // never overwritten
    expect(app.services.scheduler.canRun()).toBe(false);
    expect(await health(app)).toMatchObject({ provider: 'unavailable' });
    await app.services.scheduler.onMessage(humanMsg('<@101> hello', { mentionedHeads: ['software'] }));
    await app.services.scheduler.idle();
    expect(fake.starts()).toHaveLength(0);
    expect(claude.calls).toHaveLength(0);
    expect(await claudeRows()).toBe(0);
    // fixing the row resumes work on the local provider
    await app.services.cfg.set('provider.default', { provider: 'claude-code-local', model: 'local/claude-sonnet-5-5' }, 'owner');
    expect(app.services.scheduler.canRun()).toBe(true);
  });

  it('a provider.default row deleted at runtime in local mode is not the code default either', async () => {
    const booted = await boot(db.pool, { localGuard: allowed(), env: { anthropicApiKey: 'sk-ant-test' }, depts: ['hq', 'software'] });
    app = booted.app;
    const claude = spyClaude(app);
    expect(app.services.scheduler.canRun()).toBe(true);
    await db.pool.query("DELETE FROM config WHERE key = 'provider.default'");
    await db.pool.query("SELECT pg_notify('config_changed', current_schema() || ':provider.default')");
    for (let i = 0; i < 50 && app.services.scheduler.canRun(); i++) await new Promise((r) => setTimeout(r, 20));
    expect(app.services.scheduler.canRun()).toBe(false);
    await app.services.scheduler.onMessage(humanMsg('<@101> hello', { mentionedHeads: ['software'] }));
    await app.services.scheduler.idle();
    expect(claude.calls).toHaveLength(0);
  });

  it('the VPS path is unchanged: no local mode, the key set, no row: nothing is seeded and the code default (claude) serves', async () => {
    const provider = new FakeProvider([{ text: 'vps' }], 'claude');
    const booted = await boot(db.pool, { provider, depts: ['hq', 'software'] });
    app = booted.app;
    expect(await new ConfigRepo(db.pool).get('provider.default')).toBeNull();
    expect(app.services.scheduler.canRun()).toBe(true);
    await app.services.scheduler.onMessage(humanMsg('<@101> hello', { mentionedHeads: ['software'] }));
    await app.services.scheduler.idle();
    expect(provider.calls).toHaveLength(1);
  });

  it('a local run in the booted app is counted against the local quota and costs $0', async () => {
    const booted = await boot(db.pool, { localGuard: allowed(), depts: ['hq', 'software'] });
    app = booted.app;
    await app.services.scheduler.onMessage(humanMsg('<@101> hello', { mentionedHeads: ['software'] }));
    await app.services.scheduler.idle();
    expect(fake.starts()).toHaveLength(1);
    const rows = await db.pool.query<{ scope: string; calls: number; spent_usd: number }>("SELECT scope, calls, spent_usd FROM budget_days WHERE scope = 'local'");
    expect(rows.rows).toEqual([{ scope: 'local', calls: 1, spent_usd: 0 }]);
  });

  it('unregistered provider.default at boot: governance alert, no loops, no crash, health reports it', async () => {
    await new ConfigRepo(db.pool).upsert('provider.default', { provider: 'claude-code-local', model: 'local/claude-sonnet-5-5' }, 'owner');
    const provider = new FakeProvider([{ text: 'never' }], 'claude');
    const booted = await boot(db.pool, { provider, depts: ['hq', 'software'] });
    app = booted.app;
    const alerts = booted.port.posts.filter((p) => p.target.channelId === BOT_LOG_CHANNEL && String(p.payload.title).startsWith('Incident ') && p.payload.body.includes('where: boot · provider'));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.payload).toMatchObject({ type: 'alert' });
    expect(alerts[0]!.payload.body).toContain('probe-local-cli.sh');
    expect(app.services.scheduler.canRun()).toBe(false);
    await app.services.scheduler.onMessage(humanMsg('<@101> hello', { mentionedHeads: ['software'] }));
    await app.services.scheduler.idle();
    expect(provider.calls).toHaveLength(0);
    expect(await health(app)).toMatchObject({ db: 'ok', provider: 'unavailable' });
    // Fixing the default resumes work without a restart.
    await app.services.cfg.set('provider.default', { provider: 'claude', model: 'claude-sonnet-5-5' }, 'owner');
    expect(app.services.scheduler.canRun()).toBe(true);
    expect(await health(app)).toMatchObject({ provider: 'ok' });
  });
});
