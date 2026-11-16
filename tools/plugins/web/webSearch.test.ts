import { describe, expect, it, vi } from 'vitest';
import { ddgResultsHtml } from '../../../tests/fakes/http.js';
import { fakeResolver, fakeTransport } from '../../../tests/fakes/net.js';
import { ddgBackend, parseDdgHtml, SearchRefused, webSearchTool, type SearchBackend } from './webSearch.js';
import { webRig } from './test-helpers.js';
import { toolApprovalPayload } from '../../../discord/embeds/approval.js';

const hits = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `T${i}`, url: `https://r${i}.example/p?q=${i}`, snippet: `s${i}` }));
const backend = (out: ReturnType<typeof hits> | Error): SearchBackend & { search: ReturnType<typeof vi.fn> } => ({
  search: vi.fn(async () => {
    if (out instanceof Error) throw out;
    return out;
  }),
});

describe('web_search', () => {
  it('caps count at 10, result text wrapped untrusted', async () => {
    const b = backend(hits(15));
    const tool = webSearchTool(b);
    const { reg, c } = await webRig([tool]);
    expect((await reg.run('web_search', { query: 'q', count: 11 }, c)).isError).toBe(true);
    expect(b.search).not.toHaveBeenCalled();
    const res = await reg.run('web_search', { query: 'q', count: 10 }, c);
    expect(b.search).toHaveBeenCalledWith('q', 10);
    expect(res.content).toMatch(/^<untrusted-[0-9a-f]{16} source="web" author="web_search"/);
    expect(res.content).toContain('T9');
    expect(res.content).not.toContain('T10');
    // every result url reaches knownUrls verbatim (R17)
    expect([...c.run.knownUrls].sort()).toEqual(hits(10).map((h) => h.url).sort());
    expect(c.tainted()).toBe(true);
    // a direct call that bypasses zod is clamped too
    await tool.run({ query: 'q', count: 50 }, c);
    expect(b.search).toHaveBeenLastCalledWith('q', 10);
    await tool.run({ query: 'q' }, c);
    expect(b.search).toHaveBeenLastCalledWith('q', 5);
  });

  it('backend error → tool error, no throw', async () => {
    const tool = webSearchTool(backend(new Error('rate limited secret=abc')));
    const { reg, c } = await webRig([tool]);
    const res = await reg.run('web_search', { query: 'q' }, c);
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/search failed/);
    expect(res.content).not.toContain('secret=abc');
    expect(c.run.knownUrls.size).toBe(0);
  });

  it('a bot-check refusal says web search is blocked and points to fetch_page (no retry advice)', async () => {
    const { reg, c } = await webRig([webSearchTool(backend(new SearchRefused()))]);
    const res = await reg.run('web_search', { query: 'q' }, c);
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/blocked by the search provider/);
    expect(res.content).toMatch(/fetch_page/);
    expect(res.content).not.toMatch(/try again later/);
  });

  it('no results says so', async () => {
    const res = await webSearchTool(backend([])).run({ query: 'q' }, {} as never);
    expect(res).toMatchObject({ content: expect.stringMatching(/no results/i) });
  });
});

describe('web_search after taint (G2-05)', () => {
  const taint = (c: { run: { markTainted(): void } }) => c.run.markTainted();

  it('an untainted run searches without approval', async () => {
    const b = backend(hits(2));
    const { reg, c, approvals } = await webRig([webSearchTool(b)]);
    await reg.run('web_search', { query: 'dns' }, c);
    expect(approvals.request).not.toHaveBeenCalled();
    expect(b.search).toHaveBeenCalledTimes(1);
  });

  it('a tainted run asks first; the stored call holds the exact query and nothing is searched', async () => {
    const b = backend(hits(2));
    const { reg, c, approvals } = await webRig([webSearchTool(b)]);
    taint(c);
    const query = 'secret\n@everyone <@123> "tok_AbC"';
    const res = await reg.run('web_search', { query, count: 3 }, c);
    expect(res.content).toMatch(/^NOT DONE YET: waiting for approval of/);
    expect(b.search).not.toHaveBeenCalled(); // a never-granted approval means zero backend calls
    const req = (approvals.request.mock.calls as unknown as [{ reason: string; tool: { name: string; input: unknown } }][])[0]![0];
    expect(req.tool).toEqual({ name: 'web_search', input: { query, count: 3 } });
    expect(req.reason).toContain('3 results');
    // the card (built from the stored call) shows the query JSON-escaped and inert
    const card = toolApprovalPayload({ id: 1, taskId: 't', reason: req.reason, estCostUsd: 0, requestedBy: 'head:praw', status: 'pending', decidedBy: null, createdAt: new Date(), decidedAt: null, toolName: 'web_search', toolInput: req.tool.input } as never);
    const shown = card.fields!.filter((f) => f.name.startsWith('Query')).map((f) => f.value).join('');
    expect(shown).toContain('secret\\\\n'); // JSON \n, markdown-escaped: no raw newline
    expect(shown).not.toContain('\n');
    expect(shown).not.toMatch(/@everyone(?!\u200b)/);
    expect(shown).not.toContain('<@123>');
  });

  it('a tainted run refuses a query with invisible characters; an untainted run does not', async () => {
    const hidden = `dns${String.fromCodePoint(0xe0074, 0xe006f)}`;
    const b = backend(hits(1));
    const { reg, c, approvals } = await webRig([webSearchTool(b)]);
    expect((await reg.run('web_search', { query: hidden }, c)).isError).toBeUndefined();
    expect(b.search).toHaveBeenCalledTimes(1);
    taint(c);
    const res = await reg.run('web_search', { query: hidden }, c);
    expect(res.isError).toBe(true);
    expect(approvals.request).not.toHaveBeenCalled();
    expect(b.search).toHaveBeenCalledTimes(1);
  });

  it('an approved call runs once, even though the run is tainted', async () => {
    const b = backend(hits(2));
    const { reg, c } = await webRig([webSearchTool(b)]);
    taint(c);
    await reg.runApproved('web_search', { query: 'dns' }, c);
    expect(b.search).toHaveBeenCalledTimes(1);
  });

  it('a tainted run that is not direct asks too', async () => {
    const b = backend(hits(1));
    const { reg, c, approvals } = await webRig([webSearchTool(b)], { direct: false });
    taint(c);
    await reg.run('web_search', { query: 'x' }, c);
    expect(approvals.request).toHaveBeenCalledTimes(1);
    expect(b.search).not.toHaveBeenCalled();
  });
});

describe('duckduckgo backend', () => {
  const PAGE = ddgResultsHtml([
    { title: 'Ad &lt;x&gt;', url: 'https://ads.example/', snippet: 'buy', ad: true },
    { title: 'Node <DNS>', url: 'https://nodejs.org/api/dns.html', snippet: 'name & resolution' },
    { title: 'Wrapped', url: 'https://wrapped.example/a?b=1&c=2', snippet: 'via redirect', redirect: true },
    { title: 'Bad', url: 'javascript:alert(1)', snippet: 'x' },
  ]);

  it('parses titles, urls and snippets; skips ads and non-http links; decodes the uddg redirect', () => {
    expect(parseDdgHtml(PAGE)).toEqual([
      { title: 'Node <DNS>', url: 'https://nodejs.org/api/dns.html', snippet: 'name & resolution' },
      { title: 'Wrapped', url: 'https://wrapped.example/a?b=1&c=2', snippet: 'via redirect' },
    ]);
  });

  it('only a duckduckgo.com redirect is unwrapped (not evilduckduckgo.com)', () => {
    const page = ddgResultsHtml([{ title: 'x', url: 'https://ok.example/', snippet: 's' }])
      .replace('href="https://ok.example/"', `href="https://evilduckduckgo.com/l/?uddg=${encodeURIComponent('https://smuggled.example/')}"`);
    const out = parseDdgHtml(page);
    expect(out.map((h) => h.url)).not.toContain('https://smuggled.example/');
  });

  it.each(['<div class="result <a class="result__a" href="', '<div class="result ', 'class="result__a"', '<a'])(
    'linear on ~2 MiB of hostile %s input (< 200 ms)',
    (unit) => {
      const html = unit.repeat(Math.ceil((2 * 1024 * 1024) / unit.length));
      const t0 = performance.now();
      parseDdgHtml(html);
      expect(performance.now() - t0).toBeLessThan(200);
    },
  );

  it('POSTs the query with safe search on through the guard and returns at most n hits', async () => {
    const transport = fakeTransport({ 'https://html.duckduckgo.com/html/': { body: PAGE } });
    const resolver = fakeResolver({ 'html.duckduckgo.com': ['52.142.124.215'] });
    const out = await ddgBackend({ resolver, transport, extraPorts: () => [] }).search('dns lookup', 1);
    expect(out).toHaveLength(1);
    const q = transport.requests[0]!;
    expect(q.method).toBe('POST');
    expect(q.address).toBe('52.142.124.215');
    expect(Object.fromEntries(new URLSearchParams(q.body!.toString()))).toEqual({ q: 'dns lookup', kp: '1' });
  });

  it('a challenge page, a 202 or a private resolution is an error', async () => {
    const resolver = fakeResolver({ 'html.duckduckgo.com': ['52.142.124.215'] });
    for (const route of [{ body: '<html>Unfortunately, bots use DuckDuckGo too. <form id="challenge-form"></form></html>' }, { status: 202, body: '' }]) {
      const transport = fakeTransport({ 'https://html.duckduckgo.com/html/': route });
      await expect(ddgBackend({ resolver, transport, extraPorts: () => [] }).search('q', 5)).rejects.toBeInstanceOf(SearchRefused);
    }
    const transport = fakeTransport({});
    await expect(ddgBackend({ resolver: fakeResolver({ 'html.duckduckgo.com': ['10.0.0.1'] }), transport, extraPorts: () => [] }).search('q', 5)).rejects.toThrow();
    expect(transport.requests).toHaveLength(0);
  });
});
