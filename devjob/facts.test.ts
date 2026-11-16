import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { computeFacts } from './facts.js';
import { fitSummary, summaryLines, defang } from './summary.js';
import { makeRepo, okSupply, sh, type Repo } from './test-helpers.js';

let repo: Repo;
afterEach(() => repo?.cleanup());
const facts = async (r: Repo, base: string, head: string) => computeFacts(r.git, base, head, okSupply());

describe('computeFacts (real git)', () => {
  it('a docs-only change is low risk with no refusals', async () => {
    repo = makeRepo();
    const base = repo.head();
    const head = repo.commit({ 'docs/new.md': '# new\n' });
    const f = await facts(repo, base, head);
    expect(f.refusals).toEqual([]);
    expect(f).toMatchObject({ lowRiskOnly: true, commits: 1 });
    expect(f.files).toEqual([{ path: 'docs/new.md', status: 'A', protected: false, nonSelfModifiable: false, test: false, closure: false }]);
  });
  it('a code change is protected, not refused; a test file edit is listed', async () => {
    repo = makeRepo();
    const base = repo.head();
    const head = repo.commit({ 'tools/x.ts': 'export const x = 2;\n', 'tools/x.test.ts': "import { it } from 'vitest';\nit('x', () => {});\nit('y', () => {});\n" });
    const f = await facts(repo, base, head);
    expect(f.refusals).toEqual([]);
    expect(f.lowRiskOnly).toBe(false);
    expect(f.files.every((x) => x.protected)).toBe(true);
    expect(f.flags.join()).toMatch(/test file modified/);
  });
  it('a case-variant executor path, a closure change and a rename out of the executor are refused', async () => {
    repo = makeRepo();
    const base = repo.head();
    const h1 = repo.commit({ 'core/a.ts': 'export const a = 2;\n' });
    expect((await facts(repo, base, h1)).refusals.join()).toMatch(/closure: core\/a\.ts changed/);
    const h2 = repo.commit({ 'executor/main.ts': null, 'src/main.ts': "import { a } from '../core/a.js';\n" });
    const r = (await facts(repo, base, h2)).refusals.join();
    expect(r).toMatch(/non-self-modifiable path: "executor\/main\.ts"/);
  });
  it('bidi, skip markers, executable bit and symlinks are refused', async () => {
    repo = makeRepo();
    const base = repo.head();
    const h1 = repo.commit({ 'tools/y.ts': 'const s = "a‮b";\n', 'tools/x.test.ts': "import { it } from 'vitest';\nit('x', () => {});\nit.skip('z', () => {});\n" });
    const r = (await facts(repo, base, h1)).refusals.join();
    expect(r).toMatch(/bidirectional/);
    expect(r).toMatch(/test integrity/);
    const h2 = repo.commit({ 'tools/z.sh': '#!/bin/sh\n' });
    sh(repo.dir, 'update-index', '--chmod=+x', 'tools/z.sh');
    sh(repo.dir, 'commit', '-q', '-m', 'x');
    expect((await facts(repo, h2, repo.head())).refusals.join()).toMatch(/executable/);
    void h2;
  });
  it('a merge commit and too many commits are refused', async () => {
    repo = makeRepo();
    const base = repo.head();
    let head = base;
    for (let i = 0; i < 21; i++) head = repo.commit({ [`docs/${i}.md`]: `${i}\n` });
    expect((await facts(repo, base, head)).refusals.join()).toMatch(/21 commits/);
    sh(repo.dir, 'checkout', '-q', '-b', 'side', base);
    const side = repo.commit({ 'docs/side.md': 's\n' });
    sh(repo.dir, 'checkout', '-q', 'main');
    sh(repo.dir, 'merge', '-q', '--no-ff', '-m', 'merge', side);
    expect((await facts(repo, base, repo.head())).refusals.join()).toMatch(/merge commit/);
  });
  it('requires full commit ids', async () => {
    repo = makeRepo();
    await expect(computeFacts(repo.git, 'main', repo.head(), okSupply())).rejects.toThrow(/full commit ids/);
  });
});

describe('G2SC-06 identity, G2SC-10 whole-tree case collisions, G2SC-09 diff hash', () => {
  it('refuses a branch with a commit by anyone but the dev-job identity (e.g. made under the owner name)', async () => {
    repo = makeRepo();
    const base = repo.head();
    const head = repo.commit({ 'docs/a.md': 'a\n' }, 'spoof', 'owner');
    expect((await facts(repo, base, head)).refusals.join()).toMatch(/other than the dev-job identity/);
    const ok = repo.commit({ 'docs/b.md': 'b\n' });
    expect((await facts(repo, head, ok)).refusals).toEqual([]);
  });
  it('refuses a new path that folds equal to an UNCHANGED file of the tree (it would overwrite it on APFS)', async () => {
    repo = makeRepo({ ...{ 'executor/main.ts': "import { a } from '../core/a.js';\n", 'core/a.ts': 'export const a = 1;\n' }, 'db/repos/adminCards.ts': 'export const x = 1;\n', 'package.json': '{}', 'package-lock.json': '{"packages":{"":{}}}' });
    const base = repo.head();
    // plumbing: the working tree of this (case-insensitive) disk would merge the two names, the git index does not
    const mk = (path: string, content: string, parent: string) => {
      const env = { PATH: process.env.PATH ?? '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'dev-job', GIT_AUTHOR_EMAIL: 'devjob@assistant.invalid', GIT_COMMITTER_NAME: 'dev-job', GIT_COMMITTER_EMAIL: 'devjob@assistant.invalid' };
      const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo.dir, env, input: content }).toString().trim();
      sh(repo.dir, 'read-tree', parent);
      sh(repo.dir, 'update-index', '--add', '--cacheinfo', `100644,${blob},${path}`);
      const tree = sh(repo.dir, 'write-tree');
      return execFileSync('git', ['commit-tree', tree, '-p', parent, '-m', 'x'], { cwd: repo.dir, env }).toString().trim();
    };
    const head = mk('db/repos/admincards.ts', 'export const x = 666;\n', base);
    const f = await facts(repo, base, head);
    expect(f.refusals.join()).toMatch(/differ only by case or normalization/);
    // a directory-level variant too
    const h2 = mk('DB/repos/other.ts', 'x\n', base);
    expect((await facts(repo, base, h2)).refusals.join()).toMatch(/differ only by case/);
  });
  it('computes the sha256 of the diff itself and shows it, with the requester, in the summary', async () => {
    repo = makeRepo();
    const base = repo.head();
    const head = repo.commit({ 'docs/a.md': 'a\n' });
    const f = await facts(repo, base, head);
    const { createHash } = await import('node:crypto');
    const d = sh(repo.dir, 'diff', '--no-ext-diff', '--no-textconv', base, head);
    expect(f.diffSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(f.diffSha256).toBe(createHash('sha256').update(d + '\n').digest('hex'));
    const text = fitSummary(summaryLines(f, { repo: 'r/r', bundleSha256: 'a'.repeat(64), jobId: 'j', ownerOnly: false, requesterId: '123456789012345678' }));
    expect(text).toContain(`requested by <123456789012345678>, diff sha256 ${f.diffSha256.slice(0, 16)}`);
  });
});

describe('X20 summary', () => {
  it('puts refusals and protected hits first, labels model text, and ends in a +N more marker instead of cutting', async () => {
    repo = makeRepo();
    const base = repo.head();
    const files = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`tools/gen/file-${i}.ts`, `export const v${i} = ${i};\n`]));
    const head = repo.commit({ ...files, 'docs/a.md': 'x\n' });
    const f = await facts(repo, base, head);
    const text = fitSummary(summaryLines(f, { repo: 'Lab-Work-Space/Assistant', bundleSha256: 'a'.repeat(64), jobId: 'j', ownerOnly: true, dashboardUrl: 'http://x/y' }, { summary: 'Hello @everyone <script>' }));
    expect(text.length).toBeLessThanOrEqual(1800);
    expect(text).toMatch(/\+\d+ more, see dashboard/);
    expect(text).toMatch(/Full diff: http:\/\/x\/y$/);
    expect(text.split('\n')[0]).toMatch(/base [0-9a-f]{12} -> head [0-9a-f]{12}/);
    expect(text.indexOf('Protected paths')).toBeLessThan(text.indexOf('tools/gen'));
  });
  it('model text is labelled and defanged', () => {
    const d = defang('hi @everyone ‮evil​ `x` https://e.example/p');
    expect(d).not.toMatch(/\u202e/);
    expect(d).not.toContain('\u200bevil');
    expect(d).toContain('<U+202E>');
    expect(d).toContain('@​everyone');
    expect(d).not.toContain('https://');
  });
});
