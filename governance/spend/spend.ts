import { randomBytes } from 'node:crypto';
import type { OutboundPayload } from '../../agents/loop/payload.js';
import { localDay, type OffDay } from '../../company/calendar.js';
import type { ConfigStore } from '../../config/store.js';
import type { AppEvents, EventBus } from '../../core/events.js';
import type { IncidentSink } from '../../core/incidents.js';
import type { Pool } from '../../db/pool.js';
import type { AuditFn } from '../audit.js';
import { weeklyApiLine } from '../../providers/fallback-text.js';
import { cleanDept, monthStart, SPEND_MAX_USD } from './spend-shared.js';

export { SPEND_MAX_USD };

/**
 * SPEND-1: spend trends and department budget control. Three parts around one repository:
 *  - SpendOverrides: the department cap a human can raise for one month, from a card in #⚙️-setting (refuse-and-announce, no task waiter).
 *  - SpendWatch: a $0, model-free tick that warns, flags anomalies, projects the month and posts the weekly summary to #🧾-bot-log.
 *  - SpendRepo / report builders: the reads behind `/usage range:trend` and the dashboard `/spend` page.
 * Nothing here is reachable by a model: every spend.* config key is a handler key, an override is created only by code on a real refusal
 * and decided only by a live Bot Admin click (Gate 1 S1, S2). Posts carry numbers, department ids, provider/tool/model ids and `#<id8>` only.
 */

type Cfg = Pick<ConfigStore, 'get'>;
type Q = { query: Pool['query'] };
type Log = { error(o: unknown, m?: string): void; warn?(o: unknown, m?: string): void };

const DAY_MS = 86_400_000;
export const ALERT_MAX_ATTEMPTS = 3;
const SPARK = '▁▂▃▄▅▆▇█';

// ---- small pure helpers ------------------------------------------------------------------------------------------------------------------

export const usdText = (n: number): string => `$${n.toFixed(n < 1 && n !== 0 ? 4 : 2)}`;
const ceilCent = (x: number): number => Math.ceil(Number((x * 100).toFixed(6))) / 100;
const code = (s: string): string => `\`${s.replace(/[^A-Za-z0-9._:/#@-]/g, '').slice(0, 80)}\``;
const pctText = (a: number, b: number): string => (b > 0 ? `${a >= b ? '+' : '-'}${Math.round((Math.abs(a - b) / b) * 100)}%` : a > 0 ? 'new' : '0%');

/** `YYYY-MM-DD` + n days (calendar arithmetic on the date itself, never on a clock). */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export const daysInMonth = (month: string): number => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

/** The ISO week of a local date as `YYYY-Www`, using the ISO week-YEAR (2027-01-01 is `2026-W53`; Gate 1 SP-10). */
export function isoWeekKey(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  const wd = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - wd); // the Thursday of this ISO week decides the year
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / DAY_MS + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}
/** The Monday (`YYYY-MM-DD`) of an ISO week key. */
export function isoWeekMonday(key: string): string {
  const [, ys, ws] = /^(\d{4})-W(\d{2})$/.exec(key) ?? [];
  const jan4 = new Date(Date.UTC(Number(ys), 0, 4));
  const monday = jan4.getTime() - ((jan4.getUTCDay() || 7) - 1) * DAY_MS + (Number(ws) - 1) * 7 * DAY_MS;
  return new Date(monday).toISOString().slice(0, 10);
}

const timeFormats = new Map<string, Intl.DateTimeFormat>();
/** `HH:MM` of instant `now` on the wall clock of `tz`. */
export function localTime(now: number, tz: string): string {
  let f = timeFormats.get(tz);
  if (!f) timeFormats.set(tz, (f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })));
  return f.format(now);
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length === 0 ? 0 : s.length % 2 ? s[h]! : (s[h - 1]! + s[h]!) / 2;
};

// ---- rows ---------------------------------------------------------------------------------------------------------------------------------

export type TrendRow = { day: string; deptId: string; provider: string; tool: string; usd: number; calls: number };
export type RootRow = { rootId: string; deptId: string; usd: number };
export type AlertKind = 'warn' | 'stop' | 'anomaly' | 'projection' | 'summary';
export type AlertRow = { period: string; kind: AlertKind; scopeId: string; detail: Record<string, unknown> | null; attempts: number; postedAt: Date | null; claimedAt: Date };
export type OverrideRow = {
  id: string; deptId: string; month: string; oldCapUsd: number; newCapUsd: number; status: 'pending' | 'approved' | 'rejected' | 'expired';
  channelId: string; messageId: string | null; createdAt: Date; expiresAt: Date; decidedBy: string | null; decidedAt: Date | null;
};
const OVR_COLS = `id, dept_id AS "deptId", to_char(month,'YYYY-MM-DD') AS month, old_cap_usd::float8 AS "oldCapUsd", new_cap_usd::float8 AS "newCapUsd", status,
  channel_id AS "channelId", message_id AS "messageId", created_at AS "createdAt", expires_at AS "expiresAt", decided_by AS "decidedBy", decided_at AS "decidedAt"`;

/** Reads and claims over the three SPEND-1 tables. Every statement is parameterised; the trend group column never comes from input. */
export class SpendRepo {
  constructor(readonly pool: Pool) {}

  async trend(from: string, to: string): Promise<TrendRow[]> {
    return (await this.pool.query<TrendRow>(
      `SELECT to_char(day,'YYYY-MM-DD') AS day, dept_id AS "deptId", provider, tool, sum(spent_usd)::float8 AS usd, sum(calls)::int AS calls
       FROM spend_days WHERE day BETWEEN $1::date AND $2::date GROUP BY day, dept_id, provider, tool ORDER BY day`,
      [from, to],
    )).rows;
  }

  /** The top task trees by spend in a window (the id only, never a title). */
  async topRoots(from: string, to: string, limit: number): Promise<RootRow[]> {
    return (await this.pool.query<RootRow>(
      `SELECT root_id AS "rootId", dept_id AS "deptId", sum(spent_usd)::float8 AS usd FROM spend_days
       WHERE day BETWEEN $1::date AND $2::date AND root_id <> '' GROUP BY root_id, dept_id ORDER BY usd DESC, root_id LIMIT $3`,
      [from, to, limit],
    )).rows;
  }

  /** The enforced month-to-date per department: the dept row of budget_days (SP-08). */
  async deptMtd(month: string): Promise<Map<string, { spent: number; reserved: number }>> {
    const r = await this.pool.query<{ id: string; spent: number; reserved: number }>(
      "SELECT scope_id AS id, spent_usd::float8 AS spent, reserved_usd::float8 AS reserved FROM budget_days WHERE day = $1::date AND scope = 'dept'", [month]);
    return new Map(r.rows.map((x) => [x.id, { spent: x.spent, reserved: x.reserved }]));
  }

  async claim(period: string, kind: AlertKind, scopeId: string, detail: Record<string, unknown>): Promise<boolean> {
    const r = await this.pool.query('INSERT INTO spend_alerts (period, kind, scope_id, detail) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [period, kind, scopeId, JSON.stringify(detail)]);
    return (r.rowCount ?? 0) === 1;
  }
  /** SP-11: the attempt is counted BEFORE the post, so a crash during the post cannot retry forever. Null: already posted or out of attempts. */
  async beginAttempt(period: string, kind: AlertKind, scopeId: string): Promise<number | null> {
    const r = await this.pool.query<{ attempts: number }>(
      'UPDATE spend_alerts SET attempts = attempts + 1 WHERE period = $1 AND kind = $2 AND scope_id = $3 AND posted_at IS NULL AND attempts < $4 RETURNING attempts', [period, kind, scopeId, ALERT_MAX_ATTEMPTS]);
    return r.rows[0]?.attempts ?? null;
  }
  async markPosted(period: string, kind: AlertKind, scopeId: string): Promise<void> {
    await this.pool.query('UPDATE spend_alerts SET posted_at = now() WHERE period = $1 AND kind = $2 AND scope_id = $3', [period, kind, scopeId]);
  }
  /** Claims not yet posted and at least `minAgeMs` old (database time): a claim being posted right now is not picked up by the retry pass (G2SP-02). */
  async unposted(minAgeMs = 0): Promise<AlertRow[]> {
    return (await this.pool.query<AlertRow>(
      `SELECT period, kind, scope_id AS "scopeId", detail, attempts, posted_at AS "postedAt", claimed_at AS "claimedAt" FROM spend_alerts
       WHERE posted_at IS NULL AND attempts < $1 AND claimed_at <= now() - $2::float8 * interval '1 millisecond' ORDER BY claimed_at LIMIT 20`, [ALERT_MAX_ATTEMPTS, minAgeMs])).rows;
  }
  async lastAlerts(limit: number): Promise<AlertRow[]> {
    return (await this.pool.query<AlertRow>(
      `SELECT period, kind, scope_id AS "scopeId", detail, attempts, posted_at AS "postedAt", claimed_at AS "claimedAt" FROM spend_alerts ORDER BY claimed_at DESC LIMIT $1`, [limit])).rows;
  }

  async overridesOf(month: string): Promise<OverrideRow[]> {
    return (await this.pool.query<OverrideRow>(`SELECT ${OVR_COLS} FROM spend_overrides WHERE month = $1::date ORDER BY created_at DESC`, [month])).rows;
  }
  async recentOverrides(limit: number): Promise<OverrideRow[]> {
    return (await this.pool.query<OverrideRow>(`SELECT ${OVR_COLS} FROM spend_overrides ORDER BY created_at DESC LIMIT $1`, [limit])).rows;
  }
  async override(id: string): Promise<OverrideRow | null> {
    return (await this.pool.query<OverrideRow>(`SELECT ${OVR_COLS} FROM spend_overrides WHERE id = $1`, [id])).rows[0] ?? null;
  }

  /** Once per local day: old rollup days, old claims, and pending overrides whose time is up. */
  async prune(oldestDay: string, now: Date): Promise<void> {
    await this.pool.query('DELETE FROM spend_days WHERE day < $1::date', [oldestDay]);
    await this.pool.query("DELETE FROM spend_alerts WHERE claimed_at < $1::timestamptz - interval '400 days'", [now]);
    await this.pool.query("UPDATE spend_overrides SET status = 'expired' WHERE status = 'pending' AND expires_at <= $1::timestamptz", [now]);
  }
}

// ---- alerts: claim first, count the attempt, post ----------------------------------------------------------------------------------------------

export type SpendPorts = {
  /** A governance embed to #🧾-bot-log (never pings: type `config`). */
  alert(p: OutboundPayload): Promise<void>;
};

const NAMEOK = /^[a-z_]{1,32}$/;
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const word = (v: unknown, fallback: string): string => (typeof v === 'string' && NAMEOK.test(v) ? v : fallback);

/** The text of one alert, rebuilt from its stored numbers and enum strings only (SP-11). A retry therefore re-renders exactly the same content. */
export function renderAlert(kind: Exclude<AlertKind, 'summary'>, period: string, scopeId: string, d: Record<string, unknown>): OutboundPayload {
  const dept = word(d.dept, cleanDept(scopeId.split(':')[0]));
  const month = period.slice(0, 7);
  let title = '';
  let body = '';
  if (kind === 'stop') {
    const out = d.outcome === 'rejected' ? 'rejected' : d.outcome === 'max' ? 'max' : d.outcome === 'failed' ? 'failed' : 'card';
    title = 'Department budget used up';
    body = `Department ${code(dept)} used its monthly budget for ${month}: ${usdText(num(d.usedUsd))} of ${usdText(num(d.capUsd))}. Its bots make no more paid model calls this month.`
      + (out === 'card' ? ' A Bot Admin can approve a raise in #⚙️-setting.' : out === 'rejected' ? ' A raise was already rejected this month; a Bot Admin can set a new cap with `/budget dept`.' : out === 'failed' ? ' The raise card could not be posted; it is offered again on the next refused call, or set a new cap with `/budget dept`.' : ' The cap is already at the maximum.');
  } else if (kind === 'warn') {
    title = 'Department budget warning';
    body = `Department ${code(dept)} used ${num(d.pct)}% of its monthly budget for ${month}: ${usdText(num(d.spentUsd))} of ${usdText(num(d.capUsd))}.`;
  } else if (kind === 'projection') {
    title = 'Department budget projection';
    body = `At the 7-day pace department ${code(dept)} will pass its monthly budget for ${month}: projected ${usdText(num(d.projUsd))} against ${usdText(num(d.capUsd))} (month to date ${usdText(num(d.mtdUsd))}).`;
  } else {
    title = 'Unusual spend today';
    const who = scopeId === '_company' ? 'The company' : `Department ${code(dept)}`;
    body = `${who} spent ${usdText(num(d.todayUsd))} so far on ${period}, above the usual: median of the last 7 days ${usdText(num(d.medianUsd))}, alert level ${usdText(num(d.levelUsd))}.`;
  }
  return { type: 'config', origin: 'governance', title, body };
}

/** A claim must be this old before the retry pass touches it (G2SP-02): longer than any post. */
export const RETRY_MIN_AGE_MS = 120_000;

export class SpendAlerts {
  private readonly inFlight = new Set<string>();
  constructor(private readonly repo: SpendRepo, private readonly ports: SpendPorts, private readonly log: Log, private readonly incidents?: IncidentSink, private readonly render?: (r: { period: string; kind: AlertKind; scopeId: string; detail: Record<string, unknown> }) => Promise<OutboundPayload>, private readonly retryAfterMs = RETRY_MIN_AGE_MS) {}

  private async payload(period: string, kind: AlertKind, scopeId: string, detail: Record<string, unknown>): Promise<OutboundPayload> {
    if (kind === 'summary') {
      if (!this.render) throw new Error('no summary renderer');
      return this.render({ period, kind, scopeId, detail });
    }
    return renderAlert(kind, period, scopeId, detail);
  }

  /** Claim (durable, survives a restart) then post. True when this call claimed it. Posting failures never throw. */
  async deliver(period: string, kind: AlertKind, scopeId: string, detail: Record<string, unknown>): Promise<boolean> {
    if (!(await this.repo.claim(period, kind, scopeId, detail))) return false;
    await this.attempt(period, kind, scopeId, detail);
    return true;
  }

  async attempt(period: string, kind: AlertKind, scopeId: string, detail: Record<string, unknown>): Promise<void> {
    const key = `${period}|${kind}|${scopeId}`;
    if (this.inFlight.has(key)) return; // being posted right now (G2SP-02)
    this.inFlight.add(key);
    try {
      await this.attemptOnce(period, kind, scopeId, detail);
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async attemptOnce(period: string, kind: AlertKind, scopeId: string, detail: Record<string, unknown>): Promise<void> {
    const n = await this.repo.beginAttempt(period, kind, scopeId);
    if (n === null) return;
    try {
      await this.ports.alert(await this.payload(period, kind, scopeId, detail));
      await this.repo.markPosted(period, kind, scopeId);
    } catch (err) {
      this.log.error({ kind, period, attempt: n, err: err instanceof Error ? err.name : 'error' }, 'spend alert post failed');
      if (n >= ALERT_MAX_ATTEMPTS) {
        this.log.error({ kind, period }, 'spend alert given up after 3 attempts');
        try { this.incidents?.report({ source: 'spend', stage: 'alert post', err: new Error(`the ${kind} alert for ${period} could not be posted after ${ALERT_MAX_ATTEMPTS} attempts`) }); } catch { /* diagnostics only */ }
      }
    }
  }

  /** Alerts claimed but not posted (a failed post, or a crash after the claim): another attempt each tick until three. */
  async retry(): Promise<void> {
    for (const a of await this.repo.unposted(this.retryAfterMs)) await this.attempt(a.period, a.kind, a.scopeId, a.detail ?? {});
  }
}

/**
 * The cap that applies to (dept, local month): Infinity when the config has none, else max(config, the approved overrides of that month).
 * `q` is the reserving transaction's client (Gate 1 S9: never a second pooled connection while row locks are held). This is the Budget's `deptCap`.
 */
export async function effectiveDeptCap(cfg: Cfg, dept: string, month: string, q: Q): Promise<number> {
  const v = (cfg.get('spend.deptMonthlyUsd') as Record<string, number | undefined>)[dept];
  if (typeof v !== 'number' || !Number.isFinite(v)) return Infinity;
  const r = await q.query<{ m: number | null }>("SELECT max(new_cap_usd)::float8 AS m FROM spend_overrides WHERE dept_id = $1 AND month = $2::date AND status = 'approved'", [dept, month]);
  return Math.max(v, r.rows[0]?.m ?? 0);
}

// ---- overrides ----------------------------------------------------------------------------------------------------------------------------

export type OverrideDeps = {
  pool: Pool;
  cfg: Cfg;
  clock: () => number;
  /** The #⚙️-setting channel id (the card's only home). */
  configChannelId: string;
  ports: {
    /** Posts the governance card (with approve/reject buttons for `spendOverrideId`) as hq in the config channel; returns the message id. */
    postCard(payload: OutboundPayload): Promise<string>;
  };
  alerts: SpendAlerts;
  audit: AuditFn;
  log: Log;
};

export type StopEvent = { dept?: string; day: string; estUsd?: number };
export type DecideInput = { id: string; action: 'approve' | 'reject'; userId: string; channelId: string | null; messageId: string | null };
export type Decided = { ok: true; row: OverrideRow } | { ok: false; text: string };

export class SpendOverrides {
  private readonly stopping = new Set<string>();
  constructor(private readonly d: OverrideDeps) {}

  effectiveCap(dept: string, month: string, q: Q = this.d.pool): Promise<number> {
    return effectiveDeptCap(this.d.cfg, dept, month, q);
  }

  /** The local month key of now. */
  month(): string {
    return monthStart(localDay(this.d.clock(), this.d.cfg.get('schedule.timezone')).date);
  }

  /**
   * governance.paused scope 'dept' (every refusal, SP-02). Expires stale pending rows, then, in the same transaction, inserts the one pending raise
   * (the partial unique index is the only dedupe). A rejected raise this month, or a cap at the maximum, gets the log alert and no card.
   */
  async onStop(e: StopEvent): Promise<void> {
    const dept = cleanDept(e.dept);
    if (dept === '_unattributed' || !/^\d{4}-\d{2}-01$/.test(e.day)) return;
    // G2SP-03: a burst of refusals runs one onStop per (dept, month) at a time; the one in flight already makes the card.
    const key = `${dept}|${e.day}`;
    if (this.stopping.has(key)) return;
    this.stopping.add(key);
    try {
      await this.stop(e, dept);
    } finally {
      this.stopping.delete(key);
    }
  }

  private async stop(e: StopEvent, dept: string): Promise<void> {
    const month = e.day;
    // G2SP-01: a refusal of the month that just ended (handled after local midnight) offers no raise: an approval for that month could never apply.
    if (month < this.month()) return;
    const est = typeof e.estUsd === 'number' && Number.isFinite(e.estUsd) && e.estUsd >= 0 ? e.estUsd : 0;
    const tz = this.d.cfg.get('schedule.timezone');
    const nowTs = new Date(this.d.clock());
    const client = await this.d.pool.connect();
    let outcome: 'card' | 'rejected' | 'max' | 'pending' = 'pending';
    let eff = 0;
    let used = 0;
    let newCap = 0;
    let id = '';
    try {
      await client.query('BEGIN');
      // SP-03: a pending row past its time must not hold the unique index until the daily prune.
      await client.query("UPDATE spend_overrides SET status = 'expired' WHERE dept_id = $1 AND month = $2::date AND status = 'pending' AND expires_at <= $3::timestamptz", [dept, month, nowTs]);
      eff = await this.effectiveCap(dept, month, client);
      if (!Number.isFinite(eff)) { await client.query('ROLLBACK'); return; } // the cap was cleared meanwhile: nothing to raise
      const dr = await client.query<{ spent: number; reserved: number }>("SELECT spent_usd::float8 AS spent, reserved_usd::float8 AS reserved FROM budget_days WHERE day = $1::date AND scope = 'dept' AND scope_id = $2", [month, dept]);
      used = (dr.rows[0]?.spent ?? 0) + (dr.rows[0]?.reserved ?? 0);
      const decided = await client.query<{ status: string }>("SELECT status FROM spend_overrides WHERE dept_id = $1 AND month = $2::date AND status IN ('approved','rejected') ORDER BY decided_at DESC NULLS LAST LIMIT 1", [dept, month]);
      if (decided.rows[0]?.status === 'rejected') outcome = 'rejected';
      else {
        const step = this.d.cfg.get('spend.overrideStepPct');
        newCap = Math.min(ceilCent(Math.max(used + est, Math.max(eff, 1) * (1 + step / 100))), SPEND_MAX_USD);
        if (eff >= SPEND_MAX_USD || newCap <= eff) outcome = 'max';
        else {
          id = randomBytes(16).toString('hex');
          const hours = this.d.cfg.get('approval.expiryHours');
          const ins = await client.query(
            `INSERT INTO spend_overrides (id, dept_id, month, old_cap_usd, new_cap_usd, channel_id, created_at, expires_at)
             VALUES ($1, $2, $3::date, $4, $5, $6, $7::timestamptz,
               least($7::timestamptz + $8::float8 * interval '1 hour', ((date_trunc('month', $7::timestamptz AT TIME ZONE $9) + interval '1 month') AT TIME ZONE $9)))
             ON CONFLICT DO NOTHING`,
            [id, dept, month, eff, newCap, this.d.configChannelId, nowTs, hours, tz],
          );
          outcome = (ins.rowCount ?? 0) === 1 ? 'card' : 'pending';
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    if (outcome === 'pending') return; // a raise is already waiting: its card and alert exist
    // The card first (SP-03): a failure anywhere after the insert must end in a posted card or an expired row, never a stranded pending one.
    let said: 'card' | 'rejected' | 'max' | 'failed' = outcome;
    if (outcome === 'card') {
      const step = this.d.cfg.get('spend.overrideStepPct');
      try {
        const messageId = await this.d.ports.postCard({
          type: 'approval', origin: 'governance', title: 'Department budget raise', spendOverrideId: id,
          body: `Department ${code(dept)} used up its monthly budget for ${month.slice(0, 7)}. Approve to raise the cap for this month only; it falls back at month end. A refused run is not resumed: ask again after approving.`,
          fields: [
            { name: 'Department', value: code(dept) },
            { name: 'Month to date', value: usdText(used) },
            { name: 'Cap', value: `${usdText(eff)} → ${usdText(newCap)}` },
            { name: 'Step', value: `${step}%` },
          ],
        });
        await this.d.pool.query("UPDATE spend_overrides SET message_id = $2 WHERE id = $1 AND status = 'pending'", [id, messageId]);
      } catch (err) {
        said = 'failed';
        this.d.log.error({ err: err instanceof Error ? err.name : 'error' }, 'spend override card post failed');
        // SP-03: a failed post must not leave a pending row that blocks the next stop.
        await this.d.pool.query("UPDATE spend_overrides SET status = 'expired' WHERE id = $1 AND status = 'pending'", [id]).catch(() => undefined);
      }
    }
    // The stop alert is claimed per (month, dept, cap level, outcome): one per stop, and a new one after an approved raise is used up (SP-02).
    // Its failure (a claim that cannot be written) is logged and never undoes the card.
    try {
      await this.d.alerts.deliver(month.slice(0, 7), 'stop', `${dept}:${Math.round(eff * 100)}${said === 'card' ? '' : `:${said[0]}`}`, { dept, capUsd: eff, usedUsd: used, outcome: said });
    } catch (err) {
      this.d.log.error({ err: err instanceof Error ? err.name : 'error' }, 'spend stop alert failed');
    }
  }

  /** The button click (the guard already checked the guild, #⚙️-setting and the live Bot Admin role). One winner: the conditional UPDATE. */
  async decide(c: DecideInput): Promise<Decided> {
    const gone = { ok: false as const, text: 'That raise expired or was already decided.' };
    if (!/^[0-9a-f]{32}$/.test(c.id)) return { ok: false, text: 'Unknown action.' };
    const row = await new SpendRepo(this.d.pool).override(c.id);
    if (!row || row.messageId === null || row.messageId !== c.messageId || row.channelId !== this.d.configChannelId || c.channelId !== this.d.configChannelId) return { ok: false, text: 'Unknown action.' };
    const status = c.action === 'approve' ? 'approved' : 'rejected';
    const r = await this.d.pool.query<{ id: string }>(
      "UPDATE spend_overrides SET status = $2, decided_by = $3, decided_at = $4::timestamptz WHERE id = $1 AND status = 'pending' AND expires_at > $4::timestamptz RETURNING id",
      [c.id, status, c.userId, new Date(this.d.clock())],
    );
    if (!r.rows[0]) return gone;
    await this.d.audit({ actor: `user:${c.userId}`, action: 'spend.override', tool: row.deptId, outcome: `${status} cap=${row.oldCapUsd}->${row.newCapUsd} ${row.deptId} ${row.month.slice(0, 7)}` });
    return { ok: true, row: { ...row, status, decidedBy: c.userId } };
  }

  /** SP-05 / G2SP-04: a human changed (or cleared) the department's cap, so this month's overrides stop applying and an earlier rejection no longer blocks a new raise card. Returns how many rows ended. */
  async supersede(dept: string, userId: string): Promise<{ count: number; cards: { channelId: string; messageId: string }[] }> {
    const month = this.month();
    const r = await this.d.pool.query<{ message_id: string | null; channel_id: string }>(
      "UPDATE spend_overrides SET status = 'expired' WHERE dept_id = $1 AND month = $2::date AND status IN ('pending','approved','rejected') RETURNING message_id, channel_id", [dept, month]);
    if (r.rows.length)
      await this.d.audit({ actor: `user:${userId}`, action: 'spend.override', tool: dept, outcome: `superseded ${r.rows.length} ${dept} ${month.slice(0, 7)}` });
    return { count: r.rows.length, cards: r.rows.filter((x) => x.message_id !== null).map((x) => ({ channelId: x.channel_id, messageId: x.message_id! })) };
  }
}

/** The app wiring: a dept refusal starts onStop in the background (never awaited by reserve, SP-12); a failure is logged only. */
export function bindSpendStop(bus: EventBus<AppEvents>, overrides: Pick<SpendOverrides, 'onStop'>, log: Log): () => void {
  return bus.on('governance.paused', (e) => {
    if (e.scope !== 'dept') return;
    void overrides.onStop({ ...(e.dept !== undefined ? { dept: e.dept } : {}), day: e.day, ...(e.estUsd !== undefined ? { estUsd: e.estUsd } : {}) })
      .catch((err: unknown) => log.error({ err: err instanceof Error ? err.name : 'error' }, 'spend stop handling failed'));
  });
}

// ---- the report (trend view, weekly summary) ----------------------------------------------------------------------------------------------

export type GroupBy = 'dept' | 'provider' | 'tool';
export type Report = { body: string; fields: { name: string; value: string }[] };
const FIELD_VALUE_MAX = 1024;
const MESSAGE_MAX = 6000;
const GROUP_FIELDS_MAX = 23;

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

export type ReportInput = {
  rows: TrendRow[];
  today: string;
  by: GroupBy;
  /** dept -> enforced month-to-date (the dept row) and its effective cap (Infinity = none). */
  budgets: { dept: string; mtd: number; cap: number; raisedFrom?: number }[];
  roots: RootRow[];
};

/** Builds the trend text from rows only (spend_days) plus the budget list; every id is code-formatted and every size is bounded. */
export function buildReport(i: ReportInput): Report {
  const { today, rows } = i;
  const month = monthStart(today);
  const dim = daysInMonth(month);
  const dom = Number(today.slice(8, 10));
  const win = (a: number, b: number) => (r: TrendRow) => r.day >= addDays(today, -b) && r.day <= addDays(today, -a);
  const total = (f: (r: TrendRow) => boolean) => sum(rows.filter(f).map((r) => r.usd));
  const d7 = total(win(0, 6));
  const p7 = total(win(7, 13));
  const d30 = total(win(0, 29));
  const mtd = total((r) => r.day >= month && r.day <= today);
  const mean7 = total(win(1, 7)) / 7; // the last 7 complete days
  const proj = mtd + mean7 * (dim - dom);
  const body = `MTD ${usdText(mtd)} · 7d ${usdText(d7)} (prev 7d ${usdText(p7)}, ${pctText(d7, p7)}) · 30d ${usdText(d30)} · projected month end ${usdText(proj)}`;

  const key = (r: TrendRow): string => (i.by === 'dept' ? r.deptId : i.by === 'provider' ? r.provider : r.tool);
  const groups = new Map<string, TrendRow[]>();
  for (const r of rows) {
    const k = key(r);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }
  const budget = new Map(i.budgets.map((b) => [b.dept, b]));
  const ranked = [...groups].map(([name, rs]) => ({ name, rs, d30: sum(rs.map((r) => r.usd)) })).sort((a, b) => b.d30 - a.d30 || a.name.localeCompare(b.name));
  const fields: { name: string; value: string }[] = [];
  for (const g of ranked.slice(0, GROUP_FIELDS_MAX)) {
    const g7 = sum(g.rs.filter(win(0, 6)).map((r) => r.usd));
    const gp7 = sum(g.rs.filter(win(7, 13)).map((r) => r.usd));
    const gm = sum(g.rs.filter((r) => r.day >= month && r.day <= today).map((r) => r.usd));
    const gmean = sum(g.rs.filter(win(1, 7)).map((r) => r.usd)) / 7;
    const days14 = Array.from({ length: 14 }, (_, n) => addDays(today, n - 13)).map((day) => sum(g.rs.filter((r) => r.day === day).map((r) => r.usd)));
    const top = Math.max(...days14);
    const spark = days14.map((v) => SPARK[top > 0 ? Math.min(7, Math.floor((v / top) * 7.999)) : 0]).join('');
    const b = i.by === 'dept' ? budget.get(g.name) : undefined;
    const mtdPart = b && Number.isFinite(b.cap) ? `MTD ${usdText(b.mtd)} / cap ${usdText(b.cap)} (${b.cap > 0 ? Math.round((b.mtd / b.cap) * 100) : 100}%)` : `MTD ${usdText(gm)}`; // a capped department shows the enforced figure (SP-08)
    fields.push({ name: clip(code(g.name), 256), value: clip(`7d ${usdText(g7)} (${pctText(g7, gp7)}) · 30d ${usdText(g.d30)} · ${mtdPart} · proj ${usdText(gm + gmean * (dim - dom))}\n${spark}`, FIELD_VALUE_MAX) });
  }
  // Top drivers: the five (dept · provider · tool) combinations and the three task trees that cost most in 7 days (ids only, never a title).
  const combo = new Map<string, number>();
  for (const r of rows.filter(win(0, 6))) combo.set(`${r.deptId}|${r.provider}|${r.tool}`, (combo.get(`${r.deptId}|${r.provider}|${r.tool}`) ?? 0) + r.usd);
  const drivers = [...combo].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([k, v]) => `${k.split('|').map(code).join(' · ')} ${usdText(v)}`);
  const roots = i.roots.slice(0, 3).map((r) => `${code(`#${r.rootId.slice(0, 8)}`)} ${code(r.deptId)} ${usdText(r.usd)}`);
  fields.push({ name: 'Top drivers', value: clip([...drivers, ...(roots.length ? ['Task trees:', ...roots] : [])].join('\n') || 'No spend in the last 7 days.', FIELD_VALUE_MAX) });
  const caps = i.budgets.filter((b) => Number.isFinite(b.cap));
  fields.push({ name: 'Budgets', value: clip(caps.length ? caps.map((b) => `${code(b.dept)} ${usdText(b.mtd)} / ${usdText(b.cap)}${b.raisedFrom !== undefined ? ` (raised from ${usdText(b.raisedFrom)})` : ''}`).join('\n') : 'No department budget is set.', FIELD_VALUE_MAX) });
  // The whole message stays under 6000 characters: drop the weakest groups first.
  const size = () => body.length + fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
  while (size() > MESSAGE_MAX - 300 && fields.length > 2) fields.splice(fields.length - 3, 1);
  return { body, fields };
}

/** Reads what the report needs and builds it for local day `today`. */
export async function spendReport(repo: SpendRepo, overrides: Pick<SpendOverrides, 'effectiveCap'>, cfg: Cfg, nowMs: number, by: GroupBy): Promise<Report> {
  const tz = cfg.get('schedule.timezone');
  const today = localDay(nowMs, tz).date;
  const month = monthStart(today);
  const [rows, roots, mtd] = await Promise.all([repo.trend(addDays(today, -29), today), repo.topRoots(addDays(today, -6), today, 3), repo.deptMtd(month)]);
  const caps = cfg.get('spend.deptMonthlyUsd') as Record<string, number>;
  const budgets: ReportInput['budgets'] = [];
  for (const dept of Object.keys(caps).sort()) {
    const cap = await overrides.effectiveCap(dept, month);
    budgets.push({ dept, mtd: mtd.get(dept)?.spent ?? 0, cap, ...(cap > caps[dept]! ? { raisedFrom: caps[dept]! } : {}) });
  }
  return buildReport({ rows, today, by, budgets, roots });
}

// ---- the dashboard /spend view ------------------------------------------------------------------------------------------------------------

export type SpendView = {
  today: string;
  /** 30 local days x department, newest last. */
  days: { day: string; deptId: string; usd: number }[];
  providers: { provider: string; usd: number }[];
  tools: { tool: string; usd: number }[];
  budgets: { dept: string; mtd: number; cap: number; raisedFrom?: number }[];
  overrides: { dept: string; month: string; oldCap: number; newCap: number; status: string; expiresAt: string }[];
  alerts: { period: string; kind: string; scope: string; posted: boolean; attempts: number; summary: string }[];
};

/** The alert detail fields the dashboard may show: numbers and enum words only, never the raw JSON (Gate 1 S17). */
const DETAIL_NUMBERS = ['pct', 'spentUsd', 'capUsd', 'projUsd', 'mtdUsd', 'todayUsd', 'medianUsd', 'levelUsd', 'usedUsd'] as const;
export function detailSummary(d: Record<string, unknown> | null): string {
  if (!d) return '';
  const parts: string[] = [];
  for (const k of DETAIL_NUMBERS) if (typeof d[k] === 'number' && Number.isFinite(d[k])) parts.push(`${k}=${Number((d[k] as number).toFixed(4))}`);
  if (d.outcome === 'card' || d.outcome === 'rejected' || d.outcome === 'max' || d.outcome === 'failed') parts.push(`outcome=${d.outcome}`);
  return parts.join(' ');
}

export async function spendView(repo: SpendRepo, overrides: Pick<SpendOverrides, 'effectiveCap'>, cfg: Cfg, nowMs: number): Promise<SpendView> {
  const today = localDay(nowMs, cfg.get('schedule.timezone')).date;
  const month = monthStart(today);
  const [rows, mtd, ovr, alerts] = await Promise.all([repo.trend(addDays(today, -29), today), repo.deptMtd(month), repo.recentOverrides(20), repo.lastAlerts(50)]);
  const byDay = new Map<string, number>();
  const byProvider = new Map<string, number>();
  const byTool = new Map<string, number>();
  for (const r of rows) {
    const k = `${r.day}|${r.deptId}`;
    byDay.set(k, (byDay.get(k) ?? 0) + r.usd);
    byProvider.set(r.provider, (byProvider.get(r.provider) ?? 0) + r.usd);
    byTool.set(r.tool, (byTool.get(r.tool) ?? 0) + r.usd);
  }
  const caps = cfg.get('spend.deptMonthlyUsd') as Record<string, number>;
  const budgets: SpendView['budgets'] = [];
  for (const dept of Object.keys(caps).sort()) {
    const cap = await overrides.effectiveCap(dept, month);
    budgets.push({ dept, mtd: mtd.get(dept)?.spent ?? 0, cap, ...(cap > caps[dept]! ? { raisedFrom: caps[dept]! } : {}) });
  }
  const sorted = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return {
    today,
    days: [...byDay].map(([k, usd]) => ({ day: k.split('|')[0]!, deptId: k.split('|')[1]!, usd })).sort((a, b) => a.day.localeCompare(b.day) || a.deptId.localeCompare(b.deptId)),
    providers: sorted(byProvider).map(([provider, usd]) => ({ provider, usd })),
    tools: sorted(byTool).map(([tool, usd]) => ({ tool, usd })),
    budgets,
    overrides: ovr.map((o) => ({ dept: o.deptId, month: o.month.slice(0, 7), oldCap: o.oldCapUsd, newCap: o.newCapUsd, status: o.status, expiresAt: o.expiresAt.toISOString() })),
    alerts: alerts.map((a) => ({ period: a.period, kind: a.kind, scope: a.scopeId, posted: a.postedAt !== null, attempts: a.attempts, summary: detailSummary(a.detail) })),
  };
}

// ---- the watch ----------------------------------------------------------------------------------------------------------------------------

export type WatchDeps = {
  repo: SpendRepo;
  cfg: Cfg;
  overrides: Pick<SpendOverrides, 'effectiveCap'>;
  alerts: SpendAlerts;
  clock: () => number;
  offDay: (now: number) => OffDay;
  log: Log;
};

const ANOMALY_EVERY_MS = 5 * 60_000;
const PROJECTION_EVERY_MS = 60 * 60_000;

/** The 60 s tick: model-free and $0. Alerts run on off days and while halted (they only read and post). */
export class SpendWatch {
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;
  private lastAnomaly = 0;
  private lastProjection = 0;
  private lastPrune = '';

  constructor(private readonly d: WatchDeps) {}

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch((err: unknown) => this.d.log.error({ err: err instanceof Error ? err.name : 'error' }, 'spend watch failed')), intervalMs);
    this.timer.unref?.();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = this.d.clock();
      const tz = this.d.cfg.get('schedule.timezone');
      const today = localDay(now, tz).date;
      const month = monthStart(today);
      await this.step('retry', () => this.d.alerts.retry());
      if (this.d.cfg.get('spend.alertsEnabled')) {
        await this.step('warn', () => this.warn(month));
        if (now - this.lastAnomaly >= ANOMALY_EVERY_MS) {
          this.lastAnomaly = now;
          await this.step('anomaly', () => this.anomaly(today));
        }
        if (now - this.lastProjection >= PROJECTION_EVERY_MS) {
          this.lastProjection = now;
          await this.step('projection', () => this.projection(today, month));
        }
      }
      await this.step('summary', () => this.summary(now, today, tz));
      if (this.lastPrune !== today) {
        this.lastPrune = today;
        await this.step('prune', () => this.d.repo.prune(addDays(today, -this.d.cfg.get('spend.retentionDays')), new Date(now)));
      }
    } finally {
      this.busy = false;
    }
  }

  /** One failing step never blocks the others. */
  private async step(name: string, f: () => Promise<void>): Promise<void> {
    try { await f(); } catch (err) { this.d.log.error({ step: name, err: err instanceof Error ? err.name : 'error' }, 'spend watch step failed'); }
  }

  private caps(): [string, number][] {
    return Object.entries(this.d.cfg.get('spend.deptMonthlyUsd') as Record<string, number>);
  }

  /** SP-08: the enforced figure (the dept row) against the effective cap. */
  private async warn(month: string): Promise<void> {
    const mtd = await this.d.repo.deptMtd(month);
    const pct = this.d.cfg.get('spend.warnPct');
    for (const [dept] of this.caps()) {
      const cap = await this.d.overrides.effectiveCap(dept, month);
      const spent = mtd.get(dept)?.spent ?? 0;
      if (cap > 0 && spent / cap >= pct / 100) await this.d.alerts.deliver(month.slice(0, 7), 'warn', dept, { dept, pct: Math.floor((spent / cap) * 100), spentUsd: spent, capUsd: cap });
    }
  }

  private async anomaly(today: string): Promise<void> {
    const rows = await this.d.repo.trend(addDays(today, -7), today);
    const mult = this.d.cfg.get('spend.anomalyMultiplier');
    const floor = this.d.cfg.get('spend.anomalyMinUsd');
    const per = new Map<string, Map<string, number>>();
    const add = (scope: string, day: string, usd: number) => {
      const m = per.get(scope) ?? per.set(scope, new Map()).get(scope)!;
      m.set(day, (m.get(day) ?? 0) + usd);
    };
    for (const r of rows) {
      add(r.deptId, r.day, r.usd);
      add('_company', r.day, r.usd);
    }
    for (const [scope, days] of per) {
      const prev = Array.from({ length: 7 }, (_, n) => days.get(addDays(today, -(n + 1))) ?? 0); // missing days count as 0
      const med = median(prev);
      const now = days.get(today) ?? 0;
      const level = Math.max(mult * med, floor);
      if (now > level) await this.d.alerts.deliver(today, 'anomaly', scope, { dept: scope, todayUsd: now, medianUsd: med, levelUsd: level });
    }
  }

  private async projection(today: string, month: string): Promise<void> {
    const caps = this.caps();
    if (!caps.length) return;
    const [rows, mtd] = [await this.d.repo.trend(addDays(today, -7), addDays(today, -1)), await this.d.repo.deptMtd(month)];
    const dim = daysInMonth(month);
    const dom = Number(today.slice(8, 10));
    for (const [dept] of caps) {
      const cap = await this.d.overrides.effectiveCap(dept, month);
      const spent = mtd.get(dept)?.spent ?? 0;
      const mean7 = sum(rows.filter((r) => r.deptId === dept).map((r) => r.usd)) / 7;
      const proj = spent + mean7 * (dim - dom);
      if (proj > cap && spent < cap) await this.d.alerts.deliver(month.slice(0, 7), 'projection', dept, { dept, projUsd: proj, capUsd: cap, mtdUsd: spent });
    }
  }

  /** Workdays only, from the configured time; a Monday holiday is caught up on the first workday (the claim keeps it to once per ISO week). */
  private async summary(now: number, today: string, tz: string): Promise<void> {
    if (!this.d.cfg.get('spend.weeklySummary') || this.d.offDay(now).off) return;
    if (localTime(now, tz) < this.d.cfg.get('spend.weeklySummaryTime')) return;
    await this.d.alerts.deliver(isoWeekKey(today), 'summary', '', {});
  }
}

/** The weekly summary renderer: the previous ISO week Monday to Sunday plus the month so far, in the same builder as `/usage range:trend`. */
export function summaryRenderer(repo: SpendRepo, overrides: Pick<SpendOverrides, 'effectiveCap'>, cfg: Cfg, clock: () => number): (r: { period: string }) => Promise<OutboundPayload> {
  return async (r) => {
    const rep = await spendReport(repo, overrides, cfg, clock(), 'dept');
    const from = addDays(isoWeekMonday(r.period), -7);
    const rows = await repo.trend(from, addDays(from, 6));
    const week = sum(rows.map((x) => x.usd));
    // R8 PROV-FALLBACK: with the backup switch on, one fixed line for the metered Claude API (numbers only); nothing changes while it is off or the API was not used.
    const api = rows.filter((x) => x.provider === 'claude');
    const apiCalls = sum(api.map((x) => x.calls));
    const apiLine = cfg.get('provider.fallback.enabled') === true && apiCalls > 0 ? `\n${weeklyApiLine({ usd: sum(api.map((x) => x.usd)), calls: apiCalls })}` : '';
    return {
      type: 'config', origin: 'governance', title: 'Weekly spend summary',
      body: `Previous week (${from} to ${addDays(from, 6)}): ${usdText(week)}.${apiLine}\n${rep.body}`, fields: rep.fields,
    };
  };
}
