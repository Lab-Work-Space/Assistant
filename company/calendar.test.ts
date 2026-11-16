import { describe, expect, it, vi } from 'vitest';
import { FakeConfig } from '../governance/test-helpers.js';
import { createCalendar, localDay, OffDayWatch, parseWeekdays, weekdayNames } from './calendar.js';

// 2026-11-06 is a Friday; Asia/Bangkok is UTC+7 all year.
const FRI_2359_BKK = Date.parse('2026-11-06T16:59:59Z');
const SAT_0000_BKK = Date.parse('2026-11-06T17:00:00Z'); // still Friday in UTC
const SUN_2359_BKK = Date.parse('2026-11-08T16:59:59Z');
const MON_0000_BKK = Date.parse('2026-11-08T17:00:00Z');

describe('calendar', () => {
  it('localDay gives the date and weekday in the zone', () => {
    expect(localDay(SAT_0000_BKK, 'Asia/Bangkok')).toEqual({ date: '2026-11-07', weekday: 6 });
    expect(localDay(SAT_0000_BKK, 'UTC')).toEqual({ date: '2026-11-06', weekday: 5 });
  });

  it('default Saturday and Sunday are off, judged at 00:00 Asia/Bangkok, not UTC', () => {
    const cal = createCalendar(new FakeConfig());
    expect(cal.isOffDay(FRI_2359_BKK)).toEqual({ off: false });
    expect(cal.isOffDay(SAT_0000_BKK)).toEqual({ off: true, reason: 'weekday' });
    expect(cal.isOffDay(SUN_2359_BKK)).toEqual({ off: true, reason: 'weekday' });
    expect(cal.isOffDay(MON_0000_BKK)).toEqual({ off: false });
  });

  it('a listed extra workday is not off, even on a weekend or a listed holiday', () => {
    const cal = createCalendar(new FakeConfig({ 'schedule.workDays': ['2026-11-08', '2026-12-31'], 'schedule.holidays': [{ date: '2026-12-31', name: 'Eve' }] }));
    expect(cal.isOffDay(SUN_2359_BKK)).toEqual({ off: false, reason: 'workday' });
    expect(cal.isOffDay(SAT_0000_BKK)).toEqual({ off: true, reason: 'weekday' });
    expect(cal.isOffDay(Date.parse('2026-12-31T05:00:00Z'))).toEqual({ off: false, reason: 'workday' });
  });

  it('schedule.timezone moves the day boundary', () => {
    const cal = createCalendar(new FakeConfig({ 'schedule.timezone': 'UTC' }));
    expect(cal.isOffDay(SAT_0000_BKK)).toEqual({ off: false }); // Friday 17:00 UTC
    expect(cal.isOffDay(MON_0000_BKK)).toEqual({ off: true, reason: 'weekday' }); // Sunday 17:00 UTC
  });

  it('a listed holiday is off with its name; a holiday on a weekend reports holiday', () => {
    const cal = createCalendar(new FakeConfig({ 'schedule.holidays': [{ date: '2026-12-31', name: 'New Year Eve' }, { date: '2026-11-07' }] }));
    expect(cal.isOffDay(Date.parse('2026-12-31T05:00:00Z'))).toEqual({ off: true, reason: 'holiday', name: 'New Year Eve' });
    expect(cal.isOffDay(Date.parse('2026-12-30T16:59:59Z'))).toEqual({ off: false }); // Wed 23:59:59 BKK
    expect(cal.isOffDay(SAT_0000_BKK)).toEqual({ off: true, reason: 'holiday' });
  });

  it('config changes apply live, without a new calendar', async () => {
    const cfg = new FakeConfig();
    const cal = createCalendar(cfg);
    expect(cal.isOffDay(SAT_0000_BKK).off).toBe(true);
    await cfg.set('schedule.offDays', [], 'test');
    expect(cal.isOffDay(SAT_0000_BKK)).toEqual({ off: false });
    await cfg.set('schedule.offDays', [5], 'test');
    expect(cal.isOffDay(FRI_2359_BKK)).toEqual({ off: true, reason: 'weekday' });
    await cfg.set('schedule.holidays', [{ date: '2026-11-09', name: 'Bridge day' }], 'test');
    expect(cal.isOffDay(MON_0000_BKK)).toEqual({ off: true, reason: 'holiday', name: 'Bridge day' });
  });

  it('parseWeekdays accepts mon..sun names (short or full, any case, comma or space separated) and none', () => {
    expect(parseWeekdays('sat,sun')).toEqual([0, 6]);
    expect(parseWeekdays(' Fri, SAT ')).toEqual([5, 6]);
    expect(parseWeekdays('monday wednesday')).toEqual([1, 3]);
    expect(parseWeekdays('sun,sun')).toEqual([0]);
    expect(parseWeekdays('')).toEqual([]);
    expect(parseWeekdays('none')).toEqual([]);
    for (const bad of ['xyz', 'sat,funday', 'sat,,sun,1', 'mo']) expect(parseWeekdays(bad), bad).toBeNull();
    expect(weekdayNames([0, 6])).toBe('Sun, Sat');
    expect(weekdayNames([])).toBe('none');
  });
});

describe('OffDayWatch', () => {
  it('logs once at the first check and on each change; leaving an off day calls onWorkday', () => {
    let now = FRI_2359_BKK;
    const log = { info: vi.fn() };
    const onWorkday = vi.fn();
    const w = new OffDayWatch({ calendar: createCalendar(new FakeConfig()), clock: () => now, log, onWorkday });
    expect(w.check()).toEqual({ off: false });
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info.mock.calls[0]![1]).toMatch(/workday/);
    w.check();
    expect(log.info).toHaveBeenCalledTimes(1);
    now = SAT_0000_BKK;
    expect(w.check()).toEqual({ off: true, reason: 'weekday' });
    expect(log.info).toHaveBeenCalledTimes(2);
    expect(log.info.mock.calls[1]![1]).toMatch(/off day started/);
    now = SUN_2359_BKK;
    w.check();
    expect(log.info).toHaveBeenCalledTimes(2);
    expect(onWorkday).not.toHaveBeenCalled();
    now = MON_0000_BKK;
    w.check();
    expect(log.info.mock.calls[2]![1]).toMatch(/off day ended/);
    expect(onWorkday).toHaveBeenCalledTimes(1);
  });

  it('booting on an off day logs it; start/stop manage an unref timer', () => {
    vi.useFakeTimers();
    try {
      let now = SAT_0000_BKK;
      const log = { info: vi.fn() };
      const onWorkday = vi.fn();
      const w = new OffDayWatch({ calendar: createCalendar(new FakeConfig()), clock: () => now, log, onWorkday, intervalMs: 1000 });
      w.start();
      expect(log.info).toHaveBeenCalledTimes(1);
      expect(log.info.mock.calls[0]![0]).toMatchObject({ offDay: true, reason: 'weekday' });
      now = MON_0000_BKK;
      vi.advanceTimersByTime(1000);
      expect(onWorkday).toHaveBeenCalledTimes(1);
      w.stop();
      now = SAT_0000_BKK + 7 * 86_400_000;
      vi.advanceTimersByTime(5000);
      expect(log.info).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
