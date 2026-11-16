-- Tool approvals cannot exist without the new kind and columns: drop them (tasks.awaiting_approval_id is ON DELETE SET NULL).
DELETE FROM approvals WHERE kind = 'tool';
DROP INDEX IF EXISTS approvals_tool_claim_idx;
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_tool_call_check;
ALTER TABLE approvals DROP COLUMN IF EXISTS result_delivered_at;
ALTER TABLE approvals DROP COLUMN IF EXISTS tool_result;
ALTER TABLE approvals DROP COLUMN IF EXISTS executed_at;
ALTER TABLE approvals DROP COLUMN IF EXISTS input_sha256;
ALTER TABLE approvals DROP COLUMN IF EXISTS tool_input;
ALTER TABLE approvals DROP COLUMN IF EXISTS tool_name;
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_kind_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_kind_check CHECK (kind IN ('estimate','tree_cap','local_cap'));
