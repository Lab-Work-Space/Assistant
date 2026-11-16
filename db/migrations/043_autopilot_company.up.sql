-- AUTO-2: company autopilot counters and task-tree tool grants. Additive, plus the daily_runs kind list.
-- AC-C16: the counter also has a per-person daily scope (scope_key = '<YYYY-MM-DD>:<person id>').
CREATE TABLE autopilot_company_counts (
  scope text NOT NULL CHECK (scope IN ('day','tree','person')),
  scope_key text NOT NULL,
  used integer NOT NULL DEFAULT 0 CHECK (used >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, scope_key),
  CONSTRAINT autopilot_company_counts_key CHECK ((scope = 'day' AND scope_key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') OR (scope IN ('tree','person') AND char_length(scope_key) BETWEEN 1 AND 64))
);
CREATE TABLE tree_tools (
  root_task_id text NOT NULL REFERENCES tasks(id),
  dept_id text NOT NULL CHECK (dept_id ~ '^[a-z_]{1,32}$'),
  tool text NOT NULL CHECK (tool ~ '^[a-z0-9_]{1,64}$'),
  task_id text,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (root_task_id, dept_id, tool)
);
ALTER TABLE daily_runs DROP CONSTRAINT daily_runs_kind_check;
ALTER TABLE daily_runs ADD CONSTRAINT daily_runs_kind_check CHECK (kind IN ('goal','report','heal','ai_digest','autopilot_cap'));
