-- WS-1: project workspaces for the software team. Additive, plus a data update of stored tools.byDept.software.
CREATE TABLE workspaces (
  slug        text PRIMARY KEY CHECK (slug ~ '^[a-z][a-z0-9-]{1,39}$'),
  title       text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  dept        text NOT NULL DEFAULT 'software' CHECK (dept = 'software'),
  created_by  text NOT NULL CHECK (created_by ~ '^head:[a-z_]{1,32}$'),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  bytes       bigint NOT NULL DEFAULT 0 CHECK (bytes >= 0),
  nm_bytes    bigint NOT NULL DEFAULT 0 CHECK (nm_bytes >= 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  archived_by text CHECK (archived_by IS NULL OR archived_by ~ '^[0-9]{17,20}$'),
  CONSTRAINT workspaces_archived CHECK ((status = 'archived') = (archived_at IS NOT NULL AND archived_by IS NOT NULL))
);
CREATE INDEX workspaces_active_idx ON workspaces (status) WHERE status = 'active';
CREATE TABLE ws_run_counts (
  scope     text NOT NULL CHECK (scope IN ('tree','day')),
  scope_key text NOT NULL CHECK ((scope = 'tree' AND scope_key ~ '^[0-9a-f-]{36}$') OR (scope = 'day' AND scope_key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')),
  used      integer NOT NULL CHECK (used >= 0),
  PRIMARY KEY (scope, scope_key)
);
UPDATE config
SET value = (
  SELECT jsonb_object_agg(k, CASE
    WHEN jsonb_typeof(v) <> 'array' OR k <> 'software' OR jsonb_array_length(v) > 93 THEN v
    ELSE v || COALESCE((SELECT jsonb_agg(to_jsonb(n)) FROM unnest(ARRAY['ws_create','ws_list','ws_read','ws_write','ws_delete','ws_run','ws_export']) AS n WHERE NOT v ? n), '[]'::jsonb)
  END)
  FROM jsonb_each(value) AS e(k, v)
), version = version + 1, updated_by = 'migration:040'
WHERE key = 'tools.byDept' AND jsonb_typeof(value) = 'object' AND value <> '{}'::jsonb;
