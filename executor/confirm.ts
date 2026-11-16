import { randomBytes } from 'node:crypto';
import type { AuditFn } from '../governance/audit.js';

/**
 * The executor's own second confirmation (Gate 2 vps-deploy OD-G2-1, G2VD-03). After the normal card is confirmed (a click the MAIN application
 * receives, and whose database row the main application's role can write), the executor asks the decider again through LW ADMIN'S OWN Discord
 * identity: a button in a DM (or, when DMs are closed, in the card's channel) that only LW Admin's own interaction stream can deliver. The
 * main application has no LW Admin token and no LW Admin gateway, so it cannot produce this click; a forged database row alone never applies.
 *
 * The pending prompts live in this process's memory ONLY (never in the database): a restart drops them and the card, already claimed, must be
 * proposed again. Each prompt is single use, expires after 5 minutes, and is honoured only for the exact user id it was sent to, after a live
 * role recheck.
 */
export const CONFIRM_TTL_MS = 5 * 60_000;
export const CONFIRM_PREFIX = 'lwadmin2:';
const MAX_PENDING = 20;

export interface SecondRun {
  ok: boolean;
  lines: string[];
  applied?: number;
  total?: number;
  /** The checked card was refused on the second pass (as opposed to failing while running). */
  refused?: boolean;
}

export interface ConfirmPort {
  /** Sends the prompt with its button: a DM first, the card's channel when DMs are closed. null = neither worked. */
  send(p: { userId: string; channelId: string; token: string; text: string }): Promise<'dm' | 'channel' | null>;
}

export interface SecondRequest {
  cardId: string;
  /** The user who confirmed the card (the only one whose click counts). */
  userId: string;
  channelId: string;
  /** What will happen, written by code from the validated op (never model text). */
  summary: string;
  family: 'deploy' | 'server' | 'code';
  /** Gate 1 self-code X20: a longer wait than 5 minutes (the decider reads the diff first). */
  ttlMs?: number;
  /** Runs the checked card for real (the executor re-validates everything again inside). Called at most once, only after a valid click. */
  run: () => Promise<SecondRun>;
  /** Live recheck of the clicker (Bot Admin / the same tier as at confirm time); a string is the refusal. */
  recheck: (userId: string) => Promise<string | null>;
}

interface Pending extends SecondRequest { expiresAt: number }

export type ClickResult = { final: boolean; text: string };

export class SecondConfirm {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly d: { port: ConfirmPort; audit: AuditFn; log: { error(o: unknown, m?: string): void }; now?: () => number; token?: () => string; ttlMs?: number }) {}

  private now(): number { return (this.d.now ?? Date.now)(); }

  private sweep(): void {
    const t = this.now();
    for (const [k, p] of this.pending) if (p.expiresAt <= t) this.pending.delete(k);
  }

  size(): number { this.sweep(); return this.pending.size; }

  /** Sends the prompt. The card stays claimed either way; a failed send is a plain refusal the admin sees. */
  async request(r: SecondRequest): Promise<{ ok: true; where: 'dm' | 'channel'; ttlMinutes: number } | { ok: false; why: string }> {
    this.sweep();
    if (this.pending.size >= MAX_PENDING) return { ok: false, why: 'too many second confirmations are waiting; try again in a few minutes' };
    for (const p of this.pending.values()) if (p.cardId === r.cardId) return { ok: false, why: 'a second confirmation for this card is already waiting' };
    const token = (this.d.token ?? (() => randomBytes(16).toString('hex')))();
    const ttl = r.ttlMs ?? this.d.ttlMs ?? CONFIRM_TTL_MS;
    let text = `Second confirmation by LW Admin (card #${r.cardId.slice(0, 8)}, valid ${Math.round(ttl / 60_000)} minutes, one click):\n${r.summary}`;
    // A code summary is built to fit (X20: facts first, an explicit "+N more" marker); one that does not fit is refused, never cut silently.
    if (r.family === 'code' && text.length > 1800) return { ok: false, why: 'the confirmation text does not fit in one message; the change is too large to confirm' };
    if (r.family !== 'code') text = text.slice(0, 1800);
    let where: 'dm' | 'channel' | null = null;
    try {
      where = await this.d.port.send({ userId: r.userId, channelId: r.channelId, token, text });
    } catch (err) {
      this.d.log.error({ err: err instanceof Error ? err.name : 'error' }, 'second confirmation send failed');
    }
    if (!where) {
      await this.d.audit({ actor: `user:${r.userId} via lwadmin`, action: 'admin.confirm2', tool: r.family, outcome: `refused card:${r.cardId} could not be sent (DMs closed and the channel is not writable)` });
      return { ok: false, why: 'LW Admin could not send the second confirmation (your DMs are closed and it cannot post in the card channel); nothing was done' };
    }
    this.pending.set(token, { ...r, expiresAt: this.now() + ttl });
    await this.d.audit({ actor: `user:${r.userId} via lwadmin`, action: 'admin.confirm2', tool: r.family, outcome: `requested card:${r.cardId} via:${where}` });
    return { ok: true, where, ttlMinutes: Math.round(ttl / 60_000) };
  }

  /** A button click received on LW Admin's own interaction stream. `userId` is Discord's own value for the clicker. */
  async onClick(c: { token: string; userId: string }): Promise<ClickResult> {
    this.sweep();
    const p = /^[0-9a-f]{32}$/.test(c.token) ? this.pending.get(c.token) : undefined;
    if (!p) return { final: true, text: 'This confirmation has expired or was already used. Nothing was done.' };
    if (c.userId !== p.userId) {
      // Not consumed: the person it was sent to can still use it (a channel fallback is visible to others).
      await this.d.audit({ actor: `user:${c.userId} via lwadmin`, action: 'admin.confirm2', tool: p.family, outcome: `refused card:${p.cardId} wrong user` });
      return { final: false, text: 'Only the person who confirmed this card can use this button.' };
    }
    this.pending.delete(c.token); // single use, whatever happens next
    const why = await p.recheck(c.userId).catch((err: unknown) => {
      this.d.log.error({ err: err instanceof Error ? err.name : 'error' }, 'second confirmation recheck failed');
      return 'your role could not be checked (refused to be safe)';
    });
    if (why) {
      await this.d.audit({ actor: `user:${c.userId} via lwadmin`, action: 'admin.confirm2', tool: p.family, outcome: `refused card:${p.cardId} ${why.slice(0, 120)}` });
      return { final: true, text: `Refused: ${why}. Nothing was done.` };
    }
    await this.d.audit({ actor: `user:${c.userId} via lwadmin`, action: 'admin.confirm2', tool: p.family, outcome: `confirmed card:${p.cardId}` });
    try {
      const r = await p.run();
      await this.d.audit({ actor: `user:${c.userId} via lwadmin`, action: 'admin.confirm2', tool: p.family, outcome: `${r.ok ? 'applied' : 'failed'} card:${p.cardId}` });
      return { final: true, text: r.lines.join('\n').slice(0, 1800) || (r.ok ? 'Done.' : 'It did not complete.') };
    } catch (err) {
      this.d.log.error({ err: err instanceof Error ? err.name : 'error' }, 'second confirmation run failed');
      await this.d.audit({ actor: `user:${c.userId} via lwadmin`, action: 'admin.confirm2', tool: p.family, outcome: `failed card:${p.cardId}` });
      return { final: true, text: 'The change failed; it may be partly applied. Check #bot-log and the audit log.' };
    }
  }
}
