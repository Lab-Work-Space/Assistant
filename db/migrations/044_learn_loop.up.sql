-- LEARN-1: code-built department incidents; on-demand retro claims. Additive.
CREATE TABLE dept_incidents (
  id bigserial PRIMARY KEY,
  dept_id text NOT NULL REFERENCES departments(id),
  kind text NOT NULL CHECK (kind IN ('task_blocked','task_cancelled','tool_errors','heal_resolve')),
  code text NOT NULL CHECK (code ~ '^[a-z_]{1,40}$'),
  tool text CHECK (tool IS NULL OR tool ~ '^[a-z0-9_]{1,64}$'),
  task_id text CHECK (task_id IS NULL OR task_id ~ '^[0-9a-f-]{36}$'),
  n integer NOT NULL DEFAULT 1 CHECK (n BETWEEN 1 AND 100000),
  ikey text NOT NULL CHECK (char_length(ikey) BETWEEN 1 AND 160 AND ikey ~ '^[a-z0-9_:-]+$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dept_incidents_tool_kind CHECK ((kind = 'tool_errors') = (tool IS NOT NULL)),
  CONSTRAINT dept_incidents_task_kind CHECK ((kind <> 'tool_errors') = (task_id IS NOT NULL))
);
CREATE UNIQUE INDEX dept_incidents_key ON dept_incidents (dept_id, ikey);
CREATE INDEX dept_incidents_recent ON dept_incidents (dept_id, created_at DESC);
ALTER TABLE retro_runs ADD COLUMN kind text NOT NULL DEFAULT 'weekly' CHECK (kind IN ('weekly','manual','incident'));
ALTER TABLE retro_runs DROP CONSTRAINT retro_runs_week_check;
ALTER TABLE retro_runs ADD CONSTRAINT retro_runs_week_check CHECK (week ~ '^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$' OR week ~ '^D[0-9]{4}-[0-9]{2}-[0-9]{2}$');
ALTER TABLE retro_runs ADD CONSTRAINT retro_runs_kind_key CHECK ((kind = 'weekly') = (week ~ '^[0-9]{4}-W'));
CREATE INDEX retro_runs_requested ON retro_runs (claimed_at) WHERE task_id IS NULL AND outcome IS NULL;
