CREATE TABLE approvals_new (
  id                TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (random() & 3), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))) CHECK (length(id) = 36),
  code              TEXT NOT NULL UNIQUE CHECK (code GLOB 'APR-*-[0-9][0-9][0-9][0-9]*' AND length(code) <= 24),
  level             TEXT NOT NULL CHECK (level IN ('dept','hq')),
  dept              TEXT NOT NULL CHECK (length(dept) BETWEEN 2 AND 4 AND dept NOT GLOB '*[^A-Z]*'),
  kind              TEXT NOT NULL CHECK (kind IN ('generic','artifact_enable','file_write_outside','destructive_cmd','config_change')),
  title             TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 256),
  summary           TEXT NOT NULL CHECK (length(summary) <= 4000),
  access            TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(access) AND json_type(access) = 'array'),
  payload           TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload) AND json_type(payload) = 'object'),
  reason            TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 1000),
  value_thb         INTEGER CHECK (value_thb IS NULL OR value_thb BETWEEN 0 AND 1000000000),
  priority          TEXT CHECK (priority IS NULL OR priority IN ('low','normal','high','urgent')),
  due               TEXT CHECK (due IS NULL OR due = date(due)),
  assignee          TEXT CHECK (assignee IS NULL OR (length(assignee) BETWEEN 2 AND 32 AND assignee NOT GLOB '*[^a-z0-9_-]*')),
  other_depts       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(other_depts) AND json_type(other_depts) = 'array'),
  route_reason      TEXT NOT NULL CHECK (route_reason IN ('kind_dangerous','access_requested','value_over_threshold','cross_dept','no_dept','no_head','requester_is_head','ai_disabled','classifier_major','classifier_unavailable','dept_routine','head_escalated','head_no_decision','head_guard_failed','legacy')),
  requested_by      TEXT NOT NULL,
  origin            TEXT NOT NULL CHECK (origin IN ('discord','cli')),
  human_user_id     INTEGER,
  origin_channel_id INTEGER NOT NULL,
  origin_thread_id  INTEGER,
  channel_id        INTEGER,
  message_id        INTEGER,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired','cancelled')),
  decided_by        TEXT CHECK ((decided_by GLOB 'discord:*' AND length(decided_by) BETWEEN 25 AND 28 AND substr(decided_by, 9) NOT GLOB '*[^0-9]*')
                                OR (decided_by GLOB 'cli:[a-z]*' AND length(decided_by) BETWEEN 5 AND 36 AND substr(decided_by, 5) NOT GLOB '*[^a-z0-9_-]*')
                                OR (decided_by GLOB 'agent:[a-z]*' AND length(decided_by) BETWEEN 8 AND 38 AND substr(decided_by, 7) NOT GLOB '*[^a-z0-9_-]*')),
  decision_reason   TEXT CHECK (decision_reason IS NULL OR length(decision_reason) <= 500),
  overridden_from   TEXT CHECK (overridden_from IS NULL OR overridden_from GLOB 'agent:*'),
  decided_at        TEXT CHECK (decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', decided_at)),
  expires_at        TEXT NOT NULL CHECK (expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', expires_at)),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) CHECK (created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  CHECK ((status IN ('approved','rejected')) = (decided_by IS NOT NULL)),
  CHECK (decided_by IS NULL OR decided_by NOT GLOB 'agent:*' OR (level = 'dept' AND kind = 'generic' AND access = '[]'))
) STRICT;
INSERT INTO approvals_new (id, code, level, dept, kind, title, summary, access, payload, route_reason, requested_by, origin,
  human_user_id, origin_channel_id, origin_thread_id, channel_id, message_id, status, decided_by, decided_at, expires_at, created_at)
SELECT id, 'APR-HQ-' || printf('%04d', row_number() OVER (ORDER BY created_at, id)), 'hq', 'HQ', kind, title, summary, access,
  payload, 'legacy', requested_by, origin, human_user_id, origin_channel_id, origin_thread_id, channel_id, message_id, status,
  decided_by, decided_at, expires_at, created_at FROM approvals;
DROP TABLE approvals;
ALTER TABLE approvals_new RENAME TO approvals;
CREATE INDEX approvals_pending_idx ON approvals (expires_at) WHERE status = 'pending';
CREATE INDEX approvals_agent_decided_idx ON approvals (decided_by, decided_at) WHERE decided_by GLOB 'agent:*';
CREATE TABLE code_counters (
  kind TEXT NOT NULL CHECK (kind IN ('task','approval')),
  dept TEXT NOT NULL CHECK (length(dept) BETWEEN 2 AND 4 AND dept NOT GLOB '*[^A-Z]*'),
  last INTEGER NOT NULL CHECK (last >= 0),
  PRIMARY KEY (kind, dept)
) STRICT;
INSERT INTO code_counters (kind, dept, last) VALUES ('approval', 'HQ', (SELECT count(*) FROM approvals));
ALTER TABLE tasks ADD COLUMN code TEXT CHECK (code IS NULL OR length(code) BETWEEN 6 AND 16);
ALTER TABLE tasks ADD COLUMN dept TEXT CHECK (dept IS NULL OR (length(dept) BETWEEN 2 AND 4 AND dept NOT GLOB '*[^A-Z]*'));
ALTER TABLE tasks ADD COLUMN priority TEXT CHECK (priority IS NULL OR priority IN ('low','normal','high','urgent'));
ALTER TABLE tasks ADD COLUMN due TEXT CHECK (due IS NULL OR due = date(due));
ALTER TABLE tasks ADD COLUMN value_thb INTEGER CHECK (value_thb IS NULL OR value_thb BETWEEN 0 AND 1000000000);
UPDATE tasks SET code = 'TASK-' || short_id;
CREATE UNIQUE INDEX tasks_code_idx ON tasks (code) WHERE code IS NOT NULL;
CREATE TABLE settings (
  key        TEXT NOT NULL PRIMARY KEY CHECK (length(key) BETWEEN 3 AND 64 AND key NOT GLOB '*[^a-z0-9_.]*'),
  value      TEXT NOT NULL CHECK (length(value) BETWEEN 1 AND 256),
  updated_by TEXT NOT NULL CHECK (updated_by GLOB 'discord:*' OR updated_by GLOB 'cli:*'),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) CHECK (updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at))
) STRICT;
CREATE TABLE audit_log (
  id        INTEGER PRIMARY KEY,
  scope     TEXT NOT NULL CHECK (scope IN ('setting','task','approval')),
  ref       TEXT NOT NULL CHECK (length(ref) BETWEEN 1 AND 64),
  action    TEXT NOT NULL CHECK (action IN ('set','reset','edit','cancel','escalate','override','ai_decide')),
  field     TEXT CHECK (field IS NULL OR length(field) <= 64),
  old_value TEXT CHECK (old_value IS NULL OR length(old_value) <= 4000),
  new_value TEXT CHECK (new_value IS NULL OR length(new_value) <= 4000),
  actor     TEXT NOT NULL CHECK (actor GLOB 'discord:*' OR actor GLOB 'cli:*' OR actor GLOB 'agent:*'),
  at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) CHECK (at = strftime('%Y-%m-%dT%H:%M:%fZ', at))
) STRICT;
CREATE INDEX audit_ref_idx ON audit_log (scope, ref, at);
CREATE INDEX audit_actor_idx ON audit_log (actor, action, at);
