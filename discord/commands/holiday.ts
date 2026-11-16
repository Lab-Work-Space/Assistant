import { localDay, weekdayNames } from '../../company/calendar.js';
import { applyPlan, isError, planHolidayAdd, planHolidayRemove, planWeekdays, planWorkday, refusal } from './plans.js';
import { configReply, type Handler } from './types.js';

const LISTED = 20;

const label = (h: { date: string; name?: string }) => (h.name ? `${h.date} ${h.name}` : h.date);

/**
 * `/holiday add date:<YYYY-MM-DD> [name]`: adds a company holiday (`schedule.holidays`); a date already listed gets the new name.
 * On an off day automated work waits (company/calendar.ts); humans are still answered. Bot Admin in #setting only (decide()); the
 * list goes through ConfigStore.set (validated, versioned, live without a restart) and is audited, like every config command.
 * The checks live in plans.ts (shared with the admin console).
 */
export const holidayAdd: Handler = async (i, deps) => {
  const p = planHolidayAdd(i.options.string('date'), i.options.string('name'), deps);
  return isError(p) ? refusal(p) : applyPlan(p, i.userId, deps);
};

/** `/holiday remove date:<YYYY-MM-DD>`. */
export const holidayRemove: Handler = async (i, deps) => {
  const p = planHolidayRemove(i.options.string('date'), deps);
  return isError(p) ? refusal(p) : applyPlan(p, i.userId, deps);
};

/** `/holiday list`: the weekly off days and the next 20 holidays from today (in schedule.timezone); past ones are only counted. */
export const holidayList: Handler = async (_i, deps) => {
  const today = localDay((deps.now?.() ?? new Date()).getTime(), deps.cfg.get('schedule.timezone')).date;
  const all = [...deps.cfg.get('schedule.holidays')].sort((a, b) => a.date.localeCompare(b.date));
  const upcoming = all.filter((h) => h.date >= today);
  const past = all.length - upcoming.length;
  const workdays = deps.cfg.get('schedule.workDays').filter((d) => d >= today);
  const lines = upcoming.slice(0, LISTED).map(label);
  if (upcoming.length > LISTED) lines.push(`… and ${upcoming.length - LISTED} more`);
  return configReply('Off days', `Weekly off days: ${weekdayNames(deps.cfg.get('schedule.offDays'))} (${deps.cfg.get('schedule.timezone')})`, {
    fields: [
      { name: 'Upcoming holidays', value: lines.join('\n') || '(none)' },
      ...(workdays.length ? [{ name: 'Extra workdays', value: workdays.join('\n') }] : []),
      ...(past ? [{ name: 'Earlier', value: `${past} past holiday${past === 1 ? '' : 's'} not shown` }] : []),
    ],
  });
};

/** `/holiday weekdays [days]`: the weekly off days, e.g. `sat,sun` or `fri,sat`; empty or `none` = no weekly off day. */
export const holidayWeekdays: Handler = async (i, deps) => {
  const p = planWeekdays(i.options.string('days'), deps);
  return isError(p) ? refusal(p) : applyPlan(p, i.userId, deps);
};

/**
 * `/holiday workday [date] [remove]`: makes a date (default today) a working day even when it is a weekly off day or a holiday
 * (`schedule.workDays`). Applied live: the off-day watch notices within a minute and releases held work.
 */
export const holidayWorkday: Handler = async (i, deps) => {
  const p = planWorkday(i.options.string('date'), i.options.boolean('remove') ?? false, deps);
  return isError(p) ? refusal(p) : applyPlan(p, i.userId, deps);
};
