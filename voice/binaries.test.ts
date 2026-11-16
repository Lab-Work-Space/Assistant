import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { MediaBackend } from '../media/backend.js';
import { binaryGroupsDisabled, bootBinaries, checkBinaries, hashPath, PINNED_BINARIES, pinnedFor, type BinaryCheck, type Exec } from './binaries.js';
import { nodeExec } from './exec.js';
import { bootBinaries as bootBinariesReexport, bootMedia } from './index.js';
import { probeVoiceLibrary } from './library.js';
import { buildFfmpegArgs } from './music/source.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'tests', 'fakes', 'bin');
const YT = join(BIN, 'yt-dlp');
const FF = join(BIN, 'ffmpeg');
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const good = { ytDlp: sha(YT), ffmpeg: sha(FF) };

const recordingExec = () => {
  const ran: string[] = [];
  const exec: Exec = async (file, args) => {
    ran.push(`${file} ${args.join(' ')}`);
    return nodeExec(file, args);
  };
  return { ran, exec };
};

let tmp: string | null = null;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('binaries', () => {
  it('ok when both binaries exist, match their pinned sha256 and run', async () => {
    const { ran, exec } = recordingExec();
    expect(await checkBinaries({ ytDlp: YT, ffmpeg: FF, exec, expectedSha256: good })).toEqual({ ok: true });
    expect(ran).toEqual([`${YT} --ignore-config --version`, `${FF} -hide_banner -version`]);
  });

  it('missing yt-dlp or ffmpeg disables music/voice groups with an alert, boot continues', async () => {
    const { exec } = recordingExec();
    const noYt = await checkBinaries({ ytDlp: join(BIN, 'nope-yt-dlp'), ffmpeg: FF, exec, expectedSha256: good });
    expect(noYt).toEqual({ ok: false, missing: ['yt-dlp'], mismatched: [] });
    const off = binaryGroupsDisabled(noYt);
    expect(off.map((d) => d.id)).toEqual(['music']); // voice chat needs only ffmpeg
    expect(off[0]!.why).toMatch(/yt-dlp/);

    const noFf = await checkBinaries({ ytDlp: YT, ffmpeg: join(BIN, 'nope-ffmpeg'), exec, expectedSha256: good });
    expect(noFf).toEqual({ ok: false, missing: ['ffmpeg'], mismatched: [] });
    expect(binaryGroupsDisabled(noFf).map((d) => d.id)).toEqual(['music', 'voice']);
    expect(binaryGroupsDisabled({ ok: true })).toEqual([]);

    // an exec that throws never fails the boot: the binary counts as missing
    const boom: Exec = async () => { throw new Error('ENOEXEC'); };
    expect(await checkBinaries({ ytDlp: YT, ffmpeg: FF, exec: boom, expectedSha256: good })).toEqual({ ok: false, missing: ['yt-dlp', 'ffmpeg'], mismatched: [] });
  });

  it('a wrong sha256 is mismatched and the binary is never executed', async () => {
    const { ran, exec } = recordingExec();
    const r = await checkBinaries({ ytDlp: YT, ffmpeg: FF, exec, expectedSha256: { ytDlp: '0'.repeat(64), ffmpeg: good.ffmpeg } });
    expect(r).toEqual({ ok: false, missing: [], mismatched: ['yt-dlp'] });
    expect(ran.some((c) => c.startsWith(YT))).toBe(false);
    expect(binaryGroupsDisabled(r).map((d) => d.id)).toEqual(['music']);
  });

  it('a non-zero exit counts as missing', async () => {
    const exec: Exec = async () => ({ code: 1, stdout: '' });
    expect(await checkBinaries({ ytDlp: YT, ffmpeg: FF, exec, expectedSha256: good })).toEqual({ ok: false, missing: ['yt-dlp', 'ffmpeg'], mismatched: [] });
  });

  it('the yt-dlp hash may cover its onedir tree (sha256sum lines of every file, sorted)', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'lw-tree-'));
    mkdirSync(join(tmp, '_internal', 'b'), { recursive: true });
    writeFileSync(join(tmp, 'yt-dlp'), 'launcher');
    writeFileSync(join(tmp, '_internal', 'a.so'), 'A');
    writeFileSync(join(tmp, '_internal', 'b', 'c.so'), 'C');
    const h = (s: string) => createHash('sha256').update(s).digest('hex');
    // what `find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum` prints in the Dockerfile
    const lines = [`${h('A')}  ./_internal/a.so\n`, `${h('C')}  ./_internal/b/c.so\n`, `${h('launcher')}  ./yt-dlp\n`].join('');
    expect(await hashPath(tmp)).toBe(h(lines));
    expect(await hashPath(join(tmp, 'yt-dlp'))).toBe(h('launcher'));
    expect(await hashPath(join(tmp, 'missing'))).toBeNull();
  });

  it('runs every binary with childEnv: no secret from the parent env reaches it', async () => {
    const planted = { BOT_TOKEN_PRAW: 'tok', GEMINI_API_KEY: 'g', DATABASE_URL: 'postgres://x', CONFIG_MASTER_KEY: 'k', NODE_OPTIONS: '--require /x.js' };
    const saved = { ...process.env };
    Object.assign(process.env, planted);
    try {
      const r = await nodeExec(FF, ['--dump-env']);
      expect(r.code).toBe(0);
      const keys = r.stdout.split('\n').map((l) => l.split('=')[0]).filter(Boolean);
      for (const k of Object.keys(planted)) expect(keys).not.toContain(k);
      expect(keys).toContain('HOME');
    } finally {
      for (const k of Object.keys(planted)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  it('pins per architecture; the Dockerfile ARGs equal PINNED_BINARIES (P22)', () => {
    const manifest = { manifest: '/opt/ffmpeg/ffmpeg.sha256' };
    expect(pinnedFor('x64')).toEqual({ ytDlp: PINNED_BINARIES.ytDlp.sha256.x64, ffmpeg: manifest }); // ffmpeg: read from the image's root-owned manifest
    expect(pinnedFor('arm64')).toEqual({ ytDlp: PINNED_BINARIES.ytDlp.sha256.arm64, ffmpeg: manifest });
    expect(PINNED_BINARIES.ffmpeg.manifest).toBe('/opt/ffmpeg/ffmpeg.sha256');
    expect(pinnedFor('ia32')).toBeNull();
    const df = readFileSync(join(ROOT, 'deploy', 'Dockerfile'), 'utf8');
    const arg = (n: string) => new RegExp(`^ARG ${n}=(\\S+)$`, 'm').exec(df)?.[1];
    expect(arg('YTDLP_VERSION')).toBe(PINNED_BINARIES.ytDlp.version);
    expect(arg('YTDLP_TREE_SHA256_AMD64')).toBe(PINNED_BINARIES.ytDlp.sha256.x64);
    expect(arg('YTDLP_TREE_SHA256_ARM64')).toBe(PINNED_BINARIES.ytDlp.sha256.arm64);
    expect(arg('FFMPEG_VERSION')).toBe(PINNED_BINARIES.ffmpeg.version);
    expect(PINNED_BINARIES.ffmpeg.path).toBe('/opt/ffmpeg/ffmpeg');
    expect(arg('FFMPEG_TAR_SHA256')).toMatch(/^[0-9a-f]{64}$/);
    expect(arg('FFMPEG_SIGNER_FPR')).toBe('FCF986EA15E6E293A5644F10B4322F04D67658D8');
    expect([...df.matchAll(/^ARG FFMPEG_VERSION=(\S+)$/gm)].map((m) => m[1])).toEqual(Array(2).fill(PINNED_BINARIES.ffmpeg.version)); // stage + final stage
    expect(df).not.toMatch(/FFMPEG_SHA256_/); // no compiled-in binary hash: the build writes /opt/ffmpeg/ffmpeg.sha256
    expect(df).not.toMatch(/yt-dlp\S*\s+(-U|--update)\b/); // never auto-updated
    // Everything below is asserted on the ffmpeg build stage only: the yt-dlp stage also has sha256sum -c / gpg lines.
    expect(df).not.toMatch(/apk add[^\n]*ffmpeg/);
    const start = df.indexOf('AS ffmpeg');
    const end = df.indexOf('FROM ${NODE_IMAGE}\nENV');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const ff = df.slice(start, end);
    expect(ff.length).toBeGreaterThan(500);
    expect(ff).toMatch(/gpg --batch --status-fd 1 --verify/);
    expect(ff).toMatch(/\$\{FFMPEG_SIGNER_FPR\}/);
    expect(ff).toMatch(/sha256sum -c/);
    expect(ff).toMatch(/--disable-everything/);
    expect(ff).toMatch(/--disable-autodetect/);
    expect(ff).toMatch(/--disable-network/);
    expect(ff).toMatch(/--enable-static/);
    expect(ff).toMatch(/--extra-ldflags=-static/);
    // the static proof must be able to fail the build: `! cmd | grep` is ignored by set -e, so only the if/exit 1 form counts
    expect(ff).toMatch(/if readelf -lW \S+ \| grep -q INTERP; then .*exit 1; fi/);
    expect(ff).toMatch(/if readelf -dW \S+ (2>\/dev\/null )?\| grep -q NEEDED; then .*exit 1; fi/);
    expect(ff).not.toMatch(/(^|;|&&|\|\|)\s*!\s/m);
    expect(ff).toMatch(/\^ffmpeg version \$\{FFMPEG_VERSION\} /);
    expect(ff).not.toMatch(/--enable-(gpl|nonfree|version3|libx|network)/);
    // the build records the binary hash in a root-owned read-only manifest, which the boot check reads
    expect(ff).toMatch(/sha256sum \/opt\/ffmpeg\/ffmpeg > \/opt\/ffmpeg\/ffmpeg\.sha256/);
    expect(ff).toMatch(/chmod 0444 \/opt\/ffmpeg\/ffmpeg\.sha256/);
    // S9 smoke runs the production argv against the committed fixtures and fails the build on any miss
    expect(ff).toContain(buildFfmpegArgs().join(' '));
    for (const f of ['t.mp3', 't.wav', 'hls-http.m3u8', 'hls-rtsp.m3u8']) {
      expect(ff, f).toContain(f);
      expect(existsSync(join(ROOT, 'voice', 'fixtures', 'ffmpeg-smoke', f)), f).toBe(true);
    }
    expect(existsSync(join(ROOT, 'voice', 'ffmpeg-release-key.asc'))).toBe(true);
    expect(df).toContain('/run/media-ipc');
    expect(df).toMatch(/COPY --from=ffmpeg (--chown=root:root )?\/opt\/ffmpeg\/ \/opt\/ffmpeg\//);
  });

  it('the Dockerfile builds with the legacy builder (DOCKER_BUILDKIT=0 in lw-git): no BuildKit-only syntax, TARGETARCH has a uname fallback', () => {
    const df = readFileSync(join(ROOT, 'deploy', 'Dockerfile'), 'utf8');
    expect(df).not.toMatch(/<</); // no heredoc
    expect(df).not.toMatch(/--mount/);
    expect(df).not.toMatch(/--(chmod|link)\b/);
    expect(df).not.toMatch(/^# syntax=/m);
    const rungs = df.match(/^ARG TARGETARCH$/gm) ?? [];
    expect(rungs.length).toBe(2); // yt-dlp and ffmpeg stages
    expect(df.match(/case "\$\(uname -m\)" in/g)?.length).toBe(2);
    expect(df.match(/x86_64\) arch=amd64/g)?.length).toBe(2);
    expect(df.match(/aarch64\) arch=arm64/g)?.length).toBe(2);
    expect(df).not.toMatch(/case "\$\{TARGETARCH:-\}"/); // the case is on the resolved $arch
  });

  it('the ffmpeg make runs at most 2 jobs (lw-git builds under --memory 1536m; plain POSIX sh arithmetic, no BuildKit)', () => {
    const df = readFileSync(join(ROOT, 'deploy', 'Dockerfile'), 'utf8');
    expect(df).not.toMatch(/make -j"\$\(nproc\)"/);
    expect(df.match(/\bmake -j/g)?.length).toBe(1);
    expect(df).toContain('jobs=$(nproc); if [ "$jobs" -gt 2 ]; then jobs=2; fi; make -j"$jobs" ffmpeg;');
  });

  describe('ffmpeg pin from the image manifest (the build is not bit-reproducible across Alpine toolchain updates)', () => {
    const uid = process.getuid!();
    const mk = (content: string, mode = 0o444) => {
      tmp = mkdtempSync(join(tmpdir(), 'lw-mf-'));
      const p = join(tmp, 'ffmpeg.sha256');
      writeFileSync(p, content);
      chmodSync(p, mode);
      return p;
    };
    const run = (manifest: string, ownerUid = uid) => {
      const { ran, exec } = recordingExec();
      return checkBinaries({ ytDlp: YT, ffmpeg: FF, exec, expectedSha256: { ytDlp: good.ytDlp, ffmpeg: { manifest, ownerUid } } }).then((r) => ({ r, ran }));
    };

    it('a good manifest (sha256sum format) enables ffmpeg', async () => {
      const { r } = await run(mk(`${good.ffmpeg}  /opt/ffmpeg/ffmpeg\n`));
      expect(r).toEqual({ ok: true });
    });

    it('missing, wrong owner, writable, symlink, malformed or mismatching manifest disables ffmpeg and never executes it', async () => {
      const cases: [string, string][] = [
        ['missing', join(tmpdir(), 'lw-no-such-manifest')],
        ['wrong owner', mk(`${good.ffmpeg}\n`)],
        ['group/world writable', mk(`${good.ffmpeg}\n`, 0o666)],
        ['malformed', mk('not a hash\n')],
        ['mismatch', mk(`${'0'.repeat(64)}  /opt/ffmpeg/ffmpeg\n`)],
      ];
      for (const [why, p] of cases) {
        const { r, ran } = await run(p, why === 'wrong owner' ? uid + 1 : uid);
        expect(r, why).toEqual({ ok: false, missing: [], mismatched: ['ffmpeg'] });
        expect(ran.some((c) => c.startsWith(FF)), why).toBe(false);
        expect(binaryGroupsDisabled(r).map((d) => d.id), why).toEqual(['music', 'voice']);
      }
      tmp = mkdtempSync(join(tmpdir(), 'lw-mf-'));
      writeFileSync(join(tmp, 'real'), `${good.ffmpeg}\n`, { mode: 0o444 });
      symlinkSync(join(tmp, 'real'), join(tmp, 'link'));
      expect((await run(join(tmp, 'link'))).r).toEqual({ ok: false, missing: [], mismatched: ['ffmpeg'] });
    });

    it('bootBinaries with the production pins reads the image manifest (absent on this host: ffmpeg disabled, yt-dlp too)', async () => {
      const r = await bootBinaries({ ytDlp: YT, ffmpeg: FF }, 'arm64');
      expect(r.check).toMatchObject({ ok: false });
      expect((r.check as { mismatched: string[] }).mismatched).toContain('ffmpeg');
    });
  });

  it('bootMedia(backend) › voice library failure disables music and voice (R13); a failed check keeps the backend\'s why', async () => {
    expect(await probeVoiceLibrary(async () => { throw new Error('Cannot find module @snazzah/davey-linux-x64-musl'); })).toMatch(/voice library failed to load/);
    expect(await probeVoiceLibrary(async () => ({}))).toBeNull();
    const stub = (check: BinaryCheck, why?: string): MediaBackend => ({ health: async () => ({ check, ...(why ? { why } : {}) }), startTrack: () => { throw new Error('unused'); }, decode: async () => Buffer.alloc(0) });
    const r = await bootMedia(stub({ ok: true }), async () => 'voice library failed to load (Error)');
    expect(r.disabled.map((d) => d.id)).toEqual(['music', 'voice']);
    const ok = await bootMedia(stub({ ok: true }), async () => null);
    expect(ok.disabled).toEqual([]);
    const bad = await bootMedia(stub({ ok: false, missing: [], mismatched: ['yt-dlp', 'ffmpeg'] }, 'no pinned sha256 for ia32'), async () => null);
    expect(bad.disabled).toEqual([{ id: 'music', why: 'no pinned sha256 for ia32' }, { id: 'voice', why: 'no pinned sha256 for ia32' }]);
    const both = await bootMedia(stub({ ok: false, missing: ['ffmpeg'], mismatched: [] }), async () => 'lib');
    expect(both.disabled).toEqual([{ id: 'music', why: 'missing or not runnable: ffmpeg; lib' }, { id: 'voice', why: 'missing or not runnable: ffmpeg; lib' }]);
  });

  describe('bootMedia retries', () => {
    const counting = (answers: (BinaryCheck | Error)[]) => {
      let calls = 0;
      const b: MediaBackend = {
        health: async () => {
          const a = answers[Math.min(calls, answers.length - 1)]!;
          calls++;
          if (a instanceof Error) throw a;
          return { check: a };
        },
        startTrack: () => { throw new Error('unused'); },
        decode: async () => Buffer.alloc(0),
      };
      return { b, calls: () => calls };
    };
    const sleeps: number[] = [];
    const sleep = async (ms: number) => void sleeps.push(ms);

    it('bootMedia › retries 10 times then disables music and voice "media sidecar unreachable"', async () => {
      sleeps.length = 0;
      const c = counting([new Error('sidecar-unavailable')]);
      const r = await bootMedia(c.b, async () => null, { sleep });
      expect(c.calls()).toBe(10);
      expect(sleeps).toEqual(Array(9).fill(1500)); // 1.5 s between attempts, none after the last
      expect(r.disabled).toEqual([{ id: 'music', why: 'media sidecar unreachable' }, { id: 'voice', why: 'media sidecar unreachable' }]);
      // a failing voice library is still reported next to it
      const lib = await bootMedia(counting([new Error('x')]).b, async () => 'voice library failed to load (Error)', { sleep, attempts: 2 });
      expect(lib.disabled).toEqual([
        { id: 'music', why: 'media sidecar unreachable; voice library failed to load (Error)' },
        { id: 'voice', why: 'media sidecar unreachable; voice library failed to load (Error)' },
      ]);
    });

    it('bootMedia › success on attempt 3 disables nothing', async () => {
      sleeps.length = 0;
      const c = counting([new Error('a'), new Error('b'), { ok: true }]);
      expect((await bootMedia(c.b, async () => null, { sleep })).disabled).toEqual([]);
      expect(c.calls()).toBe(3);
      expect(sleeps).toEqual([1500, 1500]);
    });

    it('bootMedia › a definite failed check is not retried; its check feeds binaryGroupsDisabled', async () => {
      sleeps.length = 0;
      const c = counting([{ ok: false, missing: [], mismatched: ['yt-dlp'] }]);
      expect((await bootMedia(c.b, async () => null, { sleep })).disabled).toEqual([{ id: 'music', why: 'sha256 mismatch: yt-dlp' }]);
      expect(c.calls()).toBe(1);
      expect(sleeps).toEqual([]);
    });

    it('bootMedia › attempts and delayMs are injectable', async () => {
      sleeps.length = 0;
      const c = counting([new Error('x')]);
      await bootMedia(c.b, async () => null, { sleep, attempts: 3, delayMs: 7 });
      expect(c.calls()).toBe(3);
      expect(sleeps).toEqual([7, 7]);
    });
  });

  it('bootBinaries lives in voice/binaries.ts (the sidecar imports it without voice/index.ts) and voice/index.ts re-exports it', async () => {
    expect(bootBinariesReexport).toBe(bootBinaries);
    const r = await bootBinaries({ ytDlp: YT, ffmpeg: FF, expectedSha256: good });
    expect(r).toEqual({ check: { ok: true }, disabled: [] });
    const none = await bootBinaries({}, 'ia32');
    expect(none.disabled).toEqual([{ id: 'music', why: 'no pinned sha256 for ia32' }, { id: 'voice', why: 'no pinned sha256 for ia32' }]);
  });
});
