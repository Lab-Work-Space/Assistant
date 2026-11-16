import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, constants, lstat, readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { nodeExec } from './exec.js';

/**
 * P22: the media binaries baked into the image, pinned by version and sha256 per architecture. deploy/Dockerfile carries the same
 * yt-dlp values as build ARGs (a unit test keeps them equal); the README "Media binaries" section is the bump procedure. Never updated
 * at runtime: yt-dlp is never run with -U.
 *
 * yt-dlp is the official onedir build (`yt-dlp_musllinux[.zip]`, verified at build time against the release's SHA2-256SUMS, whose
 * signature is checked with the yt-dlp signing key AC0CBBE6848D6A873464AF4E57CF65933B5A7581). The one-file build cannot be used:
 * it self-extracts ~96 MB of shared objects into TMPDIR, which the container's 16 MB noexec /tmp refuses. Its pin is the tree hash
 * of /opt/yt-dlp (see hashPath). ffmpeg is built in the image from the GPG-verified ffmpeg.org 9.0.2 source tarball (fingerprint
 * FCF986EA15E6E293A5644F10B4322F04D67658D8, key committed as voice/ffmpeg-release-key.asc) as one minimal, fully static binary
 * (--disable-everything, pipe protocol and the few demuxers/decoders Praw needs). Source integrity is the GPG signature plus the
 * pinned tarball sha256; the compiled binary is not bit-reproducible across Alpine toolchain updates, so the build writes its
 * sha256 to a root-owned read-only manifest (PINNED_BINARIES.ffmpeg.manifest) and the boot check compares against that, which
 * guards against tampering after the build.
 */
export const PINNED_BINARIES = {
  ytDlp: {
    version: '2026.10.26',
    path: '/opt/yt-dlp/yt-dlp',
    tree: '/opt/yt-dlp',
    sha256: {
      x64: '726fe7666e5d027161232d70bd1dab3dbde13554093c290c0113036adc7fb3e4',
      arm64: '1c033be9483fcfb1352fc67d37aaeab48ee6ee0382f9db58f654203d4247bc12',
    },
  },
  ffmpeg: {
    version: '9.0.2',
    path: '/opt/ffmpeg/ffmpeg',
    /** Written by the ffmpeg build stage (`sha256sum`, root-owned, 0444); the boot check reads the expected hash from here. */
    manifest: '/opt/ffmpeg/ffmpeg.sha256',
  },
} as const;

/** ffmpeg's expected hash is either given directly (tests) or read from the image's root-owned manifest (production). */
export type FfmpegManifest = { manifest: string; ownerUid?: number };
export type ExpectedSha256 = { ytDlp: string; ffmpeg: string | FfmpegManifest };

/** The pinned hashes for this CPU, or null on an architecture the image is not built for. */
export function pinnedFor(arch: string): ExpectedSha256 | null {
  if (arch !== 'x64' && arch !== 'arm64') return null;
  return { ytDlp: PINNED_BINARIES.ytDlp.sha256[arch], ffmpeg: { manifest: PINNED_BINARIES.ffmpeg.manifest } };
}

/** Runs a binary with childEnv() (voice/exec.ts in production); injected so tests never run a real binary. */
export type Exec = (file: string, args: string[]) => Promise<{ code: number | null; stdout: string }>;

export type BinaryCheck = { ok: true } | { ok: false; missing: string[]; mismatched: string[] };

export interface CheckBinariesOptions {
  ytDlp: string;
  ffmpeg: string;
  exec: Exec;
  expectedSha256: ExpectedSha256;
  /** Hash this directory (the yt-dlp onedir) instead of the yt-dlp executable itself. */
  ytDlpTree?: string;
}

async function fileSha256(p: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(p)) h.update(chunk as Buffer);
  return h.digest('hex');
}

async function filesUnder(dir: string, out: string[] = []): Promise<string[]> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await filesUnder(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/**
 * sha256 of a file, or of a directory tree: the sha256 of `<sha256>  ./<relpath>\n` for every regular file, sorted by path in
 * byte order, which is what `find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum` prints in the Dockerfile. Null when absent.
 */
export async function hashPath(p: string): Promise<string | null> {
  const s = await stat(p).catch(() => null);
  if (!s) return null;
  if (!s.isDirectory()) return fileSha256(p);
  const rels = (await filesUnder(p)).map((f) => `./${relative(p, f).split(sep).join('/')}`);
  rels.sort((a, b) => (Buffer.compare(Buffer.from(a), Buffer.from(b))));
  const lines: string[] = [];
  for (const r of rels) lines.push(`${await fileSha256(join(p, r))}  ${r}\n`);
  return createHash('sha256').update(lines.join('')).digest('hex');
}

/**
 * The expected ffmpeg sha256 from the build's manifest, or null when it cannot be trusted: absent, not a regular file (a symlink
 * is refused), not owned by root (`ownerUid`, tests only), group/world writable, or not `<64 hex>[  path]`.
 */
export async function readFfmpegManifest(m: FfmpegManifest): Promise<string | null> {
  try {
    const st = await lstat(m.manifest);
    if (!st.isFile() || st.uid !== (m.ownerUid ?? 0) || (st.mode & 0o022) !== 0 || st.size > 512) return null;
    const hit = /^([0-9a-f]{64})(?:  \S+)?\n?$/.exec(await readFile(m.manifest, 'utf8'));
    return hit ? hit[1]! : null;
  } catch {
    return null;
  }
}

const VERSION_ARGS = { 'yt-dlp': ['--ignore-config', '--version'], ffmpeg: ['-hide_banner', '-version'] } as const;

/**
 * Boot check (P22, R13): each binary must exist, be executable, match its pinned sha256 and then answer its version command.
 * A hash mismatch is never executed. Never throws: any failure is reported so only the dependent groups are disabled.
 */
export async function checkBinaries(o: CheckBinariesOptions): Promise<BinaryCheck> {
  const missing: string[] = [];
  const mismatched: string[] = [];
  const bins = [
    { name: 'yt-dlp' as const, file: o.ytDlp, hashOf: o.ytDlpTree ?? o.ytDlp, want: o.expectedSha256.ytDlp },
    { name: 'ffmpeg' as const, file: o.ffmpeg, hashOf: o.ffmpeg, want: o.expectedSha256.ffmpeg },
  ];
  for (const b of bins) {
    try {
      const want = typeof b.want === 'string' ? b.want : ((await readFfmpegManifest(b.want)) ?? '');
      if (!(await access(b.file, constants.X_OK).then(() => true, () => false))) {
        missing.push(b.name);
        continue;
      }
      const got = await hashPath(b.hashOf);
      if (got === null) missing.push(b.name);
      else if (want === '' || got !== want.toLowerCase()) mismatched.push(b.name);
      else if ((await o.exec(b.file, [...VERSION_ARGS[b.name]])).code !== 0) missing.push(b.name);
    } catch {
      missing.push(b.name);
    }
  }
  return missing.length || mismatched.length ? { ok: false, missing, mismatched } : { ok: true };
}

/**
 * R13 groups a failed check turns off, for the one startup "Tool groups disabled" alert. Music needs yt-dlp and ffmpeg; voice
 * chat needs ffmpeg only (TTS transcoding), so a yt-dlp problem leaves voice chat on.
 */
export function binaryGroupsDisabled(r: BinaryCheck): { id: string; why: string }[] {
  if (r.ok) return [];
  const why = [r.missing.length ? `missing or not runnable: ${r.missing.join(', ')}` : '', r.mismatched.length ? `sha256 mismatch: ${r.mismatched.join(', ')}` : '']
    .filter(Boolean).join('; ');
  const ffmpegBad = r.missing.includes('ffmpeg') || r.mismatched.includes('ffmpeg');
  return [{ id: 'music', why }, ...(ffmpegBad ? [{ id: 'voice', why }] : [])];
}

/**
 * Boot check of the pinned media binaries (P22) with the production defaults; `over` replaces any of them (tests: tests/fakes/bin).
 * Returns the R13 groups to disable; never throws, so the boot continues. Lives here (not voice/index.ts) so the media sidecar can
 * use it without loading the voice stack (R2).
 */
export async function bootBinaries(over: Partial<CheckBinariesOptions> = {}, arch: string = process.arch): Promise<{ check: BinaryCheck; disabled: { id: string; why: string }[] }> {
  const expected = over.expectedSha256 ?? pinnedFor(arch);
  if (!expected) {
    const check: BinaryCheck = { ok: false, missing: [], mismatched: ['yt-dlp', 'ffmpeg'] };
    return { check, disabled: binaryGroupsDisabled(check).map((d) => ({ ...d, why: `no pinned sha256 for ${arch.replace(/[^a-z0-9]/gi, '')}` })) };
  }
  const defaults = over.ytDlp ? {} : { ytDlpTree: PINNED_BINARIES.ytDlp.tree };
  const check = await checkBinaries({ ytDlp: PINNED_BINARIES.ytDlp.path, ffmpeg: PINNED_BINARIES.ffmpeg.path, exec: nodeExec, ...defaults, ...over, expectedSha256: expected });
  return { check, disabled: binaryGroupsDisabled(check) };
}
