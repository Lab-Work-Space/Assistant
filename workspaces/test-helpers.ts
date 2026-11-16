import type { DockerCli, ExecResult, RunDone, RunHandle } from './runner.js';

export type FakeRun = { code?: number; out?: string; oom?: boolean; exit?: number; startedAt?: string; hang?: boolean; overflowed?: boolean; before?: (argv: string[]) => void | Promise<void> };

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, timedOut: false, missing: false });

/** A scripted docker CLI: containers live in a set; `rm -f` removes; `hang` runs end only when the container is removed (or the client is killed). */
export class FakeDocker implements DockerCli {
  readonly execs: string[][] = [];
  readonly runs: string[][] = [];
  readonly containers = new Map<string, { labels: boolean; info: string }>();
  /** Next behaviours, consumed in order; default: exit 0 with no output. */
  plan: FakeRun[] = [];
  proxyUp = true;
  prepInternal = true;
  neverRemove = false;
  extraContainers: string[] = [];
  private readonly waiters = new Map<string, (code: number) => void>();
  killed = 0;
  /** Boot checks. */
  imageId = '';
  versionCode = 0;
  psCode = 0;
  sweepIds: string[] = [];
  stubbornIds = false;

  exec(args: readonly string[]): Promise<ExecResult> {
    const a = [...args];
    this.execs.push(a);
    const j = a.join(' ');
    if (a[0] === 'rm' && a[1] === '-f' && /^[0-9a-f]{12,64}$/.test(a[2]!)) {
      if (!this.stubbornIds) this.sweepIds = this.sweepIds.filter((x) => x !== a[2]);
      return Promise.resolve(ok());
    }
    if (a[0] === 'rm' && a[1] === '-f') {
      if (!this.neverRemove) {
        this.containers.delete(a[2]!);
        this.extraContainers = this.extraContainers.filter((n) => n !== a[2]);
        this.waiters.get(a[2]!)?.(137);
      }
      return Promise.resolve(ok());
    }
    if (a[0] === 'ps' && a.includes('--format')) {
      const f = a[a.indexOf('--filter') + 1]!;
      const names = [...this.containers.keys(), ...this.extraContainers];
      if (f === 'label=ws=1') return Promise.resolve(ok(names.join('\n')));
      const want = f.replace(/^name=/, '');
      return Promise.resolve(ok(names.filter((n) => n.includes(want)).join('\n')));
    }
    if (a[0] === 'ps' && a.includes('-aq')) return Promise.resolve(this.psCode === 0 ? ok(this.sweepIds.join('\n')) : { code: this.psCode, stdout: '', timedOut: false, missing: false });
    if (a[0] === 'inspect' && a.includes('--format')) {
      const c = this.containers.get(a[a.length - 1]!);
      return Promise.resolve(c ? ok(c.info) : { code: 1, stdout: '', timedOut: false, missing: false });
    }
    if (j.startsWith('network inspect')) return Promise.resolve(ok(String(this.prepInternal)));
    if (a[0] === 'inspect' && a[1] === '-f') return Promise.resolve(ok(String(this.proxyUp)));
    if (a[0] === 'version') return Promise.resolve(this.versionCode === 0 ? ok('29.9.3') : { code: this.versionCode, stdout: '', timedOut: false, missing: this.versionCode === 127 });
    if (a[0] === 'image') return Promise.resolve(ok(this.imageId));
    return Promise.resolve(ok());
  }

  start(args: readonly string[]): RunHandle {
    const argv = [...args];
    this.runs.push(argv);
    const name = argv[argv.indexOf('--name') + 1]!;
    const p = this.plan.shift() ?? {};
    this.containers.set(name, { labels: true, info: `${p.oom ?? false} ${p.exit ?? p.code ?? 0} ${p.startedAt ?? '2026-11-10T00:00:00Z'}` });
    const done = new Promise<RunDone>((resolve) => {
      const finish = (code: number) => resolve({ code, tail: Buffer.from(p.out ?? ''), overflowed: p.overflowed ?? false, spawnFailed: false });
      void (async () => {
        await p.before?.(argv);
        if (p.hang) this.waiters.set(name, finish);
        else finish(p.code ?? 0);
      })();
    });
    return { done, killClient: () => { this.killed++; this.waiters.get(name)?.(137); } };
  }
}
