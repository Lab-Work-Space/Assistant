-- USAGE-1: the latest Claude subscription quota snapshot (one row) and the quota alerts already posted (one per window and reset period). Additive only; no secrets.
CREATE TABLE quota_snapshot (
  id smallint PRIMARY KEY CHECK (id = 1),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object' AND pg_column_size(snapshot) <= 2048),
  observed_at timestamptz NOT NULL
);
CREATE TABLE quota_alerts (
  win text NOT NULL CHECK (win IN ('five_hour','seven_day','seven_day_opus','seven_day_sonnet')),
  resets_at bigint NOT NULL CHECK (resets_at > 0),
  kind text NOT NULL CHECK (kind IN ('high','rejected')),
  posted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (win, resets_at, kind)
);
