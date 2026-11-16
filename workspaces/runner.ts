import { execFile, spawn } from 'node:child_process';
import { redactText } from '../core/logger.js';
import { cmdFor, needsNetwork, type Parsed } from './command.js';

/**
 * The ws container spawner (SA-1 C5 and 5.3, Gate 1 WS-C1 to WS-C3). Nothing is imported from devjob/launcher.ts: that file forbids `-v` and
 * hard-codes uid 65534 and the devjob label. Argv is built from validated parts only (the model chooses a verb, never a flag), spawn takes
 * an array with no shell, and env is {PATH, HOME, DOCKER_HOST?}. This is damage limitation, not a boundary (OD-1): the app uid can reach the
 * Docker socket anyway.
 */
export const WS_NETWORK = 'ws_prepnet';
export const PROXY_CONTAINER = 'assistant-ws-registryproxy-1';
export const TAIL_BYTES = 64 * 1024;
export const OUTPUT_CHARS = 8000;
export const RUN_TIMEOUT_MS = 300_000;
const CLIENT_GRACE_MS = 10_000;
const CLI_TIMEOUT_MS = 15_000;

export const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const SLUG = /^[a-z][a-z0-9-]{1,39}$/;
const NAME = /^ws-[a-z][a-z0-9-]{1,39}-[0-9a-f]{8}$/;
const ROOT = /^\/[A-Za-z0-9._/-]{1,200}$/;

export type ArgvIn = { name: string; slug: string; uid: number; gid: number; wsReal: string; image: string; parsed: Parsed };

/** The one place that builds a `docker run` argv. Throws on any part that fails its rule (WS-C2: no comma or odd character can reach --mount). */
export function buildArgv(i: ArgvIn): string[] {
  if (!NAME.test(i.name) || !SLUG.test(i.slug) || !i.name.startsWith(`ws-${i.slug}-`)) throw new Error('bad container name or slug');
  if (!IMAGE_ID.test(i.image)) throw new Error('bad image id');
  if (!ROOT.test(i.wsReal)) throw new Error('bad workspace root');
  if (!Number.isInteger(i.uid) || i.uid < 1 || !Number.isInteger(i.gid) || i.gid < 0) throw new Error('refusing to run as uid 0');
  const tmpfs = 'rw,noexec,nosuid,nodev,size=512m';
  return [
    'run', '--init', '--pull=never', '--log-driver=none', '--ulimit', 'core=0',
    '--name', i.name, '--label', 'ws=1', '--label', `ws.slug=${i.slug}`,
    '--user', `${i.uid}:${i.gid}`, '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--pids-limit', '256', '--memory', '2g', '--memory-swap', '2g', '--cpus', '2',
    '--tmpfs', `/tmp:${tmpfs}`, '--tmpfs', `/home/ws:${tmpfs}`,
    '--network', needsNetwork(i.parsed.verb) ? WS_NETWORK : 'none',
    '--mount', `type=bind,src=${i.wsReal}/${i.slug},dst=/work`,
    '-w', '/work', '-e', 'HOME=/home/ws', '-e', 'CI=1', '-e', 'NO_UPDATE_NOTIFIER=1', '-e', 'npm_config_update_notifier=false',
    i.image, ...cmdFor(i.parsed),
  ];
}

// ---- docker CLI port --------------------------------------------------------------------------------------------------------------------

export type ExecResult = { code: number; stdout: string; timedOut: boolean; missing: boolean };
export type RunDone = { code: number; tail: Buffer; overflowed: boolean; spawnFailed: boolean };
export type RunHandle = { done: Promise<RunDone>; killClient(): void };
export interface DockerCli {
  /** A short docker command; always has a timeout. */
  exec: (args: readonly string[], timeoutMs?: number) => Promise<ExecResult>;
  /** `docker run` with output kept as a 64 KiB tail ring. */
  start(args: readonly string[]): RunHandle;
}

export const dockerEnv = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME ?? '/', ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}) });

/** The last `cap` bytes written to it; `overflowed` once anything was dropped. */
export class TailRing {
  private buf: Buffer = Buffer.alloc(0);
  overflowed = false;
  constructor(private readonly cap = TAIL_BYTES) {}
  push(chunk: Buffer): void {
    const all = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    if (all.length > this.cap) {
      this.overflowed = true;
      this.buf = Buffer.from(all.subarray(all.length - this.cap));
    } else this.buf = Buffer.from(all);
  }
  bytes(): Buffer {
    return this.buf;
  }
}

export function realDockerCli(): DockerCli {
  return {
    exec: (args, timeoutMs = CLI_TIMEOUT_MS) =>
      new Promise((resolve) => {
        execFile('docker', [...args], { env: dockerEnv(), encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: timeoutMs, killSignal: 'SIGKILL' }, (err, stdout) => {
          const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
          resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout: String(stdout ?? ''), timedOut: !!e?.killed, missing: e?.code === 'ENOENT' });
        });
      }),
    start(args) {
      const ring = new TailRing();
      let spawnFailed = false;
      const p = spawn('docker', [...args], { env: dockerEnv(), stdio: ['ignore', 'pipe', 'pipe'], shell: false });
      p.stdout.on('data', (c: Buffer) => ring.push(c));
      p.stderr.on('data', (c: Buffer) => ring.push(c));
      const done = new Promise<RunDone>((resolve) => {
        let fin = false;
        const end = (code: number) => {
          if (fin) return;
          fin = true;
          resolve({ code, tail: ring.bytes(), overflowed: ring.overflowed, spawnFailed });
        };
        p.on('error', () => {
          spawnFailed = true;
          end(127);
        });
        p.on('close', (code) => end(code ?? 137));
      });
      return { done, killClient: () => void p.kill('SIGKILL') };
    },
  };
}

// ---- one container run ------------------------------------------------------------------------------------------------------------------

export type ContainerRun = {
  code: number;
  tail: Buffer;
  overflowed: boolean;
  spawnFailed: boolean;
  timedOut: boolean;
  /** Halted or aborted (killAll) while the container ran or before it was started. */
  stopped: boolean;
  info: { oom: boolean; exit: number; started: boolean } | null;
  secs: number;
  /** `rm -f` was verified (the name is gone from `docker ps -a`). False: the caller must report E_STUCK. */
  removed: boolean;
};

export type RunOpts = {
  argv: readonly string[];
  name: string;
  timeoutMs?: number;
  clientGraceMs?: number;
  haltPollMs?: number;
  isHalted: () => boolean;
  signal?: AbortSignal;
  now?: () => number;
};

const ZERO_TIME = /^0001-01-01/;

/** `rm -f` then a `ps -a` check that the name is gone, up to 3 times. `volumes` (R6 MC-C2) adds `-v`, so an anonymous volume the image declared goes with the container; the default argv is unchanged. */
export async function removeVerified(d: Pick<DockerCli, 'exec'>, name: string, o: { volumes?: boolean } = {}): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    await d.exec(o.volumes === true ? ['rm', '-f', '-v', name] : ['rm', '-f', name]);
    const r = await d.exec(['ps', '-a', '--filter', `name=${name}`, '--format', '{{.Names}}']);
    if (r.code === 0 && !r.timedOut && !r.stdout.split('\n').some((l) => l.trim() === name)) return true;
  }
  return false;
}

/**
 * Starts the container and waits. A timeout, a halt or an abort runs `docker rm -f` (which ends the `docker run` client); the client is killed
 * after a further grace period. While the container runs, the halt flag is polled so a container created after killAll's own `rm -f` is still
 * removed. The container is always removed and verified gone in `finally` (a started container is never left behind).
 */
export async function runContainer(d: DockerCli, o: RunOpts): Promise<ContainerRun> {
  const now = o.now ?? Date.now;
  const t0 = now();
  let timedOut = false;
  let stopped = false;
  let removing = false;
  const kill = () => {
    if (removing) return;
    removing = true;
    void d.exec(['rm', '-f', o.name]).finally(() => { removing = false; });
  };
  let h: RunHandle | null = null;
  let done: RunDone | null = null;
  const timers: NodeJS.Timeout[] = [];
  try {
    // Same synchronous block: the last halt check and the start of the container (WS-C12).
    if (o.isHalted() || o.signal?.aborted) {
      stopped = true;
      return { code: 0, tail: Buffer.alloc(0), overflowed: false, spawnFailed: false, timedOut, stopped, info: null, secs: 0, removed: true };
    }
    h = d.start(o.argv);
    const timeout = setTimeout(() => {
      timedOut = true;
      kill();
      const grace = setTimeout(() => h?.killClient(), o.clientGraceMs ?? CLIENT_GRACE_MS);
      grace.unref();
      timers.push(grace);
    }, o.timeoutMs ?? RUN_TIMEOUT_MS);
    const poll = setInterval(() => {
      if (o.isHalted() || o.signal?.aborted) {
        stopped = true;
        kill();
      }
    }, o.haltPollMs ?? 500);
    timeout.unref();
    poll.unref();
    timers.push(timeout, poll);
    done = await h.done;
  } finally {
    for (const t of timers) clearTimeout(t);
    timers.length = 0;
  }
  let info: ContainerRun['info'] = null;
  let removed = false;
  try {
    if (!stopped) {
      const ins = await d.exec(['inspect', '--format', '{{.State.OOMKilled}} {{.State.ExitCode}} {{.State.StartedAt}}', o.name]);
      const m = ins.code === 0 ? /^(true|false) (-?\d+) (\S+)$/.exec(ins.stdout.trim()) : null;
      if (m) info = { oom: m[1] === 'true', exit: Number(m[2]), started: !ZERO_TIME.test(m[3]!) };
    }
  } finally {
    removed = await removeVerified(d, o.name);
  }
  if (o.isHalted() || o.signal?.aborted) stopped = true;
  return { code: done.code, tail: done.tail, overflowed: done.overflowed, spawnFailed: done.spawnFailed, timedOut, stopped, info, secs: Math.max(0, Math.round((now() - t0) / 1000)), removed };
}

// ---- output -----------------------------------------------------------------------------------------------------------------------------

// ESC sequences (CSI, OSC, two-character), then every C0 control except \n and \t, and DEL.
// eslint-disable-next-line no-control-regex
export const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex
export const C0 = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/**
 * What the model sees of a run (SA-1 5.3, WS-C16): strip ANSI and C0, redact with the secret list, keep the last 8000 characters, in that order.
 * When the 64 KiB ring dropped its head, the cut can be inside a secret: the first line (at least the longest literal minus one characters)
 * is dropped before redaction so half a secret cannot survive.
 */
export function formatOutput(tail: Buffer, overflowed: boolean, secrets: readonly string[]): string {
  let text = tail.toString('utf8');
  if (overflowed) {
    const nl = text.indexOf('\n');
    const longest = secrets.reduce((m, x) => Math.max(m, x.length), 0);
    // A literal cut by the ring leaves a suffix of at most longest-1 characters; a pattern secret (key=value) is cut along with its line.
    text = text.slice(Math.max(nl >= 0 && nl < 4096 ? nl + 1 : 0, longest - 1, 256));
  }
  const clean = text.replace(ANSI, '').replace(C0, '');
  const red = redactText(clean, secrets.filter((s) => s.length > 0));
  return red.length > OUTPUT_CHARS ? red.slice(red.length - OUTPUT_CHARS) : red;
}
