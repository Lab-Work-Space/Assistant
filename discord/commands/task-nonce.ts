import { randomBytes } from 'node:crypto';

/**
 * TASKADMIN-1 (TA-C2): the confirm tokens of `/task cancel` and `/task done`. Held in process memory only (a restart invalidates them), bound to the user, the
 * subcommand, the target and the digest, single use (every lookup deletes the entry, a refused lookup too), valid 5 minutes, at most 100 entries: when full
 * the oldest is evicted. The id is 8 random bytes in hex; nothing about the task is derivable from it.
 */
export type NonceKind = 'cancel' | 'done';
export interface NonceEntry {
  kind: NonceKind; userId: string; targetId: string; digest: string;
  cascade: boolean;
  /** Cancel only: the admin's reason, already masked and cut (TA-C12). */
  reason: string | null;
  expiresAt: number;
}

export const NONCE_TTL_MS = 5 * 60_000;
export const NONCE_MAX = 100;

export class NonceStore {
  private readonly entries = new Map<string, NonceEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(e: Omit<NonceEntry, 'expiresAt'>): string {
    const t = this.now();
    for (const [k, v] of this.entries) if (v.expiresAt <= t) this.entries.delete(k);
    while (this.entries.size >= NONCE_MAX) this.entries.delete(this.entries.keys().next().value as string); // insertion order: the oldest
    let id: string;
    do id = randomBytes(8).toString('hex'); while (this.entries.has(id));
    this.entries.set(id, { ...e, expiresAt: t + NONCE_TTL_MS });
    return id;
  }

  /** Deletes `id` whatever the outcome; returns the entry only for the same user, an unexpired entry and (unless `any`) the same subcommand. */
  take(id: string, userId: string, kind: NonceKind | 'any'): NonceEntry | null {
    const e = this.entries.get(id);
    this.entries.delete(id);
    if (!e || e.expiresAt <= this.now() || e.userId !== userId || (kind !== 'any' && e.kind !== kind)) return null;
    return e;
  }

  get size(): number {
    return this.entries.size;
  }
}
