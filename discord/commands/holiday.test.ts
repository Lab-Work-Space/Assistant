import { describe, expect, it } from 'vitest';
import { COMMANDS, handleInteraction } from './index.js';
import { cmd, makeDeps, text } from './test-helpers.js';

// makeDeps' clock: 2026-10-31T12:00Z, which is 2026-10-31 in Asia/Bangkok.
const holiday = (sub: string, strings: Record<string, string> = {}, extra = {}) => cmd('holiday', sub, { strings, ...extra });

describe('/holiday', () => {
  it('is registered with add, remove, list, weekdays and workday', () => {
    const def = COMMANDS.find((c) => c.name === 'holiday')!;
    expect(def.options!.map((o) => o.name)).toEqual(['add', 'remove', 'list', 'weekdays', 'workday']);
  });

  it('workday with no date makes today a working day (audited); remove drops it; a past date is refused', async () => {
    const t = await makeDeps();
    expect(text(await handleInteraction(holiday('workday'), t.deps))).toContain('2026-10-31');
    expect(t.deps.cfg.get('schedule.workDays')).toEqual(['2026-10-31']);
    expect(t.sets.at(-1)).toMatchObject({ key: 'schedule.workDays', by: 'user:u1' });
    expect(t.audits.at(-1)).toMatchObject({ actor: 'user:u1', action: 'holiday.workday', tool: '2026-10-31', outcome: 'ok' });
    await handleInteraction(holiday('workday', { date: '2026-11-01' }), t.deps);
    expect(t.deps.cfg.get('schedule.workDays')).toEqual(['2026-10-31', '2026-11-01']);
    await handleInteraction(holiday('workday', { date: '2026-10-31' }, { bools: { remove: true } }), t.deps);
    expect(t.deps.cfg.get('schedule.workDays')).toEqual(['2026-11-01']);
    expect(text(await handleInteraction(holiday('workday', { date: '2026-10-30' }), t.deps))).toMatch(/past/);
    expect(text(await handleInteraction(holiday('workday', { date: '2026-12-25' }, { bools: { remove: true } }), t.deps))).toMatch(/not a listed/);
    expect(text(await handleInteraction(holiday('workday', { date: 'today' }), t.deps))).toMatch(/YYYY-MM-DD/);
    expect(text(await handleInteraction(holiday('workday', {}, { roles: [] }), t.deps))).toContain('Only Bot Admins');
  });

  it('list shows the upcoming extra workdays', async () => {
    const t = await makeDeps();
    await t.deps.cfg.set('schedule.workDays', ['2026-10-01', '2026-11-01'], 'test');
    const out = text(await handleInteraction(holiday('list'), t.deps));
    expect(out).toContain('2026-11-01');
    expect(out).not.toContain('2026-10-01');
  });

  it('admin only, in #setting', async () => {
    const t = await makeDeps();
    expect(text(await handleInteraction(holiday('add', { date: '2026-12-31' }, { roles: [] }), t.deps))).toContain('Only Bot Admins');
    expect(text(await handleInteraction(holiday('add', { date: '2026-12-31' }, { channelId: '1565000000000000999' }), t.deps))).toContain('#⚙️-setting');
    expect(t.sets).toHaveLength(0);
  });

  it('add writes through ConfigStore.set, is audited, and re-adding a date replaces its name', async () => {
    const t = await makeDeps();
    expect(text(await handleInteraction(holiday('add', { date: '2026-12-31', name: ' New Year Eve ' }), t.deps))).toContain('2026-12-31');
    expect(t.deps.cfg.get('schedule.holidays')).toEqual([{ date: '2026-12-31', name: 'New Year Eve' }]);
    expect(t.sets.at(-1)).toMatchObject({ key: 'schedule.holidays', by: 'user:u1' });
    expect(t.audits.at(-1)).toMatchObject({ actor: 'user:u1', action: 'holiday.add', tool: '2026-12-31', outcome: 'ok' });
    await handleInteraction(holiday('add', { date: '2026-11-10' }), t.deps);
    await handleInteraction(holiday('add', { date: '2026-12-31', name: 'Eve' }), t.deps);
    expect(t.deps.cfg.get('schedule.holidays')).toEqual([{ date: '2026-11-10' }, { date: '2026-12-31', name: 'Eve' }]);
  });

  it('add refuses bad dates and over-long names without writing', async () => {
    const t = await makeDeps();
    for (const date of ['2026-02-30', '31/12/2026', 'tomorrow', '2026-1-1']) {
      expect(text(await handleInteraction(holiday('add', { date }), t.deps)), date).toMatch(/YYYY-MM-DD/);
    }
    expect(text(await handleInteraction(holiday('add', { date: '2026-12-31', name: 'x'.repeat(61) }), t.deps))).toMatch(/60/);
    expect(t.sets).toHaveLength(0);
  });

  it('add refuses a name with control characters before writing; a store failure is not mistaken for a bad name', async () => {
    const t = await makeDeps();
    expect(text(await handleInteraction(holiday('add', { date: '2026-12-31', name: 'a\nb' }), t.deps))).toMatch(/plain text/);
    expect(t.sets).toHaveLength(0);
    const broken = await makeDeps({ cfg: { ...t.deps.cfg, set: async () => { throw new Error('connection terminated'); } } });
    const out = text(await handleInteraction(holiday('add', { date: '2026-12-31', name: 'Eve' }), broken.deps));
    expect(out).toContain('That failed');
    expect(out).not.toMatch(/plain text/);
    expect(broken.logLines.join('')).toContain('command failed');
  });

  it('add refuses past 100 holidays', async () => {
    const t = await makeDeps();
    const full = Array.from({ length: 100 }, (_, i) => ({ date: new Date(Date.UTC(2027, 0, 1 + i)).toISOString().slice(0, 10) }));
    await t.deps.cfg.set('schedule.holidays', full, 'test');
    expect(text(await handleInteraction(holiday('add', { date: '2028-01-01' }), t.deps))).toMatch(/100/);
    expect(t.deps.cfg.get('schedule.holidays')).toHaveLength(100);
  });

  it('remove drops the date (audited); a date not listed is refused', async () => {
    const t = await makeDeps();
    await t.deps.cfg.set('schedule.holidays', [{ date: '2026-12-31' }, { date: '2026-11-10' }], 'test');
    expect(text(await handleInteraction(holiday('remove', { date: '2026-12-31' }), t.deps))).toContain('→');
    expect(t.deps.cfg.get('schedule.holidays')).toEqual([{ date: '2026-11-10' }]);
    expect(t.audits.at(-1)).toMatchObject({ action: 'holiday.remove', tool: '2026-12-31', outcome: 'ok' });
    expect(text(await handleInteraction(holiday('remove', { date: '2026-12-31' }), t.deps))).toContain('not a listed holiday');
  });

  it('list shows the weekly off days and the next 20 upcoming holidays in date order; past ones are counted, not listed', async () => {
    const t = await makeDeps();
    const future = Array.from({ length: 22 }, (_, i) => ({ date: new Date(Date.UTC(2026, 11, 31 - i)).toISOString().slice(0, 10), name: `H${i}` }));
    await t.deps.cfg.set('schedule.holidays', [{ date: '2026-10-30', name: 'Past' }, { date: '2026-10-31', name: 'Today' }, ...future], 'test');
    const out = text(await handleInteraction(holiday('list'), t.deps));
    expect(out).toContain('Sun, Sat');
    expect(out).not.toContain('Past');
    expect(out.indexOf('2026-10-31')).toBeLessThan(out.indexOf('2026-12-10'));
    expect(out).toContain('2026-12-10 H21');
    expect(out).toContain('2026-12-28');
    expect(out).not.toContain('2026-12-29'); // 21st upcoming
    expect(out).toMatch(/3 more/);
    expect(out).toMatch(/1 past/);
    expect(t.sets).toHaveLength(1); // listing writes nothing
  });

  it('weekdays sets schedule.offDays from day names; none clears; bad names are refused', async () => {
    const t = await makeDeps();
    expect(text(await handleInteraction(holiday('weekdays', { days: 'fri,sat' }), t.deps))).toContain('→');
    expect(t.deps.cfg.get('schedule.offDays')).toEqual([5, 6]);
    expect(t.audits.at(-1)).toMatchObject({ action: 'holiday.weekdays', tool: '5,6', outcome: 'ok' });
    await handleInteraction(holiday('weekdays', { days: 'none' }), t.deps);
    expect(t.deps.cfg.get('schedule.offDays')).toEqual([]);
    await handleInteraction(holiday('weekdays'), t.deps);
    expect(t.deps.cfg.get('schedule.offDays')).toEqual([]);
    expect(text(await handleInteraction(holiday('weekdays', { days: 'sat,funday' }), t.deps))).toMatch(/mon/);
    expect(t.sets).toHaveLength(3);
  });
});
