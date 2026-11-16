-- CLICKUP-ALL-1 (C9): the daily count of ClickUp writes made in workspace mode, one row per calendar day of the company timezone
-- (the application computes the day; this table never uses CURRENT_DATE). The cap is taken under the row lock of the upsert (db/repos/clickup-write-usage.ts).
CREATE TABLE clickup_write_usage (
  day  date    PRIMARY KEY,
  used integer NOT NULL DEFAULT 0 CHECK (used >= 0)
);
