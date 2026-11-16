CREATE TABLE departments (
  id text PRIMARY KEY,
  name text NOT NULL,
  category_name_pattern text NOT NULL DEFAULT '',
  work_channel_id text,
  color integer NOT NULL DEFAULT 0,
  model text,
  provider text,
  enabled boolean NOT NULL DEFAULT true
);

CREATE TABLE personas (
  id text PRIMARY KEY,
  dept_id text NOT NULL REFERENCES departments(id),
  name text NOT NULL,
  avatar_url text,
  prompt_ref text NOT NULL,
  model text,
  provider text,
  tools text[] NOT NULL DEFAULT '{}',
  direct_channel_id text,
  enabled boolean NOT NULL DEFAULT true
);

CREATE TABLE channel_map (
  channel_id text PRIMARY KEY,
  dept_id text NOT NULL REFERENCES departments(id),
  is_work boolean NOT NULL DEFAULT false
);

CREATE TABLE persona_webhooks (
  channel_id text PRIMARY KEY,
  webhook_id text NOT NULL UNIQUE,
  application_id text NOT NULL,
  dept_id text NOT NULL REFERENCES departments(id)
);

CREATE TABLE tasks (
  id text PRIMARY KEY,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  dept_id text NOT NULL REFERENCES departments(id),
  owner jsonb NOT NULL,
  requester jsonb NOT NULL,
  parent_id text REFERENCES tasks(id),
  root_id text NOT NULL REFERENCES tasks(id) DEFERRABLE INITIALLY DEFERRED,
  depth integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'todo'
    CHECK (status IN ('todo','doing','review','done','blocked','awaiting_approval','cancelled')),
  thread_id text,
  turns_used integer NOT NULL DEFAULT 0,
  cost_usd numeric(12,6) NOT NULL DEFAULT 0,
  est_cost_usd numeric(12,6),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tasks_status_idx ON tasks(status);
CREATE INDEX tasks_thread_idx ON tasks(thread_id);
CREATE INDEX tasks_parent_idx ON tasks(parent_id);
CREATE INDEX tasks_root_idx ON tasks(root_id);

CREATE TABLE dept_notes (
  id bigserial PRIMARY KEY,
  dept_id text NOT NULL REFERENCES departments(id),
  task_id text REFERENCES tasks(id),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dept_notes_dept_idx ON dept_notes(dept_id, created_at DESC);

CREATE TABLE config (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE prompt_overrides (
  id bigserial PRIMARY KEY,
  ref text NOT NULL,
  body text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  active boolean NOT NULL DEFAULT true
);
CREATE INDEX prompt_overrides_ref_idx ON prompt_overrides(ref, active);

CREATE TABLE provider_keys (
  provider text PRIMARY KEY,
  ciphertext bytea NOT NULL,
  iv bytea NOT NULL,
  tag bytea NOT NULL
);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL,
  action text NOT NULL,
  task_id text,
  provider text,
  model text,
  tokens_in integer,
  tokens_out integer,
  cost_usd numeric(12,6),
  tool text,
  outcome text
);
CREATE INDEX audit_log_ts_idx ON audit_log(ts);

CREATE TABLE approvals (
  id bigserial PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id),
  reason text NOT NULL,
  est_cost_usd numeric(12,6),
  requested_by text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','expired')),
  decided_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);
CREATE INDEX approvals_status_idx ON approvals(status);

CREATE TABLE budget_days (
  day date NOT NULL,
  scope text NOT NULL,
  scope_id text NOT NULL,
  reserved_usd numeric(12,6) NOT NULL DEFAULT 0,
  spent_usd numeric(12,6) NOT NULL DEFAULT 0,
  PRIMARY KEY (day, scope, scope_id)
);
