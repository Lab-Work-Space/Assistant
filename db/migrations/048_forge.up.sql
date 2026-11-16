-- R7 PLUGIN-FORGE: tool idea -> project -> release -> code-built image -> staged MCP server. Additive; widens named CHECKs only (047 owns the quarantine CHECK).
CREATE TABLE plugin_forges (
  id bigserial PRIMARY KEY,
  idea_id bigint NOT NULL REFERENCES tool_ideas(id) ON DELETE RESTRICT,
  project_id bigint NOT NULL UNIQUE REFERENCES projects(id) ON DELETE RESTRICT,
  dept_id text NOT NULL CHECK (dept_id ~ '^[a-z_]{1,32}$'),
  proposer text NOT NULL CHECK (proposer ~ '^(head:hq|user:[0-9]{17,20})$'),
  status text NOT NULL DEFAULT 'live' CHECK (status IN ('live','staged','installed','cancelled')),
  server_id bigint REFERENCES mcp_servers(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  close_reason text CHECK (close_reason IS NULL OR close_reason IN ('project_cancelled','project_closed','admin_cancel','installed')),
  CONSTRAINT plugin_forges_server CHECK (status NOT IN ('staged','installed') OR server_id IS NOT NULL),
  CONSTRAINT plugin_forges_closed CHECK ((status IN ('installed','cancelled')) = (closed_at IS NOT NULL AND close_reason IS NOT NULL)),
  CONSTRAINT plugin_forges_installed CHECK ((status = 'installed') = (close_reason IS NOT DISTINCT FROM 'installed'))
);
CREATE UNIQUE INDEX plugin_forges_one_live_per_idea ON plugin_forges (idea_id) WHERE status IN ('live','staged');
CREATE INDEX plugin_forges_open_idx ON plugin_forges (status) WHERE status IN ('live','staged');
CREATE TABLE plugin_builds (
  id bigserial PRIMARY KEY,
  forge_id bigint NOT NULL REFERENCES plugin_forges(id) ON DELETE RESTRICT,
  release_id bigint NOT NULL UNIQUE REFERENCES releases(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','building','staged','failed','cancelled')),
  plugin_slug text NOT NULL CHECK (plugin_slug ~ '^[a-z][a-z0-9]{1,15}$'),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  bytes integer NOT NULL CHECK (bytes BETWEEN 1 AND 10000000),
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  zip bytea,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  decided_by text NOT NULL CHECK (decided_by ~ '^[0-9]{17,20}$'),
  base_image_id text CHECK (base_image_id IS NULL OR base_image_id ~ '^sha256:[0-9a-f]{64}$'),
  image_id text CHECK (image_id IS NULL OR image_id ~ '^sha256:[0-9a-f]{64}$'),
  image_bytes bigint CHECK (image_bytes IS NULL OR image_bytes BETWEEN 0 AND 8388608),
  image_removed_at timestamptz,
  code text CHECK (code IS NULL OR code ~ '^[a-z_]{1,40}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  CONSTRAINT plugin_builds_zip CHECK ((status IN ('queued','building')) = (zip IS NOT NULL) AND (zip IS NULL OR octet_length(zip) = bytes)),
  CONSTRAINT plugin_builds_code CHECK ((status IN ('failed','cancelled')) = (code IS NOT NULL)),
  CONSTRAINT plugin_builds_staged CHECK (status <> 'staged' OR (image_id IS NOT NULL AND base_image_id IS NOT NULL AND finished_at IS NOT NULL)),
  CONSTRAINT plugin_builds_removed CHECK (image_removed_at IS NULL OR image_id IS NOT NULL)
);
CREATE UNIQUE INDEX plugin_builds_one_building ON plugin_builds ((true)) WHERE status = 'building';
CREATE INDEX plugin_builds_queue_idx ON plugin_builds (created_at) WHERE status = 'queued';
CREATE INDEX plugin_builds_image_idx ON plugin_builds (image_id) WHERE image_id IS NOT NULL AND image_removed_at IS NULL;
CREATE INDEX plugin_builds_forge_idx ON plugin_builds (forge_id);
CREATE INDEX plugin_builds_created_idx ON plugin_builds (created_at);
ALTER TABLE releases DROP CONSTRAINT releases_target_check;
ALTER TABLE releases ADD CONSTRAINT releases_target_check CHECK (target IN ('handoff','install_plugin'));
ALTER TABLE releases ADD COLUMN forge_id bigint REFERENCES plugin_forges(id) ON DELETE RESTRICT;
ALTER TABLE releases ADD COLUMN plugin_slug text CHECK (plugin_slug IS NULL OR plugin_slug ~ '^[a-z][a-z0-9]{1,15}$');
ALTER TABLE releases ADD COLUMN plugin_manifest_sha256 text CHECK (plugin_manifest_sha256 IS NULL OR plugin_manifest_sha256 ~ '^[0-9a-f]{64}$');
ALTER TABLE releases ADD CONSTRAINT releases_plugin CHECK ((target = 'install_plugin') = (forge_id IS NOT NULL AND plugin_slug IS NOT NULL AND plugin_manifest_sha256 IS NOT NULL));
ALTER TABLE mcp_servers DROP CONSTRAINT mcp_servers_source_check;
ALTER TABLE mcp_servers ADD CONSTRAINT mcp_servers_source_check CHECK (source IN ('admin','release'));
ALTER TABLE mcp_servers ADD CONSTRAINT mcp_servers_release_write CHECK (source <> 'release' OR tool_class = 'write');
CREATE UNIQUE INDEX mcp_servers_release_once ON mcp_servers (release_id) WHERE release_id IS NOT NULL;
ALTER TABLE dept_incidents DROP CONSTRAINT dept_incidents_kind_check;
ALTER TABLE dept_incidents ADD CONSTRAINT dept_incidents_kind_check CHECK (kind IN ('task_blocked','task_cancelled','tool_errors','heal_resolve','forge_failed'));
-- G2-MCP-R4: the approval pin exists exactly while the row is active. An existing row that is not active may still hold a pin or approval columns (047 only required a pin on active rows): clear them first.
UPDATE mcp_servers SET approved_config_sha256 = NULL, approved_by = NULL, approved_at = NULL WHERE status <> 'active';
ALTER TABLE mcp_servers DROP CONSTRAINT mcp_servers_pin;
ALTER TABLE mcp_servers ADD CONSTRAINT mcp_servers_pin CHECK ((status = 'active') = (approved_config_sha256 IS NOT NULL));
