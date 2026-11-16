-- R5 RELEASE-1: one Bot Admin approval per deliverable; the approved bytes are the released bytes. Additive only.
CREATE TABLE releases (
  id bigserial PRIMARY KEY,
  token text NOT NULL UNIQUE CHECK (token ~ '^[0-9a-f]{32}$'),
  dept_id text NOT NULL CHECK (dept_id ~ '^[a-z_]{1,32}$'),
  requester text NOT NULL CHECK (requester ~ '^head:[a-z_]{1,32}$'),
  task_id text NOT NULL CHECK (task_id ~ '^[0-9a-f-]{36}$'),
  root_id text NOT NULL CHECK (root_id ~ '^[0-9a-f-]{36}$'),
  project_id bigint REFERENCES projects(id) ON DELETE SET NULL,
  target text NOT NULL CONSTRAINT releases_target_check CHECK (target IN ('handoff')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 600),
  slug text NOT NULL CHECK (slug ~ '^[a-z][a-z0-9-]{1,39}$'),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  bytes integer NOT NULL CHECK (bytes BETWEEN 1 AND 10000000),
  files integer NOT NULL CHECK (files BETWEEN 1 AND 2000),
  skipped integer NOT NULL DEFAULT 0 CHECK (skipped BETWEEN 0 AND 100000),
  zip bytea,
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object' AND pg_column_size(evidence) <= 2048),
  tainted boolean NOT NULL,
  catalog_digest text NOT NULL CHECK (catalog_digest ~ '^[0-9a-f]{64}$'),
  source_channel_id text NOT NULL CHECK (source_channel_id ~ '^[0-9]{17,20}$'),
  source_thread_id text CHECK (source_thread_id IS NULL OR source_thread_id ~ '^[0-9]{17,20}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','releasing','released','rejected','expired','failed')),
  channel_id text CHECK (channel_id IS NULL OR channel_id ~ '^[0-9]{17,20}$'),
  message_id text CHECK (message_id IS NULL OR message_id ~ '^[0-9]{17,20}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  decided_by text CHECK (decided_by IS NULL OR decided_by ~ '^[0-9]{17,20}$'),
  decided_at timestamptz,
  reason text CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 200),
  released_message_id text CHECK (released_message_id IS NULL OR released_message_id ~ '^[0-9]{17,20}$'),
  released_at timestamptz,
  outcome text CHECK (outcome IS NULL OR outcome ~ '^[a-z_]{1,32}$'),
  CONSTRAINT releases_expiry CHECK (expires_at > created_at AND expires_at <= created_at + interval '7 days 1 hour'),
  CONSTRAINT releases_zip CHECK ((status IN ('pending','releasing')) = (zip IS NOT NULL) AND (zip IS NULL OR octet_length(zip) = bytes)),
  CONSTRAINT releases_decided CHECK (status IN ('pending','expired') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CONSTRAINT releases_released CHECK ((status = 'released') = (released_at IS NOT NULL AND released_message_id IS NOT NULL))
);
CREATE UNIQUE INDEX releases_one_open_per_tree ON releases (root_id) WHERE status IN ('pending','releasing');
CREATE INDEX releases_open_dept_idx ON releases (dept_id) WHERE status IN ('pending','releasing');
CREATE INDEX releases_expiry_idx ON releases (expires_at) WHERE status = 'pending';
CREATE INDEX releases_dept_created_idx ON releases (dept_id, created_at);
