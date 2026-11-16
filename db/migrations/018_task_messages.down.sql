DROP TABLE IF EXISTS board_messages;
ALTER TABLE tasks DROP COLUMN IF EXISTS card_message_id;
ALTER TABLE tasks DROP COLUMN IF EXISTS log_message_id;
