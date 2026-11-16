import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { realGit } from '../devjob/git.js';
import { makeRepo, sh, type Repo } from '../devjob/test-helpers.js';
import { intakeBundle, MAX_BUNDLE_BYTES, verifyBundle } from './code-bundle.js';

const JOB = 'J-0123456789abcdef';
let src: Repo;
let exec: string;
afterEach(() => { src?.cleanup(); if (exec) rmSync(exec, { recursive: true, force: true }); });

/** The executor's own bare repo, seeded with the base like the owner's first push would. */
function executorRepo(from: Repo): ReturnType<typeof realGit> {
  exec = mkdtempSync(join(tmpdir(), 'exec-'));
  sh(exec, 'init', '-q', '--bare', '-b', 'main', 'repo.git');
  sh(from.dir, 'push', '-q', join(exec, 'repo.git'), 'main:main');
  return realGit(join(exec, 'repo.git'));
}

describe('X16 bundle verification', () => {
  it('accepts a one-head bundle that descends from the executor main', async () => {
    src = makeRepo();
    const base = src.head();
    const git = executorRepo(src);
    const head = src.commit({ 'docs/a.md': 'a' });
    const b = join(exec, 'in.bundle');
    src.bundle(base, head, b);
    const { readFileSync } = await import('node:fs');
    const { path, sha256 } = intakeBundle(join(exec, 'bundles'), JOB, readFileSync(b));
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyBundle(git, { bundlePath: path, jobId: JOB, base, head })).toEqual({ ok: true, commits: 1 });
    expect((await git.run(['rev-parse', `refs/jobs/${JOB}`])).toString().trim()).toBe(head);
  });
  it('refuses a bundle with two heads, a wrong head, a moved base and a head that is not a descendant', async () => {
    src = makeRepo();
    const base = src.head();
    const git = executorRepo(src);
    const head = src.commit({ 'docs/a.md': 'a' });
    sh(src.dir, 'update-ref', 'refs/heads/other', head);
    sh(src.dir, 'update-ref', 'refs/heads/job', head);
    const two = join(exec, 'two.bundle');
    sh(src.dir, 'bundle', 'create', two, `${base}..refs/heads/job`, `${base}..refs/heads/other`);
    expect((await verifyBundle(git, { bundlePath: two, jobId: JOB, base, head })).ok).toBe(false);
    const one = join(exec, 'one.bundle');
    src.bundle(base, head, one);
    const other = src.commit({ 'docs/b.md': 'b' });
    expect(await verifyBundle(git, { bundlePath: one, jobId: JOB, base, head: other })).toMatchObject({ ok: false, why: expect.stringMatching(/head that was confirmed/) });
    // base moved: the executor's main is ahead of the job's base
    sh(src.dir, 'push', '-q', join(exec, 'repo.git'), `${other}:refs/heads/main`);
    expect(await verifyBundle(git, { bundlePath: one, jobId: JOB, base, head })).toMatchObject({ ok: false, why: expect.stringMatching(/current main/) });
  });
  it('refuses a bundle whose prerequisite the executor does not have, and a head not descending from base', async () => {
    src = makeRepo();
    const base = src.head();
    const mid = src.commit({ 'docs/m.md': 'm' });
    const git = executorRepo(src); // executor main = mid
    const head = src.commit({ 'docs/a.md': 'a' });
    const missing = join(exec, 'm.bundle');
    sh(src.dir, 'update-ref', 'refs/heads/job', head);
    sh(src.dir, 'bundle', 'create', missing, `${mid}..refs/heads/job`);
    // the job claims a base the bundle does not build on
    expect((await verifyBundle(git, { bundlePath: missing, jobId: JOB, base: head, head })).ok).toBe(false);
    void base;
  });
});

describe('intake', () => {
  it('refuses empty and oversize data and a symlinked directory; every intake is its own file', () => {
    exec = mkdtempSync(join(tmpdir(), 'exec-'));
    expect(() => intakeBundle(join(exec, 'b'), JOB, Buffer.alloc(0))).toThrow(/size cap/);
    expect(() => intakeBundle(join(exec, 'b'), JOB, Buffer.alloc(MAX_BUNDLE_BYTES + 1))).toThrow(/size cap/);
    const a = intakeBundle(join(exec, 'b'), JOB, Buffer.from('x'));
    expect(existsSync(a.path)).toBe(true);
    expect(intakeBundle(join(exec, 'b'), JOB, Buffer.from('x')).path).not.toBe(a.path); // every intake gets its own file (O_EXCL on a random name)
    writeFileSync(join(exec, 'real'), '');
    symlinkSync(exec, join(exec, 'link'));
    expect(() => intakeBundle(join(exec, 'link'), JOB, Buffer.from('y'))).toThrow(/real directory/);
    expect(() => intakeBundle(join(exec, 'b'), 'bad', Buffer.from('x'))).toThrow(/job id/);
  });
});
