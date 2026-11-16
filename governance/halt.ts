import type { ConfigStore } from '../config/store.js';
import type { AppEvents, EventBus } from '../core/events.js';
import type { TaskRepo } from '../db/repos/tasks.js';

type Cfg = Pick<ConfigStore, 'get' | 'set' | 'watch'>;
type Tasks = Pick<TaskRepo, 'listByStatus' | 'update'>;

/** Emergency stop backed by the `halted` config row, so every instance agrees. */
export class Halt {
  private readonly tracked = new Set<AbortController>();

  /** Set synchronously by halt(), cleared only by resume(): this process stays halted even if persisting fails. */
  private latched = false;
  private blocking: Promise<void> | null = null;
  /** WEBGRANT-1 (W-C3c): run on EVERY way into a halt (`/halt`, and a halt set elsewhere seen by the config watcher), never on resume. */
  private readonly haltHooks: (() => void | Promise<void>)[] = [];
  /** G2W-02: run by /resume (the app revokes every grant that exists then: a resume restores nothing). */
  private readonly resumeHooks: (() => void | Promise<void>)[] = [];

  constructor(private readonly cfg: Cfg, private readonly tasks: Tasks, private readonly bus: EventBus<AppEvents>) {
    // A halt set elsewhere (another instance, or a direct UPDATE) must stop this process's in-flight work too.
    cfg.watch('halted', (v) => {
      if (v !== false) {
        this.abortAll();
        void this.blockDoing().catch(() => undefined);
        void this.runHooks();
      }
    });
  }

  /** Registers something to do whenever this process enters a halt by any path (e.g. revoke every web grant). A hook's failure never blocks the halt. */
  onHalted(fn: () => void | Promise<void>): void {
    this.haltHooks.push(fn);
  }

  onResumed(fn: () => void | Promise<void>): void {
    this.resumeHooks.push(fn);
  }

  private async runHooks(list: readonly (() => void | Promise<void>)[] = this.haltHooks): Promise<void> {
    for (const h of list) {
      try { await h(); } catch { /* the halt itself must not depend on a hook */ }
    }
  }

  /** Never throws: any read error or non-boolean value counts as halted (Gate 1 D9). */
  isHalted(): boolean {
    try {
      return this.latched || this.cfg.get('halted') !== false;
    } catch {
      return true;
    }
  }

  /** Aborts in-flight work first, then persists the flag; returns the number of controllers aborted. */
  async halt(by: string): Promise<number> {
    this.latched = true;
    const aborted = this.abortAll();
    const hooks = this.runHooks(); // started now (the revoke runs alongside the persist), awaited after the event so nothing waits on it
    let failure: unknown;
    try {
      await this.cfg.set('halted', true, by);
    } catch (err) {
      failure = err;
    }
    try {
      await this.blockDoing();
    } catch (err) {
      failure ??= err;
    }
    await this.bus.emit('halt.changed', { halted: true, by });
    await hooks;
    if (failure !== undefined) throw failure;
    return aborted;
  }

  async resume(by: string): Promise<void> {
    await this.cfg.set('halted', false, by);
    this.latched = false;
    await this.runHooks(this.resumeHooks);
    await this.bus.emit('halt.changed', { halted: false, by });
  }

  /** Registers a controller to abort on halt; the returned function unregisters it. */
  track(ac: AbortController): () => void {
    if (this.isHalted()) ac.abort(new Error('halted'));
    else this.tracked.add(ac);
    return () => { this.tracked.delete(ac); };
  }

  /** Process shutdown: aborts in-flight work only. Not a halt: nothing is latched or persisted, tasks stay `doing` for boot recovery. */
  abortInFlight(): number {
    return this.abortAll();
  }

  private abortAll(): number {
    const controllers = [...this.tracked];
    this.tracked.clear();
    for (const ac of controllers) ac.abort(new Error('halted'));
    return controllers.length;
  }

  /** Shared in-flight pass so halt() and the config watcher do not block the same tasks twice. */
  private blockDoing(): Promise<void> {
    return (this.blocking ??= (async () => {
      // R35: reason 'halt' so recovery resumes them; each change is mirrored once it is stored (final #4).
      for (const t of await this.tasks.listByStatus('doing')) {
        const blocked = await this.tasks.update(t.id, { status: 'blocked', blockedReason: 'halt' }, 'doing');
        if (blocked) await this.bus.emit('task.changed', { task: blocked, from: 'doing', to: 'blocked' });
      }
    })().finally(() => { this.blocking = null; }));
  }
}
