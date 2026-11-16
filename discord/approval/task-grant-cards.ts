import type { TaskGrant, TaskRevokeReason, TaskGrantRepo } from '../../db/repos/task-grants.js';

/**
 * TREEGRANT-1 (TG-C17, TG-C18): keeps the card a task grant was made on honest. Two jobs:
 *  - the usage line (`Used 7/40 · write_file×3 ...`), edited in place at most once per debounce window (15 s). The row is re-read before each edit, and
 *    the edit is skipped when the grant is revoked, expired or its root ended; a close (`closed`) cancels any pending or queued edit for good.
 *  - closing the card when the grant ends (revoke, root end, halt, switch-off): a solo card loses its buttons, a batch card keeps them (its items may still be
 *    pending) and only its message content changes.
 * Every edit targets the card ids STORED on the grant row, never an id from a custom id. Nothing here throws into the caller.
 */
export interface TaskGrantCardPorts {
  /** Replaces only the message content (components stay). */
  note(channelId: string, messageId: string, text: string): Promise<void>;
  /** Replaces the content and removes every button. */
  close(channelId: string, messageId: string, text: string): Promise<void>;
}

export class TaskGrantCards {
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly ended = new Set<number>();
  private readonly inflight = new Map<number, Promise<void>>();

  constructor(private readonly o: {
    repo: Pick<TaskGrantRepo, 'editable'>;
    ports: TaskGrantCardPorts;
    /** The live card content of a grant row (usage line included). */
    text: (g: TaskGrant) => Promise<string>;
    /** The card content once the grant ended. */
    endedText: (g: TaskGrant, reason: TaskRevokeReason) => string;
    /** Whether the grant's card is a batch card (it keeps its buttons when the grant ends). */
    isBatchCard: (approvalId: number) => Promise<boolean>;
    log: { error(o: unknown, m: string): void };
    debounceMs?: number;
  }) {}

  /** A call was spent: schedule one edit within the debounce window (further calls inside it share it). */
  touch(grantId: number): void {
    if (this.ended.has(grantId) || this.timers.has(grantId)) return;
    const t = setTimeout(() => {
      this.timers.delete(grantId);
      const p = this.refresh(grantId).catch((err) => this.o.log.error({ err }, 'editing the task grant usage line failed')).finally(() => { if (this.inflight.get(grantId) === p) this.inflight.delete(grantId); });
      this.inflight.set(grantId, p);
    }, this.o.debounceMs ?? 15_000);
    t.unref?.();
    this.timers.set(grantId, t);
  }

  /** TG-C17: the grant is closed (revoked by anyone): cancel the pending edit, and stop any later one. Idempotent. */
  closed(grantId: number): void {
    this.ended.add(grantId);
    const t = this.timers.get(grantId);
    if (t) clearTimeout(t);
    this.timers.delete(grantId);
  }

  private async refresh(grantId: number): Promise<void> {
    if (this.ended.has(grantId)) return;
    const g = await this.o.repo.editable(grantId); // re-read: revoked, expired or root ended = skip
    if (!g || !g.cardChannelId || !g.cardMessageId || this.ended.has(grantId)) return;
    const text = await this.o.text(g);
    if (this.ended.has(grantId)) return; // a close that landed while the text was built wins
    await this.o.ports.note(g.cardChannelId, g.cardMessageId, text);
  }

  /** Grants were revoked (repo.onRevoked): close their cards. Waits for an edit already in flight so the close is the last write. */
  async revoked(rows: readonly TaskGrant[], reason: TaskRevokeReason): Promise<void> {
    for (const g of rows) this.closed(g.id);
    if (reason === 'admin') return; // the Revoke click edits its own card (and re-renders a batch card from the database); a second writer would race it
    await Promise.all(rows.map(async (g) => {
      try {
        await this.inflight.get(g.id);
        if (!g.cardChannelId || !g.cardMessageId) return;
        // the revoke row already carries the final counts: re-read nothing, the row is what the revoke returned
        const text = this.o.endedText(g, reason);
        if (await this.o.isBatchCard(g.approvalId)) await this.o.ports.note(g.cardChannelId, g.cardMessageId, text);
        else await this.o.ports.close(g.cardChannelId, g.cardMessageId, text);
      } catch (err) {
        this.o.log.error({ err }, 'closing a task grant card failed');
      }
    }));
  }
}
