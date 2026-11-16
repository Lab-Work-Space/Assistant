import puppeteer, { type Browser, type BrowserContext, type HTTPRequest, type Page } from 'puppeteer-core';
import { SafeFetchError } from '../../../net/guard.js';
import { CHROME_PIN, compareVersions, Slots } from '../web/chrome.js';

/**
 * RF15 / RF16: the document render driver. It is NEW code, not `ChromeBrowser.read()` / `lockDown()`: documents are never rendered in the web Chrome.
 * The renderer is its own Chrome container on a network with no route (docker-compose.render.yml); this host-side driver reaches only its DevTools
 * forwarder (127.0.0.1, per-boot bearer token). Per call:
 *  - a fresh browser context with `proxyServer` set to a dead loopback address (a stray request fails even if the network did not), no proxy session is minted;
 *  - the page is loaded with `setContent` only (no goto, no file://, no http(s)), JavaScript OFF, every request aborted except the embedded `data:` font;
 *  - downloads denied, no permissions, popups closed, dialogs dismissed;
 *  - PDF through `Page.printToPDF` with transferMode ReturnAsStream, read under a byte cap (8 MB) and a page cap (30): over a cap is a refusal, never a cut;
 *  - a hard 20 s limit for the whole call.
 */

export interface DocRenderer {
  /** Renders `html` (a complete, code-built document) to a PDF. Throws RenderError. */
  renderPdf(html: string): Promise<{ pdf: Buffer; pages: number }>;
  /** RFMD P4 / RF23: renders checked Mermaid text to a PNG in a page of its own (the pinned bundle is the only script). Absent: diagram_create is off. */
  renderDiagram?(page: DiagramPage, source: string): Promise<{ png: Buffer; width: number; height: number }>;
}

/** The code-built diagram page (docs/diagram.ts buildDiagramPage) and the fixed Mermaid configuration, handed over by the tool. */
export type DiagramPage = { html: string; config: Readonly<Record<string, unknown>> };

export type RenderErrorCode = 'busy' | 'timeout' | 'too_large' | 'too_many_pages' | 'failed' | 'unavailable' | 'bad_source';
export class RenderError extends Error {
  constructor(readonly code: RenderErrorCode, message: string) {
    super(message);
    this.name = 'RenderError';
  }
}

export const PDF_MAX_BYTES = 8 * 1024 * 1024;
export const PDF_MAX_PAGES = 30;
export const RENDER_TIMEOUT_MS = 20_000;
const HTML_MAX_BYTES = 6 * 1024 * 1024; // P4: a deck may embed up to 5 diagram PNGs (docs/diagram.ts), each at most 768 KB
const DIAGRAM_HTML_MAX_BYTES = 8 * 1024 * 1024; // the inlined Mermaid bundle is about 5.5 MB
const DIAGRAM_PNG_CAP = 768 * 1024;
const DIAGRAM_MAX_SIDE = 3000;
const DIAGRAM_TIMEOUT_MS = 15_000;
export const RENDER_MAX_MESSAGE = 6 * 1024 * 1024;
const MAX_MESSAGE = RENDER_MAX_MESSAGE; // G2C-02: a DevTools message bigger than this drops the connection
const RECYCLE_MS = 2 * 60 * 60_000;
const CLOSE_WAIT_MS = 3000;
const DEAD_PROXY = 'http://127.0.0.1:1';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());

export type RendererOptions = {
  /** http://127.0.0.1:<port> of the renderer's DevTools forwarder. */
  cdpUrl: string;
  token: string;
  minVersion?: string;
  recycleEveryMs?: number;
  timeoutMs?: number;
  maxBytes?: number;
  maxPages?: number;
  maxConcurrent?: number;
  maxQueued?: number;
  /** Test seam: connects to the DevTools endpoint. */
  connect?: (cdpUrl: string) => Promise<Browser>;
};

/** Counts pages of a PDF from its page dictionaries (and the page tree's /Count as a cross-check). */
export function countPdfPages(pdf: Buffer): number {
  const s = pdf.toString('latin1');
  const dicts = (s.match(/\/Type\s*\/Page(?![A-Za-z])/g) ?? []).length;
  const counts = [...s.matchAll(/\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
  return Math.max(dicts, ...counts, 0);
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Runs in the diagram page: draws with the pinned Mermaid and returns the size, or a short error text (a syntax error of the model's text). */
const DRAW_DIAGRAM = async (src: string, cfg: Record<string, unknown>, maxSide: number): Promise<{ w: number; h: number } | { error: string }> => {
  const g = globalThis as unknown as { mermaid?: { initialize(c: unknown): void; render(id: string, t: string): Promise<{ svg: string }> } };
  if (!g.mermaid) return { error: 'the diagram library did not load' };
  try {
    // measure text with the real font, not a fallback (a fallback Thai font is wider and would push labels into a cut)
    await Promise.all([document.fonts.load('16px Sarabun', 'ก'), document.fonts.load('bold 16px Sarabun', 'ก')]).catch(() => undefined);
    g.mermaid.initialize(cfg);
    const r = await g.mermaid.render('dg-render', src);
    const out = document.getElementById('out');
    if (!out) return { error: 'the diagram page is broken' };
    out.innerHTML = r.svg;
    await document.fonts.ready;
    const svg = out.querySelector('svg');
    if (!svg) return { error: 'no diagram was drawn' };
    const vb = svg.viewBox && svg.viewBox.baseVal;
    const box = svg.getBoundingClientRect();
    const w = vb && vb.width > 0 ? vb.width : box.width;
    const h = vb && vb.height > 0 ? vb.height : box.height;
    if (!(w > 0 && h > 0)) return { error: 'the diagram is empty' };
    if (w > maxSide || h > maxSide) return { error: 'the diagram is too large (over ' + maxSide + ' px); make it smaller' };
    svg.style.maxWidth = 'none';
    svg.setAttribute('width', String(w));
    svg.setAttribute('height', String(h));
    return { w, h };
  } catch (e) {
    const m = e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e);
    return { error: 'syntax error: ' + m.replace(/\s+/g, ' ').slice(0, 240) };
  }
};

export class ChromeRenderer implements DocRenderer {
  private readonly slots: Slots;
  private stuck = 0;
  private active = 0;
  private restarting: Promise<void> | null = null;
  private lastRecycle = Date.now();
  /** Test visibility: the requests the last render saw that were not the embedded font (must stay 0). */
  lastStray = 0;

  constructor(private readonly o: RendererOptions) {
    this.slots = new Slots(o.maxConcurrent ?? 1, o.maxQueued ?? 4);
  }

  private connect(): Promise<Browser> {
    const headers = { authorization: `Bearer ${this.o.token}` };
    return (this.o.connect ?? ((u: string) => puppeteer.connect({ browserURL: u, defaultViewport: { width: 794, height: 1123 }, protocolTimeout: 15_000, wsOptions: { headers, maxPayload: MAX_MESSAGE } })))(this.o.cdpUrl);
  }

  /** The renderer is recycled on a schedule (default every 2 h) once idle, and after contexts that would not close; the container restart policy brings a fresh process. */
  startMaintenance(checkEveryMs = 60_000): NodeJS.Timeout {
    const t = setInterval(() => {
      const due = Date.now() - this.lastRecycle >= (this.o.recycleEveryMs ?? RECYCLE_MS) || this.stuck >= 2;
      if (due && this.active === 0 && !this.restarting) void this.recycle();
    }, checkEveryMs);
    t.unref();
    return t;
  }

  async recycle(): Promise<boolean> {
    if (this.active > 0 || this.restarting) return false;
    let done!: () => void;
    this.restarting = new Promise<void>((r) => (done = r));
    try {
      const b = await this.connect();
      await b.close().catch(() => undefined);
      await sleep(2000);
      for (let i = 0; i < 20; i++) {
        if ((await this.check()).ok) break;
        await sleep(1000);
      }
      this.stuck = 0;
      return true;
    } catch {
      return false;
    } finally {
      this.lastRecycle = Date.now();
      this.restarting = null;
      done();
    }
  }

  /** Boot check: the renderer answers and is at least the pinned Chrome version (C32). */
  async check(): Promise<{ ok: true; version: string } | { ok: false; why: string }> {
    let browser: Browser | undefined;
    try {
      browser = await this.connect();
      const version = await browser.version();
      let min = CHROME_PIN;
      if (this.o.minVersion && (compareVersions(this.o.minVersion, CHROME_PIN) ?? -1) > 0) min = this.o.minVersion;
      const cmp = compareVersions(version, min);
      if (cmp === null || cmp < 0) return { ok: false, why: `the document renderer's Chrome ${version} is older than the minimum ${min}; update the image pin in docker-compose.render.yml` };
      return { ok: true, version };
    } catch {
      return { ok: false, why: 'the document renderer does not answer (start it with: npm run local:render)' };
    } finally {
      await browser?.disconnect().catch(() => undefined);
    }
  }

  async renderPdf(html: string): Promise<{ pdf: Buffer; pages: number }> {
    if (Buffer.byteLength(html, 'utf8') > HTML_MAX_BYTES) throw new RenderError('too_large', 'the document is too large to render');
    return this.session(Math.min(this.o.timeoutMs ?? RENDER_TIMEOUT_MS, RENDER_TIMEOUT_MS), (b, ctx, timeoutMs) => this.render(b, ctx, html, timeoutMs));
  }

  /**
   * One call, one fresh context (dead proxy), one slot, a hard deadline; the context is closed and counted as stuck when it will not close.
   * Shared by the PDF path (scripts off) and the diagram path (only the pinned bundle runs).
   */
  private async session<T>(timeoutMs: number, fn: (b: Browser, ctx: BrowserContext, timeoutMs: number) => Promise<T>): Promise<T> {
    if (this.stuck >= 2) throw new RenderError('unavailable', 'the document renderer is unavailable (it did not shut a page down); restart it with: npm run local:render');
    if (this.restarting) await this.restarting;
    const release = await this.slots.take().catch(() => {
      throw new RenderError('busy', 'the document renderer is busy, try again later');
    });
    this.active++;
    let browser: Browser | undefined;
    let ctx: BrowserContext | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      browser = await this.connect().catch(() => {
        throw new RenderError('unavailable', 'the document renderer is unavailable');
      });
      const b = browser;
      const deadline = new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new RenderError('timeout', 'rendering timed out')), timeoutMs);
      });
      deadline.catch(() => undefined);
      const work = (async () => {
        ctx = await b.createBrowserContext({ proxyServer: DEAD_PROXY });
        return fn(b, ctx, timeoutMs);
      })();
      work.catch(() => undefined);
      try {
        return await Promise.race([work, deadline]);
      } catch (err) {
        throw err instanceof RenderError ? err : err instanceof SafeFetchError ? new RenderError('failed', err.message) : new RenderError('failed', 'rendering failed');
      }
    } finally {
      clearTimeout(timer);
      if (ctx) {
        const closed = await Promise.race([ctx.close().then(() => true, () => false), sleep(CLOSE_WAIT_MS).then(() => false)]);
        this.stuck = closed ? 0 : this.stuck + 1;
      }
      await browser?.disconnect().catch(() => undefined);
      this.active--;
      release();
    }
  }

  /**
   * RF23: Mermaid text to PNG. Same lock-down as documents (fresh context on a dead proxy, every request aborted and counted, no downloads, no permissions,
   * popups and dialogs closed) except that scripts are ON, and the only script that can run is the pinned bundle inlined in `page.html` (the page's CSP
   * allows exactly its hash). The text travels as an `evaluate` argument, never inside the HTML. The result is a screenshot of the drawn diagram under a
   * size cap; the SVG never leaves the page (RF26: PNG only).
   */
  async renderDiagram(page: DiagramPage, source: string): Promise<{ png: Buffer; width: number; height: number }> {
    if (Buffer.byteLength(page.html, 'utf8') > DIAGRAM_HTML_MAX_BYTES) throw new RenderError('too_large', 'the diagram page is too large to render');
    return this.session(Math.min(this.o.timeoutMs ?? DIAGRAM_TIMEOUT_MS, DIAGRAM_TIMEOUT_MS), (b, ctx, timeoutMs) => this.drawDiagram(b, ctx, page, source, timeoutMs));
  }

  private async drawDiagram(browser: Browser, ctx: BrowserContext, dp: DiagramPage, source: string, timeoutMs: number): Promise<{ png: Buffer; width: number; height: number }> {
    const page = await ctx.newPage();
    const seen = { stray: 0 };
    this.lastStray = 0;
    await this.lockDown(browser, ctx, page, seen, { js: true });
    await page.setViewport({ width: 1200, height: 900, deviceScaleFactor: 1 });
    await page.setContent(dp.html, { waitUntil: 'load', timeout: Math.max(1000, timeoutMs - 5000) });
    if (seen.stray > 0) throw new RenderError('failed', 'the diagram page tried to load a resource');
    const drawn = (await page.evaluate(DRAW_DIAGRAM, source, dp.config as Record<string, unknown>, DIAGRAM_MAX_SIDE)) as { error: string } | { w: number; h: number } | null;
    if (seen.stray > 0) throw new RenderError('failed', 'the diagram page tried to load a resource');
    if (!drawn || 'error' in drawn) throw new RenderError('bad_source', drawn && 'error' in drawn ? drawn.error : 'the diagram could not be drawn');
    const w = Math.ceil(drawn.w) + 32;
    const h = Math.ceil(drawn.h) + 32;
    if (!(w > 32 && h > 32) || w > DIAGRAM_MAX_SIDE + 32 || h > DIAGRAM_MAX_SIDE + 32) throw new RenderError('too_large', 'the diagram is too large; make it smaller');
    const cap = Math.min(this.o.maxBytes ?? DIAGRAM_PNG_CAP, DIAGRAM_PNG_CAP);
    for (const scale of [2, 1.5, 1]) {
      await page.setViewport({ width: w, height: h, deviceScaleFactor: scale });
      const shot = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: w, height: h }, captureBeyondViewport: false });
      const png = Buffer.from(shot);
      if (png.length <= cap) {
        if (!png.subarray(0, 8).equals(PNG_MAGIC)) throw new RenderError('failed', 'the renderer did not produce a PNG');
        if (seen.stray > 0) throw new RenderError('failed', 'the diagram page tried to load a resource');
        return { png, width: w, height: h };
      }
    }
    throw new RenderError('too_large', `the diagram image is larger than ${Math.floor(cap / 1024)} KB; make it simpler`);
  }

  private async render(browser: Browser, ctx: BrowserContext, html: string, timeoutMs: number): Promise<{ pdf: Buffer; pages: number }> {
    const page = await ctx.newPage();
    const seen = { stray: 0 };
    this.lastStray = 0;
    await this.lockDown(browser, ctx, page, seen);
    await page.setContent(html, { waitUntil: 'load', timeout: Math.max(1000, timeoutMs - 4000) });
    if (seen.stray > 0) throw new RenderError('failed', 'the document tried to load a resource');
    // waitForFonts would evaluate script in the page, which is off; the fonts are data: URLs decoded before `load`.
    const stream = await page.createPDFStream({ format: 'A4', preferCSSPageSize: true, printBackground: true, waitForFonts: false, timeout: timeoutMs - 1000 });
    const pdf = await this.readCapped(stream);
    if (seen.stray > 0) throw new RenderError('failed', 'the document tried to load a resource');
    const pages = countPdfPages(pdf);
    if (pages > (this.o.maxPages ?? PDF_MAX_PAGES)) throw new RenderError('too_many_pages', `the document is longer than ${this.o.maxPages ?? PDF_MAX_PAGES} pages`);
    if (pages < 1 || !pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new RenderError('failed', 'the renderer did not produce a PDF');
    return { pdf, pages };
  }

  /** Reads the stream chunk by chunk; the cap is checked as bytes arrive, and over it the stream is cancelled (a refusal, never a truncated file). */
  private async readCapped(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
    const cap = this.o.maxBytes ?? PDF_MAX_BYTES;
    const reader = stream.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > cap) {
          await reader.cancel().catch(() => undefined);
          throw new RenderError('too_large', `the PDF is larger than ${Math.floor(cap / 1024 / 1024)} MB`);
        }
        chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      }
    } finally {
      reader.releaseLock?.();
    }
    return Buffer.concat(chunks, total);
  }

  /** RF16: scripts off (on only for the diagram page, RF23), downloads denied, no permissions, popups and dialogs closed, every request aborted (the embedded font excepted). Fail closed. */
  private async lockDown(browser: Browser, ctx: BrowserContext, page: Page, seen: { stray: number }, o: { js: boolean } = { js: false }): Promise<void> {
    const cdp = await browser.target().createCDPSession();
    const scope = ctx.id ? { browserContextId: ctx.id } : {};
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny', ...scope });
    await cdp.send('Browser.grantPermissions', { permissions: [], ...scope });
    await cdp.detach().catch(() => undefined);
    await page.setJavaScriptEnabled(o.js);
    await page.setBypassServiceWorker(true);
    await page.setRequestInterception(true);
    page.on('request', (req: HTTPRequest) => {
      const url = req.url();
      // the only thing a document may load is its own embedded font; anything else is aborted AND counted (the render then fails)
      const embeddedFont = /^data:font\//i.test(url) && req.resourceType() === 'font';
      // P4 / RF23: a slide embeds the diagram PNGs the code holds as `data:image/png;base64` (an image request only; nothing else is a `data:` exception).
      // The diagram page never embeds one, and its scripts are on, so it gets no image exception.
      const embeddedPng = !o.js && /^data:image\/png;base64,/i.test(url) && req.resourceType() === 'image';
      const allowed = embeddedFont || embeddedPng;
      if (!allowed && !/^about:blank$/i.test(url)) {
        seen.stray++;
        this.lastStray = seen.stray;
      }
      void (allowed ? req.continue() : req.abort('blockedbyclient')).catch(() => undefined);
    });
    page.on('dialog', (d) => void d.dismiss().catch(() => undefined));
    ctx.on('targetcreated', (t) => {
      if (t.type() === 'page' && t !== page.target()) void t.page().then((p) => p?.close()).catch(() => undefined);
    });
  }
}
