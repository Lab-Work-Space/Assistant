/**
 * Unit-project guard: unit tests never reach a network (Gate 1 P12 / task 11). `fetch` and every outbound TCP connect
 * (net, http, https, tls and so discord.js and pg all go through `net.Socket#connect`) throw. A test that needs its own
 * loopback server (the health server) opts in with `allowLoopbackForTest()`; that allows 127.0.0.1, ::1 and localhost only.
 * Setup files run again for each test file, so the opt-in never leaks into another file. Integration and (later) `net`
 * projects do not load this file.
 */
import { realpathSync } from 'node:fs';
import net from 'node:net';
import { dirname, isAbsolute, sep } from 'node:path';

const STATE = Symbol.for('assistant.noNetwork.loopback');
type Holder = { [STATE]?: boolean };
const holder = globalThis as Holder;

/** Allows connections to the loopback interface for the rest of this test file. Anything else stays blocked. */
export function allowLoopbackForTest(): void {
  holder[STATE] = true;
}

const UNIX_STATE = Symbol.for('assistant.noNetwork.unixDirs');
type UnixHolder = { [UNIX_STATE]?: string[] };
const unixHolder = globalThis as UnixHolder;

/**
 * Allows `connect({path})` to unix sockets that live directly in or below `dir` (compared as real paths, so `..`, a symlinked
 * directory and a symlinked socket file cannot lead out of it) for the rest of this test file. Loopback opt-in does not imply it,
 * and TCP stays blocked.
 */
export function allowUnixSocketForTest(dir: string): void {
  (unixHolder[UNIX_STATE] ??= []).push(realpathSync(dir));
}

function unixAllowed(path: string): boolean {
  const dirs = unixHolder[UNIX_STATE];
  if (!dirs?.length || !isAbsolute(path)) return false;
  let where: string;
  try {
    where = dirname(realpathSync(path)); // resolves a symlinked socket file as well
  } catch {
    try {
      where = realpathSync(dirname(path)); // not there yet: the connect fails by itself, but only inside an allowed dir
    } catch {
      return false;
    }
  }
  return dirs.some((d) => where === d || where.startsWith(d.endsWith(sep) ? d : d + sep));
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '[::1]']);
const blocked = (what: string, target: string): Error => new Error(`no-network: ${what} to ${target} is blocked in unit tests`);
const allowed = (host: string | undefined): boolean => holder[STATE] === true && !!host && (LOOPBACK.has(host) || /^127\.\d+\.\d+\.\d+$/.test(host));

function hostOf(input: unknown): string {
  try {
    if (typeof input === 'string' || input instanceof URL) return new URL(input).hostname;
    if (input && typeof input === 'object' && 'url' in input) return new URL(String((input as { url: unknown }).url)).hostname;
  } catch {
    /* fall through */
  }
  return 'unknown host';
}

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const host = hostOf(input);
  if (allowed(host)) return realFetch(input, init);
  return Promise.reject(blocked('fetch', host));
}) as typeof fetch;

const realConnect = net.Socket.prototype.connect as (this: net.Socket, ...a: unknown[]) => net.Socket;
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]): net.Socket {
  // net.connect hands connect() the already normalised `[options, cb]` array; a direct call passes the options (or port) itself.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const opts = typeof first === 'object' && first !== null ? (first as { host?: string; path?: string; port?: number }) : null;
  const host = opts ? (opts.path ? 'unix socket' : opts.host ?? 'localhost') : typeof first === 'string' ? first : (typeof args[1] === 'string' ? args[1] : 'localhost');
  if (opts?.path) {
    if (!unixAllowed(opts.path)) throw blocked('connect', host);
  } else if (!allowed(host)) throw blocked('connect', host);
  return realConnect.apply(this, args);
} as typeof net.Socket.prototype.connect;
