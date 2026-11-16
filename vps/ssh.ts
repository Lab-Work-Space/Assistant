import { spawn } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { childEnv } from '../core/child-env.js';
import { parseReply } from './ops.js';

/**
 * The ssh transport to the VPS (Gate 1 V1, V4, V22). Host, port and user are CONSTANTS here, not read from the environment. The key file is
 * checked on every call. Only the executor process (a separate macOS user, OD-1) can read the key; the main application never has this module's
 * inputs.
 */
export const VPS = { host: '72.60.196.53', port: 2223, user: 'assistantdeploy' } as const;
export const SSH_BIN = '/usr/bin/ssh';
export const KNOWN_HOSTS_NAME = 'known_hosts';
const REPLY_CAP = 20_000;

/** V4: every option that could widen the connection is pinned. */
export function sshArgs(keyPath: string, knownHosts: string): string[] {
  return [
    '-i', keyPath, '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ProxyCommand=none', '-o', 'ProxyJump=none', '-F', '/dev/null', '-p', String(VPS.port),
    '-o', 'HostKeyAlgorithms=ssh-ed25519', '-o', 'PubkeyAcceptedAlgorithms=ssh-ed25519', '-o', 'PreferredAuthentications=publickey',
    '-o', 'ClearAllForwardings=yes', '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'PermitLocalCommand=no', '-o', 'LocalCommand=none',
    '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4', '-o', 'LogLevel=ERROR', '-T',
    `${VPS.user}@${VPS.host}`, 'request',
  ];
}

export interface KeyDeps { uid?: number | undefined }

/** V22: regular, 0600, owned by this uid, not a symlink, outside the env.local directory; the pinned known_hosts beside it is checked the same way. */
export function keyProblem(keyPath: string, d: KeyDeps = {}): string | null {
  const uid = d.uid ?? (typeof process.getuid === 'function' ? process.getuid() : -1);
  if (!keyPath.startsWith('/') || keyPath.includes('\0') || keyPath.includes('..')) return 'the deploy key path is not an absolute plain path';
  if (keyPath.includes('/.config/assistant/')) return 'the deploy key must not live in the assistant config directory (env.local)';
  const bad = (p: string, what: string, mode: number): string | null => {
    let st;
    try { st = lstatSync(p); } catch { return `the ${what} is missing`; }
    if (st.isSymbolicLink() || !st.isFile()) return `the ${what} is not a regular file`;
    if ((st.mode & 0o777) !== mode) return `the ${what} must have mode ${mode.toString(8).padStart(4, '0')}`;
    if (st.uid !== uid) return `the ${what} is not owned by the executor user`;
    return null;
  };
  const hostsPath = join(dirname(keyPath), KNOWN_HOSTS_NAME);
  const k = bad(keyPath, 'deploy key', 0o600);
  if (k) return k;
  const h = bad(hostsPath, 'pinned known_hosts', 0o600);
  if (h) return h;
  const lines = readFileSync(hostsPath, 'utf8').split('\n').filter((l) => l.trim() !== '' && !l.startsWith('#'));
  const want = new RegExp(`^\\[${VPS.host.replace(/\./g, '\\.')}\\]:${VPS.port} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43}$`);
  if (lines.length !== 1 || !want.test(lines[0]!)) return 'the pinned known_hosts must hold exactly the one ed25519 host key line for the VPS';
  return null;
}
export const knownHostsOf = (keyPath: string): string => join(dirname(keyPath), KNOWN_HOSTS_NAME);

export type SshRun = (args: string[], input: Buffer, timeoutMs: number) => Promise<{ code: number | null; out: string }>;

export const spawnSsh: SshRun = (args, input, timeoutMs) =>
  new Promise((resolve) => {
    const c = childEnv(); // P8: never process.env; a private HOME (ssh is run with -F /dev/null and a pinned known_hosts, so nothing is read from it)
    const child = spawn(SSH_BIN, args, { stdio: ['pipe', 'pipe', 'ignore'], env: c.env, shell: false });
    let out = '';
    let done = false;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      c.cleanup();
      resolve({ code, out });
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(null); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => { if (out.length < REPLY_CAP) out += c; });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
    child.stdin.on('error', () => undefined); // the server may refuse early and close
    child.stdin.end(input);
  });

export type CallResult = { ok: true; data: Record<string, unknown> } | { ok: false; code: string };

export class VpsClient {
  constructor(private readonly d: { keyPath: string; run?: SshRun; keyCheck?: (p: string) => string | null }) {}

  /** `line` is the request line (see requestLine); `stream` follows it for publish_static. */
  async call(line: string, stream?: Buffer, timeoutMs = 180_000): Promise<CallResult> {
    const why = (this.d.keyCheck ?? ((p) => keyProblem(p)))(this.d.keyPath);
    if (why) return { ok: false, code: 'KEY' };
    const input = stream ? Buffer.concat([Buffer.from(line, 'ascii'), stream]) : Buffer.from(line, 'ascii');
    const r = await (this.d.run ?? spawnSsh)(sshArgs(this.d.keyPath, knownHostsOf(this.d.keyPath)), input, timeoutMs);
    if (r.code === null) return { ok: false, code: 'TIMEOUT' };
    const first = r.out.split('\n')[0] ?? '';
    if (r.code !== 0 && !/^ERR /.test(first)) return { ok: false, code: r.code === 255 ? 'UNREACHABLE' : 'FAILED' };
    return parseReply(first);
  }

  keyName(): string { return basename(this.d.keyPath); }
}
