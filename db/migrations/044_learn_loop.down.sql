DELETE FROM retro_runs WHERE kind <> 'weekly';
DROP INDEX IF EXISTS retro_runs_requested;
ALTER TABLE retro_runs DROP CONSTRAINT IF EXISTS retro_runs_kind_key;
ALTER TABLE retro_runs DROP CONSTRAINT IF EXISTS retro_runs_week_check;
ALTER TABLE retro_runs ADD CONSTRAINT retro_runs_week_check CHECK (week ~ '^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$');
ALTER TABLE retro_runs DROP COLUMN IF EXISTS kind;
DROP TABLE IF EXISTS dept_incidents;
