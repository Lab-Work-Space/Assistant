/**
 * Host side of the local media relay (`node dist/media/relay-host.js`, started by `scripts/dev.sh media up`, Gate 1 LM3, LM8).
 * Listens on a 0600 unix socket in a 0700 directory and, per connection, dials 127.0.0.1:9225, sends the token line and pipes.
 * The token comes only from its environment. Imports: node:* and media/relay-core.ts only (media/graph.test.ts).
 */
import { chmodSync, lstatSync, mkdirSync, unlinkSync, type Stats } from 'node:fs';
import net from 'node:net';
import { dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bridge, IDLE_MS, MAGIC, MAX_CONN, RELAY_PORT, stderrLog, TOKEN_RE, type RelayLog } from './relay-core.js';

export class HostRelayRefusal extends Error {}

type LstatFn = (p: string) => Stats;

/**
 * Host-side twin of prepareSocketPath in media/server.ts. The parent must be a user-owned real directory that is not group- or
 * world-writable; the media dir must be a user-owned real directory with mode exactly 0700 (created 0700 when missing); an
 * existing path at `sock` may only be unlinked when it is a socket owned by the user. Throws HostRelayRefusal otherwise.
 */
export function prepareHostSocket(dir: string, sock: string, o: { euid?: number; lstat?: LstatFn } = {}): void {
  const euid = o.euid ?? process.geteuid?.() ?? -1;
  const lstat = o.lstat ?? lstatSync;
  const find = (p: string): Stats | null => {
    try {
      return lstat(p);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new HostRelayRefusal('cannot inspect a media path');
    }
  };
  if (!isAbsolute(dir) || dirname(sock) !== dir) throw new HostRelayRefusal('media paths must be absolute and the socket must sit in the media directory');
  const parent = dirname(dir);
  let ps = find(parent);
  if (!ps) {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    ps = find(parent);
  }
  if (!ps || ps.isSymbolicLink() || !ps.isDirectory() || ps.uid !== euid || (ps.mode & 0o022) !== 0)
    throw new HostRelayRefusal('parent directory must be a real directory owned by the user and not group/world-writable');
  let ds = find(dir);
  if (!ds) {
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700);
    ds = find(dir);
  }
  if (!ds || ds.isSymbolicLink() || !ds.isDirectory() || ds.uid !== euid || (ds.mode & 0o777) !== 0o700)
    throw new HostRelayRefusal('media directory must be a real directory owned by the user with mode 0700');
  const ss = find(sock);
  if (ss) {
    if (!ss.isSocket() || ss.uid !== euid) throw new HostRelayRefusal('socket path is occupied by something that is not our socket');
    unlinkSync(sock);
  }
}

export interface HostRelayOptions {
  token: string;
  dir: string;
  sock: string;
  port?: number;
  host?: string;
  idleMs?: number;
  maxConn?: number;
  log?: RelayLog;
  euid?: number;
  lstat?: LstatFn;
}

/** Listens on the unix socket (chmod 0600 and verified) and resolves with the server. */
export async function createHostRelay(o: HostRelayOptions): Promise<net.Server> {
  if (!TOKEN_RE.test(o.token)) throw new HostRelayRefusal('bad token');
  prepareHostSocket(o.dir, o.sock, { ...(o.euid !== undefined ? { euid: o.euid } : {}), ...(o.lstat ? { lstat: o.lstat } : {}) });
  const first = `${MAGIC}${o.token}\n`;
  const log = o.log ?? stderrLog;
  const server = net.createServer();
  server.maxConnections = o.maxConn ?? MAX_CONN;
  server.on('drop', () => log('warn', { reason: 'too-many' }, 'connection refused'));
  server.on('connection', (c) => {
    const up = net.connect({ host: o.host ?? '127.0.0.1', port: o.port ?? RELAY_PORT });
    up.write(first);
    bridge(c, up, o.idleMs ?? IDLE_MS);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.sock, () => {
      server.off('error', reject);
      // G2M-04: a later server error closes the relay with a fixed reason (fail closed; the app then sees the sidecar as unreachable).
      server.on('error', () => {
        log('error', { reason: 'server-error' }, 'host relay stopped');
        server.close();
      });
      resolve();
    });
  });
  try {
    chmodSync(o.sock, 0o600);
    const st = lstatSync(o.sock);
    if (!st.isSocket() || (st.mode & 0o777) !== 0o600 || st.uid !== (o.euid ?? process.geteuid?.() ?? -1)) throw new HostRelayRefusal('socket mode/owner check failed');
  } catch (e) {
    server.close();
    throw e;
  }
  return server;
}

export async function runHostRelay(o: { env?: NodeJS.ProcessEnv; exit?: (code: number) => never; log?: RelayLog } = {}): Promise<net.Server | null> {
  const env = o.env ?? process.env;
  const exit = o.exit ?? ((c: number) => process.exit(c));
  const log = o.log ?? stderrLog;
  const token = env.MEDIA_RELAY_TOKEN ?? '';
  delete env.MEDIA_RELAY_TOKEN;
  const home = env.HOME ?? '';
  if (!TOKEN_RE.test(token) || !isAbsolute(home)) {
    log('error', { key: 'MEDIA_RELAY_TOKEN/HOME' }, 'MEDIA_RELAY_TOKEN (48 hex) and an absolute HOME are required');
    exit(78);
    return null;
  }
  const dir = join(home, '.config', 'assistant', 'media');
  process.umask(0o077);
  try {
    const server = await createHostRelay({ token, dir, sock: join(dir, 'media.sock') });
    log('info', {}, 'host media relay listening');
    const stop = (): void => {
      server.close();
      setTimeout(() => process.exit(0), 500).unref();
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    return server;
  } catch (e) {
    log('error', { reason: e instanceof HostRelayRefusal ? e.message : 'listen-failed' }, 'host media relay could not start');
    exit(e instanceof HostRelayRefusal ? 78 : 1);
    return null;
  }
}

const isEntry = (): boolean => !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry()) void runHostRelay();
