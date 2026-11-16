import { chmodSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EventBus, type AppEvents } from '../../core/index.js';
import { buildFfmpegArgs, buildYtDlpArgs, MusicInputError, normaliseQuery, prepareCookies, spawnSafe, startTrack } from './source.js';
import { ALLOW, argvLog, FAKE_JS, FAKE_YTDLP, fakeTrackOptions, musicRig, pidAlive, scratch, silent, waitFor } from './test-helpers.js';

const CAPS = { capBytes: 50_000_000, capSeconds: 1200, allowlist: ALLOW, jsRuntime: '/usr/local/bin/node' };
const FIXED = ['--ignore-config', '--no-plugin-dirs', '--no-exec', '--no-playlist', '--no-cache-dir', '--no-write-info-json', '--no-write-thumbnail', '--no-write-subs', '--no-write-comments'];
const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
const ROOT = join(import.meta.dirname, '..', '..');

describe('music.test.ts', () => {
  it('search "-o /app/x" stays after -- with ytsearch1:', () => {
    const a = buildYtDlpArgs('-o /app/x', CAPS);
    expect(a.at(-2)).toBe('--');
    expect(a.at(-1)).toBe('ytsearch1:-o /app/x');
    expect(a.indexOf('--')).toBe(a.length - 2);
    expect(a.filter((x) => x === '/app/x')).toEqual([]); // never a separate argument
    expect(a.filter((x) => x === '-o')).toHaveLength(1); // only our own `-o -`
    expect(after(a, '-o')).toBe('-');
  });

  it('http://10.0.0.1/a.m3u8 and any non-allowlisted host refused', () => {
    for (const bad of ['http://10.0.0.1/a.m3u8', 'https://evil.example/watch?v=dQw4w9WgXcQ', 'https://youtube.com.evil.example/x', 'https://youtube.com./watch?v=a',
      'https://user:pw@youtube.com/watch?v=a', 'https://youtube.com:8443/watch?v=a', 'https://[::1]/x', 'https://127.0.0.1/x', 'ftp://youtube.com/x',
      'file:///etc/passwd', 'data:text/plain,hi', 'javascript:alert(1)']) {
      expect(() => normaliseQuery(bad, ALLOW), bad).toThrow(MusicInputError);
      expect(() => buildYtDlpArgs(bad, CAPS), bad).toThrow(MusicInputError);
    }
    expect(normaliseQuery('https://www.youtube.com/watch?v=dQw4w9WgXcQ#t=3', ALLOW)).toMatchObject({ kind: 'url', target: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
    expect(normaliseQuery('http://youtu.be/dQw4w9WgXcQ', ALLOW).target).toBe('https://youtu.be/dQw4w9WgXcQ'); // re-serialised, upgraded
    expect(normaliseQuery('music.youtube.com/watch?v=dQw4w9WgXcQ', ALLOW).target).toBe('https://music.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(normaliseQuery('HTTPS://WWW.YOUTUBE.COM/watch?v=dQw4w9WgXcQ', ALLOW).target).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(normaliseQuery('Artist: Song name', ALLOW)).toMatchObject({ kind: 'search', target: 'ytsearch1:Artist: Song name' }); // a colon is not a scheme
    expect(() => normaliseQuery('   ', ALLOW)).toThrow(MusicInputError);
    expect(() => normaliseQuery('x'.repeat(301), ALLOW)).toThrow(MusicInputError);
  });

  it('ffmpeg argv has protocol_whitelist pipe and pipe:0 input', () => {
    const a = buildFfmpegArgs();
    expect(after(a, '-protocol_whitelist')).toBe('pipe');
    expect(after(a, '-i')).toBe('pipe:0');
    expect(a.indexOf('-protocol_whitelist')).toBeLessThan(a.indexOf('-i')); // an input option: before -i or it does not apply
    expect(a.filter((x) => x === '-i')).toHaveLength(1);
    expect(a.slice(a.indexOf('-i') + 2)).toEqual(['-vn', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1']);
    expect(a.join(' ')).not.toMatch(/http|file|concat|subfile|reconnect/);
  });

  it('ffmpeg whitelists: formats, codecs and protocol (Gate 2 G2-01)', () => {
    const a = buildFfmpegArgs();
    expect(after(a, '-format_whitelist')).toBe('matroska,webm,mov,mp4,m4a,3gp,3g2,mj2,mp3');
    expect(after(a, '-codec_whitelist')).toBe('opus,aac,mp3,mp3float,vorbis');
    expect(after(a, '-protocol_whitelist')).toBe('pipe');
  });

  it('the Dockerfile ffmpeg stage compiles in only the demuxers, decoders, parsers and protocol Praw needs', () => {
    const df = readFileSync(join(ROOT, 'deploy', 'Dockerfile'), 'utf8');
    const ff = df.slice(df.indexOf('AS ffmpeg'), df.indexOf('FROM ${NODE_IMAGE}\nENV'));
    const enabled = (kind: string) => new RegExp(`--enable-${kind}=([^\\s;\\\\]+)`).exec(ff)?.[1]?.split(',').sort();
    expect(enabled('demuxer')).toEqual(['matroska', 'mov', 'mp3']);
    expect(enabled('decoder')).toEqual(['aac', 'mp3', 'mp3float', 'opus', 'vorbis']);
    expect(enabled('parser')).toEqual(['aac', 'mpegaudio', 'opus', 'vorbis']);
    expect(enabled('protocol')).toEqual(['pipe']);
    expect(enabled('muxer')).toEqual(['pcm_s16le']);
    expect(enabled('encoder')).toEqual(['pcm_s16le']);
    // the build checks the resulting lists too
    for (const w of ['-demuxers', '-decoders', '-protocols', '-muxers', '-encoders']) expect(ff, w).toContain(w);
  });

  describe('halt kills children (also /stop, timeout, leaving voice)', () => {
    async function playing(o: { timeoutMs?: number } = {}) {
      const dir = scratch();
      const pids = join(dir, 'pids');
      const rig = musicRig({ track: { extraEnv: { FAKE_YTDLP_HANG: pids }, ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) } });
      const r = await rig.player.play('u1', 'a long song');
      expect(r.ok).toBe(true);
      const line = await waitFor(() => existsSync(pids) && readFileSync(pids, 'utf8').trim());
      const [self, grandchild] = line.split(' ').slice(1).map(Number) as [number, number];
      expect(pidAlive(self) && pidAlive(grandchild)).toBe(true);
      return { ...rig, self, grandchild };
    }
    const gone = (t: { self: number; grandchild: number }) => waitFor(() => !pidAlive(t.self) && !pidAlive(t.grandchild), 2000);

    it('/halt: the whole process group (yt-dlp and its own child) is gone within 2 s', async () => {
      const t = await playing();
      const bus = new EventBus<AppEvents>(silent);
      t.voice.leaveOnHalt(bus);
      await bus.emit('halt.changed', { halted: true, by: 'owner' });
      await gone(t);
      expect(t.voice.current()).toBeNull();
      expect(t.queue.list().current).toBeNull(); // /halt clears the queue
    });

    it('/stop', async () => {
      const t = await playing();
      expect((await t.player.stop()).ok).toBe(true);
      await gone(t);
      expect(t.queue.list()).toMatchObject({ current: null, upcoming: [] });
      expect(t.voice.current()).not.toBeNull(); // stop keeps Praw in the channel
    });

    it('timeout', async () => {
      const t = await playing({ timeoutMs: 300 });
      await gone(t);
    });

    it('leaving voice', async () => {
      const t = await playing();
      await t.voice.leave();
      await gone(t);
    });
  });
});

describe('args', () => {
  it('fixed flags present (--ignore-config … --use-extractors youtube), no -U', () => {
    const a = buildYtDlpArgs('some song', CAPS);
    for (const f of FIXED) expect(a, f).toContain(f);
    expect(after(a, '--max-filesize')).toBe('50000000');
    expect(after(a, '--match-filters')).toBe('duration<=1200'); // canonical name of --match-filter (yt-dlp options.py)
    expect(after(a, '--use-extractors')).toBe('youtube,youtube:search'); // ytsearch1: is the youtube:search extractor
    expect(after(a, '-f')).toBe('bestaudio/best');
    expect(a.slice(a.indexOf('--no-js-runtimes'), a.indexOf('--no-js-runtimes') + 3)).toEqual(['--no-js-runtimes', '--js-runtimes', 'node:/usr/local/bin/node']);
    for (const f of ['--no-remote-components', '-q', '--no-progress']) expect(a).toContain(f);
    expect(after(a, '--downloader')).toBe('native'); // yt-dlp never hands a URL to an ffmpeg of its own
    expect(after(a, '--fixup')).toBe('never');
    expect(after(a, '-o')).toBe('-');
    for (const bad of ['-U', '--update', '--update-to', '--exec', '--print', '-O', '--remote-components', '--plugin-dirs', '--config-locations', '--load-info-json', '-a', '--batch-file'])
      expect(a, bad).not.toContain(bad);
    expect(a).not.toContain('--cookies');
    const withCookies = buildYtDlpArgs('some song', { ...CAPS, cookiesTmpPath: '/tmp/lw-child-x/cookies.txt' });
    expect(after(withCookies, '--cookies')).toBe('/tmp/lw-child-x/cookies.txt');
    expect(() => buildYtDlpArgs('x', { ...CAPS, jsRuntime: 'node' })).toThrow(); // absolute path only: no PATH lookup
    expect(() => buildYtDlpArgs('x', { ...CAPS, capSeconds: 0 })).toThrow();
  });

  it('URL with leading "-" or file:// or shell metacharacters never becomes a flag or shell string', () => {
    for (const q of ['--exec "rm -rf /"', '-U', '--config-locations /etc/x', '; rm -rf / #', '$(id)', '`id`', '| nc 10.0.0.1 1', '&& curl x', "' OR 1=1 --", 'a\nb\r\n--exec x', '-o/app/x']) {
      const a = buildYtDlpArgs(q, CAPS);
      expect(a.at(-2)).toBe('--');
      expect(a.at(-1)!.startsWith('ytsearch1:')).toBe(true);
      expect(a.at(-1)).not.toMatch(/[\n\r]/); // control characters become spaces
      expect(a.slice(0, -1)).not.toContain('-U');
      expect(a.filter((x) => x === '--exec')).toEqual([]);
    }
    expect(() => buildYtDlpArgs('file:///etc/passwd', CAPS)).toThrow(MusicInputError);
    expect(() => buildYtDlpArgs('-https://youtube.com/watch?v=a', CAPS)).not.toThrow(); // just a search term
    expect(buildYtDlpArgs('https://youtube.com/watch?v=a;id&x=$(id)', CAPS).at(-1)).toBe('https://youtube.com/watch?v=a;id&x=$(id)'); // inert: no shell
  });
});

describe('spawn', () => {
  it('fake yt-dlp argv logged exactly; shell never used (spawn option shell false)', async () => {
    const dir = scratch();
    const log = join(dir, 'argv');
    const marker = join(dir, 'pwned');
    const t = startTrack(`x; touch ${marker} $(touch ${marker})`, fakeTrackOptions({ extraEnv: { FAKE_ARGV_LOG: log } }));
    const chunks: Buffer[] = [];
    for await (const c of t.pcm) chunks.push(c as Buffer);
    await t.done;
    expect(Buffer.concat(chunks).toString()).toBe('fake-audio'); // yt-dlp stdout → our ffmpeg stdin → PCM out
    const [argv] = argvLog(log);
    expect(argv).toEqual(buildYtDlpArgs(`x; touch ${marker} $(touch ${marker})`, { ...CAPS, capBytes: 1_000_000, capSeconds: 600, jsRuntime: FAKE_JS }));
    expect(existsSync(marker)).toBe(false);
    const src = readFileSync(join(import.meta.dirname, 'source.ts'), 'utf8');
    expect(src).toMatch(/shell:\s*false/);
    expect(src).not.toMatch(/shell:\s*true|\bexec(Sync)?\(/);
  });

  it('a leader that dies on its own takes its process group with it (no orphan holding the pipe)', async () => {
    const pids = join(scratch(), 'pids');
    const c = spawnSafe(FAKE_YTDLP, ['ytsearch1:x'], { timeoutMs: 30_000, stdoutCap: 1000, extraEnv: { FAKE_YTDLP_HANG: pids } });
    c.stdout.resume();
    const line = await waitFor(() => existsSync(pids) && readFileSync(pids, 'utf8').trim());
    const [self, grandchild] = line.split(' ').slice(1).map(Number) as [number, number];
    process.kill(self, 'SIGKILL'); // only the leader, like a crash
    await waitFor(() => !pidAlive(grandchild), 2000);
    await c.done;
  });

  it('M1: a spawn that throws removes the private HOME (and the cookies copy in it)', () => {
    let home = '';
    expect(() => spawnSafe(FAKE_YTDLP, (h) => {
      home = h;
      writeFileSync(join(h, 'cookies.txt'), 'x', { mode: 0o600 });
      return ['bad\0arg'];
    }, { timeoutMs: 1000, stdoutCap: 10 })).toThrow();
    expect(home).toMatch(/lw-child-/);
    expect(existsSync(home)).toBe(false);
  });

  it('stdout over the cap kills the child', async () => {
    const c = spawnSafe(FAKE_YTDLP, ['ytsearch1:x'], { timeoutMs: 5000, stdoutCap: 3 });
    c.stdout.resume();
    const r = await c.done;
    expect(r.reason).toBe('stdout-cap');
  });
});

describe('music', () => {
  it('cookies file is mode 0600, read-only, copied to tmpfs, absent from the image', async () => {
    const dir = scratch();
    const src = join(dir, 'cookies.txt');
    writeFileSync(src, '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tabc\n', { mode: 0o600 });
    const home = scratch();
    const copy = prepareCookies(src, home);
    expect(copy.startsWith(home)).toBe(true);
    expect(statSync(copy).mode & 0o777).toBe(0o600);
    expect(readFileSync(copy, 'utf8')).toBe(readFileSync(src, 'utf8'));
    chmodSync(src, 0o644);
    expect(() => prepareCookies(src, scratch())).toThrow(/0600/);
    chmodSync(src, 0o600);
    expect(() => prepareCookies(dir, scratch())).toThrow(/regular file/);

    // yt-dlp gets the copy inside its private HOME, which is removed when it exits; the mounted original is never passed.
    const log = join(dir, 'argv');
    const t = startTrack('song', fakeTrackOptions({ cookiesFile: src, extraEnv: { FAKE_ARGV_LOG: log } }));
    t.pcm.resume();
    await t.done;
    const passed = argvLog(log)[0]![argvLog(log)[0]!.indexOf('--cookies') + 1]!;
    expect(passed).not.toBe(src);
    expect(passed).toMatch(/lw-child-[^/]+\/cookies\.txt$/);
    expect(existsSync(passed)).toBe(false); // deleted after the call

    // never in the image: no cookies in the build context or the Dockerfile
    expect(readFileSync(join(ROOT, '.dockerignore'), 'utf8')).toMatch(/^\*\*\/\*cookies\*$/m);
    expect(readFileSync(join(ROOT, 'deploy', 'Dockerfile'), 'utf8')).not.toMatch(/cookie/i);
    expect(readdirSync(ROOT).filter((n) => /cookie/i.test(n))).toEqual([]);
  });
});
