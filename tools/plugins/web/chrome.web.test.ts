import { describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../../../core/env.js';
import { SafeFetchError, type SafeFetchResult } from '../../../net/guard.js';
import { fakeResolver, fakeTransport } from '../../../tests/fakes/net.js';
import { FakeConfig } from '../../../governance/test-helpers.js';
import type { PluginDeps } from '../deps.js';
import { bootWeb, loopbackUrl } from './boot.js';
import { unavailableBrowser, type WebBrowser } from './browser.js';
import { fetchPageTool } from './fetchPage.js';
import { webGroup } from './index.js';
import { ddgBackend } from './webSearch.js';
import { webRig } from './test-helpers.js';

const page = (over: Partial<SafeFetchResult> = {}): SafeFetchResult => ({ finalUrl: 'https://example.com/a', status: 200, contentType: 'text/html', headers: {}, body: Buffer.from('<p>rendered by chrome</p>'), truncated: false, ...over });
const browser = (impl: (u: string) => Promise<SafeFetchResult>): WebBrowser & { urls: string[] } => {
  const urls: string[] = [];
  return { urls, fetch: async (u) => (urls.push(u), impl(u)) };
};
// An HTTP path that must never be used when a browser is configured.
const noHttp = () => ({ resolver: fakeResolver({}), transport: fakeTransport({}), extraPorts: () => [] as number[] });

describe('web tools on the Chrome backend', () => {
  it('fetch_page reads through the browser only, keeping the untrusted wrapper and the taint', async () => {
    const b = browser(async () => page());
    const n = noHttp();
    const { reg, c } = await webRig([fetchPageTool({ ...n, browser: b })]);
    const res = await reg.run('fetch_page', { url: 'https://example.com/a' }, c);
    expect(res.content).toMatch(/^<untrusted-[0-9a-f]{16} source="web" author="fetch_page"/);
    expect(res.content).toContain('rendered by chrome');
    expect(c.tainted()).toBe(true);
    expect(b.urls).toEqual(['https://example.com/a']);
    expect(n.transport.requests).toHaveLength(0);
    expect(n.resolver.calls).toHaveLength(0);
  });

  it('fetch_page maps a browser refusal to a tool error and a blocked address stays "refused"', async () => {
    const b = browser(async () => { throw new SafeFetchError('blocked', 'refused: the address is not allowed'); });
    const { reg, c } = await webRig([fetchPageTool({ ...noHttp(), browser: b })]);
    const res = await reg.run('fetch_page', { url: 'https://example.com/go' }, c);
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/fetch_page refused/);
  });

  it('web_search renders the DuckDuckGo results page (GET, safe search on) in the browser', async () => {
    const html = '<div class="result results_links"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2F">Node.js</a><a class="result__snippet">runtime</a></div>';
    const b = browser(async () => page({ finalUrl: 'https://html.duckduckgo.com/html/', body: Buffer.from(html) }));
    const n = noHttp();
    const out = await ddgBackend({ ...n, browser: b }).search('node js', 5);
    expect(out).toEqual([{ title: 'Node.js', url: 'https://nodejs.org/', snippet: 'runtime' }]);
    const u = new URL(b.urls[0]!);
    expect(`${u.origin}${u.pathname}`).toBe('https://html.duckduckgo.com/html/');
    expect(Object.fromEntries(u.searchParams)).toEqual({ q: 'node js', kp: '1' });
    expect(n.transport.requests).toHaveLength(0);
  });

  it('a failing browser is an error for search; nothing falls back to HTTP', async () => {
    const b = browser(async () => { throw new SafeFetchError('failed', 'Chrome is unavailable'); });
    const n = noHttp();
    await expect(ddgBackend({ ...n, browser: b }).search('q', 3)).rejects.toThrow();
    expect(n.transport.requests).toHaveLength(0);
    await expect(unavailableBrowser().fetch('https://example.com/')).rejects.toBeInstanceOf(SafeFetchError);
  });
});

describe('web group and boot (Chrome only in local mode)', () => {
  const deps = (over: Partial<PluginDeps>) => ({ cfg: new FakeConfig(), env: {}, log: { warn: vi.fn() }, ...over }) as unknown as PluginDeps;
  const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/db', CONFIG_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'), BOT_ADMIN_ROLE_ID: '1565649426943442999', GUILD_ID: '1565649426943442999' };

  it('is disabled with the reason when the boot check failed; enabled with the browser; unchanged without Chrome config', () => {
    expect(webGroup(deps({ browserDisabled: 'Chrome does not answer' }))).toEqual({ id: 'web', disabled: 'Chrome does not answer' });
    const on = webGroup(deps({ browser: browser(async () => page()) }));
    expect('tools' in on && on.tools.map((t) => t.name)).toEqual(['fetch_page', 'web_search']);
    expect('tools' in webGroup(deps({}))).toBe(true);
  });

  it('env: CHROME_* keys are read raw; unset leaves chrome undefined', () => {
    expect(loadEnv(base).chrome).toBeUndefined();
    expect(loadEnv({ ...base, CHROME_CDP_URL: 'http://127.0.0.1:9222', CHROME_PROXY_CONTROL_URL: 'http://127.0.0.1:9223', CHROME_ACCESS_TOKEN: 'tok' }).chrome).toEqual({ cdpUrl: 'http://127.0.0.1:9222', controlUrl: 'http://127.0.0.1:9223', token: 'tok' });
  });

  it('bootWeb: nothing without config; loopback http only; a failed check disables with the reason and warns', async () => {
    const log = { warn: vi.fn() };
    expect(await bootWeb({}, log, { local: false })).toEqual({});
    // G2C-07: on the Mac a missing CHROME_* disables the group instead of taking the HTTP path
    expect((await bootWeb({}, log, { local: true })).disabled).toMatch(/local mode needs Chrome/);
    expect((await bootWeb({ chrome: { cdpUrl: 'http://127.0.0.1:9222', controlUrl: 'http://127.0.0.1:9223' } }, log, { local: false })).disabled).toMatch(/CHROME_ACCESS_TOKEN/);
    for (const bad of [{ cdpUrl: 'http://evil.example:9222', controlUrl: 'http://127.0.0.1:9223' }, { cdpUrl: 'https://127.0.0.1:9222', controlUrl: 'http://127.0.0.1:9223' }, { cdpUrl: 'http://127.0.0.1:9222' }, { cdpUrl: 'http://127.0.0.1:9222@evil.example:1', controlUrl: 'http://127.0.0.1:9223' }]) {
      const r = await bootWeb({ chrome: { ...bad, token: 't' } }, log, { local: true });
      expect(r.browser).toBeUndefined();
      expect(r.disabled).toMatch(/CHROME_CDP_URL/);
    }
    const down = await bootWeb({ chrome: { cdpUrl: 'http://127.0.0.1:9222', controlUrl: 'http://127.0.0.1:9223', token: 't' } }, log, { local: true, control: { open: async () => ({ user: 'u', pass: 'p' }), close: async () => null, health: async () => { throw new Error('down'); } } });
    expect(down.disabled).toMatch(/npm run local:chrome/);
    expect(log.warn).toHaveBeenCalled();
    expect(loopbackUrl('http://127.0.0.1:9222/')).toBe('http://127.0.0.1:9222');
    expect(loopbackUrl('http://10.0.0.1:9222')).toBeNull();
  });
});
