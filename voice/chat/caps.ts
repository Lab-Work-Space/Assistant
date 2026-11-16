import type { ConfigStore } from '../../config/store.js';

/**
 * P15 (Task 37): `limits.voiceMinPerUserDay` minutes of utterance audio sent to STT per human per UTC day. In memory by design,
 * like VisionCap and the per-user Praw counter: a restart forgets the day's count, which the company budget still bounds.
 */
export class VoiceMinuteCap {
  private day = '';
  private readonly used = new Map<string, number>();

  constructor(private readonly cfg: Pick<ConfigStore, 'get'>, private readonly now: () => number) {}

  private seconds(userId: string): number {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.used.clear();
    }
    return this.used.get(userId) ?? 0;
  }

  private limit(): number {
    return this.cfg.get('limits.voiceMinPerUserDay') * 60;
  }

  /** No audio of this user may be sent to STT today. */
  exhausted(userId: string): boolean {
    return this.seconds(userId) >= this.limit();
  }

  /** Counts `sec` seconds when the total stays within the cap; false (nothing counted) otherwise. */
  take(userId: string, sec: number): boolean {
    const total = this.seconds(userId) + sec;
    if (total > this.limit()) return false;
    this.used.set(userId, total);
    return true;
  }
}
