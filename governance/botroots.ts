import type { ConfigStore } from '../config/store.js';
import type { RootTaskGate } from '../tools/types.js';

/**
 * TW6: bots may create at most `warroom.rootTasksPerDay` root tasks (tasks with no parent) per UTC day: tasks born from warroom talk and
 * from meeting closes. The count comes from the tasks table (it survives a restart); slots taken but not yet written are counted in memory,
 * so concurrent runs cannot both take the last slot. Any error refuses (fail closed).
 */
export class BotRoots implements RootTaskGate {
  private taking = 0;

  constructor(
    private readonly cfg: Pick<ConfigStore, 'get'>,
    private readonly countSince: (since: Date) => Promise<number>,
    private readonly now: () => number = Date.now,
  ) {}

  async acquire(): Promise<(() => void) | null> {
    const day = new Date(this.now());
    day.setUTCHours(0, 0, 0, 0);
    this.taking++; // reserved before the first await, so a second caller sees it
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        this.taking--;
      }
    };
    try {
      const made = await this.countSince(day);
      if (made + this.taking - 1 < this.cfg.get('warroom.rootTasksPerDay')) return release;
    } catch {
      // fail closed
    }
    release();
    return null;
  }
}
