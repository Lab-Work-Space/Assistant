import { McpError } from './errors.js';

interface Waiter { slug: string; go(): void; timer: NodeJS.Timeout }

/**
 * Concurrency slots for MCP calls (spec 3.4 step 1, MC-C13): at most 2 containers at once, 1 per server, a wait of at most 15 s, and at most 8 waiters (the ninth
 * is E_BUSY at once). A slot is released once, in `finally`; the claimed counter is never refunded (that is the caller's rule, not ours).
 */
export class Slots {
  private readonly running = new Map<string, number>();
  private total = 0;
  private readonly queue: Waiter[] = [];
  private readonly o: { global: number; perServer: number; waitMs: number; maxWaiters: number };

  constructor(o: { global?: number; perServer?: number; waitMs?: number; maxWaiters?: number } = {}) {
    this.o = { global: o.global ?? 2, perServer: o.perServer ?? 1, waitMs: o.waitMs ?? 15_000, maxWaiters: o.maxWaiters ?? 8 };
  }

  state(): { running: number; waiting: number } {
    return { running: this.total, waiting: this.queue.length };
  }

  private free(slug: string): boolean {
    return this.total < this.o.global && (this.running.get(slug) ?? 0) < this.o.perServer;
  }

  private take(slug: string): { release(): void } {
    this.total++;
    this.running.set(slug, (this.running.get(slug) ?? 0) + 1);
    let done = false;
    return {
      release: () => {
        if (done) return;
        done = true;
        this.total--;
        const n = (this.running.get(slug) ?? 1) - 1;
        if (n <= 0) this.running.delete(slug);
        else this.running.set(slug, n);
        this.pump();
      },
    };
  }

  private pump(): void {
    for (let i = 0; i < this.queue.length; ) {
      const w = this.queue[i]!;
      if (this.free(w.slug)) {
        this.queue.splice(i, 1);
        clearTimeout(w.timer);
        w.go();
      } else i++;
    }
  }

  acquire(slug: string): Promise<{ release(): void }> {
    // G2-MCP-06: every queued waiter is blocked (pump runs on each release and acquire only queues when not free), so a free slug takes its slot at once instead of waiting behind another server's waiter.
    if (this.free(slug)) return Promise.resolve(this.take(slug));
    if (this.queue.length >= this.o.maxWaiters) return Promise.reject(new McpError('E_BUSY'));
    return new Promise((resolve, reject) => {
      const w: Waiter = {
        slug,
        go: () => resolve(this.take(slug)),
        timer: setTimeout(() => {
          const i = this.queue.indexOf(w);
          if (i >= 0) this.queue.splice(i, 1);
          reject(new McpError('E_BUSY'));
        }, this.o.waitMs),
      };
      this.queue.push(w);
    });
  }
}
