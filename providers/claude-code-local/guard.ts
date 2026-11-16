import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, createReadStream, existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { argvDigest } from './protocol.js';
import { childEnv, resolveClaudePath } from './spawn.js';

/**
 * Where `ALLOW_LOCAL_PROVIDERS` may come from (Gate 1 L9, global rule 7): only the real process env, set by the
 * `dev` npm script / launcher (Task 3). Node's `--env-file` copies a file into `process.env`, so the origin of a value
 * cannot be read back from the env itself. The rule enforced here instead: the flag must be `1` in the process env
 * AND must not be defined in any env file this process could have loaded — the L10 file
 * `~/.config/assistant/env.local` and every `--env-file` / `--env-file-if-exists` in `execArgv`.
 * Launcher contract (Task 3): set `ALLOW_LOCAL_PROVIDERS=1` in the child's environment, never write it to an env file.
 */
export const LOCAL_ENV_FILE = join('.config', 'assistant', 'env.local');
const FLAG = 'ALLOW_LOCAL_PROVIDERS';
/**
 * LOCAL-OFF-1: the owner's switch that turns ONLY the provider off (local mode, web tools, dashboard stay). scripts/dev.sh sets it in the child's
 * process env when the marker `~/.config/assistant/local-provider-off` exists. Unlike ALLOW_LOCAL_PROVIDERS it may also arrive through an env file
 * (`--env-file` copies it into process.env): it only makes the guard stricter, so its origin is not checked.
 */
export const OWNER_OFF_FLAG = 'ASSISTANT_LOCAL_PROVIDER_OFF';
export const OWNER_OFF_REASON = 'the local provider is turned off by the owner';
export const localOffByOwner = (env: GuardEnv): boolean => env.vars[OWNER_OFF_FLAG] === '1';
const DEFINES_FLAG = /^\s*(?:export\s+)?ALLOW_LOCAL_PROVIDERS\s*=/m;
/** R-L9: the owner's explicit, command-line-only override of the probe pin. */
const SKIP_PIN = 'ASSISTANT_SKIP_PROBE_PIN';
const DEFINES_SKIP_PIN = /^\s*(?:export\s+)?ASSISTANT_SKIP_PROBE_PIN\s*=/m;
/**
 * R-L9 / VULN-L-002: written by scripts/probe-local-cli.sh on PASS: `version=<first line of claude --version>`,
 * `realpath=<resolved claude binary>`, `sha256=<hex digest of that file>`, and (STREAM-1 S16) `argv_sha256=<argvDigest()>`: the digest of the
 * provider's fixed CLI argv. All four must match the claude and the provider found now, so a change to the argv invalidates the old pin (fail closed
 * until the owner re-probes).
 */
export const PROBE_PIN_FILE = join('.config', 'assistant', 'probe-ok');
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);
/** HEALTH_HOST: core/env.ts accepts only an IPv4 address, so the one loopback value is 127.0.0.1. */
const HEALTH_LOOPBACK = '127.0.0.1';
const CONTAINER_CGROUP = /docker|containerd|kubepods|libpod|lxc/;
const VERSION_TIMEOUT_MS = 10_000;
/** Every pin failure tells the owner exactly what to run (close other Claude Code sessions first; the probe uses the subscription). */
const RERUN = 'run: bash scripts/probe-local-cli.sh --yes';

export type GuardEnv = {
  vars: Readonly<Record<string, string | undefined>>;
  platform: string;
  execArgv: readonly string[];
  home: string;
};

export type GuardFs = {
  exists(path: string): boolean;
  /** File text, or null when it does not exist; throws when it exists but cannot be read. */
  readFile(path: string): string | null;
  isExecutable(path: string): boolean;
  /** R-L9: regular file (not a symlink) owned by the current user with mode 0600, in a 0700 directory owned by the user. */
  isOwnerOnlyFile(path: string): boolean;
  /** Gate 1 L1 path check (realpath, not group/world-writable); throws when unsafe. */
  resolveClaude(path: string): string;
  /** Hex SHA-256 of the file's bytes (streamed). */
  sha256(path: string): Promise<string>;
};

export type GuardExec = (file: string, args: string[], env: Record<string, string>) => Promise<{ code: number | null; stdout?: string }>;

export type GuardResult = { ok: true; claudePath: string; warnings?: string[] } | { ok: false; reason: string; /** fixed code when the fix is RERUN (pin missing/mismatch, old format, argv changed) */ code?: 'pin_mismatch' | 'pin_old_format' | 'argv_changed' };

/** The L10 env file, then every env file passed to node in `execArgv` (both `--flag=path` and `--flag path`). */
export function envFilesOf(execArgv: readonly string[], home: string): string[] {
  const files = [join(home, LOCAL_ENV_FILE)];
  for (let i = 0; i < execArgv.length; i++) {
    const a = execArgv[i]!;
    const m = /^--env-file(?:-if-exists)?(?:=(.*))?$/.exec(a);
    if (!m) continue;
    const path = m[1] ?? execArgv[++i];
    if (path) files.push(path);
  }
  return files;
}

/**
 * Spec §4.4 + Gate 1 L9: the local provider registers only on the owner's Mac. Every reason is fixed text
 * (no paths, no error messages). Nothing is executed until every static check has passed.
 */
export async function localProviderAllowed(env: GuardEnv, fs: GuardFs, exec: GuardExec): Promise<GuardResult> {
  const no = (reason: string, code?: 'pin_mismatch' | 'pin_old_format' | 'argv_changed'): GuardResult => ({ ok: false, reason, ...(code ? { code } : {}) });
  if (env.vars[FLAG] !== '1') return no(`${FLAG} is not 1 in the process environment`);
  // A deliberate owner choice, not a refusal: no `code`, so app.ts raises no local_provider_refused incident. Checked before any file read or spawn.
  if (localOffByOwner(env)) return no(OWNER_OFF_REASON);
  for (const f of envFilesOf(env.execArgv, env.home)) {
    let text: string | null;
    try {
      text = fs.readFile(f);
    } catch {
      return no('an env file could not be read');
    }
    if (text !== null && DEFINES_FLAG.test(text)) return no(`${FLAG} is defined in an env file; it may only come from the process environment`);
    if (text !== null && DEFINES_SKIP_PIN.test(text)) return no(`${SKIP_PIN} is defined in an env file; it may only come from the process environment`);
  }
  if (!databaseIsLoopback(env.vars.DATABASE_URL)) return no('DATABASE_URL must point at a loopback host in local mode');
  for (const k of ['PGHOST', 'PGHOSTADDR'])
    if (env.vars[k] && !hostsAreLoopback(env.vars[k]!)) return no(`${k} must be a loopback host in local mode`);
  const hh = env.vars.HEALTH_HOST;
  if (hh !== undefined && hh !== '' && hh !== HEALTH_LOOPBACK) return no('HEALTH_HOST must be 127.0.0.1 in local mode');
  if (env.platform !== 'darwin') return no('the local provider runs only on darwin (the owner Mac)');
  const container = inContainer(fs);
  if (container) return no(container);

  const found = (env.vars.PATH ?? '').split(':').filter((d) => d && isAbsolute(d)).map((d) => join(d, 'claude')).find((p) => fs.isExecutable(p));
  if (!found) return no('claude CLI not found on PATH');
  let claudePath: string;
  try {
    claudePath = fs.resolveClaude(found);
  } catch {
    return no('claude CLI path is unsafe (group- or world-writable)');
  }
  let version = '';
  try {
    const r = await exec(claudePath, ['--version'], childEnv(env.vars as NodeJS.ProcessEnv));
    if (r.code !== 0) return no('claude --version failed');
    version = (r.stdout ?? '').split('\n')[0]!.trim();
  } catch {
    return no('claude --version failed');
  }
  if (env.vars[SKIP_PIN] === '1')
    return { ok: true, claudePath, warnings: [`${SKIP_PIN}=1: the probe pin is NOT enforced; ${RERUN}`] };
  const pinPath = join(env.home, PROBE_PIN_FILE);
  const noPin = () => no(`the probe pin is missing, unsafe or does not match the installed claude; ${RERUN}`, 'pin_mismatch');
  let pin: string | null = null;
  try {
    if (fs.isOwnerOnlyFile(pinPath)) pin = fs.readFile(pinPath);
  } catch {
    return noPin();
  }
  if (pin === null) return noPin();
  const field = (k: string) => new RegExp(`^${k}=(.+)$`, 'm').exec(pin!)?.[1]?.trim();
  const pinnedVersion = field('version');
  if (!pinnedVersion || !version || pinnedVersion !== version) return noPin();
  const pinnedPath = field('realpath');
  const pinnedSha = field('sha256');
  if (!pinnedPath || !pinnedSha) return no(`the probe pin is in an old format; ${RERUN}`, 'pin_old_format');
  if (pinnedPath !== claudePath) return noPin();
  try {
    if ((await fs.sha256(claudePath)).toLowerCase() !== pinnedSha.toLowerCase()) return noPin();
  } catch {
    return noPin();
  }
  const pinnedArgv = field('argv_sha256');
  if (!pinnedArgv) return no(`the probe pin is in an old format (it does not bind the CLI arguments); ${RERUN}`, 'pin_old_format');
  if (pinnedArgv.toLowerCase() !== argvDigest()) return no(`the provider CLI arguments changed since the last probe; ${RERUN}`, 'argv_changed');
  return { ok: true, claudePath };
}

const isLoopbackHost = (h: string): boolean => LOOPBACK_HOSTS.has(h.trim().toLowerCase());
/** libpq lists: every comma-separated entry must be loopback; socket paths (leading /) are refused. */
const hostsAreLoopback = (list: string): boolean => list.split(',').every((h) => isLoopbackHost(h));

/** Unset or empty is fine (the app requires it elsewhere). Otherwise the URL host AND any `host` / `hostaddr` query parameter must be loopback. */
function databaseIsLoopback(raw: string | undefined): boolean {
  if (raw === undefined || raw === '') return true;
  try {
    const u = new URL(raw);
    if (!u.hostname || !isLoopbackHost(u.hostname)) return false;
    for (const k of ['host', 'hostaddr']) for (const v of u.searchParams.getAll(k)) if (!hostsAreLoopback(v)) return false;
    return true;
  } catch {
    return false;
  }
}

export const processGuardEnv = (): GuardEnv => ({ vars: process.env, platform: process.platform, execArgv: process.execArgv, home: homedir() });

/**
 * The container check (R5): a reason when this process runs in a container (`/.dockerenv`, a container runtime in
 * `/proc/1/cgroup`, or a cgroup file that cannot be read), null otherwise. Used by the local-provider guard and injected by app.ts
 * into the media backend selection, so local yt-dlp/ffmpeg are refused in a container.
 */
export function inContainer(fs: Pick<GuardFs, 'exists' | 'readFile'>): string | null {
  if (fs.exists('/.dockerenv')) return 'running in a container';
  let cgroup: string | null;
  try {
    cgroup = fs.readFile('/proc/1/cgroup');
  } catch {
    return 'running in a container (cgroup unreadable)';
  }
  if (cgroup !== null && CONTAINER_CGROUP.test(cgroup)) return 'running in a container';
  return null;
}

export const nodeGuardFs: GuardFs = {
  exists: (p) => existsSync(p),
  readFile: (p) => {
    try {
      return readFileSync(p, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  },
  isExecutable: (p) => {
    try {
      if (!statSync(p).isFile()) return false;
      accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  isOwnerOnlyFile: (p) => {
    try {
      const uid = process.getuid?.();
      const f = lstatSync(p);
      const d = lstatSync(dirname(p));
      return f.isFile() && f.uid === uid && (f.mode & 0o777) === 0o600 && d.isDirectory() && d.uid === uid && (d.mode & 0o777) === 0o700;
    } catch {
      return false;
    }
  },
  resolveClaude: (p) => resolveClaudePath(p),
  sha256: sha256File,
};

/** Streaming SHA-256 (the binary is large; never read it whole). */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', (c) => h.update(c)).once('error', reject).once('end', () => resolve(h.digest('hex')));
  });
}

/** `claude --version`: no shell, allowlisted env (L2), output discarded, killed after a timeout. */
export const nodeGuardExec: GuardExec = (file, args, env) =>
  new Promise((resolve) => {
    const child = spawn(file, args, { shell: false, env, stdio: ['ignore', 'pipe', 'ignore'], timeout: VERSION_TIMEOUT_MS, killSignal: 'SIGKILL' });
    let out = '';
    child.stdout.on('data', (d: Buffer) => { if (out.length < 1024) out += d.toString('utf8').slice(0, 1024); });
    child.once('error', () => resolve({ code: null }));
    child.once('close', (code) => resolve({ code, stdout: out }));
  });

/**
 * G2-PV-05: the flag provenance the guard enforces, without the later checks: exactly `1` in the process env, on darwin, and defined in no env file
 * (an unreadable env file refuses). Pure given `fs`.
 */
export function localFlagOk(env: GuardEnv, fs: Pick<GuardFs, 'readFile'>): boolean {
  if (env.vars[FLAG] !== '1' || env.platform !== 'darwin') return false;
  for (const f of envFilesOf(env.execArgv, env.home)) {
    try {
      const text = fs.readFile(f);
      if (text !== null && DEFINES_FLAG.test(text)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * R8 PV-C01: whether this process is in local mode. A test override wins; otherwise the local guard passed, or the flag passed `localFlagOk` (the guard's
 * provenance rules) AND the process is not in a container (a container never counts as the owner's Mac). Pure.
 */
export function localModeOf(i: { override: boolean | undefined; guardOk: boolean; flagOk: boolean; inContainer: boolean }): boolean {
  if (i.override !== undefined) return i.override;
  return i.guardOk || (i.flagOk && !i.inContainer);
}
