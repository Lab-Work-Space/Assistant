import type { Browser } from 'puppeteer-core';
import { describe, expect, it, vi } from 'vitest';
import { bootRenderer, RENDERER_OFF } from './boot.js';
import { ChromeRenderer, countPdfPages, type DiagramPage, PDF_MAX_BYTES, RENDER_MAX_MESSAGE, RenderError } from './render.js';

const PNG_OK = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)]);
type Req = { url: () => string; resourceType: () => string; continue: ReturnType<typeof vi.fn>; abort: ReturnType<typeof vi.fn> };
const req = (url: string, type = 'other'): Req => ({ url: () => url, resourceType: () => type, continue: vi.fn(async () => {}), abort: vi.fn(async () => {}) });
const pdfOf = (pages: number, extra = 0): Buffer => Buffer.concat([Buffer.from('%PDF-1.4\n'), ...Array.from({ length: pages }, () => Buffer.from('<< /Type /Page /Parent 1 0 R >>\n')), Buffer.alloc(extra, 0x20)]);
const streamOf = (b: Buffer, chunk = 64 * 1024): ReadableStream<Uint8Array> => {
  let i = 0;
  return new ReadableStream({ pull(c) { if (i >= b.length) return c.close(); c.enqueue(new Uint8Array(b.subarray(i, i + chunk))); i += chunk; } });
};

function rig(o: { evalResult?: unknown; shots?: Buffer[]; pdf?: Buffer; version?: string; requestsDuringLoad?: Req[]; setContent?: () => Promise<void>; closeCtx?: () => Promise<void>; cdpFail?: boolean; timeoutMs?: number; maxQueued?: number; connectFail?: boolean } = {}) {
  const handlers: Record<string, (x: never) => void> = {};
  const calls: string[] = [];
  const sent: { method: string; params: unknown }[] = [];
  const reqs = o.requestsDuringLoad ?? [];
  const evalArgs: unknown[][] = [];
  let shotNo = 0;
  const page = {
    setJavaScriptEnabled: vi.fn(async (v: boolean) => void calls.push(`js:${v}`)),
    setBypassServiceWorker: vi.fn(async () => {}),
    setRequestInterception: vi.fn(async (v: boolean) => void calls.push(`intercept:${v}`)),
    on: vi.fn((ev: string, fn: (x: never) => void) => void (handlers[ev] = fn)),
    setContent: vi.fn(async (html: string, opts: unknown) => { calls.push('setContent'); void html; void opts; for (const r of reqs) handlers.request!(r as never); await (o.setContent ?? (async () => {}))(); }),
    createPDFStream: vi.fn(async (opts: unknown) => { calls.push('createPDFStream'); void opts; return streamOf(o.pdf ?? pdfOf(1)); }),
    target: () => ({}),
    evaluate: vi.fn(async (fn: unknown, ...args: unknown[]) => { calls.push('evaluate'); void fn; evalArgs.push(args); return o.evalResult === undefined ? { w: 300, h: 200 } : o.evalResult; }),
    setViewport: vi.fn(async (v: unknown) => void calls.push(`viewport:${JSON.stringify(v)}`)),
    screenshot: vi.fn(async () => { calls.push('screenshot'); return new Uint8Array((o.shots ?? [PNG_OK])[Math.min(shotNo++, (o.shots ?? [PNG_OK]).length - 1)]!); }),
  };
  const ctx = { id: 'ctx1', newPage: vi.fn(async () => page), close: vi.fn(o.closeCtx ?? (async () => {})), on: vi.fn() };
  const browser = {
    createBrowserContext: vi.fn(async (_o?: unknown) => ctx), version: vi.fn(async () => o.version ?? 'Chrome/157.0.8103.27'), close: vi.fn(async () => {}), disconnect: vi.fn(async () => {}),
    target: () => ({ createCDPSession: async () => ({ send: async (method: string, params: unknown) => { if (o.cdpFail) throw new Error('refused'); sent.push({ method, params }); }, detach: async () => {} }) }),
  };
  const connect = vi.fn(async () => { if (o.connectFail) throw new Error('down'); return browser as unknown as Browser; });
  const r = new ChromeRenderer({ cdpUrl: 'http://127.0.0.1:9224', token: 't'.repeat(40), connect, ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}), ...(o.maxQueued !== undefined ? { maxQueued: o.maxQueued } : {}) });
  return { r, page, ctx, browser, handlers, calls, sent, connect, evalArgs };
}

describe('RF16 render driver', () => {
  it('RF16: a fresh context with a dead loopback proxy, scripts OFF before the content is set, setContent (never goto), every request aborted, PDF as a stream', async () => {
    const x = rig();
    const out = await x.r.renderPdf('<!doctype html><p>hi</p>');
    expect(out.pages).toBe(1);
    expect(out.pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(x.browser.createBrowserContext).toHaveBeenCalledWith({ proxyServer: 'http://127.0.0.1:1' });
    expect(x.calls).toEqual(['js:false', 'intercept:true', 'setContent', 'createPDFStream']);
    expect(x.page).not.toHaveProperty('goto'); // the fake has no goto: the driver cannot navigate
    expect(x.page.setContent).toHaveBeenCalledWith('<!doctype html><p>hi</p>', expect.objectContaining({ waitUntil: 'load' }));
    expect(x.sent).toEqual([{ method: 'Browser.setDownloadBehavior', params: { behavior: 'deny', browserContextId: 'ctx1' } }, { method: 'Browser.grantPermissions', params: { permissions: [], browserContextId: 'ctx1' } }]);
    expect(x.page.createPDFStream).toHaveBeenCalledWith(expect.objectContaining({ waitForFonts: false, printBackground: true }));
    expect(x.ctx.close).toHaveBeenCalledOnce();
    expect(x.browser.disconnect).toHaveBeenCalledOnce();
  });

  it('RF16 / RF17: zero requests: every request (http, https, file, a stylesheet, an image) is aborted and counted, and the render is refused; only the embedded data: font is allowed through', async () => {
    for (const url of ['http://evil.example/a.png', 'https://evil.example/a.css', 'file:///etc/passwd', 'ftp://x/y', 'data:text/html,<script>1</script>', 'blob:x', 'chrome://version']) {
      const rq = req(url, 'image');
      const x = rig({ requestsDuringLoad: [rq] });
      const err = (await x.r.renderPdf('<p>x</p>').catch((e: unknown) => e)) as RenderError;
      expect(err, url).toBeInstanceOf(RenderError);
      expect(err.code).toBe('failed');
      expect(rq.abort, url).toHaveBeenCalled();
      expect(rq.continue, url).not.toHaveBeenCalled();
      expect(x.r.lastStray, url).toBe(1);
      expect(x.page.createPDFStream, url).not.toHaveBeenCalled();
      expect(x.ctx.close).toHaveBeenCalled();
    }
    const font = req('data:font/ttf;base64,AAAA', 'font');
    const ok = rig({ requestsDuringLoad: [font] });
    await ok.r.renderPdf('<p>x</p>');
    expect(font.continue).toHaveBeenCalled();
    expect(ok.r.lastStray).toBe(0);
    // a data: font URL requested as a different resource type (a script, a document) is NOT the embedded font
    const sneaky = req('data:font/ttf;base64,AAAA', 'script');
    const s = rig({ requestsDuringLoad: [sneaky] });
    await expect(s.r.renderPdf('<p>x</p>')).rejects.toBeInstanceOf(RenderError);
    expect(sneaky.abort).toHaveBeenCalled();
  });

  it('RF16: fails closed when Chrome refuses the download or permission controls', async () => {
    const x = rig({ cdpFail: true });
    await expect(x.r.renderPdf('<p>x</p>')).rejects.toMatchObject({ code: 'failed' });
    expect(x.page.setContent).not.toHaveBeenCalled();
    expect(x.ctx.close).toHaveBeenCalled();
  });

  it('RF16: the PDF is read as a stream under the 8 MB cap: over the cap is a refusal, never a truncated file; the stream is cancelled', async () => {
    expect(PDF_MAX_BYTES).toBe(8 * 1024 * 1024);
    const x = rig({ pdf: pdfOf(1, PDF_MAX_BYTES) });
    await expect(x.r.renderPdf('<p>x</p>')).rejects.toMatchObject({ code: 'too_large' });
    const justUnder = rig({ pdf: pdfOf(1, PDF_MAX_BYTES - 200) });
    expect((await justUnder.r.renderPdf('<p>x</p>')).pdf.length).toBeLessThanOrEqual(PDF_MAX_BYTES);
    expect(RENDER_MAX_MESSAGE).toBe(6 * 1024 * 1024); // G2C-02: the DevTools message cap the connection is opened with
  });

  it('RF16: more than 30 pages is refused', async () => {
    await expect(rig({ pdf: pdfOf(31) }).r.renderPdf('<p>x</p>')).rejects.toMatchObject({ code: 'too_many_pages' });
    expect((await rig({ pdf: pdfOf(30) }).r.renderPdf('<p>x</p>')).pages).toBe(30);
    await expect(rig({ pdf: Buffer.from('not a pdf /Type /Page') }).r.renderPdf('<p>x</p>')).rejects.toMatchObject({ code: 'failed' });
  });

  it('RF16: a render that hangs times out (at most 20 s) and still closes the context and disconnects', async () => {
    const x = rig({ setContent: () => new Promise(() => {}), timeoutMs: 80 });
    await expect(x.r.renderPdf('<p>x</p>')).rejects.toMatchObject({ code: 'timeout' });
    expect(x.ctx.close).toHaveBeenCalled();
    expect(x.browser.disconnect).toHaveBeenCalled();
    const long = new ChromeRenderer({ cdpUrl: 'http://127.0.0.1:9224', token: 't', timeoutMs: 999_999, connect: async () => { throw new Error('x'); } });
    await expect(long.renderPdf('<p>x</p>')).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('RF15: a context that will not close counts as stuck; after two, the renderer refuses further work until it is recycled; a busy queue is refused', async () => {
    const x = rig({ closeCtx: () => new Promise(() => {}) });
    // CLOSE_WAIT is 3 s in production; two stuck renders here would be slow, so drive the counter through the public path with a fake clock
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 2; i++) {
        const p = x.r.renderPdf('<p>x</p>');
        await vi.advanceTimersByTimeAsync(4000);
        await p;
      }
    } finally {
      vi.useRealTimers();
    }
    await expect(x.r.renderPdf('<p>x</p>')).rejects.toMatchObject({ code: 'unavailable' });
    const busy = rig({ maxQueued: 0, setContent: () => new Promise((r) => setTimeout(r, 50)) });
    const first = busy.r.renderPdf('<p>1</p>');
    await expect(busy.r.renderPdf('<p>2</p>')).rejects.toMatchObject({ code: 'busy' });
    await first;
  });

  it('refuses an oversized document before connecting', async () => {
    const x = rig();
    await expect(x.r.renderPdf('x'.repeat(6 * 1024 * 1024 + 1))).rejects.toMatchObject({ code: 'too_large' });
    expect(x.connect).not.toHaveBeenCalled();
  });

  it('countPdfPages reads page dictionaries and the page tree count (and not /Pages)', () => {
    expect(countPdfPages(Buffer.from('<< /Type /Pages /Count 3 /Kids [] >> << /Type /Page >> << /Type /Page >> << /Type /Page >>'))).toBe(3);
    expect(countPdfPages(Buffer.from('<< /Type /Pages >>'))).toBe(0);
    expect(countPdfPages(Buffer.from('<</Type/Page/Parent 1 0 R>>'))).toBe(1);
  });

  it('check(): the renderer must answer and be at least the pinned Chrome version', async () => {
    expect(await rig().r.check()).toEqual({ ok: true, version: 'Chrome/157.0.8103.27' });
    expect(await rig({ version: 'Chrome/150.0.1.1' }).r.check()).toMatchObject({ ok: false, why: expect.stringMatching(/older than the minimum/) });
    expect(await rig({ connectFail: true }).r.check()).toMatchObject({ ok: false, why: expect.stringMatching(/npm run local:render/) });
  });
});

describe('RF15 boot', () => {
  const log = { warn: vi.fn() };
  it('RF15: without RENDER_* the group is off with the fixed message; a missing token, a non-loopback URL and a failed check are refused; nothing falls back', async () => {
    expect((await bootRenderer({}, log)).disabled).toBe(RENDERER_OFF);
    expect((await bootRenderer({ render: { cdpUrl: 'http://127.0.0.1:9224' } }, log)).disabled).toMatch(/RENDER_ACCESS_TOKEN/);
    for (const u of ['http://10.0.0.5:9224', 'http://evil.example:9224', 'https://127.0.0.1:9224', 'http://127.0.0.1']) expect((await bootRenderer({ render: { cdpUrl: u, token: 'tok' } }, log)).disabled, u).toMatch(/RENDER_CDP_URL/);
    const down = await bootRenderer({ render: { cdpUrl: 'http://127.0.0.1:9224', token: 'tok' } }, log, { connect: async () => { throw new Error('x'); } });
    expect(down.renderer).toBeUndefined();
    expect(down.disabled).toMatch(/does not answer/);
  });

  it('RF15: a healthy renderer boots; the env keys are separate from CHROME_* and parsed into env.render', async () => {
    const x = rig();
    const b = await bootRenderer({ render: { cdpUrl: 'http://127.0.0.1:9224', token: 'tok' } }, log, { connect: x.connect });
    expect(b.renderer).toBeInstanceOf(ChromeRenderer);
    const { loadEnv } = await import('../../../core/env.js');
    const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/db', CONFIG_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'), BOT_ADMIN_ROLE_ID: '1565649426943442999', GUILD_ID: '1565649426943442999' };
    expect(loadEnv(base).render).toBeUndefined();
    expect(loadEnv({ ...base, RENDER_CDP_URL: 'http://127.0.0.1:9224', RENDER_ACCESS_TOKEN: 'tok' }).render).toEqual({ cdpUrl: 'http://127.0.0.1:9224', token: 'tok' });
    expect(loadEnv({ ...base, CHROME_CDP_URL: 'http://127.0.0.1:9222', CHROME_ACCESS_TOKEN: 'web' }).render).toBeUndefined(); // the web Chrome is never the renderer
  });
});

describe('RFMD P4 / RF23 diagram render driver', () => {
  const DP: DiagramPage = { html: '<!doctype html><p>bundle here</p>', config: { securityLevel: 'strict' } };

  it('RF23: a fresh context on a dead proxy, scripts ON, interception on, the page set with setContent (no goto), the source passed only as an evaluate argument, PNG out', async () => {
    const x = rig();
    const out = await x.r.renderDiagram(DP, 'flowchart TD\n A-->B');
    expect(out.png.subarray(0, 4).toString('latin1')).toBe('\x89PNG');
    expect(out.width).toBe(332);
    expect(out.height).toBe(232);
    expect(x.browser.createBrowserContext).toHaveBeenCalledWith({ proxyServer: 'http://127.0.0.1:1' });
    expect(x.calls.filter((c) => !c.startsWith('viewport'))).toEqual(['js:true', 'intercept:true', 'setContent', 'evaluate', 'screenshot']);
    expect(x.page.setContent).toHaveBeenCalledWith(DP.html, expect.objectContaining({ waitUntil: 'load' }));
    expect(x.page).not.toHaveProperty('goto');
    expect(x.evalArgs[0]).toEqual(['flowchart TD\n A-->B', { securityLevel: 'strict' }, 3000]);
    expect(JSON.stringify(x.page.setContent.mock.calls)).not.toContain('A-->B'); // never pasted into HTML
    expect(x.sent.map((m) => m.method)).toEqual(['Browser.setDownloadBehavior', 'Browser.grantPermissions']);
    expect(x.ctx.close).toHaveBeenCalledOnce();
  });

  it('RF23: every request on the diagram page is aborted and counted, a data: PNG image included (the diagram page has no image exception); the render is refused', async () => {
    for (const rq of [req('https://evil.example/x', 'script'), req('data:image/png;base64,AAAA', 'image'), req('data:font/ttf;base64,AAAA', 'script')]) {
      const x = rig({ requestsDuringLoad: [rq] });
      await expect(x.r.renderDiagram(DP, 'flowchart TD\n A-->B')).rejects.toMatchObject({ code: 'failed' });
      expect(rq.abort).toHaveBeenCalled();
      expect(x.page.evaluate).not.toHaveBeenCalled();
    }
  });

  it('RF23: a syntax error text from the library is a bad_source refusal; the screenshot is never taken', async () => {
    const x = rig({ evalResult: { error: 'syntax error: Parse error on line 2' } });
    await expect(x.r.renderDiagram(DP, 'flowchart TD\n A-->(')).rejects.toMatchObject({ code: 'bad_source', message: expect.stringContaining('Parse error') });
    expect(x.page.screenshot).not.toHaveBeenCalled();
  });

  it('RF23: a diagram over 3000 px on a side is refused; a missing size is a bad_source', async () => {
    await expect(rig({ evalResult: { w: 3001, h: 100 } }).r.renderDiagram(DP, 'x')).rejects.toMatchObject({ code: 'too_large' });
    await expect(rig({ evalResult: null }).r.renderDiagram(DP, 'x')).rejects.toMatchObject({ code: 'bad_source' });
  });

  it('RF23: the PNG is capped at 768 KB: a big one is re-taken at a smaller scale, and refused when even 1x is too big; a non-PNG is refused', async () => {
    const big = Buffer.concat([PNG_OK, Buffer.alloc(800 * 1024)]);
    const x = rig({ shots: [big, big, PNG_OK] });
    const out = await x.r.renderDiagram(DP, 'x');
    expect(out.png.length).toBe(PNG_OK.length);
    expect(x.calls.filter((c) => c.startsWith('viewport')).map((c) => JSON.parse(c.slice(9)).deviceScaleFactor).filter(Boolean)).toEqual([1, 2, 1.5, 1]);
    await expect(rig({ shots: [big] }).r.renderDiagram(DP, 'x')).rejects.toMatchObject({ code: 'too_large' });
    await expect(rig({ shots: [Buffer.from('not a png at all')] }).r.renderDiagram(DP, 'x')).rejects.toMatchObject({ code: 'failed' });
  });

  it('RF23: the diagram page may not exceed 8 MB, and a page over the 15 s limit times out', async () => {
    const x = rig();
    await expect(x.r.renderDiagram({ ...DP, html: 'x'.repeat(8 * 1024 * 1024 + 1) }, 'x')).rejects.toMatchObject({ code: 'too_large' });
    expect(x.connect).not.toHaveBeenCalled();
    const slow = rig({ timeoutMs: 50, setContent: () => new Promise<void>(() => {}) });
    await expect(slow.r.renderDiagram(DP, 'x')).rejects.toMatchObject({ code: 'timeout' });
  });

  it('P4: the document path keeps scripts OFF and lets a slide load an embedded data:image/png (image request only); nothing else data: is allowed', async () => {
    const png = req('data:image/png;base64,iVBORw0KGgo=', 'image');
    const ok = rig({ requestsDuringLoad: [png] });
    await ok.r.renderPdf('<p>x</p>');
    expect(ok.calls[0]).toBe('js:false');
    expect(png.continue).toHaveBeenCalled();
    expect(ok.r.lastStray).toBe(0);
    for (const rq of [req('data:image/png;base64,AAAA', 'script'), req('data:image/svg+xml;base64,AAAA', 'image'), req('data:image/png,AAAA', 'image')]) {
      const x = rig({ requestsDuringLoad: [rq] });
      await expect(x.r.renderPdf('<p>x</p>')).rejects.toMatchObject({ code: 'failed' });
      expect(rq.abort).toHaveBeenCalled();
    }
  });
});
