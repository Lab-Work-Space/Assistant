import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { IMAGE_ID, dockerEnv, removeVerified, type DockerCli } from '../workspaces/runner.js';
import { COMMAND_ITEM, ENV_KEY, ENV_VALUE } from './fields.js';
import { McpError } from './errors.js';
import { INIT_TIMEOUT_MS, LIST_TIMEOUT_MS, RpcClient, type McpProc, type McpSpawner } from './rpc.js';

/**
 * R6 MCP-1: the per-call sandbox (spec 3.5 with MC-C2, MC-C3, MC-C19). One fresh container per call and per probe; the argv is built ONLY here from validated
 * parts; spawn takes an array with `shell: false` and the env is {PATH, HOME, DOCKER_HOST?} (`dockerEnv` of workspaces/runner.ts, reused). This is damage limitation,
 * not a boundary: the app uid can reach the Docker socket (WS-1 OD-1). The container is always removed in `finally` with `rm -f -v` and verified gone; a removal
 * that cannot be verified is E_STUCK and latches every later MCP call until restart.
 */
export const SANDBOX_NAME = /^mcp-[a-z][a-z0-9]{1,15}-[0-9a-f]{8}$/;
const SLUG = /^[a-z][a-z0-9]{1,15}$/;
const ENV_DENY = /^(?:PATH|HOME|USER|SHELL|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONSTARTUP|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|ALL_PROXY)$|^(?:LD_|DYLD_|DOCKER_)|TOKEN|SECRET|PASSW|API_KEY|PRIVATE|CREDENTIAL|AUTH/;

export interface ArgvIn { name: string; slug: string; image: string; command: readonly string[]; env: Readonly<Record<string, string>> }

/** Spec 3.5 verbatim plus `--no-healthcheck` (MC-C2), `--hostname mcp`, `--cgroupns=private` and `--ulimit nofile=256:256` (MC-C3). Throws on any part that fails its rule. */
export function buildMcpArgv(i: ArgvIn): string[] {
  if (!SANDBOX_NAME.test(i.name) || !SLUG.test(i.slug) || !i.name.startsWith(`mcp-${i.slug}-`)) throw new Error('bad container name or slug');
  if (!IMAGE_ID.test(i.image)) throw new Error('bad image id');
  for (const c of i.command) if (!COMMAND_ITEM.test(c)) throw new Error('bad command item');
  const keys = Object.keys(i.env).sort();
  const envArgs: string[] = [];
  for (const k of keys) {
    const v = i.env[k]!;
    if (!ENV_KEY.test(k) || ENV_DENY.test(k) || !ENV_VALUE.test(v)) throw new Error('bad env entry');
    envArgs.push('-e', `${k}=${v}`);
  }
  return [
    'run', '-i', '--init', '--pull=never', '--log-driver=none', '--no-healthcheck', '--ulimit', 'core=0', '--ulimit', 'nofile=256:256',
    '--name', i.name, '--label', 'mcp=1', '--label', `mcp.server=${i.slug}`, '--hostname', 'mcp', '--user', '65534:65534', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--cgroupns=private',
    '--pids-limit', '64', '--memory', '512m', '--memory-swap', '512m', '--cpus', '1', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m', '--network', 'none', '--ipc', 'none',
    ...envArgs, i.image, ...i.command,
  ];
}

/** The real spawner: `docker` with an argv array and three pipes (the shared DockerCli opens stdin as `ignore`; MCP needs a pipe). */
export function realMcpSpawner(): McpSpawner {
  return (argv) => {
    const p = spawn('docker', [...argv], { env: dockerEnv(), stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    const exited = new Promise<{ code: number | null; spawnFailed: boolean }>((resolve) => {
      p.on('error', () => resolve({ code: 127, spawnFailed: true }));
      p.on('close', (code) => resolve({ code, spawnFailed: false }));
    });
    return { stdin: p.stdin, stdout: p.stdout, stderr: p.stderr, exited, kill: () => void p.kill('SIGKILL') } satisfies McpProc;
  };
}

/** Latches after a removal that could not be verified: every MCP call is refused until restart. */
export class StuckLatch {
  private on = false;
  get stuck(): boolean { return this.on; }
  set(): void { this.on = true; }
}

export interface SandboxDeps {
  docker: Pick<DockerCli, 'exec'>;
  spawn: McpSpawner;
  isHalted(): boolean;
  latch: StuckLatch;
  /** Called once, when the latch first sets: the fixed incident to #bot-log. */
  onStuck?: () => void;
  newSuffix?: () => string;
  haltPollMs?: number;
  clientGraceMs?: number;
  /** Test override of `20 s + 10 s + timeout_ms + 5 s`. */
  hardTimeoutMs?: number;
}
export interface SandboxCfg { slug: string; imageId: string; command: readonly string[]; env: Readonly<Record<string, string>>; timeoutMs: number }

/** Is the image this id, and does it declare no volume (MC-C2: a VOLUME gets a writable anonymous volume despite --read-only)? Never throws. */
export async function checkImage(docker: Pick<DockerCli, 'exec'>, imageId: string): Promise<boolean> {
  try {
    if (!IMAGE_ID.test(imageId)) return false;
    const id = await docker.exec(['image', 'inspect', '--format', '{{.Id}}', imageId]);
    if (id.code !== 0 || id.timedOut || id.stdout.trim() !== imageId) return false;
    const v = await docker.exec(['image', 'inspect', '--format', '{{json .Config.Volumes}}', imageId]);
    if (v.code !== 0 || v.timedOut) return false;
    const t = v.stdout.trim();
    return t === 'null' || t === '{}';
  } catch {
    return false;
  }
}

/** MC-C3 (G2-MCP-02): does `docker info` show seccomp and no `unconfined`? The one check, shared by the boot and every path that spawns the sandbox. Never throws; unreadable is false. */
export function seccompOk(stdout: string): boolean {
  try {
    const v: unknown = JSON.parse(stdout.trim());
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) return false;
    return v.some((x) => /^name=seccomp\b/.test(x)) && !v.some((x) => /unconfined/.test(x));
  } catch {
    return false;
  }
}
export async function checkSeccomp(docker: Pick<DockerCli, 'exec'>): Promise<boolean> {
  try {
    const info = await docker.exec(['info', '--format', '{{json .SecurityOptions}}']);
    return info.code === 0 && !info.timedOut && seccompOk(info.stdout);
  } catch {
    return false;
  }
}

const INSPECT = '{{.State.OOMKilled}} {{.State.ExitCode}} {{.State.StartedAt}}';
const ZERO_TIME = /^0001-01-01/;

/**
 * Runs `fn` against a fresh container. The hard timeout is 20 s + 10 s + timeout_ms + 5 s; the halt flag is polled every 500 ms; either kills the container
 * (`rm -f -v`) and, after a grace period, the docker client. In `finally`: stdin is closed, the container is inspected (OOM), removed with `-v` and verified gone.
 * Errors come out as McpError with the final code: E_STUCK over everything, then E_TIMEOUT, E_HALTED, E_OOM, E_SPAWN, else the error of `fn`.
 */
export async function withSandbox<T>(d: SandboxDeps, cfg: SandboxCfg, fn: (rpc: RpcClient) => Promise<T>): Promise<T> {
  if (d.latch.stuck) throw new McpError('E_STUCK');
  if (d.isHalted()) throw new McpError('E_HALTED');
  const name = `mcp-${cfg.slug}-${d.newSuffix ? d.newSuffix() : randomBytes(4).toString('hex')}`;
  const argv = buildMcpArgv({ name, slug: cfg.slug, image: cfg.imageId, command: cfg.command, env: cfg.env });
  let proc: McpProc;
  try {
    proc = d.spawn(argv);
  } catch {
    throw new McpError('E_SPAWN');
  }
  let timedOut = false;
  let stopped = false;
  let removing = false;
  const kill = (): void => {
    if (removing) return;
    removing = true;
    void d.docker.exec(['rm', '-f', '-v', name]).catch(() => undefined).finally(() => { removing = false; });
  };
  const timers: NodeJS.Timeout[] = [];
  const grace = (): void => {
    const t = setTimeout(() => proc.kill(), d.clientGraceMs ?? 10_000);
    t.unref();
    timers.push(t);
  };
  const rpc = new RpcClient(proc, { onFatal: () => { kill(); grace(); } });
  const hard = d.hardTimeoutMs ?? INIT_TIMEOUT_MS + LIST_TIMEOUT_MS + cfg.timeoutMs + 5_000;
  const hardTimer = setTimeout(() => { timedOut = true; kill(); grace(); }, hard);
  const poll = setInterval(() => { if (d.isHalted()) { stopped = true; kill(); grace(); } }, d.haltPollMs ?? 500);
  hardTimer.unref();
  poll.unref();
  timers.push(hardTimer, poll);
  let result: T | undefined;
  let err: unknown = null;
  let ok = false;
  try {
    result = await fn(rpc);
    ok = true;
  } catch (e) {
    err = e;
  } finally {
    for (const t of timers) clearTimeout(t);
    rpc.closeStdin();
  }
  let oom = false;
  let started = true;
  let removed = false;
  try {
    if (!stopped) {
      const ins = await d.docker.exec(['inspect', '--format', INSPECT, name]);
      const m = ins.code === 0 ? /^(true|false) (-?\d+) (\S+)$/.exec(ins.stdout.trim()) : null;
      if (m) { oom = m[1] === 'true'; started = !ZERO_TIME.test(m[3]!); }
    }
  } catch { /* the inspect is best effort */ } finally {
    removed = await removeVerified(d.docker, name, { volumes: true }).catch(() => false);
  }
  const g = setTimeout(() => proc.kill(), d.clientGraceMs ?? 10_000);
  g.unref();
  const x = await Promise.race([proc.exited, new Promise<{ code: number | null; spawnFailed: boolean }>((r) => setTimeout(() => r({ code: null, spawnFailed: false }), d.clientGraceMs ?? 10_000).unref())]);
  clearTimeout(g);
  proc.kill();
  if (!removed) {
    const first = !d.latch.stuck;
    d.latch.set();
    if (first) { try { d.onStuck?.(); } catch { /* the incident post never throws out of here */ } }
    throw new McpError('E_STUCK');
  }
  if (ok && !timedOut && !stopped) return result as T;
  if (timedOut) throw new McpError('E_TIMEOUT');
  if (stopped || d.isHalted()) throw new McpError('E_HALTED');
  const code = err instanceof McpError ? err.code : 'E_INTERNAL';
  if (oom && (code === 'E_EXIT' || code === 'E_TIMEOUT' || code === 'E_PROTOCOL')) throw new McpError('E_OOM');
  if (code === 'E_EXIT' && (x.spawnFailed || x.code === 125 || !started)) throw new McpError('E_SPAWN');
  throw err instanceof McpError ? err : new McpError('E_INTERNAL');
}
