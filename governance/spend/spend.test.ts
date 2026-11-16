import { describe, expect, it } from 'vitest';
import type { OutboundPayload } from '../../agents/loop/payload.js';
import { createCalendar } from '../../company/calendar.js';
import { detailSummary, isoWeekKey, isoWeekMonday, addDays, daysInMonth, buildReport, localTime, renderAlert, SpendAlerts, SpendWatch, summaryRenderer, type AlertKind, type AlertRow, type SpendRepo, type TrendRow } from './spend.js';
import { cleanDept, cleanModel, cleanProvider, cleanTool } from './spend-shared.js';
import { FakeConfig } from '../test-helpers.js';

/** An in-memory stand-in for SpendRepo (claims, attempts and the few reads the watch makes). */
function fakeRepo(init: { trend?: TrendRow[]; mtd?: Record<string, number> } = {}) {
  const alerts = new Map<string, AlertRow>();
  const k = (p: string, kind: string, s: string) => `${p}|${kind}|${s}`;
  const repo = {
    trend: async (from: string, to: string) => (init.trend ?? []).filter((r) => r.day >= from && r.day <= to),
    topRoots: async () => [],
    deptMtd: async () => new Map(Object.entries(init.mtd ?? {}).map(([d, spent]) => [d, { spent, reserved: 0 }])),
    claim: async (period: string, kind: AlertKind, scopeId: string, detail: Record<string, unknown>) => {
      if (alerts.has(k(period, kind, scopeId))) return false;
      alerts.set(k(period, kind, scopeId), { period, kind, scopeId, detail, attempts: 0, postedAt: null, claimedAt: new Date() });
      return true;
    },
    beginAttempt: async (period: string, kind: AlertKind, scopeId: string) => {
      const a = alerts.get(k(period, kind, scopeId));
      if (!a || a.postedAt || a.attempts >= 3) return null;
      return ++a.attempts;
    },
    markPosted: async (period: string, kind: AlertKind, scopeId: string) => { alerts.get(k(period, kind, scopeId))!.postedAt = new Date(); },
    unposted: async () => [...alerts.values()].filter((a) => !a.postedAt && a.attempts < 3),
    prune: async () => undefined,
    lastAlerts: async () => [...alerts.values()],
  };
  return { repo: repo as unknown as SpendRepo, alerts };
}
const day = (date: string, deptId: string, usd: number, o: Partial<TrendRow> = {}): TrendRow => ({ day: date, deptId, provider: 'gemini', tool: 'ocr', usd, calls: 1, ...o });

describe('SPEND-1 date and sanitising helpers', () => {
  it('SP-10: the ISO week uses the week-year (2027-01-01 is 2026-W53; 2024-12-30 is 2025-W01)', () => {
    expect(isoWeekKey('2027-01-01')).toBe('2026-W53');
    expect(isoWeekKey('2026-12-31')).toBe('2026-W53');
    expect(isoWeekKey('2024-12-30')).toBe('2025-W01');
    expect(isoWeekKey('2026-11-09')).toBe('2026-W46');
    expect(isoWeekKey('2026-11-15')).toBe('2026-W46');
    expect(isoWeekKey('2026-11-16')).toBe('2026-W47');
    expect(isoWeekMonday('2026-W46')).toBe('2026-11-09');
    expect(isoWeekMonday('2026-W53')).toBe('2026-12-28');
    expect(isoWeekMonday('2025-W01')).toBe('2024-12-30');
  });

  it('day arithmetic is calendar arithmetic; local time follows the zone', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(daysInMonth('2026-02-01')).toBe(28);
    expect(daysInMonth('2028-02-01')).toBe(29);
    expect(localTime(Date.parse('2026-11-30T17:00:00Z'), 'Asia/Bangkok')).toBe('00:00');
    expect(localTime(Date.parse('2026-11-30T16:59:00Z'), 'Asia/Bangkok')).toBe('23:59');
  });

  it('S10: the rollup allowlists', () => {
    expect(cleanDept('hq')).toBe('hq');
    for (const d of ['HQ', 'a b', '', 'x'.repeat(33), undefined, null, 'h1']) expect(cleanDept(d as string)).toBe('_unattributed');
    expect(cleanTool('image_generate')).toBe('image_generate');
    expect(cleanTool(undefined)).toBe('llm');
    for (const t of ['Bad', 'a-b', '', 'x'.repeat(41), 'a\u0000b', '🤖']) expect(cleanTool(t)).toBe('other');
    expect(cleanProvider('claude-code-local')).toBe('claude-code-local');
    expect(cleanProvider('gemini')).toBe('gemini');
    for (const p of ['Gem', 'a b', '', 'x'.repeat(65), 'a\u0000b', undefined]) expect(cleanProvider(p as string)).toBe('unknown');
    expect(cleanModel('gemini-2.5-flash-image')).toBe('gemini-2.5-flash-image');
    expect(cleanModel('local/claude-sonnet-5-5')).toBe('local/claude-sonnet-5-5');
    for (const m of ['a b', 'a\u0000b', '🤖', 'y'.repeat(129), undefined]) expect(cleanModel(m as string)).toBe('');
    expect(cleanModel('')).toBe('');
  });
});

describe('SPEND-1 S16: what is posted', () => {
  it('alerts are rebuilt from numbers and enum words only: a hostile detail changes nothing but the numbers', () => {
    const evil = { dept: '`@everyone` <@1> hq', capUsd: 10, usedUsd: 'drop table', outcome: '@everyone', pct: '85' };
    const p = renderAlert('stop', '2026-11', 'hq:1000', evil);
    expect(p.body).not.toContain('@everyone');
    expect(p.body).not.toContain('drop table');
    expect(p).toMatchObject({ type: 'config', origin: 'governance' }); // type config: never pings the admin role
    expect(detailSummary({ dept: '<@1>', pct: 85, spentUsd: 8.5, outcome: 'card', note: '<script>x</script>', title: 'secret' })).toBe('pct=85 spentUsd=8.5 outcome=card');
    expect(detailSummary(null)).toBe('');
  });

  it('the report shows the department, provider, tool and task id (8 chars) in code format, and nothing else', () => {
    const rows = [day('2026-11-08', 'hq', 4, { provider: 'gemini', tool: 'image_generate' }), day('2026-11-07', '_unattributed', 1, { provider: 'unknown', tool: 'other' })];
    const r = buildReport({ rows, today: '2026-11-08', by: 'dept', budgets: [{ dept: 'hq', mtd: 4, cap: 10 }], roots: [{ rootId: '1234abcd5678ef90'.repeat(2), deptId: 'hq', usd: 4 }] });
    const all = r.body + JSON.stringify(r.fields);
    expect(all).toContain('`hq`');
    expect(all).toContain('`_unattributed`');
    expect(all).toContain('`#1234abcd`');
    expect(all).toContain('`hq` · `gemini` · `image_generate` $4.00');
    expect(r.fields[0]!.value).toContain('MTD $4.00 / cap $10.00 (40%)');
    expect(r.fields[0]!.value.match(/MTD/g)).toHaveLength(1);
    expect(all).not.toContain('5678ef90');
    expect(r.fields.find((f) => f.name === 'Budgets')!.value).toBe('`hq` $4.00 / $10.00');
  });

  it('body shape: MTD, 7d with previous 7d and percent, 30d and the projected month end; the sparkline has 14 glyphs', () => {
    const rows: TrendRow[] = [];
    for (let d = 0; d < 14; d++) rows.push(day(addDays('2026-11-14', -d), 'hq', d < 7 ? 2 : 1));
    const r = buildReport({ rows, today: '2026-11-14', by: 'dept', budgets: [], roots: [] });
    // 7 days of 2 (14), the 7 before of 1 (7); the last 7 complete days (13..7) sum 13, so 21 + 13/7 x 16 remaining days = 50.71
    expect(r.body).toBe('MTD $21.00 · 7d $14.00 (prev 7d $7.00, +100%) · 30d $21.00 · projected month end $50.71');
    const spark = /\n([▁▂▃▄▅▆▇█]+)$/.exec(r.fields[0]!.value)![1]!;
    expect([...spark]).toHaveLength(14);
  });
});

describe('SPEND-1 S14: the watch', () => {
  const cal = (cfg: FakeConfig) => createCalendar(cfg);
  const mk = (cfg: FakeConfig, repo: SpendRepo, clock: { t: number }, posted: OutboundPayload[], fail = { n: 0 }) => {
    const overrides = { effectiveCap: async (d: string) => (cfg.get('spend.deptMonthlyUsd') as Record<string, number>)[d] ?? Infinity };
    const alerts = new SpendAlerts(repo, { alert: async (p) => { if (fail.n-- > 0) throw new Error('x'); posted.push(p); } }, { error: () => undefined }, undefined, (r) => summaryRenderer(repo, overrides, cfg, () => clock.t)(r));
    return new SpendWatch({ repo, cfg, overrides, alerts, clock: () => clock.t, offDay: (t) => cal(cfg).isOffDay(t), log: { error: () => undefined } });
  };

  it('the weekly summary waits for the configured time, skips an off day, catches up on the first workday, and only once per ISO week', async () => {
    const cfg = new FakeConfig({ 'schedule.holidays': [{ date: '2026-11-09' }], 'spend.alertsEnabled': false });
    const clock = { t: Date.parse('2026-11-09T03:00:00Z') }; // Monday 10:00 Bangkok, a holiday
    const posted: OutboundPayload[] = [];
    const { repo, alerts } = fakeRepo();
    const w = mk(cfg, repo, clock, posted);
    await w.tick();
    expect(posted).toHaveLength(0); // off day
    clock.t = Date.parse('2026-11-10T01:59:00Z'); // Tuesday 08:59: before 09:00
    await w.tick();
    expect(posted).toHaveLength(0);
    clock.t = Date.parse('2026-11-10T02:00:00Z'); // Tuesday 09:00: the catch-up
    await w.tick();
    expect(posted.map((p) => p.title)).toEqual(['Weekly spend summary']);
    expect([...alerts.keys()]).toEqual(['2026-W46|summary|']);
    clock.t = Date.parse('2026-11-11T05:00:00Z');
    await w.tick();
    expect(posted).toHaveLength(1);
    clock.t = Date.parse('2026-11-16T03:00:00Z'); // next Monday: a new week
    await w.tick();
    expect(posted).toHaveLength(2);
    // weeklySummary false: nothing
    cfg.values.set('spend.weeklySummary', false);
    clock.t = Date.parse('2026-11-23T03:00:00Z');
    await w.tick();
    expect(posted).toHaveLength(2);
  });

  it('the summary claim uses the ISO week-year around New Year (2027-01-01 -> 2026-W53)', async () => {
    const cfg = new FakeConfig({ 'spend.alertsEnabled': false, 'schedule.offDays': [] });
    const clock = { t: Date.parse('2027-01-01T03:00:00Z') };
    const { repo, alerts } = fakeRepo();
    await mk(cfg, repo, clock, []).tick();
    expect([...alerts.keys()]).toEqual(['2026-W53|summary|']);
  });

  it('anomaly: the USD floor applies when the median is 0, the median of 7 complete days sets the level, claimed once per day and scope', async () => {
    const cfg = new FakeConfig({ 'spend.weeklySummary': false });
    const clock = { t: Date.parse('2026-11-10T05:00:00Z') };
    const trend: TrendRow[] = [day('2026-11-10', 'hq', 0.4)];
    const { repo, alerts } = fakeRepo({ trend });
    const posted: OutboundPayload[] = [];
    const w = mk(cfg, repo, clock, posted);
    await w.tick();
    expect(posted).toHaveLength(0); // 0.4 < floor 0.5, median 0
    trend[0] = day('2026-11-10', 'hq', 0.6);
    clock.t += 301_000;
    await w.tick();
    expect([...alerts.keys()].sort()).toEqual(['2026-11-10|anomaly|_company', '2026-11-10|anomaly|hq']);
    // with history: median 2 -> level max(3 x 2, 0.5) = 6
    alerts.clear();
    posted.length = 0;
    for (let d = 1; d <= 7; d++) trend.push(day(addDays('2026-11-10', -d), 'hq', 2));
    trend[0] = day('2026-11-10', 'hq', 5.9);
    clock.t += 301_000;
    await w.tick();
    expect(posted).toHaveLength(0);
    trend[0] = day('2026-11-10', 'hq', 6.1);
    clock.t += 301_000;
    await w.tick();
    expect(posted.map((p) => p.body).join('\n')).toContain('alert level $6.00');
    // not before the 5-minute interval, and never twice for the same claim
    const n = posted.length;
    clock.t += 301_000;
    await w.tick();
    expect(posted).toHaveLength(n);
  });

  it('projection: fires when the 7-day pace passes the cap while month-to-date is below it; once per month', async () => {
    const cfg = new FakeConfig({ 'spend.weeklySummary': false, 'spend.deptMonthlyUsd': { hq: 100 }, 'spend.warnPct': 99 });
    const clock = { t: Date.parse('2026-11-10T05:00:00Z') };
    const trend: TrendRow[] = [];
    for (let d = 1; d <= 7; d++) trend.push(day(addDays('2026-11-10', -d), 'hq', 3)); // 3/day for 20 more days = 60 more
    const { repo, alerts } = fakeRepo({ trend, mtd: { hq: 50 } }); // 50 + 3 x 20 = 110 > 100
    const posted: OutboundPayload[] = [];
    await mk(cfg, repo, clock, posted).tick();
    expect([...alerts.keys()]).toContain('2026-11|projection|hq');
    expect(posted.find((p) => p.title === 'Department budget projection')!.body).toContain('projected $110.00 against $100.00');
    // month to date already at the cap: the warn/stop path owns it, no projection
    const b = fakeRepo({ trend, mtd: { hq: 100 } });
    const p2: OutboundPayload[] = [];
    await mk(cfg, b.repo, clock, p2).tick();
    expect([...b.alerts.keys()].some((x) => x.includes('projection'))).toBe(false);
  });

  it('warn: at warnPct of the effective cap, once per month, and not when alertsEnabled is false', async () => {
    const cfg = new FakeConfig({ 'spend.weeklySummary': false, 'spend.deptMonthlyUsd': { hq: 100, rnd: 100 } });
    const clock = { t: Date.parse('2026-11-10T05:00:00Z') };
    const { repo, alerts } = fakeRepo({ mtd: { hq: 80, rnd: 79.99 } });
    const posted: OutboundPayload[] = [];
    const w = mk(cfg, repo, clock, posted);
    await w.tick();
    await w.tick();
    expect([...alerts.keys()]).toEqual(['2026-11|warn|hq']);
    expect(posted[0]!.body).toContain('80% of its monthly budget');
  });

  it('a failed post is retried on later ticks, at most 3 attempts, and a crash after the claim is also retried', async () => {
    const cfg = new FakeConfig({ 'spend.weeklySummary': false, 'spend.deptMonthlyUsd': { hq: 100 } });
    const clock = { t: Date.parse('2026-11-10T05:00:00Z') };
    const { repo, alerts } = fakeRepo({ mtd: { hq: 95 } });
    const posted: OutboundPayload[] = [];
    const fail = { n: 2 };
    const w = mk(cfg, repo, clock, posted, fail);
    await w.tick(); // attempt 1 fails
    await w.tick(); // attempt 2 fails
    expect(posted).toHaveLength(0);
    await w.tick(); // attempt 3 succeeds
    expect(posted).toHaveLength(1);
    expect(alerts.get('2026-11|warn|hq')!.attempts).toBe(3);
    await w.tick();
    expect(posted).toHaveLength(1);
    // a claim whose first attempt never happened (crash): picked up by the retry pass
    await repo.claim('2026-11', 'warn', 'rnd', { dept: 'rnd', pct: 90, spentUsd: 90, capUsd: 100 });
    await w.tick();
    expect(posted.map((p) => p.body).some((b) => b.includes('`rnd`'))).toBe(true);
  });

  it('the stop alert is not part of alertsEnabled: warn, anomaly and projection are off, the retry pass still runs', async () => {
    const cfg = new FakeConfig({ 'spend.weeklySummary': false, 'spend.alertsEnabled': false, 'spend.deptMonthlyUsd': { hq: 1 } });
    const clock = { t: Date.parse('2026-11-10T05:00:00Z') };
    const { repo, alerts } = fakeRepo({ mtd: { hq: 5 }, trend: [day('2026-11-10', 'hq', 50)] });
    const posted: OutboundPayload[] = [];
    const w = mk(cfg, repo, clock, posted);
    await repo.claim('2026-11', 'stop', 'hq:100', { dept: 'hq', capUsd: 1, usedUsd: 1, outcome: 'card' });
    await w.tick();
    expect(posted.map((p) => p.title)).toEqual(['Department budget used up']);
    expect([...alerts.keys()].filter((x) => !x.includes('|stop|'))).toEqual([]);
  });
});
