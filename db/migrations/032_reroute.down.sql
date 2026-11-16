DROP INDEX IF EXISTS tasks_reroute_recent;
DROP INDEX IF EXISTS tasks_reroute_once;
ALTER TABLE tasks DROP COLUMN IF EXISTS reroute_where;
ALTER TABLE tasks DROP COLUMN IF EXISTS reroute_source_id;
