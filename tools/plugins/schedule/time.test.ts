import { describe, expect, it } from 'vitest';
import { nextRun, planJob } from './time.js';

const iso = (d: Date) => d.toISOString();

describe('time', () => {
  it('time › daily 09:00 Asia/Bangkok across midnight; once; interval', () => {
    const spec = { kind: 'daily' as const, hhmm: '09:00', tz: 'Asia/Bangkok' };
    // 23:30 Bangkok on Nov 1 -> 09:00 Bangkok on Nov 2 (crosses midnight)
    expect(iso(nextRun(spec, new Date('2026-11-01T16:30:00Z')))).toBe('2026-11-02T02:00:00.000Z');
    // 08:59 Bangkok -> same day 09:00; exactly 09:00 -> the next day (strictly after)
    expect(iso(nextRun(spec, new Date('2026-11-01T01:59:00Z')))).toBe('2026-11-01T02:00:00.000Z');
    expect(iso(nextRun(spec, new Date('2026-11-01T02:00:00Z')))).toBe('2026-11-02T02:00:00.000Z');
    // DST zone: America/New_York 09:00 after the Nov 1 2026 fall-back (EST, UTC-5)
    expect(iso(nextRun({ kind: 'daily', hhmm: '09:00', tz: 'America/New_York' }, new Date('2026-10-31T14:00:00Z')))).toBe('2026-11-01T14:00:00.000Z');
    expect(iso(nextRun({ kind: 'daily', hhmm: '09:00', tz: 'America/New_York' }, new Date('2026-11-01T14:00:00Z')))).toBe('2026-11-02T14:00:00.000Z');
    const at = new Date('2026-12-01T03:00:00Z');
    expect(nextRun({ kind: 'once', at }, new Date('2026-11-01T00:00:00Z'))).toEqual(at);
    expect(iso(nextRun({ kind: 'interval', intervalMinutes: 30 }, new Date('2026-11-01T00:00:00Z')))).toBe('2026-11-01T00:30:00.000Z');
    expect(() => nextRun({ kind: 'daily', hhmm: '09:00' }, new Date())).toThrow();
  });

  it('planJob validates each kind', () => {
    const now = Date.parse('2026-11-01T10:00:00Z');
    expect(planJob({ kind: 'daily', hhmm: '09:00' }, now, 'Asia/Bangkok')).toMatchObject({ kind: 'daily', hhmm: '09:00', tz: 'Asia/Bangkok', nextRunAt: new Date('2026-11-02T02:00:00Z') });
    expect(planJob({ kind: 'interval', intervalMinutes: 15 }, now, 'Asia/Bangkok')).toMatchObject({ kind: 'interval', intervalMinutes: 15, tz: null, nextRunAt: new Date(now + 15 * 60_000) });
    expect(planJob({ kind: 'once', at: '2026-11-02T09:00' }, now, 'Asia/Bangkok')).toMatchObject({ kind: 'once', nextRunAt: new Date('2026-11-02T02:00:00Z') });
    for (const bad of [
      { kind: 'interval' as const, intervalMinutes: 14 }, { kind: 'interval' as const }, { kind: 'daily' as const, hhmm: '25:00' }, { kind: 'daily' as const },
      { kind: 'once' as const, at: 'tomorrow' }, { kind: 'once' as const, at: '2026-11-01T09:00' }, { kind: 'once' as const },
    ]) expect('error' in planJob(bad, now, 'Asia/Bangkok'), JSON.stringify(bad)).toBe(true);
  });
});
