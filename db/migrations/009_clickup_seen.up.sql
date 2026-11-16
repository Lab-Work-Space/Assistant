-- Task 27: dedupe of ClickUp poll notices. One row per announced fact; insert-or-skip makes a notice once-only and restart-safe.
-- The special row (task_id '*', kind 'baseline') marks that the silent first run happened; its seen_at is the baseline time.
-- The row ('*', 'tick') holds the last completed comment window in its seen_at, so a restart resumes from it.
CREATE TABLE clickup_seen (
  task_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('baseline','tick','created','status_changed','assigned','comment')),
  fingerprint text NOT NULL,
  seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, kind, fingerprint)
);
CREATE INDEX clickup_seen_seen_at_idx ON clickup_seen(seen_at);
