/**
 * Real-socket SSRF suite (Gate 1 P4, AC5), vitest project `net` only: `npx vitest run --project net`.
 * It binds loopback servers and drives the real `net/system.ts` transport; it never leaves the machine (the only
 * addresses it can reach are the loopback servers below, and every "public" name comes from a fake resolver).
 * The `net` project does not load the unit no-network guard (that guard checks hostnames, and these requests carry
 * test hostnames pinned to loopback IPs), so this file is excluded from `unit` by name.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fakeResolver } from '../tests/fakes/net.js';
import { createSafeFetch } from './fetch.js';
import { isBlockedAddress, safeFetch, SafeFetchError } from './guard.js';
import { systemResolver, systemTransport } from './system.js';

type Srv = { server: http.Server; conns: number; reqs: { url: string; host: string }[]; closed: number };

function serve(): Srv {
  const s: Srv = { server: http.createServer(), conns: 0, reqs: [], closed: 0 };
  s.server.on('connection', () => void s.conns++);
  s.server.on('request', (req, res) => {
    s.reqs.push({ url: req.url ?? '', host: req.headers.host ?? '' });
    res.on('close', () => void s.closed++);
    const u = req.url ?? '/';
    if (u === '/meta') return void res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
    if (u.startsWith('/to-v4/')) return void res.writeHead(302, { location: `http://127.0.0.1:${u.slice(7)}/` }).end();
    if (u === '/endless') {
      res.writeHead(200, { 'content-type': 'text/plain' }); // chunked: no content-length
      const chunk = Buffer.alloc(64 * 1024, 97);
      const pump = () => {
        while (!res.destroyed && res.write(chunk));
        if (!res.destroyed) res.once('drain', pump);
      };
      return pump();
    }
    if (u === '/trickle') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '1000000' });
      const t = setInterval(() => (res.destroyed ? clearInterval(t) : res.write('x')), 100);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end('<p>loopback secret</p>');
  });
  return s;
}

const listen = (s: Srv, host: string, port = 0) =>
  new Promise<number>((ok, bad) => {
    s.server.once('error', bad);
    s.server.listen({ host, port, ipv6Only: host.includes(':') }, () => ok((s.server.address() as AddressInfo).port));
  });

let v4: Srv;
let v6: Srv;
let P = 0;
const sys = { resolver: systemResolver, transport: systemTransport };
const opts = (extra: object = {}) => ({ ...sys, extraPorts: [P], ...extra });

beforeAll(async () => {
  // The same port on 127.0.0.1 and ::1, so a rebinding resolver can switch address behind one url.
  for (let i = 0; i < 20 && !P; i++) {
    v4 = serve();
    v6 = serve();
    const p = await listen(v4, '127.0.0.1');
    try {
      await listen(v6, '::1', p);
      P = p;
    } catch {
      v4.server.close();
    }
  }
  if (!P) throw new Error('could not bind 127.0.0.1 and ::1 on one port');
});
afterAll(() => {
  v4.server.closeAllConnections();
  v6.server.closeAllConnections();
  v4.server.close();
  v6.server.close();
});
beforeEach(() => {
  for (const s of [v4, v6]) Object.assign(s, { conns: 0, reqs: [], closed: 0 });
});

const blockedCode = (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (e: unknown) => (e instanceof SafeFetchError ? e.code : `other: ${String(e)}`),
  );
const noContact = () => expect(v4.conns + v6.conns).toBe(0);

describe('ssrf (real sockets)', () => {
  it.each(['127.1', '0.0.0.0', '[::1]', '[::ffff:127.0.0.1]', '2130706433', '0x7f.1', '0177.0.0.1', '127.0.0.1', 'localhost'])(
    'http://%s:<port>/ is refused and the server sees zero connections',
    async (host) => {
      expect(await blockedCode(safeFetch(`http://${host}:${P}/`, opts()))).toBe('blocked');
      noContact();
    },
  );

  it('a name resolving to 127.0.0.1 is refused; the server sees zero connections', async () => {
    const r = fakeResolver({ 'loop.test': ['127.0.0.1'] });
    expect(await blockedCode(safeFetch(`http://loop.test:${P}/`, opts({ resolver: r })))).toBe('blocked');
    noContact();
  });

  // The remaining cases need one loopback address to count as "public". The predicate override lives in net/fetch.ts,
  // which the production entry (net/guard.ts) does not re-export; tools only ever see guard.safeFetch.
  const v6Public = createSafeFetch((ip) => (ip === '::1' ? false : isBlockedAddress(ip)));
  const v4Public = createSafeFetch((ip) => (ip === '127.0.0.1' ? false : isBlockedAddress(ip)));

  it('the real transport connects to the validated address (rebinding resolver: public then 127.0.0.1)', async () => {
    const r = fakeResolver({ 'rebind.test': (n) => (n === 1 ? ['::1'] : ['127.0.0.1']) });
    const res = await v6Public(`http://rebind.test:${P}/page`, opts({ resolver: r }));
    expect(res.status).toBe(200);
    expect(r.calls).toEqual(['rebind.test']);
    expect(v6.reqs).toEqual([{ url: '/page', host: `rebind.test:${P}` }]);
    expect(v4.conns).toBe(0);
  });

  it('302 to 169.254.169.254 is refused at the hop', async () => {
    const r = fakeResolver({ 'pub.test': ['::1'] });
    expect(await blockedCode(v6Public(`http://pub.test:${P}/meta`, opts({ resolver: r })))).toBe('blocked');
    expect(v6.reqs.map((q) => q.url)).toEqual(['/meta']);
  });

  it('public URL redirecting to http://127.0.0.1 is refused at the hop (AC5); 127.0.0.1 sees zero connections', async () => {
    const r = fakeResolver({ 'pub.test': ['::1'] });
    expect(await blockedCode(v6Public(`http://pub.test:${P}/to-v4/${P}`, opts({ resolver: r })))).toBe('blocked');
    expect(v6.reqs).toHaveLength(1);
    expect(v4.conns).toBe(0);
  });

  it('an endless chunked body stops at 2 MiB and the connection is closed', async () => {
    const res = await v4Public(`http://127.0.0.1:${P}/endless`, opts());
    expect(res.truncated).toBe(true);
    expect(res.body.length).toBe(2 * 1024 * 1024);
    await expect.poll(() => v4.closed, { timeout: 2000 }).toBe(1);
  });

  it('a trickling body is aborted by the timeout, whatever content-length says', async () => {
    const t0 = Date.now();
    expect(await blockedCode(v4Public(`http://127.0.0.1:${P}/trickle`, opts({ timeoutMs: 400 })))).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(3000);
    await expect.poll(() => v4.closed, { timeout: 2000 }).toBe(1);
  });

  it('agent: false keeps an env proxy (NODE_USE_ENV_PROXY / HTTP_PROXY global agent) out of the path', async () => {
    // The env proxy lives in http.globalAgent (Node 24 builds it from HTTP_PROXY when NODE_USE_ENV_PROXY=1). Swapping in
    // such an agent in-process is the same thing; the control request proves the proxy agent works.
    const proxy = serve();
    const pp = await listen(proxy, '127.0.0.1');
    const saved = http.globalAgent;
    http.globalAgent = new http.Agent({ proxyEnv: { HTTP_PROXY: `http://127.0.0.1:${pp}` } } as http.AgentOptions);
    try {
      await new Promise<void>((ok, bad) => http.get(`http://127.0.0.1:${P}/control`, (r) => r.resume().on('end', ok)).on('error', bad));
      expect(proxy.reqs).toHaveLength(1); // control: the global agent goes through the proxy
      const res = await v4Public(`http://127.0.0.1:${P}/direct`, opts());
      expect(res.status).toBe(200);
      expect(proxy.reqs).toHaveLength(1); // safeFetch did not
      expect(v4.reqs.map((q) => q.url)).toEqual(['/direct']);
    } finally {
      http.globalAgent = saved;
      proxy.server.closeAllConnections();
      proxy.server.close();
    }
  });

  it('the default 10 s timeout applies to the real transport', { timeout: 20_000 }, async () => {
    const t0 = Date.now();
    expect(await blockedCode(v4Public(`http://127.0.0.1:${P}/trickle`, opts()))).toBe('timeout');
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(9_900);
    expect(took).toBeLessThan(12_000);
  });
});
