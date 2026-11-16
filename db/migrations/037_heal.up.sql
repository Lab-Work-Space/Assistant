-- HEAL-1 (Gate 1 HL-C18). Additive only, plus the daily_runs kind list.
-- guard_state: the warroom quiet clock (H3b) and the per-day lift counters (HL-C2), counted in schedule.timezone (lift_day).
-- Counters and timestamps only, never message text. touched_at stays the retention clock, so a new column holds the quiet clock.
ALTER TABLE guard_state ADD COLUMN last_bot_turn_at timestamptz NULL;
UPDATE guard_state SET last_bot_turn_at = touched_at;
ALTER TABLE guard_state ADD COLUMN quiet_lifts int NOT NULL DEFAULT 0;
ALTER TABLE guard_state ADD COLUMN person_lifts int NOT NULL DEFAULT 0;
ALTER TABLE guard_state ADD COLUMN lift_day text NULL;
-- daily_runs: the heal summary claims one row per day with kind 'heal'.
ALTER TABLE daily_runs DROP CONSTRAINT daily_runs_kind_check;
ALTER TABLE daily_runs ADD CONSTRAINT daily_runs_kind_check CHECK (kind IN ('goal','report','heal'));
