import { afterEach, describe, expect, it } from 'vitest';
import { closureReport } from './closure-report.js';
import { makeRepo, sh, type Repo } from './test-helpers.js';

let repo: Repo;
afterEach(() => repo?.cleanup());

describe('X9 install side: closureReport', () => {
  it('reports nothing when only unrelated files changed', async () => {
    repo = makeRepo();
    const from = repo.head();
    const to = repo.commit({ 'tools/x.ts': 'export const x = 2;\n', 'docs/a.md': 'a\n' }, 'change', 'owner');
    expect(await closureReport(repo.git, from, to)).toMatchObject({ nothing: true, changed: [], devJobCommits: [] });
  });
  it('reports a changed closure file and flags commits made by the dev-job identity', async () => {
    repo = makeRepo();
    const from = repo.head();
    sh(repo.dir, '-c', 'user.email=devjob@assistant.invalid', '-c', 'user.name=dev-job', 'commit', '-q', '--allow-empty', '-m', 'empty');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(`${repo.dir}/core/a.ts`, 'export const a = 2;\n');
    sh(repo.dir, 'add', '-A');
    const env = { ...process.env, GIT_AUTHOR_EMAIL: 'devjob@assistant.invalid', GIT_COMMITTER_EMAIL: 'devjob@assistant.invalid', GIT_AUTHOR_NAME: 'dev-job', GIT_COMMITTER_NAME: 'dev-job' };
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['commit', '-q', '-m', 'change a'], { cwd: repo.dir, env });
    const to = repo.head();
    const r = await closureReport(repo.git, from, to);
    expect(r.nothing).toBe(false);
    expect(r.changed).toContain('closure: core/a.ts changed');
    expect(r.devJobCommits.some((c) => c.includes('devjob@assistant.invalid'))).toBe(true);
  });
});
