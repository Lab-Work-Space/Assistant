/**
 * Container side of the local media relay (`node dist/media/relay-container.js`, Gate 1 LM1-LM7). It listens on TCP, requires the
 * per-boot token line `LWMEDIA1 <token>\n` within 2 s, and only then connects to the sidecar's unix socket and pipes bytes. Own env
 * allowlist (media/main.ts ENV_ALLOW is untouched); exit 78 on any other key (names logged, never values). Imports: node:* and
 * media/relay-core.ts only (media/graph.test.ts).
 */
import { lstatSync } from 'node:fs';
import net from 'node:net';
import { isAbsolute, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AUTH_MS, bridge, IDLE_MS, MAX_CONN, readTokenLine, RELAY_PORT, stderrLog, TOKEN_RE, type RelayLog } from './relay-core.js';

export const RELAY_ENV_ALLOW: readonly string[] = Object.freeze([
  'PATH', 'HOME', 'HOSTNAME', 'TERM', 'LANG', 'TMPDIR', 'NODE_ENV', 'NODE_VERSION', 'YARN_VERSION', 'MEDIA_RELAY_TOKEN', 'MEDIA_SOCKET',
]);
const ALLOWED = new Set(RELAY_ENV_ALLOW);
const EXIT_CONFIG = 78;
export const SOCKET_PREFIX = '/run/media-ipc/';

export function envViolations(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).filter((k) => !ALLOWED.has(k)).map((k) => k.replace(/[^A-Za-z0-9_.-]/g, '?').slice(0, 64));
}

export interface ContainerRelayOptions {
  token: string;
  socketPath: string;
  /** The socket path must start with this (default /run/media-ipc/). Tests pass their temp dir. */
  prefix?: string;
  authMs?: number;
  idleMs?: number;
  maxConn?: number;
  log?: RelayLog;
}

/** True when `p` is absolute, already normalised and inside `prefix`. */
export const socketPathOk = (p: string, prefix: string = SOCKET_PREFIX): boolean =>
  isAbsolute(p) && !p.includes('\0') && normalize(p) === p && p.startsWith(prefix) && p.length > prefix.length;

/** The token-gated server (not yet listening). Pre-auth sockets count toward maxConn like piped ones. */
export function createContainerRelay(o: ContainerRelayOptions): net.Server {
  if (!TOKEN_RE.test(o.token)) throw new Error('bad token');
  if (!socketPathOk(o.socketPath, o.prefix)) throw new Error('bad socket path');
  const log = o.log ?? stderrLog;
  const server = net.createServer();
  server.maxConnections = o.maxConn ?? MAX_CONN;
  server.on('drop', () => log('warn', { reason: 'too-many' }, 'connection refused'));
  server.on('error', () => undefined);
  server.on('connection', (sock) => {
    void (async () => {
      const rest = await readTokenLine(sock, o.token, o.authMs ?? AUTH_MS, log);
      if (rest === null) return;
      // The unix connect happens only now, after the token matched; the target must be a socket (lstat, no symlink).
      let isSock = false;
      try {
        isSock = lstatSync(o.socketPath).isSocket();
      } catch {
        /* missing */
      }
      if (!isSock) {
        log('warn', { reason: 'no-socket' }, 'connection refused');
        sock.destroy();
        return;
      }
      const up = net.connect({ path: o.socketPath });
      if (rest.length) up.write(rest);
      bridge(sock, up, o.idleMs ?? IDLE_MS);
      sock.resume();
    })();
  });
  return server;
}

/** Starts the relay from `env` (the process env in production). Exit 78 on a bad env; the token is deleted from `env` after reading. */
export function runContainerRelay(
  o: { env?: NodeJS.ProcessEnv; exit?: (code: number) => never; port?: number; host?: string; prefix?: string; log?: RelayLog } = {},
): net.Server | null {
  const env = o.env ?? process.env;
  const exit = o.exit ?? ((c: number) => process.exit(c));
  const log = o.log ?? stderrLog;
  const bad = envViolations(env);
  if (bad.length) {
    log('error', { keys: bad.join(',') }, 'env keys outside the relay allowlist; refusing to start');
    exit(EXIT_CONFIG);
    return null;
  }
  const token = env.MEDIA_RELAY_TOKEN ?? '';
  const socketPath = env.MEDIA_SOCKET ?? '';
  delete env.MEDIA_RELAY_TOKEN;
  if (!TOKEN_RE.test(token)) {
    log('error', { key: 'MEDIA_RELAY_TOKEN' }, 'MEDIA_RELAY_TOKEN must be 48 lowercase hex characters');
    exit(EXIT_CONFIG);
    return null;
  }
  if (!socketPathOk(socketPath, o.prefix)) {
    log('error', { key: 'MEDIA_SOCKET' }, 'MEDIA_SOCKET must be an absolute path under the media-ipc directory');
    exit(EXIT_CONFIG);
    return null;
  }
  const server = createContainerRelay({ token, socketPath, ...(o.prefix ? { prefix: o.prefix } : {}), log });
  server.listen(o.port ?? RELAY_PORT, o.host ?? '0.0.0.0', () => log('info', { port: RELAY_PORT }, 'media relay listening'));
  server.on('error', () => exit(1));
  const stop = (): void => {
    server.close();
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  return server;
}

const isEntry = (): boolean => !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry()) runContainerRelay();
