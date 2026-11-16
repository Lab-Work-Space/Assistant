import { describe, expect, it } from 'vitest';
import { CONFIG_DEFAULTS } from './defaults.js';
import { ConfigSchema } from './schema.js';

describe('config schema', () => {
  it('media.ytHostAllowlist: lower-case host names only, never an IP literal; default includes m.youtube.com', () => {
    const s = ConfigSchema['media.ytHostAllowlist'];
    expect(CONFIG_DEFAULTS['media.ytHostAllowlist']).toEqual(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);
    expect(s.safeParse(CONFIG_DEFAULTS['media.ytHostAllowlist']).success).toBe(true);
    expect(s.safeParse(['invidious.example.org', 'a1.b2.example']).success).toBe(true);
    for (const bad of [['10.0.0.1'], ['127.1'], ['1.2.3.4'], ['host.0x7f'], ['a.b.123'], ['YouTube.com'], ['localhost'], ['youtube.com/'], ['*.youtube.com'], [], ['x'.repeat(254)]])
      expect(s.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it('schedule.offDays: unique weekday numbers 0-6, at most 7; default Saturday and Sunday', () => {
    const s = ConfigSchema['schedule.offDays'];
    expect(CONFIG_DEFAULTS['schedule.offDays']).toEqual([0, 6]);
    for (const ok of [[], [0, 6], [5, 6], [0, 1, 2, 3, 4, 5, 6]]) expect(s.safeParse(ok).success, JSON.stringify(ok)).toBe(true);
    for (const bad of [[7], [-1], [1.5], [0, 0], ['sat'], [0, 1, 2, 3, 4, 5, 6, 0]]) expect(s.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it('schedule.holidays: real calendar dates, unique by date, name up to 60 characters, at most 100; default none', () => {
    const s = ConfigSchema['schedule.holidays'];
    expect(CONFIG_DEFAULTS['schedule.holidays']).toEqual([]);
    expect(s.safeParse([{ date: '2026-12-31', name: 'New Year Eve' }, { date: '2028-02-29' }]).success).toBe(true);
    for (const bad of [
      [{ date: '2026-02-30' }], [{ date: '2027-02-29' }], [{ date: '2026-13-01' }], [{ date: '2026-1-01' }], [{ date: '31/12/2026' }],
      [{ date: '2026-12-31', name: 'x'.repeat(61) }], [{ date: '2026-12-31', name: '' }], [{ date: '2026-12-31', name: 'a\nb' }],
      [{ date: '2026-12-31' }, { date: '2026-12-31', name: 'dup' }], [{ date: '2026-12-31', extra: 1 }],
    ]) expect(s.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    const many = Array.from({ length: 101 }, (_, i) => ({ date: new Date(Date.UTC(2027, 0, 1 + i)).toISOString().slice(0, 10) }));
    expect(s.safeParse(many.slice(0, 100)).success).toBe(true);
    expect(s.safeParse(many).success).toBe(false);
  });
});
