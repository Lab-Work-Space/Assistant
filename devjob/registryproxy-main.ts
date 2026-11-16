import http from 'node:http';
import https from 'node:https';
import { createRegistryProxy, type RegistryUpstream } from './registryproxy.js';

/** Entry point of the registry-proxy container (Gate 1 self-code X3). Upstream is fixed to registry.npmjs.org; UPSTREAM_URL (http, loopback or compose name) exists for tests only. */
const env = process.env;
const test = env.UPSTREAM_URL && env.UPSTREAM_ALLOW_HTTP === '1' ? new URL(env.UPSTREAM_URL) : null;
const upstream: RegistryUpstream = (r) => new Promise((resolve, reject) => {
  const done = (res: http.IncomingMessage) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') headers[k] = v;
    resolve({ status: res.statusCode ?? 502, headers, body: res });
  };
  const req = test
    ? http.request({ host: test.hostname, port: Number(test.port || 80), method: r.method, path: r.path, headers: r.headers }, done)
    : https.request({ host: 'registry.npmjs.org', port: 443, method: r.method, path: r.path, headers: { ...r.headers, host: 'registry.npmjs.org' }, timeout: 120_000 }, done);
  req.on('error', reject);
  req.end();
});
http.createServer(createRegistryProxy({ upstream, log: (m) => console.log(m) })).listen(Number(env.PROXY_PORT ?? 4873), '0.0.0.0');
console.log('registry proxy up');
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => process.exit(0));
