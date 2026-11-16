import { Events } from 'discord.js';

/** Gate 1 D9: the hq client may be offline this long before every agent loop pauses. */
export const HQ_OFFLINE_GRACE_MS = 60_000;

type Emitter = { on(event: string, fn: () => void): unknown };

const DOWN = [Events.ShardDisconnect, Events.ShardReconnecting, Events.Invalidated] as const;
const UP = [Events.ShardReady, Events.ShardResume] as const;

/**
 * Tracks whether the hq client (the only one serving /halt and approvals) is connected. Offline from construction
 * until `watch` gets a ready client, so an hq that never logs in also pauses the company after the grace period.
 */
export class HqPresence {
  private offlineSince: number | null;
  private readonly recover: (() => void)[] = [];

  constructor(private readonly now: () => number = Date.now, private readonly graceMs = HQ_OFFLINE_GRACE_MS) {
    this.offlineSince = now();
  }

  /** `client` is the started (ready) hq client, or undefined when it did not start. */
  watch(client: Emitter | undefined): void {
    if (!client) return;
    this.offlineSince = null;
    for (const e of DOWN) client.on(e, () => (this.offlineSince ??= this.now()));
    for (const e of UP) client.on(e, () => this.up());
  }

  online(): boolean {
    return this.offlineSince === null;
  }

  paused(): boolean {
    return this.offlineSince !== null && this.now() - this.offlineSince > this.graceMs;
  }

  /** Called when hq comes back after a pause, so work skipped meanwhile can be picked up. */
  onRecover(fn: () => void): void {
    this.recover.push(fn);
  }

  private up(): void {
    const wasPaused = this.paused();
    this.offlineSince = null;
    if (wasPaused) for (const fn of this.recover) fn();
  }
}
