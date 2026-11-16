import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeRepo, type Repo } from '../devjob/test-helpers.js';
import { buildRelease, copyRuntimeFiles, currentHead, makeWritable, pruneReleases, releaseDir, switchCurrent, type BuildPorts } from './code-release.js';

let repo: Repo;
let root: string;
afterEach(() => {
  repo?.cleanup();
  if (root && existsSync(root)) { try { makeWritable(root); } catch { /* best effort */ } rmSync(root, { recursive: true, force: true }); }
});
const fakePorts = (log: string[] = []): BuildPorts => ({
  extract: async (git, head, dir) => { log.push('extract'); const { execFileSync } = await import('node:child_process'); execFileSync('tar', ['-x', '-C', dir], { input: await git.run(['archive', '--format=tar', head]) }); },
  install: async (dir) => { log.push('install'); mkdirSync(join(dir, 'node_modules'), { recursive: true }); writeFileSync(join(dir, 'node_modules', 'dep.js'), '1'); },
  compile: async (dir) => { log.push('compile'); mkdirSync(join(dir, 'dist'), { recursive: true }); writeFileSync(join(dir, 'dist', 'main.js'), 'console.log(1)'); },
});

describe('release directories (OD-2a, X16b)', () => {
  it('builds from git archive, copies the runtime files, records head and tree, and is read-only', async () => {
    repo = makeRepo({ 'package.json': '{}', 'db/migrations/001.sql': 'x', 'prompts/system/a.md': 'p', 'tools/plugins/github/deploy-repos.json': '{}', 'src/a.ts': '1' });
    root = mkdtempSync(join(tmpdir(), 'rel-'));
    const log: string[] = [];
    const { dir, tree } = await buildRelease({ git: repo.git, head: repo.head(), root, ports: fakePorts(log) });
    expect(log).toEqual(['extract', 'install', 'compile']);
    expect(dir).toBe(releaseDir(root, repo.head()));
    expect(readFileSync(join(dir, 'dist/db/migrations/001.sql'), 'utf8')).toBe('x');
    expect(existsSync(join(dir, 'dist/prompts/system/a.md'))).toBe(true);
    expect(existsSync(join(dir, 'dist/tools/plugins/github/deploy-repos.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'release.json'), 'utf8'))).toMatchObject({ head: repo.head(), tree });
    expect(() => writeFileSync(join(dir, 'dist/main.js'), 'evil')).toThrow();
    expect(existsSync(join(root, 'staging', repo.head()))).toBe(false);
  });
  it('a failed build leaves no release and no staging directory', async () => {
    repo = makeRepo();
    root = mkdtempSync(join(tmpdir(), 'rel-'));
    const p = fakePorts();
    p.compile = async () => { throw new Error('tsc failed'); };
    await expect(buildRelease({ git: repo.git, head: repo.head(), root, ports: p })).rejects.toThrow(/tsc failed/);
    expect(existsSync(releaseDir(root, repo.head()))).toBe(false);
    expect(existsSync(join(root, 'staging', repo.head()))).toBe(false);
  });
  it('a build that produces no dist/main.js is refused; a symlink in the tree is refused', async () => {
    repo = makeRepo();
    root = mkdtempSync(join(tmpdir(), 'rel-'));
    const p = fakePorts();
    p.compile = async () => undefined;
    await expect(buildRelease({ git: repo.git, head: repo.head(), root, ports: p })).rejects.toThrow(/no dist\/main\.js/);
    const p2 = fakePorts();
    p2.extract = async (_g, _h, dir) => { const { symlinkSync } = await import('node:fs'); symlinkSync('/etc', join(dir, 'evil')); };
    await expect(buildRelease({ git: repo.git, head: repo.head(), root, ports: p2 })).rejects.toThrow(/symlink/);
  });
  it('switchCurrent is atomic and refuses a missing release; currentHead reads it back', async () => {
    repo = makeRepo();
    root = mkdtempSync(join(tmpdir(), 'rel-'));
    expect(currentHead(root)).toBeNull();
    expect(() => switchCurrent(root, 'a'.repeat(40))).toThrow(/does not exist/);
    const a = repo.head();
    await buildRelease({ git: repo.git, head: a, root, ports: fakePorts() });
    const b = repo.commit({ 'docs/x.md': 'x' });
    await buildRelease({ git: repo.git, head: b, root, ports: fakePorts() });
    switchCurrent(root, a);
    expect(currentHead(root)).toBe(a);
    switchCurrent(root, b);
    expect(currentHead(root)).toBe(b);
  });
  it('copyRuntimeFiles refuses a symlinked source', () => {
    root = mkdtempSync(join(tmpdir(), 'rel-'));
    mkdirSync(join(root, 'db'));
    symlinkSync('/etc', join(root, 'db/migrations'));
    expect(() => copyRuntimeFiles(root)).toThrow(/symlink/);
  });
  it('prune keeps the protected heads', async () => {
    repo = makeRepo();
    root = mkdtempSync(join(tmpdir(), 'rel-'));
    const heads: string[] = [];
    for (let i = 0; i < 4; i++) { const h = repo.commit({ [`docs/${i}.md`]: `${i}` }); heads.push(h); await buildRelease({ git: repo.git, head: h, root, ports: fakePorts() }); }
    const gone = pruneReleases(root, [heads[0]!], 2);
    expect(gone).not.toContain(heads[0]);
    expect(gone).toHaveLength(1);
  });
});
