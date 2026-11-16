import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import net, { isIP } from 'node:net';
import type { Resolver, TargetOptions } from './fetch.js';

/**
 * Guard proxy for the Chrome container (Gate 1 Part C, C24/C25/C27, N3).
 *
 * Chrome's only route to the internet is this proxy. For every plain-HTTP request and every CONNECT tunnel (https and
 * WebSocket alike) it runs the same target check as `safeFetch` (scheme, port, host name, every resolved address),
 * then connects to the address it checked, never to a fresh lookup (the host name is not resolved a second time, so a
 * rebinding answer is useless). Redirects are not followed here: Chrome follows them and each hop arrives as a new
 * request. Access needs a per-call credential minted through `openSession`; the session also carries the per-call
 * byte and request caps (C27), counted here because only here does all traffic pass.
 */

export type CheckTarget = (raw: string | URL, o: TargetOptions) => Promise<{ url: URL; address: string }>;
export type Caps = { maxBytes: number; maxRequests: number };
export type SessionStats = { bytes: number; requests: number; blocked: number; capped: boolean };
export type Session = { user: string; pass: string };

export const DEFAULT_CAPS: Caps = { maxBytes: 8 * 1024 * 1024, maxRequests: 200 };
const SESSION_TTL_MS = 3 * 60_000;
const MAX_SESSIONS = 16;
const UPSTREAM_IDLE_MS = 60_000;
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

type Live = { passHash: Buffer; stats: SessionStats; caps: Caps; sockets: Set<net.Socket>; timer: NodeJS.Timeout };

export type GuardProxyOptions = {
  check: CheckTarget;
  resolver: Resolver;
  extraPorts?: () => number[];
  caps?: Partial<Caps>;
  sessionTtlMs?: number;
};

const eq = (a: Buffer, b: Buffer): boolean => a.length === b.length && timingSafeEqual(a, b);
const sha = (s: string): Buffer => Buffer.from(s, 'utf8');

export function createGuardProxy(o: GuardProxyOptions) {
  const sessions = new Map<string, Live>();
  const caps: Caps = { ...DEFAULT_CAPS, ...o.caps };
  const targetOpts = (): TargetOptions => ({ resolver: o.resolver, extraPorts: o.extraPorts?.() ?? [] });

  function openSession(): Session {
    if (sessions.size >= MAX_SESSIONS) throw new Error('too many open sessions');
    const user = `s${randomBytes(8).toString('hex')}`;
    const pass = randomBytes(24).toString('hex');
    const timer = setTimeout(() => void closeSession(user), o.sessionTtlMs ?? SESSION_TTL_MS);
    timer.unref();
    sessions.set(user, { passHash: sha(pass), stats: { bytes: 0, requests: 0, blocked: 0, capped: false }, caps, sockets: new Set(), timer });
    return { user, pass };
  }

  /** Ends a session: its open sockets are destroyed and the credential stops working. Returns the final counters. */
  function closeSession(user: string): SessionStats | null {
    const s = sessions.get(user);
    if (!s) return null;
    sessions.delete(user);
    clearTimeout(s.timer);
    for (const sock of s.sockets) sock.destroy();
    return { ...s.stats };
  }

  const statsOf = (user: string): SessionStats | null => {
    const s = sessions.get(user);
    return s ? { ...s.stats } : null;
  };

  function authenticate(header: string | undefined): Live | null {
    if (!header || !/^basic /i.test(header)) return null;
    const raw = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
    const i = raw.indexOf(':');
    if (i < 1) return null;
    const s = sessions.get(raw.slice(0, i));
    return s && eq(s.passHash, sha(raw.slice(i + 1))) ? s : null;
  }

  const overCap = (s: Live): boolean => s.stats.capped;
  function addBytes(s: Live, n: number): void {
    s.stats.bytes += n;
    if (s.stats.bytes > s.caps.maxBytes && !s.stats.capped) {
      s.stats.capped = true;
      for (const sock of s.sockets) sock.destroy();
    }
  }
  function countRequest(s: Live): boolean {
    s.stats.requests++;
    if (s.stats.requests > s.caps.maxRequests) {
      s.stats.capped = true;
      return false;
    }
    return !overCap(s);
  }
  const track = (s: Live, sock: net.Socket) => {
    s.sockets.add(sock);
    sock.once('close', () => s.sockets.delete(sock));
  };

  const deny = (res: http.ServerResponse, code: number, why: string, blocked: boolean) => {
    res.writeHead(code, { 'content-type': 'text/plain', connection: 'close', ...(blocked ? { 'x-guard-blocked': '1' } : {}) }).end(why);
  };

  const server = http.createServer({ requestTimeout: 0, headersTimeout: 30_000 }, (req, res) => {
    const s = authenticate(req.headers['proxy-authorization'] as string | undefined);
    if (!s) return void res.writeHead(407, { 'proxy-authenticate': 'Basic realm="guard"', connection: 'close' }).end();
    track(s, req.socket);
    if (!countRequest(s)) return deny(res, 429, 'request cap reached', false);
    void (async () => {
      let t: { url: URL; address: string };
      try {
        t = await o.check(req.url ?? '', targetOpts());
        if (t.url.protocol !== 'http:') throw new Error('refused: plain proxying is http only');
      } catch (err) {
        s.stats.blocked++;
        return deny(res, 403, err instanceof Error ? err.message : 'refused', true);
      }
      const headers: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && v !== undefined) headers[k] = v;
      headers.host = t.url.host;
      const up = http.request(
        { host: t.address, port: Number(t.url.port || 80), path: `${t.url.pathname}${t.url.search}`, method: req.method, headers, agent: false, setHost: false },
        (ur) => {
          const out: http.OutgoingHttpHeaders = {};
          for (const [k, v] of Object.entries(ur.headers)) if (!HOP.has(k) && v !== undefined) out[k] = v;
          res.writeHead(ur.statusCode ?? 502, out);
          ur.on('data', (c: Buffer) => addBytes(s, c.length));
          ur.pipe(res);
          ur.on('error', () => res.destroy());
        },
      );
      up.on('socket', (sock) => track(s, sock));
      up.setTimeout(UPSTREAM_IDLE_MS, () => up.destroy());
      up.on('error', () => (res.headersSent ? res.destroy() : deny(res, 502, 'upstream failed', false)));
      req.on('data', (c: Buffer) => addBytes(s, c.length));
      req.pipe(up);
    })();
  });
  server.on('clientError', (_e, sock) => sock.destroy());

  server.on('connect', (req, clientDuplex, head) => {
    const client = clientDuplex as net.Socket;
    client.on('error', () => client.destroy());
    const refuse = (line: string, extra = '') => client.end(`HTTP/1.1 ${line}\r\n${extra}Connection: close\r\nContent-Length: 0\r\n\r\n`);
    const s = authenticate(req.headers['proxy-authorization'] as string | undefined);
    if (!s) return void refuse('407 Proxy Authentication Required', 'Proxy-Authenticate: Basic realm="guard"\r\n');
    track(s, client);
    if (!countRequest(s)) return void refuse('429 Too Many Requests');
    const authority = req.url ?? '';
    if (!/^[A-Za-z0-9.:[\]_-]{1,300}$/.test(authority) || !/:\d{1,5}$/.test(authority)) return void refuse('400 Bad Request');
    void (async () => {
      let t: { url: URL; address: string };
      try {
        t = await o.check(`https://${authority}/`, targetOpts());
      } catch {
        s.stats.blocked++;
        return void refuse('403 Forbidden', 'X-Guard-Blocked: 1\r\n');
      }
      const port = Number(authority.slice(authority.lastIndexOf(':') + 1));
      if (client.destroyed) return;
      const up = net.connect({ host: t.address, port, family: isIP(t.address) });
      track(s, up);
      up.setTimeout(UPSTREAM_IDLE_MS, () => up.destroy());
      up.on('error', () => (client.writable && !client.destroyed ? refuse('502 Bad Gateway') : client.destroy()));
      up.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) { addBytes(s, head.length); up.write(head); }
        client.on('data', (c: Buffer) => addBytes(s, c.length));
        up.on('data', (c: Buffer) => addBytes(s, c.length));
        client.pipe(up);
        up.pipe(client);
        client.once('close', () => up.destroy());
        up.once('close', () => client.destroy());
      });
    })();
  });

  return { server, openSession, closeSession, statsOf, sessionCount: () => sessions.size };
}
export type GuardProxy = ReturnType<typeof createGuardProxy>;

// ---- control channel (host side: mint a credential, read counters, end a session) and the CDP forwarder --------------

/** Constant-time check of `Authorization: Bearer <token>`. An empty configured token never matches. */
export function bearerOk(header: string | undefined, token: string): boolean {
  if (!token || !header || !/^bearer /i.test(header)) return false;
  return eq(sha(header.slice(7).trim()), sha(token));
}

/** True when `ip` (v4, or v4-mapped v6) lies inside `cidr` ("10.88.77.0/24"). Anything unparsable is "inside" (fail closed). */
export function inCidr(ip: string, cidr: string): boolean {
  const bare = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  const [base, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  const toN = (s: string): number | null => {
    const p = s.split('.');
    if (p.length !== 4 || p.some((x) => !/^\d{1,3}$/.test(x) || Number(x) > 255)) return null;
    return p.reduce((n, x) => n * 256 + Number(x), 0);
  };
  const a = toN(bare);
  const b = toN(base ?? '');
  if (a === null || b === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return true;
  if (bits === 0) return true;
  const shift = 2 ** (32 - bits);
  return Math.floor(a / shift) === Math.floor(b / shift);
}

/**
 * Control API. `allowed(remoteAddress)` must be false for anything on Chrome's internal network: the page must not be able to mint or
 * read sessions. Only the host (through the published loopback port) is let in.
 */
export function createControlServer(proxy: GuardProxy, allowed: (remote: string) => boolean, token: string): http.Server {
  // DNS rebinding (a page in the owner's own browser rebinding a name to 127.0.0.1): only a Host that is the loopback address itself, and no Origin, is served.
  const HOST_OK = /^(127\.0\.0\.1|localhost|\[::1\]):\d{2,5}$/i;
  const send = (res: http.ServerResponse, code: number, body: unknown) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  return http.createServer((req, res) => {
    if (!allowed(req.socket.remoteAddress ?? '')) return void req.socket.destroy();
    if (req.headers.origin !== undefined || !HOST_OK.test(req.headers.host ?? '')) return send(res, 403, { error: 'forbidden' });
    const url = new URL(req.url ?? '/', 'http://control.invalid');
    if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true }); // container healthcheck; reveals nothing
    // G2C-03: a per-boot secret. Without it nothing else on this Mac (another container through host.docker.internal, a local process) can mint, read or end sessions.
    if (!bearerOk(req.headers.authorization, token)) return send(res, 401, { error: 'unauthorized' });
    const m = /^\/session\/(s[0-9a-f]{16})$/.exec(url.pathname);
    if (req.method === 'POST' && url.pathname === '/session') {
      try {
        return send(res, 200, proxy.openSession());
      } catch {
        return send(res, 429, { error: 'too many sessions' });
      }
    }
    if (m && req.method === 'GET') {
      const s = proxy.statsOf(m[1]!);
      return s ? send(res, 200, s) : send(res, 404, { error: 'no such session' });
    }
    if (m && req.method === 'DELETE') {
      const s = proxy.closeSession(m[1]!);
      return s ? send(res, 200, s) : send(res, 404, { error: 'no such session' });
    }
    send(res, 404, { error: 'not found' });
  });
}

/**
 * TCP forwarder for the DevTools port. Refuses callers on Chrome's own network, and requires the bearer token on the first request of each
 * connection (the `/json/version` call or the WebSocket upgrade; the rest of the connection is a raw pipe).
 */
export function createForwarder(target: { host: string; port: number }, allowed: (remote: string) => boolean, token: string): net.Server {
  return net.createServer((client) => {
    if (!allowed(client.remoteAddress ?? '')) return void client.destroy();
    let head = Buffer.alloc(0);
    client.setTimeout(5000, () => client.destroy());
    client.on('error', () => client.destroy());
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end === -1) {
        if (head.length > 16_384) client.destroy();
        return;
      }
      client.off('data', onData);
      client.pause();
      const auth = /^authorization:[ \t]*(.*)$/im.exec(head.subarray(0, end).toString('latin1'))?.[1]?.trim();
      if (!bearerOk(auth, token)) return void client.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      client.setTimeout(0);
      const up = net.connect(target);
      up.on('error', () => client.destroy());
      up.once('connect', () => {
        up.write(head);
        client.pipe(up);
        up.pipe(client);
        client.resume();
      });
      client.once('close', () => up.destroy());
      up.once('close', () => client.destroy());
    };
    client.on('data', onData);
  });
}
