import puppeteer, { type Browser, type BrowserContext, type HTTPRequest, type Page } from 'puppeteer-core';
import { checkUrl, MAX_BYTES, SafeFetchError, type SafeFetchResult } from '../../../net/guard.js';
import type { Caps, Session, SessionStats } from '../../../net/proxy.js';
import { systemResolver } from '../../../net/system.js';
import type { WebBrowser } from './browser.js';

/**
 * Chrome-backed page reads (Gate 1 Part C). Chrome runs in a container (docker-compose.chrome.yml) whose only route out is the guard
 * proxy (net/proxy.ts); this class is the host-side driver: it mints a per-call proxy credential, opens a fresh browser context,
 * navigates, extracts the DOM, and always tears the context and the credential down. Request interception here is defence in depth
 * only (C24): the proxy is the control.
 */

export interface ProxyControl {
  open(): Promise<Session>;
  /** Ends the session and returns its counters (null when it is already gone). */
  close(user: string): Promise<SessionStats | null>;
  health(): Promise<void>;
}

/** The control API of the guard-proxy container (published on the host's 127.0.0.1 only). */
export function httpProxyControl(baseUrl: string, token: string, fetchFn: typeof fetch = fetch): ProxyControl {
  const call = async (method: string, path: string): Promise<Response> =>
    fetchFn(`${baseUrl}${path}`, { method, headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
  return {
    async open() {
      const r = await call('POST', '/session');
      if (!r.ok) throw new Error(`proxy control answered ${r.status}`);
      const j = (await r.json()) as Session;
      if (typeof j.user !== 'string' || typeof j.pass !== 'string') throw new Error('proxy control answered an unexpected body');
      return { user: j.user, pass: j.pass };
    },
    async close(user) {
      const r = await call('DELETE', `/session/${encodeURIComponent(user)}`);
      return r.ok ? ((await r.json()) as SessionStats) : null;
    },
    async health() {
      const r = await call('GET', '/healthz');
      if (!r.ok) throw new Error(`proxy control answered ${r.status}`);
    },
  };
}

export type ChromeOptions = {
  /** http://127.0.0.1:9222 (the proxy container's published DevTools forwarder). */
  cdpUrl: string;
  /** Per-boot bearer token the DevTools forwarder requires (G2C-03). */
  token?: string;
  control: ProxyControl;
  /** The port allow-list the proxy enforces too (this side only pre-checks). */
  extraPorts?: () => number[];
  /** Lowest accepted Chrome version "157.0.8103.27" (C32); never lower than CHROME_PIN. */
  minVersion?: string;
  recycleEveryMs?: number;
  timeoutMs?: number;
  idleCapMs?: number;
  maxConcurrent?: number;
  maxQueued?: number;
  /** Test seam: connects to the DevTools endpoint. */
  connect?: (cdpUrl: string) => Promise<Browser>;
  resolver?: typeof systemResolver;
  caps?: Partial<Caps>;
};

/** The Chrome build the image pin in docker-compose.chrome.yml ships. Bump with the digest (docker/chrome/README.md). Older builds are refused. */
export const CHROME_PIN = '157.0.8103.27';
const MAX_MESSAGE = 6 * 1024 * 1024; // G2C-02: a DevTools message bigger than this drops the connection (puppeteer's default is 256 MiB)
const RECYCLE_MS = 6 * 60 * 60_000;

const parts = (v: string): number[] | null => {
  const m = /(\d+)\.(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? m.slice(1).map(Number) : null;
};
/** <0, 0, >0 like a comparator; null when either side is not a four-part version. */
export function compareVersions(a: string, b: string): number | null {
  const x = parts(a);
  const y = parts(b);
  if (!x || !y) return null;
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}
const TIMEOUT_MS = 25_000;
const IDLE_CAP_MS = 4000;
const CLOSE_WAIT_MS = 3000;
const MAX_REQUESTS = 200; // same default as the proxy's per-call request cap (C27)
const BLOCKED_TYPES = new Set(['image', 'media', 'font']);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());

/** Counting semaphore with a bounded queue (C27 concurrency cap). */
export class Slots {
  private free: number;
  private readonly waiting: (() => void)[] = [];
  constructor(n: number, private readonly maxQueued: number) {
    this.free = n;
  }
  async take(): Promise<() => void> {
    if (this.free > 0) this.free--;
    else {
      if (this.waiting.length >= this.maxQueued) throw new SafeFetchError('failed', 'the browser is busy, try again later');
      await new Promise<void>((r) => this.waiting.push(r));
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.free++;
    };
  }
}

const TEXTUAL = /^(text\/(plain|csv|markdown|xml)|application\/(json|xml|[\w.-]+\+(json|xml)))$/;

export class ChromeBrowser implements WebBrowser {
  private readonly slots: Slots;
  private stuck = 0;
  private active = 0;
  private restarting: Promise<void> | null = null;
  private lastRecycle = Date.now();
  constructor(private readonly o: ChromeOptions) {
    this.slots = new Slots(o.maxConcurrent ?? 2, o.maxQueued ?? 8);
  }

  private connect(): Promise<Browser> {
    const headers: Record<string, string> = this.o.token ? { authorization: `Bearer ${this.o.token}` } : {};
    return (this.o.connect ?? ((u: string) => puppeteer.connect({ browserURL: u, defaultViewport: { width: 1280, height: 900 }, protocolTimeout: 15_000, wsOptions: { headers, maxPayload: MAX_MESSAGE } })))(this.o.cdpUrl);
  }

  /**
   * C27/C30 compensation for one long-lived Chrome: every `recycleEveryMs` (default 6 h), once idle, and after contexts that would not close,
   * Chrome is told to exit; the container's restart policy brings up a fresh process with an empty profile. Calls made meanwhile wait for it.
   */
  startMaintenance(checkEveryMs = 60_000): NodeJS.Timeout {
    const t = setInterval(() => {
      const due = Date.now() - this.lastRecycle >= (this.o.recycleEveryMs ?? RECYCLE_MS) || this.stuck >= 3;
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

  /** Boot check: proxy control answers, Chrome answers and is at least the minimum major version (C32). */
  async check(): Promise<{ ok: true; version: string } | { ok: false; why: string }> {
    try {
      await this.o.control.health();
    } catch {
      return { ok: false, why: 'the Chrome guard proxy does not answer (start it with: npm run local:chrome)' };
    }
    let browser: Browser | undefined;
    try {
      browser = await this.connect();
      const version = await browser.version();
      let min = CHROME_PIN;
      if (this.o.minVersion && (compareVersions(this.o.minVersion, CHROME_PIN) ?? -1) > 0) min = this.o.minVersion;
      const cmp = compareVersions(version, min);
      if (cmp === null || cmp < 0) return { ok: false, why: `Chrome ${version} is older than the minimum ${min}; update the image pin in docker-compose.chrome.yml` };
      return { ok: true, version };
    } catch {
      return { ok: false, why: 'Chrome does not answer on the DevTools port (start it with: npm run local:chrome)' };
    } finally {
      await browser?.disconnect().catch(() => undefined);
    }
  }

  async fetch(rawUrl: string): Promise<SafeFetchResult> {
    // Early, cheap refusal with the same check the proxy applies (scheme, port, host name, resolved addresses). The proxy re-checks.
    const { url } = await checkUrl(rawUrl, { resolver: this.o.resolver ?? systemResolver, extraPorts: this.o.extraPorts?.() ?? [] });
    if (this.stuck >= 3) throw new SafeFetchError('failed', 'the browser is unavailable (it did not shut a page down); restart it with: npm run local:chrome');
    if (this.restarting) await this.restarting;
    const release = await this.slots.take();
    this.active++;
    const timeoutMs = this.o.timeoutMs ?? TIMEOUT_MS;
    let session: Session | null = null;
    let stats: SessionStats | null = null;
    let browser: Browser | undefined;
    let ctx: BrowserContext | undefined;
    let timer: NodeJS.Timeout | undefined;
    const endSession = async (): Promise<SessionStats | null> => {
      if (stats === null && session) stats = await this.o.control.close(session.user).catch(() => null);
      return stats;
    };
    try {
      session = await this.o.control.open().catch(() => {
        throw new SafeFetchError('failed', 'the Chrome guard proxy is unavailable');
      });
      browser = await this.connect().catch(() => {
        throw new SafeFetchError('failed', 'Chrome is unavailable');
      });
      const b = browser;
      const s = session;
      const deadline = new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new SafeFetchError('timeout', 'the fetch timed out')), timeoutMs);
      });
      deadline.catch(() => undefined);
      const work = (async () => {
        ctx = await b.createBrowserContext();
        return this.read(b, ctx, url.href, s);
      })();
      work.catch(() => undefined);
      try {
        const res = await Promise.race([work, deadline]);
        // C27: the caps are counted at the proxy; a page that went over them is an error even when its document loaded
        const st = await endSession();
        if (st?.capped) throw new SafeFetchError('failed', 'the page went over the size or request cap');
        return res;
      } catch (err) {
        const st = await endSession();
        throw this.classify(err, st);
      }
    } finally {
      clearTimeout(timer);
      await endSession();
      if (ctx) {
        const closed = await Promise.race([ctx.close().then(() => true, () => false), sleep(CLOSE_WAIT_MS).then(() => false)]);
        this.stuck = closed ? 0 : this.stuck + 1;
      }
      await browser?.disconnect().catch(() => undefined);
      this.active--;
      release();
    }
  }

  private classify(err: unknown, st: SessionStats | null): SafeFetchError {
    if (err instanceof SafeFetchError) return err;
    if (st?.blocked) return new SafeFetchError('blocked', 'refused: the address is not allowed');
    if (st?.capped) return new SafeFetchError('failed', 'the page went over the size or request cap');
    if (err instanceof Error && err.name === 'TimeoutError') return new SafeFetchError('timeout', 'the fetch timed out');
    return new SafeFetchError('failed', 'the request failed');
  }

  private async read(browser: Browser, ctx: BrowserContext, url: string, session: Session): Promise<SafeFetchResult> {
    const page = await ctx.newPage();
    const seen = { requests: 0, over: false };
    await this.lockDown(browser, ctx, page, seen);
    await page.authenticate({ username: session.user, password: session.pass });
    const ua = (await browser.userAgent()).replace('HeadlessChrome', 'Chrome');
    await page.setUserAgent({ userAgent: ua });
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: (this.o.timeoutMs ?? TIMEOUT_MS) - 2000 }).catch((err: unknown) => {
      // a download (pdf, zip...) is denied and aborts the navigation; the type is not text either way
      if (err instanceof Error && /ERR_ABORTED/.test(err.message)) throw new SafeFetchError('failed', 'the page is not displayable text');
      throw err;
    });
    if (!response) throw new SafeFetchError('failed', 'no response');
    const headers = response.headers();
    if (headers['x-guard-blocked']) throw new SafeFetchError('blocked', 'refused: the address is not allowed');
    await page.waitForNetworkIdle({ idleTime: 500, timeout: this.o.idleCapMs ?? IDLE_CAP_MS }).catch(() => undefined);
    if (seen.over) throw new SafeFetchError('failed', 'the page went over the size or request cap');
    // a script or meta refresh that sent the page to a refused or unreachable target leaves Chrome's error page behind
    if (/^chrome-error:/i.test(page.url())) throw new Error('the page navigated to an error page');
    const contentType = headers['content-type'] ?? '';
    const type = contentType.split(';')[0]!.trim().toLowerCase();
    let text = '';
    // G2C-02: cut inside the page, so a DOM grown by script never crosses DevTools whole (one extra character tells us it was cut)
    if (type === '' || type.includes('html')) text = await page.evaluate((n: number) => { const s = document.documentElement?.outerHTML ?? ''; return s.length > n ? s.slice(0, n + 1) : s; }, MAX_BYTES);
    else if (TEXTUAL.test(type)) text = await response.text().catch(() => '');
    const buf = Buffer.from(text, 'utf8');
    const truncated = buf.length >= MAX_BYTES;
    return { finalUrl: new URL(page.url()).href.replace(/#.*$/, ''), status: response.status(), contentType, headers: {}, body: truncated ? buf.subarray(0, MAX_BYTES) : buf, truncated };
  }

  /** C26: http(s) only, no downloads, no permissions, no popups, no dialogs, no service workers, no images/media/fonts. */
  private async lockDown(browser: Browser, ctx: BrowserContext, page: Page, seen: { requests: number; over: boolean }): Promise<void> {
    const cdp = await browser.target().createCDPSession();
    const id = ctx.id;
    const scope = id ? { browserContextId: id } : {};
    // fail closed (G2C-05): if Chrome refuses either control the read does not go ahead
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny', ...scope });
    await cdp.send('Browser.grantPermissions', { permissions: [], ...scope }); // nothing is granted: geolocation, notifications, clipboard, camera, mic stay refused
    await cdp.detach().catch(() => undefined);
    await page.setBypassServiceWorker(true);
    await page.setRequestInterception(true);
    page.on('request', (req: HTTPRequest) => {
      const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(req.url())?.[1]?.toLowerCase();
      // the proxy counts too; counting here as well stops a page that fires thousands of requests from queueing them all through DevTools
      if (++seen.requests > (this.o.caps?.maxRequests ?? MAX_REQUESTS)) seen.over = true;
      const ok = !seen.over && (scheme === 'http' || scheme === 'https') && !BLOCKED_TYPES.has(req.resourceType());
      void (ok ? req.continue() : req.abort('blockedbyclient')).catch(() => undefined);
    });
    page.on('dialog', (d) => void d.dismiss().catch(() => undefined));
    ctx.on('targetcreated', (t) => {
      if (t.type() === 'page' && t !== page.target()) void t.page().then((p) => p?.close()).catch(() => undefined);
    });
  }
}
