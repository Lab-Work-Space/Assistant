-- OFFDAY-1: tasks.offday_notice_on, on a ROOT task: the local calendar day (schedule.timezone) on which its person was told that delegated work is
-- held for the next workday. One notice per root per off day, taken with a conditional UPDATE (scheduler.noteHeld); it survives a restart.
ALTER TABLE tasks ADD COLUMN offday_notice_on date;
