# Troubleshooting

A symptom index. Each entry points to the page that owns the fix.

## Troubleshooting

| Symptom | What to check | Where |
| :--- | :--- | :--- |
| `#🧾-bot-log` says the web tools are off, or Chrome does not answer | Start the Chrome containers (`npm run local:chrome`) before `npm run dev`, then restart the app | [Web reading and Chrome](../features/web-and-chrome.md) |
| The document tools are off, or the renderer is unreachable | Start the renderer with `npm run local:render` | [Documents and diagrams](../features/documents-and-receipts.md) |
| Music or voice is off with "media sidecar not configured" or "media sidecar unreachable" | Locally, start `npm run local:media`; on the VPS, check the sidecar health and the `MEDIA_SOCKET` setting | [Environment variables](../configuration/environment-variables.md), [Media sidecar live checks](media-sidecar-live-checks.md) |
| `claude-code-local not registered` in the log | The reason is in the same line: flag, platform, probe pin or loopback check | [First run](../getting-started/first-run.md), [Local mode setup](../getting-started/local-mode-setup.md) |
| The probe failed, or the provider disappeared after a `claude` upgrade | Do not use local mode; re-run the probe after the upgrade; send the probe output if it fails | [Local mode setup](../getting-started/local-mode-setup.md) |
| `/healthz` reports `provider: "unavailable"`, or the bots do nothing | Set `ANTHROPIC_API_KEY` for the Claude API, or make the local provider available | [Providers and models](../configuration/providers-and-models.md), [First run](../getting-started/first-run.md) |
| A profile or override shows "Unavailable" | It is still pinned to `claude-code-local`; repoint it | [Providers and models](../configuration/providers-and-models.md) |
| Calls fail with a provider error and the affected task is blocked | Subscription rate limits on the local provider (see the Quotas section for the limits that apply) | [Budgets and quotas](../configuration/budgets-and-quotas.md) |
| "Tool groups disabled" alert | Names the groups that are off; check the keys and the sidecar for each | [Incidents and #🧾-bot-log](incidents-and-bot-log.md) |
| All bots stopped answering | The system may be halted (`/halt`), or the budget is exhausted (alert in `#🧾-bot-log`) | [Halt and resume](halt-and-resume.md), [Budgets and quotas](../configuration/budgets-and-quotas.md) |
| Tasks wait as `todo` on a day off | Off days stop automated work until the next workday | [Off days and holidays](../configuration/off-days-and-holidays.md) |
| Praw is unavailable, or refuses to run with a "no price" alert | Set `GEMINI_API_KEY`; add `gemini-3.8-flash` to the stored `pricing` row | [Praw](../features/praw.md) |
| Praw leaves a voice channel | DAVE is not live, or the idle or session limit was reached; check the log line | [Media, music and voice](../features/media-music-voice.md) |
| YouTube asks to sign in to confirm you are not a bot | Setting `YTDLP_COOKIES_FILE` needs a throwaway account and is an owner decision (the cookies carve-out in the sidecar owner lines) | [Media, music and voice](../features/media-music-voice.md), [Media sidecar live checks](media-sidecar-live-checks.md) |
| The receipt row does not appear in the Google sheet | A rejection by the Apps Script is not visible to Praw; check the sheet by hand after setup | [Documents and receipts](../features/documents-and-receipts.md) |
| `#🧾-bot-log` says "Server management is off" | Finish the owner steps for the LW Admin executor | [Admin console and server management](../features/admin-console-and-server-management.md) |
| A Manager or Moderator card is refused, or the mod room does nothing | The tier roles or `roles.modRoomId` are not valid; an alert is posted | [Admin console and server management](../features/admin-console-and-server-management.md) |
| An MCP server is quarantined (`config_changed` or tool list changed) | Re-add and re-approve the server as a Bot Admin | [MCP servers and the plugin forge](../features/mcp-and-forge.md) |
| `/forge cancel` answers `busy` for a stale build | Switch `forge.enabled` on once and let the boot recover run | [MCP servers and the plugin forge](../features/mcp-and-forge.md) |
| Local data is gone after a Docker reset | Restore from the most recent dump; re-set the settings listed in the restore list | [Backups and restore](backups-and-restore.md) |
| Docker Desktop shows the `ws` runner as "Unused" | Do not delete the `assistant-*` images in Docker Desktop; the runner image is expected to show as unused | [Start, stop and restart](start-stop-restart.md) |
| The local `claude` login or a bot token may have leaked | Rotate the tokens and keys; for a lost Mac, follow the recovery steps | [Key and token rotation](rotation.md) |

Back to the [documentation index](../_index.md).
