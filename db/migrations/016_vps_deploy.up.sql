-- VPS deploy (programme part 3, Gate 1 docs/security/2026-11-02-gate1-vps-deploy.md V22): a new card family `deploy`, the executor's
-- result message to the card channel (`deploy.result` outbox kind), the static-site upload the main application hands to the executor
-- (the executor runs as another macOS user and cannot read Praw's workspace), and the executor's own record of queued VPS jobs.
ALTER TABLE admin_cards DROP CONSTRAINT IF EXISTS admin_cards_kind_check;
ALTER TABLE admin_cards ADD CONSTRAINT admin_cards_kind_check CHECK (kind IN ('config', 'admin_op', 'perm', 'server', 'knowledge', 'deploy'));
ALTER TABLE exec_outbox DROP CONSTRAINT IF EXISTS exec_outbox_kind_check;
ALTER TABLE exec_outbox ADD CONSTRAINT exec_outbox_kind_check CHECK (kind IN ('welcome.post', 'alert', 'summary', 'deploy.result'));

-- Written by the main application (proposal), read and deleted by the executor. Content-addressed: the card stores only sha256 and size.
CREATE TABLE deploy_uploads (
  sha256 text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size integer NOT NULL CHECK (size BETWEEN 1 AND 52428800),
  data bytea NOT NULL,
  proposer_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The executor's jobs on the VPS (an add or a build runs for minutes): lets it resume polling after a restart. Ids only.
CREATE TABLE deploy_jobs (
  job text PRIMARY KEY CHECK (job ~ '^J-[0-9a-f]{16}$'),
  card_id text NOT NULL,
  op text NOT NULL,
  channel_id text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'done', 'failed', 'lost')),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX deploy_jobs_open_idx ON deploy_jobs (created_at) WHERE status = 'queued';
