DELETE FROM daily_runs WHERE kind = 'heal';
ALTER TABLE daily_runs DROP CONSTRAINT daily_runs_kind_check;
ALTER TABLE daily_runs ADD CONSTRAINT daily_runs_kind_check CHECK (kind IN ('goal','report'));
ALTER TABLE guard_state DROP COLUMN IF EXISTS lift_day;
ALTER TABLE guard_state DROP COLUMN IF EXISTS person_lifts;
ALTER TABLE guard_state DROP COLUMN IF EXISTS quiet_lifts;
ALTER TABLE guard_state DROP COLUMN IF EXISTS last_bot_turn_at;
