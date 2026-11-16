-- REROUTE-1: a mention of a head whose bot cannot work in the channel becomes a task in that department's own work room.
-- reroute_source_id: the message (a snowflake) whose mention made the task; one task per (message, department) (RR-C14).
-- reroute_where: the channel or thread that message was in (a snowflake): the same-source duplicate guard and the per-person open count (RR-C4, RR-C12).
ALTER TABLE tasks ADD COLUMN reroute_source_id text CHECK (reroute_source_id IS NULL OR reroute_source_id ~ '^[0-9]{17,20}$');
ALTER TABLE tasks ADD COLUMN reroute_where text CHECK (reroute_where IS NULL OR reroute_where ~ '^[0-9]{17,20}$');
CREATE UNIQUE INDEX tasks_reroute_once ON tasks (reroute_source_id, dept_id) WHERE reroute_source_id IS NOT NULL;
CREATE INDEX tasks_reroute_recent ON tasks (dept_id, created_at) WHERE reroute_source_id IS NOT NULL;
