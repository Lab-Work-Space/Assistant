-- GROW-1: weekly retro claims, AI skill review text, tool requests, tool ideas. Additive only.
CREATE TABLE retro_runs (
  dept_id text NOT NULL CHECK (dept_id ~ '^[a-z_]{1,32}$'),
  week text NOT NULL CHECK (week ~ '^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$'),
  task_id text CHECK (task_id IS NULL OR task_id ~ '^[0-9a-f-]{36}$'),
  skill_claimed_at timestamptz,
  skill_proposal_id bigint,
  outcome text CHECK (outcome IS NULL OR outcome IN ('done','failed','interrupted')),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  PRIMARY KEY (dept_id, week)
);
CREATE UNIQUE INDEX retro_runs_task_idx ON retro_runs (task_id) WHERE task_id IS NOT NULL;
ALTER TABLE skill_proposals ADD COLUMN ai_review text CHECK (ai_review IS NULL OR char_length(ai_review) <= 200);
CREATE TABLE tool_requests (
  id bigserial PRIMARY KEY,
  token text NOT NULL UNIQUE CHECK (token ~ '^[0-9a-f]{32}$'),
  dept_id text NOT NULL CHECK (dept_id ~ '^[a-z_]{1,32}$'),
  tool text NOT NULL CHECK (tool ~ '^[a-z0-9_]{1,64}$'),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 300),
  task_id text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired','void')),
  channel_id text CHECK (channel_id IS NULL OR channel_id ~ '^[0-9]{17,20}$'),
  message_id text CHECK (message_id IS NULL OR message_id ~ '^[0-9]{17,20}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  decided_by text CHECK (decided_by IS NULL OR decided_by ~ '^[0-9]{17,20}$'),
  decided_at timestamptz,
  outcome text CHECK (outcome IS NULL OR char_length(outcome) <= 64),
  CONSTRAINT tool_requests_expiry CHECK (expires_at > created_at AND expires_at <= created_at + interval '7 days 1 hour'),
  CONSTRAINT tool_requests_decided CHECK (status IN ('pending','expired') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL))
);
CREATE UNIQUE INDEX tool_requests_one_pending ON tool_requests (dept_id, tool) WHERE status = 'pending';
CREATE INDEX tool_requests_expiry_idx ON tool_requests (expires_at) WHERE status = 'pending';
CREATE TABLE tool_ideas (
  id bigserial PRIMARY KEY,
  dept_id text NOT NULL CHECK (dept_id ~ '^[a-z_]{1,32}$'),
  name text NOT NULL CHECK (name ~ '^[a-z][a-z0-9_-]{1,39}$'),
  problem text NOT NULL CHECK (char_length(problem) BETWEEN 10 AND 500),
  example text NOT NULL CHECK (char_length(example) BETWEEN 1 AND 500),
  tainted boolean NOT NULL,
  task_id text,
  proposer text NOT NULL CHECK (proposer ~ '^head:[a-z_]{1,32}$'),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_by text CHECK (closed_by IS NULL OR closed_by ~ '^[0-9]{17,20}$'),
  closed_at timestamptz,
  close_reason text CHECK (close_reason IS NULL OR char_length(close_reason) <= 200),
  CONSTRAINT tool_ideas_closed CHECK ((status = 'closed') = (closed_at IS NOT NULL AND closed_by IS NOT NULL))
);
CREATE UNIQUE INDEX tool_ideas_one_open ON tool_ideas (dept_id, name) WHERE status = 'open';
