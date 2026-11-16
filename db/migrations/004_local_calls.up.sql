-- Gate 1 L8: claude-code-local calls are counted, not priced. `calls` is an exact integer count on the daily
-- `local` row and on the lifetime per-root `task` row; money columns are never reused for counts.
-- Plain ADD COLUMN: re-applying this file fails instead of silently zeroing existing counts.
ALTER TABLE budget_days ADD COLUMN calls integer NOT NULL DEFAULT 0 CHECK (calls >= 0);
-- Per-root local call cap approvals: the approved cap is an integer call count, not USD.
ALTER TABLE approvals ADD COLUMN cap_calls integer CHECK (cap_calls > 0);
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_kind_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_kind_check CHECK (kind IN ('estimate','tree_cap','local_cap'));
