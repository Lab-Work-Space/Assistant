-- Self-code / dev jobs (programme part 4, Gate 1 docs/security/2026-11-02-gate1-self-code.md): a new card family `code`, the executor's result message
-- (`code.result` outbox kind), the job record and the bundle the main application hands to the executor (the executor runs as another macOS user and
-- cannot read the owner's files). The request text is stored as tainted data (X22): any later run that reads it is tainted.
ALTER TABLE admin_cards DROP CONSTRAINT IF EXISTS admin_cards_kind_check;
ALTER TABLE admin_cards ADD CONSTRAINT admin_cards_kind_check CHECK (kind IN ('config', 'admin_op', 'perm', 'server', 'knowledge', 'deploy', 'code'));
ALTER TABLE exec_outbox DROP CONSTRAINT IF EXISTS exec_outbox_kind_check;
ALTER TABLE exec_outbox ADD CONSTRAINT exec_outbox_kind_check CHECK (kind IN ('welcome.post', 'alert', 'summary', 'deploy.result', 'code.result'));

CREATE TABLE dev_jobs (
  id text PRIMARY KEY CHECK (id ~ '^J-[0-9a-f]{16}$'),
  repo text NOT NULL CHECK (repo ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,99}/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$'),
  kind text NOT NULL CHECK (kind IN ('assistant', 'pr')),
  requester_id text NOT NULL CHECK (requester_id ~ '^[0-9]{17,20}$'),
  channel_id text,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'planning', 'coding', 'testing', 'reviewing', 'ready', 'failed', 'refused', 'cancelled', 'confirmed', 'applied', 'rolled_back')),
  request text NOT NULL CHECK (length(request) BETWEEN 1 AND 4000),
  tainted boolean NOT NULL DEFAULT true,
  base_sha text CHECK (base_sha ~ '^[0-9a-f]{40}$'),
  head_sha text CHECK (head_sha ~ '^[0-9a-f]{40}$'),
  bundle_sha256 text CHECK (bundle_sha256 ~ '^[0-9a-f]{64}$'),
  facts jsonb,
  verdicts jsonb,
  report text CHECK (length(report) <= 65536),
  diff text CHECK (length(diff) <= 2097152),
  card_id text,
  spend_usd numeric(12, 6) NOT NULL DEFAULT 0,
  outcome text CHECK (length(outcome) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX dev_jobs_created_idx ON dev_jobs (created_at DESC);
CREATE INDEX dev_jobs_open_idx ON dev_jobs (created_at) WHERE status IN ('queued', 'planning', 'coding', 'testing', 'reviewing');

-- Written by the main application, read by the executor. Content addressed; at most 20 MiB (X7).
CREATE TABLE dev_job_bundles (
  job text PRIMARY KEY REFERENCES dev_jobs (id) ON DELETE CASCADE,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size integer NOT NULL CHECK (size BETWEEN 1 AND 20971520),
  data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
