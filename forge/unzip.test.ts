import { deflateRawSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildZip } from '../workspaces/zip.js';
import { readZip } from './unzip.js';
import { rawZip } from './test-helpers.js';

const zlibSpy = vi.hoisted(() => ({ calls: 0 }));
vi.mock('node:zlib', async (orig) => {
  const m = await orig<typeof import('node:zlib')>();
  return { ...m, inflateRawSync: ((...a: Parameters<typeof m.inflateRawSync>) => { zlibSpy.calls++; return m.inflateRawSync(...a); }) as typeof m.inflateRawSync };
});
beforeEach(() => { zlibSpy.calls = 0; });

const text = Buffer.from('hello world, hello world, hello world, hello world\n'.repeat(20));
const SAMPLE = [{ name: 'forge.json', data: Buffer.from('{"a":1}') }, { name: 'src/a.mjs', data: text }, { name: 'empty.txt', data: Buffer.alloc(0) }];
const good = () => buildZip(SAMPLE);

describe('FG-AC02 / PF-C1: the strict zip reader', () => {
  it('reads what buildZip emits (stored, deflated and empty entries) byte for byte', () => {
    const r = readZip(good())!;
    expect(r.map((e) => e.name)).toEqual(['forge.json', 'src/a.mjs', 'empty.txt']);
    expect(r.map((e) => e.data.toString())).toEqual(SAMPLE.map((e) => e.data.toString()));
    expect(readZip(buildZip([]))).toEqual([]);
    expect(buildZip(r)).toEqual(good()); // the request-time canonical check relies on this
  });
  it('every truncation of a valid zip is refused', () => {
    const z = good();
    for (let i = 0; i < z.length; i++) expect(readZip(z.subarray(0, i)), String(i)).toBeNull();
    expect(readZip(Buffer.from('not a zip at all, nope'))).toBeNull();
    expect(readZip(Buffer.alloc(0))).toBeNull();
  });
  const refused: [string, () => Buffer][] = [
    ['method 12', () => rawZip([{ name: 'a', data: text, method: 12 }])],
    ['a general-purpose flag', () => rawZip([{ name: 'a', data: text, flags: 1 }])],
    ['an extra field (central and local)', () => rawZip([{ name: 'a', data: text, extra: Buffer.from([1, 2]), localExtra: Buffer.from([1, 2]) }])],
    ['a central extra field only', () => rawZip([{ name: 'a', data: text, extra: Buffer.from([1, 2]) }])],
    ['a local extra field only', () => rawZip([{ name: 'a', data: text, localExtra: Buffer.from([1, 2]) }])],
    ['an entry comment', () => rawZip([{ name: 'a', data: text, comment: Buffer.from('x') }])],
    ['a directory entry', () => rawZip([{ name: 'src/', data: Buffer.alloc(0) }])],
    ['an empty name', () => rawZip([{ name: '', data: text }])],
    ['a CRC mismatch', () => rawZip([{ name: 'a', data: text, crc: 123, localCrc: 123 }])],
    ['a local CRC differing from the central one', () => rawZip([{ name: 'a', data: text, localCrc: 5 }])],
    ['a local name differing from the central name', () => rawZip([{ name: 'ab', data: text, localName: 'ac' }])],
    ['a local size differing from the central size', () => rawZip([{ name: 'a', data: text, localUsize: 7 }])],
    ['a local compressed size differing', () => rawZip([{ name: 'a', data: text, localCsize: 9 }])],
    ['external attributes', () => rawZip([{ name: 'a', data: text, extAttr: 0x81a40000 }])],
    ['internal attributes', () => rawZip([{ name: 'a', data: text, intAttr: 1 }])],
    ['a disk start field', () => rawZip([{ name: 'a', data: text, diskStart: 1 }])],
    ['a different version made by', () => rawZip([{ name: 'a', data: text, versionMade: 63 }])],
    ['an EOCD disk number', () => rawZip([{ name: 'a', data: text }], { diskNo: 1 })],
    ['an EOCD comment', () => rawZip([{ name: 'a', data: text }], { eocdComment: Buffer.from('hi') })],
    ['trailing bytes after the EOCD', () => rawZip([{ name: 'a', data: text }], { trailing: Buffer.from([0]) })],
    ['bytes before the first entry', () => rawZip([{ name: 'a', data: text }], { gapBefore: Buffer.from([0, 0, 0, 0]) })],
    ['bytes between the last entry and the central directory', () => rawZip([{ name: 'a', data: text }], { cdGap: Buffer.from([0]) })],
    ['a wrong central directory offset', () => rawZip([{ name: 'a', data: text }], { cdOffsetDelta: 1 })],
    ['an entry count that does not match', () => rawZip([{ name: 'a', data: text }], { totalEntries: 2 })],
    ['out-of-order offsets', () => rawZip([{ name: 'a', data: text, offset: 500 }, { name: 'b', data: text }])],
    ['an exact duplicate name', () => rawZip([{ name: 'a', data: text }, { name: 'a', data: Buffer.from('x') }])],
    ['a name that is not UTF-8', () => { const z = rawZip([{ name: 'ab', data: text }]); const i = z.indexOf('ab'); z[i] = 0xff; z[z.lastIndexOf('ab')] = 0xff; return z; }],
    ['ZIP64 sizes', () => rawZip([{ name: 'a', data: text, csize: 0xffffffff, usize: 0xffffffff }])],
    ['a stored entry whose compressed size differs from its size', () => rawZip([{ name: 'a', data: text, method: 0, body: text, csize: text.length - 1 }])],
  ];
  it.each(refused)('refuses %s', (_n, mk) => { expect(readZip(mk())).toBeNull(); });
  it('refuses 201 entries and accepts 200', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `f${i}`, data: Buffer.from('x') }));
    expect(readZip(buildZip(many(200)))).toHaveLength(200);
    expect(readZip(buildZip(many(201)))).toBeNull();
  });
  it('refuses a declared size or total over the caps BEFORE the first inflate (central directory only is read)', () => {
    const fake = (n: number, usize: (i: number) => number) => rawZip(Array.from({ length: n }, (_, i) => ({ name: `f${i}`, data: Buffer.from('x'), method: 8, body: deflateRawSync(Buffer.from('x')), csize: 9, usize: usize(i) })));
    expect(readZip(fake(1, () => 512 * 1024 + 1))).toBeNull(); // one entry over 512 KiB
    expect(readZip(fake(9, (i) => (i < 8 ? 512 * 1024 : 1)))).toBeNull(); // 8 x 512 KiB + 1 = 4 MiB + 1 declared in total
    expect(readZip(fake(1, () => 0xffffffff))).toBeNull();
    expect(zlibSpy.calls).toBe(0);
  });
  it('an entry whose real inflate exceeds its declared size is refused (output capped at the declared size)', () => {
    const real = Buffer.alloc(200_000, 7);
    const z = rawZip([{ name: 'a', data: real, method: 8, body: deflateRawSync(real), usize: 4000, crc: 1, localUsize: 4000, localCrc: 1 }]);
    expect(readZip(z)).toBeNull();
    expect(zlibSpy.calls).toBe(1);
  });
  it('an entry that inflates to less than declared is refused', () => {
    const z = rawZip([{ name: 'a', data: text, method: 8, body: deflateRawSync(text.subarray(0, 300)), usize: text.length, csize: deflateRawSync(text.subarray(0, 300)).length }]);
    expect(readZip(z)).toBeNull();
  });
  it('a decompression bomb inside the declared caps is refused with a bounded memory peak; a tiny file declaring a huge volume is refused at once', () => {
    const body = deflateRawSync(Buffer.alloc(96 * 1024 * 1024, 0), { level: 9 }); // ~100 KB of deflate holding 96 MiB
    expect(body.length).toBeLessThan(500 * 1024);
    const bomb = rawZip([{ name: 'a', data: Buffer.alloc(0), method: 8, body, usize: 512 * 1024, csize: body.length, crc: 0, localUsize: 512 * 1024, localCsize: body.length, localCrc: 0 }]);
    const base = process.resourceUsage().maxRSS;
    expect(readZip(bomb)).toBeNull();
    const grew = (process.resourceUsage().maxRSS - base) / 1024; // MiB (maxRSS is in KiB)
    expect(grew).toBeLessThan(48);
    const huge = rawZip([{ name: 'a', data: Buffer.alloc(0), method: 8, body: Buffer.from([3, 0]), usize: 0xfffffff0, csize: 2 }]);
    expect(huge.length).toBeLessThan(200);
    zlibSpy.calls = 0;
    expect(readZip(huge)).toBeNull();
    expect(zlibSpy.calls).toBe(0);
  });
});
