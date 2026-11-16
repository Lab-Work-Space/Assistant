// Real Chrome, real guard proxy, hostile origin. Run by scripts/chrome-e2e.sh (needs dist/ built). Exit 1 on any failed check.
import { execFileSync } from 'node:child_process';
import { ChromeBrowser, httpProxyControl } from '../../dist/tools/plugins/web/chrome.js';

let last = null;
const TOKEN = process.env.CHROME_ACCESS_TOKEN;
const real = httpProxyControl('http://127.0.0.1:9223', TOKEN);
const control = { ...real, close: async (u) => (last = await real.close(u)) };
// The app-side pre-check is made blind on purpose (every name "resolves" to a dummy public address): only the proxy stands in the way.
const chrome = new ChromeBrowser({ cdpUrl: 'http://127.0.0.1:9222', token: TOKEN, control, resolver: async () => ['93.184.215.14'], timeoutMs: 10_000 });
let failed = 0;
const check = (name, pass, detail = '') => { console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); if (!pass) failed++; };
const run = async (url) => { const t0 = Date.now(); last = null; try { const r = await chrome.fetch(url); return { ok: true, r, ms: Date.now() - t0 }; } catch (e) { return { ok: false, e, ms: Date.now() - t0 }; } };

const base = await run('http://redir.test/ok');
check('a public page is read', base.ok && base.r.body.toString().includes('origin ok'));

for (const p of ['to-meta', 'to-loop', 'to-priv-https', 'to-v6', 'to-zero', 'to-short']) {
  const x = await run(`http://redir.test/${p}`);
  check(`redirect /${p} is blocked at the second hop`, !x.ok && x.e.code === 'blocked', x.ok ? 'was fetched' : x.e.message);
}

// Page-driven requests to private targets: iframe, fetch x2, WebSocket. Proxy counters are the evidence (the page-visible outcome of a
// refused request is an opaque 403 answer from the proxy, which says nothing about whether the target was contacted).
const probe = await run('http://redir.test/probe');
const result = [...(probe.r?.body.toString().matchAll(/PROBE-DONE ([^<'+]+)/g) ?? [])].pop()?.[1] ?? '';
check('WebRTC to a private STUN server: no server-reflexive/relay candidate, no extra proxied request', !/candidate (srflx|relay)/.test(result) && !result.includes('rtc threw'), result);
console.log('   probe:', [...(probe.r?.body.toString().matchAll(/PROBE-DONE ([^<'+]+)/g) ?? [])].pop()?.[1]);
check('probe page loads and its script finishes', probe.ok && /PROBE-DONE [^'+]/.test(probe.r.body.toString()));
check('iframe + 2x fetch + WebSocket + worker fetch to loopback/metadata were each refused by the proxy', last?.blocked === 5, JSON.stringify(last));

const endless = await run('http://redir.test/endless');
check('endless body: ends within the timeout, as an error', !endless.ok && endless.ms < 12_000, `${endless.ms} ms ${endless.ok ? '' : endless.e.message}`);
check('endless body: byte cap tripped at the proxy', last?.capped === true, JSON.stringify(last));
const many = await run('http://redir.test/many');
check('10,000 subrequests: ends within the timeout, as an error', !many.ok && many.ms < 12_000, `${many.ms} ms ${many.ok ? '' : many.e.message}`);
check('10,000 subrequests: reported as over the cap, and far fewer than 10,000 reached the proxy', !many.ok && /cap/.test(many.e.message) && (last?.requests ?? 0) <= 205, `${many.ok ? '' : many.e.message} ${JSON.stringify(last)}`);
const loop = await run('http://redir.test/loop');
check('infinite script loop: ends within the timeout, as an error', !loop.ok && loop.ms < 15_000, `${loop.ms} ms ${loop.ok ? '' : loop.e.message}`);

// G2C-03: nothing without the token can use the control API or Chrome's DevTools, even from the host loopback
const noTok = await fetch('http://127.0.0.1:9223/session', { method: 'POST' });
check('control API refuses a caller without the token', noTok.status === 401);
const noTokCdp = await fetch('http://127.0.0.1:9222/json/version').then((r) => r.status, () => 0);
check('DevTools forwarder refuses a caller without the token', noTokCdp === 401, String(noTokCdp));
// G2C-01: the proxy image carries no package manager and still runs node
const sh = (c) => { try { return execFileSync('docker', ['exec', 'chrome-e2e-guardproxy-1', 'sh', '-c', c], { encoding: 'utf8' }).trim(); } catch { return 'ERR'; } };
check('proxy image has no npm/npx/corepack/yarn, and node runs', sh('command -v npm npx corepack yarn || echo none') === 'none' && sh('node -e "console.log(1+1)"') === '2');
await new Promise((r) => setTimeout(r, 1500));
const top = execFileSync('docker', ['top', 'chrome-e2e-chrome-1'], { encoding: 'utf8' });
check('no renderer process survives', !/--type=renderer/.test(top), `${(top.match(/--type=renderer/g) ?? []).length} left`);
const after = await run('http://redir.test/ok');
check('Chrome still serves a normal page afterwards', after.ok);
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
