import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ALLOW, FF, JS, VERSIONS, YT, call, json, readPids, reap, rmDir, sockDir, staleSocket, until } from '../tests/fakes/media.js';
import { buildFfmpegArgs, buildYtDlpArgs } from '../voice/music/source.js';
import { PCM_CAP } from './decode.js';
import { decodeExitTrailer } from './protocol.js';
import { MediaServerRefusal, startMediaServer, type MediaServer, type MediaServerOptions } from './server.js';

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
const track = (body: object) => JSON.stringify({ v: 1, query: 'some song', allowlist: ALLOW, capSeconds: 60, capBytes: 1_000_000, ...body });
const post = (sock: string, path: string, body: string | Buffer, headers: Record<string, string> = {}) =>
  call(sock, 'POST', path, { body, headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), ...headers } });

describe('startMediaServer', () => {
  it('health returns {v:1, check, versions, busy:{tracks:0,decodes:0}}', async () => {
    const sock = await start({ check: { ok: false, missing: ['ffmpeg'], mismatched: [] } });
    const r = await call(sock, 'GET', '/v1/health');
    expect(r.status).toBe(200);
    expect(json(r)).toEqual({ v: 1, check: { ok: false, missing: ['ffmpeg'], mismatched: [] }, versions: VERSIONS, busy: { tracks: 0, decodes: 0 } });
  });

  it('404 on /v1/x, 405 on GET /v1/track', async () => {
    const sock = await start();
    expect((await call(sock, 'GET', '/v1/x')).status).toBe(404);
    expect((await call(sock, 'GET', '/v1/health?x=1')).status).toBe(404);
    expect((await call(sock, 'GET', '/v1/track')).status).toBe(405);
    expect((await call(sock, 'POST', '/v1/health', { body: '' })).status).toBe(405);
    expect((await call(sock, 'GET', '/v1/decode')).status).toBe(405);
  });

  it('400 on unknown key / 8193-byte body', async () => {
    const sock = await start();
    expect((await post(sock, '/v1/track', track({ extra: 1 }))).status).toBe(400);
    expect((await post(sock, '/v1/track', 'not json')).status).toBe(400);
    const body = track({});
    const padded = body + ' '.repeat(8193 - Buffer.byteLength(body));
    expect(Buffer.byteLength(padded)).toBe(8193);
    expect((await post(sock, '/v1/track', padded)).status).toBe(400);
    // the same body at 8192 bytes is accepted (JSON allows trailing white space)
    const ok = await post(sock, '/v1/track', padded.slice(0, 8192));
    expect(ok.status).toBe(200);
  });

  it('400 input with the MusicInputError message for host evil.com', async () => {
    const sock = await start();
    const r = await post(sock, '/v1/track', track({ query: 'https://evil.com/x' }));
    expect(r.status).toBe(400);
    expect(json(r)).toEqual({ error: 'input', message: 'Links from evil.com are not allowed; only YouTube.' });
  });

  it('server builds argv itself: fake yt-dlp argv log equals buildYtDlpArgs(...) and the fake ffmpeg log equals buildFfmpegArgs()', async () => {
    dir = sockDir();
    const argv = join(dir, 'argv.log');
    const ffLog = join(dir, 'ff.log');
    const sock = await start({ extraEnv: { FAKE_ARGV_LOG: argv, FAKE_BIN_LOG: ffLog } });
    const q = '--exec touch /tmp/pwned';
    const r = await post(sock, '/v1/track', track({ query: q, capSeconds: 321, capBytes: 777_000 }));
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe('fake-audio');
    const got = readFileSync(argv, 'utf8').split('\n')[0]!.split('\0').slice(0, -1);
    expect(got).toEqual(buildYtDlpArgs(q, { capBytes: 777_000, capSeconds: 321, allowlist: ALLOW, jsRuntime: JS }));
    expect(got.slice(-2)).toEqual(['--', `ytsearch1:${q}`]); // hostile input stays a search term after `--`
    const ffLine = readFileSync(ffLog, 'utf8').split('\n').find((l) => l.startsWith('ffmpeg '));
    expect(ffLine).toBe(`ffmpeg ${buildFfmpegArgs().join(' ')}`);
    // an extra key never reaches a spawn
    rmDir(argv);
    expect((await post(sock, '/v1/track', track({ extra: '--exec x' }))).status).toBe(400);
    expect(existsSync(argv)).toBe(false);
  });

  it('M-2: after a failed boot check, track is 503 unavailable and decode 500 unavailable; no binary is executed', async () => {
    dir = sockDir();
    const argv = join(dir, 'argv.log');
    const ffLog = join(dir, 'ff.log');
    const sock = await start({ check: { ok: false, missing: [], mismatched: ['ffmpeg'] }, extraEnv: { FAKE_ARGV_LOG: argv, FAKE_BIN_LOG: ffLog } });
    const t = await post(sock, '/v1/track', track({}));
    expect(t.status).toBe(503);
    expect(json(t)).toEqual({ error: 'unavailable' });
    const d = await post(sock, '/v1/decode', Buffer.from('MP3DATA'));
    expect(d.status).toBe(500);
    expect(json(d)).toEqual({ error: 'unavailable' });
    expect(existsSync(argv)).toBe(false);
    expect(existsSync(ffLog)).toBe(false);
    expect(srv!.active()).toEqual({ tracks: 0, decodes: 0 });
    // health still answers, so the app reads the failed check and disables music/voice
    expect((json(await call(sock, 'GET', '/v1/health')) as { check: unknown }).check).toEqual({ ok: false, missing: [], mismatched: ['ffmpeg'] });
  });

  it('third concurrent track → 503 busy', async () => {
    dir = sockDir();
    const pids = join(dir, 'pids');
    pidFiles.push(pids);
    const sock = await start({ extraEnv: { FAKE_YTDLP_HANG: pids } });
    const open = [0, 1].map(() => {
      const c = call(sock, 'POST', '/v1/track', { body: track({}), headers: { 'content-type': 'application/json' } });
      c.catch(() => undefined);
      return c;
    });
    expect(await until(() => srv!.active().tracks === 2)).toBe(true);
    const third = await post(sock, '/v1/track', track({}));
    expect(third.status).toBe(503);
    expect(json(third)).toEqual({ error: 'busy' });
    const h = json(await call(sock, 'GET', '/v1/health')) as { busy: unknown };
    expect(h.busy).toEqual({ tracks: 2, decodes: 0 });
    for (const c of open) c.req.destroy();
    expect(await until(() => srv!.active().tracks === 0)).toBe(true);
  });

  it('third concurrent decode → 503 busy', async () => {
    const sock = await start();
    const held = [0, 1].map(() => {
      const c = call(sock, 'POST', '/v1/decode', { body: null, headers: { 'content-length': '10' } });
      c.catch(() => undefined);
      return c;
    });
    expect(await until(() => srv!.active().decodes === 2)).toBe(true);
    const third = await post(sock, '/v1/decode', Buffer.from('x'));
    expect(third.status).toBe(503);
    expect(json(third)).toEqual({ error: 'busy' });
    for (const c of held) c.req.destroy();
    expect(await until(() => srv!.active().decodes === 0)).toBe(true);
  });

  it('decode 200 with Content-Length; 411 without Content-Length, 413 over 4 MiB, 422 stdout-cap, 422 exit 1', async () => {
    let sock = await start();
    const ok = await post(sock, '/v1/decode', Buffer.from('MP3DATA'));
    expect(ok.status).toBe(200);
    expect(ok.headers['content-length']).toBe('7');
    expect(ok.body.toString()).toBe('MP3DATA');
    const chunked = await call(sock, 'POST', '/v1/decode', { body: 'abc', headers: { 'transfer-encoding': 'chunked' } });
    expect(chunked.status).toBe(411);
    const big = await call(sock, 'POST', '/v1/decode', { body: null, headers: { 'content-length': String(4 * 1024 * 1024 + 1) } });
    expect(big.status).toBe(413);
    await srv!.close();
    sock = await start({ extraEnv: { FAKE_FFMPEG_BYTES: String(PCM_CAP + 1) } });
    const cap = await post(sock, '/v1/decode', Buffer.from('x'));
    expect(cap.status).toBe(422);
    expect(json(cap)).toEqual({ error: 'decode', reason: 'stdout-cap' });
    await srv!.close();
    sock = await start({ extraEnv: { FAKE_FFMPEG_EXIT: '1' } });
    const ex = await post(sock, '/v1/decode', Buffer.from('x'));
    expect(ex.status).toBe(422);
    expect(json(ex)).toEqual({ error: 'decode', reason: 'exit 1' });
  });

  it('track 200 is chunked with an X-Media-Exit trailer of both exits', async () => {
    const sock = await start();
    const r = await post(sock, '/v1/track', track({}));
    expect(r.headers['transfer-encoding']).toBe('chunked');
    expect(r.headers['trailer']).toBe('X-Media-Exit');
    const t = decodeExitTrailer(r.trailers['x-media-exit']);
    expect(t?.ytDlp.code).toBe(0);
    expect(t?.ffmpeg.code).toBe(0);
  });

  it('socket is mode 0666 after listen', async () => {
    const sock = await start();
    expect(statSync(sock).isSocket()).toBe(true);
    expect(statSync(sock).mode & 0o777).toBe(0o666);
  });

  it('refuses to start over a symlink or regular file at MEDIA_SOCKET', async () => {
    dir = sockDir();
    const sock = join(dir, 'media.sock');
    writeFileSync(sock, 'planted');
    await expect(start()).rejects.toBeInstanceOf(MediaServerRefusal);
    expect(readFileSync(sock, 'utf8')).toBe('planted'); // never unlinked
    rmDir(sock);
    writeFileSync(join(dir, 'target'), 'x');
    symlinkSync(join(dir, 'target'), sock);
    const err = await start().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MediaServerRefusal);
    expect((err as MediaServerRefusal).exitCode).toBe(78);
    expect(lstatSync(sock).isSymbolicLink()).toBe(true);
    rmDir(sock);
    mkdirSync(sock);
    await expect(start()).rejects.toBeInstanceOf(MediaServerRefusal);
  });

  it('refuses a socket directory that is not 0755, not owned by its euid, or a symlink', async () => {
    dir = sockDir();
    chmodSync(dir, 0o700);
    await expect(start()).rejects.toThrow(/mode 0755/);
    chmodSync(dir, 0o775);
    await expect(start()).rejects.toThrow(/mode 0755/);
    chmodSync(dir, 0o755);
    await expect(start({ geteuid: () => (process.geteuid?.() ?? 0) + 1 })).rejects.toThrow(/owned by/);
    const real = lstatSync(dir);
    const foreign = Object.assign(Object.create(Object.getPrototypeOf(real) as object) as typeof real, real, { uid: real.uid + 1 });
    await expect(start({ lstat: (p) => (p === dir ? foreign : lstatSync(p)) })).rejects.toBeInstanceOf(MediaServerRefusal);
    const link = join(dir, 'l');
    mkdirSync(join(dir, 'real'), { mode: 0o755 });
    chmodSync(join(dir, 'real'), 0o755);
    symlinkSync(join(dir, 'real'), link);
    await expect(startMediaServer({ socketPath: join(link, 'media.sock'), ytDlp: YT, ffmpeg: FF, jsRuntime: JS, check: { ok: true }, versions: VERSIONS, log: silent }))
      .rejects.toThrow(/directory/);
  });

  it('unlinks a stale socket and starts', async () => {
    dir = sockDir();
    const sock = join(dir, 'media.sock');
    await staleSocket(sock);
    expect(lstatSync(sock).isSocket()).toBe(true);
    await start();
    expect((await call(sock, 'GET', '/v1/health')).status).toBe(200);
  });

  it('close() stops listening and removes the socket', async () => {
    const sock = await start();
    await srv!.close();
    srv = null;
    expect(existsSync(sock)).toBe(false);
  });

  it('close() unlinks only the socket it bound (dev/ino recorded at listen): a newer instance\'s socket at the path survives', async () => {
    const sock = await start();
    const first = srv!;
    // a second sidecar (rolling restart) replaced the path with its own socket before the first one shut down
    unlinkSync(sock);
    await staleSocket(sock);
    const newer = lstatSync(sock);
    await first.close();
    srv = null;
    expect(existsSync(sock)).toBe(true);
    expect(lstatSync(sock).ino).toBe(newer.ino);
    expect(readdirSync(dir!).filter((n) => n !== 'media.sock')).toEqual([]); // no temporary bind name left behind
  });

  it('the listening socket is bound under a temporary name and renamed into place (libuv\'s own unlink on close never hits MEDIA_SOCKET)', async () => {
    const sock = await start();
    expect(lstatSync(sock).isSocket()).toBe(true);
    expect(readdirSync(dir!)).toEqual(['media.sock']);
    expect((await call(sock, 'GET', '/v1/health')).status).toBe(200);
  });
});
