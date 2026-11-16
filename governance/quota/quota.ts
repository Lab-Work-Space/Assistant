import type { AlertKind, StoredQuota } from '../../db/repos/quota.js';
import { alertBackupUnavailable, alertEnd, alertEngage } from '../../providers/fallback-text.js';
import { QUOTA_WINDOWS, SHARED_WINDOWS, type QuotaSnapshot, type QuotaWindowName } from '../../providers/claude-code-local/quota.js';

/** USAGE-1: alert at or above this utilization (once per window and reset period), and when a window is rejected. */
export const QUOTA_ALERT_AT = 0.9;

export const WINDOW_LABEL: Record<QuotaWindowName, string> = { five_hour: '5-hour', seven_day: 'Weekly', seven_day_opus: 'Weekly (Opus)', seven_day_sonnet: 'Weekly (Sonnet)' };

export interface QuotaRepoPort {
  load(): Promise<StoredQuota | null>;
  save(s: QuotaSnapshot, observedAt: Date): Promise<void>;
  claimAlert(win: QuotaWindowName, resetsAt: number, kind: AlertKind, nowMs: number): Promise<boolean>;
  releaseAlert(win: QuotaWindowName, resetsAt: number, kind: AlertKind): Promise<void>;
}
type Log = { error(o: unknown, m?: string): void; info?(o: unknown, m?: string): void };

/** R8 PROV-FALLBACK: what the alerts need to know about the Claude API backup. Every read is guarded: a fault reads as "no backup" and today's text. */
export interface QuotaFallbackPort {
  /** The switch is on (read live, fail closed). */
  enabled(): boolean;
  /** The `claude` provider is registered (an API key is loaded). */
  keyed(): boolean;
  capUsd(): number;
  /** The backup served at least one call this hold episode. */
  used(): boolean;
  /** Claude API spend and calls today (UTC day), for the end alert. */
  spend(): Promise<{ usd: number; calls: number }>;
}

/** OPS-HOLD: a rejected window holds the Claude-backed bots until its reset plus this much. */
export const QUOTA_HOLD_GRACE_MS = 60_000;
/** OPS-HOLD: a top-level rejection that names no window (e.g. the CLI's overage type) holds this long from the observation. */
export const QUOTA_UNKNOWN_HOLD_MS = 15 * 60_000;

/**
 * OPS-HOLD: until when (epoch ms) Claude-backed work is held, derived only from the persisted snapshot, so a restart keeps it. Null when nothing is rejected, or when
 * the rejection is stale (its reset plus grace is already past: the snapshot is only refreshed by a call, and a held bot makes none).
 */
export function quotaHoldUntil(q: StoredQuota | null, nowMs: number): number | null {
  if (!q) return null;
  const s = q.snapshot;
  const ends: number[] = [];
  for (const n of SHARED_WINDOWS) {
    const w = s.windows[n];
    if (w?.status === 'rejected') ends.push(w.resetsAt * 1000 + QUOTA_HOLD_GRACE_MS);
  }
  if (s.status === 'rejected') {
    const named = s.rateLimitType && s.rateLimitType !== 'unknown' ? s.windows[s.rateLimitType] : undefined;
    ends.push(named ? named.resetsAt * 1000 + QUOTA_HOLD_GRACE_MS : q.observedAt.getTime() + QUOTA_UNKNOWN_HOLD_MS);
  }
  const live = ends.filter((e) => e > nowMs);
  return live.length ? Math.max(...live) : null;
}

/** The latest snapshot in memory, persisted on change, with the once-per-window-and-reset alert and the hold. Never throws to the caller. */
export class QuotaStore {
  private cur: StoredQuota | null = null;
  private timer: NodeJS.Timeout | null = null;
  private wasHeld = false;
  /** `onHoldEnd`: called once when a hold that was active ends (the reset passed, or a fresh snapshot lifted it). */
  constructor(private readonly o: {
    repo?: QuotaRepoPort; alert?: (title: string, body: string) => Promise<void>; timezone?: () => string; now?: () => number; onHoldEnd?: () => void; log: Log;
    /** R8 (PV-C03): called once on the not-held to held transition driven by a published snapshot (never by `load`, which runs before the scheduler exists, and never for a stale rejection). */
    onHoldStart?: () => void;
    fallback?: QuotaFallbackPort;
    /** R8: one `provider.fallback` audit row (`engaged` | `ended`); a failure is logged and ignored. */
    audit?: (outcome: string) => Promise<void>;
  }) {}

  private fb<T>(f: (p: QuotaFallbackPort) => T, dflt: T): T {
    try {
      return this.o.fallback ? f(this.o.fallback) : dflt;
    } catch {
      return dflt;
    }
  }

  private async auditFallback(outcome: string): Promise<void> {
    try {
      await this.o.audit?.(outcome);
    } catch {
      this.o.log.error({ stage: 'quota.audit' }, 'quota: fallback audit failed');
    }
  }

  async load(): Promise<void> {
    try {
      this.cur = (await this.o.repo?.load()) ?? this.cur;
    } catch {
      this.o.log.error({ stage: 'quota.load' }, 'quota: snapshot load failed');
    }
    this.arm(false);
  }

  /** OPS-HOLD: until when Claude-backed work is held (epoch ms), or null. */
  heldUntil(): number | null {
    return quotaHoldUntil(this.cur, (this.o.now ?? Date.now)());
  }

  /** Tracks hold start/end: arms a timer for the end while held; at the end (or when a fresh snapshot lifts it) posts one line and calls `onHoldEnd`. */
  private arm(fromPublish: boolean): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const nowMs = (this.o.now ?? Date.now)();
    const until = quotaHoldUntil(this.cur, nowMs);
    if (until !== null) {
      const starting = !this.wasHeld;
      this.wasHeld = true;
      this.timer = setTimeout(() => this.arm(false), Math.min(Math.max(until - nowMs, 1000), 2_000_000_000));
      this.timer.unref();
      if (starting && fromPublish) {
        try {
          this.o.onHoldStart?.();
        } catch {
          this.o.log.error({ stage: 'quota.holdStart' }, 'quota: hold start callback failed');
        }
      }
      return;
    }
    if (!this.wasHeld) return;
    this.wasHeld = false;
    this.o.log.info?.({ stage: 'quota.hold' }, 'quota: hold ended');
    // R8: with the backup switch on and a key loaded the end alert says the bots are back on the subscription (and the API spend when the backup ran); otherwise today's text.
    const backup = this.fb((p) => p.enabled() && p.keyed(), false);
    const used = backup ? this.fb((p) => p.used(), false) : false; // read now: the end callback clears the gate
    void (async () => {
      try {
        let body = 'The Claude quota hold is over. Claude-backed work has resumed.';
        if (backup) {
          let spent: { usd: number; calls: number } | null = null;
          if (used) {
            try {
              spent = (await this.o.fallback?.spend()) ?? null;
            } catch {
              spent = null;
            }
          }
          body = alertEnd(spent);
        }
        await this.o.alert?.('Claude subscription quota', body);
        if (backup) await this.auditFallback('ended');
      } catch {
        this.o.log.error({ stage: 'quota.alert' }, 'quota: hold-end notice failed');
      }
    })();
    try {
      this.o.onHoldEnd?.();
    } catch {
      this.o.log.error({ stage: 'quota.holdEnd' }, 'quota: hold end callback failed');
    }
  }

  latest(): StoredQuota | null {
    return this.cur;
  }

  /** Synchronous entry for the provider callback: memory first, persistence and alerts in the background. */
  publish(s: QuotaSnapshot): void {
    const nowMs = (this.o.now ?? Date.now)();
    const changed = !this.cur || JSON.stringify(this.cur.snapshot) !== JSON.stringify(s);
    this.cur = { snapshot: s, observedAt: new Date(nowMs) };
    this.arm(true);
    void this.after(s, nowMs, changed);
  }

  private async after(s: QuotaSnapshot, nowMs: number, changed: boolean): Promise<void> {
    if (changed) {
      try {
        await this.o.repo?.save(s, new Date(nowMs));
      } catch {
        this.o.log.error({ stage: 'quota.save' }, 'quota: snapshot save failed');
      }
    }
    try {
      await this.alerts(s, nowMs);
    } catch {
      this.o.log.error({ stage: 'quota.alert' }, 'quota: alert failed');
    }
  }

  private async alerts(s: QuotaSnapshot, nowMs: number): Promise<void> {
    if (!this.o.repo || !this.o.alert) return;
    const tz = this.o.timezone?.() ?? 'UTC';
    for (const name of QUOTA_WINDOWS) {
      const w = s.windows[name];
      if (!w) continue;
      const rejected = w.status === 'rejected' || (s.status === 'rejected' && s.rateLimitType === name);
      const kinds: AlertKind[] = [...(rejected ? (['rejected'] as const) : []), ...(w.utilization >= QUOTA_ALERT_AT ? (['high'] as const) : [])];
      for (const kind of kinds) {
        if (!(await this.o.repo.claimAlert(name, w.resetsAt, kind, nowMs))) continue;
        const label = WINDOW_LABEL[name];
        const when = `${resetText(w.resetsAt, tz)}`;
        // R8: with the switch on, A1 says the bots continue on the metered API (or that the backup is unavailable for lack of a key); switch off: today's text, byte for byte.
        const backupOn = kind === 'rejected' && this.fb((p) => p.enabled(), false);
        const engaged = backupOn && this.fb((p) => p.keyed(), false);
        const body = kind === 'rejected'
          ? engaged ? alertEngage({ label, capUsd: this.fb((p) => p.capUsd(), 0), when })
            : backupOn ? alertBackupUnavailable({ label, when })
            : `The ${label} Claude quota is used up. The bots will idle until ${when}.`
          : `The ${label} Claude quota is at ${pct(w.utilization)}. It resets ${when}.`;
        try {
          await this.o.alert('Claude subscription quota', body);
          if (engaged) await this.auditFallback('engaged');
        } catch {
          await this.o.repo.releaseAlert(name, w.resetsAt, kind); // retried on the next snapshot
          throw new Error('post failed');
        }
      }
    }
  }
}

export const pct = (u: number): string => `${(u * 100).toFixed(1)}%`;

function absolute(unix: number, tz: string): string {
  try {
    const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(unix * 1000);
    const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
    return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')} ${tz}`;
  } catch {
    return new Date(unix * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  }
}
export const resetText = (unix: number, tz: string): string => `<t:${unix}:R> (${absolute(unix, tz)})`;

/** The "Claude subscription (shared by the bots)" block: fixed format, numbers and enums only. */
export function quotaLines(q: StoredQuota | null, tz: string, nowMs: number = Date.now()): string[] {
  if (!q) return ['No data yet.'];
  const held = quotaHoldUntil(q, nowMs);
  const lines: string[] = held === null ? [] : [`Held: Claude-backed bots wait until ${resetText(Math.floor(held / 1000), tz)}`];
  lines.push(...QUOTA_WINDOWS.flatMap((n) => {
    const w = q.snapshot.windows[n];
    return w ? [`${WINDOW_LABEL[n]}: ${pct(w.utilization)} (${w.status}), resets ${resetText(w.resetsAt, tz)}`] : [];
  }));
  lines.push(`Observed <t:${Math.floor(q.observedAt.getTime() / 1000)}:R>`);
  return lines;
}
export const QUOTA_TITLE = 'Claude subscription (shared by the bots)';
