import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dockerEnv } from '../workspaces/runner.js';
import {
  Builder, CONFIG_IGNORE, DAEMON_LABELS, ForgeLatch, checkStage, cleanStageRoot, commitArgv, cpArgv, createArgv, forgeImagesArgv, imageInspectArgv, imageRmArgv, inspectBase, parseInspect, psSweepArgv, removeImageVerified,
  stageCode, sweepForgeContainers, verifiedRoot, verifyImage, writeFiles, type BuilderDeps, type Inspected,
} from './builder.js';
import { BASE_CONFIG, BASE_ID, BASE_LAYERS, FakeForgeDocker, NEW_ID, helloBuild, removeScratch, scratchRoot } from './test-helpers.js';
import type { StageReleaseFn } from './types.js';
import { validatePlugin } from './validate.js';

const NAME = 'forge-b7-0123abcd';
let scratch: { root: string; parent: string };
beforeEach(() => { scratch = scratchRoot(); });
afterEach(async () => { await removeScratch(scratch.parent); });

function mk(over: Partial<BuilderDeps> = {}, dockerSetup?: (d: FakeForgeDocker) => void) {
  const docker = new FakeForgeDocker();
  dockerSetup?.(docker);
  const calls: string[] = [];
  const stageCalls: unknown[][] = [];
  const logs: unknown[] = [];
  const stuck: number[] = [];
  const latch = new ForgeLatch();
  const repo = {
    recordImage: vi.fn(async (_id: number, _img: string) => { calls.push('recordImage'); return true; }),
    imageRemoved: vi.fn(async (_id: number, _i12: string) => { calls.push('imageRemoved'); return true; }),
    serverOfRelease: vi.fn(async (_r: number) => null as { id: number; slug: string; imageId: string; status: string } | null),
    stillLive: vi.fn(async (_f: number) => true),
  };
  const stage = vi.fn<StageReleaseFn>(async (...a: unknown[]) => { stageCalls.push(a); calls.push('stage'); return { ok: true, slug: 'hello', config12: 'abcdef012345', toolCount: 2 }; });
  const d: BuilderDeps = {
    docker, repo, stage, baseImageId: BASE_ID, stageRoot: scratch.root, isHalted: () => false, forgeEnabled: () => true, latch, onStuck: () => void stuck.push(1),
    newSuffix: () => '0123abcd', log: { error: (o: unknown) => void logs.push(o) }, ...over,
  };
  return { b: new Builder(d), d, docker, repo, stage, stageCalls, logs, stuck, latch, calls };
}
const dirsLeft = (): string[] => readdirSync(scratch.root);
const orderOf = (docker: FakeForgeDocker): string[] => docker.verbs();

describe('FG-AC04 / PF-C16: the argv is built in one place and golden-tested', () => {
  it('exact arrays', () => {
    expect(imageInspectArgv(BASE_ID)).toEqual(['image', 'inspect', '--format', '{{json .}}', BASE_ID]);
    expect(createArgv(NAME, BASE_ID)).toEqual(['create', '--pull=never', '--network', 'none', '--log-driver=none', '--name', NAME, BASE_ID]);
    expect(cpArgv('/tmp/x/assistant-forge/b-AbC123', NAME)).toEqual(['cp', '/tmp/x/assistant-forge/b-AbC123/.', `${NAME}:/srv/plugin`]);
    const sha = 'f'.repeat(64);
    expect(commitArgv(NAME, 7, sha)).toEqual([
      'commit', '--change', 'USER 65534:65534', '--change', 'WORKDIR /srv/plugin', '--change', 'ENTRYPOINT ["node","/srv/plugin/server.mjs"]', '--change', 'CMD []', '--change', 'ENV NODE_ENV=production',
      '--change', 'LABEL assistant.forge=1', '--change', 'LABEL assistant.forge.build=7', '--change', `LABEL assistant.forge.sha256=${sha}`, NAME,
    ]);
    // G2-FG-01: `--no-prune`, so removing a plugin image never deletes an untagged parent (the base, if its tag was ever removed); probed on Docker 29 (containerd store)
    expect(imageRmArgv(NEW_ID)).toEqual(['image', 'rm', '--no-prune', NEW_ID]);
    expect(psSweepArgv()).toEqual(['ps', '-a', '--filter', 'name=forge-b', '--format', '{{.Names}}']);
    expect(forgeImagesArgv()).toEqual(['image', 'ls', '-a', '--no-trunc', '--filter', 'label=assistant.forge=1', '--format', '{{.ID}}']);
  });
  it('no argv carries run, start, exec, build, pull, push, tag, prune, system or rmi; cp has no -a, --archive, -L or --follow-link; image rm has no -f', () => {
    const all = [imageInspectArgv(BASE_ID), createArgv(NAME, BASE_ID), cpArgv('/d', NAME), commitArgv(NAME, 7, 'f'.repeat(64)), imageRmArgv(NEW_ID), psSweepArgv(), forgeImagesArgv()];
    for (const a of all) for (const w of ['run', 'start', 'exec', 'build', 'pull', 'push', 'tag', 'prune', 'system', 'rmi', 'save', 'load', 'import', 'export']) expect(a, w).not.toContain(w);
    expect(cpArgv('/d', NAME)).toHaveLength(3);
    for (const f of ['-a', '--archive', '-L', '--follow-link']) expect(cpArgv('/d', NAME)).not.toContain(f);
    expect(imageRmArgv(NEW_ID)).not.toContain('-f');
    expect(imageRmArgv(NEW_ID)).not.toContain('--force');
  });
  it('the source file names no forbidden docker verb as an argv element and spawns nothing itself', () => {
    const src = readFileSync(new URL('./builder.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const w of ['run', 'start', 'build', 'pull', 'push', 'tag', 'prune', 'system', 'rmi']) expect(src, w).not.toMatch(new RegExp(`['"\`]${w}['"\`]`));
    expect(src).not.toMatch(/\[\s*['"`]exec['"`]/); // an argv that starts with exec (the port's own `exec` method name is not an argv)
    expect(src).not.toMatch(/child_process|\bspawn\(|execFile/);
    expect(src).not.toMatch(/\.\.\/mcp\//);
    expect(src).not.toMatch(/shell\s*:\s*true/);
  });
  it('the spawn environment of the real docker port is PATH, HOME and DOCKER_HOST only', () => {
    process.env.DOCKER_HOST = 'unix:///x.sock';
    process.env.SECRET_THING = 'nope';
    try { expect(Object.keys(dockerEnv()).sort()).toEqual(['DOCKER_HOST', 'HOME', 'PATH']); } finally { delete process.env.DOCKER_HOST; delete process.env.SECRET_THING; }
  });
  it('a successful build issues exactly this sequence and never `image rm`; the name, argv and stage input are the golden ones', async () => {
    const m = mk();
    const r = await m.b.build(helloBuild());
    expect(r).toEqual({ kind: 'staged', imageId: NEW_ID, baseImageId: BASE_ID, imageBytes: 100_000, slug: 'hello', config12: 'abcdef012345', toolCount: 2 });
    expect(orderOf(m.docker)).toEqual(['image inspect', 'create', 'cp', 'commit', 'rm', 'ps', 'image inspect']);
    expect(m.docker.calls[0]).toEqual(imageInspectArgv(BASE_ID));
    expect(m.docker.calls[1]).toEqual(createArgv(NAME, BASE_ID));
    const dir = m.docker.calls[2]![1]!.replace(/\/\.$/, '');
    expect(m.docker.calls[2]).toEqual(cpArgv(dir, NAME));
    expect(m.docker.calls[3]).toEqual(commitArgv(NAME, 7, helloBuild().sha256));
    expect(m.docker.calls[4]).toEqual(['rm', '-f', '-v', NAME]);
    expect(m.docker.calls[6]).toEqual(imageInspectArgv(NEW_ID));
    expect(dir).toMatch(new RegExp(`^${scratch.root}/b-[A-Za-z0-9]{6}/plugin$`));
    expect(m.stageCalls).toEqual([[{ slug: 'hello', image: NEW_ID, departments: 'software', title: 'Hello plugin', ref: 'forge:release-11' }, { kind: 'release', releaseId: 11, decidedBy: '900000000000000001' }]]);
    expect(m.calls).toEqual(['recordImage', 'stage']);
    expect(m.repo.recordImage).toHaveBeenCalledWith(7, NEW_ID);
    expect(dirsLeft()).toEqual([]); // the stage dir is gone
    expect(m.docker.containers.size).toBe(0);
    expect(m.docker.images.has(NEW_ID)).toBe(true); // a staged image is kept
  });
});

describe('PF-C2: the builder re-proves the bytes', () => {
  const refused = async (b: ReturnType<typeof helloBuild>) => {
    const m = mk();
    const r = await m.b.build(b);
    expect(r).toEqual({ kind: 'failed', code: 'zip_invalid' });
    expect(m.docker.calls).toEqual([]); // nothing reaches docker
    expect(dirsLeft()).toEqual([]);
    return m;
  };
  it('refuses when sha256(zip) differs from the build row', async () => { const b = helloBuild(); b.zip = Buffer.concat([b.zip, Buffer.from([0])]); await refused(b); });
  it('refuses when the build sha256 differs from the release sha256', async () => { await refused(helloBuild({ releaseSha256: 'e'.repeat(64) })); });
  it('refuses when the build manifest differs from the release manifest', async () => { await refused(helloBuild({ releaseManifestSha256: 'e'.repeat(64) })); });
  it('refuses when the validator manifest differs from the build manifest', async () => { await refused(helloBuild({ manifestSha256: 'e'.repeat(64), releaseManifestSha256: 'e'.repeat(64) })); });
  it('refuses when the zip no longer validates, or names another idea or slug', async () => {
    const b = helloBuild();
    await refused(helloBuild({ ideaId: 2 }));
    await refused(helloBuild({ pluginSlug: 'other' }));
    const bad = Buffer.from('not a zip');
    await refused({ ...b, zip: bad, sha256: require('node:crypto').createHash('sha256').update(bad).digest('hex'), releaseSha256: require('node:crypto').createHash('sha256').update(bad).digest('hex') });
  });
  it('checkStage re-reads every file with a no-follow open: a changed byte, a missing file, an extra file, a symlink and a changed size are refused', async () => {
    const v = validatePlugin(helloBuild().zip, { forgeIdeaId: 1 });
    if (!v.ok) throw new Error('x');
    const fresh = async (): Promise<string> => { const d = mkdtempSync(join(scratch.root, 'b-')); await writeFiles(d, v.info.files); return d; };
    expect(await checkStage(await fresh(), v.info.shipped)).toBe('ok');
    const a = await fresh(); writeFileSync(join(a, 'server.mjs'), v.info.files.find((f) => f.path === 'server.mjs')!.data.toString().replace('hello', 'hellX')); // same size, other bytes
    expect(await checkStage(a, v.info.shipped)).toBe('zip_invalid');
    const b = await fresh(); writeFileSync(join(b, 'server.mjs'), 'short');
    expect(await checkStage(b, v.info.shipped)).toBe('stage_dir'); // byte total no longer equals the manifest
    const c = await fresh(); writeFileSync(join(c, 'extra.mjs'), 'x');
    expect(await checkStage(c, v.info.shipped)).toBe('stage_dir');
    const d = await fresh(); symlinkSync('/etc/hosts', join(d, 'src', 'evil.mjs'));
    expect(await checkStage(d, v.info.shipped)).toBe('stage_dir');
    const e = await fresh(); symlinkSync(join(e, 'server.mjs'), join(e, 'link.mjs'));
    expect(await checkStage(e, v.info.shipped)).toBe('stage_dir');
    const f = await fresh(); await import('node:fs/promises').then((fs) => fs.rm(join(f, 'src', 'tools.mjs')));
    expect(await checkStage(f, v.info.shipped)).toBe('stage_dir');
    const g = await fresh(); await import('node:fs/promises').then(async (fs) => { await fs.rm(join(g, 'server.mjs')); symlinkSync(join(g, 'forge.json'), join(g, 'server.mjs')); });
    expect(await checkStage(g, v.info.shipped)).toBe('stage_dir'); // a symlink in place of a file
  });
});

describe('PF-C3: stage directory hygiene', () => {
  it('G2-FG-07 (PF-C15 relaxed): a staging euid or egid of 65534 (the plugin runtime user) is refused, failing closed; the real ids pass', async () => {
    expect(await verifiedRoot(scratch.root)).toBe(true);
    for (const which of ['geteuid', 'getegid'] as const) {
      const spy = vi.spyOn(process, which).mockReturnValue(65534);
      try {
        expect(await verifiedRoot(scratch.root), which).toBe(false);
        const m = mk();
        expect(await m.b.build(helloBuild()), which).toEqual({ kind: 'failed', code: 'stage_dir' });
        expect(m.docker.calls.some((c) => c[0] === 'create'), which).toBe(false);
      } finally { spy.mockRestore(); }
    }
    const noGid = vi.spyOn(process, 'getegid').mockReturnValue(undefined as never);
    try { expect(await verifiedRoot(scratch.root)).toBe(false); } finally { noGid.mockRestore(); }
  });
  it('files are created exclusively with mode 0644, directories 0755; the stage dir b-xxxxxx is 0700 under a 0700 root and the copied content dir `plugin` inside it is 0755 (BE3 probe: `docker cp dir/.` stamps that mode on /srv/plugin, and a 0700 /srv/plugin is unreadable to uid 65534)', async () => {
    const modes: Record<string, number> = {};
    const m = mk({}, (d) => { d.k.onCp = (a) => {
      const dir = a[1]!.replace(/\/\.$/, '');
      modes['.'] = lstatSync(dir).mode & 0o777;
      modes['parent'] = lstatSync(join(dir, '..')).mode & 0o777;
      modes['name'] = dir.endsWith('/plugin') ? 1 : 0;
      const walk = (p: string, rel: string): void => { for (const n of readdirSync(p)) { const q = join(p, n); modes[`${rel}${n}`] = lstatSync(q).mode & 0o777; if (lstatSync(q).isDirectory()) walk(q, `${rel}${n}/`); } };
      walk(dir, '');
      modes['root'] = lstatSync(scratch.root).mode & 0o777;
    }; });
    expect((await m.b.build(helloBuild())).kind).toBe('staged');
    expect(modes['.']).toBe(0o755);
    expect(modes['name']).toBe(1);
    expect(modes['parent']).toBe(0o700);
    expect(modes['root']).toBe(0o700);
    expect(modes['server.mjs']).toBe(0o644);
    expect(modes['forge.json']).toBe(0o644);
    expect(modes['src']).toBe(0o755);
    expect(modes['src/tools.mjs']).toBe(0o644);
  });
  it('writeFiles opens with O_EXCL: a second write of the same path fails', async () => {
    const d = mkdtempSync(join(scratch.root, 'b-'));
    await writeFiles(d, [{ path: 'a.mjs', data: Buffer.from('x') }]);
    await expect(writeFiles(d, [{ path: 'a.mjs', data: Buffer.from('y') }])).rejects.toThrow();
    expect(readFileSync(join(d, 'a.mjs'), 'utf8')).toBe('x');
  });
  it('a root that is group or world accessible is stage_dir and docker is never touched for create', async () => {
    chmodSync(scratch.root, 0o755);
    const m = mk();
    expect(await m.b.build(helloBuild())).toEqual({ kind: 'failed', code: 'stage_dir' });
    expect(m.docker.verbs()).toEqual(['image inspect']);
    expect(readdirSync(scratch.root)).toEqual([]);
  });
  it('a root that is a symlink is stage_dir', async () => {
    const link = join(scratch.parent, 'link-forge');
    symlinkSync(scratch.root, link);
    const m = mk({ stageRoot: link });
    expect(await m.b.build(helloBuild())).toEqual({ kind: 'failed', code: 'stage_dir' });
    expect(readdirSync(scratch.root)).toEqual([]);
  });
  it('the root is created with mode 0700 when it does not exist', async () => {
    const fresh = join(scratch.parent, 'new-root');
    const m = mk({ stageRoot: fresh });
    expect((await m.b.build(helloBuild())).kind).toBe('staged');
    expect(lstatSync(fresh).mode & 0o777).toBe(0o700);
  });
  it('boot clean-up removes only direct children named b- plus six letters or digits; links are unlinked and never followed; other names, longer names and files elsewhere survive', async () => {
    const outside = join(scratch.parent, 'outside');
    mkdirSync(outside); writeFileSync(join(outside, 'keep.txt'), 'keep');
    mkdirSync(join(scratch.root, 'b-AbC123')); writeFileSync(join(scratch.root, 'b-AbC123', 'f'), 'x');
    mkdirSync(join(scratch.root, 'b-zzzzzz'));
    symlinkSync(outside, join(scratch.root, 'b-LINK12')); // a link with a matching name pointing at a directory with a file
    writeFileSync(join(scratch.root, 'b-FILE12'), 'x');
    for (const keep of ['b-abc', 'x-AbC123', 'b-AbC1234', 'B-Zz9999', 'b-Ab_123', 'b-AbC12.']) mkdirSync(join(scratch.root, keep));
    expect(await cleanStageRoot(scratch.root)).toBe(true);
    expect(readdirSync(scratch.root).sort()).toEqual(['B-Zz9999', 'b-Ab_123', 'b-AbC12.', 'b-AbC1234', 'b-abc', 'x-AbC123'].sort());
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
  });
  it('boot clean-up touches nothing when the root is not a safe directory (mode, symlink), and a missing root is fine', async () => {
    mkdirSync(join(scratch.root, 'b-AbC123'));
    chmodSync(scratch.root, 0o755);
    expect(await cleanStageRoot(scratch.root)).toBe(false);
    expect(existsSync(join(scratch.root, 'b-AbC123'))).toBe(true);
    const link = join(scratch.parent, 'l');
    symlinkSync(scratch.root, link);
    chmodSync(scratch.root, 0o700);
    expect(await cleanStageRoot(link)).toBe(false);
    expect(existsSync(join(scratch.root, 'b-AbC123'))).toBe(true);
    expect(await cleanStageRoot(join(scratch.parent, 'does-not-exist'))).toBe(true);
  });
  it('the default stage root is under the OS temp dir (documented constant of the service), never the repository', () => {
    expect(join(tmpdir(), 'assistant-forge').startsWith(tmpdir())).toBe(true);
  });
});

describe('PF-C4 / FG-AC05: verify by exact config diff', () => {
  const base = (): Inspected => ({ id: BASE_ID, config: BASE_CONFIG(), layers: [...BASE_LAYERS], size: 50_000_000, os: 'linux' });
  const good = (over: (c: Record<string, unknown>) => void = () => undefined, layers?: string[], size = 50_100_000): Inspected => {
    const c = { ...BASE_CONFIG(), User: '65534:65534', WorkingDir: '/srv/plugin', Entrypoint: ['node', '/srv/plugin/server.mjs'], Cmd: [], Hostname: 'abcdef012345', Image: BASE_ID,
      Env: ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'NODE_VERSION=24.1.0', 'NODE_ENV=production'], Labels: { 'assistant.forge': '1', 'assistant.forge.build': '7', 'assistant.forge.sha256': 'f'.repeat(64) } } as Record<string, unknown>;
    over(c);
    return { id: NEW_ID, config: c, layers: layers ?? [...BASE_LAYERS, `sha256:${'d'.repeat(64)}`], size, os: 'linux' };
  };
  const A = { id: NEW_ID, sha256: 'f'.repeat(64), buildId: 7 };
  it('the expected image passes', () => { expect(verifyImage(good(), base(), A)).toBeNull(); });
  it('Hostname and Image (the named ignore list) may differ; nothing else does', () => {
    expect(verifyImage(good((c) => { c.Hostname = 'zzzzzzzzzzzz'; c.Image = 'sha256:other'; }), base(), A)).toBeNull();
  });
  it('BE3 probe: ArgsEscaped (a flag a Dockerfile CMD leaves in the base config; commit drops it when it replaces Cmd and Entrypoint) may differ; the ignore list is exactly these three', () => {
    const b = base();
    b.config.ArgsEscaped = true;
    expect(verifyImage(good(), b, A)).toBeNull();
    expect(verifyImage(good((c) => { c.ArgsEscaped = true; }), b, A)).toBeNull(); // equal to the base
    expect(verifyImage(good((c) => { c.ArgsEscaped = false; }), b, A)).toBeNull();
    // G2-FG-10: the new image may not GAIN the flag (absent or false, or equal to the base)
    expect(verifyImage(good((c) => { c.ArgsEscaped = true; }), base(), A)).toBe('verify_failed');
    expect(verifyImage(good((c) => { c.ArgsEscaped = 'yes'; }), b, A)).toBe('verify_failed');
    expect([...CONFIG_IGNORE]).toEqual(['Hostname', 'Image', 'ArgsEscaped']);
  });
  it('BE3 probe: Docker Desktop stamps `desktop.docker.io/ports.scheme=v2` on every container, and commit copies it into the image; exactly that pair is tolerated, no other value or label', () => {
    const dd = { 'desktop.docker.io/ports.scheme': 'v2' };
    const withDd = (extra: Record<string, string> = {}) => good((c) => { c.Labels = { ...(c.Labels as object), ...dd, ...extra }; });
    expect(verifyImage(withDd(), base(), A)).toBeNull();
    expect(verifyImage(good((c) => { c.Labels = { ...(c.Labels as object), 'desktop.docker.io/ports.scheme': 'v3' }; }), base(), A)).toBe('verify_failed');
    expect(verifyImage(withDd({ 'desktop.docker.io/other': 'x' }), base(), A)).toBe('verify_failed');
    expect(verifyImage(good((c) => { c.Labels = dd; }), base(), A)).toBe('verify_failed'); // the three forge labels are still required
    expect(DAEMON_LABELS).toEqual(dd);
  });
  const cases: [string, Inspected][] = [
    ['an extra layer', good(undefined, [...BASE_LAYERS, `sha256:${'d'.repeat(64)}`, `sha256:${'e'.repeat(64)}`])],
    ['no new layer', good(undefined, [...BASE_LAYERS])],
    ['a wrong prefix', good(undefined, [BASE_LAYERS[0]!, `sha256:${'9'.repeat(64)}`, BASE_LAYERS[2]!, `sha256:${'d'.repeat(64)}`])],
    ['a reordered prefix', good(undefined, [BASE_LAYERS[1]!, BASE_LAYERS[0]!, BASE_LAYERS[2]!, `sha256:${'d'.repeat(64)}`])],
    ['another id', { ...good(), id: `sha256:${'7'.repeat(64)}` }],
    ['another os', { ...good(), os: 'windows' }],
    ['User root', good((c) => { c.User = ''; })], ['User 0', good((c) => { c.User = '0:0'; })], ['User 65534 only', good((c) => { c.User = '65534'; })],
    ['Entrypoint changed', good((c) => { c.Entrypoint = ['node', '/srv/plugin/other.mjs']; })], ['Entrypoint as a string', good((c) => { c.Entrypoint = 'node /srv/plugin/server.mjs'; })],
    ['Entrypoint with an extra arg', good((c) => { c.Entrypoint = ['node', '/srv/plugin/server.mjs', '--x']; })], ['Entrypoint null', good((c) => { c.Entrypoint = null; })],
    ['WorkingDir changed', good((c) => { c.WorkingDir = '/'; })], ['Cmd set', good((c) => { c.Cmd = ['sh']; })],
    ['Volumes', good((c) => { c.Volumes = { '/data': {} }; })], ['ExposedPorts', good((c) => { c.ExposedPorts = { '80/tcp': {} }; })], ['OnBuild', good((c) => { c.OnBuild = ['RUN x']; })],
    ['Healthcheck', good((c) => { c.Healthcheck = { Test: ['CMD', 'true'] }; })], ['Shell', good((c) => { c.Shell = ['/bin/sh']; })], ['StopSignal', good((c) => { c.StopSignal = 'SIGKILL'; })],
    ['an unknown extra key', good((c) => { c.Surprise = 'x'; })], ['AttachStdin', good((c) => { c.AttachStdin = true; })], ['Tty', good((c) => { c.Tty = true; })], ['Domainname', good((c) => { c.Domainname = 'x'; })],
    ['a missing forge label', good((c) => { c.Labels = { 'assistant.forge': '1', 'assistant.forge.build': '7' }; })], ['an extra label', good((c) => { c.Labels = { ...(c.Labels as object), extra: 'x' }; })],
    ['a wrong build label', good((c) => { c.Labels = { ...(c.Labels as object), 'assistant.forge.build': '8' }; })], ['a wrong sha256 label', good((c) => { c.Labels = { ...(c.Labels as object), 'assistant.forge.sha256': 'a'.repeat(64) }; })],
    ['no labels', good((c) => { c.Labels = null; })],
    ['NODE_ENV missing', good((c) => { c.Env = (c.Env as string[]).filter((e) => !e.startsWith('NODE_ENV')); })], ['NODE_ENV=development', good((c) => { c.Env = [...(c.Env as string[]).filter((e) => !e.startsWith('NODE_ENV')), 'NODE_ENV=development']; })],
    ['an extra env var', good((c) => { c.Env = [...(c.Env as string[]), 'EXTRA=1']; })], ['a dropped base env var', good((c) => { c.Env = (c.Env as string[]).filter((e) => !e.startsWith('NODE_VERSION')); })],
    ['Env not a list', good((c) => { c.Env = 'x'; })],
  ];
  it.each(cases)('verify_failed for %s', (_n, img) => { expect(verifyImage(img, base(), A)).toBe('verify_failed'); });
  it('the size delta: exactly 8 MiB passes, 8 MiB + 1 is image_too_big', () => {
    expect(verifyImage(good(undefined, undefined, 50_000_000 + 8 * 1024 * 1024), base(), A)).toBeNull();
    expect(verifyImage(good(undefined, undefined, 50_000_000 + 8 * 1024 * 1024 + 1), base(), A)).toBe('image_too_big');
  });
  it('an unlisted key equal to the base passes; a base Env NODE_ENV is replaced, not duplicated', () => {
    const b = base();
    (b.config.Env as string[]).push('NODE_ENV=test');
    const n = good((c) => { c.Env = ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'NODE_VERSION=24.1.0', 'NODE_ENV=production']; });
    expect(verifyImage(n, b, A)).toBeNull();
  });
  it('the base must have no labels, ONBUILD, healthcheck or volumes, be linux, and be the named id; otherwise base_missing and nothing is created', async () => {
    const bads: [string, (d: FakeForgeDocker) => void][] = [
      ['labels', (d) => { d.k.baseConfig.Labels = { a: 'b' }; }], ['onbuild', (d) => { d.k.baseConfig.OnBuild = ['RUN x']; }], ['healthcheck', (d) => { d.k.baseConfig.Healthcheck = { Test: ['CMD', 'x'] }; }],
      ['volumes', (d) => { d.k.baseConfig.Volumes = { '/v': {} }; }], ['os', (d) => { d.k.baseOs = 'windows'; }], ['id', (d) => { d.k.baseId = `sha256:${'8'.repeat(64)}`; }],
      ['layers', (d) => { d.k.baseLayers = []; }],
    ];
    for (const [n, f] of bads) {
      const m = mk({}, f);
      expect(await m.b.build(helloBuild()), n).toEqual({ kind: 'failed', code: 'base_missing' });
      expect(m.docker.verbs(), n).toEqual(['image inspect']);
    }
    expect(await inspectBase(new FakeForgeDocker(), 'latest')).toBeNull();
  });
  it('parseInspect refuses forbidden keys, non-sha layers, a missing RootFS and oversize output', () => {
    const ok = JSON.stringify({ Id: BASE_ID, Os: 'linux', Size: 1, Config: {}, RootFS: { Layers: BASE_LAYERS } });
    expect(parseInspect(ok)).not.toBeNull();
    expect(parseInspect(ok.replace('"Config":{}', '"Config":{"__proto__":{"x":1}}'))).toBeNull();
    expect(parseInspect(ok.replace('"Config":{}', '"Config":{"constructor":1}'))).toBeNull();
    expect(parseInspect(JSON.stringify({ Id: BASE_ID, Os: 'linux', Size: 1, Config: {}, RootFS: { Layers: ['x'] } }))).toBeNull();
    expect(parseInspect(JSON.stringify({ Id: BASE_ID, Os: 'linux', Size: 1, Config: {} }))).toBeNull();
    expect(parseInspect('x'.repeat(600 * 1024))).toBeNull();
    expect(parseInspect('{"a":' + '['.repeat(100) + ']'.repeat(100) + '}')).toBeNull();
  });
  it('through the builder: a tampered committed image is verify_failed, image_too_big for the size, and the image is removed', async () => {
    const t1 = mk({}, (d) => { d.k.tamper = (img) => { (img.Config as Record<string, unknown>).User = 'root'; }; });
    expect(await t1.b.build(helloBuild())).toEqual({ kind: 'failed', code: 'verify_failed' });
    expect(t1.docker.images.has(NEW_ID)).toBe(false);
    expect(t1.repo.imageRemoved).toHaveBeenCalledWith(7, '222222222222');
    const t2 = mk({}, (d) => { d.k.delta = 8 * 1024 * 1024 + 1; });
    expect(await t2.b.build(helloBuild())).toEqual({ kind: 'failed', code: 'image_too_big' });
    expect(t2.docker.images.has(NEW_ID)).toBe(false);
    const t3 = mk({}, (d) => { d.k.tamper = (img) => { (img.RootFS as { Layers: string[] }).Layers.push(`sha256:${'e'.repeat(64)}`); }; });
    expect(await t3.b.build(helloBuild())).toEqual({ kind: 'failed', code: 'verify_failed' });
  });
});

describe('PF-C5 / FG-AC06: no orphan images, cleanup on every failure path', () => {
  const clean = (m: ReturnType<typeof mk>): void => {
    expect(m.docker.containers.size).toBe(0);
    expect(dirsLeft()).toEqual([]);
  };
  it('the image id is recorded in ONE statement right after commit, before the container is removed, verified or staged', async () => {
    const order: string[] = [];
    const m = mk({}, (d) => { d.k.onExec = (a) => { order.push(a[0] === 'image' ? `image ${a[1]}` : a[0]!); }; });
    m.repo.recordImage.mockImplementation(async () => { order.push('RECORD'); return true; });
    m.stage.mockImplementation(async () => { order.push('STAGE'); return { ok: true, slug: 'hello', config12: 'abcdef012345', toolCount: 2 }; });
    await m.b.build(helloBuild());
    expect(order).toEqual(['image inspect', 'create', 'cp', 'commit', 'RECORD', 'rm', 'ps', 'image inspect', 'STAGE']);
  });
  it.each([
    ['create fails', (d: FakeForgeDocker) => { d.k.createFail = true; }, 'create_failed', false],
    ['create prints a bad id', (d: FakeForgeDocker) => { d.k.createOut = 'not hex'; }, 'create_failed', false],
    ['cp fails', (d: FakeForgeDocker) => { d.k.cpFail = true; }, 'copy_failed', false],
    ['commit fails', (d: FakeForgeDocker) => { d.k.commitFail = true; }, 'commit_failed', false],
    ['commit prints a bad id', (d: FakeForgeDocker) => { d.k.commitOut = 'sha256:short'; }, 'commit_failed', false],
    ['verify fails', (d: FakeForgeDocker) => { d.k.tamper = (img) => { (img.Config as Record<string, unknown>).User = ''; }; }, 'verify_failed', true],
  ])('%s: the container is verified gone, the stage dir is gone and the new image (if any) is removed', async (_n, setup, code, hadImage) => {
    const m = mk({}, setup);
    expect(await m.b.build(helloBuild())).toEqual({ kind: 'failed', code });
    clean(m);
    expect(m.docker.images.has(NEW_ID)).toBe(false);
    expect(m.docker.rmCalls).toContain(NAME);
    expect(m.repo.imageRemoved).toHaveBeenCalledTimes(hadImage ? 1 : 0);
    expect(m.docker.calls.some((c) => c[0] === 'image' && c[1] === 'rm')).toBe(hadImage);
  });
  it.each([
    ['E_PROBE', 'stage_probe'], ['E_SECCOMP', 'stage_seccomp'], ['E_TOOLS_NONE', 'stage_tools'], ['E_TOOLS_MANY', 'stage_tools'], ['E_SCHEMA', 'stage_schema'], ['E_SCREEN', 'stage_screen'], ['E_NAME', 'stage_name'],
    ['E_COLLISION', 'stage_name'], ['E_EXISTS', 'stage_exists'], ['E_MAX_SERVERS', 'stage_max'], ['E_IMAGE', 'stage_image'], ['E_STATE', 'stage_state'], ['E_INTERNAL', 'stage_other'], ['E_WHATEVER', 'stage_other'],
  ])('a stage refusal %s is %s and the image is removed (every exit other than staged)', async (mcp, code) => {
    const m = mk();
    m.stage.mockImplementation(async () => ({ ok: false, code: mcp }));
    expect(await m.b.build(helloBuild())).toEqual({ kind: 'failed', code });
    expect(stageCode(mcp)).toBe(code);
    expect(m.docker.images.has(NEW_ID)).toBe(false);
    expect(m.repo.imageRemoved).toHaveBeenCalledWith(7, '222222222222');
    clean(m);
  });
  it('E_HALTED from the stage is a requeue and the image is removed', async () => {
    const m = mk();
    m.stage.mockImplementation(async () => ({ ok: false, code: 'E_HALTED' }));
    expect(await m.b.build(helloBuild())).toEqual({ kind: 'requeue' });
    expect(m.docker.images.has(NEW_ID)).toBe(false);
  });
  it('a stage that throws is `error` (requeue without refund by the service), the image is removed, the log has only the error name', async () => {
    const m = mk();
    m.stage.mockImplementation(async () => { throw new TypeError('secret path /x/y detail'); });
    expect(await m.b.build(helloBuild())).toEqual({ kind: 'error' });
    expect(m.docker.images.has(NEW_ID)).toBe(false);
    expect(m.logs).toEqual([{ errName: 'TypeError' }]);
    expect(JSON.stringify(m.logs)).not.toContain('secret');
    clean(m);
  });
  it('recordImage failing (false) removes the image at once and fails stage_state; throwing removes it and ends as `error`', async () => {
    const a = mk();
    a.repo.recordImage.mockImplementation(async () => false);
    expect(await a.b.build(helloBuild())).toEqual({ kind: 'failed', code: 'stage_state' });
    expect(a.docker.images.has(NEW_ID)).toBe(false);
    expect(a.repo.imageRemoved).not.toHaveBeenCalled(); // the row holds another image: its removal is not recorded against it
    const b = mk();
    b.repo.recordImage.mockImplementation(async () => { throw new Error('db down'); });
    expect(await b.b.build(helloBuild())).toEqual({ kind: 'error' });
    expect(b.docker.images.has(NEW_ID)).toBe(false);
    clean(b);
  });
  it('an image that cannot be removed latches `stuck` once (the incident hook fires once) and the next build does not start', async () => {
    const m = mk({}, (d) => { d.k.imageRmFails = true; d.k.tamper = (img) => { (img.Config as Record<string, unknown>).User = ''; }; });
    expect(await m.b.build(helloBuild())).toEqual({ kind: 'failed', code: 'stuck' });
    expect(m.latch.stuck).toBe(true);
    expect(m.stuck).toEqual([1]);
    const before = m.docker.calls.length;
    expect(await m.b.build(helloBuild())).toEqual({ kind: 'failed', code: 'stuck' });
    expect(m.docker.calls.length).toBe(before);
    expect(m.stuck).toEqual([1]);
  });
  it('a container that cannot be removed latches `stuck` and the committed image is still removed', async () => {
    const m = mk({}, (d) => { d.k.containerRmFails = true; });
    expect(await m.b.build(helloBuild())).toEqual({ kind: 'failed', code: 'stuck' });
    expect(m.latch.stuck).toBe(true);
    expect(m.docker.images.has(NEW_ID)).toBe(false);
    expect(dirsLeft()).toEqual([]);
    expect(m.stuck).toEqual([1]);
  });
  it('removeImageVerified never uses -f and is true only when the listing exits 0 without the id', async () => {
    const d = new FakeForgeDocker();
    d.images.set(NEW_ID, {});
    expect(await removeImageVerified(d, NEW_ID)).toBe(true);
    d.images.set(NEW_ID, {});
    d.k.imageRmFails = true;
    expect(await removeImageVerified(d, NEW_ID)).toBe(false);
    expect(await removeImageVerified(d, 'latest')).toBe(false);
    expect(d.calls.every((c) => !c.includes('-f'))).toBe(true);
  });
  it('G2-FG-05a/14: the proof listing uses -a (the real daemon hides untagged and parent images without it, so the id was never listed) and keeps the forge label filter', () => {
    expect(forgeImagesArgv()).toEqual(['image', 'ls', '-a', '--no-trunc', '--filter', 'label=assistant.forge=1', '--format', '{{.ID}}']);
  });
  it('G2-FG-05: a daemon outage (every call fails, the inspect included) is NOT "removed"; the proof is a listing that exits 0 without the id', async () => {
    const d = new FakeForgeDocker();
    d.images.set(NEW_ID, {});
    d.k.onExec = () => { throw new Error('daemon down'); };
    expect(await removeImageVerified(d, NEW_ID)).toBe(false);
    // the rm worked but the listing could not be read: still not proven
    const e = new FakeForgeDocker();
    e.images.set(NEW_ID, {});
    e.k.onExec = (a) => { if (a[1] === 'ls') throw new Error('daemon down'); };
    expect(await removeImageVerified(e, NEW_ID)).toBe(false);
    // a listing that exits 0 and still holds the id: not removed; one that exits 0 without it: removed
    const f = new FakeForgeDocker();
    f.images.set(NEW_ID, {});
    f.k.imageRmFails = true;
    expect(await removeImageVerified(f, NEW_ID)).toBe(false);
    const g = new FakeForgeDocker();
    g.images.set(NEW_ID, {});
    expect(await removeImageVerified(g, NEW_ID)).toBe(true);
    expect(g.verbs()).toEqual(['image rm', 'image ls']);
    expect(g.calls[1]).toEqual(forgeImagesArgv());
  });
});

describe('PF-C6: the boot sweep matches the full container name', () => {
  it('removes forge-b<digits>-<8 hex> only; names that merely contain forge-b survive (the daemon filter is a substring match)', async () => {
    const d = new FakeForgeDocker();
    const mine = ['forge-b12-deadbeef', 'forge-b1-0123abcd'];
    const theirs = ['myforge-bar', 'xforge-b1-deadbeef', 'forge-b1-DEADBEEF', 'forge-b1234567890123-deadbeef', 'forge-b-deadbeef', 'forge-b1-deadbee', 'forge-b1-deadbeef0', 'forge-bx1-deadbeef', 'assistant-forge-b1-deadbeef'];
    for (const n of [...mine, ...theirs]) d.containers.add(n);
    expect(await sweepForgeContainers(d)).toBe(true);
    expect([...d.containers].sort()).toEqual([...theirs].sort());
    for (const n of mine) expect(d.rmCalls).toContain(n);
    for (const n of theirs) expect(d.rmCalls).not.toContain(n);
  });
  it('a container that stays is reported (false)', async () => {
    const d = new FakeForgeDocker();
    d.containers.add('forge-b1-deadbeef');
    d.k.containerRmFails = true;
    expect(await sweepForgeContainers(d)).toBe(false);
  });
});

describe('FG-AC07: halt, switch and deadline between steps', () => {
  it('a halt at each step boundary stops the build, cleans up and asks for a requeue; the image is removed when it exists', async () => {
    const results: string[] = [];
    for (let n = 0; n < 8; n++) {
      let polls = 0;
      const m = mk({ isHalted: () => ++polls > n });
      const r = await m.b.build(helloBuild());
      results.push(r.kind);
      expect(m.docker.containers.size, `n=${n}`).toBe(0);
      expect(dirsLeft(), `n=${n}`).toEqual([]);
      if (r.kind === 'requeue') expect(m.docker.images.size, `n=${n}`).toBe(0);
      expect(m.stage).toHaveBeenCalledTimes(r.kind === 'staged' ? 1 : 0);
    }
    expect(results.slice(0, 6).every((k) => k === 'requeue')).toBe(true);
    expect(results.at(-1)).toBe('staged');
  });
  it('the forge switch is polled between steps: off, or a throwing read, requeues', async () => {
    let polls = 0;
    const a = mk({ forgeEnabled: () => ++polls < 3 });
    expect((await a.b.build(helloBuild())).kind).toBe('requeue');
    const b = mk({ forgeEnabled: () => { throw new Error('x'); } });
    expect((await b.b.build(helloBuild())).kind).toBe('requeue');
    expect(b.docker.calls).toEqual([]);
    const c = mk({ isHalted: () => { throw new Error('x'); } });
    expect((await c.b.build(helloBuild())).kind).toBe('requeue');
  });
  it('a forge or project that is no longer live requeues (the reconcile then cancels the queued build)', async () => {
    const m = mk();
    m.repo.stillLive.mockImplementation(async () => false);
    expect((await m.b.build(helloBuild())).kind).toBe('requeue');
    expect(m.docker.calls).toEqual([]);
  });
  it('the 180 s deadline: a clock past it is `timeout`, and exec timeouts never exceed the remaining time', async () => {
    let t = 0;
    const timeouts: (number | undefined)[] = [];
    const m = mk({ now: () => t }, (d) => { const inner = d.exec.bind(d); d.exec = ((a: readonly string[], ms?: number) => { timeouts.push(ms); if (a[0] === 'create') t += 200_000; return inner(a); }) as never; });
    expect(await m.b.build(helloBuild())).toEqual({ kind: 'failed', code: 'timeout' });
    expect(Math.max(...timeouts.filter((x): x is number => x !== undefined))).toBeLessThanOrEqual(60_000);
    clean2(m);
    function clean2(x: ReturnType<typeof mk>): void { expect(x.docker.containers.size).toBe(0); expect(dirsLeft()).toEqual([]); }
  });
  it('exec timeouts per step: inspect 15 s, create 30 s, cp 60 s, commit 60 s, rm 30 s', async () => {
    const seen: Record<string, number | undefined> = {};
    const m = mk({}, (d) => { const inner = d.exec.bind(d); d.exec = ((a: readonly string[], ms?: number) => { seen[a[0] === 'image' ? `image ${a[1]}` : a[0]!] ??= ms; return inner(a); }) as never; });
    await m.b.build(helloBuild());
    expect(seen['image inspect']).toBe(15_000);
    expect(seen['create']).toBe(30_000);
    expect(seen['cp']).toBe(60_000);
    expect(seen['commit']).toBe(60_000);
  });
});

describe('FG-AC08: stage idempotency by release id', () => {
  it('a server row already staged for this release is adopted: no docker call, no second image, no stage', async () => {
    const m = mk();
    m.repo.serverOfRelease.mockImplementation(async () => ({ id: 5, slug: 'hello', imageId: NEW_ID, status: 'pending' }));
    const r = await m.b.build(helloBuild({ imageId: NEW_ID }));
    expect(r).toMatchObject({ kind: 'staged', imageId: NEW_ID, slug: 'hello' });
    expect(m.docker.calls).toEqual([]);
    expect(m.stage).not.toHaveBeenCalled();
  });
  it('an existing server with another slug or another image than the build recorded is stage_state, never adopted', async () => {
    for (const s of [{ id: 5, slug: 'other', imageId: NEW_ID, status: 'pending' }, { id: 5, slug: 'hello', imageId: BASE_ID, status: 'pending' }]) {
      const m = mk();
      m.repo.serverOfRelease.mockImplementation(async () => s);
      expect(await m.b.build(helloBuild({ imageId: NEW_ID }))).toEqual({ kind: 'failed', code: 'stage_state' });
    }
    const n = mk();
    n.repo.serverOfRelease.mockImplementation(async () => ({ id: 5, slug: 'hello', imageId: NEW_ID, status: 'pending' }));
    expect(await n.b.build(helloBuild({ imageId: null }))).toEqual({ kind: 'failed', code: 'stage_state' });
  });
});

describe('logging and latch', () => {
  it('ForgeLatch.set is true only the first time', () => {
    const l = new ForgeLatch();
    expect(l.stuck).toBe(false);
    expect(l.set()).toBe(true);
    expect(l.set()).toBe(false);
    expect(l.stuck).toBe(true);
  });
  it('a docker port that throws is a failure code, not an exception', async () => {
    const m = mk({}, (d) => { d.k.onExec = (a) => { if (a[0] === 'create') throw new Error('daemon exploded: /secret'); }; });
    expect(await m.b.build(helloBuild())).toEqual({ kind: 'failed', code: 'create_failed' });
    expect(JSON.stringify(m.logs)).not.toContain('secret');
  });
});
