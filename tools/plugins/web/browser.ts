import { safeFetch, SafeFetchError, type Resolver, type SafeFetchResult, type Transport } from '../../../net/guard.js';

/**
 * The page-reading port of the web tools (`fetch_page`, `web_search`, watch fetches). Local mode backs it with headless Chrome in
 * a container (chrome.ts, Gate 1 Part C). Without a browser the group keeps the guarded HTTP fetch (the VPS, and tests): that
 * path is chosen only by the absence of a browser, never as a fallback after a Chrome failure.
 */
export interface WebBrowser {
  /** Renders `url` and returns the final document: DOM html for html pages, raw text for other text types. Throws SafeFetchError. */
  fetch(url: string): Promise<SafeFetchResult>;
}

/** What the web tools need. `browser` set: every read goes through it and `resolver`/`transport` are not used. */
export type WebNetOptions = { resolver: Resolver; transport: Transport; extraPorts: () => number[]; browser?: WebBrowser };

/** Per-read limits for the HTTP path (SEARCH-1). The browser path ignores them: Chrome has its own fixed timeout, headers and size caps. */
export type ReadOpts = { allowHosts?: readonly string[]; timeoutMs?: number; maxBytes?: number; headers?: Record<string, string> };

/** One guarded read of `url`: through the browser when there is one, else over guarded HTTP. `opts` apply to the HTTP path only. */
export function readPage(o: WebNetOptions, url: string, opts?: ReadOpts): Promise<SafeFetchResult> {
  return o.browser ? o.browser.fetch(url) : safeFetch(url, { resolver: o.resolver, transport: o.transport, extraPorts: o.extraPorts(), ...(opts ?? {}) });
}

/** A browser that is known to be unavailable (boot check failed): every read fails closed, nothing goes over HTTP. */
export const unavailableBrowser = (): WebBrowser => ({
  fetch: () => Promise.reject(new SafeFetchError('failed', 'the browser is unavailable')),
});
