-- R4 / Gate 1 P3: a tool approval stores the exact validated call the approver saw. The input is canonical JSON
-- (sorted keys) and input_sha256 its digest; executed_at is the single-use claim (set atomically when the call is run).
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_kind_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_kind_check CHECK (kind IN ('estimate','tree_cap','local_cap','tool'));
ALTER TABLE approvals ADD COLUMN tool_name text;
ALTER TABLE approvals ADD COLUMN tool_input jsonb;
ALTER TABLE approvals ADD COLUMN input_sha256 text;
ALTER TABLE approvals ADD COLUMN executed_at timestamptz;
-- The executed call's outcome (redacted, capped) is kept until the owner's model turn has seen it: a run that stops before
-- its first model call (budget, halt, turn limit, provider down) must not lose it, and the call is never re-run.
ALTER TABLE approvals ADD COLUMN tool_result text;
ALTER TABLE approvals ADD COLUMN result_delivered_at timestamptz;
ALTER TABLE approvals ADD CONSTRAINT approvals_tool_call_check
  CHECK (kind <> 'tool' OR (tool_name IS NOT NULL AND tool_input IS NOT NULL AND input_sha256 IS NOT NULL));
CREATE INDEX approvals_tool_claim_idx ON approvals(task_id) WHERE kind = 'tool' AND status = 'approved' AND executed_at IS NULL;
