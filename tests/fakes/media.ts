/**
 * Helpers for the media IPC suites (media/*.test.ts): a short socket directory (macOS sun_path is 104 bytes), the unit-guard
 * opt-in for it, a raw HTTP/1.1 caller over a unix socket and process-group checks. Tests only; `tests/` is never built.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowUnixSocketForTest } from '../../vitest.setup.no-network.js';

export const BIN = join(dirname(fileURLToPath(import.meta.url)), 'bin');
export const YT = join(BIN, 'yt-dlp');
export const FF = join(BIN, 'ffmpeg');
export const JS = join(BIN, 'js-runtime');
export const ALLOW = ['youtube.com', 'www.youtube.com'];
export const VERSIONS = { ytDlp: '2026.10.26', ffmpeg: '9.0.2' };

/** A fresh 0755 directory under the OS temp dir (mkdtemp makes 0700), allowed for unix-socket connects in this test file. */
export function sockDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'm-'));
  chmodSync(d, 0o755);
  allowUnixSocketForTest(d);
  return d;
}

export const rmDir = (d: string | null): void => {
  if (d) rmSync(d, { recursive: true, force: true });
};

/** Leaves a socket inode at `path` that nothing listens on (net.Server#close unlinks its own path, so listen elsewhere and rename). */
export async function staleSocket(path: string): Promise<void> {
  const tmp = `${path}.t`;
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(tmp, r));
  renameSync(tmp, path);
  await new Promise<void>((r) => s.close(() => r()));
}

export type Reply = { status: number; headers: http.IncomingHttpHeaders; body: Buffer; trailers: NodeJS.Dict<string> };

/** One request over the socket. `body: null` sends the headers only and keeps the request open (a held upload). */
export function call(socketPath: string, method: string, path: string, o: { body?: Buffer | string | null; headers?: Record<string, string> } = {}): Promise<Reply> & { req: http.ClientRequest } {
  let req!: http.ClientRequest;
  const p = new Promise<Reply>((resolve, reject) => {
    req = http.request({ socketPath, agent: false, method, path, headers: o.headers ?? {} }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (b: Buffer) => parts.push(b));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts), trailers: res.trailers }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (o.body === null) req.flushHeaders();
    else req.end(o.body ?? undefined);
  });
  return Object.assign(p, { req });
}

export const json = (r: Reply): unknown => JSON.parse(r.body.toString('utf8'));

/** Every "pids <a> <b>" line of a fake's pid file. */
export function readPids(file: string): number[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).flatMap((l) => l.split(' ').slice(1).map(Number));
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};

/** Resolves true once none of `pids` exists (kill(pid, 0) gives ESRCH), false after `ms`. */
export async function allGone(pids: number[], ms = 2000): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (!pids.some(alive)) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Polls until `f()` is true or `ms` passes. */
export async function until(f: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
  return true;
}

/** Best-effort SIGKILL for pids a failed test may leave (never throws). */
export function reap(pids: number[]): void {
  for (const p of pids) {
    try {
      process.kill(p, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
}
