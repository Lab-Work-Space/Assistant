import { mkdirSync, mkdtempSync, openSync, ftruncateSync, closeSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemWorkspaceRepo } from '../db/repos/workspaces.mem.js';
import { WsError, type WsCode } from './errors.js';
import { ProjectFiles } from './files.js';
import { SlugLock } from './lock.js';
import { WsService, type RunDeps } from './service.js';
import { FakeDocker } from './test-helpers.js';

const IMAGE = `sha256:${'b'.repeat(64)}`;
const ROOT_ID = '11111111-2222-3333-4444-555555555555';
let base: string;
let root: string;
let repo: MemWorkspaceRepo;
let d: FakeDocker;
let halted: boolean;
let secrets: string[];
let svc: WsService;
let incidents: { report: ReturnType<typeof vi.fn> };
let caps: { tree: number; day: number };

const mk = (over: Partial<RunDeps> = {}) =>
  new WsService({
    repo, root, files: new ProjectFiles(root), lock: new SlugLock(),
    run: { docker: d, image: IMAGE, uid: 501, gid: 20, caps: () => caps, isHalted: () => halted, secrets: () => secrets, incidents: incidents as never, haltPollMs: 5, ...over },
  });
const pkgJson = (o: unknown) => writeFileSync(join(root, 'demo', 'package.json'), JSON.stringify(o));
const refused = async (p: Promise<unknown>, code: WsCode) => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e, code).toBeInstanceOf(WsError);
  expect((e as WsError).code).toBe(code);
};
const run = (command: string, slug = 'demo', rootId = ROOT_ID) => svc.run({ slug, command, rootId });

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ws-run-')));
  root = join(base, 'root');
  mkdirSync(root, { mode: 0o700 });
  repo = new MemWorkspaceRepo();
  d = new FakeDocker();
  halted = false;
  secrets = [];
  incidents = { report: vi.fn(() => '') };
  caps = { tree: 40, day: 200 };
  svc = mk();
  await svc.create('demo', 'Demo', 'head:software');
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('ws_run: outcomes', () => {
  it('npm install runs on ws_prepnet with the full argv, labels ws=1, removes the container, and updates bytes and nm_bytes', async () => {
    pkgJson({ name: 'x', version: '1.0.0' });
    d.plan = [{ out: 'added 1 package', before: () => { mkdirSync(join(root, 'demo', 'node_modules', 'is-number'), { recursive: true }); writeFileSync(join(root, 'demo', 'node_modules', 'is-number', 'i.js'), 'x'.repeat(1234)); } }];
    const r = await run('npm install is-number@7.0.0');
    expect(r).toMatchObject({ outcome: 'exit', exit: 0, verb: 'install', output: 'added 1 package' });
    const a = d.runs[0]!;
    expect(a[a.indexOf('--network') + 1]).toBe('ws_prepnet');
    expect(a).toContain('ws.slug=demo');
    expect(a.slice(-13)).toEqual(['/usr/local/bin/npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--registry', 'http://10.88.80.2:4873', '--userconfig', '/dev/null', '--globalconfig', '/nonexistent/npmrc', '--replace-registry-host=always', 'is-number@7.0.0']);
    expect(d.containers.size).toBe(0);
    const row = (await repo.get('demo'))!;
    expect(row.nmBytes).toBe(1234);
    expect(row.bytes).toBeGreaterThan(0);
  });

  it('npm test runs with network none; nm_bytes is measured after every run, not only install (WS-C8)', async () => {
    pkgJson({ scripts: { test: 'node --test' } });
    d.plan = [{ before: () => { mkdirSync(join(root, 'demo', 'node_modules'), { recursive: true }); writeFileSync(join(root, 'demo', 'node_modules', 'f'), 'y'.repeat(99)); } }];
    await run('npm test');
    expect(d.runs[0]![d.runs[0]!.indexOf('--network') + 1]).toBe('none');
    expect((await repo.get('demo'))!.nmBytes).toBe(99);
  });

  it('a non-zero exit is a result, not an error', async () => {
    d.plan = [{ out: 'FAIL', exit: 1, code: 1 }];
    pkgJson({ scripts: { test: 'x' } });
    expect(await run('npm test')).toMatchObject({ outcome: 'exit', exit: 1, output: 'FAIL' });
  });

  it('timeout -> outcome timeout, container removed', async () => {
    pkgJson({ scripts: { test: 'x' } });
    svc = mk({ timeoutMs: 40, clientGraceMs: 20 });
    d.plan = [{ hang: true }];
    expect(await run('npm test')).toMatchObject({ outcome: 'timeout', exit: 137 });
    expect(d.containers.size).toBe(0);
  });

  it('OOMKilled -> outcome oom with the exit status', async () => {
    pkgJson({ scripts: { test: 'x' } });
    d.plan = [{ oom: true, exit: 137, code: 137 }];
    expect(await run('npm test')).toMatchObject({ outcome: 'oom', exit: 137 });
  });

  it('exit 125, a zero StartedAt, or a spawn failure -> outcome start', async () => {
    pkgJson({ scripts: { test: 'x' } });
    d.plan = [{ code: 125, exit: 125 }, { startedAt: '0001-01-01T00:00:00Z', code: 1, exit: 1 }];
    expect(await run('npm test')).toMatchObject({ outcome: 'start', exit: 125 });
    expect(await run('npm test')).toMatchObject({ outcome: 'start' });
  });

  it('output: ANSI stripped, secret redacted, cut at 8000, secret list read at call time', async () => {
    pkgJson({ scripts: { test: 'x' } });
    secrets = [];
    secrets.push('SEEDED-SECRET-LITERAL-77');
    d.plan = [{ out: `\u001b[32mgreen\u001b[0m SEEDED-SECRET-LITERAL-77 ${'z'.repeat(9000)}` }];
    const r = await run('npm test');
    expect(r.outcome).toBe('exit');
    const out = (r as { output: string }).output;
    expect(out).not.toContain('SEEDED');
    expect(out).not.toContain('\u001b');
    expect(out).toHaveLength(8000);
  });
});

describe('ws_run: refusals before the claim', () => {
  it('a command outside the allowlist is E_CMD; no container, no claim', async () => {
    await refused(run('npm install https://x/y.tgz'), 'E_CMD');
    expect(d.runs).toHaveLength(0);
  });
  it('an unknown script is E_SCRIPT; a known one runs', async () => {
    pkgJson({ scripts: { build: 'x' } });
    await refused(run('npm run nope'), 'E_SCRIPT');
    await refused(run('npm run constructor'), 'E_SCRIPT');
    expect((await run('npm run build')).outcome).toBe('exit');
  });
  it('no package.json: npm run is E_SCRIPT, npm install still runs', async () => {
    await refused(run('npm run build'), 'E_SCRIPT');
    expect((await run('npm install a@1.0.0')).outcome).toBe('exit');
  });
  it.each(['.npmrc', '.NPMRC', '.NpmRc'])('%s at the workspace root is E_NPMRC', async (n) => {
    pkgJson({ scripts: { test: 'x' } });
    writeFileSync(join(root, 'demo', n), 'registry=http://evil');
    await refused(run('npm test'), 'E_NPMRC');
    await refused(run('npm ci'), 'E_NPMRC');
  });
  it('a symlink named .npmrc and a directory named .npmrc are E_NPMRC', async () => {
    symlinkSync('/etc/passwd', join(root, 'demo', '.npmrc'));
    await refused(run('npm ci'), 'E_NPMRC');
    rmSync(join(root, 'demo', '.npmrc'));
    mkdirSync(join(root, 'demo', '.npmrc'));
    await refused(run('npm ci'), 'E_NPMRC');
    rmSync(join(root, 'demo', '.npmrc'), { recursive: true });
    writeFileSync(join(root, 'demo', '.NPMRC'), 'registry=https://example.com/\n');
    await refused(run('npm ci'), 'E_NPMRC');
    expect(d.runs).toHaveLength(0);
  });
  it.each([
    ['dependencies', { a: 'git+https://x/y.git' }],
    ['devDependencies', { a: 'https://x/y.tgz' }],
    ['optionalDependencies', { a: 'file:../x' }],
    ['peerDependencies', { a: 'github:u/r' }],
    ['dependencies', { a: 'npm:other@1' }],
    ['dependencies', { a: 'user/repo' }],
    ['dependencies', { a: 'link:../x' }],
    ['dependencies', { a: 'workspace:*' }],
    ['dependencies', { a: 'gitlab:u/r' }],
    ['dependencies', { a: 'bitbucket:u/r' }],
    ['dependencies', { a: 'http://x/y' }],
    ['dependencies', { a: '..' }],
    ['dependencies', { a: 'x.tgz' }],
    ['devDependencies', { a: 'C:x' }],
    ['overrides', { a: '.' }],
    ['dependencies', { a: 5 }],
    ['overrides', { a: 'git+https://x/y.git' }],
    ['overrides', { a: { b: { c: 'https://x' } } }],
    ['overrides', { a: { '.': 'npm:x@1' } }],
  ])('%s with %j is E_SPEC', async (k, v) => {
    pkgJson({ [k]: v });
    await refused(run('npm ci'), 'E_SPEC');
    await refused(run('npm install a@1.0.0'), 'E_SPEC');
  });
  it('plain versions in every map pass; an invalid package.json is E_SPEC', async () => {
    pkgJson({ dependencies: { a: '^1.0.0', b: '>=1 <2', c: '~2.1.0', d: '*', e: 'latest', f: '1.x || 2.x' }, overrides: { a: '1.0.0', b: { c: '$a' } } });
    expect((await run('npm ci')).outcome).toBe('exit');
    writeFileSync(join(root, 'demo', 'package.json'), '{nope');
    await refused(run('npm ci'), 'E_SPEC');
  });
  it('node: a missing file, a directory or a symlink is refused; a regular file runs', async () => {
    await expect(run('node a.js')).rejects.toThrow(/no such file/);
    symlinkSync('/etc/hosts', join(root, 'demo', 'l.js'));
    await expect(run('node l.js')).rejects.toThrow();
    writeFileSync(join(root, 'demo', 'a.js'), '1');
    expect((await run('node a.js')).outcome).toBe('exit');
    expect(d.runs).toHaveLength(1);
  });
  it('tsc without node_modules/typescript is E_TSC; with it, the fixed node command', async () => {
    await refused(run('npx tsc'), 'E_TSC');
    mkdirSync(join(root, 'demo', 'node_modules', 'typescript', 'bin'), { recursive: true });
    writeFileSync(join(root, 'demo', 'node_modules', 'typescript', 'bin', 'tsc'), '1');
    await run('npx tsc --noEmit');
    expect(d.runs[0]!.slice(-3)).toEqual(['/usr/local/bin/node', '/work/node_modules/typescript/bin/tsc', '--noEmit']);
  });
  it('a stopped proxy or a non-internal network is E_PROXY for install verbs only', async () => {
    pkgJson({ scripts: { test: 'x' } });
    d.proxyUp = false;
    await refused(run('npm install a@1.0.0'), 'E_PROXY');
    await refused(run('npm ci'), 'E_PROXY');
    expect((await run('npm test')).outcome).toBe('exit');
    d.proxyUp = true;
    d.prepInternal = false;
    await refused(run('npm ci'), 'E_PROXY');
  });
  it('an archived workspace and an unknown workspace are refused', async () => {
    await refused(run('npm ci', 'nothere'), 'E_SLUG');
    await repo.archive('demo', '123');
    await refused(run('npm ci'), 'E_ARCHIVED');
  });
  it('3 000 files at depth 20 make the run E_QUOTA; 1.2 GiB in node_modules by a run makes the next run E_QUOTA (WS-C8)', async () => {
    pkgJson({ scripts: { test: 'x' } });
    d.plan = [{ before: () => { const nm = join(root, 'demo', 'node_modules'); mkdirSync(nm, { recursive: true }); const fd = openSync(join(nm, 'big'), 'w'); ftruncateSync(fd, Math.floor(1.2 * 1024 ** 3)); closeSync(fd); } }];
    expect((await run('npm test')).outcome).toBe('exit');
    expect((await repo.get('demo'))!.nmBytes).toBeGreaterThan(1024 ** 3);
    await refused(run('npm test'), 'E_QUOTA');
    expect(d.runs).toHaveLength(1);
    rmSync(join(root, 'demo', 'node_modules'), { recursive: true });
    const deep = join(root, 'demo', ...Array.from({ length: 20 }, (_, i) => `d${i}`));
    mkdirSync(deep, { recursive: true });
    for (let i = 0; i < 3000; i++) writeFileSync(join(deep, `f${i}`), '');
    await refused(run('npm test'), 'E_QUOTA');
  });
});

describe('ws_run: concurrency, caps, halt', () => {
  it('a second run in the same slug is E_BUSY (no waiting); a file operation during a run is E_BUSY too', async () => {
    pkgJson({ scripts: { test: 'x' } });
    d.plan = [{ hang: true }];
    const first = run('npm test');
    await vi.waitFor(() => expect(d.runs).toHaveLength(1));
    await refused(run('npm test'), 'E_BUSY');
    await expect(svc.write('demo', 'a.txt', 'x')).rejects.toMatchObject({ code: 'E_BUSY' });
    await expect(svc.export('demo', [])).rejects.toMatchObject({ code: 'E_BUSY' });
    await svc.killAll();
    await first;
  });

  it('three concurrent runs in three slugs give exactly two spawns; the third is E_GLOBAL before the claim (WS-C11)', async () => {
    for (const s of ['aa', 'bb', 'cc']) {
      await svc.create(s, s, 'head:software');
      writeFileSync(join(root, s, 'package.json'), JSON.stringify({ scripts: { test: 'x' } }));
    }
    d.plan = [{ hang: true }, { hang: true }];
    const claim = vi.spyOn(repo, 'claim');
    const a = run('npm test', 'aa');
    const b = run('npm test', 'bb');
    await vi.waitFor(() => expect(d.runs).toHaveLength(2));
    await refused(run('npm test', 'cc'), 'E_GLOBAL');
    expect(d.runs).toHaveLength(2);
    expect(claim).toHaveBeenCalledTimes(2);
    await svc.killAll();
    await Promise.all([a, b]);
    // the slots are free again
    expect((await run('npm test', 'cc')).outcome).toBe('exit');
  });

  it('tree cap, day cap; a day refusal leaves the tree count unchanged (rollback)', async () => {
    pkgJson({ scripts: { test: 'x' } });
    caps = { tree: 2, day: 200 };
    await run('npm test');
    await run('npm test');
    await refused(run('npm test'), 'E_CAP_TREE');
    caps = { tree: 5, day: 2 };
    await refused(run('npm test', 'demo', 'aaaaaaaa-2222-3333-4444-555555555555'), 'E_CAP_DAY');
    caps = { tree: 5, day: 200 };
    // the refused day claim did not consume a tree slot for the other root
    for (let i = 0; i < 5; i++) await run('npm test', 'demo', 'aaaaaaaa-2222-3333-4444-555555555555');
    await refused(run('npm test', 'demo', 'aaaaaaaa-2222-3333-4444-555555555555'), 'E_CAP_TREE');
    expect(d.runs).toHaveLength(7);
  });

  it('a halt between the claim and the spawn: zero containers, outcome halted, the slot stays claimed (WS-C12)', async () => {
    pkgJson({ scripts: { test: 'x' } });
    const orig = repo.claim.bind(repo);
    vi.spyOn(repo, 'claim').mockImplementation(async (...a) => {
      const r = await orig(...a);
      halted = true;
      return r;
    });
    const r = await run('npm test');
    expect(r.outcome).toBe('halted');
    expect(d.runs).toHaveLength(0);
    expect(d.containers.size).toBe(0);
    halted = false;
    vi.restoreAllMocks();
    caps = { tree: 1, day: 200 };
    await refused(run('npm test'), 'E_CAP_TREE'); // the claimed slot was not refunded
  });

  it('a halt during a run: killAll removes the container and the run ends halted; nothing starts after shutdown', async () => {
    pkgJson({ scripts: { test: 'x' } });
    d.plan = [{ hang: true }];
    const p = run('npm test');
    await vi.waitFor(() => expect(d.runs).toHaveLength(1));
    halted = true;
    await svc.killAll();
    expect(await p).toMatchObject({ outcome: 'halted' });
    expect(d.containers.size).toBe(0);
    halted = false;
    await svc.shutdown();
    expect((await run('npm test')).outcome).toBe('halted');
    expect(d.runs).toHaveLength(1);
  });

  it('killAll removes ws=1 containers named ws-* and not others', async () => {
    d.extraContainers = ['ws-demo-0123abcd', 'ws-other-deadbeef', 'devjob-J-1-agent', 'ws-evil;x'];
    await svc.killAll();
    const rm = [...new Set(d.execs.filter((e) => e[0] === 'rm').map((e) => e[2]))];
    expect(rm.sort()).toEqual(['ws-demo-0123abcd', 'ws-other-deadbeef']);
  });

  it('a container that cannot be removed: E_STUCK outcome, the lock stays held, an incident is reported, nothing is released', async () => {
    pkgJson({ scripts: { test: 'x' } });
    d.neverRemove = true;
    const r = await run('npm test');
    expect(r.outcome).toBe('stuck');
    expect(incidents.report).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(incidents.report.mock.calls[0])).not.toContain(root);
    d.neverRemove = false;
    await refused(run('npm test'), 'E_BUSY');
    await expect(svc.write('demo', 'x', 'y')).rejects.toMatchObject({ code: 'E_BUSY' });
  });

  it('the mount source must still be the same real directory right before the spawn (WS-C2)', async () => {
    pkgJson({ scripts: { test: 'x' } });
    const orig = repo.claim.bind(repo);
    vi.spyOn(repo, 'claim').mockImplementation(async (...a) => {
      const r = await orig(...a);
      rmSync(join(root, 'demo'), { recursive: true });
      symlinkSync(base, join(root, 'demo'));
      return r;
    });
    const r = await run('npm test');
    expect(r.outcome).toBe('start');
    expect(d.runs).toHaveLength(0);
  });
});

describe('ws_export', () => {
  const put = (rel: string, data: string | Buffer) => {
    const p = join(root, 'demo', rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, data);
  };
  /** Reads names from the central directory. */
  const names = (z: Buffer): string[] => {
    const eocd = z.length - 22;
    const n = z.readUInt16LE(eocd + 10);
    let p = z.readUInt32LE(eocd + 16);
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const nl = z.readUInt16LE(p + 28);
      out.push(z.subarray(p + 46, p + 46 + nl).toString());
      p += 46 + nl + z.readUInt16LE(p + 30) + z.readUInt16LE(p + 32);
    }
    return out;
  };

  it('zips the regular files, excludes node_modules and .git (any case, any depth), temp names, big files, symlinks and odd names; counts the skipped', async () => {
    put('package.json', '{}');
    put('src/a.js', 'console.log(1)');
    put('src/deep/b.txt', 'b');
    put('node_modules/x/i.js', 'x');
    put('NODE_MODULES/y.js', 'y');
    put('src/node_modules/z.js', 'z');
    put('.git/config', 'g');
    put('.GIT/config', 'g');
    put('.ws-tmp-123', 't');
    put('big.bin', Buffer.alloc(5_000_001, 1));
    put('a\\..\\x.js', 'evil');
    put('c:evil.js', 'evil');
    symlinkSync('/etc/hosts', join(root, 'demo', 'link.txt'));
    const z = await svc.export('demo', []);
    expect(names(z.zip).sort()).toEqual(['package.json', 'src/a.js', 'src/deep/b.txt']);
    expect(z.files).toBe(3);
    expect(z.skipped).toBe(4); // big.bin, two odd names, the symlink
    expect(z.sha256).toMatch(/^[0-9a-f]{64}$/);
    for (const n of names(z.zip)) expect(n).not.toMatch(/[\\:]|\.\./);
  });

  it('an empty workspace and a zip over 10,000,000 bytes are E_EXPORT_SIZE; more than 2000 files too', async () => {
    await expect(svc.export('demo', [])).rejects.toMatchObject({ code: 'E_EXPORT_SIZE' });
    const { randomBytes } = await import('node:crypto');
    for (let i = 0; i < 3; i++) put(`r${i}.bin`, randomBytes(4_000_000));
    await expect(svc.export('demo', [])).rejects.toMatchObject({ code: 'E_EXPORT_SIZE' });
  });
  it('more than 2000 files is E_EXPORT_SIZE', async () => {
    for (let i = 0; i < 2001; i++) writeFileSync(join(root, 'demo', `f${i}`), '');
    // 2001 files is also over the 2000 workspace file limit for writes, but export reads, not writes
    await expect(svc.export('demo', [])).rejects.toMatchObject({ code: 'E_EXPORT_SIZE' });
  });

  it('a literal secret in any file without a NUL refuses the export with a count and no path (WS-C15c, f); a binary file is not scanned', async () => {
    put('notes.weird', 'token is TOP-SECRET-LITERAL here');
    put('src/x.js', 'const k = "TOP-SECRET-LITERAL"');
    put('bin.dat', Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from('TOP-SECRET-LITERAL')]));
    put('ok.txt', 'fine');
    const e = await svc.export('demo', ['', 'TOP-SECRET-LITERAL']).then(() => null, (x: unknown) => x as WsError);
    expect(e).toBeInstanceOf(WsError);
    expect(e!.code).toBe('E_EXPORT_SECRET');
    expect(e!.message).toBe('The export was refused: 2 file(s) contain a company secret; remove it first.');
    expect(e!.message).not.toMatch(/notes|weird|src|x\.js/);
  });

  it('a symlink planted at the leaf, in a parent folder, or as a hard link never reaches the zip', async () => {
    put('ok.txt', 'ok');
    symlinkSync(base, join(root, 'demo', 'dirlink'));
    writeFileSync(join(base, 'outside.txt'), 'OUTSIDE');
    symlinkSync(join(base, 'outside.txt'), join(root, 'demo', 'leaf.txt'));
    const { linkSync } = await import('node:fs');
    linkSync(join(base, 'outside.txt'), join(root, 'demo', 'hard.txt'));
    const z = await svc.export('demo', []);
    expect(names(z.zip)).toEqual(['ok.txt']);
    expect(z.skipped).toBe(3);
  });

  it('an archived workspace can still be exported', async () => {
    put('a.txt', 'a');
    await repo.archive('demo', '123');
    expect((await svc.export('demo', [])).files).toBe(1);
  });

  it('fails closed on a run service that is not configured', async () => {
    const bare = new WsService({ repo, root, files: new ProjectFiles(root), lock: new SlugLock() });
    await expect(bare.export('demo', [])).rejects.toMatchObject({ code: 'E_IO' });
    await expect(bare.run({ slug: 'demo', command: 'npm ci', rootId: ROOT_ID })).rejects.toMatchObject({ code: 'E_IO' });
    await bare.killAll();
    expect(existsSync(root)).toBe(true);
    expect(readFileSync).toBeDefined();
  });
});
