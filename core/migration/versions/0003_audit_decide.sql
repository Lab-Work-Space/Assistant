CREATE TABLE audit_log_new (
  id        INTEGER PRIMARY KEY,
  scope     TEXT NOT NULL CHECK (scope IN ('setting','task','approval')),
  ref       TEXT NOT NULL CHECK (length(ref) BETWEEN 1 AND 64),
  action    TEXT NOT NULL CHECK (action IN ('set','reset','edit','cancel','escalate','override','ai_decide','decide')),
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
