import http from 'node:http';
import https from 'node:https';
import { pathToFileURL } from 'node:url';
import { createRegistryProxy, type RegistryUpstream } from '../devjob/registryproxy.js';

/**
 * Entry point of the ws registry-proxy container (SA-1 C2). Same proxy as dev jobs (GET/HEAD of package documents and tarballs only, upstream fixed
 * to registry.npmjs.org, Authorization dropped), but a fresh handler every UTC hour with a 1 GiB cap: the shared handler counts bytes for the life of
 * the process and would start answering 429 after about ten fresh installs. There is no test upstream switch here (WS-C4: no UPSTREAM_URL).
 * devjob/ is not edited; this file imports it.
 */
export const HOUR_MS = 3_600_000;
export const HOURLY_MAX_BYTES = 1024 * 1024 * 1024;

export const upstream: RegistryUpstream = (r) => new Promise((resolve, reject) => {
  const req = https.request({ host: 'registry.npmjs.org', port: 443, method: r.method, path: r.path, headers: { ...r.headers, host: 'registry.npmjs.org' }, timeout: 120_000 }, (res: http.IncomingMessage) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') headers[k] = v;
    resolve({ status: res.statusCode ?? 502, headers, body: res });
  });
  req.on('error', reject);
  req.end();
});

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

/** A handler that is rebuilt (counter reset) each time the UTC hour changes. `make` gets the cap. */
export function hourlyHandler(make: (maxBytes: number) => Handler, now: () => number = Date.now): Handler {
  let hour = -1;
  let cur: Handler | null = null;
  return (req, res) => {
    const h = Math.floor(now() / HOUR_MS);
    if (!cur || h !== hour) {
      hour = h;
      cur = make(HOURLY_MAX_BYTES);
    }
    cur(req, res);
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  http.createServer(hourlyHandler((maxBytes) => createRegistryProxy({ upstream, maxBytes, log: (m) => console.log(m) }))).listen(Number(env.PROXY_PORT ?? 4873), '0.0.0.0');
  console.log('ws registry proxy up');
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => process.exit(0));
}
