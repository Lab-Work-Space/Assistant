/**
 * App-side client of the media sidecar (spec 4.2-4.4, 5.3; Gate 1 S1 client side, S7). HTTP/1.1 over the unix socket, one
 * connection per request (`agent:false`, so `req.destroy()` is the cancel). The sidecar is treated as hostile: every byte it sends
 * is bounded (headers 8 KiB / 20, error bodies 1 KiB, trailer 4 KiB before decoding, PCM caps, a wall-clock deadline that also
 * ends a drip) and only fixed, mapped reasons leave this file. Sidecar text (a 400 message, stderr) reaches the masked logger only.
 */
import { lstatSync, type Stats } from 'node:fs';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import type { BinaryCheck } from '../voice/binaries.js';
import { normaliseQuery, type SafeExit, type TrackHandle } from '../voice/music/source.js';
import type { MediaBackend, TrackRequestOptions } from './backend.js';
import { PCM_CAP } from './decode.js';
import { LIMITS, PROTOCOL_V, decodeExitTrailer, parseHealth, type WireExit } from './protocol.js';

export interface SocketMediaBackendOptions {
  socketPath: string;
  log: { warn(o: object, m?: string): void };
  /** Injected for tests; default fs.lstatSync. */
  lstat?: (p: string) => Stats;
  /** Wall-clock bounds (tests shorten them). Defaults: connect 2 s, health 2 s, decode 25 s, track (capSeconds + 120) s + 5 s. */
  deadlines?: { connectMs?: number; healthMs?: number; decodeMs?: number; trackMs?: (capSeconds: number) => number };
}

/** HTTP framing bounds for every reply (S7). */
const MAX_HEADER_BYTES = 8192;
const ERROR_BODY_MAX = 1024;
const HEALTH_BODY_MAX = 2048;
const DEC = 'ffmpeg could not decode the speech';
const TOO_LONG = 'the reply is too long to speak (decoded audio over its cap)';

/** Trailer reasons the server itself produces; anything else is sidecar text and becomes `sidecar-error`. */
const KNOWN_REASONS = new Set(['timeout', 'stdout-cap', 'client-closed', 'shutdown', 'ffmpeg failed to start']);
const SIGNAL_RE = /^SIG[A-Z0-9]{1,12}$/;
const DECODE_REASON = /^(timeout|exit -?\d{1,10})$/;

const reasonOf = (r: string | null): string | null => {
  if (r === null || KNOWN_REASONS.has(r)) return r;
  if (r.startsWith('spawn failed:')) return 'spawn failed';
  return 'sidecar-error';
};
const fromWire = (e: WireExit): SafeExit => ({ code: e.code, signal: e.signal !== null && SIGNAL_RE.test(e.signal) ? e.signal : null, reason: reasonOf(e.reason), stderr: e.stderr });
const failed = (reason: string): SafeExit => ({ code: null, signal: null, reason, stderr: '' });
const both = (reason: string) => ({ ytDlp: failed(reason), ffmpeg: failed(reason) });

/** PCM bytes of capSeconds of audio plus slack (the same bound the server's ffmpeg has). */
const pcmCapFor = (capSeconds: number) => capSeconds * 48_000 * 2 * 2 + 1024 * 1024;

const CONNECT_ERRORS = new Set(['ENOENT', 'ECONNREFUSED', 'EACCES', 'ENOTSOCK', 'EPERM', 'connect-timeout']);
const errCode = (e: unknown): string => (e as NodeJS.ErrnoException | null)?.code ?? (e instanceof Error ? e.message : '');

/** Reads an error body of at most `max` bytes; null when it is larger (the connection is cut) or broken. */
function readSmall(res: http.IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const parts: Buffer[] = [];
    let n = 0;
    let settled = false;
    const settle = (v: Buffer | null) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    res.on('data', (b: Buffer) => {
      n += b.length;
      if (n > max) {
        settle(null);
        res.destroy();
        return;
      }
      parts.push(b);
    });
    res.on('end', () => settle(res.complete ? Buffer.concat(parts) : null));
    res.on('error', () => settle(null));
    res.on('close', () => settle(res.complete ? Buffer.concat(parts) : null));
  });
}

const jsonOf = (b: Buffer | null): Record<string, unknown> | null => {
  if (!b) return null;
  try {
    const v: unknown = JSON.parse(b.toString('utf8'));
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** One-line, control-free, bounded copy of a sidecar string for the masked logger. */
const forLog = (x: unknown): string => (typeof x === 'string' ? x.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200) : '');

export class SocketMediaBackend implements MediaBackend {
  private readonly lstat: (p: string) => Stats;
  private readonly connectMs: number;
  private readonly healthMs: number;
  private readonly decodeMs: number;
  private readonly trackMs: (capSeconds: number) => number;

  constructor(private readonly o: SocketMediaBackendOptions) {
    this.lstat = o.lstat ?? lstatSync;
    this.connectMs = o.deadlines?.connectMs ?? LIMITS.connectTimeoutMs;
    this.healthMs = o.deadlines?.healthMs ?? LIMITS.connectTimeoutMs;
    this.decodeMs = o.deadlines?.decodeMs ?? LIMITS.decodeClientMs;
    this.trackMs = o.deadlines?.trackMs ?? ((s) => (s + 120) * 1000 + 5000);
  }

  /** S1: the path must be a socket itself (lstat: a symlink or a planted file is refused before any connect). */
  private socketOk(): boolean {
    try {
      return this.lstat(this.o.socketPath).isSocket();
    } catch {
      return false;
    }
  }

  /** A request with the header bounds, a connect timeout and a total deadline that `onDeadline` handles. */
  private request(method: string, path: string, headers: Record<string, string | number>, deadlineMs: number, onDeadline: () => void): http.ClientRequest {
    const req = http.request({ socketPath: this.o.socketPath, agent: false, method, path, headers: { Host: 'media', ...headers }, maxHeaderSize: MAX_HEADER_BYTES });
    req.maxHeadersCount = LIMITS.maxHeaders;
    const connect = setTimeout(() => req.destroy(Object.assign(new Error('connect-timeout'), { code: 'connect-timeout' })), this.connectMs);
    const total = setTimeout(onDeadline, deadlineMs);
    connect.unref?.();
    total.unref?.();
    req.once('socket', (s) => {
      if (!s.connecting) clearTimeout(connect);
      else s.once('connect', () => clearTimeout(connect));
    });
    req.once('close', () => {
      clearTimeout(connect);
      clearTimeout(total);
    });
    return req;
  }

  async health(): Promise<{ check: BinaryCheck }> {
    if (!this.socketOk()) throw new Error('sidecar-unavailable');
    const body = await new Promise<Buffer | null>((resolve) => {
      const req = this.request('GET', '/v1/health', {}, this.healthMs, () => {
        resolve(null);
        req.destroy();
      });
      req.on('error', () => resolve(null));
      req.on('response', (res) => {
        if (res.statusCode !== 200) {
          res.destroy();
          resolve(null);
          return;
        }
        void readSmall(res, HEALTH_BODY_MAX).then(resolve);
      });
      req.end();
    });
    const h = parseHealth(jsonOf(body));
    if (!h) throw new Error('sidecar-unavailable');
    return { check: h.check };
  }

  startTrack(q: string, o: TrackRequestOptions): TrackHandle {
    normaliseQuery(q, o.allowlist); // MusicInputError stays synchronous, before any I/O
    const pcm = new PassThrough();
    let settle!: (d: { ytDlp: SafeExit; ffmpeg: SafeExit }) => void;
    let settled = false;
    const done = new Promise<{ ytDlp: SafeExit; ffmpeg: SafeExit }>((r) => (settle = r)).then((d) => {
      const { ytDlp, ffmpeg } = d;
      // the warn rule of startTrack (voice/music/source.ts), applied to the sidecar's exits; stderr reaches the masked logger only
      if ((ytDlp.code !== 0 && !ytDlp.reason) || ytDlp.reason === 'timeout' || ytDlp.reason === 'stdout-cap' || ffmpeg.reason === 'stdout-cap')
        this.o.log.warn({ ytDlp: ytDlp.code, ytReason: ytDlp.reason, ffmpeg: ffmpeg.code, ffReason: ffmpeg.reason, err: ytDlp.stderr.slice(-300) }, 'music track ended abnormally');
      return d;
    });
    let req: http.ClientRequest | null = null;
    const finish = (d: { ytDlp: SafeExit; ffmpeg: SafeExit }) => {
      if (settled) return;
      settled = true;
      settle(d);
      if (!pcm.writableEnded) pcm.end(); // never destroy(err): a sidecar failure ends the track like a dead child does locally
      req?.destroy();
    };
    const fail = (reason: string) => {
      if (reason !== 'input' && !settled) this.o.log.warn({ reason }, 'media sidecar track failed');
      finish(both(reason));
    };
    const handle: TrackHandle = { pcm, kill: (why) => finish(both(why)), done };
    if (!this.socketOk()) {
      fail('sidecar-unavailable');
      return handle;
    }
    const body = JSON.stringify({ v: PROTOCOL_V, query: q, allowlist: [...o.allowlist], capSeconds: o.capSeconds, capBytes: o.capBytes });
    const r = this.request('POST', '/v1/track', { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, this.trackMs(o.capSeconds), () => finish(both('timeout')));
    req = r;
    let responded = false;
    r.on('error', (e) => {
      if (!responded) fail(CONNECT_ERRORS.has(errCode(e)) ? 'sidecar-unavailable' : 'sidecar-reset');
      else fail('sidecar-reset');
    });
    r.on('response', (res) => {
      responded = true;
      res.on('error', () => undefined);
      const status = res.statusCode ?? 0;
      if (status !== 200) {
        void readSmall(res, ERROR_BODY_MAX).then((b) => {
          const j = jsonOf(b);
          if (!b) return fail('sidecar-reset');
          if (status === 400) {
            this.o.log.warn({ status, error: forLog(j?.['error']), message: forLog(j?.['message']) }, 'media sidecar refused the track');
            return fail('input');
          }
          if (status === 503) return fail(j?.['error'] === 'busy' ? 'busy' : 'unavailable');
          return fail('unavailable');
        });
        return;
      }
      const cap = pcmCapFor(o.capSeconds);
      let n = 0;
      res.on('data', (chunk: Buffer) => {
        if (settled) return;
        n += chunk.length;
        if (n > cap) return finish(both('stdout-cap'));
        if (!pcm.write(chunk)) {
          res.pause();
          pcm.once('drain', () => res.resume());
        }
      });
      res.on('end', () => {
        if (!res.complete) return fail('sidecar-reset');
        const t = decodeExitTrailer(res.trailers['x-media-exit']);
        if (!t) return fail('sidecar-reset');
        finish({ ytDlp: fromWire(t.ytDlp), ffmpeg: fromWire(t.ffmpeg) });
      });
      res.on('close', () => {
        if (!settled) fail('sidecar-reset');
      });
    });
    r.end(body);
    return handle;
  }

  async decode(audio: Buffer): Promise<Buffer> {
    if (!this.socketOk()) throw new Error(`${DEC} (sidecar-unavailable)`);
    if (audio.length > LIMITS.decodeBodyMax) throw new Error(`${DEC} (input-cap)`); // the sidecar would answer 413
    return new Promise<Buffer>((resolve, reject) => {
      let settled = false;
      let responded = false;
      const done = (v: Buffer | Error) => {
        if (settled) return;
        settled = true;
        req.destroy();
        if (v instanceof Error) reject(v);
        else resolve(v);
      };
      const err = (why: string) => done(new Error(`${DEC} (${why})`));
      const req = this.request('POST', '/v1/decode', { 'Content-Type': 'application/octet-stream', 'Content-Length': audio.length }, this.decodeMs, () => err('timeout'));
      req.on('error', (e) => {
        if (responded) return; // a 413/503 that raced our upload wins over the write error
        err(CONNECT_ERRORS.has(errCode(e)) ? 'sidecar-unavailable' : 'sidecar-reset');
      });
      req.on('response', (res) => {
        responded = true;
        res.on('error', () => undefined);
        const status = res.statusCode ?? 0;
        if (status !== 200) {
          void readSmall(res, ERROR_BODY_MAX).then((b) => {
            const j = jsonOf(b);
            if (!b) return err('sidecar-reset');
            if (status === 413) return err('input-cap');
            if (status === 503) return err('busy');
            if (status === 500 && j?.['error'] === 'unavailable') return err('sidecar-unavailable'); // its boot check failed (M-2)
            if (status === 422 && j?.['error'] === 'decode') {
              const r = j['reason'];
              if (r === 'stdout-cap') return done(new Error(TOO_LONG));
              if (typeof r === 'string' && DECODE_REASON.test(r)) return err(r);
            }
            return err('input');
          });
          return;
        }
        const cl = res.headers['content-length'];
        if (cl === undefined || !/^\d{1,10}$/.test(cl)) return err('sidecar-reset');
        const want = Number(cl);
        if (want > PCM_CAP) return done(new Error(TOO_LONG)); // refused before reading a byte
        const buf = Buffer.allocUnsafe(want);
        let n = 0;
        res.on('data', (chunk: Buffer) => {
          if (settled) return;
          if (n + chunk.length > want) return err('sidecar-reset');
          chunk.copy(buf, n);
          n += chunk.length;
        });
        res.on('end', () => {
          if (!res.complete || n !== want) return err('sidecar-reset');
          done(buf.subarray(0, n - (n % 2))); // whole 16-bit samples only (an odd trailing byte is dropped)
        });
        res.on('close', () => err('sidecar-reset'));
      });
      req.end(audio);
    });
  }
}
