/**
 * Wire protocol of the media sidecar (spec 5.2/5.3, Gate 1 S7). Imported by both the app-side client and the secret-free sidecar,
 * so it imports `node:*` only (no zod, no config). Everything a peer sends is parsed here with strict shape and size limits.
 */
import type { BinaryCheck } from '../voice/binaries.js';
import type { SafeExit } from '../voice/music/source.js';

export const PROTOCOL_V = 1 as const;

export const LIMITS = {
  trackBody: 8192,
  query: 300,
  allowlistMax: 20,
  capSecondsMax: 1200,
  capBytesMax: 52428800,
  trailerMax: 4096,
  reasonMax: 200,
  stderrMax: 300,
  decodeBodyMax: 4194304,
  maxHeaders: 20,
  headersTimeoutMs: 5000,
  connectTimeoutMs: 2000,
  decodeServerMs: 20000,
  decodeClientMs: 25000,
  tracks: 2,
  decodes: 2,
} as const;

/** A copy of the `media.ytHostAllowlist` regex in config/schema.ts (pinned by a parity test; the sidecar cannot import zod). */
export const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** The schema's `.refine`: all-numeric dotted names and names ending in a numeric or hex label read as an IP address. Also any `[`..`]` or `:` form. */
export function isIpLiteral(h: string): boolean {
  return /^[0-9.]+$/.test(h) || /\.(0x[0-9a-f]*|[0-9]+)$/i.test(h) || h.startsWith('[') || h.includes(':');
}

export class ProtocolError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

export type TrackRequest = { v: 1; query: string; allowlist: string[]; capSeconds: number; capBytes: number };

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const onlyKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
const intIn = (x: unknown, min: number, max: number): x is number => typeof x === 'number' && Number.isInteger(x) && x >= min && x <= max;

/** Validates a decoded `POST /v1/track` body. Unknown keys, missing keys and wrong types are refused with 400. */
export function parseTrackRequest(body: unknown): TrackRequest {
  const bad = (m: string): never => {
    throw new ProtocolError(400, m);
  };
  if (!isRecord(body)) return bad('body must be an object');
  if (!onlyKeys(body, ['v', 'query', 'allowlist', 'capSeconds', 'capBytes'])) return bad('unexpected or missing field');
  if (body['v'] !== PROTOCOL_V) return bad('unsupported protocol version');
  const { query, allowlist, capSeconds, capBytes } = body;
  if (typeof query !== 'string' || query.length < 1 || query.length > LIMITS.query) return bad('query must be 1..300 characters');
  if (!Array.isArray(allowlist) || allowlist.length < 1 || allowlist.length > LIMITS.allowlistMax) return bad('allowlist must have 1..20 hosts');
  for (const h of allowlist) {
    if (typeof h !== 'string' || h.length < 1 || h.length > 253 || !HOST_RE.test(h) || isIpLiteral(h)) return bad('allowlist entry must be a lower-case host name');
  }
  if (!intIn(capSeconds, 1, LIMITS.capSecondsMax)) return bad('capSeconds must be an integer 1..1200');
  if (!intIn(capBytes, 1, LIMITS.capBytesMax)) return bad('capBytes must be an integer 1..52428800');
  return { v: PROTOCOL_V, query, allowlist: allowlist as string[], capSeconds, capBytes };
}

export type WireExit = { code: number | null; signal: string | null; reason: string | null; stderr: string };
export type ExitTrailer = { ytDlp: WireExit; ffmpeg: WireExit };

const CONTROL = /[\u0000-\u001f\u007f]/g;
const CONTROL_TEST = /[\u0000-\u001f\u007f]/;
const clean = (s: string, max: number): string => s.replace(CONTROL, '').slice(0, max);

export function toWireExit(e: SafeExit): WireExit {
  return {
    code: e.code,
    signal: e.signal === null ? null : clean(e.signal, 32),
    reason: e.reason === null ? null : clean(e.reason, LIMITS.reasonMax),
    stderr: clean(e.stderr, LIMITS.stderrMax),
  };
}

const parseWireExit = (x: unknown): WireExit | null => {
  if (!isRecord(x) || !onlyKeys(x, ['code', 'signal', 'reason', 'stderr'])) return null;
  const { code, signal, reason, stderr } = x;
  if (code !== null && !intIn(code, -2147483648, 2147483647)) return null;
  if (signal !== null && (typeof signal !== 'string' || signal.length > 32 || CONTROL_TEST.test(signal))) return null;
  if (reason !== null && (typeof reason !== 'string' || reason.length > LIMITS.reasonMax || CONTROL_TEST.test(reason))) return null;
  if (typeof stderr !== 'string' || stderr.length > LIMITS.stderrMax) return null;
  return { code, signal, reason, stderr: stderr.replace(CONTROL, '') };
};

const B64URL = /^[A-Za-z0-9_-]*$/;
const enc = (x: ExitTrailer): string => Buffer.from(JSON.stringify(x), 'utf8').toString('base64url');

/** base64url JSON of both exits, at most 4 KiB. Shrinks stderr (then reason) of a pathological value before giving up. */
export function encodeExitTrailer(x: ExitTrailer): string {
  let cur: ExitTrailer = { ytDlp: { ...x.ytDlp }, ffmpeg: { ...x.ffmpeg } };
  for (const field of ['stderr', 'reason'] as const) {
    for (let max: number = LIMITS[field === 'stderr' ? 'stderrMax' : 'reasonMax']; ; max = Math.floor(max / 2)) {
      const shrink = (e: WireExit): WireExit => (e[field] === null ? e : { ...e, [field]: e[field].slice(0, max) });
      cur = { ytDlp: shrink(cur.ytDlp), ffmpeg: shrink(cur.ffmpeg) };
      const s = enc(cur);
      if (s.length <= LIMITS.trailerMax) return s;
      if (max === 0) break;
    }
  }
  throw new Error('exit trailer does not fit in 4 KiB');
}

/** Null for anything but a well-formed trailer: absent, oversize (checked before decoding), not base64url, not JSON, wrong shape. */
export function decodeExitTrailer(s: string | undefined): ExitTrailer | null {
  if (typeof s !== 'string' || s.length === 0 || s.length > LIMITS.trailerMax || !B64URL.test(s)) return null;
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!isRecord(v) || !onlyKeys(v, ['ytDlp', 'ffmpeg'])) return null;
  const ytDlp = parseWireExit(v['ytDlp']);
  const ffmpeg = parseWireExit(v['ffmpeg']);
  return ytDlp && ffmpeg ? { ytDlp, ffmpeg } : null;
}

export type HealthBody = {
  v: 1;
  check: BinaryCheck;
  versions: { ytDlp: string; ffmpeg: string };
  busy: { tracks: number; decodes: number };
};

const VERSION_RE = /^[0-9A-Za-z.+-]{1,64}$/;
// Only the two names checkBinaries emits: binaryGroupsDisabled puts them into the disabled alert, so no other sidecar text may pass (S7).
const names = (x: unknown): x is string[] => Array.isArray(x) && x.length <= 2 && x.every((n) => n === 'yt-dlp' || n === 'ffmpeg');

/** Strict parse of `GET /v1/health`: the app never trusts the sidecar's text, so versions are charset and length bound (S7). */
export function parseHealth(body: unknown): HealthBody | null {
  if (!isRecord(body) || !onlyKeys(body, ['v', 'check', 'versions', 'busy']) || body['v'] !== PROTOCOL_V) return null;
  const c = body['check'];
  let check: BinaryCheck;
  if (isRecord(c) && c['ok'] === true && onlyKeys(c, ['ok'])) check = { ok: true };
  else if (isRecord(c) && c['ok'] === false && onlyKeys(c, ['ok', 'missing', 'mismatched']) && names(c['missing']) && names(c['mismatched'])) {
    check = { ok: false, missing: c['missing'], mismatched: c['mismatched'] };
  } else return null;
  const v = body['versions'];
  if (!isRecord(v) || !onlyKeys(v, ['ytDlp', 'ffmpeg'])) return null;
  const { ytDlp, ffmpeg } = v;
  if (typeof ytDlp !== 'string' || typeof ffmpeg !== 'string' || !VERSION_RE.test(ytDlp) || !VERSION_RE.test(ffmpeg)) return null;
  const b = body['busy'];
  if (!isRecord(b) || !onlyKeys(b, ['tracks', 'decodes']) || !intIn(b['tracks'], 0, 1000) || !intIn(b['decodes'], 0, 1000)) return null;
  return { v: PROTOCOL_V, check, versions: { ytDlp, ffmpeg }, busy: { tracks: b['tracks'], decodes: b['decodes'] } };
}
