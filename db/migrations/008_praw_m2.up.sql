-- Praw M2: reminders, scheduled jobs, watches, lessons (R9, R10, R11, P13, P14, PF12).
-- Ids of Discord users/guilds/channels are text (snowflakes). legacy_id = old SQLite row id (import idempotency, Task 22).
CREATE TABLE reminders (
  id bigserial PRIMARY KEY,
  guild_id text NOT NULL,
  channel_id text NOT NULL,
  user_id text NOT NULL,
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 2000),
  remind_at timestamptz NOT NULL,
  every_minutes int CHECK (every_minutes >= 1),
  advance_minutes int CHECK (advance_minutes >= 0),
  notify_via text NOT NULL DEFAULT 'channel' CHECK (notify_via IN ('dm','channel')),
  -- one-off claim (R11); recurring rows are claimed by advancing remind_at instead (PF12)
  claimed_at timestamptz,
  -- a one-off whose claim was never delivered is re-claimed once after 5 minutes (Task 16); never again
  retried boolean NOT NULL DEFAULT false,
  -- advance notice (R9): set to the remind_at occurrence whose advance notice was claimed; differs again once remind_at moves
  advance_claimed_for timestamptz,
  fired_at timestamptz,
  cancelled boolean NOT NULL DEFAULT false,
  legacy_id bigint UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reminders_due_idx ON reminders(remind_at) WHERE NOT cancelled;
CREATE INDEX reminders_user_idx ON reminders(user_id) WHERE NOT cancelled;

CREATE TABLE scheduled_jobs (
  id bigserial PRIMARY KEY,
  guild_id text NOT NULL,
  channel_id text NOT NULL,
  user_id text NOT NULL,
  prompt text NOT NULL CHECK (length(prompt) BETWEEN 1 AND 4000),
  origin text NOT NULL CHECK (origin IN ('schedule','import')),
  kind text NOT NULL CHECK (kind IN ('daily','interval','once')),
  hhmm text CHECK (hhmm ~ '^[0-2][0-9]:[0-5][0-9]$'),
  tz text,
  interval_minutes int CHECK (interval_minutes >= 15),
  next_run_at timestamptz NOT NULL,
  last_claim timestamptz,
  active boolean NOT NULL DEFAULT true,
  legacy_id bigint UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scheduled_jobs_shape_check CHECK (
    (kind = 'interval' AND interval_minutes IS NOT NULL) OR (kind = 'daily' AND hhmm IS NOT NULL AND tz IS NOT NULL) OR kind = 'once')
);
CREATE INDEX scheduled_jobs_due_idx ON scheduled_jobs(next_run_at) WHERE active;
CREATE INDEX scheduled_jobs_user_idx ON scheduled_jobs(user_id) WHERE active;

CREATE TABLE watches (
  id bigserial PRIMARY KEY,
  guild_id text NOT NULL,
  channel_id text NOT NULL,
  user_id text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  kind text NOT NULL CHECK (kind IN ('url','topic')),
  target text NOT NULL CHECK (length(target) BETWEEN 1 AND 2000),
  interval_minutes int NOT NULL CHECK (interval_minutes >= 15),
  next_check_at timestamptz NOT NULL DEFAULT now(),
  last_snapshot text CHECK (length(last_snapshot) <= 6000),
  last_hrefs jsonb,
  has_baseline boolean NOT NULL DEFAULT false,
  fail_count int NOT NULL DEFAULT 0,
  legacy_id bigint UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX watches_due_idx ON watches(next_check_at) WHERE enabled;
CREATE INDEX watches_user_idx ON watches(user_id) WHERE enabled;

CREATE TABLE lessons (
  id bigserial PRIMARY KEY,
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 500),
  source text NOT NULL CHECK (source IN ('auto','manual','import')),
  author_id text,
  origin text NOT NULL CHECK (origin IN ('chat','slash','voice','delegated','schedule','watch','reminder','poll','import')),
  active boolean NOT NULL DEFAULT true,
  legacy_id bigint UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lessons_active_idx ON lessons(id DESC) WHERE active;
