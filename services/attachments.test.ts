import { describe, expect, it, vi } from 'vitest';
import { safeFetch } from '../net/guard.js';
import { fakeResolver, fakeTransport } from '../tests/fakes/net.js';
import { ATTACHMENT_MAX_BYTES, fetchAttachment, sniffType } from './attachments.js';

const CDN = 'https://cdn.discordapp.com/attachments/1/2/receipt.png?ex=1&is=2&hm=abc';
const PUBLIC = { 'cdn.discordapp.com': ['162.159.130.233'], 'media.discordapp.net': ['162.159.130.234'], 'evil.example': ['93.184.216.34'] };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const PDF = Buffer.from('%PDF-1.7\n%...');
const EPS = Buffer.from('%!PS-Adobe-3.0 EPSF-3.0\n');
const bin = { 'content-type': 'image/png' };

const opts = (routes: Parameters<typeof fakeTransport>[0], table: Parameters<typeof fakeResolver>[0] = PUBLIC) => {
  const transport = fakeTransport(routes);
  return { transport, o: { fetch: safeFetch, resolver: fakeResolver(table), transport } };
};

describe('attachments', () => {
  it('non-discord host refused; non-image/pdf refused; >10 MB refused before reading all bytes', async () => {
    const fetch = vi.fn(safeFetch);
    const evil = opts({ 'https://evil.example/a.png': { headers: bin, body: [PNG] } });
    await expect(fetchAttachment('https://evil.example/a.png', { ...evil.o, fetch })).rejects.toThrow(/discord/i);
    await expect(fetchAttachment('https://cdn.discordapp.com.evil.example/a.png', { ...evil.o, fetch })).rejects.toThrow(/discord/i);
    await expect(fetchAttachment('http://cdn.discordapp.com/a.png', { ...evil.o, fetch })).rejects.toThrow(/discord/i);
    expect(fetch).not.toHaveBeenCalled();

    const text = opts({ [CDN]: { headers: bin, body: 'just some text, not an image' } });
    await expect(fetchAttachment(CDN, text.o)).rejects.toThrow(/not a supported image or PDF/);

    let yielded = 0;
    async function* huge(): AsyncIterable<Uint8Array> {
      const c = new Uint8Array(1024 * 1024);
      c.set(PNG);
      for (;;) {
        yielded++;
        yield c;
      }
    }
    const big = opts({ [CDN]: { headers: bin, body: huge() } });
    await expect(fetchAttachment(CDN, big.o)).rejects.toThrow(/larger than 10 MB/);
    expect(yielded).toBeLessThanOrEqual(12);

    // a redirect off the CDN is never followed
    const hop = opts({ [CDN]: { status: 302, headers: { location: 'https://evil.example/a.png' }, body: '' }, 'https://evil.example/a.png': { headers: bin, body: [PNG] } });
    await expect(fetchAttachment(CDN, hop.o)).rejects.toThrow();
    expect(hop.transport.requests.map((r) => r.url.hostname)).toEqual(['cdn.discordapp.com']);

    const ok = opts({ 'https://media.discordapp.net/x/y.webp': { headers: bin, body: [PNG] } });
    expect(await fetchAttachment('https://media.discordapp.net/x/y.webp', ok.o)).toEqual({ mimeType: 'image/png', data: PNG });
  });

  it('.png with PDF magic handled as PDF, .png with EPS refused', async () => {
    const pdf = opts({ [CDN]: { headers: bin, body: [PDF] } });
    expect((await fetchAttachment(CDN, pdf.o)).mimeType).toBe('application/pdf');
    const eps = opts({ [CDN]: { headers: bin, body: [EPS] } });
    await expect(fetchAttachment(CDN, eps.o)).rejects.toThrow(/not a supported image or PDF/);
    expect(sniffType(Buffer.from([0xc5, 0xd0, 0xd3, 0xc6, 0, 0, 0, 0]))).toBeNull(); // binary EPS
    expect(sniffType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffType(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffType(Buffer.from('RIFF\0\0\0\0WAVEfmt '))).toBeNull();
  });

  it('11 MB streamed body refused', async () => {
    const eleven = Array.from({ length: 11 }, (_, i) => {
      const c = new Uint8Array(1024 * 1024);
      if (i === 0) c.set(PNG);
      return c;
    });
    const r = opts({ [CDN]: { headers: bin, body: eleven } }); // no content-length: only the streamed bytes tell
    await expect(fetchAttachment(CDN, r.o)).rejects.toThrow(/larger than 10 MB/);
    // exactly 10 MB is accepted
    const ten = new Uint8Array(ATTACHMENT_MAX_BYTES);
    ten.set(PNG);
    const okr = opts({ [CDN]: { headers: bin, body: [ten] } });
    expect((await fetchAttachment(CDN, okr.o)).data.length).toBe(ATTACHMENT_MAX_BYTES);
  });

  it('goes through safeFetch (a CDN name resolving private is refused)', async () => {
    const r = opts({ [CDN]: { headers: bin, body: [PNG] } }, { 'cdn.discordapp.com': ['10.0.0.5'] });
    await expect(fetchAttachment(CDN, r.o)).rejects.toThrow(/refused/);
    expect(r.transport.requests).toHaveLength(0);
  });
});
