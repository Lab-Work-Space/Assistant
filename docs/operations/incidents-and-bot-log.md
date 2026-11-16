# Incidents and #🧾-bot-log

What the incident log channel posts, how to read it, and where to look in the live log.

## Incidents and #🧾-bot-log

- `#🧾-bot-log` is the incident log: one compact plain message per real runtime fault (incident id, bot, task, where, error, cause, fix hint; grep `incident=<id>` in live.log), deduped per 10 minutes and capped at 20 per 10 minutes.
- Security boot incidents (bot disabled for unsafe permissions, provider unavailable, GitHub denylist unavailable, interrupted approved calls, server management off) are posted as governance alerts with the `@Bot Admin` ping; every other incident is plain and never pings.
- Tool groups that are merely not configured are reported only when the disabled set changes between boots. A "Tool groups disabled" alert names the groups that are off.
- Budget, auto-OCR and approval-integrity alerts are unchanged, also here, no longer in `#⚙️-setting`. Approval cards and slash command replies stay in `#⚙️-setting`.
- Messages in `#🧾-bot-log` are never routed and it cannot be mapped (see the [owner setup checklist](../deployment/owner-setup-checklist.md)).

Example entries that point you to a fix, from the code: a renderer that is unreachable or crashed says to run `npm run local:render` (see [Documents and diagrams](../features/documents-and-receipts.md)). A GitHub denylist that cannot be resolved refuses every GitHub write until it is fixed (see [GitHub write tools](../features/tools-and-plugins.md#github-write-tools-ac10)).

Symptom index: [Troubleshooting](troubleshooting.md).

Back to the [documentation index](../_index.md).
