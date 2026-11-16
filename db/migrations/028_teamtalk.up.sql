-- TEAMTALK-1 (docs/superpowers/specs/2026-11-08-teamtalk-design.md; Gate 1 T14): visible handoffs and team-room work boards.
-- Additive only. Task columns: what "done" means and when (model-written, display only), and the ids of the handoff line (H1) and of the owner's final report.
ALTER TABLE tasks ADD COLUMN acceptance text CHECK (length(acceptance) <= 300);
ALTER TABLE tasks ADD COLUMN due_on date;
ALTER TABLE tasks ADD COLUMN handoff_message_id text CHECK (handoff_message_id ~ '^[0-9]{17,20}$');
ALTER TABLE tasks ADD COLUMN result_message_id text CHECK (result_message_id ~ '^[0-9]{17,20}$');

-- What each persona room recorded: the team's memory read by later runs. Only code paths insert rows (never a Discord read); `tainted` defaults to true
-- (fail safe) and carries the producing run's taint. Retention: last 200 rows per persona (pruned on insert). Not granted to the executor role (T14).
CREATE TABLE room_entries (
  id bigserial PRIMARY KEY,
  persona_id text NOT NULL CHECK (length(persona_id) BETWEEN 1 AND 64),
  dept_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('assigned','done','blocked','cancelled','idea','decision')),
  task_id text,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 400),
  tainted boolean NOT NULL DEFAULT true,
  message_id text CHECK (message_id ~ '^[0-9]{17,20}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX room_entries_persona_idx ON room_entries (persona_id, created_at DESC);
CREATE INDEX room_entries_task_idx ON room_entries (task_id) WHERE task_id IS NOT NULL;
