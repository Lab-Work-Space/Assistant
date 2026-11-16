import { isIP } from 'node:net';
import { bareHost } from './address.js';

/**
 * SSRF-safe fetch core (Gate 1 P4). Tools import `safeFetch` from `net/guard.ts`, which binds the real address
 * predicate; this module takes the predicate as a parameter only so the real-socket suite can treat one loopback
 * address as public. It is the only egress for user- or LLM-influenced URLs (PF9); fixed vendor base URLs
 * (ClickUp/GitHub) use their own HttpClient.
 */

export type Resolver = (host: string) => Promise<string[]>;
export type TransportRequest = {
  url: URL;
  /** The validated IP the transport must connect to (never re-resolve the hostname). */
  address: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: Buffer;
  signal: AbortSignal;
};
export type TransportResponse = { status: number; headers: Record<string, string>; body: AsyncIterable<Uint8Array> };
export type Transport = (r: TransportRequest) => Promise<TransportResponse>;

export type SafeFetchErrorCode = 'blocked' | 'timeout' | 'aborted' | 'too_many_redirects' | 'failed';
export class SafeFetchError extends Error {
  constructor(readonly code: SafeFetchErrorCode, message: string) {
    super(message);
    this.name = 'SafeFetchError';
  }
}

export type TargetOptions = { resolver: Resolver; extraPorts?: number[] };
export type SafeFetchOptions = TargetOptions & {
  transport: Transport;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  /** RFMD P5 (RF33): when set, EVERY hop's host must equal an entry (or end with an entry that starts with a dot); otherwise refused before any lookup or request. */
  allowHosts?: readonly string[];
  signal?: AbortSignal;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string | Buffer;
};
export type SafeFetchResult = {
  finalUrl: string;
  status: number;
  contentType: string;
  /** Response headers of the final hop, names lower-case (e.g. `location` of an unfollowed POST redirect). */
  headers: Record<string, string>;
  body: Buffer;
  truncated: boolean;
};
export type AddressPredicate = (ip: string) => boolean;

export const MAX_BYTES = 2 * 1024 * 1024;
export const TIMEOUT_MS = 10_000;
export const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization', 'x-goog-api-key'];
const DEFAULT_HEADERS = { 'user-agent': 'Mozilla/5.0 (compatible; PrawAssistant/1.0)', accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' };

const refuse = (why: string) => new SafeFetchError('blocked', `refused: ${why}`);

/** P4 port rule: the scheme's default (80/443, either scheme) or a configured extra port >= 1024. */
function portAllowed(u: URL, extra: number[]): boolean {
  const port = u.port === '' ? (u.protocol === 'https:' ? 443 : 80) : Number(u.port);
  return port === 80 || port === 443 || (port >= 1024 && extra.includes(port));
}

/** Validates one url (one hop): scheme, userinfo, port, host name, then every resolved address. Returns the address to connect to. */
export function createCheckTarget(isBlocked: AddressPredicate) {
  return async function checkTarget(raw: string | URL, o: TargetOptions): Promise<{ url: URL; address: string }> {
    let url: URL;
    try {
      url = new URL(raw); // WHATWG: numeric, octal and hex hosts normalise to dotted quads here
    } catch {
      throw refuse('not a valid url');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw refuse(`scheme ${url.protocol} is not http(s)`);
    url.hash = ''; // never sent
    if (url.username || url.password) throw refuse('urls with credentials are not fetched');
    if (!portAllowed(url, o.extraPorts ?? [])) throw refuse(`port ${url.port} is not allowed`);
    const host = bareHost(url.hostname);
    const name = host.toLowerCase().replace(/\.$/, '');
    if (!name || name === 'localhost' || name.endsWith('.localhost')) throw refuse('local host name');
    let addresses: string[];
    if (isIP(host)) addresses = [host];
    else {
      try {
        addresses = await o.resolver(host);
      } catch {
        throw refuse(`could not resolve ${host}`); // fail closed
      }
    }
    if (!Array.isArray(addresses) || addresses.length === 0) throw refuse(`${host} has no address`);
    // every address must pass, not just the one we would pick (a mixed answer is refused)
    for (const a of addresses) if (typeof a !== 'string' || isBlocked(a)) throw refuse(`${host} resolves to a blocked address`);
    return { url, address: addresses[0]! };
  };
}

/** Rejects when `signal` aborts; used to bound waits on transports and bodies that ignore the signal. */
function abortPromise(signal: AbortSignal): { p: Promise<never>; done: () => void } {
  let done = () => {};
  const p = new Promise<never>((_, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const on = () => reject(signal.reason);
    signal.addEventListener('abort', on, { once: true });
    done = () => signal.removeEventListener('abort', on);
  });
  p.catch(() => {});
  return { p, done };
}

async function readBody(body: AsyncIterable<Uint8Array>, max: number, stop: Promise<never>): Promise<{ buf: Buffer; truncated: boolean }> {
  const it = body[Symbol.asyncIterator]();
  const parts: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const r = await Promise.race([it.next(), stop]);
      if (r.done) return { buf: Buffer.concat(parts), truncated: false };
      const chunk = Buffer.from(r.value);
      if (size + chunk.length >= max) {
        // reaching the cap counts as truncated (a body of exactly maxBytes is reported truncated; never wait for more)
        parts.push(chunk.subarray(0, max - size));
        return { buf: Buffer.concat(parts), truncated: true };
      }
      parts.push(chunk);
      size += chunk.length;
    }
  } finally {
    void Promise.resolve(it.return?.()).catch(() => {}); // destroys a node stream; never awaited (a stalled body may never settle)
  }
}

/**
 * resolve -> check all addresses -> connect to a checked address -> repeat on every redirect hop (at most `maxRedirects`).
 * Size (streamed bytes) and time (whole fetch, body included) are bounded regardless of Content-Length.
 * POST never follows redirects: a 3xx answer is returned unfollowed (fail closed; Apps Script answers POST with a 302
 * after the write, so the caller decides what a 3xx means).
 */
export function createSafeFetch(isBlocked: AddressPredicate) {
  const checkTarget = createCheckTarget(isBlocked);
  return async function safeFetch(rawUrl: string, o: SafeFetchOptions): Promise<SafeFetchResult> {
    const maxBytes = o.maxBytes ?? MAX_BYTES;
    const maxRedirects = o.maxRedirects ?? MAX_REDIRECTS;
    const timer = new AbortController();
    const clock = setTimeout(() => timer.abort(new SafeFetchError('timeout', 'the fetch timed out')), o.timeoutMs ?? TIMEOUT_MS);
    const timeout = timer.signal;
    const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
    const stop = abortPromise(signal);
    const method = o.method ?? 'GET';
    const body = o.body === undefined ? undefined : Buffer.isBuffer(o.body) ? o.body : Buffer.from(o.body);
    const lower = Object.fromEntries(Object.entries(o.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    let headers: Record<string, string> = { ...DEFAULT_HEADERS, ...lower, 'accept-encoding': 'identity' }; // node:http does not decompress
    if (body) headers['content-length'] = String(body.length);
    let current = rawUrl;
    try {
      for (let hop = 0; ; hop++) {
        if (o.allowHosts) {
          let h = '';
          try { h = new URL(current).hostname.toLowerCase(); } catch { /* refused below */ }
          if (!h || !o.allowHosts.some((a) => (a.startsWith('.') ? h.endsWith(a) : h === a))) throw refuse('host is not on the allowlist');
        }
        const { url, address } = await checkTarget(current, o);
        let res: TransportResponse;
        try {
          res = await Promise.race([o.transport({ url, address, method, headers, ...(body ? { body } : {}), signal }), stop.p]);
        } catch (err) {
          throw err instanceof SafeFetchError ? err : signal.aborted ? err : new SafeFetchError('failed', 'the request failed');
        }
        const location = res.headers.location;
        if (method === 'GET' && REDIRECTS.has(res.status) && location) {
          void Promise.resolve(res.body[Symbol.asyncIterator]().return?.()).catch(() => {});
          if (hop >= maxRedirects) throw new SafeFetchError('too_many_redirects', `more than ${maxRedirects} redirects`);
          let next: URL;
          try {
            next = new URL(location, url);
          } catch {
            throw refuse('invalid redirect location');
          }
          if (next.origin !== url.origin) headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !CREDENTIAL_HEADERS.includes(k)));
          current = next.href;
          continue;
        }
        const { buf, truncated } = await readBody(res.body, maxBytes, stop.p);
        return { finalUrl: url.href, status: res.status, contentType: res.headers['content-type'] ?? '', headers: res.headers, body: buf, truncated };
      }
    } catch (err) {
      if (err instanceof SafeFetchError) throw err;
      if (o.signal?.aborted) throw new SafeFetchError('aborted', 'the fetch was cancelled');
      if (timeout.aborted) throw new SafeFetchError('timeout', 'the fetch timed out');
      throw new SafeFetchError('failed', 'the request failed');
    } finally {
      clearTimeout(clock);
      stop.done();
    }
  };
}
