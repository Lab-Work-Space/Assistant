import { createHash } from 'node:crypto';
import { redactText } from '../core/logger.js';
import { MAX_STATIC_BYTES } from './ops.js';

/**
 * Static site packing and checking (Gate 1 V15 mirrored on the Mac, spec "Static site building"). The VPS re-checks everything; these rules make
 * a bad upload fail here with a clear message and let the executor re-validate the stored tar before it sends a byte (V22).
 */
export interface StaticFile { path: string; data: Buffer }
export const STATIC_LIMITS = { files: 2000, fileBytes: 5 * 1024 * 1024, totalBytes: MAX_STATIC_BYTES, dirs: 200, depth: 20, pathBytes: 100 } as const;
export const EXT_OK = new Set(['html', 'htm', 'css', 'js', 'mjs', 'json', 'map', 'txt', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'woff', 'woff2', 'ttf', 'otf', 'xml', 'webmanifest']);
const TEXT_EXT = new Set(['html', 'htm', 'css', 'js', 'mjs', 'json', 'map', 'txt', 'svg', 'xml', 'webmanifest']);
const PART = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,254}$/;
const FORBIDDEN = new Set(['deploy.yml', 'docker-compose.yml', 'compose.yml', '.lw', 'caddyfile', '.env']);

const ext = (p: string): string => (p.includes('.') ? p.slice(p.lastIndexOf('.') + 1).toLowerCase() : '');

/** Null when the path is acceptable (no absolute path, `..`, empty or dot component; allowed extension; none of the platform's own file names). */
export function pathProblem(path: string): string | null {
  const parts = path.split('/');
  if (path.length > STATIC_LIMITS.pathBytes || parts.length > STATIC_LIMITS.depth || !parts.every((p) => PART.test(p))) return `${path.slice(0, 60)}: not a plain relative path (no dotfiles, no "..", at most ${STATIC_LIMITS.pathBytes} characters)`;
  if (parts.some((p) => FORBIDDEN.has(p.toLowerCase()))) return `${path.slice(0, 60)}: a platform file name is not allowed in an upload`;
  if (!EXT_OK.has(ext(parts.at(-1)!))) return `${path.slice(0, 60)}: this file type is not allowed on a static site`;
  return null;
}

/** Inline secrets (the redaction identity) and off-site scripts (spec: no `<script src>` to other hosts). */
export function contentProblem(path: string, data: Buffer): string | null {
  if (!TEXT_EXT.has(ext(path))) return null;
  const text = data.toString('utf8');
  if (redactText(text) !== text) return `${path}: looks like it contains a secret (a token, key or password); remove it`;
  if (ext(path) === 'html' || ext(path) === 'htm' || ext(path) === 'svg') {
    for (const m of text.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']?\s*([^"'\s>]+)/gi)) {
      if (/^(?:https?:)?\/\//i.test(m[1]!)) return `${path}: a script loaded from another site is not allowed (${m[1]!.slice(0, 60)})`;
    }
  }
  return null;
}

export function checkFiles(files: readonly StaticFile[]): string | null {
  if (files.length < 1 || files.length > STATIC_LIMITS.files) return `a site has 1 to ${STATIC_LIMITS.files} files`;
  const seen = new Set<string>();
  const dirs = new Set<string>();
  let total = 0;
  for (const f of files) {
    const why = pathProblem(f.path);
    if (why) return why;
    if (seen.has(f.path)) return `${f.path}: duplicate path`;
    seen.add(f.path);
    if (f.data.length > STATIC_LIMITS.fileBytes) return `${f.path}: a file is at most ${STATIC_LIMITS.fileBytes / 1024 / 1024} MiB`;
    total += f.data.length;
    const parts = f.path.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  if (total > STATIC_LIMITS.totalBytes) return 'the site is over 50 MiB';
  if (dirs.size > STATIC_LIMITS.dirs) return `at most ${STATIC_LIMITS.dirs} directories`;
  if (!seen.has('index.html')) return 'a static site needs an index.html at its top';
  return null;
}

const oct = (n: number, len: number): string => `${n.toString(8).padStart(len - 1, '0')}\0`;
function header(name: string, size: number, type: '0' | '5'): Buffer {
  const h = Buffer.alloc(512, 0);
  h.write(name, 0, 'ascii');
  h.write(oct(type === '5' ? 0o755 : 0o644, 8), 100, 'ascii');
  h.write(oct(0, 8), 108, 'ascii');
  h.write(oct(0, 8), 116, 'ascii');
  h.write(oct(size, 12), 124, 'ascii');
  h.write(oct(0, 12), 136, 'ascii'); // mtime 0: the archive is reproducible
  h.write('        ', 148, 'ascii');
  h.write(type, 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return h;
}

/** A plain ustar archive (no PAX, no long names): the only form the receiver reads. Files only; directories are implied by the paths. */
export function makeTar(files: readonly StaticFile[]): Buffer {
  const out: Buffer[] = [];
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    out.push(header(f.path, f.data.length, '0'), f.data, Buffer.alloc((512 - (f.data.length % 512)) % 512, 0));
  }
  out.push(Buffer.alloc(1024, 0));
  return Buffer.concat(out);
}

/** Reads back an archive under the V15 rules; anything but plain files and directories is refused. */
export function readTar(buf: Buffer): { ok: true; files: StaticFile[] } | { ok: false; error: string } {
  if (buf.length < 1024 || buf.length > STATIC_LIMITS.totalBytes + 8 * 1024 * 1024) return { ok: false, error: 'not a usable archive size' };
  if (buf[0] === 0x1f && buf[1] === 0x8b) return { ok: false, error: 'compressed archives are refused' };
  const files: StaticFile[] = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const field = (a: number, b: number): string => { const s = h.subarray(a, b); const z = s.indexOf(0); return s.subarray(0, z < 0 ? s.length : z).toString('ascii'); };
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
    if (parseInt(field(148, 156).trim() || 'x', 8) !== sum) return { ok: false, error: 'bad archive header' };
    const type = String.fromCharCode(h[156] === 0 ? 48 : h[156]!);
    const size = parseInt(field(124, 136).trim() || 'x', 8);
    if (!Number.isInteger(size) || size < 0 || field(345, 500) !== '') return { ok: false, error: 'bad archive member' };
    const name = field(0, 100).replace(/\/$/, '');
    off += 512;
    if (type === '5') {
      if (size !== 0 || pathPartsProblem(name)) return { ok: false, error: 'bad archive directory' };
    } else if (type === '0') {
      const why = pathProblem(name);
      if (why) return { ok: false, error: why };
      if (off + size > buf.length) return { ok: false, error: 'truncated archive' };
      files.push({ path: name, data: Buffer.from(buf.subarray(off, off + size)) });
      off += Math.ceil(size / 512) * 512;
    } else {
      return { ok: false, error: 'archive member type refused' }; // symlink, hardlink, device, fifo, PAX/GNU extension, contiguous
    }
  }
  const why = checkFiles(files);
  return why ? { ok: false, error: why } : { ok: true, files };
}
const pathPartsProblem = (p: string): boolean => !p.split('/').every((x) => PART.test(x)) || p.split('/').length > STATIC_LIMITS.depth;

export function packFiles(files: readonly StaticFile[]): { ok: true; tar: Buffer; sha256: string; size: number } | { ok: false; error: string } {
  const why = checkFiles(files) ?? files.map((f) => contentProblem(f.path, f.data)).find((x) => x !== null && x !== undefined) ?? null;
  if (why) return { ok: false, error: why };
  const tar = makeTar(files);
  if (tar.length > STATIC_LIMITS.totalBytes) return { ok: false, error: 'the archive is over 50 MiB' };
  return { ok: true, tar, sha256: createHash('sha256').update(tar).digest('hex'), size: tar.length };
}
