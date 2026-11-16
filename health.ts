import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * `provider`: whether provider.default is registered in this process (Gate 1 L9); reported, not a 503. `offDay`: today is an off day
 * (automated work waits); `offDayReason` says why, never the holiday name.
 */
export type HealthStatus = { db: 'ok' | 'error'; clients: string[]; halted: boolean; provider?: 'ok' | 'unavailable'; offDay?: boolean; offDayReason?: 'weekday' | 'holiday' | 'workday'; /** Gate 1 self-code X18: the commit this build was made from (from the release record), so the executor can tell which code is serving. */ build?: string };

export interface HealthServer {
  address(): { host: string; port: number };
  url(): string;
  close(): Promise<void>;
}

const DEFAULT_HOST = '127.0.0.1';

/**
 * `GET /healthz` on `host` (default 127.0.0.1; the container sets 0.0.0.0 so the compose loopback-only published port can reach it). 200 when the db answers, else 503. Never returns error text. */
export async function startHealth(o: { port: number; host?: string; check: () => Promise<HealthStatus> }): Promise<HealthServer> {
  const host = o.host ?? DEFAULT_HOST;
  const server: Server = createServer((req, res) => {
    if (req.method !== 'GET' || (req.url ?? '').split('?')[0] !== '/healthz') {
      res.writeHead(404).end();
      return;
    }
    o.check()
      .then((s) => ({ code: s.db === 'ok' ? 200 : 503, body: {
        db: s.db, clients: s.clients, halted: s.halted, ...(s.provider ? { provider: s.provider } : {}), ...(s.build ? { build: s.build } : {}),
        ...(s.offDay !== undefined ? { offDay: s.offDay, ...(s.offDay && s.offDayReason ? { offDayReason: s.offDayReason } : {}) } : {}),
      } }))
      .catch(() => ({ code: 503, body: { db: 'error' } }))
      .then(({ code, body }) => {
        res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, host, () => resolve());
  });
  const a = server.address() as AddressInfo; // captured once: server.address() is null after close
  const bound = { host: a.address, port: a.port };
  return {
    address: () => bound,
    url: () => `http://${bound.host}:${bound.port}`,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
