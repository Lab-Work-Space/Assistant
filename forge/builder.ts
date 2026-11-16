import { createHash, randomBytes } from 'node:crypto';
import { constants as FS, type Stats } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson } from '../governance/canonical.js';
import type { ForgeRepo } from '../db/repos/forge.js';
import { removeVerified, type DockerCli, type ExecResult } from '../workspaces/runner.js';
import { BUILD_DEADLINE_MS, EXEC_MS, IMAGE_DELTA_MAX } from './caps.js';
import type { BuildCode } from './texts.js';
import type { ReleaseStageBy, StageReleaseFn } from './types.js';
import { parseJson, validatePlugin } from './validate.js';
import type { ClaimedBuild } from '../db/repos/forge.js';

/**
 * R7 PLUGIN-FORGE (spec 3.5, PF-C2 to PF-C6): the code-owned image builder. The docker verbs are inspect, create (never started), cp, commit, rm and image rm: NOTHING here runs, starts, execs, builds,
 * pulls, pushes or tags (argv golden test and grep test). The argv is built only in this file, from constants, the base image id (checked in and read once at boot), an integer build id and 64-hex
 * hashes; no model text, plugin text or file name reaches an argv. The docker port is injected (`exec` only), so unit tests use a fake and the real CLI is `workspaces/runner.ts realDockerCli`.
 * It never imports `mcp/` (the stage goes through the injected `StageReleaseFn` closure) and never logs content, names, stderr or a parse error: only error names.
 */
export type BuildResult =
  | { kind: 'staged'; imageId: string; baseImageId: string; imageBytes: number; slug: string; config12: string; toolCount: number }
  | { kind: 'failed'; code: BuildCode }
  /** Halt, the forge switch going off, or the forge no longer live: nothing was staged; the service requeues and gives the attempt back. */
  | { kind: 'requeue' }
  /** An unexpected exception: the service requeues WITHOUT a refund (3 attempts then `failed:interrupted`). */
  | { kind: 'error' };

/** A process-local latch (not mcp's StuckLatch: forge/ may not import mcp/sandbox.ts). Once set, no build starts until the process restarts. */
export class ForgeLatch {
  private on = false;
  get stuck(): boolean { return this.on; }
  /** True the first time only (the caller posts the one incident). */
  set(): boolean { const first = !this.on; this.on = true; return first; }
}

export interface BuilderDeps {
  docker: Pick<DockerCli, 'exec'>;
  repo: Pick<ForgeRepo, 'recordImage' | 'imageRemoved' | 'serverOfRelease' | 'stillLive'>;
  stage: StageReleaseFn;
  /** The checked-in base image id (docker/forge/images.json, read once at boot). */
  baseImageId: string;
  /** The staging parent, `join(tmpdir(), 'assistant-forge')` in production. Injectable so tests never touch the real one (global rule 24). */
  stageRoot: string;
  isHalted(): boolean;
  /** `forge.enabled` (PF-C17): polled between steps; a read error counts as off. */
  forgeEnabled(): boolean;
  latch: ForgeLatch;
  onStuck?: () => void;
  now?: () => number;
  newSuffix?: () => string;
  log: { error(o: unknown, m?: string): void };
}

export const BASE_RE = /^sha256:[0-9a-f]{64}$/;
const NAME_RE = /^forge-b[0-9]{1,12}-[0-9a-f]{8}$/;
const DIR_RE = /^b-[A-Za-z0-9]{6}$/;
const PATH_RE = /^\/[A-Za-z0-9._/-]{1,200}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const errName = (e: unknown): string => (e instanceof Error ? e.name : 'unknown');

// ---- argv (the only place docker argv is built; golden-tested) ---------------------------------------------------------------------------
export const imageInspectArgv = (id: string): string[] => ['image', 'inspect', '--format', '{{json .}}', id];
export const createArgv = (name: string, base: string): string[] => ['create', '--pull=never', '--network', 'none', '--log-driver=none', '--name', name, base];
export const cpArgv = (dir: string, name: string): string[] => ['cp', `${dir}/.`, `${name}:/srv/plugin`];
export const commitArgv = (name: string, buildId: number, sha256: string): string[] => [
  'commit', '--change', 'USER 65534:65534', '--change', 'WORKDIR /srv/plugin', '--change', 'ENTRYPOINT ["node","/srv/plugin/server.mjs"]', '--change', 'CMD []', '--change', 'ENV NODE_ENV=production',
  '--change', 'LABEL assistant.forge=1', '--change', `LABEL assistant.forge.build=${buildId}`, '--change', `LABEL assistant.forge.sha256=${sha256}`, name,
];
/** G2-FG-01: `--no-prune` (never `-f`): `docker image rm <child>` otherwise also deletes untagged parents, i.e. the base whenever its tag is gone (probed, Docker 29 containerd store). */
export const imageRmArgv = (id: string): string[] => ['image', 'rm', '--no-prune', id];
export const psSweepArgv = (): string[] => ['ps', '-a', '--filter', 'name=forge-b', '--format', '{{.Names}}'];
export const forgeImagesArgv = (): string[] => ['image', 'ls', '-a', '--no-trunc', '--filter', 'label=assistant.forge=1', '--format', '{{.ID}}'];

// ---- docker inspect parsing and the exact config diff (PF-C4) ----------------------------------------------------------------------------
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isEmpty = (v: unknown): boolean => v === null || v === undefined || (Array.isArray(v) && v.length === 0) || (isObj(v) && Object.keys(v).length === 0);
const norm = (v: unknown): unknown => (isEmpty(v) ? null : v);
const same = (a: unknown, b: unknown): boolean => {
  try { return canonicalJson(norm(a)) === canonicalJson(norm(b)); } catch { return false; }
};
/**
 * PF-C4: the Config keys `docker commit` rewrites from the container (named, minimal). BE3 probe, Docker Desktop 29 with the containerd image store: `commit` writes neither Hostname nor Image (they
 * stay in the list for a daemon that does) and DROPS `ArgsEscaped` (the base keeps it from a Dockerfile CMD; it only says how Cmd and Entrypoint were escaped on Windows). Anything else that differs from the base, besides the fields the build sets on purpose, is `verify_failed`.
 */
export const CONFIG_IGNORE: readonly string[] = ['Hostname', 'Image', 'ArgsEscaped'];
/**
 * BE3 probe (Docker Desktop 29, containerd image store): the daemon stamps `desktop.docker.io/ports.scheme=v2` on every container it creates and `commit` copies container labels into the image, so
 * the committed image carries it although the build sets no such label. Exactly this key and value is tolerated in the label comparison; any other extra label or value is `verify_failed`.
 * (On the same daemon `commit` does NOT write Hostname or Image into the image config: CONFIG_IGNORE is kept for a daemon that does, it is not exercised there.)
 */
export const DAEMON_LABELS: Readonly<Record<string, string>> = { 'desktop.docker.io/ports.scheme': 'v2' };
export const SET_ON_PURPOSE: readonly string[] = ['User', 'WorkingDir', 'Entrypoint', 'Cmd', 'Env', 'Labels'];

export interface Inspected { id: string; config: Record<string, unknown>; layers: string[]; size: number; os: string }

export function parseInspect(stdout: string): Inspected | null {
  try {
    if (stdout.length > 512 * 1024) return null;
    const v = parseJson(stdout.trim());
    if (!isObj(v) || typeof v.Id !== 'string' || !isObj(v.Config) || typeof v.Size !== 'number' || !Number.isFinite(v.Size) || typeof v.Os !== 'string') return null;
    const rootfs = v.RootFS;
    if (!isObj(rootfs) || !Array.isArray(rootfs.Layers) || !rootfs.Layers.every((l) => typeof l === 'string' && /^sha256:[0-9a-f]{64}$/.test(l))) return null;
    return { id: v.Id, config: v.Config, layers: rootfs.Layers as string[], size: v.Size, os: v.Os };
  } catch {
    return null;
  }
}

/** The base must hold nothing a plugin image could inherit unnoticed: no volumes, labels, ONBUILD or healthcheck; linux (PF-C4, spec 3.5 step 1). */
export function baseAcceptable(b: Inspected, wantId: string): boolean {
  return b.id === wantId && b.os === 'linux' && isEmpty(b.config.Volumes) && isEmpty(b.config.Labels) && isEmpty(b.config.OnBuild) && isEmpty(b.config.Healthcheck) && b.layers.length >= 1;
}

export async function inspectBase(docker: Pick<DockerCli, 'exec'>, baseId: string): Promise<Inspected | null> {
  if (!BASE_RE.test(baseId)) return null;
  const r = await safeExec(docker, imageInspectArgv(baseId), EXEC_MS.inspect);
  if (r.code !== 0 || r.timedOut) return null;
  const b = parseInspect(r.stdout);
  return b && baseAcceptable(b, baseId) ? b : null;
}

export type VerifyFail = 'verify_failed' | 'image_too_big';
/** PF-C4 / FG-AC05: the new image against the base, field by field. */
export function verifyImage(n: Inspected, base: Inspected, a: { id: string; sha256: string; buildId: number }): VerifyFail | null {
  if (n.id !== a.id || n.os !== 'linux') return 'verify_failed';
  if (n.layers.length !== base.layers.length + 1 || base.layers.some((l, i) => n.layers[i] !== l)) return 'verify_failed';
  const c = n.config;
  const b = base.config;
  if (c.User !== '65534:65534' || c.WorkingDir !== '/srv/plugin') return 'verify_failed';
  if (!Array.isArray(c.Entrypoint) || c.Entrypoint.length !== 2 || c.Entrypoint[0] !== 'node' || c.Entrypoint[1] !== '/srv/plugin/server.mjs') return 'verify_failed';
  if (!(c.Cmd === null || c.Cmd === undefined || (Array.isArray(c.Cmd) && c.Cmd.length === 0))) return 'verify_failed';
  if (!Array.isArray(c.Env) || !c.Env.every((e) => typeof e === 'string')) return 'verify_failed';
  const baseEnv = (Array.isArray(b.Env) ? (b.Env as string[]) : []).filter((e) => !e.startsWith('NODE_ENV='));
  const want = [...baseEnv, 'NODE_ENV=production'].sort();
  if (canonicalJson([...(c.Env as string[])].sort()) !== canonicalJson(want)) return 'verify_failed';
  const labels = c.Labels;
  const wantLabels = { 'assistant.forge': '1', 'assistant.forge.build': String(a.buildId), 'assistant.forge.sha256': a.sha256 };
  if (!isObj(labels)) return 'verify_failed';
  const rest: Record<string, unknown> = { ...labels };
  for (const [k, v] of Object.entries(DAEMON_LABELS)) if (rest[k] === v) delete rest[k];
  if (canonicalJson(rest) !== canonicalJson(wantLabels)) return 'verify_failed';
  for (const k of new Set([...Object.keys(b), ...Object.keys(c)])) {
    if (SET_ON_PURPOSE.includes(k) || CONFIG_IGNORE.includes(k)) continue;
    if (!same(b[k], c[k])) return 'verify_failed'; // Healthcheck, Shell, StopSignal, ExposedPorts, Volumes, OnBuild, ... anything else
  }
  // G2-FG-10: ArgsEscaped is ignored in the key diff, but only in the direction commit really goes: absent or false, or the base's own value. A new image that GAINS it is refused.
  if (!(c.ArgsEscaped === undefined || c.ArgsEscaped === null || c.ArgsEscaped === false || c.ArgsEscaped === b.ArgsEscaped)) return 'verify_failed';
  if (n.size - base.size > IMAGE_DELTA_MAX) return 'image_too_big';
  return null;
}

// ---- exec helpers ------------------------------------------------------------------------------------------------------------------------
async function safeExec(docker: Pick<DockerCli, 'exec'>, argv: readonly string[], ms: number): Promise<ExecResult> {
  try {
    return await docker.exec(argv, ms);
  } catch {
    return { code: 1, stdout: '', timedOut: false, missing: false };
  }
}
const okOut = (r: ExecResult): boolean => r.code === 0 && !r.timedOut;

/**
 * `docker image rm --no-prune <id>` (never `-f`), then a LISTING must prove it (G2-FG-05): `image ls` of the forge-labelled images must exit 0 within its time and not hold the id. A failing
 * inspect proves nothing (a daemon outage or a timeout fails it too), so it is not used. Any outage means "not removed" (the caller sets the latch). Never throws.
 */
export async function removeImageVerified(docker: Pick<DockerCli, 'exec'>, id: string): Promise<boolean> {
  if (!BASE_RE.test(id)) return false;
  await safeExec(docker, imageRmArgv(id), EXEC_MS.rm);
  const r = await safeExec(docker, forgeImagesArgv(), EXEC_MS.inspect);
  if (!okOut(r) || r.missing) return false;
  return !r.stdout.split('\n').some((l) => l.trim() === id);
}

/** PF-C6: containers whose NAME matches `^forge-b[0-9]{1,12}-[0-9a-f]{8}$` in full (docker's name filter is a substring match). Returns false when one could not be removed. */
export async function sweepForgeContainers(docker: Pick<DockerCli, 'exec'>): Promise<boolean> {
  const r = await safeExec(docker, psSweepArgv(), EXEC_MS.inspect);
  if (!okOut(r)) return true; // nothing could be listed: the next boot tries again
  let clean = true;
  for (const line of r.stdout.split('\n')) {
    const name = line.trim();
    if (!NAME_RE.test(name)) continue;
    if (!(await removeVerified(docker, name, { volumes: true }))) clean = false;
  }
  return clean;
}

// ---- the stage directory (PF-C3) ---------------------------------------------------------------------------------------------------------
export async function verifiedRoot(root: string): Promise<boolean> {
  try {
    await mkdir(root, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') throw e; });
    const st = await lstat(root);
    const euid = process.geteuid?.() ?? -1;
    const egid = process.getegid?.() ?? -1;
    // G2-FG-07 (PF-C15 relaxed): the files of the new layer keep the staging uid and gid, which is safe only while neither is the plugin runtime user (65534). Unknown ids fail closed.
    if (!Number.isInteger(euid) || !Number.isInteger(egid) || euid < 0 || egid < 0 || euid === 65534 || egid === 65534) return false;
    return st.isDirectory() && !st.isSymbolicLink() && st.uid === euid && (st.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

/**
 * PF-C3 boot clean-up: only the lstat'ed direct children of the VERIFIED parent whose names are exactly `b-` plus six letters or digits. A directory goes with `rm` (which never follows a link),
 * anything else with `unlink`. No glob, no recursion into a path that was not just listed. Returns false when the parent is not a safe directory (nothing is touched then).
 */
export async function cleanStageRoot(root: string): Promise<boolean> {
  try {
    const st = await lstat(root).catch(() => null);
    if (st === null) return true; // nothing there yet
    if (!(await verifiedRoot(root))) return false;
    for (const name of await readdir(root)) {
      if (!DIR_RE.test(name)) continue;
      const p = join(root, name);
      const s = await lstat(p).catch(() => null);
      if (s === null) continue;
      if (s.isDirectory() && !s.isSymbolicLink()) await rm(p, { recursive: true, force: true });
      else await unlink(p).catch(() => undefined);
    }
    return true;
  } catch {
    return false;
  }
}

async function removeStageDir(root: string, dir: string): Promise<void> {
  try {
    const name = dir.slice(root.length + 1);
    if (!dir.startsWith(`${root}/`) || !DIR_RE.test(name)) return; // only a directory this builder made
    const s = await lstat(dir).catch(() => null);
    if (s !== null && s.isDirectory() && !s.isSymbolicLink()) await rm(dir, { recursive: true, force: true });
  } catch { /* the boot clean-up is the backstop */ }
}

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** Writes the shipped files (dirs 0755, files O_CREAT|O_EXCL|O_NOFOLLOW then fchmod 0644). Returns false on any failure. */
export async function writeFiles(dir: string, files: readonly { path: string; data: Buffer }[]): Promise<boolean> {
  const madeDirs = new Set<string>();
  for (const f of files) {
    const parts = f.path.split('/');
    let cur = dir;
    for (const seg of parts.slice(0, -1)) {
      cur = join(cur, seg);
      if (!madeDirs.has(cur)) {
        await mkdir(cur, { mode: 0o755 });
        const h = await open(cur, FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW);
        try { await h.chmod(0o755); } finally { await h.close(); }
        madeDirs.add(cur);
      }
    }
    const h = await open(join(cur, parts.at(-1)!), FS.O_CREAT | FS.O_EXCL | FS.O_WRONLY | FS.O_NOFOLLOW, 0o644);
    try { await h.writeFile(f.data); await h.chmod(0o644); } finally { await h.close(); }
  }
  return true;
}

/**
 * Re-walks the stage dir with lstat (regular files and dirs only; the file count and byte total equal the manifest: else `stage_dir`) and re-reads every file through a no-follow open, comparing
 * its size and sha256 with its manifest entry (any difference: `zip_invalid`, PF-C2).
 */
export async function checkStage(dir: string, manifest: readonly { path: string; size: number; sha256: string }[]): Promise<'ok' | 'stage_dir' | 'zip_invalid'> {
  let count = 0;
  let bytes = 0;
  const walk = async (d: string): Promise<boolean> => {
    for (const name of await readdir(d)) {
      const p = join(d, name);
      const s: Stats = await lstat(p);
      if (s.isSymbolicLink()) return false;
      if (s.isDirectory()) { if (!(await walk(p))) return false; } else if (s.isFile()) { count++; bytes += s.size; } else return false;
    }
    return true;
  };
  if (!(await walk(dir))) return 'stage_dir';
  if (count !== manifest.length || bytes !== manifest.reduce((a, m) => a + m.size, 0)) return 'stage_dir';
  for (const m of manifest) {
    let h;
    try { h = await open(join(dir, ...m.path.split('/')), FS.O_RDONLY | FS.O_NOFOLLOW); } catch { return 'zip_invalid'; }
    try {
      const st = await h.stat();
      if (!st.isFile() || st.size !== m.size) return 'zip_invalid';
      const data = await h.readFile();
      if (data.length !== m.size || sha256(data) !== m.sha256) return 'zip_invalid';
    } finally { await h.close(); }
  }
  return 'ok';
}

const STAGE_CODE: Record<string, BuildCode> = {
  E_PROBE: 'stage_probe', E_SECCOMP: 'stage_seccomp', E_TOOLS_NONE: 'stage_tools', E_TOOLS_MANY: 'stage_tools', E_SCHEMA: 'stage_schema', E_SCREEN: 'stage_screen', E_NAME: 'stage_name', E_COLLISION: 'stage_name',
  E_EXISTS: 'stage_exists', E_MAX_SERVERS: 'stage_max', E_IMAGE: 'stage_image', E_STATE: 'stage_state',
};
export const stageCode = (code: string): BuildCode => STAGE_CODE[code] ?? 'stage_other';

/** Where the builder is while it runs; the finally blocks clean up from it. */
export class Builder {
  constructor(private readonly d: BuilderDeps) {}

  async build(b: ClaimedBuild): Promise<BuildResult> {
    const now = this.d.now ?? Date.now;
    const deadline = now() + BUILD_DEADLINE_MS;
    const made: { id: string | null } = { id: null };
    let result: BuildResult;
    try {
      result = await this.steps(b, deadline, (id) => { made.id = id; });
    } catch (e) {
      this.d.log.error({ errName: errName(e) }, 'forge build failed');
      result = { kind: 'error' };
    }
    // PF-C5: every exit other than `staged` removes the image the build made (no -f, verified) and records it; a failed removal latches `stuck`.
    if (result.kind !== 'staged' && made.id !== null) {
      const gone = await removeImageVerified(this.d.docker, made.id);
      if (gone) {
        try { await this.d.repo.imageRemoved(b.id, made.id.slice(7, 19)); } catch (e) { this.d.log.error({ errName: errName(e) }, 'forge image record failed'); }
      } else {
        this.latch();
        result = { kind: 'failed', code: 'stuck' };
      }
    }
    return result;
  }

  private latch(): void {
    if (this.d.latch.set()) { try { this.d.onStuck?.(); } catch { /* the incident post never fails a build */ } }
  }

  private stop(deadline: number): 'requeue' | 'timeout' | null {
    const now = (this.d.now ?? Date.now)();
    let halted = true;
    try { halted = this.d.isHalted(); } catch { halted = true; }
    let on = false;
    try { on = this.d.forgeEnabled() === true; } catch { on = false; }
    if (halted || !on) return 'requeue';
    if (now >= deadline) return 'timeout';
    return null;
  }

  private ms(step: number, deadline: number): number {
    return Math.max(1, Math.min(step, deadline - (this.d.now ?? Date.now)()));
  }

  private async steps(b: ClaimedBuild, deadline: number, setImage: (id: string) => void): Promise<BuildResult> {
    const d = this.d;
    const fail = (code: BuildCode): BuildResult => ({ kind: 'failed', code });
    const halt = async (): Promise<BuildResult | null> => {
      const s = this.stop(deadline);
      if (s === 'requeue') return { kind: 'requeue' };
      if (s === 'timeout') return fail('timeout');
      if (!(await d.repo.stillLive(b.forgeId))) return { kind: 'requeue' }; // the forge or its project ended: the reconcile cancels the build
      return null;
    };
    if (d.latch.stuck) return fail('stuck');
    if (!BASE_RE.test(d.baseImageId) || !Number.isSafeInteger(b.id) || b.id < 1 || !HEX64.test(b.sha256)) return fail('base_missing');

    // PF-C2: the hash chain, then the validator on the pinned bytes
    if (!Buffer.isBuffer(b.zip) || sha256(b.zip) !== b.sha256 || b.sha256 !== b.releaseSha256 || b.manifestSha256 !== b.releaseManifestSha256) return fail('zip_invalid');
    const v = validatePlugin(b.zip, { forgeIdeaId: b.ideaId });
    if (!v.ok || v.info.manifestSha256 !== b.manifestSha256 || v.info.forge.slug !== b.pluginSlug) return fail('zip_invalid');

    // idempotency: a server row already staged for this release (a crash after the stage) is adopted, no second image is built
    const existing = await d.repo.serverOfRelease(b.releaseId);
    if (existing !== null) {
      if (existing.slug !== b.pluginSlug || b.imageId === null || existing.imageId !== b.imageId) return fail('stage_state');
      return { kind: 'staged', imageId: existing.imageId, baseImageId: d.baseImageId, imageBytes: 0, slug: existing.slug, config12: '', toolCount: 0 };
    }

    let r = await halt();
    if (r) return r;
    const base = await inspectBase(d.docker, d.baseImageId);
    if (base === null) return fail('base_missing');

    r = await halt();
    if (r) return r;
    if (!(await verifiedRoot(d.stageRoot))) return fail('stage_dir');
    let dir: string;
    try { dir = await mkdtemp(join(d.stageRoot, 'b-')); } catch { return fail('stage_dir'); }
    const name = `forge-b${b.id}-${(d.newSuffix ?? (() => randomBytes(4).toString('hex')))()}`;
    let committed: string | null = null;
    try {
      if (!PATH_RE.test(dir) || !DIR_RE.test(dir.slice(d.stageRoot.length + 1))) return fail('stage_dir');
      // BE3 probe: `docker cp <dir>/. NAME:/srv/plugin` stamps the mode of <dir> on /srv/plugin. The stage dir is 0700 (private to this process), so the content goes in a 0755 child: the child is
      // what is copied, and /srv/plugin ends 0755 (a 0700 /srv/plugin, owned by the host uid, is unreadable to uid 65534 and the probe fails).
      const content = join(dir, 'plugin');
      try {
        await mkdir(content, { mode: 0o755 });
        const h = await open(content, FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW);
        try { await h.chmod(0o755); } finally { await h.close(); }
        await writeFiles(content, v.info.files);
      } catch { return fail('stage_dir'); }
      const chk = await checkStage(content, v.info.shipped).catch(() => 'stage_dir' as const);
      if (chk !== 'ok') return fail(chk);

      r = await halt();
      if (r) return r;
      if (!NAME_RE.test(name)) return fail('create_failed');
      try {
        const c = await safeExec(d.docker, createArgv(name, d.baseImageId), this.ms(EXEC_MS.create, deadline));
        if (!okOut(c) || !/^[0-9a-f]{64}$/.test(c.stdout.trim())) return fail('create_failed');
        r = await halt();
        if (r) return r;
        const cp = await safeExec(d.docker, cpArgv(content, name), this.ms(EXEC_MS.cp, deadline));
        if (!okOut(cp)) return fail('copy_failed');
        r = await halt();
        if (r) return r;
        const cm = await safeExec(d.docker, commitArgv(name, b.id, b.sha256), this.ms(EXEC_MS.commit, deadline));
        const out = cm.stdout.trim();
        if (!okOut(cm) || !BASE_RE.test(out)) return fail('commit_failed');
        committed = out;
        // PF-C5: ONE statement records the id right away. If it cannot (the row already holds an image, or the database is down) the image is removed here and now, never left unrecorded.
        let recorded = false;
        try { recorded = await d.repo.recordImage(b.id, out); } catch (e) { if (!(await removeImageVerified(d.docker, out))) this.latch(); throw e; }
        if (!recorded) { if (!(await removeImageVerified(d.docker, out))) this.latch(); return fail(d.latch.stuck ? 'stuck' : 'stage_state'); }
        setImage(out); // from here the image is the build's to remove on any exit but `staged`
      } finally {
        if (!(await removeVerified(d.docker, name, { volumes: true }))) this.latch();
      }
    } finally {
      await removeStageDir(d.stageRoot, dir);
    }
    if (d.latch.stuck) return fail('stuck');
    if (committed === null) return fail('commit_failed');

    // verify
    r = await halt();
    if (r) return r;
    const ins = await safeExec(d.docker, imageInspectArgv(committed), this.ms(EXEC_MS.inspect, deadline));
    const img = okOut(ins) ? parseInspect(ins.stdout) : null;
    if (img === null) return fail('verify_failed');
    const bad = verifyImage(img, base, { id: committed, sha256: b.sha256, buildId: b.id });
    if (bad !== null) return fail(bad);

    // stage
    r = await halt();
    if (r) return r;
    const by: ReleaseStageBy = { kind: 'release', releaseId: b.releaseId, decidedBy: b.decidedBy };
    const st = await d.stage({ slug: b.pluginSlug, image: committed, departments: b.deptId, title: v.info.forge.title, ref: `forge:release-${b.releaseId}` }, by);
    if (!st.ok) return st.code === 'E_HALTED' ? { kind: 'requeue' } : fail(stageCode(st.code));
    return { kind: 'staged', imageId: committed, baseImageId: d.baseImageId, imageBytes: Math.max(0, img.size - base.size), slug: st.slug, config12: st.config12, toolCount: st.toolCount };
  }
}
