# Governance and approvals

How the company asks for approval, when it decides on its own, and the second confirmation for dangerous server work.

## Company autopilot (AUTO-2, `docs/security/2026-11-12-gate1-autopilot-company.md`)

- With `autopilot.enabled = true` and `autopilot.scope = 'company'`, calls that need approval run at once with no card in every open task tree that has no project (any status) and no outside origin (`watch`, `import`, `poll`). That includes plain chat with Praw or a head (the conversation task carries the call) and `ws_run`/`ws_export` from chat. Dangerous work still gets a card: hard-deny classes, the always-card list, own approval reasons not on the waive list, tainted `write_file`, and any tree in a paused, exhausted, past-deadline or closed project. Spend limits still apply.
- Caps (owner-only, psql): `autopilot.company.maxApprovalsPerTree` (80), `autopilot.company.maxApprovalsPerDay` (600), `autopilot.company.maxApprovalsPerPersonDay` (200). At a cap the call goes to the card path and bot-log gets one notice per day.
- Switch from Discord: `/settings set autopilot.scope company|project` (Bot Admin). Halt, `autopilot.enabled = false` and `project` stop company decisions at once. `/project list` shows the scope.
- One-off deploy flip (run once after the 043 migration is deployed and the service restarted; revert with `"project"` or the `/settings` command):

```sql
BEGIN;
INSERT INTO config (key, value, updated_by) VALUES ('autopilot.scope', '"company"'::jsonb, 'owner-decision:AUTO-2')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, version = config.version + 1, updated_by = EXCLUDED.updated_by, updated_at = now();
INSERT INTO audit_log (actor, action, tool, outcome) VALUES ('system:deploy', 'config.set', 'autopilot.scope', 'ok company (owner decision 2026-11-12, AUTO-2)');
COMMIT;
SELECT pg_notify('config_changed', 'public:autopilot.scope');
```

## Second confirmation by LW Admin itself (Gate 2 OD-G2-1, G2VD-03)

For **deploy operations** (add, preview, publish_static, redeploy, remove) and **destructive server operations** (ban, kick, bulk delete, channel delete, AutoMod disable or delete), the normal card is not enough. After the Bot Admin (or, for a destructive server card in the mod room, the Manager/Moderator) presses Confirm, the executor checks the card and then **LW Admin sends the same person a second button through its own identity**: a DM with the exact operation, the card id, valid 5 minutes, one click. Only a click that arrives on **LW Admin's own interaction stream** from that same Discord user id, after a live role recheck, lets the executor apply; every check runs again at that moment. The main application has no LW Admin token and no LW Admin gateway, so it cannot produce this click: a forged database row (G2VD-03) leaves the card waiting and nothing is applied. The prompts live only in the executor's memory (not in the database): a restart or the 5 minutes drop them, the card is then spent and must be proposed again. Both confirmations are audited (`admin.card` ... `awaiting_second`, `admin.confirm2` requested / confirmed / refused / applied).

- **DMs closed:** LW Admin posts the button in the card's channel instead (`#setting` for a Bot Admin, the mod room for a tier), mentioning only that user; only that user's click counts. Owner setup for this: give the LW Admin bot **Send Messages as a channel permission overwrite in `#setting` and in the mod room** (not guild-wide; the invite integer `1125684159671` is unchanged and the boot check, which looks at guild-level bits, still passes). Without it, a Bot Admin whose DMs are closed gets a refusal and must open DMs (Discord: Privacy settings -> Allow direct messages from server members).
- **Gate impact:** LW Admin now has ONE interaction listener (buttons whose id starts `lwadmin2:` + 32 hex), still no MessageCreate listener, no slash commands, intents unchanged (Guilds + GuildMembers; DMs and buttons need none); no `applications.commands` scope. Everything else about S3/S8 stands.
- Other server operations (kick/ban excluded as listed above, nicknames, channel edits, AutoMod create, ...) and permission cards keep the single confirmation.

Related: [Admin console and server management](admin-console-and-server-management.md), [Executor](../operations/executor.md), [Budgets and quotas](../configuration/budgets-and-quotas.md).

Back to the [documentation index](../_index.md).
