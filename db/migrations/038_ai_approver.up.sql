-- 038_ai_approver.up.sql (AI-APPROVE-1)
ALTER TABLE approvals ADD COLUMN ai_review text CHECK (ai_review IS NULL OR char_length(ai_review) <= 200);
ALTER TABLE daily_runs DROP CONSTRAINT daily_runs_kind_check;
ALTER TABLE daily_runs ADD CONSTRAINT daily_runs_kind_check CHECK (kind IN ('goal','report','heal','ai_digest'));
