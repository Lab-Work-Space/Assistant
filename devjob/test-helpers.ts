import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { realGit, type GitPort } from './git.js';
import type { SupplyPort } from './supply.js';

const ENV = { PATH: process.env.PATH ?? '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'dev-job', GIT_AUTHOR_EMAIL: 'devjob@assistant.invalid', GIT_COMMITTER_NAME: 'dev-job', GIT_COMMITTER_EMAIL: 'devjob@assistant.invalid', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
export const sh = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, env: ENV, encoding: 'utf8' }).trim();

/** A tiny repo with the closure the executor needs, plus helpers to commit changes on top. */
export const BASE_TREE: Record<string, string> = {
  'executor/main.ts': "import { a } from '../core/a.js';\nexport const m = a;\n",
  'core/a.ts': 'export const a = 1;\n',
  'tools/x.ts': 'export const x = 1;\n',
  'tools/x.test.ts': "import { it } from 'vitest';\nit('x', () => {});\n",
  'docs/guide.md': '# guide\n',
  'package.json': JSON.stringify({ name: 'a', scripts: { test: 'vitest' }, dependencies: {} }),
  'package-lock.json': JSON.stringify({ packages: { '': {} } }),
};

export interface Repo {
  dir: string;
  git: GitPort;
  /** Writes the files (null = delete) and commits; returns the new commit id. */
  commit(files: Record<string, string | null>, msg?: string, as?: 'owner'): string;
  head(): string;
  bundle(base: string, head: string, path: string): void;
  cleanup(): void;
}

export function makeRepo(tree: Record<string, string> = BASE_TREE): Repo {
  const dir = mkdtempSync(join(tmpdir(), 'devjob-repo-'));
  sh(dir, 'init', '-q', '-b', 'main');
  const repo: Repo = {
    dir,
    git: realGit(join(dir, '.git')),
    commit(files, msg = 'change', as) {
      for (const [p, c] of Object.entries(files)) {
        const f = join(dir, p);
        if (c === null) rmSync(f, { force: true });
        else { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, c); }
      }
      sh(dir, 'add', '-A');
      if (as === 'owner') execFileSync('git', ['commit', '-q', '--allow-empty', '-m', msg], { cwd: dir, env: { ...ENV, GIT_AUTHOR_NAME: 'owner', GIT_AUTHOR_EMAIL: 'owner@example.com', GIT_COMMITTER_NAME: 'owner', GIT_COMMITTER_EMAIL: 'owner@example.com' } });
      else sh(dir, 'commit', '-q', '--allow-empty', '-m', msg);
      return sh(dir, 'rev-parse', 'HEAD');
    },
    head: () => sh(dir, 'rev-parse', 'HEAD'),
    bundle(base, head, path) {
      sh(dir, 'update-ref', 'refs/heads/job', head);
      sh(dir, 'bundle', 'create', path, `${base}..refs/heads/job`);
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
  repo.commit(tree, 'base');
  return repo;
}

export const okSupply = (o: Partial<SupplyPort> = {}): SupplyPort => ({ publishedAt: async () => '2025-01-01T00:00:00Z', integrity: async () => 'sha512-AAAA', audit: async () => ({ high: 0, critical: 0, databaseDate: '2026-11-02' }), ...o });
