CREATE TABLE audit_log_new (
  id        INTEGER PRIMARY KEY,
  scope     TEXT NOT NULL CHECK (scope IN ('setting','task','approval','lesson','overlay','persona','dept')),
  ref       TEXT NOT NULL CHECK (length(ref) BETWEEN 1 AND 64),
  action    TEXT NOT NULL CHECK (action IN ('set','reset','edit','cancel','escalate','override','ai_decide','decide','propose','delete','activate','rollback','hire','fire','move','add')),
  field     TEXT CHECK (field IS NULL OR length(field) <= 64),
  old_value TEXT CHECK (old_value IS NULL OR length(old_value) <= 4000),
  new_value TEXT CHECK (new_value IS NULL OR length(new_value) <= 4000),
  actor     TEXT NOT NULL CHECK (actor GLOB 'discord:*' OR actor GLOB 'cli:*' OR actor GLOB 'agent:*'),
  at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) CHECK (at = strftime('%Y-%m-%dT%H:%M:%fZ', at))
) STRICT;
INSERT INTO audit_log_new (id, scope, ref, action, field, old_value, new_value, actor, at)
SELECT id, scope, ref, action, field, old_value, new_value, actor, at FROM audit_log;
DROP TABLE audit_log;
ALTER TABLE audit_log_new RENAME TO audit_log;
CREATE INDEX audit_ref_idx ON audit_log (scope, ref, at);
CREATE INDEX audit_actor_idx ON audit_log (actor, action, at);
CREATE TABLE code_counters_new (
  kind TEXT NOT NULL CHECK (kind IN ('task','approval','lesson')),
  dept TEXT NOT NULL CHECK (length(dept) BETWEEN 2 AND 4 AND dept NOT GLOB '*[^A-Z]*'),
  last INTEGER NOT NULL CHECK (last >= 0),
  PRIMARY KEY (kind, dept)
) STRICT;
INSERT INTO code_counters_new (kind, dept, last) SELECT kind, dept, last FROM code_counters;
DROP TABLE code_counters;
ALTER TABLE code_counters_new RENAME TO code_counters;
CREATE TABLE lessons (
  id          TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 36),
  code        TEXT NOT NULL UNIQUE CHECK (code GLOB 'LSN-*-[0-9][0-9][0-9][0-9]*' AND length(code) <= 24),
  dept        TEXT NOT NULL CHECK (length(dept) BETWEEN 2 AND 4 AND dept NOT GLOB '*[^A-Z]*'),
  proposed_by TEXT NOT NULL CHECK (length(proposed_by) BETWEEN 2 AND 32 AND proposed_by NOT GLOB '*[^a-z0-9_-]*'),
  scope_kind  TEXT NOT NULL CHECK (scope_kind IN ('persona','dept')),
  scope_id    TEXT NOT NULL CHECK (length(scope_id) BETWEEN 2 AND 32),
  category    TEXT NOT NULL CHECK (category IN ('method','tooling','communication','quality','domain','permissions','money','policy','safety')),
  body        TEXT NOT NULL CHECK (length(body) BETWEEN 20 AND 400 AND instr(body, char(10)) = 0),
  g1_hit      TEXT CHECK (g1_hit IS NULL OR length(g1_hit) <= 64),
  task_code   TEXT CHECK (task_code IS NULL OR length(task_code) BETWEEN 6 AND 16),
  approval_id TEXT UNIQUE REFERENCES approvals (id) CHECK (approval_id IS NULL OR length(approval_id) = 36),
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','dropped','deleted')),
  decided_at  TEXT CHECK (decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', decided_at)),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) CHECK (created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  CHECK ((scope_kind = 'persona' AND scope_id GLOB '[a-z]*' AND scope_id NOT GLOB '*[^a-z0-9_-]*') OR (scope_kind = 'dept' AND scope_id = dept))
) STRICT;
CREATE INDEX lessons_scope_idx ON lessons (scope_kind, scope_id, status);
CREATE INDEX lessons_proposer_idx ON lessons (proposed_by, created_at);
CREATE TABLE overlay_versions (
  id          INTEGER PRIMARY KEY,
  scope_kind  TEXT NOT NULL CHECK (scope_kind IN ('persona','dept')),
  scope_id    TEXT NOT NULL CHECK (length(scope_id) BETWEEN 2 AND 32),
  version     INTEGER NOT NULL CHECK (version >= 1),
  body        TEXT NOT NULL CHECK (length(body) <= 6500),
  lesson_ids  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(lesson_ids) AND json_type(lesson_ids) = 'array'),
  dropped_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(dropped_ids) AND json_type(dropped_ids) = 'array'),
  reason      TEXT NOT NULL CHECK (reason IN ('lesson_approved','lesson_removed')),
  created_by  TEXT NOT NULL CHECK (created_by GLOB 'discord:*' OR created_by GLOB 'cli:*' OR created_by GLOB 'agent:*'),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) CHECK (created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  UNIQUE (scope_kind, scope_id, version)
) STRICT;
CREATE TABLE overlay_active (
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('persona','dept')),
  scope_id   TEXT NOT NULL CHECK (length(scope_id) BETWEEN 2 AND 32),
  version    INTEGER NOT NULL CHECK (version >= 0),
  updated_by TEXT NOT NULL CHECK (updated_by GLOB 'discord:*' OR updated_by GLOB 'cli:*' OR updated_by GLOB 'agent:*'),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) CHECK (updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)),
  PRIMARY KEY (scope_kind, scope_id)
) STRICT;
CREATE TABLE departments (
  code       TEXT NOT NULL PRIMARY KEY CHECK (length(code) BETWEEN 2 AND 4 AND code NOT GLOB '*[^A-Z]*' AND code NOT IN ('HQ','APR','LSN','TASK','SYS','ALL','NONE')),
  slug       TEXT NOT NULL UNIQUE CHECK (slug = lower(code)),
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(name) BETWEEN 1 AND 64),
  created_by TEXT NOT NULL CHECK (created_by GLOB 'discord:*' OR created_by GLOB 'cli:*'),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) CHECK (created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at))
) STRICT;
CREATE TABLE personas_runtime (
  id         TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 2 AND 32 AND id GLOB '[a-z]*' AND id NOT GLOB '*[^a-z0-9_-]*' AND id NOT IN ('system','praw','admin','hq','everyone','here')),
  kind       TEXT NOT NULL CHECK (kind IN ('hired','override')),
  name       TEXT CHECK (name IS NULL OR length(name) BETWEEN 1 AND 80),
  aliases    TEXT CHECK (aliases IS NULL OR (json_valid(aliases) AND json_type(aliases) = 'array' AND json_array_length(aliases) BETWEEN 1 AND 10)),
  role       TEXT CHECK (role IS NULL OR length(role) BETWEEN 1 AND 300),
  model      TEXT CHECK (model IS NULL OR length(model) BETWEEN 3 AND 80),
  dept       TEXT CHECK (dept IS NULL OR (length(dept) BETWEEN 2 AND 32 AND dept GLOB '[a-z]*' AND dept NOT GLOB '*[^a-z0-9_-]*')),
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','fired')),
  updated_by TEXT NOT NULL CHECK (updated_by GLOB 'discord:*' OR updated_by GLOB 'cli:*'),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) CHECK (created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) CHECK (updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)),
  CHECK (kind = 'override' OR (name IS NOT NULL AND aliases IS NOT NULL AND role IS NOT NULL AND model IS NOT NULL AND dept IS NOT NULL)),
  CHECK (kind = 'hired' OR (name IS NULL AND aliases IS NULL AND role IS NULL AND model IS NULL))
) STRICT;
