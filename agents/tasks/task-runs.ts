/**
 * TASKADMIN-1 (TA-C9, TA-C10): the stop signal of an admin cancel for runs in this process.
 *
 * `track` is called by `callProvider` for the provider stream of a run that has a task (owner runs, roll-ups and mention runs all do); `abort` marks every id
 * cancelled (whether or not a stream is tracked at that moment: between model calls nothing is) and aborts the controllers that are. The loop checks
 * `cancelled` at the iteration top, after an aborted call and before every tool. Process memory only: a restart loses the mark (residual R5); the loop's
 * check of the fresh row status `cancelled` is the cross-process backstop, and nothing restarts a cancelled task.
 */
export class TaskRuns {
  private readonly controllers = new Map<string, Set<AbortController>>();
  private readonly marked = new Set<string>();

  /** `maxMarked`: bound of the cancelled set (the oldest mark is forgotten first; the row status still stops those runs). */
  constructor(private readonly maxMarked = 5000) {}

  /** Registers a stream's controller for `taskId`; the returned function removes it (idempotent). */
  track(taskId: string, ac: AbortController): () => void {
    let set = this.controllers.get(taskId);
    if (!set) this.controllers.set(taskId, (set = new Set()));
    set.add(ac);
    return () => {
      const cur = this.controllers.get(taskId);
      if (!cur) return;
      cur.delete(ac);
      if (!cur.size) this.controllers.delete(taskId);
    };
  }

  /** Marks `ids` cancelled and aborts their tracked streams. Returns how many streams were aborted. */
  abort(ids: readonly string[]): number {
    let n = 0;
    for (const id of ids) {
      this.marked.delete(id);
      this.marked.add(id); // re-inserted last: bounded eviction forgets the oldest
      for (const ac of this.controllers.get(id) ?? []) {
        ac.abort();
        n++;
      }
    }
    while (this.marked.size > this.maxMarked) this.marked.delete(this.marked.values().next().value as string);
    return n;
  }

  cancelled(taskId: string): boolean {
    return this.marked.has(taskId);
  }

  /** Whether a model call of this task is streaming right now. */
  active(taskId: string): boolean {
    return (this.controllers.get(taskId)?.size ?? 0) > 0;
  }
}
