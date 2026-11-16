import { spawn } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/** Gate 1 L2: the only environment keys the CLI child ever sees. */
export const CHILD_ENV_KEYS = ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR'] as const;

/** Gate 1 L4: per-stream output cap. */
export const OUTPUT_CAP_BYTES = 1024 * 1024;
/** Gate 1 L6: SIGTERM -> SIGKILL grace. */
export const KILL_GRACE_MS = 1000;
/** After the CLI exits, how long a descendant may keep our pipes open before they are destroyed. */
export const PIPE_GRACE_MS = 250;
/** Gate 1 L6 / AC4: once a kill starts, the call resolves within this, whatever holds the pipes. */
export const STOP_DEADLINE_MS = 1800;

export type SpawnImpl = typeof spawn;

export function childEnv(parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of CHILD_ENV_KEYS) {
    const v = parent[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}

/**
 * Gate 1 L1: resolve once to an absolute realpath; refuse a non-file, or a file or any parent directory
 * that is group- or world-writable (someone else could swap the binary).
 */
export function resolveClaudePath(p: string): string {
  const real = realpathSync(p);
  const st = statSync(real);
  if (!st.isFile()) throw new Error('claude-code-local: claude path is not a file');
  for (let d = real; ; d = dirname(d)) {
    if (statSync(d).mode & 0o022) throw new Error(`claude-code-local: ${d === real ? 'claude binary' : 'a parent directory of claude'} is group- or world-writable`);
    if (dirname(d) === d) break;
  }
  return real;
}

export type CliOutcome =
  | { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null; stdout: string }
  | { kind: 'timeout' }
  | { kind: 'aborted' }
  | { kind: 'overflow' }
  | { kind: 'spawn_error' };

/** STREAM-1 (S19): line mode for stream-json: stdout is split into lines on the byte 0x0A (so a multi-byte character split across `data` events survives), each line is capped before it is parsed, the total is capped, and lines are handed on and dropped, never retained here. */
export type LineMode = { onLine: (line: string) => void; maxLineBytes: number; maxTotalBytes: number };

export type RunCliOptions = {
  path: string;
  args: string[];
  stdin: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal: AbortSignal;
  spawnImpl?: SpawnImpl;
  /** Absent: stdout is buffered whole (up to OUTPUT_CAP_BYTES) as before. */
  lines?: LineMode;
};

const groupAlive = (pid: number): boolean => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
};
const signalGroup = (pid: number, sig: NodeJS.Signals): void => {
  try {
    process.kill(-pid, sig);
  } catch {
    // ESRCH: the group is already gone
  }
};

/** Gate 1 L6: SIGTERM the whole process group, SIGKILL after the grace; resolves once the group is gone. */
async function killGroup(pid: number): Promise<void> {
  signalGroup(pid, 'SIGTERM');
  const deadline = Date.now() + KILL_GRACE_MS;
  while (groupAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  if (groupAlive(pid)) signalGroup(pid, 'SIGKILL');
  for (let i = 0; i < 20 && groupAlive(pid); i++) await new Promise((r) => setTimeout(r, 25));
}

/**
 * One CLI process in its own process group (shell:false, detached:true). stderr is counted, never kept.
 * Completion is driven by the process `exit`, not by the pipes closing: a descendant that inherited the pipes
 * (even one that escaped the group with setsid) can delay the result by at most PIPE_GRACE_MS, and a
 * timeout/abort resolves within STOP_DEADLINE_MS.
 */
export function runCli(o: RunCliOptions): Promise<CliOutcome> {
  return new Promise((resolve) => {
    if (o.signal.aborted) return resolve({ kind: 'aborted' });
    const child = (o.spawnImpl ?? spawn)(o.path, o.args, {
      cwd: o.cwd,
      env: o.env,
      shell: false,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const pid = child.pid;
    const out: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let reason: CliOutcome | undefined;
    let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let spawnFailed = false;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];

    const finish = (r: CliOutcome): void => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      o.signal.removeEventListener('abort', onAbort);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
      resolve(r);
    };
    const finishExit = (): void => {
      if (reason) return; // the kill path resolves
      if (spawnFailed || !exited) return finish({ kind: 'spawn_error' });
      if (lm && pendingBytes > 0) {
        emitLine(Buffer.concat(pending)); // the last line without a trailing newline
        pending = [];
        pendingBytes = 0;
      }
      finish({ kind: 'exit', code: exited.code, signal: exited.signal, stdout: Buffer.concat(out).toString('utf8') });
    };
    const stop = (why: CliOutcome): void => {
      if (reason || settled || exited) return;
      reason = why;
      timers.push(setTimeout(() => finish(why), STOP_DEADLINE_MS));
      void (pid !== undefined ? killGroup(pid) : Promise.resolve()).then(() => finish(why));
    };
    const onAbort = (): void => stop({ kind: 'aborted' });
    o.signal.addEventListener('abort', onAbort, { once: true });
    timers.push(setTimeout(() => stop({ kind: 'timeout' }), o.timeoutMs));

    const lm = o.lines;
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    const emitLine = (b: Buffer): void => {
      try {
        lm!.onLine(b.toString('utf8'));
      } catch {
        // a sink problem never changes the outcome
      }
    };
    /** Splits on byte 0x0A; false when a cap was hit (the call stops as overflow). */
    const onLines = (b: Buffer): boolean => {
      outBytes += b.length;
      if (outBytes > lm!.maxTotalBytes) return false;
      let start = 0;
      for (;;) {
        const nl = b.indexOf(0x0a, start);
        if (nl < 0) break;
        const piece = b.subarray(start, nl);
        if (pendingBytes + piece.length > lm!.maxLineBytes) return false;
        emitLine(pending.length ? Buffer.concat([...pending, piece]) : piece);
        pending = [];
        pendingBytes = 0;
        start = nl + 1;
      }
      if (start < b.length) {
        const rest = b.subarray(start);
        pendingBytes += rest.length;
        if (pendingBytes > lm!.maxLineBytes) return false;
        pending.push(Buffer.from(rest));
      }
      return true;
    };
    child.stdout?.on('data', (b: Buffer) => {
      if (reason || settled) return;
      if (lm) {
        if (!onLines(b)) stop({ kind: 'overflow' });
        return;
      }
      outBytes += b.length;
      if (outBytes > OUTPUT_CAP_BYTES) return stop({ kind: 'overflow' });
      out.push(b);
    });
    child.stderr?.on('data', (b: Buffer) => {
      errBytes += b.length;
      if (errBytes > OUTPUT_CAP_BYTES) stop({ kind: 'overflow' });
    });
    // Destroyed pipes and EPIPE (child exited before reading stdin) are expected here.
    child.stdin?.on('error', () => {});
    child.stdout?.on('error', () => {});
    child.stderr?.on('error', () => {});
    child.stdin?.end(o.stdin);

    child.on('error', () => {
      spawnFailed = true;
      if (pid === undefined) finish({ kind: 'spawn_error' });
    });
    child.on('exit', (code, sig) => {
      exited = { code, signal: sig };
      if (reason) return;
      for (const t of timers) clearTimeout(t);
      if (pid !== undefined) signalGroup(pid, 'SIGKILL'); // nothing the CLI left in its group outlives the call
      timers.push(setTimeout(finishExit, PIPE_GRACE_MS)); // 'close' normally comes first
    });
    child.on('close', () => {
      if (exited) finishExit();
    });
  });
}
