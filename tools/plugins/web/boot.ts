import type { Env } from '../../../core/env.js';
import type { Logger } from '../../../core/index.js';
import type { WebBrowser } from './browser.js';
import { ChromeBrowser, httpProxyControl, type ProxyControl } from './chrome.js';

export type WebBoot = { browser?: WebBrowser; disabled?: string };

/** The Chrome and control endpoints are the container's published ports on this Mac: http, loopback address, a port, nothing else. */
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):(\d{2,5})$/;
export const loopbackUrl = (v: string | undefined): string | null => (v && LOOPBACK.test(v.replace(/\/+$/, '')) ? v.replace(/\/+$/, '') : null);

/**
 * Local mode (Gate 1 Part C, "Chrome only"): when CHROME_CDP_URL is configured, the web tools read pages through Chrome, and a Chrome
 * that is missing, too old or misconfigured turns the web group off (the startup alert in #bot-log says why). Nothing falls back
 * to plain HTTP. Without CHROME_* (the VPS, tests) the group keeps the guarded HTTP fetch.
 * `seam` replaces the real ChromeBrowser (tests).
 */
export async function bootWeb(env: Pick<Env, 'chrome'>, log: Pick<Logger, 'warn'>, seam?: { local?: boolean; control?: ProxyControl; connect?: ConstructorParameters<typeof ChromeBrowser>[0]['connect'] }): Promise<WebBoot> {
  const c = env.chrome;
  // G2C-07: on the owner's Mac (the local provider is allowed) the web tools are Chrome-only; a missing CHROME_* never means plain HTTP there.
  const local = seam?.local === true; // app.ts passes ALLOW_LOCAL_PROVIDERS=1 (set by dev.sh for the node child only)
  if (!c) return local ? { disabled: 'local mode needs Chrome: start it with npm run local:chrome and run the app with npm run dev (CHROME_CDP_URL is not set)' } : {};
  if (!c.token) return { disabled: 'CHROME_ACCESS_TOKEN is not set; run the app with npm run dev after npm run local:chrome' };
  const cdpUrl = loopbackUrl(c.cdpUrl);
  const controlUrl = loopbackUrl(c.controlUrl);
  if (!cdpUrl || !controlUrl) return { disabled: 'CHROME_CDP_URL and CHROME_PROXY_CONTROL_URL must both be set to http://127.0.0.1:<port>' };
  if (c.minVersion && !/^\d+\.\d+\.\d+\.\d+$/.test(c.minVersion)) return { disabled: 'CHROME_MIN_VERSION must look like 157.0.8103.27' };
  const browser = new ChromeBrowser({ cdpUrl, token: c.token, control: seam?.control ?? httpProxyControl(controlUrl, c.token), ...(c.minVersion ? { minVersion: c.minVersion } : {}), ...(seam?.connect ? { connect: seam.connect } : {}) });
  const r = await browser.check();
  if (!r.ok) {
    log.warn({ why: r.why }, 'chrome check failed; web group disabled');
    return { disabled: r.why };
  }
  browser.startMaintenance();
  return { browser };
}
