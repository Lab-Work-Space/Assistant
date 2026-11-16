/**
 * The media sidecar's HTTP/1.1 server over one unix socket (spec 5.1/5.2, Gate 1 S1). It holds no secret: the app sends a track
 * request or encoded speech, and this process re-validates the input, builds argv itself (startTrack/buildYtDlpArgs,
 * decodeToPcm/buildFfmpegArgs) and runs every child through spawnSafe. Request bodies and PCM are never logged.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, renameSync, unlinkSync, type Stats } from 'node:fs';
import http from 'node:http';
import { dirname } from 'node:path';
import type { BinaryCheck } from '../voice/binaries.js';
import { MusicInputError, normaliseQuery, startTrack, type TrackHandle } from '../voice/music/source.js';
import { DECODE_TIMEOUT_MS, PCM_CAP, decodeToPcm } from './decode.js';
import { LIMITS, PROTOCOL_V, ProtocolError, encodeExitTrailer, parseTrackRequest, toWireExit, type HealthBody, type TrackRequest } from './protocol.js';

/** A start refusal (socket directory or socket path not as required). The sidecar entry exits with `exitCode`. */
export class MediaServerRefusal extends Error {
  override readonly name = 'MediaServerRefusal';
  readonly exitCode = 78;
}

export interface MediaServerOptions {
  socketPath: string;
  ytDlp: string;
  ffmpeg: string;
  jsRuntime: string;
  /** Computed once at start (hash before exec) and reported by /v1/health. */
  check: BinaryCheck;
  versions: { ytDlp: string; ffmpeg: string };
  cookiesFile?: string;
  /** Tests only (the fakes' FAKE_* switches); childEnv still refuses secret names. */
  extraEnv?: Record<string, string>;
  log: { warn(o: object, m?: string): void; info(o: object, m?: string): void };
  /** Injected for tests (a foreign-owner directory); default fs.lstatSync / process.geteuid. */
  lstat?: (p: string) => Stats;
  geteuid?: () => number;
}

export interface MediaServer {
  close(): Promise<void>;
  active(): { tracks: number; decodes: number };
  killAll(why: string): void;
}

const ROUTES: Record<string, string> = { '/v1/health': 'GET', '/v1/track': 'POST', '/v1/decode': 'POST' };
const DIGITS = /^\d{1,10}$/;
/** A track body over 8 KiB is refused; up to this many bytes are read and dropped first so the 400 reaches the client. */
const TRACK_DRAIN = 65536;
const DECODE_REASON = /^(stdout-cap|timeout|exit -?\d{1,10})$/;

const errno = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | null)?.code;

/** S1 + R4: the directory is a real 0755 directory owned by our euid; at the socket path only a stale socket may be removed. */
function prepareSocketPath(o: MediaServerOptions): void {
  const lstat = o.lstat ?? lstatSync;
  const euid = (o.geteuid ?? process.geteuid)?.();
  const dir = dirname(o.socketPath);
  let d: Stats;
  try {
    d = lstat(dir);
  } catch (e) {
    throw new MediaServerRefusal(`socket directory ${dir} is not usable (${errno(e) ?? 'error'})`);
  }
  if (!d.isDirectory()) throw new MediaServerRefusal(`socket directory ${dir} must be a directory (not a symlink)`);
  if (euid !== undefined && d.uid !== euid) throw new MediaServerRefusal(`socket directory ${dir} must be owned by uid ${euid}`);
  if ((d.mode & 0o7777) !== 0o755) throw new MediaServerRefusal(`socket directory ${dir} must have mode 0755`);
  let s: Stats;
  try {
    s = lstat(o.socketPath);
  } catch (e) {
    if (errno(e) === 'ENOENT') return;
    throw new MediaServerRefusal(`socket path is not usable (${errno(e) ?? 'error'})`);
  }
  if (!s.isSocket()) throw new MediaServerRefusal('socket path holds something other than a socket; refusing to replace it');
  unlinkSync(o.socketPath); // a stale socket from an earlier run (the volume outlives the container)
}

function sendJson(res: http.ServerResponse, status: number, body: object, close = false): void {
  if (res.headersSent || res.destroyed) return;
  const s = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s), ...(close ? { Connection: 'close' } : {}) });
  res.end(s);
}

/**
 * Reads at most `max` bytes; null when the body is larger or the request is aborted. Bytes past `max` are drained (so the
 * caller's reply reaches a well-behaved client) up to `drainMax`, after which the connection is cut.
 */
function readBody(req: http.IncomingMessage, max: number, drainMax = max): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const parts: Buffer[] = [];
    let n = 0;
    let over = false;
    let settled = false;
    const settle = (v: Buffer | null) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    req.on('data', (b: Buffer) => {
      n += b.length;
      if (n > drainMax) {
        settle(null);
        req.destroy();
        return;
      }
      if (n > max) {
        over = true;
        parts.length = 0;
        return;
      }
      parts.push(b);
    });
    req.on('end', () => settle(over ? null : Buffer.concat(parts)));
    req.on('aborted', () => settle(null));
    req.on('error', () => settle(null));
    req.on('close', () => settle(req.complete && !over ? Buffer.concat(parts) : null));
  });
}

/** The fixed reason of a decodeToPcm error (never raw text: the app maps it to a user string). */
function decodeReason(err: unknown): string {
  const m = err instanceof Error ? err.message : '';
  if (m.startsWith('the reply is too long to speak')) return 'stdout-cap';
  const r = /\(([^()]*)\)$/.exec(m)?.[1] ?? '';
  return DECODE_REASON.test(r) ? r : 'error';
}

export async function startMediaServer(o: MediaServerOptions): Promise<MediaServer> {
  prepareSocketPath(o);
  const lstat = o.lstat ?? lstatSync;
  const tracks = new Set<TrackHandle>();
  const decodes = new Set<AbortController>();
  let slotsTracks = 0;
  let slotsDecodes = 0;
  const env = o.extraEnv ? { extraEnv: o.extraEnv } : {};

  const health = (res: http.ServerResponse) => {
    const body: HealthBody = { v: PROTOCOL_V, check: o.check, versions: o.versions, busy: { tracks: slotsTracks, decodes: slotsDecodes } };
    sendJson(res, 200, body);
  };

  // Final review M-2: a binary whose boot check failed (missing or wrong hash) is never executed, even if a caller asks.
  const checked = o.check.ok;

  const onTrack = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (!checked) return sendJson(res, 503, { error: 'unavailable' }, true); // the client maps it to `unavailable`: the queue pauses
    if (slotsTracks >= LIMITS.tracks) return sendJson(res, 503, { error: 'busy' }, true);
    slotsTracks++;
    let handed = false; // once the track runs, its done releases the slot
    try {
      const cl = req.headers['content-length'];
      if (cl !== undefined && (!DIGITS.test(cl) || Number(cl) > TRACK_DRAIN)) return sendJson(res, 400, { error: 'request', message: 'body too large' }, true);
      const raw = await readBody(req, LIMITS.trackBody, TRACK_DRAIN);
      if (!raw) return sendJson(res, 400, { error: 'request', message: 'body too large or incomplete' }, true);
      let parsed: TrackRequest;
      try {
        parsed = parseTrackRequest(JSON.parse(raw.toString('utf8')) as unknown);
        normaliseQuery(parsed.query, parsed.allowlist);
      } catch (e) {
        if (e instanceof MusicInputError) return sendJson(res, 400, { error: 'input', message: e.message });
        const message = e instanceof ProtocolError ? e.message : 'body is not JSON';
        o.log.warn({ err: message }, 'media track request refused');
        return sendJson(res, 400, { error: 'request', message });
      }
      if (res.destroyed) return;
      const allowlist = parsed.allowlist;
      let track: TrackHandle;
      try {
        track = startTrack(parsed.query, {
          ytDlp: o.ytDlp, ffmpeg: o.ffmpeg, jsRuntime: o.jsRuntime, allowlist: () => allowlist, capBytes: parsed.capBytes, capSeconds: parsed.capSeconds,
          timeoutMs: (parsed.capSeconds + 120) * 1000, log: o.log, ...(o.cookiesFile ? { cookiesFile: o.cookiesFile } : {}), ...env,
        });
      } catch (e) {
        o.log.warn({ err: e instanceof Error ? e.message.slice(0, 200) : 'error' }, 'media track could not start');
        return sendJson(res, 500, { error: 'start' });
      }
      handed = true;
      tracks.add(track);
      void track.done.finally(() => {
        tracks.delete(track);
        slotsTracks--;
      });
      let finished = false;
      res.on('close', () => {
        if (finished) return;
        track.kill('client-closed');
        track.pcm.resume(); // drain to 'end' so this handler settles once the children are gone
      });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Transfer-Encoding': 'chunked', Trailer: 'X-Media-Exit' });
      track.pcm.on('error', () => undefined);
      track.pcm.pipe(res, { end: false });
      const pcmEnded = new Promise<void>((r) => {
        track.pcm.once('end', () => r());
        track.pcm.once('close', () => r());
      });
      const [done] = await Promise.all([track.done, pcmEnded]);
      if (res.destroyed) return;
      let trailer: string;
      try {
        trailer = encodeExitTrailer({ ytDlp: toWireExit(done.ytDlp), ffmpeg: toWireExit(done.ffmpeg) });
      } catch {
        o.log.warn({}, 'media exit trailer did not fit; resetting the reply');
        res.destroy(); // no trailer: the client reads sidecar-reset, never a normal end
        return;
      }
      track.pcm.unpipe(res);
      finished = true;
      res.addTrailers({ 'X-Media-Exit': trailer });
      res.end();
    } finally {
      if (!handed) slotsTracks--;
    }
  };

  const onDecode = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const cl = req.headers['content-length'];
    if (cl === undefined) return sendJson(res, 411, { error: 'length' }, true);
    if (!DIGITS.test(cl) || Number(cl) > LIMITS.decodeBodyMax) return sendJson(res, 413, { error: 'too-large' }, true);
    if (!checked) {
      await readBody(req, 0, LIMITS.decodeBodyMax); // drained like the 503 below, so the reply is read, not a reset mid-upload
      return sendJson(res, 500, { error: 'unavailable' }, true); // not 503: the client reads a 503 as `busy`
    }
    if (slotsDecodes >= LIMITS.decodes) {
      await readBody(req, 0, LIMITS.decodeBodyMax); // drain (CL is already ≤ 4 MiB) so the 503 is read, not a reset mid-upload
      return sendJson(res, 503, { error: 'busy' }, true);
    }
    slotsDecodes++;
    const ac = new AbortController();
    decodes.add(ac);
    res.on('close', () => {
      if (!res.writableFinished) ac.abort('client-closed');
    });
    try {
      const audio = await readBody(req, LIMITS.decodeBodyMax);
      if (!audio || ac.signal.aborted) return sendJson(res, 400, { error: 'request', message: 'body incomplete' }, true);
      let pcm: Buffer;
      try {
        pcm = await decodeToPcm(audio, { ffmpeg: o.ffmpeg, timeoutMs: DECODE_TIMEOUT_MS, capBytes: PCM_CAP, signal: ac.signal, ...env });
      } catch (e) {
        return sendJson(res, 422, { error: 'decode', reason: decodeReason(e) });
      }
      if (res.destroyed) return;
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': pcm.length });
      res.end(pcm);
    } finally {
      decodes.delete(ac);
      slotsDecodes--;
    }
  };

  const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 30_000 }, (req, res) => {
    req.on('error', () => undefined);
    res.on('error', () => undefined);
    const url = req.url ?? '';
    const method = ROUTES[url];
    if (!method) return sendJson(res, 404, { error: 'not-found' }, true);
    if (req.method !== method) return sendJson(res, 405, { error: 'method' }, true);
    if (url === '/v1/health') return health(res);
    const run = url === '/v1/track' ? onTrack : onDecode;
    run(req, res).catch((e: unknown) => {
      o.log.warn({ err: e instanceof Error ? e.message.slice(0, 200) : 'error' }, 'media request failed');
      if (!res.headersSent) sendJson(res, 500, { error: 'internal' }, true);
      else res.destroy();
    });
  });
  server.headersTimeout = LIMITS.headersTimeoutMs;
  server.maxHeadersCount = LIMITS.maxHeaders;
  server.on('clientError', (_e, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    else socket.destroy();
  });

  // Bound under a private name, then renamed into place: libuv unlinks the name it bound when the server closes, and that must
  // never be MEDIA_SOCKET, which a newer sidecar may own by then. close() below removes MEDIA_SOCKET only while it is still our inode.
  // Random, not the pid: two sidecar containers both run as pid 1 during a rolling restart and must never share this name.
  const bindPath = `${o.socketPath}.${randomBytes(4).toString('hex')}`;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(bindPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  let ours: { dev: number; ino: number };
  try {
    chmodSync(bindPath, 0o666); // uid 1000 (the app) needs write permission on the inode to connect (S1)
    const st = lstat(bindPath); // read before the rename: a rename keeps the inode, and the path may be another sidecar's a moment later
    ours = { dev: st.dev, ino: st.ino };
    renameSync(bindPath, o.socketPath);
  } catch (e) {
    server.close();
    throw new MediaServerRefusal(`could not set up the socket (${errno(e) ?? 'error'})`);
  }
  o.log.info({ socket: o.socketPath }, 'media sidecar listening');

  const killAll = (why: string) => {
    for (const t of tracks) t.kill(why);
    for (const ac of decodes) ac.abort(why);
  };
  let closing: Promise<void> | null = null;
  return {
    active: () => ({ tracks: slotsTracks, decodes: slotsDecodes }),
    killAll,
    close: () =>
      (closing ??= new Promise<void>((resolve) => {
        killAll('shutdown');
        server.close(() => resolve());
        server.closeAllConnections();
      }).then(() => {
        try {
          const st = lstat(o.socketPath);
          if (st.isSocket() && st.dev === ours.dev && st.ino === ours.ino) unlinkSync(o.socketPath); // never a newer sidecar's socket
        } catch {
          /* already gone */
        }
      })),
  };
}
