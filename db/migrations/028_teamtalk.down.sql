-- Dropping the table forgets the room memory; the handoff and result links stop being shown.
DROP TABLE IF EXISTS room_entries;
ALTER TABLE tasks DROP COLUMN IF EXISTS result_message_id, DROP COLUMN IF EXISTS handoff_message_id, DROP COLUMN IF EXISTS due_on, DROP COLUMN IF EXISTS acceptance;
