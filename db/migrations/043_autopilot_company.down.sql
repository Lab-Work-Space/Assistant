DELETE FROM daily_runs WHERE kind = 'autopilot_cap';
ALTER TABLE daily_runs DROP CONSTRAINT daily_runs_kind_check;
ALTER TABLE daily_runs ADD CONSTRAINT daily_runs_kind_check CHECK (kind IN ('goal','report','heal','ai_digest'));
DROP TABLE IF EXISTS tree_tools;
DROP TABLE IF EXISTS autopilot_company_counts;
