import type { ConfigStore } from '../config/store.js';
import type { TaskRepo } from '../db/repos/tasks.js';

type Cfg = Pick<ConfigStore, 'get' | 'watch'>;
type Counts = Pick<TaskRepo, 'countChildren' | 'countOpenChildren' | 'countOpen'>;

/** Turn, depth, fan-out and concurrency caps. Every check fails closed (false = refuse). */
export class Limits {
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  /** WS5: waiters for bot-only work; a free slot goes to a waiting person's run first. */
  private readonly botWaiters: (() => void)[] = [];
  private readonly unwatch: () => void;

  constructor(private readonly cfg: Cfg, private readonly counts?: Counts) {
    this.unwatch = cfg.watch('limits.concurrency', () => this.drain());
  }

  checkTurn(task: { turnsUsed: number }): boolean {
    return task.turnsUsed < this.cfg.get('limits.turnsPerTask');
  }

  checkDepth(parentDepth: number): boolean {
    return parentDepth + 1 <= this.cfg.get('limits.depth');
  }

  /**
   * True when the parent may take one more child (D2). 2026-11-08 (owner): only OPEN children count (done/cancelled do not),
   * so a long-lived conversation is not locked after 5 lifetime children; tree/open-task/budget caps still bound the total.
   */
  async checkChildren(parentId: string): Promise<boolean> {
    try {
      return (await this.requireCounts().countOpenChildren(parentId)) < this.cfg.get('limits.childrenPerTask');
    } catch {
      return false;
    }
  }

  /** True when the company may open `slots` more tasks (D2; default one). REROUTE-1 asks for two when it must adopt a conversation first. */
  async checkOpenTasks(slots = 1): Promise<boolean> {
    try {
      return (await this.requireCounts().countOpen()) + slots <= this.cfg.get('limits.openTasks');
    } catch {
      return false;
    }
  }

  /**
   * Resolves with an idempotent release function once a concurrency slot is free: FIFO within a class, and (WS5) every waiting
   * 'human' run before any waiting 'bot' run, so bot talk can never queue a person's work behind it.
   */
  acquire(priority: 'human' | 'bot' = 'human'): Promise<() => void> {
    return new Promise((resolve) => {
      (priority === 'bot' ? this.botWaiters : this.waiters).push(() => {
        this.active++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active--;
          this.drain();
        });
      });
      this.drain();
    });
  }

  dispose(): void {
    this.unwatch();
  }

  private requireCounts(): Counts {
    if (!this.counts) throw new Error('Limits has no task counts source');
    return this.counts;
  }

  private drain(): void {
    while ((this.waiters.length > 0 || this.botWaiters.length > 0) && this.active < this.cfg.get('limits.concurrency')) (this.waiters.shift() ?? this.botWaiters.shift())!();
  }
}
