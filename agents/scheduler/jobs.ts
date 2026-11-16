/** Runs functions one at a time per key (FIFO); different keys run in parallel. */
export class KeyedLock {
  private readonly tails = new Map<string, Promise<void>>();

  /** TASKADMIN-1 (TA-C19): whether a job of `key` is queued or running right now. A query only: it never waits (an admin interaction must not wait on a run). */
  busy(key: string): boolean {
    return this.tails.has(key);
  }

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const result = prev.then(fn);
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}

/** In-flight background jobs, so callers (tests, shutdown) can wait until all work, including work spawned by work, is done. */
export class JobSet {
  private readonly jobs = new Set<Promise<void>>();

  /** Starts tracking `p`; it must never reject (callers catch and log their own errors). */
  add(p: Promise<void>): Promise<void> {
    this.jobs.add(p);
    void p.finally(() => this.jobs.delete(p));
    return p;
  }

  get size(): number {
    return this.jobs.size;
  }

  async idle(): Promise<void> {
    while (this.jobs.size) await Promise.allSettled([...this.jobs]);
  }
}
