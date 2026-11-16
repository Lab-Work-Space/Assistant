import { inflateRawSync } from 'node:zlib';
import { crc32 } from '../workspaces/zip.js';
import { ZIP_MAX_ENTRIES, ZIP_MAX_FILE, ZIP_MAX_TOTAL } from './caps.js';

/**
 * R7 PLUGIN-FORGE (spec 5.4 Z, PF-C1; global backend rule 11): the strict reader for exactly what `workspaces/zip.ts buildZip` emits, and nothing else.
 * The central directory is read and bounded FIRST: entry count, every declared size and the declared total are checked before the first inflate. The EOCD sits at exactly `length - 22`
 * (comment length 0, so there are no trailing bytes), the central directory ends at the EOCD, and the local entries are contiguous from offset 0 to the central directory (no gap, no
 * overlap, ascending). Attributes, disk fields, extra and comment fields, flags, time and date must be what buildZip writes. Exact duplicate names are refused. Inflate output is capped at the
 * declared size and must equal it; the CRC-32 must match. Any failure returns null (the caller maps it to `zip_bad`); nothing here throws and nothing echoes content.
 */
export interface ZipEntry { name: string; data: Buffer }

const DOS_DATE = 0x21;
const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

interface Central { name: string; nameBytes: Buffer; method: number; crc: number; csize: number; usize: number; offset: number }

export function readZip(buf: Buffer): ZipEntry[] | null {
  const r = readZipResult(buf);
  return r.ok ? r.entries : null;
}

/** `too_big`: a declared size or total over the caps (spec 5.4 S maps it to `too_big`; every other refusal is `bad`, i.e. `zip_bad`). */
export type ZipResult = { ok: true; entries: ZipEntry[] } | { ok: false; reason: 'bad' | 'too_big' };
const BAD = { ok: false, reason: 'bad' } as const;
const BIG = { ok: false, reason: 'too_big' } as const;

export function readZipResult(buf: Buffer): ZipResult {
  try {
    return read(buf);
  } catch {
    return BAD;
  }
}

function read(buf: Buffer): ZipResult {
  if (!Buffer.isBuffer(buf) || buf.length < 22) return BAD;
  const eocd = buf.length - 22;
  if (buf.readUInt32LE(eocd) !== EOCD_SIG) return BAD;
  if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0) return BAD; // disk fields
  const n = buf.readUInt16LE(eocd + 10);
  if (buf.readUInt16LE(eocd + 8) !== n || n > ZIP_MAX_ENTRIES) return BAD;
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt16LE(eocd + 20) !== 0) return BAD; // EOCD comment
  if (cdOff + cdSize !== eocd) return BAD; // the central directory ends where the EOCD starts: nothing after, nothing between

  // 1. the whole central directory, before any local header is read or any byte is inflated
  const cds: Central[] = [];
  let p = cdOff;
  let declared = 0;
  const seen = new Set<string>();
  for (let i = 0; i < n; i++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== CENTRAL_SIG) return BAD;
    if (buf.readUInt16LE(p + 4) !== 20 || buf.readUInt16LE(p + 6) !== 20) return BAD; // version made by / needed
    if (buf.readUInt16LE(p + 8) !== 0) return BAD; // flags
    const method = buf.readUInt16LE(p + 10);
    if (method !== 0 && method !== 8) return BAD;
    if (buf.readUInt16LE(p + 12) !== 0 || buf.readUInt16LE(p + 14) !== DOS_DATE) return BAD; // time, date
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    if (buf.readUInt16LE(p + 30) !== 0 || buf.readUInt16LE(p + 32) !== 0) return BAD; // extra, comment
    if (buf.readUInt16LE(p + 34) !== 0 || buf.readUInt16LE(p + 36) !== 0) return BAD; // disk start, internal attributes
    if (buf.readUInt32LE(p + 38) !== 0) return BAD; // external attributes
    const offset = buf.readUInt32LE(p + 42);
    if (nameLen === 0 || nameLen > 1024 || p + 46 + nameLen > eocd) return BAD;
    if (usize > ZIP_MAX_FILE) return BIG;
    declared += usize;
    if (declared > ZIP_MAX_TOTAL) return BIG;
    if (method === 0 ? csize !== usize : csize >= usize) return BAD; // buildZip stores unless deflate is smaller
    const nameBytes = Buffer.from(buf.subarray(p + 46, p + 46 + nameLen));
    const name = UTF8.decode(nameBytes);
    if (name.endsWith('/') || seen.has(name)) return BAD; // no directory entries; an exact duplicate is refused
    seen.add(name);
    cds.push({ name, nameBytes, method, crc, csize, usize, offset });
    p += 46 + nameLen;
  }
  if (p !== eocd) return BAD;

  // 2. the local entries: contiguous and ascending from 0 to the central directory, each equal to its central header
  const out: ZipEntry[] = [];
  let at = 0;
  for (const c of cds) {
    if (c.offset !== at || at + 30 > cdOff || buf.readUInt32LE(at) !== LOCAL_SIG) return BAD;
    if (buf.readUInt16LE(at + 4) !== 20 || buf.readUInt16LE(at + 6) !== 0 || buf.readUInt16LE(at + 8) !== c.method) return BAD;
    if (buf.readUInt16LE(at + 10) !== 0 || buf.readUInt16LE(at + 12) !== DOS_DATE) return BAD;
    if (buf.readUInt32LE(at + 14) !== c.crc || buf.readUInt32LE(at + 18) !== c.csize || buf.readUInt32LE(at + 22) !== c.usize) return BAD;
    if (buf.readUInt16LE(at + 26) !== c.nameBytes.length || buf.readUInt16LE(at + 28) !== 0) return BAD;
    const bodyAt = at + 30 + c.nameBytes.length;
    const end = bodyAt + c.csize;
    if (end > cdOff || !buf.subarray(at + 30, bodyAt).equals(c.nameBytes)) return BAD;
    const body = buf.subarray(bodyAt, end);
    let data: Buffer;
    if (c.method === 0) data = Buffer.from(body);
    else {
      data = inflateRawSync(body, { maxOutputLength: c.usize }); // throws when the output would be larger than declared
      if (data.length !== c.usize) return BAD;
    }
    if (crc32(data) !== c.crc) return BAD;
    out.push({ name: c.name, data });
    at = end;
  }
  if (at !== cdOff) return BAD; // a gap between the last entry and the central directory
  return { ok: true, entries: out };
}
