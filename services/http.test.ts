import { describe, expect, it } from 'vitest';
import { fakeFetch } from '../tests/fakes/http.js';
import { createHttpClient, HttpError } from './http.js';
import { vendorId } from './ids.js';

describe('HttpClient', () => {
  it('sends headers and query, parses JSON', async () => {
    const f = fakeFetch({ 'https://x.test/a': { body: { ok: 1 } } });
    const http = createHttpClient({ fetch: f });
    expect(await http.getJson('https://x.test/a', { headers: { authorization: 'T' }, query: [['p', '1'], ['q[]', '2']] })).toEqual({ ok: 1 });
    expect(f.requests[0]!.url).toBe('https://x.test/a?p=1&q%5B%5D=2');
    expect(f.requests[0]!.headers['authorization']).toBe('T');
  });
  it('non-2xx throws HttpError with status only; text carries no url, headers or body', async () => {
    const f = fakeFetch({ 'https://x.test/a': { status: 500, body: { echo: 'SECRET-TOKEN' } } });
    const err = await createHttpClient({ fetch: f }).getJson('https://x.test/a', { headers: { authorization: 'SECRET-TOKEN' } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(500);
    expect(String((err as HttpError).message) + JSON.stringify(err)).not.toMatch(/SECRET-TOKEN|x\.test|authorization/i);
  });
  it('network failure and timeout become HttpError without the cause text', async () => {
    const boom = (async () => { throw new Error('connect ECONNREFUSED authorization=SECRET'); }) as unknown as typeof fetch;
    const e1 = (await createHttpClient({ fetch: boom }).getJson('https://x.test/a').catch((e: unknown) => e)) as HttpError;
    expect(e1).toMatchObject({ kind: 'network', status: null });
    expect(e1.message).not.toContain('SECRET');
    const slow = ((_u: unknown, init?: RequestInit) => new Promise((_r, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))))) as unknown as typeof fetch;
    const e2 = await createHttpClient({ fetch: slow, timeoutMs: 10 }).getJson('https://x.test/a').catch((e: unknown) => e as HttpError);
    expect(e2).toMatchObject({ kind: 'timeout' });
  });
  it('does not follow redirects (the token would travel)', async () => {
    const f = fakeFetch({ 'https://x.test/a': { status: 302, headers: { location: 'https://evil.test/' } } });
    await expect(createHttpClient({ fetch: f }).getJson('https://x.test/a')).rejects.toMatchObject({ status: 302 });
  });
  const streamOf = (chunks: number, size: number, pulled: { n: number }): Response => {
    let i = 0;
    return new Response(new ReadableStream<Uint8Array>({ pull(ctl) { pulled.n++; if (i++ < chunks) ctl.enqueue(new Uint8Array(size).fill(0x61)); else ctl.close(); } }, { highWaterMark: 0 }), { status: 200 });
  };
  it('a body over maxBytes fails as too_large without being read to the end (bytes, not characters)', async () => {
    const pulled = { n: 0 };
    const f = (async () => streamOf(10_000, 1024, pulled)) as unknown as typeof fetch; // 10 MB offered
    const err = (await createHttpClient({ fetch: f, maxBytes: 4096 }).getJson('https://x.test/a').catch((e: unknown) => e)) as HttpError;
    expect(err).toMatchObject({ kind: 'too_large', status: 200 });
    expect(err.message).toBe('response too large');
    expect(pulled.n).toBeLessThan(10);
    // multi-byte text: 3 bytes per character, 2000 characters = 6000 bytes > 4096 although only 2000 UTF-16 units
    const wide = (async () => new Response(JSON.stringify('€'.repeat(2000)))) as unknown as typeof fetch;
    await expect(createHttpClient({ fetch: wide, maxBytes: 4096 }).getJson('https://x.test/a')).rejects.toMatchObject({ kind: 'too_large' });
  });
  it('content-length over the cap is refused before reading', async () => {
    const pulled = { n: 0 };
    const f = (async () => { const r = streamOf(5, 10, pulled); return new Response(r.body, { status: 200, headers: { 'content-length': '999999' } }); }) as unknown as typeof fetch;
    await expect(createHttpClient({ fetch: f, maxBytes: 4096 }).getJson('https://x.test/a')).rejects.toMatchObject({ kind: 'too_large' });
    expect(pulled.n).toBe(0);
  });
  it('an abort while reading the body is a timeout; bad JSON is a parse error with its own text', async () => {
    // like real fetch, the signal is tied to the body stream
    const hang = (async (_u: unknown, init?: RequestInit) => new Response(new ReadableStream({ start(ctl) { ctl.enqueue(new Uint8Array([123])); init?.signal?.addEventListener('abort', () => ctl.error(init.signal!.reason)); } }), { status: 200 })) as unknown as typeof fetch;
    const e1 = (await createHttpClient({ fetch: hang, timeoutMs: 20 }).getJson('https://x.test/a').catch((e: unknown) => e)) as HttpError;
    expect(e1).toMatchObject({ kind: 'timeout', status: null });
    const bad = fakeFetch({ 'https://x.test/a': { body: 'not json' } });
    const e2 = (await createHttpClient({ fetch: bad }).getJson('https://x.test/a').catch((e: unknown) => e)) as HttpError;
    expect(e2).toMatchObject({ kind: 'parse' });
    expect(e2.message).toBe('unreadable response');
  });
  it('vendorId accepts only the strict pattern', () => {
    const re = /^[a-z0-9]{1,32}$/;
    expect(vendorId(re, 'abc123')).toBe('abc123');
    for (const bad of ['../user', 'a/b', 'A', '', 'x'.repeat(33), 'a b', 'a%2e']) expect(() => vendorId(re, bad), bad).toThrow();
  });
});
