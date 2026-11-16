import type { McpRow } from '../db/repos/mcp.js';
import { configSha256 } from './snapshot.js';
import type { DockerCli, ExecResult } from '../workspaces/runner.js';

export { FIXTURE, fixtureSpawner } from './spawner-fixture.js';

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, timedOut: false, missing: false });
/** A scripted docker CLI for `exec` only (MCP never uses `start`). */
export class FakeMcpDocker implements Pick<DockerCli, 'exec'> {
  readonly execs: string[][] = [];
  /** `docker image inspect` answers. */
  imageId = `sha256:${'c'.repeat(64)}`;
  volumes = 'null';
  /** R7 PF-C10: the `{{json .Config.Labels}}` answer, and whether that inspect fails. */
  labels = 'null';
  labelsFail = false;
  /** Names that `ps -a` keeps reporting (removal fails). */
  stuck = new Set<string>();
  oom = false;
  exitCode = 0;
  started = true;
  versionCode = 0;
  info = '["name=seccomp,profile=builtin","name=cgroupns"]';
  /** Containers the sweep sees (`ps -a --filter label=mcp=1`). */
  labelled: string[] = [];
  removed: string[] = [];
  missing = false;

  exec(args: readonly string[]): Promise<ExecResult> {
    const a = [...args];
    this.execs.push(a);
    if (this.missing) return Promise.resolve({ code: 127, stdout: '', timedOut: false, missing: true });
    if (a[0] === 'rm') { const n = a[a.length - 1]!; this.removed.push(n); this.labelled = this.labelled.filter((x) => x !== n); return Promise.resolve(ok()); }
    if (a[0] === 'ps') {
      const f = a[a.indexOf('--filter') + 1]!;
      if (f === 'label=mcp=1') return Promise.resolve(ok(this.labelled.join('\n')));
      const want = f.replace(/^name=/, '');
      return Promise.resolve(ok([...this.stuck].filter((n) => n.includes(want)).join('\n')));
    }
    if (a[0] === 'inspect') return Promise.resolve(ok(`${this.oom} ${this.exitCode} ${this.started ? '2026-11-12T00:00:00Z' : '0001-01-01T00:00:00Z'}`));
    if (a[0] === 'image' && a[1] === 'inspect' && a.join(' ').includes('Config.Labels')) return Promise.resolve(this.labelsFail ? { code: 1, stdout: '', timedOut: false, missing: false } : ok(this.labels));
    if (a[0] === 'image' && a[1] === 'inspect') return Promise.resolve(ok(a.join(' ').includes('Config.Volumes') ? this.volumes : this.imageId));
    if (a[0] === 'version') return Promise.resolve(this.versionCode === 0 ? ok('29.9.3') : { code: this.versionCode, stdout: '', timedOut: false, missing: false });
    if (a[0] === 'info') return Promise.resolve(ok(this.info));
    return Promise.resolve(ok());
  }
}

/** Migration 047: a unit-test row as an approved row holds it, with the pin of its own config (an explicit `approvedConfigSha256` wins, null included). */
export const pinned = (r: Omit<McpRow, 'approvedConfigSha256'> & { approvedConfigSha256?: string | null }): McpRow => ({ ...r, approvedConfigSha256: r.approvedConfigSha256 !== undefined ? r.approvedConfigSha256 : configSha256(r) });
