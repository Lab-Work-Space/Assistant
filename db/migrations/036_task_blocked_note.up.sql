-- TASKADMIN-1 (TA-C13): a model that blocks its own task says why. blocked_reason gains 'owner' (update_task); the model-written note (masked, at most 300 characters,
-- display only: only TaskRepo.listOpenAdmin reads it) is kept for /task list. The constraint name is the auto-name of migration 003's unnamed column CHECK; there is
-- deliberately no IF EXISTS, so a wrong name fails this migration instead of leaving the old CHECK (which would refuse 'owner' at run time).
ALTER TABLE tasks DROP CONSTRAINT tasks_blocked_reason_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_blocked_reason_check CHECK (blocked_reason IN ('halt','approval','budget','turns','error','owner'));
ALTER TABLE tasks ADD COLUMN blocked_note text CHECK (blocked_note IS NULL OR char_length(blocked_note) <= 300);
-- Backstop: a note belongs to one owner-blocked spell. A writer that moves the status without clearing it fails loudly here.
ALTER TABLE tasks ADD CONSTRAINT tasks_blocked_note_owner CHECK (blocked_note IS NULL OR (status = 'blocked' AND blocked_reason = 'owner'));
