import type { Browser } from 'puppeteer-core';
import { describe, expect, it, vi } from 'vitest';
import { SafeFetchError } from '../../../net/guard.js';
import type { SessionStats } from '../../../net/proxy.js';
import { fakeResolver } from '../../../tests/fakes/net.js';
import { ChromeBrowser, type ProxyControl } from './chrome.js';

const PUBLIC = '93.184.215.14';
const resolver = fakeResolver({ 'example.com': [PUBLIC], 'evil.example': ['10.1.2.3'] });
const zero: SessionStats = { bytes: 0, requests: 1, blocked: 0, capped: false };

type Req = { url: () => string; resourceType: () => string; continue: ReturnType<typeof vi.fn>; abort: ReturnType<typeof vi.fn> };
const req = (url: string, type = 'document'): Req => ({ url: () => url, resourceType: () => type, continue: vi.fn(async () => {}), abort: vi.fn(async () => {}) });

type Rig = ReturnType<typeof rig>;
function rig(o: { cdpFail?: boolean; html?: string; status?: number; headers?: Record<string, string>; goto?: () => Promise<unknown>; stats?: SessionStats; closeCtx?: () => Promise<void>; maxConcurrent?: number; timeoutMs?: number; final?: string } = {}) {
  const handlers: Record<string, (x: never) => void> = {};
  const sent: { method: string; params: unknown }[] = [];
  const response = { status: () => o.status ?? 200, headers: () => o.headers ?? { 'content-type': 'text/html; charset=utf-8' }, text: async () => 'plain body' };
  const page = {
    authenticate: vi.fn(async () => {}), setUserAgent: vi.fn(async () => {}), setBypassServiceWorker: vi.fn(async () => {}), setRequestInterception: vi.fn(async () => {}),
    on: vi.fn((ev: string, fn: (x: never) => void) => void (handlers[ev] = fn)),
    goto: vi.fn(o.goto ?? (async () => response)), waitForNetworkIdle: vi.fn(async () => {}),
    evaluate: vi.fn(async (_fn: unknown, n: number) => (o.html ?? '<html><body><p>hi</p></body></html>').slice(0, n + 1)), url: () => o.final ?? 'https://example.com/a#frag', target: () => ({}),
  };
  const ctx = { id: 'ctx1', newPage: vi.fn(async () => page), close: vi.fn(o.closeCtx ?? (async () => {})), on: vi.fn() };
  const browser = {
    createBrowserContext: vi.fn(async () => ctx), userAgent: vi.fn(async () => 'Mozilla/5.0 HeadlessChrome/157.0'), version: vi.fn(async () => 'Chrome/157.0.8103.27'), close: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    target: () => ({ createCDPSession: async () => ({ send: async (method: string, params: unknown) => { if (o.cdpFail) throw new Error('refused'); sent.push({ method, params }); }, detach: async () => {} }) }),
  };
  const control: ProxyControl & { opened: number; closed: string[] } = {
    opened: 0, closed: [],
    open: async () => ({ user: `s${++control.opened}`, pass: 'secret' }),
    close: async (u) => (control.closed.push(u), o.stats ?? zero),
    health: async () => {},
  };
  const connect = vi.fn(async () => browser as unknown as Browser);
  const chrome = new ChromeBrowser({ cdpUrl: 'http://127.0.0.1:9222', control, connect, resolver, ...(o.maxConcurrent ? { maxConcurrent: o.maxConcurrent } : {}), ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) });
  return { chrome, page, ctx, browser, control, handlers, sent, connect };
}

describe('ChromeBrowser.fetch', () => {
  it('renders the page in a fresh context, returns the DOM and tears everything down', async () => {
    const r = rig();
    const res = await r.chrome.fetch('https://example.com/a');
    expect(res.status).toBe(200);
    expect(res.finalUrl).toBe('https://example.com/a');
    expect(res.body.toString()).toContain('<p>hi</p>');
    expect(res.contentType).toMatch(/html/);
    expect(r.page.authenticate).toHaveBeenCalledWith({ username: 's1', password: 'secret' });
    expect(r.page.setUserAgent).toHaveBeenCalledWith({ userAgent: 'Mozilla/5.0 Chrome/157.0' });
    expect(r.ctx.close).toHaveBeenCalledOnce();
    expect(r.control.closed).toEqual(['s1']);
    expect(r.browser.disconnect).toHaveBeenCalledOnce();
  });

  it('refuses private targets before any session or browser is opened', async () => {
    for (const url of ['http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'https://evil.example/', 'http://[::1]/', 'http://0.0.0.0/', 'http://127.1/', 'file:///etc/passwd']) {
      const r = rig();
      const err = await r.chrome.fetch(url).then(() => null, (e: unknown) => e);
      expect(err, url).toBeInstanceOf(SafeFetchError);
      expect(r.control.opened, url).toBe(0);
      expect(r.connect, url).not.toHaveBeenCalled();
    }
  });

  it('a navigation error after a proxy refusal is reported as blocked (redirect to a private address)', async () => {
    const r = rig({ goto: async () => { throw new Error('net::ERR_TUNNEL_CONNECTION_FAILED'); }, stats: { ...zero, blocked: 1 } });
    const err = (await r.chrome.fetch('https://example.com/go').catch((e: unknown) => e)) as SafeFetchError;
    expect(err.code).toBe('blocked');
    expect(r.ctx.close).toHaveBeenCalled();
    expect(r.control.closed).toEqual(['s1']);
  });

  it('a plain-http refusal page from the proxy (x-guard-blocked) is reported as blocked', async () => {
    const r = rig({ status: 403, headers: { 'x-guard-blocked': '1', 'content-type': 'text/plain' } });
    const err = (await r.chrome.fetch('http://example.com/go').catch((e: unknown) => e)) as SafeFetchError;
    expect(err.code).toBe('blocked');
  });

  it('reports a capped session and other failures without leaking the browser error text', async () => {
    const capped = rig({ goto: async () => { throw new Error('net::ERR_CONNECTION_RESET secret-detail'); }, stats: { ...zero, capped: true } });
    const e1 = (await capped.chrome.fetch('https://example.com/').catch((e: unknown) => e)) as SafeFetchError;
    expect(e1.message).toMatch(/cap/);
    const plain = rig({ goto: async () => { throw new Error('boom secret-detail'); } });
    const e2 = (await plain.chrome.fetch('https://example.com/').catch((e: unknown) => e)) as SafeFetchError;
    expect(e2.code).toBe('failed');
    expect(e2.message).not.toContain('secret-detail');
  });

  it('a document that loaded but went over the proxy caps is an error, not partial content', async () => {
    const r = rig({ stats: { ...zero, capped: true } });
    const err = (await r.chrome.fetch('https://example.com/a').catch((e: unknown) => e)) as SafeFetchError;
    expect(err).toBeInstanceOf(SafeFetchError);
    expect(err.message).toMatch(/cap/);
    expect(r.ctx.close).toHaveBeenCalled();
  });

  it('times out, and still closes the context and the credential', async () => {
    const r = rig({ goto: () => new Promise(() => {}), timeoutMs: 80 });
    const err = (await r.chrome.fetch('https://example.com/').catch((e: unknown) => e)) as SafeFetchError;
    expect(err.code).toBe('timeout');
    expect(r.ctx.close).toHaveBeenCalled();
    expect(r.control.closed).toEqual(['s1']);
  });

  it('plain text pages return the raw text; binary types return no body', async () => {
    const t = rig({ headers: { 'content-type': 'text/plain' } });
    expect((await t.chrome.fetch('https://example.com/t')).body.toString()).toBe('plain body');
    const b = rig({ headers: { 'content-type': 'image/png' } });
    const res = await b.chrome.fetch('https://example.com/p');
    expect(res.contentType).toBe('image/png');
    expect(res.body.length).toBe(0);
  });

  it('caps the extracted document at the fetch byte cap and says so', async () => {
    const r = rig({ html: 'x'.repeat(2 * 1024 * 1024 + 10) });
    const res = await r.chrome.fetch('https://example.com/big');
    expect(res.truncated).toBe(true);
    expect(res.body.length).toBe(2 * 1024 * 1024);
  });

  it('request policy: http(s) documents continue; file:, data:, chrome:, blob: and images/media/fonts are aborted', async () => {
    const r = rig();
    await r.chrome.fetch('https://example.com/a');
    const onRequest = r.handlers.request as unknown as (q: Req) => void;
    const ok = req('https://example.com/x');
    onRequest(ok);
    expect(ok.continue).toHaveBeenCalled();
    for (const q of [req('file:///etc/passwd'), req('data:text/html,hi'), req('chrome://settings'), req('blob:https://example.com/1'), req('javascript:alert(1)'), req('view-source:https://example.com/'), req('https://example.com/i.png', 'image'), req('https://example.com/v.mp4', 'media'), req('https://example.com/f.woff', 'font')]) {
      onRequest(q);
      expect(q.abort, q.url()).toHaveBeenCalled();
      expect(q.continue, q.url()).not.toHaveBeenCalled();
    }
  });

  it('a page that fires more requests than the cap has the excess aborted and the read fails', async () => {
    const r = rig();
    r.page.waitForNetworkIdle.mockImplementation(async () => {
      const onRequest = r.handlers.request as unknown as (q: Req) => void;
      for (let i = 0; i < 205; i++) onRequest(req(`https://example.com/s${i}`, 'fetch'));
    });
    const err = (await r.chrome.fetch('https://example.com/a').catch((e: unknown) => e)) as SafeFetchError;
    expect(err.message).toMatch(/cap/);
  });

  it('capability policy: downloads denied, service workers bypassed, dialogs dismissed, interception on', async () => {
    const r = rig();
    await r.chrome.fetch('https://example.com/a');
    expect(r.sent.find((s) => s.method === 'Browser.setDownloadBehavior')?.params).toMatchObject({ behavior: 'deny', browserContextId: 'ctx1' });
    expect(r.sent.find((s) => s.method === 'Browser.grantPermissions')?.params).toEqual({ permissions: [], browserContextId: 'ctx1' });
    expect(r.page.setBypassServiceWorker).toHaveBeenCalledWith(true);
    expect(r.page.setRequestInterception).toHaveBeenCalledWith(true);
    const dismiss = vi.fn(async () => {});
    (r.handlers.dialog as unknown as (d: unknown) => void)({ dismiss });
    expect(dismiss).toHaveBeenCalled();
  });

  it('concurrency is capped and the queue is bounded', async () => {
    let live = 0;
    let peak = 0;
    const r = rig({ maxConcurrent: 1, goto: async () => { live++; peak = Math.max(peak, live); await new Promise((ok) => setTimeout(ok, 20)); live--; return { status: () => 200, headers: () => ({ 'content-type': 'text/html' }), text: async () => '' }; } });
    await Promise.all([r.chrome.fetch('https://example.com/1'), r.chrome.fetch('https://example.com/2'), r.chrome.fetch('https://example.com/3')]);
    expect(peak).toBe(1);
    expect(r.control.closed).toHaveLength(3);
  });

  it('after three contexts that would not close, calls fail fast', async () => {
    const r = rig({ closeCtx: () => new Promise(() => {}) });
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 3; i++) {
        const p = r.chrome.fetch('https://example.com/').catch((e: unknown) => e);
        await vi.advanceTimersByTimeAsync(10_000);
        await p;
      }
      const err = (await r.chrome.fetch('https://example.com/').catch((e: unknown) => e)) as SafeFetchError;
      expect(err.message).toMatch(/unavailable/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('lockdown, size and maintenance', () => {
  it('fails closed when Chrome refuses a download or permission control (G2C-05)', async () => {
    const r = rig({ cdpFail: true });
    const err = (await r.chrome.fetch('https://example.com/a').catch((e: unknown) => e)) as SafeFetchError;
    expect(err).toBeInstanceOf(SafeFetchError);
    expect(r.page.goto).not.toHaveBeenCalled();
    expect(r.ctx.close).toHaveBeenCalled();
  });

  it('cuts the DOM inside the page, never calling page.content() (G2C-02)', async () => {
    const r = rig({ html: 'y'.repeat(3 * 1024 * 1024) });
    const res = await r.chrome.fetch('https://example.com/a');
    expect(res.truncated).toBe(true);
    expect(res.body.length).toBe(2 * 1024 * 1024);
    expect((r.page as Record<string, unknown>).content).toBeUndefined();
  });

  it('a version floor in the env can raise but never lower the pinned build (G2C-06)', async () => {
    const low = rig();
    const c = new ChromeBrowser({ cdpUrl: 'x', control: low.control, connect: low.connect, minVersion: '100.0.0.0' });
    low.browser.version.mockResolvedValue('Chrome/157.0.8103.26');
    expect(await c.check()).toMatchObject({ ok: false });
    const high = new ChromeBrowser({ cdpUrl: 'x', control: low.control, connect: low.connect, minVersion: '158.0.0.0' });
    low.browser.version.mockResolvedValue('Chrome/157.0.8103.27');
    expect(await high.check()).toMatchObject({ ok: false });
  });

  it('recycle closes Chrome only while idle', async () => {
    const r = rig();
    expect(await r.chrome.recycle()).toBe(true);
    expect(r.browser.close).toHaveBeenCalledOnce();
    const busy = rig({ goto: () => new Promise((ok) => setTimeout(() => ok({ status: () => 200, headers: () => ({ 'content-type': 'text/html' }), text: async () => '' }), 50)) });
    const p = busy.chrome.fetch('https://example.com/a');
    await new Promise((ok) => setTimeout(ok, 10));
    expect(await busy.chrome.recycle()).toBe(false);
    await p;
  }, 20_000);
});

describe('ChromeBrowser.check', () => {
  it('passes for a current Chrome, fails for an old one, an unreachable one and a dead proxy', async () => {
    const ok = rig();
    expect(await ok.chrome.check()).toEqual({ ok: true, version: 'Chrome/157.0.8103.27' });
    const old = rig();
    old.browser.version.mockResolvedValue('Chrome/157.0.8103.26');
    expect(await old.chrome.check()).toMatchObject({ ok: false, why: expect.stringMatching(/older than the minimum 157.0.8103.27/) });
    const down = rig();
    down.connect.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await down.chrome.check()).toMatchObject({ ok: false, why: expect.stringMatching(/npm run local:chrome/) });
    const noProxy = rig();
    noProxy.control.health = async () => { throw new Error('down'); };
    expect(await noProxy.chrome.check()).toMatchObject({ ok: false, why: expect.stringMatching(/guard proxy/) });
  });
});
