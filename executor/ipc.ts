import { chmodSync, existsSync, lstatSync, statSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { z } from 'zod';

/**
 * The local IPC between the main application and the executor (Gate 1 S2, option A): one JSON request per line over a Unix socket in the
 * assistant config dir (dir 0700, socket 0600; the path is short because macOS limits a socket path to 104 bytes). It carries NO token and no
 * permission to do anything the executor's own hard limits forbid: `apply` names a card id and nothing else, and the executor re-reads the
 * confirmed row from the database and re-validates everything on its own live data (S1).
 */
const snowflake = z.string().regex(/^\d{17,20}$/);
export const IpcRequest = z.discriminatedUnion('op', [
  z.object({ op: z.literal('status') }).strict(),
  z.object({ op: z.literal('propose'), family: z.enum(['perm', 'server', 'deploy', 'code']), ops: z.array(z.unknown()).max(20), userId: snowflake, namedIds: z.array(snowflake).max(200) }).strict(),
  z.object({ op: z.literal('apply'), cardId: z.string().regex(/^[0-9a-f]{32}$/) }).strict(),
  z.object({ op: z.literal('read'), kind: z.enum(['roles', 'channels', 'members', 'audit']), roleId: snowflake.optional(), joinedAfter: z.string().datetime().optional() }).strict(),
  /** Gate 1 V22: status and logs of assistant-owned apps; Bot Admin only, judged by the executor on the live member. */
  z.object({ op: z.literal('deploy_read'), userId: snowflake, read: z.object({ kind: z.enum(['status', 'logs']), app: z.string().max(80).optional(), lines: z.number().int().min(1).max(200).optional() }).strict() }).strict(),
  /** Self-code X18: a Bot Admin's manual rollback of the last code change within 24 hours; the executor judges the tier on the live member. */
  z.object({ op: z.literal('code_rollback'), userId: snowflake }).strict(),
  z.object({ op: z.literal('check_welcome'), roleIds: z.array(snowflake).max(5), channelId: snowflake.nullable() }).strict(),
  /** T7-T10: the prospective `roles.*` values (current config with the card's changes applied), judged on the executor's live view. */
  z.object({ op: z.literal('check_tiers'), managerId: snowflake.nullable(), moderatorId: snowflake.nullable(), modRoomId: snowflake.nullable() }).strict(),
]);
export type IpcRequest = z.infer<typeof IpcRequest>;

export const MAX_LINE = 512 * 1024;
type Handler = (req: IpcRequest) => Promise<unknown>;
const log0 = { error(_o: unknown, _m?: string) {} };

/**
 * The directory must be owned by this user with mode 0700 and the path must not be a symlink; a stale socket file is removed.
 * `shared` (OD-1: the executor runs as its OWN macOS user under launchd): the directory may be group readable/searchable (0750, group = the owner's
 * ipc group) but never reachable by anyone else, and the socket is 0660. The kernel then lets only that group connect; Node has no getpeereid, so
 * there is no per-connection uid check (reported as a residual).
 */
function prepare(path: string, shared: boolean): void {
  const dir = dirname(path);
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('the socket directory is not a real directory');
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error('the socket directory is not owned by the current user');
  const mode = statSync(dir).mode;
  if (shared) {
    if ((mode & 0o700) !== 0o700 || (mode & 0o027) !== 0 || (mode & 0o007) !== 0) throw new Error('the shared socket directory must have mode 0750 (owner full, group read and search, others nothing)');
  } else if ((mode & 0o077) !== 0) throw new Error('the socket directory must have mode 0700');
  if (existsSync(path)) {
    if (!lstatSync(path).isSocket()) throw new Error('the socket path exists and is not a socket');
    unlinkSync(path);
  }
}

export async function startIpcServer(path: string, handler: Handler, log: { error(o: unknown, m?: string): void } = log0, opts: { shared?: boolean } = {}): Promise<Server> {
  prepare(path, opts.shared === true);
  const server = createServer((sock: Socket) => {
    let buf = '';
    let busy = false;
    sock.setEncoding('utf8');
    sock.setTimeout(150_000, () => sock.destroy());
    const reply = (v: unknown) => {
      sock.end(`${JSON.stringify(v)}\n`);
    };
    sock.on('error', () => undefined);
    sock.on('data', (chunk: string) => {
      if (busy) return;
      buf += chunk;
      if (buf.length > MAX_LINE) {
        busy = true;
        return reply({ ok: false, error: 'request too large' });
      }
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      busy = true;
      let json: unknown;
      try {
        json = JSON.parse(buf.slice(0, nl));
      } catch {
        return reply({ ok: false, error: 'not JSON' });
      }
      const req = IpcRequest.safeParse(json);
      if (!req.success) return reply({ ok: false, error: 'invalid request' });
      handler(req.data).then(reply, (err: unknown) => {
        log.error({ err: err instanceof Error ? err.name : 'error' }, 'ipc handler failed');
        reply({ ok: false, error: 'internal error' });
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });
  chmodSync(path, opts.shared === true ? 0o660 : 0o600);
  return server;
}

/** One connection per call: no state, no reconnect logic. A refused or timed-out call is an error the caller turns into "the executor is off". */
export async function ipcCall(path: string, req: IpcRequest, timeoutMs = 30_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(path);
    let buf = '';
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('the executor did not answer in time'));
    }, timeoutMs);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(`${JSON.stringify(req)}\n`));
    sock.on('data', (c: string) => {
      buf += c;
      if (buf.length > MAX_LINE) sock.destroy();
    });
    sock.on('error', () => {
      clearTimeout(timer);
      reject(new Error('the executor is not running'));
    });
    sock.on('close', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(buf.split('\n')[0] ?? ''));
      } catch {
        reject(new Error('the executor sent no valid answer'));
      }
    });
  });
}
