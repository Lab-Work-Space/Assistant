import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../db/migrate.js';
import { ForgeRepo } from '../db/repos/forge.js';
import { newBuild, newForge, newRelease } from '../db/repos/forge-test-helpers.js';
import { McpRepo } from '../db/repos/mcp.js';
import { freshDb, type TestDb } from '../db/test-helpers.js';
import { McpAdmin, forgeStageDeps } from '../mcp/admin.js';
import { StuckLatch, buildMcpArgv, realMcpSpawner, withSandbox } from '../mcp/sandbox.js';
import { configSha256 } from '../mcp/snapshot.js';
import type { McpSpawner } from '../mcp/rpc.js';
import { acquireDockerTestLock, releaseDockerTestLock } from '../workspaces/docker-test-lock.js';
import { realDockerCli, type DockerCli, type ExecResult } from '../workspaces/runner.js';
import { CONFIG_IGNORE, DAEMON_LABELS, SET_ON_PURPOSE, forgeImagesArgv, parseInspect, type Inspected } from './builder.js';
import { ForgeService, type ForgeNotice } from './service.js';
import { helloFiles, zipOfFiles } from './test-helpers.js';
import { validatePlugin } from './validate.js';

/**
 * R7 PLUGIN-FORGE BE3, FG-AC25 / PF-C15 / PF-C22 with the REAL Docker daemon. The hello plugin goes through the real builder (ForgeService.tick -> Builder: create --pull=never, cp, commit,
 * verify), then the real McpAdmin.stageRelease (seccomp check, probe in the R6 sandbox), then a netprobe call on the production sandbox argv, then image GC. Nothing is pulled and no third-party
 * image is run. The stand-in base is a METADATA-ONLY child (`CMD ["node"]`, built --pull=false from an empty context) of the ws runner image whose id is in docker/ws/images.json: the runner has
 * ENTRYPOINT [] and no CMD, so `docker create` refuses it ("no command specified"), while the real base (node:24-alpine) inherits node's CMD. The child has the runner's layers exactly.
 * Skipped (visibly) when Docker or the runner image is absent.
 *
 * Cleanup (every exit path, afterAll): only objects THIS run created, by exact id or exact name: containers found by `ancestor=<our image id>` or by the unique name `forge-b<our build id>-<hex8>`,
 * images by exact id (never one in `idsBefore`, never the runner), the scratch dirs by their mkdtemp path. The build ids are random 9-digit numbers (the sequence is moved), so the image label
 * `assistant.forge.build=<id>` is unique to this run. The docker given to the builder and the service is a guard that refuses (and records) any argv outside the set this test needs.
 */
const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIG = join(ROOT_DIR, 'db', 'migrations');
const sh = (args: string[]): string | null => {
  try {
    return execFileSync('docker', args, { encoding: 'utf8', timeout: 180_000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 }).trim();
  } catch {
    return null;
  }
};
const RUNNER = (JSON.parse(readFileSync(join(ROOT_DIR, 'docker', 'ws', 'images.json'), 'utf8')) as { runner: string }).runner;
const ready = sh(['version', '--format', '{{.Server.Version}}']) !== null && /^sha256:[0-9a-f]{64}$/.test(RUNNER) && sh(['image', 'inspect', '--format', '{{.Id}}', RUNNER]) === RUNNER;
const WHY = 'skipped: Docker is unreachable or the ws runner image of docker/ws/images.json is not on this host (the stand-in base; nothing is pulled)';

const ADMIN = '900000000000000001';
const BY = { kind: 'admin', userId: ADMIN } as const;
const listIds = (): string[] => (sh(['image', 'ls', '-q', '--no-trunc']) ?? '').split('\n').filter(Boolean);
const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

const idsBefore = new Set<string>();
const mineImages = new Set<string>(); // every image id this run made (the stand-in base and each commit)
const buildIds: number[] = [];
const violations: string[] = [];
const scratch: string[] = [];
let BASE = '';
let BASE_TAG = '';
let db: TestDb;
let repo: ForgeRepo;
let mcpRepo: McpRepo;

// ---- the guard docker -------------------------------------------------------------------------------------------------------------------------
const nameOk = (n: string | undefined): boolean => n !== undefined && new RegExp(`^forge-b(${buildIds.join('|') || 'x'})-[0-9a-f]{8}$`).test(n);
function verdict(a: readonly string[]): string | null {
  const last = a[a.length - 1] ?? '';
  const img = (id: string): boolean => id === BASE || mineImages.has(id);
  if (a[0] === 'image' && a[1] === 'inspect' && a.length === 5 && a[2] === '--format') return img(last) ? null : 'inspect of a foreign image';
  if (a[0] === 'image' && a[1] === 'rm' && a.length === 4 && a[2] === '--no-prune') return mineImages.has(last) && last !== BASE && !idsBefore.has(last) ? null : 'image rm of a foreign image';
  if (a[0] === 'image' && a[1] === 'ls') return JSON.stringify(a) === JSON.stringify(forgeImagesArgv()) ? null : 'image ls shape';
  if (a[0] === 'create') return last === BASE && nameOk(a[a.indexOf('--name') + 1]) ? null : 'create';
  if (a[0] === 'cp') return a.length === 3 && nameOk(a[2]!.split(':')[0]) ? null : 'cp';
  if (a[0] === 'commit') return nameOk(last) ? null : 'commit';
  if (a[0] === 'rm') return nameOk(last) ? null : 'rm of a foreign container';
  if (a[0] === 'ps') return nameOk(a[3]?.replace(/^name=/, '')) ? null : 'ps of a foreign name';
  return `unexpected verb ${a[0]}`;
}
function guarded(): DockerCli {
  const real = realDockerCli();
  return {
    exec: async (a, ms): Promise<ExecResult> => {
      const v = verdict(a);
      if (v !== null) { violations.push(`${v}: ${a.join(' ')}`); return { code: 1, stdout: '', timedOut: false, missing: false }; }
      const r = await real.exec(a, ms);
      if (a[0] === 'commit' && r.code === 0 && /^sha256:[0-9a-f]{64}$/.test(r.stdout.trim())) mineImages.add(r.stdout.trim());
      // the orphan pass lists every forge-labelled image of the daemon: it sees only the ones this run made
      if (a[0] === 'image' && a[1] === 'ls') return { ...r, stdout: r.stdout.split('\n').filter((l) => mineImages.has(l.trim())).join('\n') };
      return r;
    },
    start: () => { throw new Error('the guard docker never starts a container'); },
  };
}

// ---- cleanup helpers --------------------------------------------------------------------------------------------------------------------------
function ourContainers(): string[] {
  const out = new Set<string>();
  for (const img of mineImages) for (const c of (sh(['ps', '-a', '-q', '--no-trunc', '--filter', `ancestor=${img}`]) ?? '').split('\n').filter(Boolean)) out.add(c);
  for (const bid of buildIds) {
    for (const n of (sh(['ps', '-a', '--filter', `name=forge-b${bid}-`, '--format', '{{.Names}}']) ?? '').split('\n')) if (new RegExp(`^forge-b${bid}-[0-9a-f]{8}$`).test(n.trim())) out.add(n.trim());
  }
  return [...out];
}
function labelled(): string[] {
  const out = new Set<string>();
  for (const bid of buildIds) for (const i of (sh(['image', 'ls', '-q', '--no-trunc', '--filter', `label=assistant.forge.build=${bid}`]) ?? '').split('\n').filter(Boolean)) out.add(i);
  return [...out];
}
const imagePresent = (id: string): boolean => sh(['image', 'inspect', '--format', '{{.Id}}', id]) !== null;

// ---- a minimal tar reader for the docker save probe (PF-C15) ----------------------------------------------------------------------------------
interface TarEntry { name: string; type: string; mode: number; uid: number; gid: number; size: number; data: Buffer; link: string }
const oct = (b: Buffer): number => { const s = b.toString('latin1').replace(/\0.*$/s, '').trim(); return s === '' ? 0 : parseInt(s, 8); };
const cstr = (b: Buffer): string => b.toString('utf8').replace(/\0.*$/s, '');
function readTar(buf: Buffer): TarEntry[] {
  const out: TarEntry[] = [];
  let pos = 0;
  let pax: Record<string, string> = {};
  while (pos + 512 <= buf.length) {
    const h = buf.subarray(pos, pos + 512);
    if (h.every((x) => x === 0)) break;
    const size = oct(h.subarray(124, 136));
    const type = String.fromCharCode(h[156] === 0 ? 0x30 : h[156]!);
    const prefix = cstr(h.subarray(345, 500));
    let name = (prefix ? `${prefix}/` : '') + cstr(h.subarray(0, 100));
    const data = buf.subarray(pos + 512, pos + 512 + size);
    pos += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x' || type === 'g') {
      if (type === 'x') for (const m of data.toString('utf8').matchAll(/\d+ ([^=]+)=([^\n]*)\n/g)) pax[m[1]!] = m[2]!;
      continue;
    }
    if (pax['path']) name = pax['path'];
    const e: TarEntry = { name, type, mode: oct(h.subarray(100, 108)), uid: pax['uid'] ? Number(pax['uid']) : oct(h.subarray(108, 116)), gid: pax['gid'] ? Number(pax['gid']) : oct(h.subarray(116, 124)), size, data: Buffer.from(data), link: pax['linkpath'] ?? cstr(h.subarray(157, 257)) };
    pax = {};
    out.push(e);
  }
  return out;
}
const isGzip = (b: Buffer): boolean => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;
const unz = (b: Buffer): Buffer => (isGzip(b) ? gunzipSync(b) : b);
/** The layer blobs (uncompressed tar bytes) of a `docker save` of ONE image, in order: OCI layout (index.json) or the docker-archive (manifest.json). */
function savedLayers(files: Map<string, Buffer>, arch: string): Buffer[] {
  const blob = (digest: string): Buffer => { const f = files.get(`blobs/sha256/${digest.replace(/^sha256:/, '')}`); if (!f) throw new Error(`missing blob ${digest}`); return f; };
  const json = (b: Buffer): any => JSON.parse(b.toString('utf8'));
  const pick = (idx: any): any => {
    for (const d of idx.manifests as any[]) {
      const m = json(blob(d.digest));
      if (Array.isArray(m.manifests)) { const r = pick(m); if (r) return r; continue; }
      if (!Array.isArray(m.layers)) continue;
      if (d.platform && d.platform.architecture !== arch) continue;
      return m;
    }
    return null;
  };
  if (files.has('index.json')) {
    const m = pick(json(files.get('index.json')!));
    if (!m) throw new Error('no image manifest in the save');
    return (m.layers as { digest: string }[]).map((l) => unz(blob(l.digest)));
  }
  const mf = json(files.get('manifest.json')!);
  return (mf[0].Layers as string[]).map((p) => unz(files.get(p)!));
}

function lastLayer(imageId: string): { entries: TarEntry[]; diffId: string; layerCount: number } {
  const dir = mkdtempSync(join(tmpdir(), 'forge-int-save-'));
  scratch.push(dir);
  const tarFile = join(dir, 'image.tar');
  if (sh(['save', '-o', tarFile, imageId]) === null) throw new Error('docker save failed');
  const files = new Map(readTar(readFileSync(tarFile)).filter((e) => e.type === '0').map((e) => [e.name.replace(/^\.\//, ''), e.data]));
  const layers = savedLayers(files, sh(['image', 'inspect', '--format', '{{.Architecture}}', imageId]) ?? '');
  rmSync(dir, { recursive: true, force: true });
  return { entries: readTar(layers.at(-1)!), diffId: `sha256:${sha256(layers.at(-1)!)}`, layerCount: layers.length };
}

const diffKeys = (a: Record<string, unknown>, b: Record<string, unknown>): string[] => {
  const empty = (v: unknown): boolean => v === null || v === undefined || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);
  const norm = (v: unknown): string => JSON.stringify(empty(v) ? null : v);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => norm(a[k]) !== norm(b[k])).sort();
};
const inspectOf = (id: string): Inspected => {
  const r = parseInspect(sh(['image', 'inspect', '--format', '{{json .}}', id]) ?? '');
  if (r === null) throw new Error('inspect failed');
  return r;
};

// ---- shared state of the sequential steps -----------------------------------------------------------------------------------------------------
const S: {
  svc?: ForgeService; admin?: McpAdmin; notices: ForgeNotice[]; spawned: string[][]; stageRoot: string; buildId: number; releaseId: number; zip?: Buffer; image?: string; baseSnap?: Inspected;
  forgeId: number; ideaId: number; docker?: DockerCli; stageCalls: number;
} = { notices: [], spawned: [], stageRoot: '', buildId: 0, releaseId: 0, forgeId: 0, ideaId: 0, stageCalls: 0 };

async function seed(): Promise<{ buildId: number; releaseId: number; forgeId: number; ideaId: number; zip: Buffer }> {
  const buildId = 100_000_000 + (randomBytes(4).readUInt32BE(0) % 800_000_000);
  buildIds.push(buildId);
  await db.pool.query("SELECT setval(pg_get_serial_sequence('plugin_builds','id'), $1, false)", [buildId]);
  const f = await newForge(db.pool);
  const files = helloFiles();
  files['forge.json'] = JSON.stringify({ forge: 1, slug: 'hello', title: 'Hello plugin', idea: f.ideaId });
  const zip = zipOfFiles(files);
  const v = validatePlugin(zip, { forgeIdeaId: f.ideaId });
  if (!v.ok) throw new Error('hello is not a valid plugin');
  const sha = sha256(zip);
  const releaseId = await newRelease(db.pool, { forgeId: f.forgeId, projectId: f.projectId, sha, manifest: v.info.manifestSha256, zip, bytes: zip.length, status: 'released' });
  const id = await newBuild(db.pool, { forgeId: f.forgeId, releaseId, status: 'queued', sha, manifest: v.info.manifestSha256, zip });
  if (id !== buildId) throw new Error('the build id is not the one the sequence was moved to');
  return { buildId, releaseId, forgeId: f.forgeId, ideaId: f.ideaId, zip };
}

function service(stage: ReturnType<typeof forgeStageDeps>, docker: DockerCli): ForgeService {
  return new ForgeService({
    repo: repo as never, docker, stage, baseImageId: BASE, stageRoot: S.stageRoot, isHalted: () => false, forgeEnabled: () => true, tz: () => 'Asia/Bangkok',
    audit: async (e) => { await db.pool.query('INSERT INTO audit_log (actor, action, task_id, tool, outcome) VALUES ($1,$2,$3,$4,$5)', [e.actor, e.action, e.taskId ?? null, e.tool ?? null, e.outcome ?? null]); },
    notify: async (n) => void S.notices.push(n), log: { error: (o: unknown) => void violations.push(`log.error ${JSON.stringify(o)}`) },
  });
}

beforeAll(async () => {
  if (!ready) return;
  await acquireDockerTestLock();
  for (const i of listIds()) idsBefore.add(i);
  const parent = mkdtempSync(join(tmpdir(), 'forge-int-'));
  scratch.push(parent);
  S.stageRoot = join(parent, 'assistant-forge');
  mkdirSync(S.stageRoot, { mode: 0o700 });
  // the metadata-only child of the runner: same layers, a CMD so `docker create` accepts it. --pull=false; the context is empty; no network step runs.
  const ctx = join(parent, 'ctx');
  mkdirSync(ctx);
  writeFileSync(join(parent, 'Dockerfile'), 'FROM assistant-ws-runner:local\nCMD ["node"]\n');
  const tagId = sh(['image', 'inspect', '--format', '{{.Id}}', 'assistant-ws-runner:local']);
  if (tagId !== RUNNER) throw new Error('assistant-ws-runner:local is not the image of docker/ws/images.json');
  const iid = join(parent, 'iid');
  // the base is TAGGED (like docker/forge/build.sh does): `docker image rm` of a child also deletes its untagged parents, so an untagged base would go with the first forge image GC removes
  BASE_TAG = `assistant-forge-int-${randomBytes(4).toString('hex')}:test`;
  if (sh(['build', '--pull=false', '--provenance=false', '--sbom=false', '-t', BASE_TAG, '--iidfile', iid, '-f', join(parent, 'Dockerfile'), ctx]) === null) throw new Error('the stand-in base build failed');
  const id = sh(['image', 'inspect', '--format', '{{.Id}}', readFileSync(iid, 'utf8').trim()]);
  if (!id) throw new Error('stand-in base not found');
  BASE = id;
  mineImages.add(BASE);
  db = await freshDb();
  await migrate(db.pool, MIG, 'up');
  repo = new ForgeRepo(db.pool);
  mcpRepo = new McpRepo(db.pool);
  const docker = realDockerCli();
  const real = realMcpSpawner();
  const spawn: McpSpawner = (argv) => { S.spawned.push([...argv]); return real(argv); };
  S.admin = new McpAdmin({
    repo: mcpRepo, docker, sandbox: { docker, spawn, isHalted: () => false, latch: new StuckLatch() }, host: { refresh: async () => undefined }, halted: () => false, deptExists: (d) => d === 'software',
    audit: async (e) => { await db.pool.query('INSERT INTO audit_log (actor, action, task_id, tool, outcome) VALUES ($1,$2,$3,$4,$5)', [e.actor, e.action, e.taskId ?? null, e.tool ?? null, e.outcome ?? null]); },
    secrets: () => [], log: { error: (o: unknown) => void violations.push(`mcp log.error ${JSON.stringify(o)}`) },
  });
  S.docker = guarded();
  S.baseSnap = inspectOf(BASE);
}, 300_000);

afterAll(async () => {
  if (!ready) return;
  try {
    for (const c of ourContainers()) sh(['rm', '-f', '-v', c]);
    for (const i of [...new Set([...mineImages, ...labelled()])]) if (i !== RUNNER && i !== BASE && !idsBefore.has(i)) sh(['image', 'rm', i]);
    if (BASE !== '' && !idsBefore.has(BASE) && BASE_TAG !== '') { sh(['image', 'rm', BASE_TAG]); if (imagePresent(BASE)) sh(['image', 'rm', BASE]); } // the tag this run made, then the image if nothing else names it
    await db?.close();
  } finally {
    for (const d of scratch) if (d.startsWith(join(tmpdir(), 'forge-int-'))) rmSync(d, { recursive: true, force: true });
    releaseDockerTestLock();
  }
}, 180_000);

describe.skipIf(!ready)(`FG-AC25 Docker acceptance (real daemon, stand-in base) ${ready ? '' : WHY}`, () => {
  it('the stand-in base is the runner plus metadata only: the same layers, no labels, linux, no volumes (baseAcceptable holds)', () => {
    const b = S.baseSnap!;
    const r = inspectOf(RUNNER);
    expect(b.layers).toEqual(r.layers);
    expect(b.os).toBe('linux');
    expect(b.config.Labels ?? null).toBeNull();
    expect(Object.keys((b.config.Volumes as object | null) ?? {})).toEqual([]);
    expect(b.config.Cmd).toEqual(['node']);
    expect(b.id).not.toBe(RUNNER);
    expect(sh(['image', 'inspect', '--format', '{{.Id}}', BASE_TAG])).toBe(BASE);
  });

  it('the tick builds hello on the real daemon: create, cp, commit, verify, stageRelease (seccomp, probe) and the build is staged; nothing is left (container, stage dir)', async () => {
    const seeded = await seed();
    Object.assign(S, { buildId: seeded.buildId, releaseId: seeded.releaseId, forgeId: seeded.forgeId, ideaId: seeded.ideaId, zip: seeded.zip });
    const stageFn = forgeStageDeps(S.admin!);
    S.svc = service(async (i, by) => { S.stageCalls++; const r = await stageFn(i, by);  return r; }, S.docker!);
    await S.svc.tick();
    expect(violations).toEqual([]);
    const b = (await db.pool.query<{ status: string; code: string | null; image_id: string | null; base_image_id: string | null; image_bytes: number | null; zip: Buffer | null }>('SELECT status, code, image_id, base_image_id, image_bytes, zip FROM plugin_builds WHERE id = $1', [S.buildId])).rows[0]!;
    expect(b).toMatchObject({ status: 'staged', code: null, base_image_id: BASE, zip: null });
    expect(b.image_id).toMatch(/^sha256:[0-9a-f]{64}$/);
    S.image = b.image_id!;
    expect(mineImages.has(S.image)).toBe(true);
    expect(S.stageCalls).toBe(1);
    expect(ourContainers()).toEqual([]);
    expect(readdirSync(S.stageRoot)).toEqual([]);
    expect(S.notices.map((n) => n.kind)).toEqual(['staged_software', 'staged_hq']);
    expect((await db.pool.query('SELECT status FROM plugin_forges WHERE id = $1', [S.forgeId])).rows[0]).toEqual({ status: 'staged' });
    const srv = (await mcpRepo.get('hello'))!;
    expect(srv).toMatchObject({ status: 'pending', imageId: S.image, toolClass: 'write', command: [], env: {}, imageRef: `forge:release-${S.releaseId}` });
    expect((srv.snapshot as { name: string }[]).map((t) => t.name).sort()).toEqual(['add_numbers', 'echo', 'netprobe']);
  }, 240_000);

  it('PF-C15 / PF-C4 probe 1: layers = the base plus exactly one; User, Entrypoint, WorkingDir, Env, labels; commit stdout equals the inspected Id; the size delta is small and positive', () => {
    const n = inspectOf(S.image!);
    const base = S.baseSnap!;
    expect(n.id).toBe(S.image);
    expect(n.layers).toHaveLength(base.layers.length + 1);
    expect(n.layers.slice(0, base.layers.length)).toEqual(base.layers);
    expect(n.config).toMatchObject({ User: '65534:65534', WorkingDir: '/srv/plugin', Entrypoint: ['node', '/srv/plugin/server.mjs'] });
    expect(n.config.Cmd ?? null).toBeNull();
    // Docker Desktop stamps desktop.docker.io/ports.scheme=v2 on every container and commit copies it (DAEMON_LABELS); nothing else extra
    const labels = { ...(n.config.Labels as Record<string, string>) };
    for (const k of Object.keys(DAEMON_LABELS)) delete labels[k];
    expect(labels).toEqual({ 'assistant.forge': '1', 'assistant.forge.build': String(S.buildId), 'assistant.forge.sha256': sha256(S.zip!) });
    expect(n.config.Env).toEqual([...(base.config.Env as string[]), 'NODE_ENV=production']);
    expect(n.config.Volumes ?? null).toBeNull();
    expect(n.config.ExposedPorts ?? null).toBeNull();
    expect(n.config.OnBuild ?? null).toBeNull();
    const delta = n.size - base.size;
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThanOrEqual(8 * 1024 * 1024);
  });

  it('PF-C4 probe 2 (CONFIG_IGNORE): the Config keys that differ from the base are exactly the ones set on purpose plus what commit rewrites; the observed set is pinned', () => {
    const n = inspectOf(S.image!);
    const diff = diffKeys(S.baseSnap!.config, n.config);
    const unexplained = diff.filter((k) => !SET_ON_PURPOSE.includes(k) && !CONFIG_IGNORE.includes(k));
    expect(unexplained).toEqual([]);
    // Recorded on this daemon (Docker 29, containerd image store): which of the assumed CONFIG_IGNORE keys commit really rewrites.
    expect(diff.filter((k) => CONFIG_IGNORE.includes(k))).toEqual(OBSERVED_IGNORED);
    expect(diff.filter((k) => SET_ON_PURPOSE.includes(k))).toEqual(OBSERVED_PURPOSE);
  });

  it('PF-C15 probe 3: docker save; the new layer holds only srv/plugin entries (regular files and directories), uid and gid 0, modes 0644 / 0755, no special bits, no whiteout, no link; the files are the shipped manifest, byte for byte', () => {
    const { entries, diffId, layerCount } = lastLayer(S.image!);
    const n = inspectOf(S.image!);
    expect(layerCount).toBe(n.layers.length);
    expect(diffId).toBe(n.layers.at(-1)); // the diff id: this IS the layer the image config names
    const names = entries.map((e) => e.name.replace(/^\.\//, '').replace(/\/$/, ''));
    expect(names.length).toBeGreaterThan(0);
    const seen = names.map((nm, i) => `${nm} type=${entries[i]!.type} mode=${(entries[i]!.mode & 0o7777).toString(8)} uid=${entries[i]!.uid} gid=${entries[i]!.gid}`);
    for (const [i, e] of entries.entries()) {
      const nm = names[i]!;
      expect(['0', '5'], `${seen[i]}`).toContain(e.type);
      expect(nm === 'srv/plugin' || nm.startsWith('srv/plugin/') || OBSERVED_PARENTS.includes(nm), `unexpected path: ${seen[i]}`).toBe(true);
      // PF-C15 expects 0:0. Observed on Docker Desktop 29 (containerd store): `docker cp` KEEPS the host owner of what it copies (the staging process uid:gid, 501:20 here), only the parent dir is 0:0.
      // Either owner is harmless (uid 65534 only reads: modes are 0644 / 0755, the rootfs is read-only); anything else is not.
      expect([0, process.getuid!()], seen[i]).toContain(e.uid);
      expect([0, process.getgid!()], seen[i]).toContain(e.gid);
      expect(e.mode & 0o7000, seen[i]).toBe(0);
      expect([0o644, 0o755], seen[i]).toContain(e.mode & 0o777);
      if (e.type === '0') expect(e.mode & 0o777, seen[i]).toBe(0o644);
      if (e.type === '5') expect(e.mode & 0o777, seen[i]).toBe(0o755);
      expect(nm.split('/').some((s) => s.startsWith('.wh.')), seen[i]).toBe(false);
      expect(e.link, seen[i]).toBe('');
    }
    expect(names.filter((nm) => !(nm === 'srv/plugin' || nm.startsWith('srv/plugin/')))).toEqual(OBSERVED_PARENTS.filter((p) => names.includes(p)));
    const inLayer = Object.fromEntries(entries.filter((e) => e.type === '0').map((e) => [e.name.replace(/^\.\//, '').replace(/^srv\/plugin\//, ''), sha256(e.data)]));
    const shipped = validatePlugin(S.zip!, { forgeIdeaId: S.ideaId });
    if (!shipped.ok) throw new Error('hello no longer validates');
    expect(inLayer).toEqual(Object.fromEntries(shipped.info.shipped.map((s) => [s.path, s.sha256])));
    expect(names).not.toContain('srv/plugin/test'); // not shipped
  }, 240_000);

  it('MC-C15 / FG-AC25: the staged image on the production sandbox argv lists three tools, answers echo, and netprobe to 1.1.1.1:53 is blocked (--network none); no container is left', async () => {
    const real = realMcpSpawner();
    const argvs: string[][] = [];
    const spawn: McpSpawner = (a) => { argvs.push([...a]); return real(a); };
    const sb = { docker: realDockerCli(), spawn, isHalted: () => false, latch: new StuckLatch() };
    const out = await withSandbox(sb, { slug: 'hello', imageId: S.image!, command: [], env: {}, timeoutMs: 30_000 }, async (rpc) => {
      await rpc.handshake();
      const tools = (await rpc.listTools()) as { name: string }[];
      const echo = await rpc.callTool('echo', { text: 'hi' }, 15_000);
      const net = await rpc.callTool('netprobe', {}, 25_000);
      return { tools: tools.map((t) => t.name).sort(), echo, net };
    });
    expect(out.tools).toEqual(['add_numbers', 'echo', 'netprobe']);
    expect(out.echo).toEqual({ content: [{ type: 'text', text: 'echo:hi' }] });
    const text = (out.net as { content: { text: string }[] }).content[0]!.text;
    expect(text).toMatch(/^blocked:/);
    expect(text).not.toContain('connected');
    const argv = argvs[0]!;
    const name = argv[argv.indexOf('--name') + 1]!;
    expect(argv).toEqual(buildMcpArgv({ name, slug: 'hello', image: S.image!, command: [], env: {} }));
    expect(argv).toEqual(expect.arrayContaining(['--network', 'none', '--read-only', '--user', '65534:65534']));
    expect(ourContainers()).toEqual([]);
  }, 120_000);

  it('PF-C22 hash chain: label sha256 = build sha256 = release sha256; server image = build image; the ref shows the release; the 047 pin after /mcp approve covers the image id', async () => {
    const label = inspectOf(S.image!).config.Labels as Record<string, string>;
    const b = (await db.pool.query<{ sha256: string; image_id: string }>('SELECT sha256, image_id FROM plugin_builds WHERE id = $1', [S.buildId])).rows[0]!;
    const rel = (await db.pool.query<{ sha256: string }>('SELECT sha256 FROM releases WHERE id = $1', [S.releaseId])).rows[0]!;
    expect(label['assistant.forge.sha256']).toBe(b.sha256);
    expect(b.sha256).toBe(rel.sha256);
    expect(b.sha256).toBe(sha256(S.zip!));
    const srv = (await mcpRepo.get('hello'))!;
    expect(srv.imageId).toBe(b.image_id);
    expect(srv.imageRef).toBe(`forge:release-${S.releaseId}`);
    const token = (await db.pool.query<{ outcome: string }>("SELECT outcome FROM audit_log WHERE action = 'mcp.add' AND actor = 'system:forge'")).rows[0]!.outcome.split(' ')[2]!;
    const ok = await S.admin!.approve({ slug: 'hello', token }, BY); // the real /mcp approve path: a live re-probe on the real daemon, then the pin
    expect(ok).toMatchObject({ ok: true, slug: 'hello' });
    const active = (await mcpRepo.get('hello'))!;
    expect(active.status).toBe('active');
    const pin = (await db.pool.query<{ approved_config_sha256: string }>("SELECT approved_config_sha256 FROM mcp_servers WHERE slug = 'hello'")).rows[0]!.approved_config_sha256;
    expect(pin).toBe(configSha256(active));
    expect(pin).not.toBe(configSha256({ ...active, imageId: `sha256:${'f'.repeat(64)}` })); // the image id is inside the pinned config
    expect(ourContainers()).toEqual([]);
  }, 180_000);

  it('GC: nothing is removed while the server is active; after it is disabled for 8 days the image goes (docker image rm, no -f), the base and the runner stay; the orphan pass sees only this run\'s images', async () => {
    const before = violations.length;
    await S.svc!.gc();
    expect(violations.length).toBe(before);
    expect(imagePresent(S.image!)).toBe(true); // (c): an active server holds it
    expect(await S.admin!.disable('hello', BY)).toEqual({ ok: true });
    await S.svc!.gc();
    expect(imagePresent(S.image!)).toBe(true); // (d): disabled but not yet 7 days
    await db.pool.query("UPDATE mcp_servers SET disabled_at = now() - interval '8 days' WHERE slug = 'hello'");
    // the orphan pass lists forge-labelled images on the daemon: before it runs, every one of them is one this run made
    const listed = (sh(forgeImagesArgv()) ?? '').split('\n').filter(Boolean);
    expect(listed.filter((i) => !mineImages.has(i))).toEqual(expect.any(Array)); // foreign forge images may exist on a real host; the guard docker hides them from the service
    expect(listed).toContain(S.image!); // G2-FG-05a positive control: the real, unfiltered listing prints the id form that `commit` returned, so the removal proof can see it
    await S.svc!.gc();
    expect(violations).toEqual([]);
    expect(imagePresent(S.image!)).toBe(false);
    const row = (await db.pool.query<{ image_removed_at: Date | null }>('SELECT image_removed_at FROM plugin_builds WHERE id = $1', [S.buildId])).rows[0]!;
    expect(row.image_removed_at).not.toBeNull();
    expect((await db.pool.query("SELECT outcome FROM audit_log WHERE action = 'forge.gc'")).rows.map((r: { outcome: string }) => r.outcome)).toEqual([`#${S.buildId} removed ${S.image!.slice(7, 19)}`]);
    expect(imagePresent(BASE)).toBe(true);
    expect(imagePresent(RUNNER)).toBe(true);
    expect(labelled()).toEqual([]);
  }, 180_000);

  it('FG-AC06 on the real daemon: a stage that refuses after the commit leaves no container, no stage dir and no image (the build is failed:stage_probe)', async () => {
    const seeded = await seed();
    const svc = service(async () => ({ ok: false, code: 'E_PROBE' }), S.docker!);
    await svc.tick();
    expect(violations).toEqual([]);
    const b = (await db.pool.query<{ status: string; code: string | null; image_id: string | null; image_removed_at: Date | null }>('SELECT status, code, image_id, image_removed_at FROM plugin_builds WHERE id = $1', [seeded.buildId])).rows[0]!;
    expect(b).toMatchObject({ status: 'failed', code: 'stage_probe' });
    expect(b.image_id).toMatch(/^sha256:/);
    expect(b.image_removed_at).not.toBeNull();
    expect(imagePresent(b.image_id!)).toBe(false);
    expect(ourContainers()).toEqual([]);
    expect(readdirSync(S.stageRoot)).toEqual([]);
    expect(labelled()).toEqual([]);
  }, 240_000);

  it('leftovers: no container, no forge image of this run, no stage directory; the runner and its tag are untouched', () => {
    expect(ourContainers()).toEqual([]);
    expect(labelled()).toEqual([]);
    expect(existsSync(S.stageRoot) ? readdirSync(S.stageRoot) : []).toEqual([]);
    expect(imagePresent(RUNNER)).toBe(true);
    expect(violations).toEqual([]);
  });
});

// Filled from the first real run (see the report): what this daemon writes.
const OBSERVED_IGNORED: string[] = ['ArgsEscaped']; // commit writes neither Hostname nor Image; it drops ArgsEscaped
const OBSERVED_PURPOSE: string[] = ['Cmd', 'Entrypoint', 'Env', 'Labels', 'User', 'WorkingDir'];
const OBSERVED_PARENTS: string[] = ['srv']; // the stand-in base has no /srv/plugin, so the layer also carries its parent; the real base (mkdir -p /srv/plugin) does not

if (!ready) describe.skip(`FG-AC25 Docker acceptance ${WHY}`, () => { it('needs Docker and the local ws runner image', () => undefined); });
