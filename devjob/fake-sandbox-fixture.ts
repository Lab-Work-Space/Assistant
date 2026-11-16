import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Sandbox, TestResult } from './launcher.js';

/** A stand-in for the containers: real git in temp directories, a scripted "model". Used by the end-to-end test; nothing here touches Docker or a network. */
const ENV = { PATH: process.env.PATH ?? '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'dev-job', GIT_AUTHOR_EMAIL: 'devjob@assistant.invalid', GIT_COMMITTER_NAME: 'dev-job', GIT_COMMITTER_EMAIL: 'devjob@assistant.invalid' };
const git = (cwd: string, ...a: string[]): Buffer => execFileSync('git', a, { cwd, env: ENV, maxBuffer: 64 * 1024 * 1024 });

export class FakeSandbox implements Sandbox {
  readonly volumes = new Map<string, string>();
  readonly calls: string[] = [];
  removed = true;
  killed = 0;
  constructor(private readonly o: { files: Record<string, string | null>; reviews?: Partial<Record<'code' | 'security', string>>; agentOk?: boolean; testsFail?: boolean; installFails?: boolean }) {}

  async prepare(job: string, tag: string, i: { bundle: Buffer; rev: string }) {
    this.calls.push(`prepare:${tag}`);
    if (this.o.installFails) return { volume: `devjob-${job}-${tag}`, ok: false, log: 'npm ci failed' };
    const dir = mkdtempSync(join(tmpdir(), 'fake-vol-'));
    const b = join(dir, 'in.bundle');
    writeFileSync(b, i.bundle);
    git(dir, '-c', 'init.defaultBranch=main', 'init', '-q', 'repo');
    git(join(dir, 'repo'), 'fetch', '-q', b, '+refs/*:refs/bundle/*');
    git(join(dir, 'repo'), 'checkout', '-q', '--detach', i.rev);
    const volume = `devjob-${job}-${tag}`;
    this.volumes.set(volume, join(dir, 'repo'));
    return { volume, ok: true, log: 'installed' };
  }

  async runAgent(_job: string, i: { volume: string; base: string; credential: string; brief: string }) {
    this.calls.push('agent');
    if (this.o.agentOk === false) return { ok: false, log: 'agent crashed', timedOut: false };
    const repo = this.volumes.get(i.volume)!;
    git(repo, 'checkout', '-q', '-b', 'job');
    for (const [p, c] of Object.entries(this.o.files)) {
      if (c === null) rmSync(join(repo, p), { force: true });
      else { mkdirSync(dirname(join(repo, p)), { recursive: true }); writeFileSync(join(repo, p), c); }
    }
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'dev job change');
    return { ok: true, log: 'done', timedOut: false };
  }

  async exportBundle(_job: string, i: { volume: string; base: string }): Promise<Buffer | null> {
    this.calls.push('export');
    return git(this.volumes.get(i.volume)!, 'bundle', 'create', '-', `${i.base}..job`);
  }

  async runTests(_job: string, i: { volume: string }): Promise<TestResult> {
    this.calls.push('tests');
    const n = git(this.volumes.get(i.volume)!, 'ls-files').toString().split('\n').filter((f) => f.endsWith('.test.ts')).length;
    const failed = this.o.testsFail ? 2 : 0;
    return { ok: !failed, testsRun: 10 + n, testsFailed: failed, typecheck: true, build: true, log: 'tests ran' };
  }

  async review(_job: string, i: { kind: 'code' | 'security'; credential: string; input: string }) {
    this.calls.push(`review:${i.kind}`);
    return { ok: true, stdout: this.o.reviews?.[i.kind] ?? JSON.stringify({ verdict: 'APPROVE', findings: [] }) };
  }

  async cleanup() { for (const d of this.volumes.values()) rmSync(dirname(d), { recursive: true, force: true }); this.volumes.clear(); return { removed: this.removed }; }
  async kill() { this.killed++; }
  async killAll() { this.killed++; return 1; }
}
