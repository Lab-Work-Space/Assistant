import { SafeFetchError, type Resolver, type safeFetch, type Transport } from '../net/guard.js';

/** P19: attachments are downloaded only from Discord's CDN (exact host names, https, default port). */
export const ATTACHMENT_HOSTS: ReadonlySet<string> = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
/** P19: size is bounded by streamed bytes, whatever Content-Length says. */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

export type AttachmentType = 'image/png' | 'image/jpeg' | 'image/webp' | 'application/pdf';
export type FetchAttachmentOptions = {
  /** The P4 guard (`safeFetch` from net/guard); a parameter only so tests can spy on it. */
  fetch: typeof safeFetch;
  resolver: Resolver;
  transport: Transport;
  maxBytes?: number;
  signal?: AbortSignal;
};

/** A refusal with fixed text (no response body, no url query) that a tool may show as is. */
export class AttachmentError extends Error {
  override readonly name = 'AttachmentError';
}

const startsWith = (b: Buffer, sig: number[] | string, at = 0) => {
  const s = typeof sig === 'string' ? Buffer.from(sig, 'latin1') : Buffer.from(sig);
  return b.length >= at + s.length && b.subarray(at, at + s.length).equals(s);
};

/** P19: the type is decided by magic bytes only (never the declared type or the file suffix). Anything else is null. */
export function sniffType(b: Buffer): AttachmentType | null {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(b, 'RIFF') && startsWith(b, 'WEBP', 8)) return 'image/webp';
  if (startsWith(b, '%PDF-')) return 'application/pdf';
  return null;
}

function discordUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AttachmentError('The attachment link is not a valid url.');
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port !== '' || !ATTACHMENT_HOSTS.has(u.hostname.toLowerCase()))
    throw new AttachmentError('Attachments are read only from Discord (cdn.discordapp.com, media.discordapp.net).');
  return u;
}

/**
 * Downloads one Discord attachment through the P4 guard (every address checked, no redirects followed: a hop off the CDN
 * would leave P19's host rule). The bytes are returned as-is for Gemini; no local image or PDF decoder ever runs.
 */
export async function fetchAttachment(url: string, o: FetchAttachmentOptions): Promise<{ mimeType: AttachmentType; data: Buffer }> {
  const u = discordUrl(url);
  const max = o.maxBytes ?? ATTACHMENT_MAX_BYTES;
  let res: Awaited<ReturnType<typeof safeFetch>>;
  try {
    // max + 1: safeFetch reports truncated on reaching its cap, so a body of exactly `max` bytes still passes.
    res = await o.fetch(u.href, {
      resolver: o.resolver, transport: o.transport, maxBytes: max + 1, maxRedirects: 0, timeoutMs: TIMEOUT_MS,
      headers: { accept: 'image/png,image/jpeg,image/webp,application/pdf' }, ...(o.signal ? { signal: o.signal } : {}),
    });
  } catch (err) {
    if (err instanceof SafeFetchError) throw new AttachmentError(`The attachment could not be downloaded (${err.code === 'blocked' ? 'refused' : err.code}).`);
    throw new AttachmentError('The attachment could not be downloaded.');
  }
  if (res.status !== 200) throw new AttachmentError(`The attachment could not be downloaded (HTTP ${res.status}).`);
  if (res.truncated || res.body.length > max) throw new AttachmentError('The attachment is larger than 10 MB.');
  const mimeType = sniffType(res.body);
  if (!mimeType) throw new AttachmentError('The attachment is not a supported image or PDF (PNG, JPEG, WebP or PDF).');
  return { mimeType, data: res.body };
}

const SUFFIX: Record<string, AttachmentType> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', pdf: 'application/pdf' };

/**
 * The type a client DECLARED (Discord's content type, else the file suffix) when it is one the readers support; otherwise null.
 * Only a cheap early filter for commands and the auto-OCR channel: the download decides by magic bytes (P19), never by this.
 */
export function declaredType(a: { name: string; contentType?: string | null }): AttachmentType | null {
  const ct = a.contentType?.split(';')[0]?.trim().toLowerCase();
  if (ct) return ct === 'image/jpg' ? 'image/jpeg' : (Object.values(SUFFIX) as string[]).includes(ct) ? (ct as AttachmentType) : null;
  const ext = /\.([a-z0-9]{1,5})$/i.exec(a.name)?.[1]?.toLowerCase();
  return (ext && SUFFIX[ext]) || null;
}
