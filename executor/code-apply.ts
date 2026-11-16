import { closeSync, constants, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { AuditFn } from '../governance/audit.js';
import type { GitPort } from '../devjob/git.js';
import { buildRelease, currentHead, pruneReleases, switchCurrent, type BuildPorts } from './code-release.js';

/**
 * Applying a confirmed code job (Gate 1 self-code X16b, X17, X18; OD-2a). One apply lock covers verify, build, release switch, restart, health
 * and confirm-or-rollback. `main` of the executor's own bare repository moves only by compare-and-swap. The owner's working tree is never
 * touched. Health means: the serving build is the applied commit, the database answers, every client that was connected before is connected
 * again, the provider is ok and the system is not halted, all of that for a stable window.
 */
export interface HealthBody { db?: string; clients?: string[]; halted?: boolean; provider?: string; build?: string }

export interface ApplyDeps {
  git: GitPort;
  root: string;
  build: BuildPorts;
  /** Restarts the application so it starts from `<root>/current`. */
  restart(): Promise<void>;
  /** One /healthz reading; null = unreachable. */
  health(): Promise<HealthBody | null>;
  audit: AuditFn;
  /** Clients that must be connected whatever the baseline says (from the executor's env). */
  expectClients?: readonly string[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Stable window (default 2 minutes), longest wait for the first healthy reading (default 5 minutes), poll interval. */
  windowMs?: number;
  maxWaitMs?: number;
  pollMs?: number;
}

export type ApplyOutcome = { ok: true; outcome: 'applied'; lines: string[] } | { ok: false; outcome: 'refused' | 'rolled_back' | 'rollback_failed'; lines: string[] };

export interface ApplyState { jobId: string; head: string; base: string; prev: string; appliedAt: number; status: 'applied' | 'rolled_back' | 'manual_rollback' }
export const MANUAL_ROLLBACK_MS = 24 * 3600_000;

const SHA = /^[0-9a-f]{40}$/;

export function healthProblem(b: HealthBody | null, o: { sha: string; expectClients: readonly string[]; needProvider: boolean }): string | null {
  if (!b) return 'the health endpoint did not answer';
  if (b.db !== 'ok') return 'the database check failed';
  if (b.build !== o.sha) return `the serving build is ${b.build ? b.build.slice(0, 12) : 'unknown'}, not ${o.sha.slice(0, 12)}`;
  if (b.halted === true) return 'the system is halted';
  if (o.needProvider && b.provider !== 'ok') return 'the provider is unavailable';
  const have = new Set(b.clients ?? []);
  const missing = o.expectClients.filter((c) => !have.has(c));
  return missing.length ? `Discord client(s) not connected: ${missing.join(', ')}` : null;
}

export class CodeApplier {
  private busy = false;

  constructor(private readonly d: ApplyDeps) {}

  private now(): number { return (this.d.now ?? Date.now)(); }
  private sleep(ms: number): Promise<void> { return (this.d.sleep ?? ((m: number) => new Promise<void>((r) => setTimeout(r, m))))(ms); }
  private statePath(): string { return join(this.d.root, 'state.json'); }
  private lockPath(): string { return join(this.d.root, 'apply.lock'); }
  private text = async (...a: string[]): Promise<string> => (await this.d.git.run(a)).toString('utf8').trim();

  readState(): ApplyState | null {
    try { return JSON.parse(readFileSync(this.statePath(), 'utf8')) as ApplyState; } catch { return null; }
  }
  private writeState(s: ApplyState): void {
    const tmp = `${this.statePath()}.tmp`;
    writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
    renameSync(tmp, this.statePath());
  }

  /** The single apply lock: in this process and on disk (O_EXCL), so a second executor process cannot interleave. */
  private async locked<T>(f: () => Promise<T>): Promise<T | { refused: string }> {
    if (this.busy) return { refused: 'another code apply or rollback is running' };
    this.busy = true;
    let fd: number | null = null;
    try {
      try { fd = openSync(this.lockPath(), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600); } catch { return { refused: 'the apply lock is held (a previous apply may have crashed; see the owner guide)' }; }
      writeSync(fd, `${process.pid} ${new Date(this.now()).toISOString()}`);
      return await f();
    } finally {
      if (fd !== null) { closeSync(fd); rmSync(this.lockPath(), { force: true }); }
      this.busy = false;
    }
  }

  isBusy(): boolean { return this.busy; }

  private async waitHealthy(sha: string, expect: readonly string[], needProvider: boolean, windowMs: number): Promise<string | null> {
    const start = this.now();
    const maxWait = this.d.maxWaitMs ?? 300_000;
    let stableSince: number | null = null;
    let last = 'no reading';
    for (;;) {
      const why = healthProblem(await this.d.health().catch(() => null), { sha, expectClients: expect, needProvider });
      const t = this.now();
      if (why === null) {
        stableSince ??= t;
        if (t - stableSince >= windowMs) return null;
      } else { stableSince = null; last = why; }
      if (t - start > maxWait + windowMs) return last;
      await this.sleep(this.d.pollMs ?? 5000);
    }
  }

  async apply(j: { jobId: string; base: string; head: string; by: string; bundleSha256: string }): Promise<ApplyOutcome> {
    const r = await this.locked(() => this.doApply(j));
    return 'refused' in r ? { ok: false, outcome: 'refused', lines: [`Refused: ${r.refused}`] } : r;
  }

  private async doApply(j: { jobId: string; base: string; head: string; by: string; bundleSha256: string }): Promise<ApplyOutcome> {
    const tag = `job:${j.jobId} base:${j.base.slice(0, 12)} head:${j.head.slice(0, 12)} bundle:${j.bundleSha256.slice(0, 12)}`;
    const refuse = async (why: string): Promise<ApplyOutcome> => {
      await this.d.audit({ actor: `user:${j.by} via code`, action: 'code.apply', tool: 'assistant', outcome: `refused ${tag} ${why.slice(0, 160)}` });
      return { ok: false, outcome: 'refused', lines: [`Refused: ${why}`] };
    };
    if (!SHA.test(j.base) || !SHA.test(j.head)) return refuse('malformed commit ids');
    // The executor's main must still be the job's base (X17); a queued job whose base moved must be run again.
    if ((await this.text('rev-parse', '--verify', '-q', 'refs/heads/main').catch(() => '')) !== j.base) return refuse('main moved since the job started; run the job again');
    const prev = currentHead(this.d.root);
    if (!prev) return refuse('there is no running release to roll back to (bootstrap the release directory first)');
    const baseline = await this.d.health().catch(() => null);
    if (!baseline || baseline.db !== 'ok') return refuse('the application is not healthy before the change; nothing was applied');
    if (baseline.halted === true) return refuse('the system is halted');
    if (baseline.build && baseline.build !== prev) return refuse('the running build is not the release `current` points at');
    // G2SC-02: the diff the human saw is against the base; it must be the code that is actually running.
    if (j.base !== prev) return refuse('the base is not the running release; bring the running release and main together first');
    const expect = [...new Set([...(baseline.clients ?? []), ...(this.d.expectClients ?? [])])];
    const needProvider = baseline.provider === 'ok';
    try {
      await buildRelease({ git: this.d.git, head: j.head, root: this.d.root, ports: this.d.build, ...(this.d.now ? { now: () => new Date(this.now()) } : {}) });
    } catch (err) {
      return refuse(`the release could not be built: ${err instanceof Error ? err.message.slice(0, 120) : 'error'}`);
    }
    await this.d.git.run(['update-ref', `refs/rollback/${j.jobId}`, j.base]);
    try {
      await this.d.git.run(['update-ref', 'refs/heads/main', j.head, j.base]);
    } catch {
      return refuse('main moved while the release was built (compare-and-swap failed)');
    }
    await this.d.audit({ actor: `user:${j.by} via code`, action: 'code.apply', tool: 'assistant', outcome: `switching ${tag} rollback-point:releases/${prev.slice(0, 12)}` });
    const state: ApplyState = { jobId: j.jobId, head: j.head, base: j.base, prev, appliedAt: this.now(), status: 'applied' };
    this.writeState(state);
    switchCurrent(this.d.root, j.head);
    let problem: string | null;
    try {
      await this.d.restart();
      problem = await this.waitHealthy(j.head, expect, needProvider, this.d.windowMs ?? 120_000);
    } catch (err) {
      problem = `restart failed: ${err instanceof Error ? err.message.slice(0, 100) : 'error'}`;
    }
    if (problem === null) {
      pruneReleases(this.d.root, [j.head, prev]);
      await this.d.audit({ actor: `user:${j.by} via code`, action: 'code.apply', tool: 'assistant', outcome: `applied ${tag} rollback-point:releases/${prev.slice(0, 12)}` });
      return { ok: true, outcome: 'applied', lines: [`Applied ${j.head.slice(0, 12)}; the new build was healthy for the whole window. The rollback point is release ${prev.slice(0, 12)} (24 hours).`, 'Rollback does not undo side effects that happened while the new build ran.'] };
    }
    return this.rollBack(j, state, problem, tag);
  }

  /** Back to the previous release, then proof that the old build is the one serving. */
  private async rollBack(j: { by: string; head: string; base: string }, st: ApplyState, problem: string, tag: string, keepMain = false): Promise<ApplyOutcome> {
    switchCurrent(this.d.root, st.prev);
    let served: string | null = 'not checked';
    try {
      await this.d.restart();
      served = await this.waitHealthy(st.prev, [], false, 0);
    } catch (err) {
      served = `restart failed: ${err instanceof Error ? err.message.slice(0, 100) : 'error'}`;
    }
    await this.d.git.run(['update-ref', `refs/rejected/${st.jobId}`, j.head]).catch(() => undefined);
    // a release of a human-imported main never moves main back
    if (!keepMain) await this.d.git.run(['update-ref', 'refs/heads/main', j.base, j.head]).catch(() => undefined);
    this.writeState({ ...st, status: 'rolled_back' });
    const ok = served === null;
    await this.d.audit({ actor: 'system:executor', action: 'code.rollback', tool: 'assistant', outcome: `${ok ? 'rolled_back' : 'ROLLBACK_FAILED'} ${tag} reason:${problem.slice(0, 120)}${ok ? '' : ` old build not serving: ${served!.slice(0, 80)}`}` });
    return ok
      ? { ok: false, outcome: 'rolled_back', lines: [`The new build was not healthy (${problem}); rolled back to ${st.prev.slice(0, 12)}, which is serving again.`] }
      : { ok: false, outcome: 'rollback_failed', lines: [`The new build was not healthy (${problem}) AND the old build did not come back (${served}). Manual action is needed now.`] };
  }

  /**
   * Builds a release from the executor's imported `main` (human-imported commits; bootstrap and after each import) and switches `current` to it under the
   * same lock. With a running release: restart, the same health window, rollback if unhealthy. `main` is never moved.
   */
  async releaseMain(by: string): Promise<ApplyOutcome> {
    const r = await this.locked(async (): Promise<ApplyOutcome> => {
      const head = await this.text('rev-parse', '--verify', '-q', 'refs/heads/main').catch(() => '');
      const tag = `release-main head:${head.slice(0, 12)}`;
      const refuse = async (why: string): Promise<ApplyOutcome> => {
        await this.d.audit({ actor: `user:${by} via code`, action: 'code.release', tool: 'assistant', outcome: `refused ${tag} ${why.slice(0, 160)}` });
        return { ok: false, outcome: 'refused', lines: [`Refused: ${why}`] };
      };
      if (!SHA.test(head)) return refuse('the executor repository has no main (import first)');
      const prev = currentHead(this.d.root);
      if (prev === head) return refuse('the running release is already main');
      try {
        await buildRelease({ git: this.d.git, head, root: this.d.root, ports: this.d.build, ...(this.d.now ? { now: () => new Date(this.now()) } : {}) });
      } catch (err) {
        return refuse(`the release could not be built: ${err instanceof Error ? err.message.slice(0, 120) : 'error'}`);
      }
      if (!prev) {
        switchCurrent(this.d.root, head);
        this.writeState({ jobId: 'J-0000000000000000', head, base: head, prev: head, appliedAt: this.now(), status: 'applied' });
        await this.d.audit({ actor: `user:${by} via code`, action: 'code.release', tool: 'assistant', outcome: `bootstrapped ${tag}` });
        return { ok: true, outcome: 'applied', lines: [`Release ${head.slice(0, 12)} is now current (bootstrap). Start or restart the application.`] };
      }
      const baseline = await this.d.health().catch(() => null);
      const expect = [...new Set([...(baseline?.clients ?? []), ...(this.d.expectClients ?? [])])];
      const needProvider = baseline?.provider === 'ok';
      const st: ApplyState = { jobId: 'J-0000000000000000', head, base: prev, prev, appliedAt: this.now(), status: 'applied' };
      this.writeState(st);
      switchCurrent(this.d.root, head);
      let problem: string | null;
      try { await this.d.restart(); problem = await this.waitHealthy(head, expect, needProvider, this.d.windowMs ?? 120_000); } catch (err) { problem = `restart failed: ${err instanceof Error ? err.message.slice(0, 100) : 'error'}`; }
      if (problem === null) {
        pruneReleases(this.d.root, [head, prev]);
        await this.d.audit({ actor: `user:${by} via code`, action: 'code.release', tool: 'assistant', outcome: `switched ${tag} rollback-point:releases/${prev.slice(0, 12)}` });
        return { ok: true, outcome: 'applied', lines: [`Release ${head.slice(0, 12)} is current and healthy. Rollback point: ${prev.slice(0, 12)}.`] };
      }
      return this.rollBack({ by, head, base: prev }, st, problem, tag, true);
    });
    return 'refused' in r ? { ok: false, outcome: 'refused', lines: [`Refused: ${r.refused}`] } : r;
  }

  /** A Bot Admin's rollback within 24 hours of the apply (X18). */
  async rollback(by: string): Promise<ApplyOutcome> {
    const r = await this.locked(async (): Promise<ApplyOutcome> => {
      const st = this.readState();
      const fail = async (why: string): Promise<ApplyOutcome> => {
        await this.d.audit({ actor: `user:${by} via code`, action: 'code.rollback', tool: 'assistant', outcome: `refused ${why}` });
        return { ok: false, outcome: 'refused', lines: [`Refused: ${why}`] };
      };
      if (!st || st.status !== 'applied') return fail('there is no applied code change to roll back');
      if (this.now() - st.appliedAt > MANUAL_ROLLBACK_MS) return fail('the rollback window of 24 hours has passed');
      if (currentHead(this.d.root) !== st.head) return fail('the running release is not the last applied change');
      const tag = `job:${st.jobId} base:${st.base.slice(0, 12)} head:${st.head.slice(0, 12)}`;
      switchCurrent(this.d.root, st.prev);
      let served: string | null;
      try { await this.d.restart(); served = await this.waitHealthy(st.prev, [], false, 0); } catch (err) { served = `restart failed: ${err instanceof Error ? err.message.slice(0, 100) : 'error'}`; }
      await this.d.git.run(['update-ref', 'refs/heads/main', st.base, st.head]).catch(() => undefined);
      this.writeState({ ...st, status: 'manual_rollback' });
      await this.d.audit({ actor: `user:${by} via code`, action: 'code.rollback', tool: 'assistant', outcome: `${served === null ? 'manual_rollback' : 'MANUAL_ROLLBACK_FAILED'} ${tag}` });
      return served === null ? { ok: true, outcome: 'applied', lines: [`Rolled back to ${st.prev.slice(0, 12)}; it is serving.`] } : { ok: false, outcome: 'rollback_failed', lines: [`Switched back, but the old build is not serving (${served}).`] };
    });
    return 'refused' in r ? { ok: false, outcome: 'refused', lines: [`Refused: ${r.refused}`] } : r;
  }
}
