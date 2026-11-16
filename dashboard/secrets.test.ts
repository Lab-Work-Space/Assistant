import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { allowLoopbackForTest } from '../vitest.setup.no-network.js';
import { createEnvEntry } from './envEntry.js';
import { BASE_ENV, envFixture, http, rig } from './test-helpers.js';

beforeAll(allowLoopbackForTest);
const SENTINEL = 'zqSENTINELzq7x9w2v';
const BAD_SENTINEL = 'zqBADSENTINELzq7 x9'; // refused by E7 (space) - must not appear anywhere either
let r: Awaited<ReturnType<typeof rig>>;
afterEach(async () => { await r?.close(); });
const form = (s: { csrf: string }, key: string, value: string) => ({ _csrf: s.csrf, key, value });
const dump = () => JSON.stringify({ logs: r.logs, audits: r.audits, notices: r.notices });

describe('Secrets page', () => {
  it('lists presence only and never pre-fills a value', async () => {
    r = await rig({ env: { text: `${BASE_ENV}GOOGLE_SHEETS_WEBAPP_SECRET=${SENTINEL}\n` } });
    const s = await r.login();
    const p = await http(r.port, { path: '/secrets', headers: { cookie: s.cookie } });
    expect(p.status).toBe(200);
    expect(p.headers['cache-control']).toBe('no-store');
    expect(p.body).toContain('GOOGLE_SHEETS_WEBAPP_SECRET');
    expect(p.body).not.toContain(SENTINEL);
    expect(p.body).toMatch(/type="password"[^>]*autocomplete="new-password"/);
    expect(p.body).not.toMatch(/<input[^>]*type="password"[^>]*value=/);
    expect(p.body).toContain('provider and account');
  });
  it('is 404 when env entry is not wired', async () => {
    r = await rig();
    const s = await r.login();
    expect((await http(r.port, { path: '/secrets', headers: { cookie: s.cookie } })).status).toBe(404);
  });
});

describe('writes: sentinel (E16, E17, E18)', () => {
  it('the value is in the file only: not in the response, logs, audit, notice, and a refused value is not echoed either', async () => {
    r = await rig({ env: {} });
    const s = await r.login();
    const ok = await r.post('/secrets/set', form(s, 'GOOGLE_SHEETS_WEBAPP_SECRET', SENTINEL), { cookie: s.cookie });
    const bad = await r.post('/secrets/set', form(s, 'GOOGLE_SHEETS_WEBAPP_SECRET', BAD_SENTINEL), { cookie: s.cookie });
    const unknown = await r.post('/secrets/set', form(s, BAD_SENTINEL, SENTINEL), { cookie: s.cookie });
    const forbidden = await r.post('/secrets/set', form(s, 'DATABASE_URL', SENTINEL), { cookie: s.cookie });
    for (const x of [ok, bad, unknown, forbidden]) {
      expect(x.status).toBe(200); // E16: one status family
      expect(x.headers['cache-control']).toBe('no-store');
      expect(x.body).not.toContain(SENTINEL);
      expect(x.body).not.toContain(BAD_SENTINEL);
      expect(x.body).not.toMatch(/value="[^"]*zq/);
    }
    expect(ok.body).toContain('Saved');
    for (const x of [bad, unknown, forbidden]) expect(x.body).toContain('Not saved');
    expect(readFileSync(r.fx!.file, 'utf8')).toContain(`GOOGLE_SHEETS_WEBAPP_SECRET=${SENTINEL}`);
    const d = dump();
    expect(d).not.toContain(SENTINEL);
    expect(d).not.toContain('zqBAD');
    expect(d).not.toContain('DATABASE_URL'); // forbidden names are not audited
    expect(r.audits.filter((a) => a['action'] === 'env.set').map((a) => [a['tool'], a['outcome']])).toEqual([
      ['GOOGLE_SHEETS_WEBAPP_SECRET', 'ok'], ['GOOGLE_SHEETS_WEBAPP_SECRET', 'refused:value'], [undefined, 'refused:key'], [undefined, 'refused:key']]);
    expect(r.audits.find((a) => a['action'] === 'env.set')!['actor']).toBe(`user:${s.cookie ? '900000000000000001' : ''} via dashboard`);
    expect(r.notices).toEqual(['env key GOOGLE_SHEETS_WEBAPP_SECRET was changed by <@900000000000000001>; restart required']);
    // the status page afterwards shows set, nothing else
    const p = await http(r.port, { path: '/secrets', headers: { cookie: s.cookie } });
    expect(p.body).not.toContain(SENTINEL);
  });
  it('clear removes the key and audits env.clear', async () => {
    r = await rig({ env: { text: `${BASE_ENV}CLICKUP_LIST_ID=abc\n` } });
    const s = await r.login();
    const c = await r.post('/secrets/clear', { _csrf: s.csrf, key: 'CLICKUP_LIST_ID' }, { cookie: s.cookie });
    expect(c.status).toBe(200);
    expect(readFileSync(r.fx!.file, 'utf8')).toBe(BASE_ENV);
    expect(r.audits.some((a) => a['action'] === 'env.clear' && a['tool'] === 'CLICKUP_LIST_ID' && a['outcome'] === 'ok')).toBe(true);
  });
  it('a writer that throws an error carrying the value leaks it nowhere (E17)', async () => {
    r = await rig({ env: { writer: { status: async () => ({}), set: async (_k, v) => { throw new Error(`boom ${v}`); }, clear: async () => { throw new Error('x'); } } } });
    const s = await r.login();
    const x = await r.post('/secrets/set', form(s, 'GOOGLE_SHEETS_WEBAPP_SECRET', SENTINEL), { cookie: s.cookie });
    expect(x.status).toBe(200);
    expect(x.body).not.toContain(SENTINEL);
    expect(dump()).not.toContain(SENTINEL);
    expect(r.audits.at(-1)!['outcome']).toBe('refused:io');
  });
});

describe('auth on writes (E14, E15, E17)', () => {
  it('step-up: an old session gets the fixed log-in-again page with no key status, for GET and POST', async () => {
    let t = Date.now() + 5_000;
    r = await rig({ env: {}, now: () => t });
    const s = await r.login();
    expect((await http(r.port, { path: '/secrets', headers: { cookie: s.cookie } })).status).toBe(200);
    t += 11 * 60_000;
    const g = await http(r.port, { path: '/secrets', headers: { cookie: s.cookie } });
    const p = await r.post('/secrets/set', form(s, 'CLICKUP_LIST_ID', 'abc'), { cookie: s.cookie });
    for (const x of [g, p]) { expect(x.status).toBe(403); expect(x.body).toContain('Log in again'); expect(x.body).not.toContain('CLICKUP_LIST_ID'); }
    expect(readFileSync(r.fx!.file, 'utf8')).toBe(BASE_ENV);
    // activity on other pages does not refresh it
    await http(r.port, { path: '/', headers: { cookie: s.cookie } });
    expect((await http(r.port, { path: '/secrets', headers: { cookie: s.cookie } })).status).toBe(403);
  });
  it('CSRF, Origin and a live role loss all refuse before anything is written', async () => {
    r = await rig({ env: {} });
    const s = await r.login();
    expect((await r.post('/secrets/set', { ...form(s, 'CLICKUP_LIST_ID', 'abc'), _csrf: 'f'.repeat(64) }, { cookie: s.cookie })).status).toBe(403);
    expect((await r.post('/secrets/set', form(s, 'CLICKUP_LIST_ID', 'abc'), { cookie: s.cookie, origin: 'http://evil.example' })).status).toBe(403);
    expect((await r.post('/secrets/set', form(s, 'CLICKUP_LIST_ID', 'abc'), {})).status).toBe(401);
    r.setAdmin(false);
    expect((await r.post('/secrets/set', form(s, 'CLICKUP_LIST_ID', 'abc'), { cookie: s.cookie })).status).toBe(401);
    expect(readFileSync(r.fx!.file, 'utf8')).toBe(BASE_ENV);
  });
  it('body limit 4 KiB and urlencoded only', async () => {
    r = await rig({ env: {} });
    const s = await r.login();
    const big = await r.post('/secrets/set', form(s, 'CLICKUP_LIST_ID', 'a'.repeat(5000)), { cookie: s.cookie });
    expect(big.status).toBe(400);
    const json = await http(r.port, { method: 'POST', path: '/secrets/set', headers: { cookie: s.cookie, origin: r.origin, 'content-type': 'application/json' }, body: '{}' });
    expect(json.status).toBe(400);
    expect(readFileSync(r.fx!.file, 'utf8')).toBe(BASE_ENV);
  });
  it('rate limit: 10 attempts per admin per hour counting failures, refusals audited without a value, a new hour resets', async () => {
    let t = 1_000_000;
    r = await rig({ env: {}, now: () => t });
    // use the entry directly for speed; the route shares it
    const f = envFixture(); const audits: Record<string, unknown>[] = [];
    const e = createEnvEntry({ paths: { dir: f.dir }, audit: async (a) => void audits.push(a as never), notify: async () => undefined, log: { error: () => undefined }, now: () => t });
    for (let i = 0; i < 10; i++) expect((await e.set('u1', 'CLICKUP_LIST_ID', i % 2 ? 'abc' : 'bad value')).ok).toBe(i % 2 === 1);
    expect(await e.set('u1', 'CLICKUP_LIST_ID', 'abc')).toEqual({ ok: false, reason: 'rate' });
    expect(await e.clear('u1', 'CLICKUP_LIST_ID')).toEqual({ ok: false, reason: 'rate' });
    expect((await e.set('u2', 'CLICKUP_LIST_ID', 'abc')).ok).toBe(true); // per admin
    expect(audits.at(-2)).toMatchObject({ action: 'env.clear', outcome: 'refused:rate' });
    t += 3_600_001;
    expect((await e.set('u1', 'CLICKUP_LIST_ID', 'abc')).ok).toBe(true);
    f.cleanup();
  });
  it('server-wide cap applies across admins', async () => {
    const f = envFixture(); const t = 5;
    const e = createEnvEntry({ paths: { dir: f.dir }, audit: async () => undefined, notify: async () => undefined, log: { error: () => undefined }, now: () => t });
    let refused = 0;
    for (let i = 0; i < 40; i++) if (!(await e.set(`admin${i}`, 'CLICKUP_LIST_ID', 'abc')).ok) refused++;
    expect(refused).toBe(10);
    f.cleanup();
    r = await rig();
  });
  it('a notice failure does not fail the write', async () => {
    const f = envFixture();
    const e = createEnvEntry({ paths: { dir: f.dir }, audit: async () => undefined, notify: async () => { throw new Error('discord down'); }, log: { error: () => undefined } });
    expect((await e.set('u', 'CLICKUP_LIST_ID', 'abc')).ok).toBe(true);
    f.cleanup();
    r = await rig();
  });
});

describe('E20: no other path reaches the writer', () => {
  it('only dashboard/envEntry.ts, dashboard/pages.ts (key names), dashboard/boot.ts import envfile; nothing outside dashboard/ does', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        if (['node_modules', 'dist', '.git', '.claude'].includes(n)) continue;
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.ts$/.test(n) && !/\.test\.ts$/.test(n) && /from '[^']*envfile(\.js)?'/.test(readFileSync(p, 'utf8'))) hits.push(relative(root, p));
      }
    };
    walk(root);
    expect(hits.sort()).toEqual(['dashboard/envEntry.ts', 'dashboard/pages.ts']);
    // the writer class itself (not just key names) is imported by envEntry.ts only
    const writerUsers = hits.filter((h) => /\bEnvWriter\b/.test(readFileSync(join(root, h), 'utf8')));
    expect(writerUsers).toEqual(['dashboard/envEntry.ts']);
  });
});
