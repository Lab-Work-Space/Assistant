import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import type { SafeFetchResult } from '../../../net/guard.js';
import { fakeResolver, redirect } from '../../../tests/fakes/net.js';
import * as F from '../../../tests/fakes/open-search.js';
import type { WebBrowser, WebNetOptions } from './browser.js';
import { openSearchBackend, parseGh, parseHn, parseNpm, parseSe, parseWiki, searchChain, SourceOff, UA, type OpenBackend } from './openSearch.js';
import { SearchRefused, webSearchTool, type SearchBackend, type SearchHit } from './webSearch.js';
import { webRig } from './test-helpers.js';

const T0 = Date.UTC(2026, 10, 10, 12, 0, 0);
const allOk = () => F.byHost({
  'en.wikipedia.org': F.ok(F.wikiEn), 'th.wikipedia.org': F.ok(F.wikiTh), 'hn.algolia.com': F.ok(F.hnOne),
  'api.stackexchange.com': F.ok(F.seOne), 'registry.npmjs.org': F.ok(F.npmOne), 'api.github.com': F.ok(F.ghOne),
});

function http(handler: (u: URL) => ReturnType<typeof F.status>, now: () => number = () => T0, o: { streamMs?: number; overallMs?: number } = {}) {
  const transport = F.hostTransport(handler);
  const net: WebNetOptions = { resolver: fakeResolver(F.resolverTable()), transport, extraPorts: () => [] };
  return { transport, backend: openSearchBackend(net, { now, ...o }) };
}
const page = (u: string, body: unknown, over: Partial<SafeFetchResult> = {}): SafeFetchResult => ({ finalUrl: u, status: 200, contentType: 'application/json', headers: {}, body: Buffer.from(JSON.stringify(body)), truncated: false, ...over });
function chrome(fetch: WebBrowser['fetch'], o: { now?: () => number; streamMs?: number; overallMs?: number } = {}) {
  const net: WebNetOptions = { resolver: fakeResolver({}), transport: F.hostTransport(() => ({ status: 500 })), extraPorts: () => [], browser: { fetch } };
  return openSearchBackend(net, { now: () => T0, ...o });
}
const bodyFor = (u: URL) => ({ 'en.wikipedia.org': F.wikiEn, 'th.wikipedia.org': F.wikiTh, 'hn.algolia.com': F.hnOne, 'api.stackexchange.com': F.seOne, 'registry.npmjs.org': F.npmOne, 'api.github.com': F.ghOne })[u.hostname];

describe('parsers (pure)', () => {
  it('Wikipedia: label, built url (slash title encoded), html and entities stripped', () => {
    const h = parseWiki(F.wikiEn, 'en');
    expect(h[0]).toEqual({ title: '[Wikipedia] Rust (programming language)', url: 'https://en.wikipedia.org/wiki/Rust_(programming_language)', snippet: 'Rust is a language & more "fast"' });
    expect(h[1]?.url).toBe('https://en.wikipedia.org/wiki/AC%2FDC');
    expect(parseWiki(F.wikiTh, 'th')[0]?.title).toBe('[Wikipedia TH] กรุงเทพมหานคร');
    expect(() => parseWiki({ nope: 1 }, 'en')).toThrow();
  });
  it('Hacker News: story url kept, item page otherwise; javascript: and data: urls become the item url (SR-C2)', () => {
    const h = parseHn(F.hnOne);
    expect(h[0]).toMatchObject({ title: '[Hacker News] Show HN: a thing', url: 'https://example.org/thing', snippet: '120 points, 33 comments, 2026-01-02' });
    expect(h[1]).toMatchObject({ url: 'https://news.ycombinator.com/item?id=222', snippet: '0 points, 0 comments, 2026-02-03' });
    for (const bad of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'ftp://x.example/a', 'file:///etc/passwd', 'not a url']) {
      expect(parseHn(F.hnBody([{ objectID: '9', title: 't', url: bad }]))[0]?.url, bad).toBe('https://news.ycombinator.com/item?id=9');
    }
    expect(parseHn(F.hnBody([{ objectID: 'x1', title: 't' }, { objectID: '1234567890123', title: 't' }, { objectID: '5' }]))).toEqual([]);
  });
  it('Stack Overflow: entity-decoded title, built url, tags capped at 5, bad items skipped', () => {
    const h = parseSe(F.seBody([...F.seOne.items, { question_id: 0, title: 'x', score: 1, answer_count: 0, is_answered: false, tags: [] }, { question_id: 1 }]));
    expect(h).toEqual([{ title: '[Stack Overflow] How to use "async" & await?', url: 'https://stackoverflow.com/questions/42', snippet: 'score 7, 2 answers (answered); tags: javascript, async, a, b, c' }]);
  });
  it('npm: bad names rejected, url built, description folded', () => {
    const h = parseNpm(F.npmBody([...F.npmOne.objects.map((o) => o.package), { name: '../etc', version: '1' }, { name: 'UPPER', version: '1' }, { name: 'a/b', version: '1' }, { name: 'x'.repeat(215), version: '1' }]));
    expect(h.map((x) => x.url)).toEqual(['https://www.npmjs.com/package/@scope/pkg', 'https://www.npmjs.com/package/left-pad']);
    expect(h[0]).toMatchObject({ title: '[npm] @scope/pkg', snippet: 'v1.2.3 - A pkg with lines' });
  });
  it('GitHub: bad full_name rejected, url built by code never html_url', () => {
    const h = parseGh(F.ghBody([...F.ghOne.items, { full_name: 'a/b/c', stargazers_count: 1 }, { full_name: '../x', stargazers_count: 1 }, { full_name: 'ok/name', stargazers_count: 1.5 }]));
    expect(h).toEqual([{ title: '[GitHub] rust-lang/rust', url: 'https://github.com/rust-lang/rust', snippet: '100000 stars, Rust: Empowering everyone' }]);
  });
  it('SR-C4: control characters, bidi/format characters, html and long text do not survive; title <= 200 with prefix, snippet <= 400', () => {
    const evil = 'a\u0000b‮c<script>alert(1)</script>d​e\n\tf';
    const hs = [
      parseWiki(F.wikiBody([{ title: evil, snippet: `x<script>bad()</script>${'y'.repeat(900)}\u0000‮` }]), 'en')[0],
      parseHn(F.hnBody([{ objectID: '1', title: evil + 'z'.repeat(500) }]))[0],
      parseNpm(F.npmBody([{ name: 'p', version: '1', description: evil.repeat(100) }]))[0],
    ];
    for (const h of hs) {
      expect(h).toBeDefined();
      expect(`${h!.title}${h!.snippet}`).not.toMatch(/[\u0000-\u001f‮​]/);
      expect(h!.title.length).toBeLessThanOrEqual(200);
      expect(h!.snippet.length).toBeLessThanOrEqual(400);
    }
    expect(hs[0]!.snippet).not.toContain('bad()');
  });
});

describe('open backend (HTTP path)', () => {
  it('queries all five source families, labels, q only through URLSearchParams, only the allowed headers (SR-C1, SR-C2, SR-C11)', async () => {
    const { backend, transport } = http(allOk());
    const q = 'a&b=c #x?';
    const hits = await backend.search(q, 10);
    expect(transport.requests.map((r) => r.url.hostname).sort()).toEqual(['api.github.com', 'api.stackexchange.com', 'en.wikipedia.org', 'hn.algolia.com', 'registry.npmjs.org']);
    for (const r of transport.requests) {
      expect([r.url.searchParams.get('q'), r.url.searchParams.get('query'), r.url.searchParams.get('text'), r.url.searchParams.get('srsearch')].filter(Boolean)).toEqual([q]);
      expect(Object.keys(r.headers).sort(), r.url.hostname).toEqual(r.url.hostname === 'api.github.com' ? ['accept', 'accept-encoding', 'user-agent', 'x-github-api-version'] : ['accept', 'accept-encoding', 'user-agent']);
      expect(r.headers['user-agent']).toBe(UA);
      expect(r.method).toBe('GET');
    }
    expect(transport.requests.find((r) => r.url.hostname === 'api.github.com')?.headers.accept).toBe('application/vnd.github+json');
    expect(hits.length).toBe(8);
    expect(hits.map((h) => h.title.match(/^\[[^\]]+\]/)![0])).toEqual(['[Wikipedia]', '[Hacker News]', '[Stack Overflow]', '[npm]', '[GitHub]', '[Wikipedia]', '[Hacker News]', '[npm]']);
  });
  it('n is clamped to 1-10 and sent as the limit; round-robin interleave stops at n and dedupes by url', async () => {
    const dup = F.hnBody([{ objectID: '1', title: 'dup', url: 'https://github.com/rust-lang/rust#frag' }]);
    const { backend, transport } = http(F.byHost({ 'hn.algolia.com': F.ok(dup), 'api.github.com': F.ok(F.ghOne), 'en.wikipedia.org': F.ok(F.wikiEn) }));
    const hits = await backend.search('q', 99);
    expect(transport.requests.every((r) => [r.url.searchParams.get('hitsPerPage'), r.url.searchParams.get('srlimit'), r.url.searchParams.get('per_page')].filter(Boolean).every((v) => v === '10'))).toBe(true);
    expect(hits.map((h) => h.url)).toEqual(['https://en.wikipedia.org/wiki/Rust_(programming_language)', 'https://github.com/rust-lang/rust', 'https://en.wikipedia.org/wiki/AC%2FDC']);
    const one = await http(allOk()).backend.search('q', 0);
    expect(one).toHaveLength(1);
  });
  it('Thai query adds Wikipedia TH and puts it first; a source filter limits streams', async () => {
    const { backend, transport } = http(allOk());
    const hits = await backend.search('กรุงเทพ', 3);
    expect(hits[0]?.title).toMatch(/^\[Wikipedia TH\]/);
    expect(transport.requests.some((r) => r.url.hostname === 'th.wikipedia.org')).toBe(true);
    const b2 = http(allOk());
    await b2.backend.search('hello', 5, ['wikipedia']);
    expect(b2.transport.requests.map((r) => r.url.hostname)).toEqual(['en.wikipedia.org']);
    const b3 = http(allOk());
    await b3.backend.search('hello', 5, ['npm']);
    expect(b3.transport.requests.map((r) => r.url.hostname)).toEqual(['registry.npmjs.org']);
  });
  it('a query over a stream limit skips that stream (GitHub 256, Wikipedia 300)', async () => {
    const { backend, transport } = http(allOk());
    await backend.search('x'.repeat(260), 5);
    expect(transport.requests.some((r) => r.url.hostname === 'api.github.com')).toBe(false);
    expect(transport.requests.some((r) => r.url.hostname === 'en.wikipedia.org')).toBe(true);
    transport.requests.length = 0;
    await backend.search('x'.repeat(301), 5);
    expect(transport.requests.some((r) => r.url.hostname === 'en.wikipedia.org')).toBe(false);
  });
  it('partial failure returns what it has; every stream failing throws; one OK stream with 0 hits returns []', async () => {
    const part = http(F.byHost({ 'en.wikipedia.org': F.status(500), 'hn.algolia.com': F.ok({ nonsense: 1 }), 'api.stackexchange.com': { status: 200, body: 'not json' }, 'registry.npmjs.org': F.ok(F.npmOne) }));
    expect((await part.backend.search('q', 5)).map((h) => h.title)).toEqual(['[npm] @scope/pkg', '[npm] left-pad']);
    await expect(http(() => F.status(500)).backend.search('q', 5)).rejects.toThrow();
    const empty = http(F.byHost({ 'en.wikipedia.org': F.ok(F.wikiBody([])), 'api.github.com': F.status(500) }));
    expect(await empty.backend.search('q', 5)).toEqual([]);
  });
  it('SR-C1: a cross-host redirect fails only that stream (allowHosts on every hop)', async () => {
    const h = http((u) => (u.hostname === 'en.wikipedia.org' ? redirect('https://evil.example/x') : u.hostname === 'registry.npmjs.org' ? F.ok(F.npmOne) : F.status(404)));
    const hits = await h.backend.search('q', 5);
    expect(hits.every((x) => x.title.startsWith('[npm]'))).toBe(true);
    expect(h.transport.requests.some((r) => r.url.hostname === 'evil.example')).toBe(false);
  });
  it('SR-C3: gzip is decoded by magic bytes; a bomb over 1 MiB and a truncated body fail only that stream', async () => {
    const g = http(F.byHost({ 'api.stackexchange.com': F.gz(F.seOne), 'registry.npmjs.org': F.ok(F.npmOne) }));
    expect((await g.backend.search('q', 5)).map((x) => x.title.split(']')[0])).toEqual(['[Stack Overflow', '[npm', '[npm']);
    const bomb = F.status(200, {}, {}) && ({ status: 200, headers: { 'content-type': 'application/json' }, body: [gzipSync(Buffer.alloc(2 * 1024 * 1024, 0x20))] });
    const b = http(F.byHost({ 'api.stackexchange.com': bomb, 'registry.npmjs.org': F.ok(F.npmOne) }));
    expect((await b.backend.search('q', 5)).every((x) => x.title.startsWith('[npm]'))).toBe(true);
    const big = { status: 200, headers: { 'content-type': 'application/json' }, body: [Buffer.alloc(600 * 1024, 0x20)] };
    const t = http(F.byHost({ 'api.stackexchange.com': big, 'registry.npmjs.org': F.ok(F.npmOne) }));
    expect((await t.backend.search('q', 5)).every((x) => x.title.startsWith('[npm]'))).toBe(true);
    // deflate content-encoding
    const { deflateSync } = await import('node:zlib');
    const d = http(F.byHost({ 'registry.npmjs.org': { status: 200, headers: { 'content-encoding': 'deflate' }, body: [deflateSync(Buffer.from(JSON.stringify(F.npmOne)))] } }));
    expect(await d.backend.search('q', 5)).toHaveLength(2);
  });
});

describe('limiter and cool-downs (SR-C7)', () => {
  const only = (id: 'github' | 'stackoverflow') => [id] as ('github' | 'stackoverflow')[];
  it('github 8 per minute: the 9th is skipped, never waited for; the window slides', async () => {
    let t = T0;
    const h = http(allOk(), () => t);
    for (let i = 0; i < 8; i++) await h.backend.search('q', 3, only('github'));
    await expect(h.backend.search('q', 3, only('github'))).rejects.toThrow();
    expect(h.transport.requests).toHaveLength(8);
    t += 61_000;
    expect(await h.backend.search('q', 3, only('github'))).toHaveLength(1);
  });
  it('stackoverflow 250 per UTC day, then free again the next day', async () => {
    let t = T0;
    const h = http(allOk(), () => t);
    for (let i = 0; i < 250; i++) { t += 61_000; await h.backend.search('q', 3, only('stackoverflow')); }
    t += 61_000;
    await expect(h.backend.search('q', 3, only('stackoverflow'))).rejects.toThrow();
    t = Math.ceil(t / 86_400_000) * 86_400_000 + 1000;
    expect(await h.backend.search('q', 3, only('stackoverflow'))).toHaveLength(1);
  });
  it('backoff in a body cools the stream down for that many seconds (the hits of that answer are kept)', async () => {
    let t = T0;
    const h = http(F.byHost({ 'api.stackexchange.com': F.ok(F.seBody(F.seOne.items, { backoff: 30 })) }), () => t);
    expect(await h.backend.search('q', 3, only('stackoverflow'))).toHaveLength(1);
    t += 29_000;
    await expect(h.backend.search('q', 3, only('stackoverflow'))).rejects.toThrow();
    t += 2_000;
    expect(await h.backend.search('q', 3, only('stackoverflow'))).toHaveLength(1);
  });
  it('stackoverflow 400 error_id 502 and quota_remaining 0 cool down until the next UTC midnight', async () => {
    for (const route of [F.status(400, { error_id: 502, error_name: 'throttle_violation' }), F.ok(F.seBody(F.seOne.items, { quota_remaining: 0 }))]) {
      let t = T0; // 12:00 UTC
      const h = http(F.byHost({ 'api.stackexchange.com': route }), () => t);
      await h.backend.search('q', 3, only('stackoverflow')).catch(() => undefined);
      t += 11 * 3600_000;
      await expect(h.backend.search('q', 3, only('stackoverflow'))).rejects.toThrow();
      expect(h.transport.requests).toHaveLength(1);
      t += 2 * 3600_000;
      await h.backend.search('q', 3, only('stackoverflow')).catch(() => undefined);
      expect(h.transport.requests).toHaveLength(2);
    }
  });
  it('github 403 with x-ratelimit-reset cools down until the reset; other 429 -> 60 s', async () => {
    let t = T0;
    const reset = String(Math.floor(T0 / 1000) + 600);
    const h = http(F.byHost({ 'api.github.com': F.status(403, {}, { 'x-ratelimit-reset': reset }) }), () => t);
    await h.backend.search('q', 3, only('github')).catch(() => undefined);
    t += 599_000;
    await expect(h.backend.search('q', 3, only('github'))).rejects.toThrow();
    expect(h.transport.requests).toHaveLength(1);
    t += 2_000;
    await h.backend.search('q', 3, only('github')).catch(() => undefined);
    expect(h.transport.requests).toHaveLength(2);
    // 429 on npm -> 60 s
    let t2 = T0;
    const n = http(F.byHost({ 'registry.npmjs.org': F.status(429) }), () => t2);
    await n.backend.search('q', 3, ['npm']).catch(() => undefined);
    t2 += 59_000;
    await n.backend.search('q', 3, ['npm']).catch(() => undefined);
    expect(n.transport.requests).toHaveLength(1);
    t2 += 2_000;
    await n.backend.search('q', 3, ['npm']).catch(() => undefined);
    expect(n.transport.requests).toHaveLength(2);
  });
  it('SR-C7: an absurd reset / backoff is clamped to 24 h; junk, negative or past values fall back to 60 s', async () => {
    const day = 24 * 3600_000;
    for (const [reset, expectMs] of [['99999999999999', day], [String(Math.floor(T0 / 1000) - 5000), 60_000], ['abc', 60_000], ['-5', 60_000], ['', 60_000]] as const) {
      let t = T0;
      const h = http(F.byHost({ 'api.github.com': F.status(429, {}, { 'x-ratelimit-reset': reset }) }), () => t);
      await h.backend.search('q', 3, ['github']).catch(() => undefined);
      t += expectMs - 1000;
      await h.backend.search('q', 3, ['github']).catch(() => undefined);
      expect(h.transport.requests, `before ${reset}`).toHaveLength(1);
      t += 2000;
      await h.backend.search('q', 3, ['github']).catch(() => undefined);
      expect(h.transport.requests, `after ${reset}`).toHaveLength(2);
    }
    for (const [backoff, expectMs] of [[10_000_000_000, day], [-3, 60_000], ['soon', 60_000]] as const) {
      let t = T0;
      const h = http(F.byHost({ 'api.stackexchange.com': F.ok(F.seBody(F.seOne.items, { backoff })) }), () => t);
      await h.backend.search('q', 3, ['stackoverflow']);
      t += expectMs - 1000;
      await h.backend.search('q', 3, ['stackoverflow']).catch(() => undefined);
      expect(h.transport.requests, `before ${backoff}`).toHaveLength(1);
      t += 2000;
      await h.backend.search('q', 3, ['stackoverflow']).catch(() => undefined);
      expect(h.transport.requests, `after ${backoff}`).toHaveLength(2);
    }
  });
});

describe('Chrome path (SR-C1, SR-C8)', () => {
  it('a final host that is not the stream host fails the stream; the rest still answer', async () => {
    const be = chrome(async (u) => {
      const url = new URL(u);
      if (url.hostname === 'en.wikipedia.org') return page('https://evil.example/x', F.wikiEn);
      return page(u, bodyFor(url));
    });
    const hits = await be.search('q', 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.title.startsWith('[Wikipedia]'))).toBe(false);
    expect(await chrome(async (u) => page('https://en.wikipedia.org.evil.example/', F.wikiEn)).search('q', 3, ['wikipedia']).catch((e) => e instanceof Error)).toBe(true);
  });
  it('a truncated page fails the stream', async () => {
    const be = chrome(async (u) => page(u, bodyFor(new URL(u)), { truncated: true }));
    await expect(be.search('q', 3)).rejects.toThrow();
  });
  it('never more than 2 streams at once (6 streams for a Thai query)', async () => {
    let active = 0, peak = 0;
    const be = chrome(async (u) => {
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      return page(u, bodyFor(new URL(u)));
    });
    const hits = await be.search('กรุงเทพ', 10);
    expect(peak).toBe(2);
    expect(hits.length).toBeGreaterThan(3);
  });
  it('a stream that outlives its race is dropped and its late result is never merged', async () => {
    const be = chrome(async (u) => {
      const url = new URL(u);
      if (url.hostname === 'hn.algolia.com') { await new Promise((r) => setTimeout(r, 60)); return page(u, F.hnOne); }
      return page(u, bodyFor(url));
    }, { streamMs: 20 });
    const first = await be.search('q', 10);
    expect(first.some((h) => h.title.startsWith('[Hacker News]'))).toBe(false);
    await new Promise((r) => setTimeout(r, 80));
    const second = await be.search('q', 10, ['hackernews']).catch(() => 'failed');
    expect(second).toBe('failed'); // the late first result left no state behind and the stream still times out
  });
  it('the overall deadline returns what finished and drops the rest', async () => {
    const be = chrome(async (u) => {
      const url = new URL(u);
      if (url.hostname === 'registry.npmjs.org' || url.hostname === 'api.github.com') await new Promise((r) => setTimeout(r, 200));
      return page(u, bodyFor(url));
    }, { overallMs: 40, streamMs: 1000 });
    const hits = await be.search('q', 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => /^\[(npm|GitHub)\]/.test(h.title))).toBe(false);
  });
  it('sends no headers through Chrome (the port takes none) and Chrome gzip is not touched', async () => {
    const seen: string[][] = [];
    const be = chrome(async (u, ...rest) => { seen.push(rest.map(String)); return page(u, bodyFor(new URL(u))); });
    await be.search('q', 3);
    expect(seen.every((s) => s.length === 0)).toBe(true);
  });
});

describe('searchChain', () => {
  const hit = (t: string): SearchHit => ({ title: t, url: `https://x.example/${t}`, snippet: '' });
  const mk = (ddg: () => Promise<SearchHit[]>, open: () => Promise<SearchHit[]> = async () => [hit('open')], enabled: () => boolean = () => true) => {
    let t = T0;
    const d = { search: vi.fn(ddg) } satisfies SearchBackend;
    const o = { search: vi.fn(open) } satisfies OpenBackend;
    const chain = searchChain(d, o, { enabled, now: () => t });
    return { d, o, chain, adv: (ms: number) => { t += ms; } };
  };
  it('DDG hits are returned and the open backend is untouched', async () => {
    const c = mk(async () => [hit('ddg')]);
    expect(await c.chain.search('q', 5)).toEqual([hit('ddg')]);
    expect(c.o.search).not.toHaveBeenCalled();
  });
  it('refused -> open; 6 h cool-down skips DDG, then DDG is tried again after expiry', async () => {
    const c = mk(async () => { throw new SearchRefused(); });
    expect(await c.chain.search('q', 5)).toEqual([hit('open')]);
    expect(c.d.search).toHaveBeenCalledTimes(1);
    c.adv(6 * 3600_000 - 1000);
    await c.chain.search('q', 5);
    expect(c.d.search).toHaveBeenCalledTimes(1);
    c.adv(2000);
    await c.chain.search('q', 5);
    expect(c.d.search).toHaveBeenCalledTimes(2);
  });
  it('another DDG error and 0 hits go to open with no cool-down', async () => {
    for (const ddg of [async () => { throw new Error('boom'); }, async () => [] as SearchHit[]]) {
      const c = mk(ddg);
      await c.chain.search('q', 5);
      await c.chain.search('q', 5);
      expect(c.d.search).toHaveBeenCalledTimes(2);
      expect(c.o.search).toHaveBeenCalledTimes(2);
    }
  });
  it('switch off (or a read error) behaves like today: DDG only, errors pass through, no cool-down', async () => {
    for (const enabled of [() => false, () => { throw new Error('cfg'); }]) {
      const c = mk(async () => { throw new SearchRefused(); }, undefined, enabled);
      await expect(c.chain.search('q', 5)).rejects.toBeInstanceOf(SearchRefused);
      await expect(c.chain.search('q', 5)).rejects.toBeInstanceOf(SearchRefused);
      expect(c.d.search).toHaveBeenCalledTimes(2);
      expect(c.o.search).not.toHaveBeenCalled();
      expect(c.d.search).toHaveBeenCalledWith('q', 5);
    }
  });
  it('source set: DDG is skipped and open gets [source]; switch off -> SourceOff', async () => {
    const c = mk(async () => [hit('ddg')]);
    await c.chain.search('q', 5, { source: 'npm' });
    expect(c.d.search).not.toHaveBeenCalled();
    expect(c.o.search).toHaveBeenCalledWith('q', 5, ['npm']);
    const off = mk(async () => [hit('ddg')], undefined, () => false);
    await expect(off.chain.search('q', 5, { source: 'npm' })).rejects.toBeInstanceOf(SourceOff);
    expect(off.o.search).not.toHaveBeenCalled();
  });
  it('all open sources failed: SearchRefused when DDG was refused (also during cool-down), a plain Error otherwise', async () => {
    const fail = async (): Promise<SearchHit[]> => { throw new Error('none'); };
    const c = mk(async () => { throw new SearchRefused(); }, fail);
    await expect(c.chain.search('q', 5)).rejects.toBeInstanceOf(SearchRefused);
    await expect(c.chain.search('q', 5)).rejects.toBeInstanceOf(SearchRefused); // cool-down path
    const d = mk(async () => { throw new Error('x'); }, fail);
    const e = await d.chain.search('q', 5).catch((x) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(SearchRefused);
    const z = mk(async () => [], async () => []);
    expect(await z.chain.search('q', 5)).toEqual([]);
  });
});

describe('tool wiring', () => {
  it('end to end: refused DDG + open hits reach the model and knownUrls; T1 / T2 / T4 are fixed texts; source rides along', async () => {
    const ddg: SearchBackend = { search: async () => { throw new SearchRefused(); } };
    const net: WebNetOptions = { resolver: fakeResolver(F.resolverTable()), transport: F.hostTransport(allOk()), extraPorts: () => [] };
    let on = true;
    const tool = webSearchTool(searchChain(ddg, openSearchBackend(net), { enabled: () => on }));
    const fresh = async () => webRig([tool]); // a run that read outside text needs approval, so each call gets its own clean run
    const call = async (input: Record<string, unknown>) => { const r = await fresh(); return r.reg.run('web_search', input, r.c); };
    const { reg, c } = await fresh();
    const res = await reg.run('web_search', { query: 'rust', count: 3 }, c);
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('[Wikipedia] Rust');
    expect(c.run.knownUrls.has('https://github.com/rust-lang/rust') || c.run.knownUrls.size > 0).toBe(true);
    const gh = await call({ query: 'rust', source: 'github' });
    expect(gh.content).toContain('[GitHub] rust-lang/rust');
    expect((await call({ query: 'rust', source: 'bing' })).isError).toBe(true);
    on = false;
    const off = await call({ query: 'rust', source: 'github' });
    expect(off.content).toContain('web.search.openSources is false');
    const refused = await call({ query: 'rust' });
    expect(refused.content).toMatch(/blocked by the search provider/);
    expect(refused.content).toMatch(/fetch_page/);
  });
  it('SR-C6: requiresApproval still runs with source; the reason names the third parties and keeps "N results"', async () => {
    const tool = webSearchTool({ search: async () => [] });
    const tainted = { tainted: () => true } as never;
    expect(await tool.requiresApproval!({ query: 'q', count: 3 }, tainted)).toMatchObject({ reason: expect.stringMatching(/DuckDuckGo; Wikipedia, Hacker News, Stack Exchange, npm and GitHub.*\(3 results\)/) });
    expect(await tool.requiresApproval!({ query: 'q', source: 'github' }, tainted)).toMatchObject({ reason: expect.stringContaining('send the query below to GitHub (5 results)') });
    expect(await tool.requiresApproval!({ query: 'q', source: 'github' }, { tainted: () => false } as never)).toBe(false);
    expect(tool.description).toMatch(/\[source\]/);
  });
  it('SR-C5: openSearch.ts has no log or console calls', () => {
    const src = readFileSync(new URL('./openSearch.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/console\.|\blog\w*\.|logger/i);
  });
});
