-- Task cards edited in place (Part B of docs/superpowers/specs/2026-11-02-teamwork-tasks-forum-design.md; Gate 1 TW15/TW16):
-- the #tasks log card and the thread card of a task, plus the pinned summary board. Additive only: nullable columns and one new table.
-- No backfill: existing tasks keep NULL and get their message the next time they change (never a repost of history).
ALTER TABLE tasks ADD COLUMN log_message_id text CHECK (log_message_id ~ '^[0-9]{17,20}$');
ALTER TABLE tasks ADD COLUMN card_message_id text CHECK (card_message_id ~ '^[0-9]{17,20}$');

-- Ids and a digest only, never message text. key 'tasks-board' is the summary board.
CREATE TABLE board_messages (
  key text PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 64),
  channel_id text NOT NULL CHECK (channel_id ~ '^[0-9]{17,20}$'),
  message_id text NOT NULL CHECK (message_id ~ '^[0-9]{17,20}$'),
  digest text CHECK (digest ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
