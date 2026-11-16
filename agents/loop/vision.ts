import type { ConfigStore } from '../../config/store.js';

/**
 * P15 (Task 34): `limits.visionPerUserDay` OCR / receipt extractions per human per UTC day. One slot per extraction, whatever
 * started it (chat, /ocr, /receipt, the auto-OCR channel): the tools take it, the entry points only peek to refuse early
 * without a model call. In memory by design (like the per-user Praw counter): a restart forgets the day's count, so the
 * worst case is one more cap's worth of extractions per user per restart, which the company budget still bounds.
 */
export class VisionCap {
  private day = '';
  private readonly used = new Map<string, number>();

  constructor(private readonly cfg: Pick<ConfigStore, 'get'>, private readonly now: () => number) {}

  private count(userId: string): number {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.used.clear();
    }
    return this.used.get(userId) ?? 0;
  }

  /** Whether the user may still extract today; consumes nothing. */
  peek(userId: string): boolean {
    return this.count(userId) < this.cfg.get('limits.visionPerUserDay');
  }

  /** Takes one slot when within the limit. */
  take(userId: string): boolean {
    if (!this.peek(userId)) return false;
    this.used.set(userId, this.count(userId) + 1);
    return true;
  }
}
