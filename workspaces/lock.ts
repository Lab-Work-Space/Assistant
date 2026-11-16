/**
 * WS-1 (SA-1 5.2, Gate 1 WS-C10): the per-slug lock, in memory, single process. A run excludes every file operation and every
 * other run of the same slug; file operations may overlap each other, but writes of one slug are serialised by a promise chain
 * so two writes cannot both pass the quota. Nothing waits for a run: a busy slug answers at once.
 */
type State = { run: boolean; ops: number; chain: Promise<unknown>; stuck: boolean };

export class SlugLock {
  private readonly s = new Map<string, State>();

  private state(slug: string): State {
    let st = this.s.get(slug);
    if (!st) this.s.set(slug, (st = { run: false, ops: 0, chain: Promise.resolve(), stuck: false }));
    return st;
  }

  /** Takes the run lock (allowed when no run and no operation is active). Returns the release, or null when busy. */
  tryRun(slug: string): (() => void) | null {
    const st = this.state(slug);
    if (st.run || st.ops > 0) return null;
    st.run = true;
    return () => {
      if (!st.stuck) st.run = false;
    };
  }

  /** E_STUCK (a container that could not be removed): the lock stays held until the next boot. */
  markStuck(slug: string): void {
    const st = this.state(slug);
    st.stuck = true;
    st.run = true;
  }

  /** Runs `fn` as a file operation (list, read, write, delete, export). Resolves `{ busy: true }` without running when a run holds the slug. */
  async op<T>(slug: string, mode: 'read' | 'write', fn: () => Promise<T>): Promise<{ busy: true } | { busy: false; value: T }> {
    const st = this.state(slug);
    if (st.run) return { busy: true };
    st.ops++;
    try {
      if (mode === 'read') return { busy: false, value: await fn() };
      const next = st.chain.then(fn);
      st.chain = next.catch(() => undefined);
      return { busy: false, value: await next };
    } finally {
      st.ops--;
    }
  }
}
