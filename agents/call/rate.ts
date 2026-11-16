import type { ActorRef } from '../../company/types.js';
import type { ConfigKey } from '../../config/schema.js';
import type { ConfigStore } from '../../config/store.js';

export const HUMAN_WINDOW_MS = 10 * 60 * 1000;

/**
 * Rolling 10-minute window per human user, limit read live from config. One slot per message; a refused trigger
 * asks for one notice per user until a run is allowed again.
 */
class WindowLimit {
  private readonly runs = new Map<string, number[]>();
  private readonly noticed = new Set<string>();

  constructor(private readonly cfg: Pick<ConfigStore, 'get'>, private readonly now: () => number, private readonly key: ConfigKey) {}

  private recent(userId: string): number[] {
    const t = this.now();
    const all = this.runs.get(userId);
    if (!all) return [];
    const recent = all.filter((x) => t - x < HUMAN_WINDOW_MS);
    if (recent.length) this.runs.set(userId, recent);
    else this.runs.delete(userId); // evict: no entry for a user with nothing in the window
    return recent;
  }

  /** Records a run when allowed; `notice` is true only for the first refusal of a window. */
  take(userId: string): { ok: true } | { ok: false; notice: boolean } {
    const recent = this.recent(userId);
    if (recent.length >= (this.cfg.get(this.key as 'limits.humanRunsPer10Min') as number)) {
      const notice = !this.noticed.has(userId);
      this.noticed.add(userId);
      return { ok: false, notice };
    }
    this.runs.set(userId, [...recent, this.now()]);
    this.noticed.delete(userId);
    return { ok: true };
  }

  /** Gives back the most recent slot (a request that was refused after it was admitted must not cost the user). */
  refund(userId: string): void {
    const recent = this.recent(userId);
    recent.pop();
    if (recent.length) this.runs.set(userId, recent);
    else this.runs.delete(userId);
  }

  /** Non-consuming: whether the user's counted runs (including one already taken for this very request) are within the limit. */
  within(userId: string): boolean {
    return this.recent(userId).length <= (this.cfg.get(this.key as 'limits.humanRunsPer10Min') as number);
  }
}

/**
 * Gate 1 D13: at most `limits.humanRunsPer10Min` triggering messages per human user in any rolling 10 minutes
 * (one slot per message, however many actors it routes to). Messages routed only to Praw are exempt (R8).
 */
export class HumanRateLimit extends WindowLimit {
  constructor(cfg: Pick<ConfigStore, 'get'>, now: () => number) {
    super(cfg, now, 'limits.humanRunsPer10Min');
  }
}

/**
 * R8 / spec §14.6: `limits.prawPerUser10Min` (20) Praw runs per human user, 600 s rolling. The triggering message's slot,
 * taken in Scheduler.admit(), IS the charge for everything that request does (including opening a conversation task, Gate P3).
 * Any entry point that does not go through admit() (a future /ask, /ocr or /voice) must call take() itself.
 */
export class PrawRateLimit extends WindowLimit {
  constructor(cfg: Pick<ConfigStore, 'get'>, now: () => number) {
    super(cfg, now, 'limits.prawPerUser10Min');
  }
}

/** Gate 1 C11: proposals per Bot Admin per rolling 10 minutes, on top of `limits.prawPerUser10Min` (a fixed cap, not a setting an injected change could raise). */
export const ADMIN_PER_10_MIN = 10;
export class AdminRateLimit extends WindowLimit {
  constructor(now: () => number, max = ADMIN_PER_10_MIN) {
    super({ get: () => max } as unknown as Pick<ConfigStore, 'get'>, now, 'limits.humanRunsPer10Min');
  }
}

/**
 * R8: company-wide cap (`limits.prawConcurrency`) on simultaneous Praw runs. `acquire` is null at the cap (refuse);
 * `wait` queues FIFO until a slot frees and resolves null when `cancelWaiters` is called (halt / stop).
 */
export class PrawConcurrency {
  private active = 0;
  private readonly waiters: ((release: (() => void) | null) => void)[] = [];

  constructor(private readonly cfg: Pick<ConfigStore, 'get'>) {}

  /** Read-only: slots neither held nor already wanted by a waiting run. */
  free(): number {
    return Math.max(0, this.cfg.get('limits.prawConcurrency') - this.active - this.waiters.length);
  }

  acquire(): (() => void) | null {
    if (this.active >= this.cfg.get('limits.prawConcurrency')) return null;
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.drain();
    };
  }

  wait(): Promise<(() => void) | null> {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      this.drain();
    });
  }

  cancelWaiters(): void {
    for (const w of this.waiters.splice(0)) w(null);
  }

  private drain(): void {
    while (this.waiters.length) {
      const release = this.acquire();
      if (!release) return;
      this.waiters.shift()!(release);
    }
  }
}

/** A Praw head or a persona of the praw department. */
export const isPrawActor = (a: ActorRef, deptOfPersona: (personaId: string) => string | undefined): boolean =>
  a.kind === 'head' ? a.dept === 'praw' : deptOfPersona(a.personaId) === 'praw';
