# Off days and holidays

When automated work pauses, and how to change the weekly off days and the holiday list.

## Off days and holidays

- Off days are Saturday and Sunday by default (`schedule.offDays`) plus the dates in `schedule.holidays`, judged in `schedule.timezone` (default Asia/Bangkok, so the day turns at 00:00 Bangkok time). Changes apply without a restart.
- On an off day automated work stops; people can still talk to every bot. Runs started by a human (chat, slash commands, `/ask`, voice, a goal for the CEO) run as usual. Tasks of any other origin (delegated, schedule, import, ...) stay `todo` and start on the next workday; a head that delegates during a chat is told so and can say it. Roll-ups and bot-to-bot messages wait in memory and start when the day turns, or after `/resume` if the system is halted then. After a restart on an off day, a Praw conversation keeps waiting in `review` and its last finished subtask is rolled up on the next workday; other held bot messages are dropped, and their task is picked up again by recovery. Bot-to-bot messages inside a thread a human started still run. ClickUp change notices (no model) are not paused.
- A scheduled job occurrence that falls on an off day is skipped (one `schedule.skip` audit row, outcome `off day`), not caught up later; a one-off job on an off day is gone. Watches are not checked on off days and resume on the next workday. Reminders fire on time. `/halt` is separate and unchanged.
- Commands (Bot Admin, `#⚙️-setting`, audited): `/holiday add date:2026-12-31 name:New Year Eve`, `/holiday remove date:2026-12-31`, `/holiday list` (weekly off days and the next 20 holidays), `/holiday weekdays days:sat,sun` (`fri,sat`, or `none` for no weekly off day; the option is required).
- `/healthz` reports `offDay` (and `offDayReason`: `weekday` or `holiday`). The log has one info line at boot and one each time an off day starts or ends.

Back to the [documentation index](../_index.md).
