-- R3 / Gate 1 P1-P2: where a task came from is data written by code (never by tool input, prompt text or model output).
-- Existing rows predate the column and were all created by delegation or by a human goal; they are treated as the
-- least trusted origin ('delegated'). The default only exists to backfill and is dropped: every writer must say.
ALTER TABLE tasks ADD COLUMN origin text NOT NULL DEFAULT 'delegated';
ALTER TABLE tasks ALTER COLUMN origin DROP DEFAULT;
ALTER TABLE tasks ADD CONSTRAINT tasks_origin_check
  CHECK (origin IN ('chat','slash','voice','delegated','schedule','watch','reminder','poll','import'));
-- Channel the task's thread lives in when it is not the department work channel.
ALTER TABLE tasks ADD COLUMN channel_id text;
-- Who created the task (job runs): context only, never used as the requester.
ALTER TABLE tasks ADD COLUMN source_user_id text;
