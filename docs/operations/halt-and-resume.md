# Halt and resume

Stopping all agent work from outside Discord, and resuming it safely.

## Out-of-band halt (when Discord or the bot is unreachable)

Two independent ways; use both if in doubt.

1. Stop the process: `docker stop <container>` (graceful; `doing` tasks are recovered on the next boot, and a halted flag stops that recovery).
2. Set the halted flag in the database so a restart stays halted and every running loop stops:

```sql
-- psql -U assistant -d assistant
UPDATE config SET value = 'true'::jsonb, version = version + 1, updated_by = 'ops-psql', updated_at = now() WHERE key = 'halted';
SELECT pg_notify('config_changed', 'public:halted');
```

If the `halted` row does not exist yet, insert it instead: `INSERT INTO config (key, value, updated_by) VALUES ('halted', 'true'::jsonb, 'ops-psql');` followed by the same `pg_notify`. The notification is only a hint; the service re-reads the row. A database read error or a dead LISTEN connection also counts as halted. A halt set this way takes effect live. Do **not** resume by writing `'false'::jsonb` with psql while the process runs: the watcher ignores `false` by design, so the resume steps never run (work blocked by the halt and approvals granted meanwhile stay parked), and a process halted with `/halt` keeps a local latch (fail-safe) and stays halted. Resume with `/resume` in `#⚙️-setting`; if Discord is unavailable, write `'false'::jsonb` with the same statement and restart the container (`lw restart apps/assistant`), whose boot recovery picks the work up again. On resume, work that was running when the halt hit is picked up again; tasks blocked for another reason (budget, approval, turn limit, provider error) stay blocked. If the headquarters bot is offline for more than 60 s all agent loops pause on their own, including a run in progress before its next model call, and continue when it is back.

A halt also revokes every web reading grant (see [Web reading and Chrome](../features/web-and-chrome.md)). Halt and the switch-off paths for the forge are in [MCP and plugin forge](../features/mcp-and-forge.md).

Back to the [documentation index](../_index.md).
