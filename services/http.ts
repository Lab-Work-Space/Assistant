/**
 * HttpClient for fixed vendor base URLs (PF9: net/guard's safeFetch is for user/LLM-influenced URLs only).
 * `fetch` is injected, so tests use tests/fakes/http.ts. Failures surface as HttpError with a fixed message and the
 * status code only: never the URL, request headers, the response body or the underlying error text (P9, P10).
 */
export type HttpErrorKind = 'http' | 'timeout' | 'network' | 'parse' | 'too_large';

export class HttpError extends Error {
  /** True for a 403/429 that carries `x-ratelimit-remaining: 0` or `retry-after` (GitHub's primary and secondary limits); nothing else of the headers is kept. */
  rateLimited = false;
  constructor(readonly kind: HttpErrorKind, readonly status: number | null) {
    super(kind === 'http' ? `HTTP ${status}` : kind === 'timeout' ? 'request timed out' : kind === 'parse' ? 'unreadable response' : kind === 'too_large' ? 'response too large' : 'network error');
    this.name = 'HttpError';
  }
}

export type GetOptions = { headers?: Record<string, string>; query?: [string, string][] };
export type SendOptions = { headers?: Record<string, string>; body?: unknown };
export interface HttpClient {
  getJson<T = unknown>(url: string, o?: GetOptions): Promise<T>;
  /** POST/PUT/DELETE with an optional JSON body. An empty response body (204) resolves to null. */
  sendJson<T = unknown>(method: 'POST' | 'PUT' | 'DELETE', url: string, o?: SendOptions): Promise<T | null>;
}

export type HttpClientOptions = { fetch?: typeof fetch; timeoutMs?: number; maxBytes?: number };

export function createHttpClient(o: HttpClientOptions = {}): HttpClient {
  const timeoutMs = o.timeoutMs ?? 15_000;
  const maxBytes = o.maxBytes ?? 4 * 1024 * 1024;
  const request = async (method: string, url: string, headers: Record<string, string>, body: string | undefined, query: [string, string][], allowEmpty: boolean): Promise<unknown> => {
    const u = new URL(url);
    for (const [k, v] of query) u.searchParams.append(k, v);
    let res: Response;
    try {
      // looked up per call so the unit-test guard (and any later patching of globalThis.fetch) applies
      const f = o.fetch ?? globalThis.fetch;
      res = await f(u.href, { method, headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body }), redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      throw new HttpError(name === 'TimeoutError' || name === 'AbortError' || (err instanceof Error && /abort|timed? ?out/i.test(err.message)) ? 'timeout' : 'network', null);
    }
    // a redirect would forward the credential header elsewhere: treated as a plain failure
    if (res.status < 200 || res.status >= 300) {
      void res.body?.cancel().catch(() => undefined);
      const err = new HttpError('http', res.status);
      err.rateLimited = (res.status === 403 || res.status === 429) && (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after'));
      throw err;
    }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      void res.body?.cancel().catch(() => undefined);
      throw new HttpError('too_large', res.status);
    }
    const text = await readCapped(res, maxBytes);
    if (allowEmpty && text.trim() === '') return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new HttpError('parse', res.status);
    }
  };
  return {
    getJson: async <T>(url: string, opts: GetOptions = {}) => (await request('GET', url, opts.headers ?? {}, undefined, opts.query ?? [], false)) as T,
    sendJson: async <T>(method: 'POST' | 'PUT' | 'DELETE', url: string, opts: SendOptions = {}) =>
      (await request(method, url, opts.headers ?? {}, opts.body === undefined ? undefined : JSON.stringify(opts.body), [], true)) as T | null,
  };
}

const isAbort = (err: unknown) => err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');

/** Reads the body as a stream counting BYTES; cancels the reader as soon as the cap is exceeded, so a huge or endless body is never buffered. */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new HttpError('too_large', res.status);
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(isAbort(err) ? 'timeout' : 'parse', isAbort(err) ? null : res.status);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
