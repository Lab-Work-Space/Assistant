import { describe, expect, it } from 'vitest';
import { admission, mayStart, RefusalGate, utcDayStart, utcMonthStart } from './limits.js';

describe('X24 limits', () => {
  const c = { day: 0, requesterDay: 0, monthSpendUsd: 0 };
  it('admission: 10 per day, 3 per person, the monthly budget', () => {
    expect(admission(c, { budgetUsd: 20 })).toBeNull();
    expect(admission({ ...c, day: 10 }, { budgetUsd: 20 })).toMatch(/10 dev jobs per day/);
    expect(admission({ ...c, requesterDay: 3 }, { budgetUsd: 20 })).toMatch(/3 dev jobs per person/);
    expect(admission({ ...c, monthSpendUsd: 20 }, { budgetUsd: 20 })).toMatch(/monthly/);
    expect(admission({ ...c, monthSpendUsd: 19.99 }, { budgetUsd: 20 })).toBeNull();
  });
  it('a job starts only when not halted, not an off day and nothing is running', () => {
    expect(mayStart({ running: 0, halted: false, offDay: false })).toEqual({ start: true });
    expect(mayStart({ running: 1, halted: false, offDay: false })).toEqual({ start: false, why: 'busy' });
    expect(mayStart({ running: 0, halted: true, offDay: true })).toEqual({ start: false, why: 'halted' });
    expect(mayStart({ running: 0, halted: false, offDay: true })).toEqual({ start: false, why: 'off day' });
  });
  it('a burst of refused proposals is blocked, per person, and recovers after the window', () => {
    let t = 0;
    const g = new RefusalGate(() => t);
    for (let i = 0; i < 5; i++) { expect(g.blocked('u')).toBe(false); g.noteRefused('u'); }
    expect(g.blocked('u')).toBe(true);
    expect(g.blocked('other')).toBe(false);
    t += 10 * 60_000 + 1;
    expect(g.blocked('u')).toBe(false);
  });
  it('windows are UTC', () => {
    expect(utcDayStart(new Date('2026-11-02T23:59:00Z')).toISOString()).toBe('2026-11-02T00:00:00.000Z');
    expect(utcMonthStart(new Date('2026-11-17T10:00:00Z')).toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });
});
