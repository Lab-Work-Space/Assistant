import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FF, YT, allGone, readPids, reap, rmDir, sockDir, until, ALLOW } from '../tests/fakes/media.js';
import { PINNED_BINARIES, type Exec } from '../voice/binaries.js';
import { nodeExec } from '../voice/exec.js';
import { SocketMediaBackend } from './client.js';
import { ENV_ALLOW, envViolations, runSidecar } from './main.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const silent = { warn() {} };

let dir: string | null = null;
let pidFiles: string[] = [];
let stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const s of stops) await s().catch(() => undefined);
  stops = [];
  for (const f of pidFiles) reap(readPids(f));
  pidFiles = [];
  rmDir(dir);
  dir = null;
  vi.restoreAllMocks();
});

/** A recording `exit`: the code, never a real process exit. */
const recorder = () => {
  const codes: number[] = [];
  const exit = ((code: number) => {
    codes.push(code);
  }) as (code: number) => never;
  return { codes, exit };
};
/** Captures every stderr line runSidecar writes (the JSON logger). */
const stderr = () => {
  const lines: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  return lines;
};
const goodEnv = (sock: string, over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/tmp', NODE_ENV: 'production', MEDIA_SOCKET: sock, ...over });
const fakes = (over: { exec?: Exec; ytDlpSha?: string } = {}) => ({ ytDlp: YT, ffmpeg: FF, exec: over.exec ?? nodeExec, expectedSha256: { ytDlp: over.ytDlpSha ?? sha(YT), ffmpeg: sha(FF) } });
const sockPath = () => {
  dir ??= sockDir();
  return join(dir, 'media.sock');
};
const run = async (o: Parameters<typeof runSidecar>[0]) => {
  const r = await runSidecar(o);
  stops.push(() => r.stop('test-end'));
  return r;
};

describe('media sidecar main', () => {
  it('ENV_ALLOW is the spec 4.4 list, exact and case-sensitive', () => {
    expect([...ENV_ALLOW]).toEqual(['PATH', 'HOME', 'HOSTNAME', 'TERM', 'LANG', 'TMPDIR', 'NODE_ENV', 'NODE_VERSION', 'YARN_VERSION', 'MEDIA_SOCKET', 'YTDLP_COOKIES_FILE']);
    expect(envViolations({ PATH: '/bin', HOME: '/x', HOSTNAME: 'h', TERM: 'xterm', LANG: 'C', TMPDIR: '/tmp', NODE_ENV: 'production', NODE_VERSION: '22', YARN_VERSION: '1', MEDIA_SOCKET: '/s', YTDLP_COOKIES_FILE: '/c' })).toEqual([]);
    expect(envViolations({ PATH: '/bin', PATHX: '1', XPATH: '1', Path: '1', NODE_OPTIONS: '--require x' })).toEqual(['PATHX', 'XPATH', 'Path', 'NODE_OPTIONS']);
  });

  it('exits 78 on any env key outside the allowlist (ZZ_MARKER, BOT_TOKEN_X, lowercase path)', async () => {
    for (const extra of [{ ZZ_MARKER: '1' }, { BOT_TOKEN_X: 'x' }, { path: '/usr/bin' }, { FAKE_YTDLP_HANG: '1' }, { DATABASE_URL: 'postgres://x' }]) {
      stderr();
      const r = recorder();
      const sock = sockPath();
      await runSidecar({ env: goodEnv(sock, extra), exit: r.exit, binaries: fakes() });
      expect(r.codes, Object.keys(extra)[0]).toEqual([78]);
      expect(existsSync(sock)).toBe(false); // refused before the server binds (and before any spawn)
      vi.restoreAllMocks();
    }
  });

  it('envViolations returns names only; the log line never contains the planted value', async () => {
    const planted = 'planted-value-9f3e1c';
    expect(envViolations({ PATH: '/bin', ZZ_MARKER: planted, BOT_TOKEN_X: planted })).toEqual(['ZZ_MARKER', 'BOT_TOKEN_X']);
    // a hostile key name cannot inject a log line either
    expect(envViolations({ 'A\nB': planted })).toEqual(['A?B']);
    const lines = stderr();
    const r = recorder();
    await runSidecar({ env: goodEnv(sockPath(), { ZZ_MARKER: planted, BOT_TOKEN_X: planted }), exit: r.exit, binaries: fakes() });
    expect(r.codes).toEqual([78]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.endsWith('\n')).toBe(true);
    const o = JSON.parse(lines[0]!) as { level: string; msg: string; keys: string[] };
    expect(o).toMatchObject({ level: 'error', keys: ['ZZ_MARKER', 'BOT_TOKEN_X'] });
    expect(typeof o.msg).toBe('string');
    expect(lines.join('')).not.toContain(planted);
  });

  it('exits 78 when MEDIA_SOCKET is relative or unset', async () => {
    for (const env of [{ PATH: '/bin' }, goodEnv('media.sock'), goodEnv('./run/media.sock'), goodEnv(''), goodEnv('/run/a\0b')]) {
      stderr();
      const r = recorder();
      await runSidecar({ env, exit: r.exit, binaries: fakes() });
      expect(r.codes, JSON.stringify(env.MEDIA_SOCKET)).toEqual([78]);
      vi.restoreAllMocks();
    }
    stderr();
    const r = recorder();
    await runSidecar({ env: goodEnv(sockPath(), { YTDLP_COOKIES_FILE: 'cookies.txt' }), exit: r.exit, binaries: fakes() });
    expect(r.codes).toEqual([78]);
  });

  it('boot check runs once; a mismatched hash is reported in health and never executed', async () => {
    stderr();
    const ran: string[] = [];
    const exec: Exec = async (f, a) => {
      ran.push(f);
      return nodeExec(f, a);
    };
    const r = recorder();
    const sock = sockPath();
    await run({ env: goodEnv(sock), exit: r.exit, binaries: fakes({ exec, ytDlpSha: '0'.repeat(64) }) });
    expect(r.codes).toEqual([]);
    const b = new SocketMediaBackend({ socketPath: sock, log: silent });
    expect(await b.health()).toEqual({ check: { ok: false, missing: [], mismatched: ['yt-dlp'] } });
    expect(await b.health()).toEqual({ check: { ok: false, missing: [], mismatched: ['yt-dlp'] } });
    expect(ran).toEqual([FF]); // yt-dlp's hash failed, so it never ran; ffmpeg ran its version check once, at boot only
  });

  it('main wiring is pinned: default paths are PINNED_BINARIES, versions from PINNED_BINARIES, no extraEnv, entry calls runSidecar() bare', async () => {
    const src = readFileSync(join(HERE, 'main.ts'), 'utf8');
    expect(src).not.toMatch(/extraEnv/);
    expect(src).not.toMatch(/FAKE_/);
    expect(src).toMatch(/\bversions: \{ ytDlp: PINNED_BINARIES\.ytDlp\.version, ffmpeg: PINNED_BINARIES\.ffmpeg\.version \}/);
    const entry = /if \(isEntry\(\)\) (.+);/.exec(src)?.[1];
    expect(entry).toBe('void runSidecar()');
    // no override: the pinned paths, which do not exist on a dev machine, so health says missing and a track fails to spawn
    stderr();
    const r = recorder();
    const sock = sockPath();
    await run({ env: goodEnv(sock), exit: r.exit, arch: 'x64' });
    expect(r.codes).toEqual([]);
    const b = new SocketMediaBackend({ socketPath: sock, log: silent });
    const h = await b.health();
    expect(h.check.ok).toBe(false);
    // M-2: the boot check failed, so the sidecar refuses the track (503 unavailable) without spawning anything
    const t = b.startTrack('some song', { allowlist: ALLOW, capBytes: 1000, capSeconds: 10 });
    t.pcm.resume();
    expect((await t.done).ytDlp.reason).toBe('unavailable');
  });

  it('SIGTERM kills all groups, unlinks socket, exits within 5 s', async () => {
    dir ??= sockDir();
    // the fakes' FAKE_* switches can only come from a wrapper here: runSidecar has no extraEnv (S8)
    const ytPids = join(dir, 'yt.pids');
    const ffPids = join(dir, 'ff.pids');
    pidFiles.push(ytPids, ffPids);
    const ytW = join(dir, 'yt-dlp');
    const ffW = join(dir, 'ffmpeg');
    writeFileSync(ytW, `#!/bin/sh\nFAKE_YTDLP_HANG='${ytPids}' exec '${YT}' "$@"\n`);
    writeFileSync(ffW, `#!/bin/sh\nFAKE_FFMPEG_PIDS='${ffPids}' exec '${FF}' "$@"\n`);
    chmodSync(ytW, 0o755);
    chmodSync(ffW, 0o755);
    stderr();
    const r = recorder();
    const sock = join(dir, 'media.sock');
    const before = process.listeners('SIGTERM');
    const sc = await run({ env: goodEnv(sock), exit: r.exit, binaries: { ytDlp: ytW, ffmpeg: ffW, exec: nodeExec, expectedSha256: { ytDlp: sha(ytW), ffmpeg: sha(ffW) } } });
    const onTerm = process.listeners('SIGTERM').filter((l) => !before.includes(l));
    expect(onTerm).toHaveLength(1);
    expect(process.listeners('SIGINT').length).toBeGreaterThan(0);
    const b = new SocketMediaBackend({ socketPath: sock, log: silent });
    expect(await b.health()).toEqual({ check: { ok: true } });
    const t = b.startTrack('some song', { allowlist: ALLOW, capBytes: 1_000_000, capSeconds: 60 });
    t.pcm.resume();
    expect(await until(() => readPids(ytPids).length === 2 && readPids(ffPids).length === 2)).toBe(true);
    const pids = [...readPids(ytPids), ...readPids(ffPids)];
    const t0 = Date.now();
    (onTerm[0] as () => void)();
    // while stopping, a second SIGTERM is swallowed by a no-op handler (node's default would exit 143 before the unlink)
    const during = process.listeners('SIGTERM').filter((l) => !before.includes(l));
    expect(during).toHaveLength(1);
    expect(during[0]).not.toBe(onTerm[0]);
    (during[0] as () => void)();
    expect(await until(() => r.codes.length > 0, 5000)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.codes).toEqual([0]);
    expect(await allGone(pids, 2000)).toBe(true);
    expect(existsSync(sock)).toBe(false);
    await t.done;
    expect(process.listeners('SIGTERM').filter((l) => !before.includes(l))).toEqual([]); // stop() removes its handlers
    await sc.stop('again'); // idempotent: no second exit
    expect(r.codes).toEqual([0]);
  });

  it('the 5 s hard timer exits 0 when it fires before close() settles (fired by hand), and never a second time', async () => {
    stderr();
    const r = recorder();
    const sc = await run({ env: goodEnv(sockPath()), exit: r.exit, binaries: fakes() });
    const timers: { fn: () => void; ms: number }[] = [];
    const real = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      if (ms === 5000) {
        timers.push({ fn, ms });
        return { unref() {}, ref() {}, hasRef: () => false, refresh() {}, [Symbol.toPrimitive]: () => 0 } as unknown as NodeJS.Timeout;
      }
      return real(fn, ms);
    }) as typeof setTimeout);
    const stopping = sc.stop('SIGTERM');
    expect(timers).toHaveLength(1);
    timers[0]!.fn(); // the hard deadline fires before close() settles
    expect(r.codes).toEqual([0]);
    await stopping;
    expect(r.codes).toEqual([0]); // never a second exit
  });

  it('maps a start refusal to 78 and a raw listen failure to 1', async () => {
    stderr();
    const d = (dir ??= sockDir());
    chmodSync(d, 0o700); // S1: the socket directory must be 0755
    const r = recorder();
    await runSidecar({ env: goodEnv(join(d, 'media.sock')), exit: r.exit, binaries: fakes() });
    expect(r.codes).toEqual([78]);
    chmodSync(d, 0o755);
    const long = join(d, `${'x'.repeat(120)}.sock`); // over sun_path: listen itself fails with a plain Error
    const r2 = recorder();
    await runSidecar({ env: goodEnv(long), exit: r2.exit, binaries: fakes() });
    expect(r2.codes).toEqual([1]);
  });
});
