-- Work-style §5 / Gate 1 WS11. Additive only.
-- daily_runs: one row per (local date in schedule.timezone, kind). The row IS the claim: it is inserted before the model call, so a run happens at
-- most once per day and kind, whatever restarts. `body` is the posted text (redacted, bounded), kept only so the next run can read "yesterday's
-- report"; it is model output and is wrapped as untrusted wherever it is read back.
CREATE TABLE daily_runs (
  day text NOT NULL CHECK (day ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  kind text NOT NULL CHECK (kind IN ('goal','report')),
  body text CHECK (body IS NULL OR length(body) <= 4000),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, kind)
);
