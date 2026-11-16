import type { Resolver, Transport, TransportRequest, TransportResponse } from '../../net/fetch.js';

/** Socket-free fakes for net/guard (spec §12 item 14): a scripted Resolver and a route-table Transport. */

/** host -> addresses. A function entry is called per resolution (rebinding fakes); a missing host rejects (NXDOMAIN). */
export function fakeResolver(table: Record<string, string[] | ((n: number) => string[])>): Resolver & { calls: string[] } {
  const calls: string[] = [];
  const r = (async (host: string) => {
    calls.push(host);
    const e = table[host];
    if (e === undefined) throw new Error(`ENOTFOUND ${host}`);
    return typeof e === 'function' ? e(calls.filter((h) => h === host).length) : e;
  }) as Resolver & { calls: string[] };
  r.calls = calls;
  return r;
}

export type FakeBody = string | Uint8Array[] | AsyncIterable<Uint8Array>;
export type FakeRoute = { status?: number; headers?: Record<string, string>; body?: FakeBody } | ((r: TransportRequest) => FakeRoute);

async function* chunks(b: string | Uint8Array[]): AsyncIterable<Uint8Array> {
  if (typeof b === 'string') yield new TextEncoder().encode(b);
  else for (const c of b) yield c;
}

/** Routes by full href (fragment dropped). Unknown urls answer 404. Every request is recorded, with the address it was sent to. */
export function fakeTransport(routes: Record<string, FakeRoute>): Transport & { requests: TransportRequest[] } {
  const requests: TransportRequest[] = [];
  const t = (async (r: TransportRequest): Promise<TransportResponse> => {
    requests.push(r);
    let route: FakeRoute = routes[r.url.href] ?? { status: 404, body: 'not found' };
    while (typeof route === 'function') route = route(r);
    const body = route.body ?? '';
    return {
      status: route.status ?? 200,
      headers: route.headers ?? { 'content-type': 'text/html; charset=utf-8' },
      body: typeof body === 'string' || Array.isArray(body) ? chunks(body) : body,
    };
  }) as Transport & { requests: TransportRequest[] };
  t.requests = requests;
  return t;
}

/** A body that never ends: 64 KiB chunks forever. */
export async function* endlessBody(): AsyncIterable<Uint8Array> {
  const c = new Uint8Array(64 * 1024).fill(97);
  for (;;) yield c;
}

/** A body that sends one chunk and then never sends another (ignores abort on purpose; the guard must not wait on it). */
export async function* stalledBody(): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode('start');
  await new Promise(() => {});
}

export const redirect = (location: string, status = 302): FakeRoute => ({ status, headers: { location }, body: '' });
