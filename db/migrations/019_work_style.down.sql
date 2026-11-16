DROP TABLE IF EXISTS guard_state;
DROP INDEX IF EXISTS tasks_conversation_idx;
ALTER TABLE tasks DROP COLUMN IF EXISTS origin_message_id;
ALTER TABLE tasks DROP COLUMN IF EXISTS conversation;
ALTER TABLE tasks DROP COLUMN IF EXISTS origin_category_id;
