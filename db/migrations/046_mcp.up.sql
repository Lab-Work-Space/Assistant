-- R6 MCP-1: Bot Admin allowlist of sandboxed stdio MCP servers. Additive only.
CREATE TABLE mcp_servers (
  id bigserial PRIMARY KEY,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z][a-z0-9]{1,15}$'),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  image_id text NOT NULL CHECK (image_id ~ '^sha256:[0-9a-f]{64}$'),
  image_ref text CHECK (image_ref IS NULL OR image_ref ~ '^[A-Za-z0-9._/:@-]{1,200}$'),
  command jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(command) = 'array' AND jsonb_array_length(command) <= 16 AND pg_column_size(command) <= 4096),
  env jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(env) = 'object' AND pg_column_size(env) <= 4096),
  tool_class text NOT NULL CHECK (tool_class IN ('read','write')),
  transport text NOT NULL DEFAULT 'stdio' CONSTRAINT mcp_servers_transport_check CHECK (transport IN ('stdio')),
  egress text NOT NULL DEFAULT 'none' CONSTRAINT mcp_servers_egress_check CHECK (egress IN ('none')),
  timeout_ms integer NOT NULL DEFAULT 60000 CHECK (timeout_ms BETWEEN 5000 AND 120000),
  max_calls_per_day integer NOT NULL DEFAULT 100 CHECK (max_calls_per_day BETWEEN 1 AND 1000),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'array' AND jsonb_array_length(snapshot) BETWEEN 1 AND 32 AND pg_column_size(snapshot) <= 262144),
  snapshot_sha256 text NOT NULL CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','quarantined','disabled')),
  source text NOT NULL DEFAULT 'admin' CONSTRAINT mcp_servers_source_check CHECK (source IN ('admin')),
  release_id bigint REFERENCES releases(id) ON DELETE RESTRICT,
  added_by text NOT NULL CHECK (added_by ~ '^[0-9]{17,20}$'),
  added_at timestamptz NOT NULL DEFAULT now(),
  approved_by text CHECK (approved_by IS NULL OR approved_by ~ '^[0-9]{17,20}$'),
  approved_at timestamptz,
  quarantine_reason text CHECK (quarantine_reason IS NULL OR quarantine_reason IN ('snapshot_changed')),
  quarantined_at timestamptz,
  disabled_by text CHECK (disabled_by IS NULL OR disabled_by ~ '^[0-9]{17,20}$'),
  disabled_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mcp_servers_release CHECK ((source = 'admin') = (release_id IS NULL)),
  CONSTRAINT mcp_servers_approved CHECK (status <> 'active' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  CONSTRAINT mcp_servers_quarantined CHECK ((status = 'quarantined') = (quarantine_reason IS NOT NULL AND quarantined_at IS NOT NULL)),
  CONSTRAINT mcp_servers_disabled CHECK ((status = 'disabled') = (disabled_by IS NOT NULL AND disabled_at IS NOT NULL))
);
CREATE INDEX mcp_servers_active_idx ON mcp_servers (status) WHERE status = 'active';
CREATE TABLE mcp_server_depts (
  server_id bigint NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  dept_id text NOT NULL CHECK (dept_id ~ '^[a-z_]{1,32}$'),
  granted_by text NOT NULL CHECK (granted_by ~ '^[0-9]{17,20}$'),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, dept_id)
);
CREATE TABLE mcp_call_counts (
  scope text NOT NULL CHECK (scope IN ('tree','day','server_day')),
  scope_key text NOT NULL CHECK ((scope = 'tree' AND scope_key ~ '^[0-9a-f-]{36}$') OR (scope = 'day' AND scope_key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') OR (scope = 'server_day' AND scope_key ~ '^[a-z][a-z0-9]{1,15}:[0-9]{4}-[0-9]{2}-[0-9]{2}$')),
  used integer NOT NULL CHECK (used >= 0),
  PRIMARY KEY (scope, scope_key)
);
