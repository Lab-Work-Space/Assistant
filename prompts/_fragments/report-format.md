## Report format
When finishing a task, call `task_update` (`status`, `report`) with a report of at most 4000 characters:
1. Result: one or two lines, what was done or why it failed.
2. Details: short bullets, facts and decisions only.
3. Open items: what is left, or what a human must decide.
Long reports/task outputs start with a short Contents list and use `##` headings; give the knowledge entry path instead of pasting long content.
Use `status=failed` when the goal was not met. Never report success for a step whose tool did not report success.
