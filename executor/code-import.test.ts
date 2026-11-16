import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { realGit } from '../devjob/git.js';
import { makeRepo, sh, type Repo } from '../devjob/test-helpers.js';
import { applyImport, planImport } from './code-import.js';

let src: Repo;
let dir = '';
afterEach(() => { src?.cleanup(); if (dir) rmSync(dir, { recursive: true, force: true }); });
function exec() {
  dir = mkdtempSync(join(tmpdir(), 'imp-'));
  sh(dir, 'init', '-q', '--bare', '-b', 'main', 'repo.git');
  return realGit(join(dir, 'repo.git'));
}

describe('G2SC-02 import: the owner never pushes into repo.git', () => {
  it('bootstraps an empty repository, then fast-forwards; lists the incoming commits; CAS moves main', async () => {
    src = makeRepo();
    const git = exec();
    sh(src.dir, 'bundle', 'create', join(dir, 'a.bundle'), 'main');
    const p1 = await planImport(git, join(dir, 'a.bundle'));
    expect(p1).toMatchObject({ ok: true, current: null, head: src.head() });
    if (!p1.ok) throw new Error('x');
    expect(p1.commits).toHaveLength(1);
    await applyImport(git, p1);
    expect((await git.run(['rev-parse', 'refs/heads/main'])).toString().trim()).toBe(src.head());
    const first = src.head();
    src.commit({ 'docs/a.md': 'a' }, 'second');
    sh(src.dir, 'bundle', 'create', join(dir, 'b.bundle'), `${first}..main`);
    const p2 = await planImport(git, join(dir, 'b.bundle'));
    expect(p2).toMatchObject({ ok: true, current: first });
    if (!p2.ok) throw new Error('x');
    expect(p2.commits[0]).toMatch(/second/);
    await applyImport(git, p2);
    // a stale plan cannot move main (compare-and-swap)
    await expect(applyImport(git, p1)).rejects.toThrow();
  });
  it('refuses a non-fast-forward, a no-op, a bundle with another head or two heads, and a bundle missing history', async () => {
    src = makeRepo();
    const git = exec();
    sh(src.dir, 'bundle', 'create', join(dir, 'a.bundle'), 'main');
    const p = await planImport(git, join(dir, 'a.bundle'));
    if (!p.ok) throw new Error('x');
    await applyImport(git, p);
    expect(await planImport(git, join(dir, 'a.bundle'))).toMatchObject({ ok: false, why: expect.stringMatching(/already at/) });
    sh(src.dir, 'checkout', '-q', '--orphan', 'other');
    sh(src.dir, 'commit', '-q', '--allow-empty', '-m', 'unrelated');
    sh(src.dir, 'branch', '-M', 'main2');
    sh(src.dir, 'bundle', 'create', join(dir, 'c.bundle'), 'main2');
    expect(await planImport(git, join(dir, 'c.bundle'))).toMatchObject({ ok: false, why: expect.stringMatching(/exactly one head/) });
    sh(src.dir, 'branch', '-M', 'main');
    sh(src.dir, 'bundle', 'create', join(dir, 'd.bundle'), 'main');
    expect(await planImport(git, join(dir, 'd.bundle'))).toMatchObject({ ok: false, why: expect.stringMatching(/not a fast-forward/) });
  });
});
