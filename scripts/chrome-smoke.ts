import { SafeFetchError } from '../net/guard.js';
import { bootWeb } from '../tools/plugins/web/boot.js';
import { ChromeBrowser, httpProxyControl } from '../tools/plugins/web/chrome.js';
import { ddgBackend } from '../tools/plugins/web/webSearch.js';
import { unavailableBrowser } from '../tools/plugins/web/browser.js';

/**
 * Gate 2 probe for Part C, run by the owner after `npm run local:chrome`:  npm run build && node dist/scripts/chrome-smoke.js
 * Needs the container up and internet access. It drives the real Chrome through the real guard proxy: one search, one page read, and
 * the refusals (loopback, link-local metadata, a public name that resolves to loopback). Redirects to private targets need an origin you control and
 * are covered by net/proxy.net.test.ts (each hop is its own checked request).
 * It reads no env file and prints no secrets. Exit code 1 when any check fails.
 */
const CDP = process.env.CHROME_CDP_URL ?? 'http://127.0.0.1:9222';
const CONTROL = process.env.CHROME_PROXY_CONTROL_URL ?? 'http://127.0.0.1:9223';
const TOKEN = process.env.CHROME_ACCESS_TOKEN ?? '';
const log = { warn: (o: unknown, m?: string) => console.warn(m ?? '', JSON.stringify(o)) };
let failed = 0;
const ok = (name: string, pass: boolean, detail = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!pass) failed++;
};

const boot = await bootWeb({ chrome: { cdpUrl: CDP, controlUrl: CONTROL, token: TOKEN } }, log);
if (!boot.browser) {
  console.error(`FAIL  boot: ${boot.disabled}`);
  process.exit(1);
}
const browser = boot.browser;
ok('boot check (proxy answers, Chrome is current)', true);

try {
  const hits = await ddgBackend({ resolver: async () => [], transport: unavailableTransport(), extraPorts: () => [], browser }).search('example domain iana', 5);
  ok('web_search through Chrome', hits.length > 0, `${hits.length} hits, first: ${hits[0]?.url ?? '-'}`);
} catch (e) {
  ok('web_search through Chrome', false, e instanceof Error ? e.message : 'error');
}
try {
  const r = await browser.fetch('https://example.com/');
  ok('fetch_page through Chrome', r.status === 200 && r.body.toString().includes('Example Domain'), `${r.status} ${r.finalUrl}`);
} catch (e) {
  ok('fetch_page through Chrome', false, e instanceof Error ? e.message : 'error');
}

const blockedUrls = [
  'http://127.0.0.1/', 'http://127.0.0.1:9223/healthz', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://localhost/',
];
for (const u of blockedUrls) {
  const err = await browser.fetch(u).then(() => null, (e: unknown) => e);
  ok(`blocked: ${u}`, err instanceof SafeFetchError && err.code === 'blocked', err instanceof Error ? err.message : 'was fetched');
}

// A public-looking name that resolves to loopback: the app-side pre-check is made blind on purpose, so only the proxy can stop it.
const blind = new ChromeBrowser({ cdpUrl: CDP, token: TOKEN, control: httpProxyControl(CONTROL, TOKEN), resolver: async () => ['93.184.215.14'] });
for (const u of ['http://localtest.me/', 'https://localtest.me/']) {
  const err = await blind.fetch(u).then(() => null, (e: unknown) => e);
  ok(`proxy blocks a name that resolves to loopback (${u})`, err instanceof SafeFetchError && err.code === 'blocked', err instanceof Error ? err.message : 'was fetched');
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);

function unavailableTransport() {
  return (() => Promise.reject(new Error('the HTTP path must not be used'))) as never;
}
