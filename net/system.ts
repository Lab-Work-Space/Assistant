import { ADDRCONFIG } from 'node:dns';
import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { bareHost } from './address.js';
import type { Resolver, Transport } from './fetch.js';

/**
 * Real Resolver and Transport for net/guard (exercised by `net/ssrf.net.test.ts`, never by the unit project).
 *
 * Pinning (Gate 1 P4): the request keeps the real hostname, so the Host header, TLS SNI and certificate checks are
 * the hostname's, but the socket's `lookup` answers only with the address guard already validated, so DNS is never
 * asked a second time and a rebinding answer cannot be used. Node 24 enables `autoSelectFamily` by default, which
 * calls lookup with `{ all: true }` and expects `[{ address, family }]`; both forms are answered. `agent: false`
 * means no pooled socket (keyed by host:port) opened to another address is ever reused, and also that an env proxy
 * (NODE_USE_ENV_PROXY + HTTP(S)_PROXY, which Node wires into the global agent) is never used: a proxy would resolve
 * the hostname itself and undo the pinning (pinned by `ssrf.net.test.ts`).
 */

/**
 * Every A/AAAA answer the system resolver gives (hosts file included), in resolver order. ADDRCONFIG (as net.connect's
 * own lookup uses) leaves out a family the host has no address for, since the pinned socket connects to the first
 * answer only and has no happy-eyeballs fallback.
 */
export const systemResolver: Resolver = async (host) =>
  (await dnsLookup(host, { all: true, order: 'verbatim', hints: ADDRCONFIG })).map((a) => a.address);

const pinned = (address: string): LookupFunction => {
  const family = isIP(address);
  return ((_host: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => {
    if (opts?.all) cb(null, [{ address, family }]);
    else cb(null, address, family);
  }) as unknown as LookupFunction;
};

const flat = (h: http.IncomingHttpHeaders): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) if (v !== undefined) out[k] = Array.isArray(v) ? v.join(', ') : v;
  return out;
};

export const systemTransport: Transport = (r) =>
  new Promise((resolve, reject) => {
    if (isIP(r.address) === 0) return reject(new Error('transport needs an ip address'));
    const tls = r.url.protocol === 'https:';
    const req = (tls ? https : http).request(
      {
        protocol: r.url.protocol,
        hostname: bareHost(r.url.hostname),
        port: r.url.port || (tls ? 443 : 80),
        path: `${r.url.pathname}${r.url.search}`,
        method: r.method,
        headers: r.headers,
        agent: false,
        lookup: pinned(r.address),
        signal: r.signal,
      },
      (res) => resolve({ status: res.statusCode ?? 0, headers: flat(res.headers), body: res }),
    );
    req.on('error', reject);
    req.end(r.body);
  });
