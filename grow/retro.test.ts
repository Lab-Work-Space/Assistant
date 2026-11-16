import { describe, expect, it, vi } from 'vitest';
import { createCalendar } from '../company/calendar.js';
import { FakeConfig } from '../governance/test-helpers.js';
import { retroSlot, WeeklyRetro, type WeeklyRetroDeps } from './retro.js';

const TZ = 'Asia/Bangkok';
/** Local Bangkok wall clock to an instant (UTC+7, no DST). */
const at = (date: string, hh = 16, mm = 0): number => Date.parse(`${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+07:00`);
const mkCfg = (o: Record<string, unknown> = {}) => new FakeConfig({ 'schedule.timezone': TZ, 'schedule.offDays': [0, 6], 'schedule.holidays': [], 'schedule.workDays': [], ...o } as never);
const slot = (cfg: FakeConfig, now: number) => { const cal = createCalendar(cfg); return retroSlot(now, cfg, (t) => cal.isOffDay(t).off); };
// 2026-11-13 is a Friday (ISO week 46), 2026-11-16 the Monday after.

describe('retroSlot (SA-1 3.1)', () => {
  it('Friday from 16:00 is due under the ISO week key; before 16:00 it is not', () => {
    const cfg = mkCfg();
    expect(slot(cfg, at('2026-11-13', 15, 59))).toBeNull();
    expect(slot(cfg, at('2026-11-13', 16, 0))).toEqual({ week: '2026-W46', slotDate: '2026-11-13' });
    expect(slot(cfg, at('2026-11-13', 23, 59))).toEqual({ week: '2026-W46', slotDate: '2026-11-13' });
  });
  it('a Thursday and a Monday are not due on a normal week (a missed workday is not caught up)', () => {
    const cfg = mkCfg();
    expect(slot(cfg, at('2026-11-12'))).toBeNull();
    expect(slot(cfg, at('2026-11-16'))).toBeNull(); // Friday was a workday that was missed: Monday does not catch up
    expect(slot(cfg, at('2026-11-17'))).toBeNull();
  });
  it('Friday holiday + weekend: Monday 16:00 runs under the PREVIOUS week key (off-day catch-up); Tuesday does not', () => {
    const cfg = mkCfg({ 'schedule.holidays': [{ date: '2026-11-13', name: 'Holiday' }] });
    expect(slot(cfg, at('2026-11-16', 15, 59))).toBeNull();
    expect(slot(cfg, at('2026-11-16'))).toEqual({ week: '2026-W46', slotDate: '2026-11-13' });
    expect(slot(cfg, at('2026-11-17'))).toBeNull(); // Monday was a workday that passed
  });
  it('a Monday that is also an off day moves the catch-up to Tuesday', () => {
    const cfg = mkCfg({ 'schedule.holidays': [{ date: '2026-11-13', name: 'A' }, { date: '2026-11-16', name: 'B' }] });
    expect(slot(cfg, at('2026-11-17'))).toEqual({ week: '2026-W46', slotDate: '2026-11-13' });
  });
  it('an extra listed workday on the slot day is a normal slot day', () => {
    const cfg = mkCfg({ 'grow.retro.weekday': 6, 'schedule.workDays': ['2026-11-14'] });
    expect(slot(cfg, at('2026-11-14'))).toEqual({ week: '2026-W46', slotDate: '2026-11-14' });
  });
  it('ISO weekday mapping: 7 is Sunday (localDay says 0), 1 is Monday', () => {
    const sun = mkCfg({ 'grow.retro.weekday': 7, 'schedule.offDays': [] });
    expect(slot(sun, at('2026-11-15'))).toEqual({ week: '2026-W46', slotDate: '2026-11-15' });
    expect(slot(sun, at('2026-11-14'))).toBeNull();
    const mon = mkCfg({ 'grow.retro.weekday': 1, 'schedule.offDays': [] });
    expect(slot(mon, at('2026-11-16'))).toEqual({ week: '2026-W47', slotDate: '2026-11-16' });
    expect(slot(mon, at('2026-11-15'))).toBeNull(); // Sunday is 6 days after Monday: not catch-up while those days were workdays
  });
  it('the hour setting moves the slot', () => {
    expect(slot(mkCfg({ 'grow.retro.hour': 9 }), at('2026-11-13', 9, 0))).not.toBeNull();
    expect(slot(mkCfg({ 'grow.retro.hour': 9 }), at('2026-11-13', 8, 59))).toBeNull();
  });
  it('2027-01-01 (a Friday) belongs to ISO week-year 2026-W53', () => {
    expect(slot(mkCfg(), at('2027-01-01'))).toEqual({ week: '2026-W53', slotDate: '2027-01-01' });
    expect(slot(mkCfg(), at('2027-01-08'))).toEqual({ week: '2027-W01', slotDate: '2027-01-08' });
  });
});

type Dept = { id: string; enabled: boolean };
type Req = { deptId: string; week: string; kind: 'weekly' | 'manual' | 'incident'; taskId: string | null; outcome: string | null; at: number };
type RigOpts = { cfg?: Record<string, unknown>; now?: number; halted?: boolean; depts?: Dept[]; online?: (d: string) => boolean; open?: boolean; claimThrows?: boolean; startResult?: 'started' | 'skipped'; startThrows?: boolean; incidents?: Record<string, number> };
function rig(o: RigOpts = {}) {
  const cfg = mkCfg(o.cfg);
  const claims = new Map<string, string>();
  const rows: Req[] = [];
  const audits: { actor: string; action: string; tool?: string | null; outcome?: string | null }[] = [];
  const finishes: [string, string, string][] = [];
  const start = vi.fn(async (a: { dept: string; week: string; taskId: string; kind?: string }) => { if (o.startThrows) throw new Error('boom'); void a; return o.startResult ?? 'started'; });
  const log = { error: vi.fn() };
  const nowOf = () => o.now ?? at('2026-11-13');
  const depts = (o.depts ?? [{ id: 'hq', enabled: true }, { id: 'praw', enabled: true }, { id: 'software', enabled: true }, { id: 'rnd', enabled: true }]) as never as Dept[];
  const d: WeeklyRetroDeps = {
    cfg, calendar: createCalendar(cfg), canRun: () => !(o.halted ?? false), limits: { checkOpenTasks: async () => o.open ?? true }, now: nowOf, log, start,
    audit: async (e) => void audits.push(e as never),
    org: { heads: () => depts as never, dept: (id: string) => (depts.find((x) => x.id === id) ?? null) as never },
    ...(o.online ? { online: o.online } : {}),
    repo: {
      claimed: async (dept, week) => claims.has(`${dept}|${week}`),
      claim: async (dept, week, taskId) => { if (o.claimThrows) throw new Error('db'); if (claims.has(`${dept}|${week}`)) return false; claims.set(`${dept}|${week}`, taskId); return true; },
      finish: async (dept, week, outcome) => void finishes.push([dept, week, outcome]),
      request: async (dept, key, kind) => { if (rows.some((r) => r.deptId === dept && r.week === key)) return false; rows.push({ deptId: dept, week: key, kind, taskId: null, outcome: null, at: nowOf() }); return true; },
      nextRequested: async () => rows.filter((r) => r.taskId === null && r.outcome === null).sort((a, b) => a.at - b.at).map((r) => ({ deptId: r.deptId, week: r.week, kind: r.kind })),
      assign: async (dept, key, taskId) => { const r = rows.find((x) => x.deptId === dept && x.week === key && x.taskId === null && x.outcome === null); if (!r) return false; r.taskId = taskId; return true; },
      expireRequested: async () => { let n = 0; for (const r of rows) if (r.taskId === null && r.outcome === null && nowOf() - r.at > 24 * 3_600_000) { r.outcome = 'failed'; n++; } return n; },
      incidentsSinceLastRetro: async (dept) => o.incidents?.[dept] ?? 0,
    },
  };
  return { r: new WeeklyRetro(d), start, claims, rows, audits, finishes, log, cfg };
}

describe('WeeklyRetro.tick', () => {
  it('at most one department per tick; praw never; each department once per ISO week (restart safe: the claim row decides)', async () => {
    const t = rig();
    const started: string[] = [];
    for (let i = 0; i < 6; i++) { const d = await t.r.tick(); if (d) started.push(d); }
    expect(started).toEqual(['hq', 'software', 'rnd']);
    expect(t.start).toHaveBeenCalledTimes(3);
    expect(t.start.mock.calls.map((c) => c[0].week)).toEqual(['2026-W46', '2026-W46', '2026-W46']);
    const again = new WeeklyRetro({ ...(t.r as never as { d: WeeklyRetroDeps }).d }); // a fresh instance over the same claim table
    expect(await again.tick()).toBeNull();
  });
  it('the next ISO week runs again', async () => {
    const t = rig();
    for (let i = 0; i < 4; i++) await t.r.tick();
    const next = rig({ now: at('2026-11-20') });
    expect(await next.r.tick()).toBe('hq');
  });
  it('nothing when: the switch is off, halted, an off day, or a config read throws', async () => {
    expect(await rig({ cfg: { 'grow.retro.enabled': false } }).r.tick()).toBeNull();
    expect(await rig({ halted: true }).r.tick()).toBeNull();
    expect(await rig({ cfg: { 'schedule.holidays': [{ date: '2026-11-13', name: 'x' }] } }).r.tick()).toBeNull();
    const t = rig();
    t.cfg.throwOn.add('grow.retro.enabled');
    expect(await t.r.tick()).toBeNull();
    expect(t.start).not.toHaveBeenCalled();
  });
  it('a department that is disabled or has no online head is skipped', async () => {
    const t = rig({ depts: [{ id: 'hq', enabled: false }, { id: 'software', enabled: true }, { id: 'rnd', enabled: true }], online: (d) => d === 'rnd' });
    expect(await t.r.tick()).toBe('rnd');
  });
  it('a full open-task limit writes no claim (the next tick retries)', async () => {
    const t = rig({ open: false });
    expect(await t.r.tick()).toBeNull();
    expect(t.claims.size).toBe(0);
    expect(t.start).not.toHaveBeenCalled();
  });
  it('a failed claim write starts nothing and logs the error name only', async () => {
    const t = rig({ claimThrows: true });
    expect(await t.r.tick()).toBeNull();
    expect(t.start).not.toHaveBeenCalled();
    expect(JSON.stringify(t.log.error.mock.calls)).toBe('[[{"errName":"Error"},"retro claim failed"]]');
  });
  it('a skipped or thrown start marks the claim failed and is not retried that week', async () => {
    for (const o of [{ startResult: 'skipped' as const }, { startThrows: true }]) {
      const t = rig({ ...o, depts: [{ id: 'software', enabled: true }] });
      expect(await t.r.tick()).toBe('software');
      expect(t.finishes).toEqual([['software', '2026-W46', 'failed']]);
      expect(await t.r.tick()).toBeNull();
      expect(t.start).toHaveBeenCalledTimes(1);
    }
  });
  it('the Friday-holiday catch-up starts on Monday under the previous week key, once', async () => {
    const t = rig({ now: at('2026-11-16'), cfg: { 'schedule.holidays': [{ date: '2026-11-13', name: 'x' }] }, depts: [{ id: 'software', enabled: true }] });
    expect(await t.r.tick()).toBe('software');
    expect(t.start.mock.calls[0]![0].week).toBe('2026-W46');
    expect(await t.r.tick()).toBeNull();
  });
});

// ---- LEARN-1 D4a: on-demand and incident retros -------------------------------------------------------------------------------------------
const WED = at('2026-11-11', 10); // a workday that is not the weekly slot day
describe('WeeklyRetro.request (LL-C7)', () => {
  it('halted means the halt flag alone: a company that is only paused or not provider-ready still queues', async () => {
    const t = rig({ now: WED, depts: [{ id: 'software', enabled: true }] });
    const d = (t.r as never as { d: WeeklyRetroDeps }).d;
    d.canRun = () => false;
    d.isHalted = () => false;
    expect(await t.r.request('software', 'user:1')).toEqual([{ dept: 'software', result: 'queued' }]);
    d.isHalted = () => true;
    expect(await t.r.request('rnd', 'user:1')).toBe('halted');
  });
  it('refusals: halted, off (also on a config read error), unknown department (bad shape or not in the org)', async () => {
    expect(await rig({ now: WED, halted: true }).r.request(null, 'user:1')).toBe('halted');
    expect(await rig({ now: WED, cfg: { 'grow.retro.enabled': false } }).r.request(null, 'user:1')).toBe('off');
    const t = rig({ now: WED });
    t.cfg.throwOn.add('grow.retro.enabled');
    expect(await t.r.request(null, 'user:1')).toBe('off');
    for (const bad of ['Software', 'a b', '', 'x'.repeat(33), 'nope', "software'; DROP TABLE"]) expect(await rig({ now: WED }).r.request(bad, 'user:1'), bad).toBe('unknown');
    expect(t.rows).toEqual([]);
  });
  it('no department: every enabled non-praw head is queued under one D-key; a second request says exists; an audit row each, actor = the caller', async () => {
    const t = rig({ now: WED, depts: [{ id: 'hq', enabled: true }, { id: 'praw', enabled: true }, { id: 'rnd', enabled: false }, { id: 'software', enabled: true }] });
    expect(await t.r.request(null, 'user:42')).toEqual([{ dept: 'hq', result: 'queued' }, { dept: 'software', result: 'queued' }]);
    expect(t.rows.map((r) => [r.deptId, r.week, r.kind, r.taskId])).toEqual([['hq', 'D2026-11-11', 'manual', null], ['software', 'D2026-11-11', 'manual', null]]);
    expect(await t.r.request('software', 'user:42')).toEqual([{ dept: 'software', result: 'exists' }]);
    expect(t.audits.map((a) => [a.actor, a.action, a.tool, a.outcome])).toEqual([
      ['user:42', 'grow.retro.request', 'hq', 'manual queued'], ['user:42', 'grow.retro.request', 'software', 'manual queued'], ['user:42', 'grow.retro.request', 'software', 'manual exists'],
    ]);
  });
  it('a named praw or disabled department is not_eligible and queues nothing', async () => {
    const t = rig({ now: WED, depts: [{ id: 'praw', enabled: true }, { id: 'rnd', enabled: false }] });
    expect(await t.r.request('praw', 'user:1')).toEqual([{ dept: 'praw', result: 'not_eligible' }]);
    expect(await t.r.request('rnd', 'user:1')).toEqual([{ dept: 'rnd', result: 'not_eligible' }]);
    expect(t.rows).toEqual([]);
  });
});

describe('WeeklyRetro.tick on-demand (LL-C8)', () => {
  it('queued, then started on the next tick with kind manual under the D-key; at most one start per tick', async () => {
    const t = rig({ now: WED, depts: [{ id: 'hq', enabled: true }, { id: 'software', enabled: true }] });
    await t.r.request(null, 'user:1');
    expect(t.start).not.toHaveBeenCalled();
    expect(await t.r.tick()).toBe('hq');
    expect(t.start).toHaveBeenCalledTimes(1);
    expect(t.start.mock.calls[0]![0]).toMatchObject({ dept: 'hq', week: 'D2026-11-11', kind: 'manual' });
    expect(t.rows.find((r) => r.deptId === 'hq')!.taskId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await t.r.tick()).toBe('software');
    expect(await t.r.tick()).toBeNull();
    expect(t.start).toHaveBeenCalledTimes(2);
  });
  it('nothing starts on an off day, while halted, or when the switch is off; the row stays queued', async () => {
    for (const o of [{ halted: true }, { cfg: { 'schedule.holidays': [{ date: '2026-11-11', name: 'x' }] } }, { cfg: { 'grow.retro.enabled': false } }]) {
      const t = rig({ now: WED, depts: [{ id: 'software', enabled: true }], ...o });
      t.rows.push({ deptId: 'software', week: 'D2026-11-11', kind: 'manual', taskId: null, outcome: null, at: WED });
      expect(await t.r.tick()).toBeNull();
      expect(t.start).not.toHaveBeenCalled();
      expect(t.rows[0]!.taskId).toBeNull();
    }
  });
  it('a queued row of a praw, disabled or offline department is skipped and stays queued; the next eligible one starts', async () => {
    const t = rig({ now: WED, depts: [{ id: 'praw', enabled: true }, { id: 'rnd', enabled: false }, { id: 'hq', enabled: true }, { id: 'software', enabled: true }], online: (d) => d !== 'hq' });
    for (const d of ['praw', 'rnd', 'hq', 'software']) t.rows.push({ deptId: d, week: 'D2026-11-11', kind: 'manual', taskId: null, outcome: null, at: WED });
    expect(await t.r.tick()).toBe('software');
    expect(t.rows.filter((r) => r.taskId === null).map((r) => r.deptId)).toEqual(['praw', 'rnd', 'hq']);
  });
  it('a full open-task limit starts nothing and keeps the row queued', async () => {
    const t = rig({ now: WED, open: false, depts: [{ id: 'software', enabled: true }] });
    await t.r.request('software', 'user:1');
    expect(await t.r.tick()).toBeNull();
    expect(t.rows[0]!.taskId).toBeNull();
  });
  it('a request expires after 24 hours (outcome failed) and starts nothing', async () => {
    const t = rig({ now: WED, depts: [{ id: 'software', enabled: true }] });
    t.rows.push({ deptId: 'software', week: 'D2026-11-10', kind: 'manual', taskId: null, outcome: null, at: WED - 25 * 3_600_000 });
    expect(await t.r.tick()).toBeNull();
    expect(t.rows[0]!.outcome).toBe('failed');
    expect(t.start).not.toHaveBeenCalled();
  });
  it('a skipped or thrown start marks the on-demand claim failed under its D-key', async () => {
    for (const o of [{ startResult: 'skipped' as const }, { startThrows: true }]) {
      const t = rig({ now: WED, depts: [{ id: 'software', enabled: true }], ...o });
      await t.r.request('software', 'user:1');
      expect(await t.r.tick()).toBe('software');
      expect(t.finishes).toEqual([['software', 'D2026-11-11', 'failed']]);
    }
  });
  it('the incident threshold fires once per day, counts only what is new since the last retro, and 0 turns it off', async () => {
    const t = rig({ now: WED, depts: [{ id: 'software', enabled: true }, { id: 'hq', enabled: true }, { id: 'praw', enabled: true }], incidents: { software: 5, hq: 4, praw: 50 } });
    expect(await t.r.tick()).toBe('software');
    expect(t.start.mock.calls[0]![0]).toMatchObject({ dept: 'software', week: 'D2026-11-11', kind: 'incident' });
    expect(t.rows.map((r) => r.deptId)).toEqual(['software']); // hq below the threshold, praw never
    expect(t.audits.map((a) => a.outcome)).toEqual(['incident queued']);
    expect(await t.r.tick()).toBeNull(); // same day: the key exists
    const off = rig({ now: WED, cfg: { 'grow.retro.incidentThreshold': 0 }, depts: [{ id: 'software', enabled: true }], incidents: { software: 99 } });
    expect(await off.r.tick()).toBeNull();
    expect(off.rows).toEqual([]);
  });
  it('a manual request and the incident trigger share the one day claim', async () => {
    const t = rig({ now: WED, depts: [{ id: 'software', enabled: true }], incidents: { software: 9 } });
    await t.r.request('software', 'user:1');
    await t.r.tick();
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]!.kind).toBe('manual');
    expect(t.audits.some((a) => a.outcome === 'incident queued')).toBe(false);
  });
  it('the weekly slot goes first and wins the tick; the weekly flow is unchanged (kind weekly)', async () => {
    const t = rig({ depts: [{ id: 'software', enabled: true }, { id: 'hq', enabled: true }], incidents: { hq: 9 } }); // Friday 16:00
    t.rows.push({ deptId: 'hq', week: 'D2026-11-13', kind: 'manual', taskId: null, outcome: null, at: at('2026-11-13') });
    expect(await t.r.tick()).toBe('software');
    expect(t.start.mock.calls[0]![0]).toMatchObject({ week: '2026-W46', kind: 'weekly' });
    expect(await t.r.tick()).toBe('hq'); // the weekly slot of hq is still open, so it goes before the queued manual row
    expect(t.start.mock.calls[1]![0].kind).toBe('weekly');
  });
  it('a store error on the on-demand step logs errName only and never throws', async () => {
    const t = rig({ now: WED, depts: [{ id: 'software', enabled: true }] });
    (t.r as never as { d: WeeklyRetroDeps }).d.repo.expireRequested = async () => { throw Object.assign(new Error('pg: secret'), { name: 'PgError' }); };
    expect(await t.r.tick()).toBeNull();
    expect(JSON.stringify(t.log.error.mock.calls)).toContain('PgError');
    expect(JSON.stringify(t.log.error.mock.calls)).not.toContain('secret');
  });
});
