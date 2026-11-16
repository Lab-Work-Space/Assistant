import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AuditFn } from '../governance/audit.js';
import type { DashboardStore } from '../db/repos/dashboard.js';

export const COOKIE = 'lw_dash_sid';
const ROLE_RECHECK_MS = 5 * 60_000;
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX = 10;
const LOGIN_LOCK_MS = 5 * 60_000;
export const STEP_UP_MS = 10 * 60_000;

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const token = (): string => randomBytes(32).toString('base64url'); // 256 bits

/** Constant-time compare of two strings of any content or length: both sides are hashed first, so a non-ASCII or short value is just a mismatch. */
export function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

export interface AuthDeps {
  store: DashboardStore;
  audit: AuditFn;
  /** S47: re-fetches the member live through hq and says whether they hold the Bot Admin role. Must fail closed: a throw counts as false. */
  isAdmin(userId: string): Promise<boolean>;
  now?: () => number;
}

export interface Session {
  sid: string;
  userId: string;
  /** Per-session CSRF token (S44): derived from the session id, so it is not a cookie value and a page on another port cannot know it. */
  csrf: string;
  /** Server-side creation time of the session (set when the one-time link was consumed, never refreshed by activity). */
  createdAt: Date;
}

const csrfOf = (sid: string): string => sha256(`lw-dash-csrf:${sid}`);

/** Gate 1 S41-S43, S47, S51: one-time links, sessions, live role checks. Only hashes are stored; the audit never holds a token, session id or CSRF value. */
export class DashboardAuth {
  private attempts: number[] = [];
  private lockedUntil = 0;
  constructor(private readonly d: AuthDeps) {}
  private now(): number { return (this.d.now ?? Date.now)(); }

  /** `/dashboard`: a new one-time link token for an admin whose role the caller already checked (hq, C5). */
  async issueLink(userId: string): Promise<{ ok: true; token: string } | { ok: false; reason: 'rate' }> {
    const t = token();
    const r = await this.d.store.issueLink(userId, sha256(t));
    await this.d.audit({ actor: `user:${userId} via dashboard`, action: 'dashboard.link', outcome: r.ok ? 'issued' : 'refused:rate' });
    return r.ok ? { ok: true, token: t } : r;
  }

  /** S41: the POST of the Continue page. Rate limited server-wide (S51); the live role is checked before a session exists. */
  async login(linkToken: string): Promise<{ ok: true; sid: string } | { ok: false; reason: 'locked' | 'invalid' | 'role' }> {
    // S51 (amended): only REFUSED attempts count toward the lock, and a live unused token still logs in during a lock
    // (a 256-bit token cannot be guessed, so the lock protects nothing a valid token needs; it must not let a stranger lock the owner out).
    const fail = async (): Promise<{ ok: false; reason: 'locked' | 'invalid' }> => {
      const t = this.now();
      this.attempts = this.attempts.filter((x) => t - x < LOGIN_WINDOW_MS);
      this.attempts.push(t);
      if (this.attempts.length > LOGIN_MAX && t >= this.lockedUntil) {
        this.lockedUntil = t + LOGIN_LOCK_MS;
        await this.d.audit({ actor: 'system:dashboard', action: 'dashboard.login', outcome: 'refused:locked' });
      }
      await this.d.audit({ actor: 'system:dashboard', action: 'dashboard.consume', outcome: 'refused' });
      return { ok: false, reason: t < this.lockedUntil ? 'locked' : 'invalid' };
    };
    if (typeof linkToken !== 'string' || linkToken.length < 20 || linkToken.length > 100) return fail();
    const userId = await this.d.store.consumeLink(sha256(linkToken));
    if (!userId) return fail();
    await this.d.audit({ actor: `user:${userId} via dashboard`, action: 'dashboard.consume', outcome: 'ok' });
    if (!(await this.live(userId))) {
      await this.d.audit({ actor: `user:${userId} via dashboard`, action: 'dashboard.role', outcome: 'refused:no-role' });
      return { ok: false, reason: 'role' };
    }
    const sid = token(); // fresh on every login: a client-supplied id is never adopted (S43)
    await this.d.store.createSession(sha256(sid), userId);
    await this.d.audit({ actor: `user:${userId} via dashboard`, action: 'dashboard.session', outcome: 'created' });
    return { ok: true, sid };
  }

  private async live(userId: string): Promise<boolean> {
    try { return (await this.d.isAdmin(userId)) === true; } catch { return false; }
  }

  /**
   * A request's session. `forWrite` (S47) forces a live role fetch; a read page refreshes it at least every 5 minutes. A failed check
   * (no role, or the fetch failed) revokes every session of that user and refuses.
   */
  async session(sid: string | null, forWrite: boolean): Promise<Session | null> {
    if (!sid || sid.length < 20 || sid.length > 100) return null;
    const h = sha256(sid);
    const s = await this.d.store.touchSession(h);
    if (!s) return null;
    if (forWrite || this.now() - s.roleCheckedAt.getTime() >= ROLE_RECHECK_MS) {
      if (!(await this.live(s.userId))) {
        await this.d.store.revokeUser(s.userId);
        await this.d.audit({ actor: `user:${s.userId} via dashboard`, action: 'dashboard.role', outcome: 'refused:no-role sessions-revoked' });
        return null;
      }
      await this.d.store.markRoleChecked(h);
    }
    return { sid, userId: s.userId, csrf: csrfOf(sid), createdAt: s.createdAt };
  }

  /** E14: secret writes need a session created less than 10 minutes ago (a fresh /dashboard login). */
  stepUpOk(s: Session): boolean {
    const age = this.now() - s.createdAt.getTime();
    return age >= 0 && age < STEP_UP_MS;
  }

  csrfOk(s: Session, given: string): boolean {
    return sameSecret(s.csrf, given);
  }

  async logout(s: Session): Promise<void> {
    await this.d.store.revokeSession(sha256(s.sid));
    await this.d.audit({ actor: `user:${s.userId} via dashboard`, action: 'dashboard.session', outcome: 'revoked' });
  }

  async revokeAll(s: Session): Promise<number> {
    const n = await this.d.store.revokeUser(s.userId);
    await this.d.audit({ actor: `user:${s.userId} via dashboard`, action: 'dashboard.session', outcome: `revoked-all:${n}` });
    return n;
  }
}
