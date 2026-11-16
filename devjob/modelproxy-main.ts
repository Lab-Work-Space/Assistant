import http from 'node:http';
import https from 'node:https';
import { inCidr } from '../net/proxy.js';
import { createModelProxy, httpsUpstream, type Price, type Upstream } from './modelproxy.js';

/**
 * Entry point of the model-proxy container (docker/devjob/modelproxy.Dockerfile, Gate 1 self-code X1). The only process that holds the dev-job key.
 *   DEVJOB_ANTHROPIC_API_KEY  the key (this container only; its own Anthropic Console workspace with a spend limit is the owner backstop)
 *   CONTROL_TOKEN             bearer token (>= 32 chars) of the control API
 *   PRICES_JSON               {"<model>":{"inUsd":..,"outUsd":..}} USD per million tokens; the keys are the model allowlist
 *   MONTHLY_CAP_USD           the monthly cap, set here and not by any caller (0 refuses everything)
 *   INTERNAL_CIDR             the agent network; the control API refuses callers from it
 *   PROXY_PORT (8080) CONTROL_PORT (8788) LEDGER_PATH (/data/ledger.json) MAX_TOKENS_CAP (16000)
 *   UPSTREAM_URL              default https://api.anthropic.com; http:// only with UPSTREAM_ALLOW_HTTP=1 (tests with a fake upstream)
 */
const env = process.env;
const key = env.DEVJOB_ANTHROPIC_API_KEY ?? '';
const token = env.CONTROL_TOKEN ?? '';
const internal = env.INTERNAL_CIDR ?? '';
if (key.length < 20 || token.length < 32 || !internal) {
  console.error('DEVJOB_ANTHROPIC_API_KEY, CONTROL_TOKEN (>= 32 chars) and INTERNAL_CIDR are required');
  process.exit(1);
}
let prices: Record<string, Price> = {};
try { prices = JSON.parse(env.PRICES_JSON ?? '{}') as Record<string, Price>; } catch { /* checked below */ }
if (Object.keys(prices).length === 0 || Object.values(prices).some((p) => !(p.inUsd > 0) || !(p.outUsd > 0))) {
  console.error('PRICES_JSON must name at least one model with positive inUsd and outUsd');
  process.exit(1);
}
const up = new URL(env.UPSTREAM_URL ?? 'https://api.anthropic.com');
let upstream: Upstream;
if (up.protocol === 'https:') upstream = httpsUpstream(up.hostname, https.request);
else if (up.protocol === 'http:' && env.UPSTREAM_ALLOW_HTTP === '1') {
  upstream = (r) => new Promise((resolve, reject) => {
    const req = http.request({ host: up.hostname, port: Number(up.port || 80), method: r.method, path: r.path, headers: { ...r.headers, 'content-length': String(r.body.length) } }, (res) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') headers[k] = v;
      resolve({ status: res.statusCode ?? 502, headers, body: res });
    });
    req.on('error', reject);
    req.end(r.body);
  });
} else { console.error('UPSTREAM_URL must be https (http only for tests)'); process.exit(1); }

const monthly = Number(env.MONTHLY_CAP_USD);
if (!Number.isFinite(monthly) || monthly < 0) { console.error('MONTHLY_CAP_USD is required (0 refuses everything)'); process.exit(1); }
const proxy = createModelProxy({ upstream, apiKey: () => key, prices, monthlyCapUsd: monthly, maxTokensCap: Number(env.MAX_TOKENS_CAP ?? 16000), ledgerPath: env.LEDGER_PATH ?? '/data/ledger.json', log: (m) => console.log(m) });
http.createServer(proxy.handler).listen(Number(env.PROXY_PORT ?? 8080), '0.0.0.0');
http.createServer(proxy.controlHandler(token, (remote) => !inCidr(remote, internal))).listen(Number(env.CONTROL_PORT ?? 8788), '0.0.0.0');
console.log('model proxy up');
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => process.exit(0));
