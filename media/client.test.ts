/**
 * SocketMediaBackend against a malicious in-process sidecar (Gate 1 S1 client side, S7): a raw `net` server writes HTTP/1.1
 * bytes by hand, so oversize, malformed, lying and dripping replies can be produced exactly. Every case maps to a fixed reason.
 */
import { lstatSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ALLOW, rmDir, sockDir, staleSocket } from '../tests/fakes/media.js';
import { MusicInputError, type SafeExit } from '../voice/music/source.js';
import { SocketMediaBackend, type SocketMediaBackendOptions } from './client.js';
import { PCM_CAP } from './decode.js';
import { encodeExitTrailer, type ExitTrailer } from './protocol.js';

type Warn = { o: object; m?: string | undefined };
let dir: string | null = null;
let servers: net.Server[] = [];
let warns: Warn[] = [];
const log = { warn: (o: object, m?: string) => void warns.push({ o, m }) };
afterEach(async () => {
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  servers = [];
  warns = [];
  rmDir(dir);
  dir = null;
});

type Evil = { path: string; connections: () => number; closedEarly: () => boolean };
/** A sidecar that reads the request head, then lets `reply` write whatever it wants to the raw socket. */
async function evil(reply: (s: net.Socket, head: string) => void): Promise<Evil> {
  dir ??= sockDir();
  const path = join(dir, `e${servers.length}.sock`);
  let n = 0;
  let early = false;
  const srv = net.createServer((s) => {
    n++;
    s.on('error', () => undefined);
    let flushed = false;
    s.on('finish', () => (flushed = true)); // every byte handed to the kernel
    s.on('close', () => (early ||= !flushed));
    let buf = '';
    const onData = (b: Buffer) => {
      buf += b.toString('latin1');
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      s.off('data', onData);
      s.resume();
      reply(s, buf.slice(0, i));
    };
    s.on('data', onData);
  });
  await new Promise<void>((r) => srv.listen(path, r));
  servers.push(srv);
  return { path, connections: () => n, closedEarly: () => early };
}

const ok: SafeExit = { code: 0, signal: null, reason: null, stderr: '' };
const trailerOf = (x: Partial<ExitTrailer> = {}) => encodeExitTrailer({ ytDlp: ok, ffmpeg: ok, ...x });
const HEAD = 'HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nTransfer-Encoding: chunked\r\nTrailer: X-Media-Exit\r\n\r\n';
const chunk = (b: Buffer | string) => {
  const buf = Buffer.isBuffer(b) ? b : Buffer.from(b);
  return Buffer.concat([Buffer.from(`${buf.length.toString(16)}\r\n`), buf, Buffer.from('\r\n')]);
};
const streamReply = (body: Buffer | string, trailer: string | null) => (s: net.Socket) => {
  s.write(HEAD);
  s.write(chunk(body));
  s.end(trailer === null ? '0\r\n\r\n' : `0\r\nX-Media-Exit: ${trailer}\r\n\r\n`);
};
const jsonReply = (status: string, body: string, extra = '') => (s: net.Socket) =>
  s.end(`HTTP/1.1 ${status}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n${extra}\r\n${body}`);

const backend = (path: string, over: Partial<SocketMediaBackendOptions> = {}) => new SocketMediaBackend({ socketPath: path, log, ...over });
const caps = { allowlist: ALLOW, capBytes: 1_000_000, capSeconds: 60 };
const play = async (b: SocketMediaBackend, q = 'some song', c = caps) => {
  const t = b.startTrack(q, c);
  const parts: Buffer[] = [];
  t.pcm.on('data', (x: Buffer) => parts.push(x));
  const done = await t.done;
  await new Promise<void>((r) => (t.pcm.readableEnded ? r() : t.pcm.once('end', () => r())));
  return { done, pcm: Buffer.concat(parts), t };
};
const reasons = (d: { ytDlp: SafeExit; ffmpeg: SafeExit }) => [d.ytDlp.reason, d.ffmpeg.reason];
const DEC = 'ffmpeg could not decode the speech';

describe('SocketMediaBackend', () => {
  it('stream + trailer: pcm bytes and done come from the reply', async () => {
    const e = await evil(streamReply('fake-audio', trailerOf({ ytDlp: { ...ok, stderr: 'warn' } })));
    const { done, pcm } = await play(backend(e.path));
    expect(pcm.toString()).toBe('fake-audio');
    expect(done).toEqual({ ytDlp: { ...ok, stderr: 'warn' }, ffmpeg: ok });
  });

  it('lstat refuses a symlinked socket (sidecar-unavailable)', async () => {
    const e = await evil(streamReply('fake-audio', trailerOf()));
    const link = join(dir!, 'link.sock');
    symlinkSync(e.path, link);
    const b = backend(link);
    expect(reasons((await play(b)).done)).toEqual(['sidecar-unavailable', 'sidecar-unavailable']);
    await expect(b.decode(Buffer.from('x'))).rejects.toThrow(`${DEC} (sidecar-unavailable)`);
    await expect(b.health()).rejects.toThrow('sidecar-unavailable');
    expect(e.connections()).toBe(0);
    const file = join(dir!, 'file.sock');
    writeFileSync(file, '');
    expect(reasons((await play(backend(file))).done)).toEqual(['sidecar-unavailable', 'sidecar-unavailable']);
  });

  it('ENOENT/ECONNREFUSED → sidecar-unavailable', async () => {
    dir = sockDir();
    const missing = backend(join(dir, 'none.sock'));
    expect(reasons((await play(missing)).done)).toEqual(['sidecar-unavailable', 'sidecar-unavailable']);
    await expect(missing.decode(Buffer.from('x'))).rejects.toThrow(`${DEC} (sidecar-unavailable)`);
    const stale = join(dir, 'stale.sock');
    await staleSocket(stale);
    expect(lstatSync(stale).isSocket()).toBe(true);
    const refused = backend(stale);
    expect(reasons((await play(refused)).done)).toEqual(['sidecar-unavailable', 'sidecar-unavailable']);
    await expect(refused.decode(Buffer.from('x'))).rejects.toThrow(`${DEC} (sidecar-unavailable)`);
    await expect(refused.health()).rejects.toThrow('sidecar-unavailable');
  });

  it('no trailer → done reason sidecar-reset', async () => {
    const e = await evil(streamReply('fake-audio', null));
    const { done, pcm } = await play(backend(e.path));
    expect(reasons(done)).toEqual(['sidecar-reset', 'sidecar-reset']);
    expect(done.ytDlp.code).toBeNull();
    expect(pcm.toString()).toBe('fake-audio');
    const cut = await evil((s) => {
      s.write(HEAD);
      s.write(chunk('fake'));
      s.destroy(); // mid-stream reset
    });
    expect(reasons((await play(backend(cut.path))).done)).toEqual(['sidecar-reset', 'sidecar-reset']);
  });

  it('trailer over 4 KiB or bad base64url → sidecar-reset', async () => {
    const big = Buffer.from(JSON.stringify({ ytDlp: ok, ffmpeg: { ...ok, stderr: 'x'.repeat(5000) } })).toString('base64url');
    const extra = Buffer.from(JSON.stringify({ ytDlp: ok, ffmpeg: ok, more: 1 })).toString('base64url');
    const extraExit = Buffer.from(JSON.stringify({ ytDlp: { ...ok, x: 1 }, ffmpeg: ok })).toString('base64url');
    for (const t of ['x'.repeat(5 * 1024), big, '!!not+base64/', extra, extraExit, Buffer.from('{').toString('base64url')]) {
      const e = await evil(streamReply('fake-audio', t));
      expect(reasons((await play(backend(e.path))).done)).toEqual(['sidecar-reset', 'sidecar-reset']);
    }
  });

  it('sidecar text never becomes a done reason: an unknown trailer reason maps to sidecar-error', async () => {
    const e = await evil(streamReply('a', trailerOf({ ytDlp: { ...ok, code: 1, reason: 'run <@1234> now' }, ffmpeg: { ...ok, reason: 'timeout' } })));
    const { done } = await play(backend(e.path));
    expect(reasons(done)).toEqual(['sidecar-error', 'timeout']);
    const e2 = await evil(streamReply('a', trailerOf({ ytDlp: { ...ok, reason: 'spawn failed: ENOENT /secret/path' } })));
    expect((await play(backend(e2.path))).done.ytDlp.reason).toBe('spawn failed');
  });

  it('the "music track ended abnormally" warn rule is kept on trailer exits (stderr goes to the logger only)', async () => {
    const e = await evil(streamReply('a', trailerOf({ ytDlp: { ...ok, code: 1, stderr: 'boom' } })));
    await play(backend(e.path));
    expect(warns.find((w) => w.m === 'music track ended abnormally')?.o).toMatchObject({ ytDlp: 1, err: 'boom' });
  });

  it('503 busy → reason busy, other 503 → unavailable', async () => {
    const busy = await evil(jsonReply('503 Service Unavailable', '{"error":"busy"}'));
    expect(reasons((await play(backend(busy.path))).done)).toEqual(['busy', 'busy']);
    const other = await evil(jsonReply('503 Service Unavailable', '{"error":"down"}'));
    expect(reasons((await play(backend(other.path))).done)).toEqual(['unavailable', 'unavailable']);
    const notJson = await evil(jsonReply('503 Service Unavailable', 'busy'));
    expect(reasons((await play(backend(notJson.path))).done)).toEqual(['unavailable', 'unavailable']);
    const down = await evil(jsonReply('503 Service Unavailable', '{"error":"unavailable"}')); // M-2: sidecar boot check failed
    expect(reasons((await play(backend(down.path))).done)).toEqual(['unavailable', 'unavailable']);
    const other500 = await evil(jsonReply('500 Internal Server Error', '{}'));
    expect(reasons((await play(backend(other500.path))).done)).toEqual(['unavailable', 'unavailable']);
  });

  it('400 input → fixed reason input; the sidecar message reaches the logger only', async () => {
    const e = await evil(jsonReply('400 Bad Request', JSON.stringify({ error: 'input', message: 'Links from \u001bevil.com are not allowed' })));
    const { done } = await play(backend(e.path));
    expect(reasons(done)).toEqual(['input', 'input']);
    expect(JSON.stringify(done)).not.toContain('evil');
    const w = warns.find((x) => JSON.stringify(x.o).includes('evil.com'));
    expect(w).toBeDefined();
    expect(JSON.stringify(w!.o)).not.toContain('\\u001b');
  });

  it('a 2 MiB error body is cut at 1 KiB (sidecar-reset, connection closed early)', async () => {
    const huge = 'x'.repeat(2 * 1024 * 1024);
    const t = await evil(jsonReply('503 Service Unavailable', huge));
    expect(reasons((await play(backend(t.path))).done)).toEqual(['sidecar-reset', 'sidecar-reset']);
    await new Promise((r) => setTimeout(r, 50));
    expect(t.closedEarly()).toBe(true); // the client cut the connection before the 2 MiB were taken
    const d = await evil(jsonReply('422 Unprocessable Entity', huge));
    await expect(backend(d.path).decode(Buffer.from('x'))).rejects.toThrow(`${DEC} (sidecar-reset)`);
  });

  it('a 20 KiB or a 10 KiB response header → sidecar-reset (maxHeaderSize 8 KiB)', async () => {
    for (const size of [20 * 1024, 10 * 1024]) {
      const e = await evil((s) => s.end(`HTTP/1.1 200 OK\r\nX-Pad: ${'a'.repeat(size)}\r\nContent-Length: 4\r\n\r\nabcd`));
      expect(reasons((await play(backend(e.path))).done)).toEqual(['sidecar-reset', 'sidecar-reset']);
      await expect(backend(e.path).decode(Buffer.from('x'))).rejects.toThrow(`${DEC} (sidecar-reset)`);
    }
  });

  it('a 1 byte per 100 ms drip ends at the total deadline, not the idle timeout', async () => {
    const drip = (head: string) => (s: net.Socket) => {
      s.write(head);
      const iv = setInterval(() => (s.destroyed ? clearInterval(iv) : s.write(head.includes('chunked') ? chunk('z') : 'z')), 100);
      s.on('close', () => clearInterval(iv));
    };
    const e = await evil(drip(HEAD));
    const t0 = Date.now();
    const { done } = await play(backend(e.path, { deadlines: { trackMs: () => 600 } }));
    expect(reasons(done)).toEqual(['timeout', 'timeout']);
    expect(Date.now() - t0).toBeLessThan(2000);
    const d = await evil(drip('HTTP/1.1 200 OK\r\nContent-Length: 100000\r\n\r\n'));
    const t1 = Date.now();
    await expect(backend(d.path, { deadlines: { decodeMs: 600 } }).decode(Buffer.from('x'))).rejects.toThrow(`${DEC} (timeout)`);
    expect(Date.now() - t1).toBeLessThan(2000);
    const h = await evil(drip('HTTP/1.1 200 OK\r\nContent-Length: 100000\r\n\r\n'));
    await expect(backend(h.path, { deadlines: { healthMs: 600 } }).health()).rejects.toThrow('sidecar-unavailable');
  });

  it('decode error strings match §5.3 for 400/413/422 stdout-cap/503/refused/reset', async () => {
    const cases: [ (s: net.Socket) => void, string ][] = [
      [jsonReply('400 Bad Request', '{"error":"input","message":"x"}'), `${DEC} (input)`],
      [jsonReply('413 Payload Too Large', '{"error":"too-large"}'), `${DEC} (input-cap)`],
      [jsonReply('411 Length Required', '{"error":"length"}'), `${DEC} (input)`],
      [jsonReply('422 Unprocessable Entity', '{"error":"decode","reason":"stdout-cap"}'), 'the reply is too long to speak (decoded audio over its cap)'],
      [jsonReply('422 Unprocessable Entity', '{"error":"decode","reason":"timeout"}'), `${DEC} (timeout)`],
      [jsonReply('422 Unprocessable Entity', '{"error":"decode","reason":"exit 1"}'), `${DEC} (exit 1)`],
      [jsonReply('422 Unprocessable Entity', '{"error":"decode","reason":"say <@1> hi"}'), `${DEC} (input)`],
      [jsonReply('503 Service Unavailable', '{"error":"busy"}'), `${DEC} (busy)`],
      [jsonReply('503 Service Unavailable', '{"error":"other"}'), `${DEC} (busy)`],
      // M-2: the sidecar's own boot check failed -> a non-busy reason; any other 500 stays input
      [jsonReply('500 Internal Server Error', '{"error":"unavailable"}'), `${DEC} (sidecar-unavailable)`],
      [jsonReply('500 Internal Server Error', '{"error":"internal"}'), `${DEC} (input)`],
      [(s) => s.destroy(), `${DEC} (sidecar-reset)`],
      [(s) => s.end('HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n' + 'a'.repeat(50)), `${DEC} (sidecar-reset)`], // a lying Content-Length
      [(s) => { s.write('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n'); s.end(Buffer.concat([chunk('abcd'), Buffer.from('0\r\n\r\n')])); }, `${DEC} (sidecar-reset)`], // no Content-Length
    ];
    for (const [reply, msg] of cases) {
      const e = await evil(reply);
      await expect(backend(e.path).decode(Buffer.from('mp3'))).rejects.toThrow(msg);
    }
  });

  it('decode refuses a Content-Length over PCM_CAP before reading the body', async () => {
    const e = await evil((s) => s.write(`HTTP/1.1 200 OK\r\nContent-Length: ${PCM_CAP + 1}\r\n\r\nabc`)); // then hangs
    const t0 = Date.now();
    await expect(backend(e.path).decode(Buffer.from('mp3'))).rejects.toThrow('the reply is too long to speak (decoded audio over its cap)');
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('decode returns PCM; an odd byte count is cut to whole 16-bit samples', async () => {
    const even = await evil((s) => s.end('HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\nPCMDATA!'));
    expect((await backend(even.path).decode(Buffer.from('mp3'))).toString()).toBe('PCMDATA!');
    const odd = await evil((s) => s.end('HTTP/1.1 200 OK\r\nContent-Length: 7\r\n\r\nPCMDATA'));
    const pcm = await backend(odd.path).decode(Buffer.from('mp3'));
    expect(pcm.length).toBe(6);
    expect(pcm.toString()).toBe('PCMDAT');
  });

  it('a track with an odd PCM byte count streams every byte and still settles from the trailer', async () => {
    const e = await evil(streamReply('abcde', trailerOf()));
    const { done, pcm } = await play(backend(e.path));
    expect(pcm.toString()).toBe('abcde');
    expect(done.ffmpeg.code).toBe(0);
  });

  it('client pcmCap exceeded → kill stdout-cap', async () => {
    const e = await evil((s) => {
      s.write(HEAD);
      const block = chunk(Buffer.alloc(64 * 1024));
      const pump = () => {
        while (!s.destroyed && s.write(block));
        if (!s.destroyed) s.once('drain', pump);
      };
      pump();
    });
    const { done, pcm } = await play(backend(e.path), 'some song', { ...caps, capSeconds: 1 });
    expect(reasons(done)).toEqual(['stdout-cap', 'stdout-cap']);
    expect(pcm.length).toBeLessThanOrEqual(1 * 48_000 * 4 + 1024 * 1024);
  });

  it('kill() after the trailer keeps the trailer exits; kill() before it settles with the kill reason', async () => {
    const e = await evil(streamReply('fake-audio', trailerOf()));
    const { done, t } = await play(backend(e.path));
    t.kill('ended');
    expect(await t.done).toEqual(done);
    expect(done.ytDlp.reason).toBeNull();
    const hang = await evil((s) => s.write(HEAD + chunk('abc').toString('latin1')));
    const t2 = backend(hang.path).startTrack('some song', caps);
    t2.pcm.resume();
    await new Promise((r) => t2.pcm.once('data', r));
    t2.kill('skip');
    expect(reasons(await t2.done)).toEqual(['skip', 'skip']);
    await new Promise<void>((r) => (t2.pcm.readableEnded ? r() : t2.pcm.once('end', () => r())));
  });

  it('MusicInputError is thrown synchronously before any connect', async () => {
    const e = await evil(streamReply('x', trailerOf()));
    let lstats = 0;
    const b = backend(e.path, { lstat: (p) => (lstats++, lstatSync(p)) });
    expect(() => b.startTrack('https://evil.com/x', caps)).toThrow(MusicInputError);
    expect(() => b.startTrack('   ', caps)).toThrow(MusicInputError);
    expect(lstats).toBe(0);
    await new Promise((r) => setTimeout(r, 50));
    expect(e.connections()).toBe(0);
  });

  it('health parses a strict body; bad versions or a non-JSON body → Error(sidecar-unavailable)', async () => {
    const good = { v: 1, check: { ok: true }, versions: { ytDlp: '2026.10.26', ffmpeg: 'n9.0.2-39-g7adfbe40dc' }, busy: { tracks: 0, decodes: 1 } };
    const g = await evil(jsonReply('200 OK', JSON.stringify(good)));
    expect(await backend(g.path).health()).toEqual({ check: { ok: true } });
    for (const body of [JSON.stringify({ ...good, versions: { ytDlp: 'x'.repeat(65), ffmpeg: '1' } }), JSON.stringify({ ...good, versions: { ytDlp: '<@1>', ffmpeg: '1' } }), 'nope', 'x'.repeat(4096)]) {
      const e = await evil(jsonReply('200 OK', body));
      await expect(backend(e.path).health()).rejects.toThrow('sidecar-unavailable');
    }
    const s5 = await evil(jsonReply('503 Service Unavailable', JSON.stringify(good)));
    await expect(backend(s5.path).health()).rejects.toThrow('sidecar-unavailable');
  });
});
