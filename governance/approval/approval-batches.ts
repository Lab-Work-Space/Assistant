import type { ApprovalBatch, ApprovalBatchRepo, BatchMember } from '../../db/repos/approval-batches.js';
import type { Approval } from '../../db/repos/ledger.js';

export { BATCH_MAX_ITEMS } from '../../db/repos/approval-batches.js';
export { itemsDigest } from '../canonical.js';

/** D3: how long the first eligible item waits for joiners before the card is posted. */
export const BATCH_WINDOW_MS = 10_000;

export interface BatchingDeps {
  repo: Pick<ApprovalBatchRepo, 'join' | 'seal' | 'get' | 'members' | 'markPosted' | 'dissolve' | 'close' | 'listOpen' | 'listUnposted' | 'listDue' | 'listStaleSealed'>;
  /** Default BATCH_WINDOW_MS; the same value drives the in-process timer and the join's DB-clock check. */
  windowMs?: number;
  expiryHours: () => number;
  /** G2AB-02: how often the sweep looks for batches nobody published (default 30 s). */
  sweepMs?: number;
  /** G2AB-02: a sealed batch without a recorded card is published by the sweep once it is this old (default 60 s). */
  stuckAfterMs?: number;
  /** B2/B7: whether this approval may be batched at all (a non-sensitive tool approval whose compact item fits). Never a copy of SENSITIVE_TOOL. */
  eligible: (a: Approval) => boolean;
  /** B2: whether the card still fits with `next` added. */
  fits: (members: Approval[], next: Approval) => boolean;
  /** Posts the batch card (hq head, today's #setting fallback); returns where it actually went. Throws when it cannot. */
  postBatch: (members: BatchMember[], batch: ApprovalBatch) => Promise<{ channelId: string; messageId: string }>;
  /** Today's solo card for one approval. */
  postSolo: (a: Approval) => Promise<void>;
  /** One code-written alert (ids only) to #bot-log. */
  alert: (text: string) => Promise<void>;
  log: { error(o: unknown, m?: string): void };
}

/**
 * Batches tool approvals of one task and one requester into one card (APPROVAL-BATCH-1). The first eligible item opens a batch and
 * starts an in-process timer; joiners within the window are added; the batch is sealed at the window end (or at 8 items) and then
 * posted by the single winner of the open -> sealed transition. Nothing joins after a card exists.
 */
export class ApprovalBatching {
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly publishing = new Set<number>();
  private readonly inflight = new Set<Promise<void>>();
  /** Batches whose card exists but could not be recorded: the sweep must not post them again (a restart may, an accepted duplicate). */
  private readonly unrecorded = new Set<number>();
  private stopped = false;
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly d: BatchingDeps) {}

  private get windowMs(): number {
    return this.d.windowMs ?? BATCH_WINDOW_MS;
  }

  /** 'batched': the approval is in a batch (its card comes with the batch). 'solo': the caller posts today's card now. */
  async enqueue(a: Approval): Promise<'batched' | 'solo'> {
    if (this.stopped || a.kind !== 'tool' || a.batchId != null || !this.d.eligible(a)) return 'solo';
    this.ensureSweeper();
    let r;
    try {
      r = await this.d.repo.join(a, { windowMs: this.windowMs, fits: this.d.fits });
    } catch (err) {
      this.d.log.error({ err }, 'joining an approval batch failed; posting a solo card');
      return 'solo';
    }
    for (const id of r.sealed) {
      this.clear(id);
      await this.publish(id);
    }
    if (r.kind === 'solo') return 'solo';
    if (r.opened && !r.sealed.includes(r.batchId)) this.startTimer(r.batchId);
    return 'batched';
  }

  /** Boot (and tests): seals every open batch and posts every sealed batch that has no card yet. */
  async flushAll(): Promise<void> {
    this.ensureSweeper();
    const handled = new Set<number>(); // a batch handled in this pass is not posted a second time (its card may exist with the record failed)
    for (const id of await this.d.repo.listOpen()) {
      this.clear(id);
      handled.add(id);
      await this.sealAndPublish(id);
    }
    for (const id of await this.d.repo.listUnposted()) if (!handled.has(id)) await this.publish(id);
  }

  /**
   * G2AB-02: publishes what a lost timer or a failed seal left behind: open batches whose window is over by the DB clock, and sealed
   * batches with no card for `stuckAfterMs`. A publish already in flight in this process is skipped (the `publishing` set).
   */
  async sweep(): Promise<void> {
    try {
      for (const id of await this.d.repo.listDue(this.windowMs)) {
        if (this.publishing.has(id)) continue;
        this.clear(id);
        await this.sealAndPublish(id);
      }
      for (const id of await this.d.repo.listStaleSealed(this.d.stuckAfterMs ?? 60_000)) if (!this.unrecorded.has(id)) await this.publish(id);
    } catch (err) {
      this.d.log.error({ err }, 'approval batch sweep failed');
    }
  }

  private ensureSweeper(): void {
    if (this.sweeper || this.stopped) return;
    this.sweeper = setInterval(() => {
      const p = this.sweep().finally(() => this.inflight.delete(p));
      this.inflight.add(p);
    }, this.d.sweepMs ?? 30_000);
    this.sweeper.unref?.();
  }

  /** Resolves when every flush started by a timer has finished. */
  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight]);
  }

  /** No new batches; every timer is cleared (open batches are sealed and posted by the next boot). */
  stop(): void {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }

  private clear(id: number): void {
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
  }

  private startTimer(id: number): void {
    const t = setTimeout(() => {
      this.timers.delete(id);
      const p = this.sealAndPublish(id).finally(() => this.inflight.delete(p));
      this.inflight.add(p);
    }, this.windowMs);
    t.unref?.();
    this.timers.set(id, t);
  }

  private async sealAndPublish(id: number): Promise<void> {
    try {
      if (await this.d.repo.seal(id)) await this.publish(id);
    } catch (err) {
      this.d.log.error({ err }, 'sealing an approval batch failed');
    }
  }

  /** Posts a sealed batch: a card for 2+ live items, today's solo card for one (D4), nothing for none; a failed post dissolves it (B9). Never throws. */
  private async publish(id: number): Promise<void> {
    if (this.publishing.has(id)) return;
    this.publishing.add(id);
    try {
      const b = await this.d.repo.get(id);
      if (!b || b.state !== 'sealed' || b.digest === null) return;
      const members = await this.d.repo.members(id, this.d.expiryHours());
      const live = members.filter((m) => m.live);
      if (live.length === 0) {
        await this.d.repo.close(id);
        return;
      }
      if (live.length === 1) {
        await this.d.repo.dissolve(id);
        await this.soloSafe(live[0]!);
        return;
      }
      let where: { channelId: string; messageId: string };
      try {
        where = await this.d.postBatch(members, b);
      } catch (err) {
        this.d.log.error({ err }, 'posting an approval batch card failed; posting solo cards');
        await this.d.repo.dissolve(id);
        for (const m of live) await this.soloSafe(m);
        await this.d.alert(`Approval batch #${id} could not be posted as one card; approvals ${live.map((m) => `#${m.id}`).join(', ')} were posted as separate cards.`)
          .catch((e: unknown) => this.d.log.error({ err: e }, 'approval batch alert failed'));
        return;
      }
      // The card exists now: a failure to record it is logged, never answered with a second set of cards (a restart would re-post it, accepted duplicate).
      await this.record(b, members, where);
    } catch (err) {
      this.d.log.error({ err }, 'publishing an approval batch failed');
    } finally {
      this.publishing.delete(id);
    }
  }

  /** G2AB-02: records the card (3 tries); when it cannot, one alert with ids only tells the admins the card's batch buttons will answer stale. */
  private async record(b: ApprovalBatch, members: BatchMember[], where: { channelId: string; messageId: string }): Promise<void> {
    let last: unknown;
    for (let i = 0; i < 3; i++) {
      try {
        await this.d.repo.markPosted(b.id, where.channelId, where.messageId); // false: the batch already left 'sealed' (nothing to record)
        return;
      } catch (err) {
        last = err;
        await new Promise((r) => setTimeout(r, 50 * (i + 1)));
      }
    }
    this.unrecorded.add(b.id);
    this.d.log.error({ err: last }, 'recording an approval batch card failed');
    await this.d.alert(`Approval batch #${b.id} (task ${b.taskId}) was posted but could not be recorded; its batch buttons will answer stale. Decide approvals ${members.map((m) => `#${m.id}`).join(', ')} one by one on the card, or restart the bot.`)
      .catch((e: unknown) => this.d.log.error({ err: e }, 'approval batch alert failed'));
  }

  private async soloSafe(a: Approval): Promise<void> {
    try {
      await this.d.postSolo(a);
    } catch (err) {
      this.d.log.error({ err }, 'solo approval card failed');
    }
  }
}
