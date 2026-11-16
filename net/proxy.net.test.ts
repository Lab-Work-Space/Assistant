/**
 * Real-socket tests for the Chrome guard proxy (Gate 1 C24, C27), vitest project `net`: `npx vitest run --project net`.
 * Loopback servers only. "Public" names come from a fake resolver and a predicate that lets only 127.0.0.1 through, so the
 * allowed path can be exercised; the blocking cases use the real `isBlockedAddress`.
 */
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeResolver } from '../tests/fakes/net.js';
import { isBlockedAddress } from './address.js';
import { createCheckTarget } from './fetch.js';
import { bearerOk, createControlServer, createForwarder, createGuardProxy, inCidr, type GuardProxy } from './proxy.js';

let origin: http.Server;
let echo: net.Server;
let originPort = 0;
let echoPort = 0;
const originSeen: { host: string; url: string }[] = [];
let originConns = 0;
let rebinds = 0;
const resolver = fakeResolver({
  'pub.test': ['127.0.0.1'],
  'evil.test': ['10.1.2.3'],
  'rebind.test': (n) => (n === 1 ? ['127.0.0.1'] : ['10.1.2.3']),
});

const listen = (s: http.Server | net.Server) => new Promise<number>((ok) => s.listen(0, '127.0.0.1', () => ok((s.address() as AddressInfo).port)));
const TOKEN = 't'.repeat(40);
const bearer = { authorization: `Bearer ${TOKEN}` };
const basic = (s: { user: string; pass: string }) => `Basic ${Buffer.from(`${s.user}:${s.pass}`).toString('base64')}`;

function mk(realGuard: boolean, caps = {}): GuardProxy {
  void rebinds;
  return createGuardProxy({
    check: createCheckTarget(realGuard ? isBlockedAddress : (a) => a !== '127.0.0.1'),
    resolver,
    extraPorts: () => [originPort, echoPort],
    caps,
  });
}
const up = async (p: GuardProxy) => ({ port: await listen(p.server) });

/** One request through the proxy as Chrome sends it (absolute-form). */
function viaProxy(proxyPort: number, url: string, auth?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((ok, bad) => {
    const r = http.request({ host: '127.0.0.1', port: proxyPort, path: url, headers: { host: new URL(url).host, ...(auth ? { 'proxy-authorization': auth } : {}) }, agent: false }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (c: Buffer) => parts.push(c));
      res.on('end', () => ok({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts).toString() }));
      res.on('error', () => ok({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts).toString() }));
    });
    r.on('error', bad);
    r.end();
  });
}

/** CONNECT through the proxy: resolves with the status line and, when 200, the open socket. */
function connectVia(proxyPort: number, authority: string, auth?: string): Promise<{ status: number; socket: net.Socket }> {
  return new Promise((ok, bad) => {
    const r = http.request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: authority, headers: { host: authority, ...(auth ? { 'proxy-authorization': auth } : {}) }, agent: false });
    r.on('connect', (res, socket) => ok({ status: res.statusCode ?? 0, socket }));
    r.on('response', (res) => ok({ status: res.statusCode ?? 0, socket: res.socket }));
    r.on('error', bad);
    r.end();
  });
}

beforeAll(async () => {
  origin = http.createServer((req, res) => {
    originSeen.push({ host: req.headers.host ?? '', url: req.url ?? '' });
    if (req.url === '/big') return void res.writeHead(200, { 'content-type': 'text/plain' }).end(Buffer.alloc(300_000, 97));
    if (req.url === '/redir') return void res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
    res.writeHead(200, { 'content-type': 'text/html' }).end('<p>hello</p>');
  });
  origin.on('connection', () => void originConns++);
  echo = net.createServer((s) => s.on('data', (d) => s.write(Buffer.concat([Buffer.from('echo:'), Buffer.from(d)]))));
  originPort = await listen(origin);
  echoPort = await listen(echo);
});
afterAll(() => {
  origin.close();
  echo.close();
});

describe('guard proxy › credential', () => {
  it('refuses a request and a tunnel without the credential, or with a wrong one', async () => {
    const p = mk(false);
    const { port } = await up(p);
    const s = p.openSession();
    const url = `http://pub.test:${originPort}/`;
    expect((await viaProxy(port, url)).status).toBe(407);
    expect((await viaProxy(port, url, basic({ user: s.user, pass: 'wrong' }))).status).toBe(407);
    expect((await connectVia(port, `pub.test:${echoPort}`)).status).toBe(407);
    expect(originSeen.filter((r) => r.url === '/')).toHaveLength(0);
    expect((await viaProxy(port, url, basic(s))).status).toBe(200);
    p.closeSession(s.user);
    expect((await viaProxy(port, url, basic(s))).status).toBe(407); // a closed session's credential is dead
    p.server.close();
  });
});

describe('guard proxy › egress policy', () => {
  it('forwards an allowed host to the checked address, keeping the Host header', async () => {
    const p = mk(false);
    const { port } = await up(p);
    const s = p.openSession();
    const r = await viaProxy(port, `http://pub.test:${originPort}/page?q=1`, basic(s));
    expect(r.status).toBe(200);
    expect(r.body).toContain('hello');
    expect(originSeen.at(-1)).toEqual({ host: `pub.test:${originPort}`, url: '/page?q=1' });
    expect(resolver.calls.filter((h) => h === 'pub.test').length).toBeGreaterThan(0);
    p.server.close();
  });

  it.each(['http://127.0.0.1:PORT/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]:PORT/', 'http://127.1:PORT/', 'http://0.0.0.0:PORT/', 'http://localhost:PORT/', 'http://evil.test/', 'http://2130706433:PORT/'])(
    'blocks %s (plain) without touching the origin',
    async (u) => {
      const before = originConns;
      const p = mk(true);
      const { port } = await up(p);
      const s = p.openSession();
      const r = await viaProxy(port, u.replace('PORT', String(originPort)), basic(s));
      expect(r.status).toBe(403);
      expect(r.headers['x-guard-blocked']).toBe('1');
      expect(originConns).toBe(before);
      expect(p.statsOf(s.user)!.blocked).toBe(1);
      p.server.close();
    },
  );

  it.each(['127.0.0.1:PORT', '169.254.169.254:80', '[::1]:PORT', 'localhost:PORT', 'evil.test:443', '0.0.0.0:80'])('blocks CONNECT %s', async (a) => {
    const p = mk(true);
    const { port } = await up(p);
    const s = p.openSession();
    const r = await connectVia(port, a.replace('PORT', String(originPort)), basic(s));
    expect(r.status).toBe(403);
    r.socket.destroy();
    p.server.close();
  });

  it('refuses ports that are neither 80/443 nor configured, and non-http schemes', async () => {
    const p = mk(false);
    const { port } = await up(p);
    const s = p.openSession();
    expect((await viaProxy(port, `http://pub.test:1025/`, basic(s))).status).toBe(403);
    expect((await viaProxy(port, 'ftp://pub.test/', basic(s))).status).toBe(403);
    expect((await connectVia(port, `pub.test:1026`, basic(s))).status).toBe(403);
    p.server.close();
  });

  it('blocks a rebinding name at the second lookup (first answer public, second private)', async () => {
    const p = mk(false);
    const { port } = await up(p);
    const s = p.openSession();
    expect((await viaProxy(port, `http://rebind.test:${originPort}/`, basic(s))).status).toBe(200);
    expect((await viaProxy(port, `http://rebind.test:${originPort}/`, basic(s))).status).toBe(403);
    p.server.close();
  });

  it('tunnels an allowed CONNECT and counts bytes', async () => {
    const p = mk(false);
    const { port } = await up(p);
    const s = p.openSession();
    const r = await connectVia(port, `pub.test:${echoPort}`, basic(s));
    expect(r.status).toBe(200);
    const got = await new Promise<string>((ok) => {
      r.socket.once('data', (d) => ok(d.toString()));
      r.socket.write('ping');
    });
    expect(got).toBe('echo:ping');
    r.socket.destroy();
    expect(p.statsOf(s.user)!.bytes).toBeGreaterThanOrEqual(9);
    p.server.close();
  });

  it('a redirect is returned to the client, not followed (the next hop is checked as its own request)', async () => {
    const p = mk(false);
    const { port } = await up(p);
    const s = p.openSession();
    const r = await viaProxy(port, `http://pub.test:${originPort}/redir`, basic(s));
    expect(r.status).toBe(302);
    p.server.close();
  });
});

describe('guard proxy › caps and sessions', () => {
  it('cuts a response that passes the byte cap and reports capped', async () => {
    const p = mk(false, { maxBytes: 50_000 });
    const { port } = await up(p);
    const s = p.openSession();
    const r = await viaProxy(port, `http://pub.test:${originPort}/big`, basic(s)).catch(() => ({ body: '' }));
    expect(r.body.length).toBeLessThan(300_000);
    expect(p.statsOf(s.user)!.capped).toBe(true);
    p.server.close();
  });

  it('answers 429 once the request cap is spent', async () => {
    const p = mk(false, { maxRequests: 2 });
    const { port } = await up(p);
    const s = p.openSession();
    const u = `http://pub.test:${originPort}/`;
    expect((await viaProxy(port, u, basic(s))).status).toBe(200);
    expect((await viaProxy(port, u, basic(s))).status).toBe(200);
    expect((await viaProxy(port, u, basic(s))).status).toBe(429);
    p.server.close();
  });

  it('closing a session destroys its open tunnels', async () => {
    const p = mk(false);
    const { port } = await up(p);
    const s = p.openSession();
    const r = await connectVia(port, `pub.test:${echoPort}`, basic(s));
    const closed = new Promise<void>((ok) => r.socket.once('close', () => ok()));
    expect(p.closeSession(s.user)).not.toBeNull();
    await closed;
    p.server.close();
  });
});

describe('guard proxy › control server', () => {
  it('mints, reads and ends a session; refuses callers from the internal network', async () => {
    const p = mk(false);
    const ok = createControlServer(p, () => true, TOKEN);
    const denied = createControlServer(p, () => false, TOKEN);
    const cp = await listen(ok);
    const dp = await listen(denied);
    const j = (port: number, method: string, path: string, auth = true) => fetch(`http://127.0.0.1:${port}${path}`, { method, headers: auth ? bearer : {} }).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }));
    const made = await j(cp, 'POST', '/session');
    expect(made.status).toBe(200);
    const user = made.body.user as string;
    expect(typeof made.body.pass).toBe('string');
    expect((await j(cp, 'GET', `/session/${user}`)).body).toMatchObject({ bytes: 0, requests: 0, blocked: 0, capped: false });
    expect((await j(cp, 'DELETE', `/session/${user}`)).status).toBe(200);
    expect((await j(cp, 'GET', `/session/${user}`)).status).toBe(404);
    await expect(j(dp, 'POST', '/session')).rejects.toThrow();
    // DNS rebinding: a foreign Host or any Origin is refused, and no session is minted
    const raw = (headers: Record<string, string>) =>
      new Promise<number>((done, bad) => {
        const r = http.request({ host: '127.0.0.1', port: cp, method: 'POST', path: '/session', headers: { ...bearer, ...headers }, agent: false }, (res) => (res.resume(), done(res.statusCode ?? 0)));
        r.on('error', bad);
        r.end();
      });
    expect(await raw({ host: 'rebound.attacker.example:9223' })).toBe(403);
    expect(await raw({ host: `127.0.0.1:${cp}`, origin: 'http://rebound.attacker.example' })).toBe(403);
    expect(await raw({ host: `localhost:${cp}` })).toBe(200);
    expect(p.sessionCount()).toBe(1);
    // G2C-03: no token, a wrong token, or an empty configured token mint nothing and read nothing
    expect((await j(cp, 'POST', '/session', false)).status).toBe(401);
    expect((await j(cp, 'GET', '/healthz', false)).status).toBe(200);
    expect(await raw({ host: `127.0.0.1:${cp}`, authorization: 'Bearer nope' })).toBe(401);
    expect(p.sessionCount()).toBe(1);
    expect(bearerOk('Bearer ', '')).toBe(false);
    expect(bearerOk(undefined, TOKEN)).toBe(false);
    ok.close();
    denied.close();
  });
});

describe('inCidr', () => {
  it('matches v4 and v4-mapped addresses and fails closed on garbage', () => {
    expect(inCidr('10.88.77.5', '10.88.77.0/24')).toBe(true);
    expect(inCidr('::ffff:10.88.77.5', '10.88.77.0/24')).toBe(true);
    expect(inCidr('10.88.78.5', '10.88.77.0/24')).toBe(false);
    expect(inCidr('192.168.65.1', '10.88.77.0/24')).toBe(false);
    expect(inCidr('not-an-ip', '10.88.77.0/24')).toBe(true);
  });
});

describe('CDP forwarder token', () => {
  it('forwards only a connection whose first request carries the bearer token', async () => {
    const target = net.createServer((s) => s.on('data', () => s.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nhi')));
    const tp = await listen(target);
    const fwd = createForwarder({ host: '127.0.0.1', port: tp }, () => true, TOKEN);
    const fp = await listen(fwd);
    const get = (extra: string) =>
      new Promise<string>((ok) => {
        const c = net.connect(fp, '127.0.0.1', () => c.write(`GET /json/version HTTP/1.1\r\nHost: 127.0.0.1:9222\r\n${extra}\r\n`));
        let out = '';
        c.on('data', (d) => (out += d));
        c.on('close', () => ok(out));
      });
    expect(await get('')).toMatch(/^HTTP\/1.1 401/);
    expect(await get('Authorization: Bearer wrong\r\n')).toMatch(/^HTTP\/1.1 401/);
    expect(await get(`Authorization: Bearer ${TOKEN}\r\n`)).toMatch(/^HTTP\/1.1 200/);
    fwd.close();
    target.close();
  });
});
