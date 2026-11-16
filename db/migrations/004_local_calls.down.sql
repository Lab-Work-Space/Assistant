DELETE FROM approvals WHERE kind = 'local_cap';
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_kind_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_kind_check CHECK (kind IN ('estimate','tree_cap'));
ALTER TABLE approvals DROP COLUMN IF EXISTS cap_calls;
ALTER TABLE budget_days DROP COLUMN IF EXISTS calls;
