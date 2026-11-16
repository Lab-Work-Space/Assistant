import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeExec } from '../voice/exec.js';
import { MusicInputError } from '../voice/music/source.js';
import { LocalMediaBackend, type LocalMediaBackendOptions } from './backend.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fakes', 'bin');
const YT = join(BIN, 'yt-dlp');
const FF = join(BIN, 'ffmpeg');
const JS = join(BIN, 'js-runtime');
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const ALLOW = ['youtube.com', 'www.youtube.com'];
const log = { warn() {} };
let tmp: string | null = null;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

const make = (over: Partial<LocalMediaBackendOptions> = {}) =>
  new LocalMediaBackend({ ytDlp: YT, ffmpeg: FF, jsRuntime: JS, expectedSha256: { ytDlp: sha(YT), ffmpeg: sha(FF) }, exec: nodeExec, log, ...over });
const caps = { allowlist: ALLOW, capBytes: 1_000_000, capSeconds: 600 };

describe('LocalMediaBackend', () => {
  it('health over tests/fakes/bin returns {ok:true}', async () => {
    expect((await make().health()).check).toEqual({ ok: true });
  });

  it('health with null expectedSha256 reports both mismatched', async () => {
    const h = await make({ expectedSha256: null }).health();
    expect(h.check).toEqual({ ok: false, missing: [], mismatched: ['yt-dlp', 'ffmpeg'] });
    expect(h.why).toMatch(/^no pinned sha256 for [a-z0-9]+$/); // the pre-seam boot alert text is kept
  });

  it('startTrack passes allowlist/caps through and pcm yields the fake bytes; done has ytDlp/ffmpeg SafeExit', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'media-backend-'));
    const argv = join(tmp, 'argv.log');
    const t = make({ extraEnv: { FAKE_ARGV_LOG: argv } }).startTrack('https://www.youtube.com/watch?v=abc', { ...caps, capBytes: 777_000, capSeconds: 321 });
    const parts: Buffer[] = [];
    for await (const c of t.pcm) parts.push(c as Buffer);
    expect(Buffer.concat(parts).toString()).toBe('fake-audio');
    const done = await t.done;
    expect(done.ytDlp).toBeDefined();
    expect(done.ffmpeg).toBeDefined();
    expect(done.ytDlp.code).toBe(0);
    expect(done.ffmpeg.code).toBe(0);
    const line = readFileSync(argv, 'utf8');
    expect(line).toContain('777000');
    expect(line).toContain('321');
  });

  it('startTrack throws MusicInputError synchronously for a bad host', () => {
    expect(() => make().startTrack('https://evil.example/x', caps)).toThrow(MusicInputError);
  });

  it('decode returns PCM; stdout-cap gives \'the reply is too long to speak (decoded audio over its cap)\'', async () => {
    expect((await make().decode(Buffer.from('MP3DATA'))).toString()).toBe('MP3DATA');
    const { decodeToPcm } = await import('./decode.js');
    await expect(decodeToPcm(Buffer.alloc(4096), { ffmpeg: FF, timeoutMs: 5000, capBytes: 1024 })).rejects.toThrow(
      'the reply is too long to speak (decoded audio over its cap)',
    );
  });

  it('extraEnv reaches the fake (FAKE_* switch) and childEnv still refuses a secret name', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'media-backend-'));
    const log2 = join(tmp, 'ff.log');
    await make({ extraEnv: { FAKE_BIN_LOG: log2 } }).decode(Buffer.from('x'));
    expect(readFileSync(log2, 'utf8')).toContain('-protocol_whitelist pipe');
    const bad = make({ extraEnv: { GEMINI_API_KEY: 'x' } });
    await expect(bad.decode(Buffer.from('x'))).rejects.toThrow(/may not be passed/);
    expect(() => bad.startTrack('https://www.youtube.com/watch?v=abc', caps)).toThrow(/may not be passed/);
  });

  it('LocalMediaBackend › refuses in a container', async () => {
    let execs = 0;
    const b = make({ inContainer: () => 'running in a container', exec: async (f, a) => (execs++, nodeExec(f, a)) });
    expect(await b.health()).toEqual({ check: { ok: false, missing: ['yt-dlp', 'ffmpeg'], mismatched: [] }, why: 'media sidecar not configured' });
    let thrown: unknown;
    try {
      b.startTrack('https://www.youtube.com/watch?v=abc', caps);
    } catch (e) {
      thrown = e;
    }
    // a plain Error, never MusicInputError: MusicPlayer pauses on it instead of skipping (draining) the queue
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(MusicInputError);
    expect((thrown as Error).message).toBe('media sidecar not configured');
    await expect(b.decode(Buffer.from('x'))).rejects.toThrow(/^media sidecar not configured$/);
    expect(execs).toBe(0); // nothing ran, not even a version check
  });

  it('exec defaults to nodeExec (app.ts imports no spawn helper)', async () => {
    const { exec: _omit, ...rest } = { ytDlp: YT, ffmpeg: FF, jsRuntime: JS, expectedSha256: { ytDlp: sha(YT), ffmpeg: sha(FF) }, exec: nodeExec, log };
    expect((await new LocalMediaBackend(rest).health()).check).toEqual({ ok: true });
  });
});
