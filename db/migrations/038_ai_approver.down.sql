-- 038_ai_approver.down.sql
DELETE FROM daily_runs WHERE kind = 'ai_digest';
ALTER TABLE daily_runs DROP CONSTRAINT daily_runs_kind_check;
ALTER TABLE daily_runs ADD CONSTRAINT daily_runs_kind_check CHECK (kind IN ('goal','report','heal'));
ALTER TABLE approvals DROP COLUMN IF EXISTS ai_review;
