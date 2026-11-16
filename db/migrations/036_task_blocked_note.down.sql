ALTER TABLE tasks DROP CONSTRAINT tasks_blocked_note_owner;
UPDATE tasks SET blocked_reason = NULL WHERE blocked_reason = 'owner';
ALTER TABLE tasks DROP COLUMN blocked_note;
ALTER TABLE tasks DROP CONSTRAINT tasks_blocked_reason_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_blocked_reason_check CHECK (blocked_reason IN ('halt','approval','budget','turns','error'));
