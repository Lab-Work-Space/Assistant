-- G2-04 option 2: whether the run behind a task or a bot post had read outside text (taint), so a later run can trust its own
-- clean replies and no others. Existing tasks predate the column: they are treated as tainted (fail safe); the default only
-- exists to backfill and is dropped, so every writer must say.
ALTER TABLE tasks ADD COLUMN tainted boolean NOT NULL DEFAULT true;
ALTER TABLE tasks ALTER COLUMN tainted DROP DEFAULT;
-- One row per Discord message a department bot or persona posted from a run (message id -> taint of the producing run).
-- A history message of ours with no row here is unknown and counts as tainted. Rows older than the history window are pruned.
CREATE TABLE bot_messages (
  message_id text PRIMARY KEY,
  channel_id text NOT NULL,
  tainted boolean NOT NULL,
  -- Whose run it was: the human who triggered it, or the task requester for a run with no human trigger (null when that is not a person).
  -- A clean reply counts as clean only for that same person (a clean answer to one member is not clean for another).
  trigger_user_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bot_messages_created_idx ON bot_messages (created_at);
