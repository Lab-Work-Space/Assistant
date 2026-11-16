import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildZip, crc32 } from './zip.js';

/** A small independent reader: walks the central directory. */
function readZip(z: Buffer): { name: string; data: Buffer; method: number; crc: number; date: number }[] {
  const eocd = z.length - 22;
  expect(z.readUInt32LE(eocd)).toBe(0x06054b50);
  const n = z.readUInt16LE(eocd + 10);
  let p = z.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < n; i++) {
    expect(z.readUInt32LE(p)).toBe(0x02014b50);
    const method = z.readUInt16LE(p + 10);
    const date = z.readUInt16LE(p + 14);
    const crc = z.readUInt32LE(p + 16);
    const csize = z.readUInt32LE(p + 20);
    const usize = z.readUInt32LE(p + 24);
    const nl = z.readUInt16LE(p + 28);
    const el = z.readUInt16LE(p + 30);
    const cl = z.readUInt16LE(p + 32);
    const lho = z.readUInt32LE(p + 42);
    const name = z.subarray(p + 46, p + 46 + nl).toString('utf8');
    const lnl = z.readUInt16LE(lho + 26);
    const lel = z.readUInt16LE(lho + 28);
    const raw = z.subarray(lho + 30 + lnl + lel, lho + 30 + lnl + lel + csize);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    expect(data.length).toBe(usize);
    out.push({ name, data, method, crc, date });
    p += 46 + nl + el + cl;
  }
  return out;
}

describe('crc32', () => {
  it('matches the standard check value', () => expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926));
});

describe('buildZip', () => {
  it('round-trips entries, deflates compressible data, stores incompressible data, DOS date 1980-01-01', () => {
    const text = Buffer.from('hello world '.repeat(500));
    const rnd = randomBytes(2000);
    const z = buildZip([{ name: 'a/text.txt', data: text }, { name: 'rnd.bin', data: rnd }, { name: 'empty', data: Buffer.alloc(0) }]);
    const e = readZip(z);
    expect(e.map((x) => x.name)).toEqual(['a/text.txt', 'rnd.bin', 'empty']);
    expect(e[0]!.data.equals(text)).toBe(true);
    expect(e[0]!.method).toBe(8);
    expect(e[1]!.method).toBe(0);
    expect(e[1]!.data.equals(rnd)).toBe(true);
    expect(e[2]!.data.length).toBe(0);
    for (const x of e) {
      expect(x.date).toBe(0x21);
      expect(x.crc).toBe(crc32(x.data));
    }
    expect(z.length).toBeLessThan(text.length);
  });
  it('writes no directory entries and no ZIP64 records', () => {
    const z = buildZip([{ name: 'a/b/c.txt', data: Buffer.from('x') }]);
    expect(readZip(z).map((x) => x.name)).toEqual(['a/b/c.txt']);
    expect(z.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBe(false);
  });
  it('is read by the system unzip', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zip-'));
    try {
      const f = join(dir, 'x.zip');
      writeFileSync(f, buildZip([{ name: 'a/b.txt', data: Buffer.from('abc'.repeat(100)) }, { name: 'c.bin', data: randomBytes(300) }]));
      let out = '';
      try {
        out = execFileSync('unzip', ['-t', f], { encoding: 'utf8' });
      } catch (e) {
        if ((e as { code?: string }).code === 'ENOENT') return;
        throw e;
      }
      expect(out).toMatch(/No errors detected/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('refuses more than 65535 entries (no ZIP64)', () => {
    expect(() => buildZip(Array.from({ length: 65536 }, (_, i) => ({ name: `f${i}`, data: Buffer.alloc(0) })))).toThrow();
  });
});
