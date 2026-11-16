import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { Transform, type Readable, type Writable } from 'node:stream';
import { childEnv } from '../../core/child-env.js';

/** A refusal shown to the user as is (bad link, host not allowed, empty query). Never carries a secret. */
export class MusicInputError extends Error {
  override readonly name = 'MusicInputError';
}

export const MAX_QUERY = 300;
/** A scheme-qualified URL, or one of the schemes yt-dlp/ffmpeg would act on even without `//`. "Artist: Song" stays a search. */
const URLISH = /^[a-z][a-z0-9+.-]*:\/\/|^(?:https?|file|data|javascript|blob|ftps?|rtmp[a-z]*|rtsp|mms|smb):/i;
const BARE_YT = /^(?:(?:www|m|music)\.)?(?:youtube\.com|youtu\.be)\//i;

export type MusicTarget = { kind: 'url' | 'search'; value: string; target: string };

/**
 * P7: user input is either an https URL whose exact host is on `media.ytHostAllowlist` (no credentials, no port; re-serialised
 * by WHATWG URL, fragment dropped) or a search term the code prefixes with `ytsearch1:`. Control characters become spaces.
 * Idempotent: normalising `value` again gives the same target (the queue stores `value` and re-checks it at play time).
 */
export function normaliseQuery(raw: string, allowlist: readonly string[]): MusicTarget {
  const q = String(raw).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!q) throw new MusicInputError('Tell me what to play (a song name or a YouTube link).');
  if (q.length > MAX_QUERY) throw new MusicInputError(`That is too long; use at most ${MAX_QUERY} characters.`);
  const s = BARE_YT.test(q) ? `https://${q}` : q;
  if (!URLISH.test(s)) return { kind: 'search', value: q, target: `ytsearch1:${q}` };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new MusicInputError('That link is not a valid URL.');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new MusicInputError('Only YouTube links (https) can be played.');
  if (u.username || u.password || u.port) throw new MusicInputError('Links with a user name, password or port are not allowed.');
  const host = u.hostname.toLowerCase();
  if (!allowlist.some((h) => h.toLowerCase() === host)) throw new MusicInputError(`Links from ${host.slice(0, 100)} are not allowed; only YouTube.`);
  u.protocol = 'https:';
  u.hash = '';
  return { kind: 'url', value: u.href, target: u.href };
}

export interface YtDlpArgOptions {
  cookiesTmpPath?: string;
  capBytes: number;
  capSeconds: number;
  allowlist: readonly string[];
  /** Absolute path of the JS runtime for YouTube's challenge (the image's node; never a PATH lookup, never a deno download). */
  jsRuntime: string;
}

/** Flags that never change (P7). Verified against the yt-dlp 2026.10.26 README and options.py (task-36-report Step 0). */
const FIXED = ['--ignore-config', '--no-plugin-dirs', '--no-exec', '--no-playlist', '--no-cache-dir', '--no-write-info-json', '--no-write-thumbnail', '--no-write-subs', '--no-write-comments'];

const posInt = (n: number, what: string) => {
  if (!Number.isInteger(n) || n < 1) throw new Error(`${what} must be a positive integer`);
  return String(n);
};

/**
 * yt-dlp argv as an array (spawned with shell:false). The target is always last, after `--`. `--use-extractors` lists
 * `youtube:search` too, because `ytsearch1:` is handled by that extractor and the names are matched as whole regexes; the generic
 * extractor is never loaded. `--downloader native` + `--fixup never` keep yt-dlp from running an ffmpeg of its own on a remote URL.
 * Output is the media on stdout (`-o -`), so nothing else may print there (`-q`, no `--print`). Never `-U`.
 */
export function buildYtDlpArgs(input: string, o: YtDlpArgOptions): string[] {
  const t = normaliseQuery(input, o.allowlist);
  if (!isAbsolute(o.jsRuntime) || o.jsRuntime.includes('\0')) throw new Error('jsRuntime must be an absolute path');
  return [
    ...FIXED,
    '--max-filesize', posInt(o.capBytes, 'capBytes'),
    '--match-filters', `duration<=${posInt(o.capSeconds, 'capSeconds')}`,
    '--use-extractors', 'youtube,youtube:search',
    '--no-js-runtimes', '--js-runtimes', `node:${o.jsRuntime}`, '--no-remote-components',
    '--downloader', 'native', '--fixup', 'never',
    '-f', 'bestaudio/best', '-q', '--no-warnings', '--no-progress', '--socket-timeout', '20',
    ...(o.cookiesTmpPath ? ['--cookies', o.cookiesTmpPath] : []),
    '-o', '-',
    '--', t.target,
  ];
}

/**
 * Our ffmpeg: reads only pipe:0 (no file/http/concat/subfile, also for nested playlists) and writes raw s16le 48 kHz stereo.
 * Gate 2 G2-01: only the demuxers (YouTube webm/m4a/mp4, Edge TTS mp3) and audio decoders we need are opened, also while
 * probing, so unpatched demuxers/decoders/parsers (mpegts, CFHD, DVB subtitles, RTSP...) are never reached by remote media.
 */
export const buildFfmpegArgs = (): string[] =>
  ['-hide_banner', '-loglevel', 'error', '-format_whitelist', 'matroska,webm,mov,mp4,m4a,3gp,3g2,mj2,mp3', '-codec_whitelist', 'opus,aac,mp3,mp3float,vorbis',
    '-protocol_whitelist', 'pipe', '-i', 'pipe:0', '-vn', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'];

const COOKIES_MAX = 1024 * 1024;

/**
 * P7: the optional cookies file (a throwaway non-owner account, mounted read-only 0600, never in the image) is checked and copied
 * into `dir` (the child's private HOME on the tmpfs, removed when the child exits). yt-dlp only ever sees the copy.
 */
export function prepareCookies(src: string, dir: string): string {
  const st = lstatSync(src);
  if (!st.isFile()) throw new Error('the cookies file must be a regular file (no symlink or directory)');
  if ((st.mode & 0o777) !== 0o600) throw new Error('the cookies file must have mode 0600');
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error('the cookies file must be owned by the app user');
  if (st.size > COOKIES_MAX) throw new Error('the cookies file is too large');
  const fd = openSync(src, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const now = fstatSync(fd);
    if (now.ino !== st.ino || now.dev !== st.dev) throw new Error('the cookies file changed while it was read');
    const dest = join(dir, 'cookies.txt');
    writeFileSync(dest, readFileSync(fd), { mode: 0o600, flag: 'wx' });
    return dest;
  } finally {
    closeSync(fd);
  }
}

export interface SpawnSafeOptions {
  timeoutMs: number;
  /** Bytes allowed on stdout; more kills the child (reason `stdout-cap`). */
  stdoutCap: number;
  /** Give the child a stdin pipe (ffmpeg); default none. */
  stdin?: boolean;
  /** Documented per-tool keys only (tests: the fakes' FAKE_* switches); childEnv refuses secret names (P8). */
  extraEnv?: Record<string, string>;
}

export type SafeExit = { code: number | null; signal: string | null; reason: string | null; stderr: string };
export interface SafeChild {
  child: ChildProcess;
  stdout: Readable;
  stdin: Writable | null;
  kill(reason: string): void;
  done: Promise<SafeExit>;
}

const STDERR_KEEP = 2048;

/**
 * Spawns with shell:false, `childEnv()` (P8: never process.env; private HOME per call, removed on exit) and its own process group,
 * so a kill reaches its children too (yt-dlp's JS runtime). Killed with SIGKILL to the group on kill(), timeout and stdout cap;
 * the group is killed again when the leader exits, so no orphan survives. `args` may be built from the private HOME (cookies copy).
 */
export function spawnSafe(bin: string, args: string[] | ((home: string) => string[]), o: SpawnSafeOptions): SafeChild {
  const c = childEnv(o.extraEnv ?? {});
  let child: ChildProcess;
  try {
    const argv = typeof args === 'function' ? args(c.env.HOME!) : args;
    child = spawn(bin, argv, { env: c.env, shell: false, detached: true, windowsHide: true, stdio: [o.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  } catch (err) {
    c.cleanup(); // the private HOME (and a cookies copy in it) never outlives a failed spawn
    throw err;
  }
  let reason: string | null = null;
  let groupGone = false;
  const killGroup = () => {
    if (groupGone || !child.pid) return;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  };
  const kill = (why: string) => {
    reason ??= why;
    killGroup();
  };
  const timer = setTimeout(() => kill('timeout'), o.timeoutMs);
  timer.unref?.();
  let n = 0;
  const stdout = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      n += chunk.length;
      if (n > o.stdoutCap) {
        kill('stdout-cap');
        cb();
        return;
      }
      cb(null, chunk);
    },
  });
  child.stdout!.pipe(stdout);
  let stderr = '';
  child.stderr!.on('data', (b: Buffer) => (stderr = (stderr + b.toString()).slice(-STDERR_KEEP)));
  child.stdin?.on('error', () => undefined); // EPIPE once the child is gone
  const done = new Promise<SafeExit>((resolve) => {
    let settled = false;
    const finish = (code: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killGroup(); // grandchildren of an exited leader
      groupGone = true;
      c.cleanup();
      resolve({ code, signal, reason, stderr });
    };
    child.once('error', (e) => {
      reason ??= `spawn failed: ${e.message.slice(0, 200)}`;
      stdout.end();
      finish(null, null);
    });
    // 'close' waits for stdio, which a surviving grandchild would hold open: kill the group as soon as the leader exits
    child.once('exit', () => killGroup());
    child.once('close', (code, signal) => finish(code, signal));
  });
  return { child, stdout, stdin: child.stdin, kill, done };
}

export interface TrackOptions {
  ytDlp: string;
  ffmpeg: string;
  jsRuntime: string;
  allowlist: () => readonly string[];
  capBytes: number;
  capSeconds: number;
  /** YTDLP_COOKIES_FILE; checked and copied per call (prepareCookies). */
  cookiesFile?: string;
  extraEnv?: Record<string, string>;
  /** Wall-clock bound for one track (default capSeconds + 120 s). */
  timeoutMs?: number;
  log: { warn(o: object, m?: string): void };
}

export interface TrackHandle {
  /** Raw s16le 48 kHz stereo PCM (the voice session's AudioSource). */
  pcm: Readable;
  kill(reason: string): void;
  done: Promise<{ ytDlp: SafeExit; ffmpeg: SafeExit }>;
}

/** PCM bytes of capSeconds of audio plus slack: our ffmpeg can never emit more than that. */
const pcmCap = (capSeconds: number) => capSeconds * 48_000 * 2 * 2 + 1024 * 1024;

/** yt-dlp (stdout, bestaudio) → our ffmpeg (pipe:0 only) → raw PCM. Both children are spawnSafe; kill() ends both groups. */
export function startTrack(query: string, o: TrackOptions): TrackHandle {
  const timeoutMs = o.timeoutMs ?? (o.capSeconds + 120) * 1000;
  const extraEnv = o.extraEnv ?? {};
  const yt = spawnSafe(o.ytDlp, (home) => buildYtDlpArgs(query, {
    capBytes: o.capBytes, capSeconds: o.capSeconds, allowlist: o.allowlist(), jsRuntime: o.jsRuntime,
    ...(o.cookiesFile ? { cookiesTmpPath: prepareCookies(o.cookiesFile, home) } : {}),
  }), { timeoutMs, stdoutCap: o.capBytes, extraEnv });
  let ff: SafeChild;
  try {
    ff = spawnSafe(o.ffmpeg, buildFfmpegArgs(), { timeoutMs, stdoutCap: pcmCap(o.capSeconds), stdin: true, extraEnv });
  } catch (err) {
    yt.kill('ffmpeg failed to start');
    throw err;
  }
  yt.stdout.on('error', () => undefined);
  yt.stdout.pipe(ff.stdin!);
  const kill = (why: string) => {
    yt.kill(why);
    ff.kill(why);
  };
  const done = Promise.all([yt.done, ff.done]).then(([ytDlp, ffmpeg]) => {
    if ((ytDlp.code !== 0 && !ytDlp.reason) || ytDlp.reason === 'timeout' || ytDlp.reason === 'stdout-cap' || ffmpeg.reason === 'stdout-cap')
      o.log.warn({ ytDlp: ytDlp.code, ytReason: ytDlp.reason, ffmpeg: ffmpeg.code, ffReason: ffmpeg.reason, err: ytDlp.stderr.slice(-300) }, 'music track ended abnormally');
    return { ytDlp, ffmpeg };
  });
  return { pcm: ff.stdout, kill, done };
}
