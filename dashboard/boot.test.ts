import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SettingsRegistry } from '../admin/settings.js';
import { checkUrl } from '../net/guard.js';
import { allowLoopbackForTest } from '../vitest.setup.no-network.js';
import { bootDashboard, runPurge, dashboardPortFrom, type BootDashboardOptions, type RunningDashboard } from './boot.js';
import { fakeData, http, MemStore } from './test-helpers.js';

beforeAll(allowLoopbackForTest);
let running: RunningDashboard | null = null;
afterEach(async () => { await running?.close(); running = null; });

const base = (over: Partial<BootDashboardOptions> = {}): BootDashboardOptions => ({
  local: true, inContainer: () => null, port: 0, store: new MemStore(), audit: async () => undefined, isAdmin: async () => true,
  console: { applyFromDashboard: async () => ({ ok: false, why: 'x' }), cancelFromDashboard: async () => false }, settings: new SettingsRegistry(), data: fakeData(),
  log: { info: () => undefined, error: () => undefined }, ...over,
});

describe('dashboard boot (S38)', () => {
  it('does not start when the mode is not local, and does not start in a container', async () => {
    expect(await bootDashboard(base({ local: false }))).toBeNull();
    expect(await bootDashboard(base({ inContainer: () => 'running in a container' }))).toBeNull();
  });

  it('starts on 127.0.0.1 only and its /dashboard link points at that origin', async () => {
    running = await bootDashboard(base());
    expect(running).not.toBeNull();
    expect(running!.server.address().host).toBe('127.0.0.1');
    const l = await running!.link('900000000000000001');
    expect(l.ok && l.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/login\?t=[A-Za-z0-9_-]{43}$/);
    const port = running!.server.address().port;
    expect((await http(port, { path: l.ok ? l.url.slice(l.url.indexOf('/login')) : '' })).body).toContain('Continue');
  });

  it('a port that is already taken logs and returns null instead of throwing (the app keeps running)', async () => {
    running = await bootDashboard(base());
    const taken = running!.server.address().port;
    const errors: unknown[] = [];
    const second = await bootDashboard(base({ port: taken, log: { info: () => undefined, error: (o) => void errors.push(o) } }));
    expect(second).toBeNull();
    expect(errors).toHaveLength(1);
    expect(JSON.stringify(errors)).not.toMatch(/token|cookie/i);
  });

  it('the purge audits how many sessions expired (S51), and nothing when none did', async () => {
    const audits: unknown[] = [];
    const store = Object.assign(new MemStore(), { purge: async () => 3 });
    expect(await runPurge({ store, audit: async (e) => void audits.push(e) })).toBe(3);
    expect(audits).toEqual([{ actor: 'system:dashboard', action: 'dashboard.session', outcome: 'expired:3' }]);
    await runPurge({ store: new MemStore(), audit: async (e) => void audits.push(e) });
    expect(audits).toHaveLength(1);
  });

  it('the port comes from DASHBOARD_PORT in the process env when valid', () => {
    expect(dashboardPortFrom(undefined)).toBe(8787);
    expect(dashboardPortFrom('9001')).toBe(9001);
    for (const bad of ['80', '99999', 'abc', '8080; rm', '']) expect(dashboardPortFrom(bad), bad).toBe(8787);
  });

  it('the deploy files publish no dashboard port and do not mention the dashboard', () => {
    const root = join(__dirname, '..');
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else files.push(p); } };
    walk(join(root, 'deploy'));
    for (const f of readdirSync(root)) if (/^docker-compose.*\.ya?ml$/.test(f)) files.push(join(root, f));
    for (const f of files.filter((x) => !x.endsWith('.test.ts'))) expect(readFileSync(f, 'utf8'), f).not.toMatch(/dashboard|DASHBOARD_PORT|8787/i);
  });

  it('the net guard (the web tools and the Chrome proxy share it) refuses the dashboard by 127.0.0.1, localhost and host.docker.internal (S50)', async () => {
    const dockerHost = async () => ['192.168.65.254']; // what host.docker.internal resolves to on Docker Desktop: a private address
    for (const url of ['http://127.0.0.1:8787/', 'http://localhost:8787/', 'http://[::1]:8787/', 'http://host.docker.internal:8787/', 'http://host.docker.internal/']) {
      await expect(checkUrl(url, { resolver: dockerHost, extraPorts: [8787] }), url).rejects.toMatchObject({ code: 'blocked' });
    }
  });
});
