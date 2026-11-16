/**
 * The media sidecar entry (`node dist/media/main.js`, spec 4.4, Gate 1 S8). It holds no secret and refuses to start with any env
 * key outside ENV_ALLOW (exit 78, key names logged, never values), before it binds or spawns anything. Binary paths come only from
 * PINNED_BINARIES (the entry passes no options) and no extra child env exists here, so the test fakes' env switches can never be
 * honoured in production. Imports are bounded by media/graph.test.ts (R2): node:*, media/*, voice/music/source.ts,
 * voice/binaries.ts, voice/exec.ts, core/child-env.ts.
 */
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bootBinaries, PINNED_BINARIES, type CheckBinariesOptions } from '../voice/binaries.js';
import { MediaServerRefusal, startMediaServer, type MediaServer } from './server.js';

/** Spec 4.4: the only env keys the sidecar accepts. Case-sensitive, exact match. */
export const ENV_ALLOW: readonly string[] = Object.freeze([
  'PATH', 'HOME', 'HOSTNAME', 'TERM', 'LANG', 'TMPDIR', 'NODE_ENV', 'NODE_VERSION', 'YARN_VERSION', 'MEDIA_SOCKET', 'YTDLP_COOKIES_FILE',
]);
const ALLOWED = new Set(ENV_ALLOW);

/** EX_CONFIG: a start refusal (env, socket path or directory); lw sees a container that never turns healthy and rolls back. */
const EXIT_CONFIG = 78;
const HARD_STOP_MS = 5000;

/** The env keys outside ENV_ALLOW, as printable names (never their values; a hostile name cannot break the log line). */
export function envViolations(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).filter((k) => !ALLOWED.has(k)).map((k) => k.replace(/[^A-Za-z0-9_.-]/g, '?').slice(0, 64));
}

type Level = 'info' | 'warn' | 'error';
/** One JSON line per event on stderr: `{level, msg, ...fields}`. Callers pass key names and fixed reasons, never env values. */
const line = (level: Level, o: object, msg?: string): void => {
  let s: string;
  try {
    s = JSON.stringify({ level, msg: msg ?? '', ...o });
  } catch {
    s = JSON.stringify({ level, msg: msg ?? '' });
  }
  process.stderr.write(`${s}\n`);
};
const log = {
  info: (o: object, m?: string) => line('info', o, m),
  warn: (o: object, m?: string) => line('warn', o, m),
  error: (o: object, m?: string) => line('error', o, m),
};

const validPath = (p: string | undefined): p is string => !!p && isAbsolute(p) && !p.includes('\0');

export interface Sidecar {
  stop(signal: string): Promise<void>;
}

/**
 * Starts the sidecar. Order: env allowlist (78) → MEDIA_SOCKET absolute (78) → the pinned-binary check, once → startMediaServer
 * (a start refusal exits 78, any other listen failure 1) → SIGTERM/SIGINT stop it: kill every child group, close the server
 * (which unlinks the socket it bound) and exit 0, with a 5 s hard deadline that exits 0 regardless. `o` is for tests only.
 */
export async function runSidecar(
  o: { env?: NodeJS.ProcessEnv; exit?: (code: number) => never; arch?: string; binaries?: Partial<CheckBinariesOptions> } = {},
): Promise<Sidecar> {
  const env = o.env ?? process.env;
  const exit = o.exit ?? ((code: number) => process.exit(code));
  const inert: Sidecar = { stop: async () => undefined };
  const refuse = (fields: object, msg: string, code: number = EXIT_CONFIG): Sidecar => {
    log.error(fields, msg);
    exit(code);
    return inert;
  };

  const bad = envViolations(env);
  if (bad.length) return refuse({ keys: bad }, 'env keys outside the media sidecar allowlist; refusing to start');
  const socketPath = env.MEDIA_SOCKET;
  if (!validPath(socketPath)) return refuse({ key: 'MEDIA_SOCKET' }, 'MEDIA_SOCKET must be set to an absolute path');
  const cookiesFile = env.YTDLP_COOKIES_FILE;
  if (cookiesFile !== undefined && cookiesFile !== '' && !validPath(cookiesFile)) return refuse({ key: 'YTDLP_COOKIES_FILE' }, 'YTDLP_COOKIES_FILE must be an absolute path');

  const over = o.binaries ?? {};
  const ytDlp = over.ytDlp ?? PINNED_BINARIES.ytDlp.path;
  const ffmpeg = over.ffmpeg ?? PINNED_BINARIES.ffmpeg.path;
  const boot = await bootBinaries(over, o.arch ?? process.arch); // computed once, hash before exec; /v1/health reports it
  if (!boot.check.ok) log.warn({ missing: boot.check.missing, mismatched: boot.check.mismatched }, 'media binaries check failed');

  let server: MediaServer;
  try {
    server = await startMediaServer({
      socketPath, ytDlp, ffmpeg, jsRuntime: process.execPath, check: boot.check,
      versions: { ytDlp: PINNED_BINARIES.ytDlp.version, ffmpeg: PINNED_BINARIES.ffmpeg.version },
      ...(cookiesFile ? { cookiesFile } : {}), log,
    });
  } catch (e) {
    if (e instanceof MediaServerRefusal) return refuse({ reason: e.message.slice(0, 200) }, 'media sidecar refused to start', e.exitCode);
    log.error({ code: (e as NodeJS.ErrnoException | null)?.code ?? 'error' }, 'media sidecar could not listen');
    exit(1);
    return inert;
  }

  let stopping: Promise<void> | null = null;
  let exited = false;
  const exitOnce = (code: number) => {
    if (exited) return;
    exited = true;
    exit(code);
  };
  const ignore = () => undefined;
  const onTerm = () => void stop('SIGTERM');
  const onInt = () => void stop('SIGINT');
  const stop = (signal: string): Promise<void> =>
    (stopping ??= (async () => {
      // a second SIGTERM/SIGINT while stopping is ignored (node's default would kill us before the socket is unlinked)
      process.off('SIGTERM', onTerm);
      process.off('SIGINT', onInt);
      process.on('SIGTERM', ignore);
      process.on('SIGINT', ignore);
      log.info({ signal: signal.replace(/[^A-Za-z0-9-]/g, '').slice(0, 20) }, 'media sidecar stopping');
      const hard = setTimeout(() => exitOnce(0), HARD_STOP_MS);
      hard.unref?.();
      try {
        server.killAll('shutdown');
        await server.close(); // kills any child left, closes every connection, unlinks the socket while it is still ours
      } finally {
        clearTimeout(hard);
        process.off('SIGTERM', ignore);
        process.off('SIGINT', ignore);
        exitOnce(0);
      }
    })());
  process.once('SIGTERM', onTerm);
  process.once('SIGINT', onInt);
  return { stop };
}

/** True when this file is the process entry (`node dist/media/main.js`), never when a test or the app imports it. */
const isEntry = (): boolean => !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntry()) void runSidecar();
