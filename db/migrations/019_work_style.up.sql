-- Work-style operation (docs/superpowers/specs/2026-11-03-work-style-design.md; Gate 1 WS4, WS6, WS13). Additive only.
-- origin_category_id: the Discord category where a root task was started; set by code from the fetched channel chain, copied to children, never from input (WS6).
ALTER TABLE tasks ADD COLUMN origin_category_id text CHECK (origin_category_id ~ '^[0-9]{17,20}$');
-- conversation: a head's or Praw's conversation root opened by code for a person's message (WS13); explicit, never inferred from origin.
ALTER TABLE tasks ADD COLUMN conversation boolean NOT NULL DEFAULT false;
-- origin_message_id: the person's message the roll-up replies to (WS13); a snowflake, never text.
ALTER TABLE tasks ADD COLUMN origin_message_id text CHECK (origin_message_id ~ '^[0-9]{17,20}$');
CREATE INDEX tasks_conversation_idx ON tasks(dept_id, thread_id) WHERE conversation;

-- WS4: the bot-talk guard state per channel or thread (key = thread id, else channel id), so a restart does not lift a stall.
-- Counters and flags only, never message text. Pruned after 6 hours idle by the guard.
CREATE TABLE guard_state (
  key text PRIMARY KEY CHECK (key ~ '^[0-9]{17,20}$'),
  run_count integer NOT NULL DEFAULT 0 CHECK (run_count >= 0),
  stalled boolean NOT NULL DEFAULT false,
  ceo_turn boolean NOT NULL DEFAULT false,
  reset_used boolean NOT NULL DEFAULT false,
  touched_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX guard_state_touched_idx ON guard_state(touched_at);
