-- RFMD P5 (docs/security/2026-11-03-gate1-rfmd.md RF30, RF33): AI image and video.
-- media_usage: durable daily counters, one row per (UTC day, scope 'company'|'user', scope id, kind 'image'|'video'); `used` counts IMAGES or VIDEOS, taken under a row lock
-- before the budget is reserved (db/repos/media.ts). A restart forgets nothing.
CREATE TABLE media_usage (
  day     date    NOT NULL,
  scope   text    NOT NULL CHECK (scope IN ('company','user')),
  scope_id text   NOT NULL,
  kind    text    NOT NULL CHECK (kind IN ('image','video')),
  used    integer NOT NULL DEFAULT 0 CHECK (used >= 0),
  PRIMARY KEY (day, scope, scope_id, kind)
);
-- media_jobs: a Veo long-running job. The estimate is booked as SPENT when the job is submitted (RF29), so a boot that zeroes reserved_usd cannot free it.
-- status: running -> posting (claimed by a conditional UPDATE: the result is posted at most once) -> posted | failed | blocked | cancelled.
CREATE TABLE media_jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  op_name      text NOT NULL,
  requester_id text,
  actor        jsonb NOT NULL,
  channel_id   text NOT NULL,
  thread_id    text,
  task_id      text,
  reserved_usd numeric(12,6) NOT NULL CHECK (reserved_usd >= 0),
  seconds      integer NOT NULL,
  tainted      boolean NOT NULL,
  status       text NOT NULL DEFAULT 'running' CHECK (status IN ('running','posting','posted','failed','blocked','cancelled')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
CREATE INDEX media_jobs_open ON media_jobs (status) WHERE status IN ('running','posting');
-- Data only: a stored tools.byDept replaces the code default, so add the media grants to the stored lists of the duty holders (marketing, rnd, praw; video: marketing, praw).
-- A list that would pass the schema limit (100) is left alone (as 023).
UPDATE config
SET value = (
  SELECT jsonb_object_agg(k, CASE
    WHEN jsonb_typeof(v) <> 'array' OR NOT (k IN ('marketing','rnd','praw')) THEN v
    ELSE (SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) FROM (
            SELECT x FROM jsonb_array_elements(v) x
            UNION ALL SELECT to_jsonb('image_generate'::text) WHERE NOT v ? 'image_generate' AND jsonb_array_length(v) < 100
            UNION ALL SELECT to_jsonb('video_generate'::text) WHERE k IN ('marketing','praw') AND NOT v ? 'video_generate' AND jsonb_array_length(v) < 99
          ) s)
  END)
  FROM jsonb_each(value) AS e(k, v)
), version = version + 1, updated_by = 'migration:024'
WHERE key = 'tools.byDept' AND jsonb_typeof(value) = 'object' AND value <> '{}'::jsonb;
