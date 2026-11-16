-- warroom_say (docs/superpowers/specs/2026-11-03-live-findings-fixes-design.md F2; Gate 1 LF7). Additive only: one nullable column.
-- warroom_say_id: the #ai-warroom message a conversation task is waiting on (a snowflake, never text). Set when a head asks another head there;
-- cleared by a conditional UPDATE when the single roll-up claims it (so it runs at most once, also across a restart).
ALTER TABLE tasks ADD COLUMN warroom_say_id text CHECK (warroom_say_id ~ '^[0-9]{17,20}$');
