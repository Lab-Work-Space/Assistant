/** The real startMediaServer and SocketMediaBackend over a unix socket, with the fakes in tests/fakes/bin. */
import net from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ALLOW, FF, JS, VERSIONS, YT, allGone, call, readPids, reap, rmDir, sockDir, until } from '../tests/fakes/media.js';
import { SocketMediaBackend } from './client.js';
import { startMediaServer, type MediaServer, type MediaServerOptions } from './server.js';

const silent = { warn() {}, info() {} };
let dir: string | null = null;
let srv: MediaServer | null = null;
let pidFiles: string[] = [];
afterEach(async () => {
  srv?.killAll('test-end');
  await srv?.close();
  srv = null;
  for (const f of pidFiles) reap(readPids(f));
  pidFiles = [];
  rmDir(dir);
  dir = null;
});

const start = async (over: Partial<MediaServerOptions> = {}) => {
  dir ??= sockDir();
  const socketPath = join(dir, 'media.sock');
  srv = await startMediaServer({ socketPath, ytDlp: YT, ffmpeg: FF, jsRuntime: JS, check: { ok: true }, versions: VERSIONS, log: silent, ...over });
  return socketPath;
};
const caps = { allowlist: ALLOW, capBytes: 1_000_000, capSeconds: 60 };
const hangEnv = () => {
  dir ??= sockDir();
  const yt = join(dir, 'yt.pids');
  const ff = join(dir, 'ff.pids');
  pidFiles.push(yt, ff);
  return { files: [yt, ff], env: { FAKE_YTDLP_HANG: yt, FAKE_FFMPEG_PIDS: ff } };
};
const allPids = (files: string[]) => files.flatMap(readPids);

describe('media IPC (server + socket client)', () => {
  it('stream + trailer: pcm bytes equal the fake output and done = {ytDlp:{code:0…}, ffmpeg:{code:0…}}', async () => {
    const sock = await start();
    const b = new SocketMediaBackend({ socketPath: sock, log: silent });
    expect(await b.health()).toEqual({ check: { ok: true } });
    const t = b.startTrack('https://www.youtube.com/watch?v=abc', caps);
    const parts: Buffer[] = [];
    for await (const c of t.pcm) parts.push(c as Buffer);
    expect(Buffer.concat(parts).toString()).toBe('fake-audio');
    expect(await t.done).toEqual({ ytDlp: { code: 0, signal: null, reason: null, stderr: '' }, ffmpeg: { code: 0, signal: null, reason: null, stderr: '' } });
    expect((await b.decode(Buffer.from('MP3DATA!'))).toString()).toBe('MP3DATA!');
    expect(srv!.active()).toEqual({ tracks: 0, decodes: 0 });
  });

  it('client kill closes the request and the server kills both process groups (no pid left)', async () => {
    const h = hangEnv();
    const sock = await start({ extraEnv: h.env });
    const t = new SocketMediaBackend({ socketPath: sock, log: silent }).startTrack('some song', caps);
    t.pcm.resume();
    expect(await until(() => allPids(h.files).length === 4)).toBe(true); // yt-dlp, its sleep, ffmpeg, its sleep
    const pids = allPids(h.files);
    t.kill('skip');
    expect((await t.done).ytDlp.reason).toBe('skip');
    expect(await allGone(pids, 2000)).toBe(true);
    expect(await until(() => srv!.active().tracks === 0)).toBe(true);
  });

  it('app socket EOF mid-stream kills children', async () => {
    const h = hangEnv();
    const sock = await start({ extraEnv: h.env });
    const body = JSON.stringify({ v: 1, query: 'some song', allowlist: ALLOW, capSeconds: 60, capBytes: 1_000_000 });
    const s = net.connect({ path: sock });
    s.on('error', () => undefined);
    s.write(`POST /v1/track HTTP/1.1\r\nHost: media\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
    await new Promise((r) => s.once('data', r));
    expect(await until(() => allPids(h.files).length === 4)).toBe(true);
    const pids = allPids(h.files);
    s.end(); // the app goes away: a plain EOF, no reset
    expect(await allGone(pids, 2000)).toBe(true);
    expect(await until(() => srv!.active().tracks === 0)).toBe(true);
  });

  it('killAll kills every track group', async () => {
    const h = hangEnv();
    const sock = await start({ extraEnv: h.env });
    const t = new SocketMediaBackend({ socketPath: sock, log: silent }).startTrack('some song', caps);
    t.pcm.resume();
    expect(await until(() => allPids(h.files).length === 4)).toBe(true);
    const pids = allPids(h.files);
    srv!.killAll('shutdown');
    expect(await allGone(pids, 2000)).toBe(true);
    expect(reasons(await t.done)).toEqual(['shutdown', 'shutdown']);
  });

  it('trailer stderr arrives stripped and ≤ 300', async () => {
    const sock = await start({ extraEnv: { FAKE_YTDLP_STDERR: '1' } });
    const warns: { o: object; m?: string | undefined }[] = [];
    const t = new SocketMediaBackend({ socketPath: sock, log: { warn: (o, m) => void warns.push({ o, m }) } }).startTrack('some song', caps);
    t.pcm.resume();
    const done = await t.done;
    expect(done.ytDlp.code).toBe(1);
    expect(done.ytDlp.stderr.length).toBeGreaterThan(100);
    expect(done.ytDlp.stderr.length).toBeLessThanOrEqual(300);
    expect(done.ytDlp.stderr).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(done.ytDlp.stderr).toContain('bad[31mx');
    expect(warns.some((w) => w.m === 'music track ended abnormally')).toBe(true);
  });

  it('decode busy with a realistic upload maps to (busy), never sidecar-reset', async () => {
    const sock = await start();
    const held = [0, 1].map(() => {
      const c = call(sock, 'POST', '/v1/decode', { body: null, headers: { 'content-length': '10' } });
      c.catch(() => undefined);
      return c;
    });
    expect(await until(() => srv!.active().decodes === 2)).toBe(true);
    const b = new SocketMediaBackend({ socketPath: sock, log: silent });
    for (let i = 0; i < 10; i++) await expect(b.decode(Buffer.alloc(512 * 1024))).rejects.toThrow('ffmpeg could not decode the speech (busy)');
    for (const c of held) c.req.destroy();
  });

  it('decode over the socket: 422 exit maps to the decodeToPcm string', async () => {
    const sock = await start({ extraEnv: { FAKE_FFMPEG_EXIT: '3' } });
    await expect(new SocketMediaBackend({ socketPath: sock, log: silent }).decode(Buffer.from('x'))).rejects.toThrow('ffmpeg could not decode the speech (exit 3)');
  });

  it('client abort mid-decode kills the server\'s ffmpeg group (no pid left) and frees the slot', async () => {
    dir ??= sockDir();
    const ff = join(dir, 'ff.pids');
    pidFiles.push(ff);
    const sock = await start({ extraEnv: { FAKE_FFMPEG_PIDS: ff, FAKE_FFMPEG_HANG: '1' } });
    const c = call(sock, 'POST', '/v1/decode', { body: Buffer.from('MP3DATA!'), headers: { 'content-length': '8' } });
    c.catch(() => undefined);
    expect(await until(() => readPids(ff).length === 2)).toBe(true); // ffmpeg and its grandchild
    const pids = readPids(ff);
    expect(srv!.active().decodes).toBe(1);
    c.req.destroy(); // the app gives up (TTS cancelled, app shutting down)
    expect(await allGone(pids, 2000)).toBe(true);
    expect(await until(() => srv!.active().decodes === 0)).toBe(true);
  });
});

const reasons = (d: { ytDlp: { reason: string | null }; ffmpeg: { reason: string | null } }) => [d.ytDlp.reason, d.ffmpeg.reason];
