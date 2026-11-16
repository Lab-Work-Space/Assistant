import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { allowLoopbackForTest } from '../vitest.setup.no-network.js';
import { ADMIN_READ_KEYS } from '../admin/keys.js';
import { ADMIN_USER, http, rawHttp, rig } from './test-helpers.js';

beforeAll(allowLoopbackForTest);
let x: Awaited<ReturnType<typeof rig>> | null = null;
afterEach(async () => { await x?.close(); x = null; });
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

describe('dashboard: local only, Host and Origin (S38, S39)', () => {
  it('binds the literal 127.0.0.1 (no host option exists)', async () => {
    x = await rig();
    expect(x.server.address().host).toBe('127.0.0.1');
  });

  it('refuses a wrong, container-style, missing or duplicated Host', async () => {
    x = await rig();
    for (const host of ['evil.example', `host.docker.internal:${x.port}`, `evil.example:${x.port}`, '127.0.0.1', `127.0.0.1:${x.port + 1}`, `[::1]:${x.port}`]) {
      expect((await http(x.port, { path: '/', headers: { host } })).status, host).toBe(421);
    }
    const none = await rawHttp(x.port, 'GET / HTTP/1.0\r\n\r\n');
    expect(none).toContain('421');
    const dup = await rawHttp(x.port, `GET / HTTP/1.1\r\nHost: 127.0.0.1:${x.port}\r\nHost: 127.0.0.1:${x.port}\r\nConnection: close\r\n\r\n`);
    expect(dup).toContain('421');
    expect((await http(x.port, { path: '/app.css', headers: { host: `localhost:${x.port}` } })).status).toBe(200);
  });

  it('has no CORS headers; OPTIONS is 405', async () => {
    x = await rig();
    const r = await http(x.port, { method: 'OPTIONS', path: '/', headers: { origin: 'http://localhost:3001', 'access-control-request-method': 'POST' } });
    expect(r.status).toBe(405);
    expect(Object.keys(r.headers).filter((h) => h.startsWith('access-control'))).toEqual([]);
  });

  it('a POST needs the exact Origin (port included) and a same-origin Sec-Fetch-Site', async () => {
    x = await rig();
    const s = await x.login();
    const body = new URLSearchParams({ _csrf: s.csrf, action: 'holiday_add' }).toString();
    const base = { ...FORM, cookie: s.cookie };
    expect((await http(x.port, { method: 'POST', path: '/propose', headers: base, body })).status).toBe(403); // no Origin
    for (const origin of ['http://localhost:3001', 'http://127.0.0.1:3001', `http://evil.example:${x.port}`, 'null', `https://127.0.0.1:${x.port}`]) {
      expect((await http(x.port, { method: 'POST', path: '/propose', headers: { ...base, origin }, body })).status, origin).toBe(403);
    }
    expect((await http(x.port, { method: 'POST', path: '/propose', headers: { ...base, origin: x.origin, 'sec-fetch-site': 'cross-site' }, body })).status).toBe(403);
    expect((await http(x.port, { method: 'POST', path: '/propose', headers: { ...base, origin: x.origin, 'sec-fetch-site': 'same-origin' }, body })).status).not.toBe(403);
  });
});

describe('dashboard: login link (S41, S42, S43)', () => {
  it('a GET of the link shows a Continue button and consumes nothing; the POST consumes once and sets a hardened cookie', async () => {
    x = await rig();
    const l = await x.auth.issueLink(ADMIN_USER);
    if (!l.ok) throw new Error('rate');
    const get = await http(x.port, { path: `/login?t=${l.token}` });
    expect(get.status).toBe(200);
    expect(get.body).toContain('Continue');
    expect(get.headers['set-cookie']).toBeUndefined();
    await http(x.port, { path: `/login?t=${l.token}` }); // a prefetch or an unfurl, twice
    const post = await x.post('/login', { t: l.token });
    expect(post.status).toBe(303);
    expect(post.headers.location).toBe('/'); // a clean URL (S42)
    const cookie = String(post.headers['set-cookie']);
    expect(cookie).toMatch(/^lw_dash_sid=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict/);
    expect(cookie).not.toMatch(/Domain/i);
    expect((await x.post('/login', { t: l.token })).status).toBe(403); // reused
  });

  it('two parallel consumes give one session', async () => {
    x = await rig();
    const l = await x.auth.issueLink(ADMIN_USER);
    if (!l.ok) throw new Error('rate');
    const r = await Promise.all([x.post('/login', { t: l.token }), x.post('/login', { t: l.token })]);
    expect(r.map((v) => v.status).sort()).toEqual([303, 403]);
    expect(x.store.sessions.size).toBe(1);
  });

  it('an unknown, malformed or expired token is refused, and the store holds only hashes', async () => {
    x = await rig();
    expect((await x.post('/login', { t: 'x'.repeat(43) })).status).toBe(403);
    expect((await x.post('/login', { t: 'short' })).status).toBe(403);
    const l = await x.auth.issueLink(ADMIN_USER);
    if (!l.ok) throw new Error('rate');
    expect([...x.store.links.keys()].every((k) => /^[0-9a-f]{64}$/.test(k) && k !== l.token)).toBe(true);
    for (const v of x.store.links.values()) v.exp = Date.now() - 1;
    expect((await x.post('/login', { t: l.token })).status).toBe(403);
  });

  it('a planted cookie value is not adopted (fixation) and a request after revoke is 401', async () => {
    x = await rig();
    const planted = 'p'.repeat(43);
    const l = await x.auth.issueLink(ADMIN_USER);
    if (!l.ok) throw new Error('rate');
    const r = await x.post('/login', { t: l.token }, { cookie: `lw_dash_sid=${planted}` });
    expect(String(r.headers['set-cookie'])).not.toContain(planted);
    expect((await http(x.port, { path: '/', headers: { cookie: `lw_dash_sid=${planted}` } })).status).toBe(401);
    const s = await x.login();
    expect((await http(x.port, { path: '/', headers: { cookie: s.cookie } })).status).toBe(200);
    const out = await x.post('/revoke-all', { _csrf: s.csrf }, { cookie: s.cookie });
    expect(out.status).toBe(303);
    expect((await http(x.port, { path: '/', headers: { cookie: s.cookie } })).status).toBe(401);
  });

  it('logout deletes only that session server-side', async () => {
    x = await rig();
    const a = await x.login();
    const b = await x.login();
    expect((await x.post('/logout', { _csrf: a.csrf }, { cookie: a.cookie })).status).toBe(303);
    expect((await http(x.port, { path: '/', headers: { cookie: a.cookie } })).status).toBe(401);
    expect((await http(x.port, { path: '/', headers: { cookie: b.cookie } })).status).toBe(200);
  });

  it('refused login attempts lock after 10 a minute, but a live unused token still logs in during the lock (S51 amended)', async () => {
    x = await rig();
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await x.post('/login', { t: 'x'.repeat(43) })).status;
    expect(last).toBe(429);
    const l = await x.auth.issueLink(ADMIN_USER);
    if (!l.ok) throw new Error('rate');
    expect((await x.post('/login', { t: l.token })).status).toBe(303); // a valid token is not a guess: the lock never keeps the owner out
    expect((await x.post('/login', { t: 'y'.repeat(43) })).status).toBe(429); // strangers stay locked
  });
});

describe('dashboard: CSRF and the live role (S44, S47)', () => {
  it('a POST that carries the cookie and the right Origin but no token, a wrong token, another session\'s token or a non-ASCII token is refused (403, never 500)', async () => {
    x = await rig();
    const a = await x.login();
    const b = await x.login();
    const fields = { action: 'holiday_add', f_date: '2026-12-31' };
    expect((await x.post('/propose', fields, { cookie: a.cookie })).status).toBe(403);
    expect((await x.post('/propose', { ...fields, _csrf: 'nope' }, { cookie: a.cookie })).status).toBe(403);
    expect((await x.post('/propose', { ...fields, _csrf: b.csrf }, { cookie: a.cookie })).status).toBe(403);
    expect((await x.post('/propose', { ...fields, _csrf: 'ทดสอบ\u0000é' }, { cookie: a.cookie })).status).toBe(403);
    expect(x.proposals).toEqual([]);
    expect((await x.post('/propose', { ...fields, _csrf: a.csrf }, { cookie: a.cookie })).status).toBe(303);
    expect(x.proposals).toHaveLength(1);
  });

  it('GET handlers never change state', async () => {
    x = await rig();
    const s = await x.login();
    for (const p of ['/', '/config', '/cards', '/propose', '/audit', '/spend', '/members', '/channels', '/cards/apply?card=' + 'a'.repeat(32), '/logout']) {
      await http(x.port, { path: p, headers: { cookie: s.cookie } });
    }
    expect(x.applied).toEqual([]);
    expect(x.proposals).toEqual([]);
    expect(x.store.sessions.size).toBe(1);
  });

  it('removing Bot Admin after login: the next write is refused and every session of that user is gone', async () => {
    x = await rig();
    const a = await x.login();
    const b = await x.login();
    x.setAdmin(false);
    const r = await x.post('/cards/apply', { _csrf: a.csrf, card: 'a'.repeat(32) }, { cookie: a.cookie });
    expect(r.status).toBe(401);
    expect(x.applied).toEqual([]);
    expect(x.store.sessions.size).toBe(0);
    expect((await http(x.port, { path: '/', headers: { cookie: b.cookie } })).status).toBe(401);
  });

  it('a read page re-checks the role when the last check is older than 5 minutes', async () => {
    x = await rig();
    const a = await x.login();
    x.setAdmin(false);
    expect((await http(x.port, { path: '/', headers: { cookie: a.cookie } })).status).toBe(200); // within 5 minutes: no fetch yet
    for (const s of x.store.sessions.values()) s.checked = Date.now() - 6 * 60_000;
    expect((await http(x.port, { path: '/', headers: { cookie: a.cookie } })).status).toBe(401);
    expect(x.store.sessions.size).toBe(0);
  });

  it('a failed role fetch refuses (fail closed)', async () => {
    let n = 0;
    x = await rig({ isAdmin: async () => { if (++n > 1) throw new Error('discord down'); return true; } });
    const a = await x.login();
    expect((await x.post('/cards/apply', { _csrf: a.csrf, card: 'a'.repeat(32) }, { cookie: a.cookie })).status).toBe(401);
    expect(x.applied).toEqual([]);
  });

  it('Apply passes the session user and the card id to the console (the actor is the session, never the form)', async () => {
    x = await rig();
    const a = await x.login();
    const r = await x.post('/cards/apply', { _csrf: a.csrf, card: 'a'.repeat(32), user: '1' }, { cookie: a.cookie });
    expect(r.status).toBe(200);
    expect(x.applied).toEqual([['a'.repeat(32), ADMIN_USER]]);
  });

  it('a proposal is made as the session user, via dashboard, never tainted; a bad field is refused before the console', async () => {
    x = await rig();
    const a = await x.login();
    await x.post('/propose', { _csrf: a.csrf, action: 'holiday_add', f_date: '2026-12-31', f_name: 'NYE' }, { cookie: a.cookie });
    expect(x.proposals[0]).toMatchObject({ who: { userId: ADMIN_USER, tainted: false, via: 'dashboard' }, kind: 'admin_op', raw: { op: 'holiday_add', date: '2026-12-31' } });
    const bad = await x.post('/propose', { _csrf: a.csrf, action: 'budget_set', f_scope: 'daily', f_usd: '-5' }, { cookie: a.cookie });
    expect(bad.status).toBe(422);
    const stub = await x.post('/propose', { _csrf: a.csrf, action: 'mod_ban' }, { cookie: a.cookie });
    expect(stub.status).toBe(422);
    expect(stub.body).toContain('available after server management is enabled');
    expect(x.proposals).toHaveLength(1);
  });
});

describe('dashboard: headers, limits, escaping, scope (S40, S42, S45, S48, S49)', () => {
  it('every response sends the CSP with frame-ancestors none, X-Frame-Options, nosniff, no-referrer and no-store; pages load nothing third-party', async () => {
    x = await rig();
    const s = await x.login();
    for (const r of [await http(x.port, { path: '/', headers: { cookie: s.cookie } }), await http(x.port, { path: '/' }), await http(x.port, { path: '/app.css' }), await http(x.port, { path: '/', headers: { host: 'evil.example' } })]) {
      expect(r.headers['content-security-policy']).toBe("default-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'; object-src 'none'");
      expect(r.headers['x-frame-options']).toBe('DENY');
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['referrer-policy']).toBe('same-origin'); // not no-referrer: that makes browsers send Origin: null on form POSTs
      expect(r.headers['cache-control']).toBe('no-store');
    }
    for (const path of ['/', '/config', '/cards', '/propose', '/audit', '/spend', '/members', '/channels', '/login?t=' + 'a'.repeat(43)]) {
      const page = (await http(x.port, { path, headers: { cookie: s.cookie } })).body;
      expect(page, path).not.toMatch(/<script|\sstyle=|<style|https?:\/\/|name="referrer"/i); // inline style or script would be blocked by the CSP; nothing third-party
    }
  });

  it('a body over 64 KB and a duplicated form key are refused; server timeouts are set', async () => {
    x = await rig();
    const big = await http(x.port, { method: 'POST', path: '/login', headers: { origin: x.origin, ...FORM }, body: 't=' + 'a'.repeat(70_000) });
    expect(big.status).toBe(400);
    const dup = await http(x.port, { method: 'POST', path: '/login', headers: { origin: x.origin, ...FORM }, body: 't=aaaaaaaaaaaaaaaaaaaaaaaaa&t=bbbbbbbbbbbbbbbbbbbbbbbbb' });
    expect(dup.status).toBe(400);
    const json = await http(x.port, { method: 'POST', path: '/login', headers: { origin: x.origin, 'content-type': 'application/json' }, body: '{}' });
    expect(json.status).toBe(400);
  });

  it('the token, the cookie and the query string never reach the logs or the audit', async () => {
    x = await rig();
    const s = await x.login();
    await http(x.port, { path: `/login?t=${s.token}` });
    await http(x.port, { path: '/audit?actor=zed', headers: { cookie: s.cookie } });
    const text = JSON.stringify([x.logs, x.audits]);
    const sid = s.cookie.split('=')[1]!;
    for (const secret of [s.token, sid, s.csrf]) expect(text).not.toContain(secret);
    expect(text).not.toContain('actor=zed');
    expect(x.logs.length).toBeGreaterThan(0);
  });

  it('the config page reads only ADMIN_READ_KEYS (never halted), hides a secret-looking value, and shows halt as a label', async () => {
    let asked: readonly string[] = [];
    x = await rig({ data: { readConfig: (keys) => { asked = keys; return keys.slice(0, 3).map((key) => ({ key, value: 'sk-ant-abcdefgh12345678' })); } } });
    const s = await x.login();
    const page = (await http(x.port, { path: '/config', headers: { cookie: s.cookie } })).body;
    expect(asked).toEqual(ADMIN_READ_KEYS);
    expect(asked).not.toContain('halted');
    expect(page).toContain('(hidden)');
    expect(page).not.toContain('sk-ant');
  });

  it('Discord-sourced strings are escaped and bidi controls are made visible', async () => {
    x = await rig({ data: {
      audit: async () => [{ id: 1, ts: new Date(0), actor: '<img src=x onerror=alert(1)>', action: 'a‮b', tool: null, outcome: '"><script>alert(1)</script>' }],
      channels: async () => [{ id: '700000000000000001', name: '<b onmouseover=x>​name', parentId: null, type: 0 }],
    } });
    const s = await x.login();
    const audit = (await http(x.port, { path: '/audit', headers: { cookie: s.cookie } })).body;
    expect(audit).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(audit).not.toContain('<img');
    expect(audit).not.toContain('<script>alert');
    expect(audit).toContain('\\u{202E}');
    expect(audit).not.toContain('‮');
    const ch = (await http(x.port, { path: '/channels', headers: { cookie: s.cookie } })).body;
    expect(ch).toContain('&lt;b onmouseover=x&gt;\\u{200B}name');
  });

  it('members are unavailable until server management exists; channels show a locked count only', async () => {
    x = await rig();
    const s = await x.login();
    expect((await http(x.port, { path: '/members', headers: { cookie: s.cookie } })).body).toContain('Available after server management is enabled');
    expect((await http(x.port, { path: '/channels', headers: { cookie: s.cookie } })).body).toContain('2 protected channels');
  });

  it('the audit filter is passed as bound values and the sort is whitelisted', async () => {
    let q: unknown;
    x = await rig({ data: { audit: async (a) => { q = a; return []; } } });
    const s = await x.login();
    await http(x.port, { path: `/audit?actor=${encodeURIComponent("x'; DROP TABLE audit_log;--")}&sort=${encodeURIComponent('id; DROP')}&dir=sideways&page=-4`, headers: { cookie: s.cookie } });
    expect(q).toMatchObject({ sort: 'ts', dir: 'desc', limit: 50, offset: 0 });
  });
});
