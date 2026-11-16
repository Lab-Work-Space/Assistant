/**
 * Shared pieces of the local media relays (docs/superpowers/specs/2026-11-02-local-media-sidecar-design.md; Gate 1 LM2-LM5).
 * Imports are node:* only (media/graph.test.ts enforces it). Nothing here spawns a process or logs a token or a received line.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type net from 'node:net';

/** The first line a client must send: `LWMEDIA1 <48 hex>\n`. */
export const MAGIC = 'LWMEDIA1 ';
export const MAX_LINE = 128;
export const AUTH_MS = 2000;
export const IDLE_MS = 5 * 60_000;
export const MAX_CONN = 16;
export const RELAY_PORT = 9225;
export const TOKEN_RE = /^[0-9a-f]{48}$/;

const digest = (b: Buffer | string): Buffer => createHash('sha256').update(b).digest();

/** Constant-time equality of two values of any length (SHA-256 digests of both, then timingSafeEqual). */
export function safeEqual(a: Buffer | string, b: Buffer | string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

/** True when `line` (without its newline) is exactly `LWMEDIA1 <token>`: one space, no CR, no other whitespace. */
export function tokenLineOk(line: Buffer, token: string): boolean {
  return safeEqual(line, MAGIC + token);
}

export type Level = 'info' | 'warn' | 'error';
export type RelayLog = (level: Level, fields: Record<string, string | number>, msg: string) => void;

/** One JSON line per event on stderr. Callers pass fixed reasons and key names only. */
export const stderrLog: RelayLog = (level, fields, msg) => {
  process.stderr.write(`${JSON.stringify({ level, msg, ...fields })}\n`);
};

/**
 * Pipes two sockets both ways with backpressure (pipe). Either side closing, erroring or idling for `idleMs` destroys both,
 * so no half-open socket is left behind.
 */
export function bridge(a: net.Socket, b: net.Socket, idleMs: number = IDLE_MS): void {
  const kill = (): void => {
    a.destroy();
    b.destroy();
  };
  for (const s of [a, b]) {
    s.on('error', kill);
    s.on('close', kill);
    s.setTimeout(idleMs, kill);
  }
  a.pipe(b);
  b.pipe(a);
}

/**
 * Reads the pre-auth token line off a fresh socket. Resolves with the bytes after the newline (to be forwarded) or null when
 * the connection was destroyed: no newline within MAX_LINE bytes (`oversize`), no line within `authMs` (`timeout`), wrong
 * line (`bad-token`). The socket is paused again when it resolves, so the caller decides when bytes flow.
 */
export function readTokenLine(sock: net.Socket, token: string, authMs: number, log: RelayLog): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (rest: Buffer | null, reason?: string): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.off('data', onData);
      sock.off('close', onClose);
      sock.pause();
      if (rest === null) {
        if (reason) log('warn', { reason }, 'connection refused');
        sock.destroy();
      }
      resolve(rest);
    };
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl < 0 ? buf.length > MAX_LINE : nl > MAX_LINE) return finish(null, 'oversize');
      if (nl < 0) return;
      if (!tokenLineOk(buf.subarray(0, nl), token)) return finish(null, 'bad-token');
      finish(buf.subarray(nl + 1));
    };
    const onClose = (): void => finish(null);
    const timer = setTimeout(() => finish(null, 'timeout'), authMs);
    sock.on('data', onData);
    sock.on('close', onClose);
    sock.on('error', () => sock.destroy());
  });
}
