DROP INDEX IF EXISTS tasks_awaiting_approval_idx;
ALTER TABLE tasks DROP COLUMN IF EXISTS awaiting_approval_id;
