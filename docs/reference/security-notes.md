# Security notes

A summary of the main security rules and where each one is explained. The full gate reports are in the [security folder](../security/).

## Security notes (summary)

- **Secrets stay out of the repo and out of the database.** The local env file is mode 0600 in a 0700 directory and must not sit in a synced folder. Logs mask tokens, keys and database passwords. See [Env file](../getting-started/env-file.md) and [Health and logs](../operations/health-and-logs.md).
- **Local provider guard.** The `claude-code-local` provider registers only on macOS, with `ALLOW_LOCAL_PROVIDERS=1` in the real process environment, a loopback database and a matching probe pin. The probe checks that no canary leaks and no tool or web request runs. See [Local mode setup](../getting-started/local-mode-setup.md).
- **Discord permissions.** No Administrator; Manage Webhooks only per channel; the denied channels are hidden from every bot; a bot with a dangerous guild-wide permission is disabled at boot. See [Owner setup checklist](../deployment/owner-setup-checklist.md).
- **Running next to the old bot.** The old Gemini bot must not share the server until its role, GitHub App and Team MCP are restricted (Gate 1 L12 to L14). See [Running next to Discord_bot](../deployment/running-next-to-discord-bot.md).
- **Dashboard guards.** Loopback only, a one-time sign-in link, exact Host and Origin checks, a per-session CSRF token and a live Bot Admin check on every write. Containers can reach the port, so the one-time login and CSRF token are the real protection. See [Settings panels](../features/settings-panels.md).
- **Executor isolation.** The server-management executor runs as a separate process, holds the only bot token for server writes, and re-checks every limit itself. On the Mac it runs as the hidden user `_lwadmin`, and the known limit of that setup is stated. See [The executor under its own macOS user](../operations/executor.md) and [Governance and approvals](../features/governance-and-approvals.md).
- **Tool and MCP sandbox.** MCP servers run in fresh containers with no network, no mounts and no secrets, and their tool list is re-checked before every call. Plugins built by the forge use the same sandbox. See [MCP servers and the plugin forge](../features/mcp-and-forge.md).
- **Web reading.** `web_search` and `fetch_page` read only through the Chrome container; a per-task web reading grant is an owner decision with a kill switch. See [Web reading and Chrome](../features/web-and-chrome.md).
- **Containers for media and documents.** The media sidecar holds no secret, and the renderer has no network route. See [Media, music and voice](../features/media-music-voice.md) and [Documents and receipts](../features/documents-and-receipts.md).
- **Pinned binaries.** yt-dlp and ffmpeg are pinned and signature-checked at build time; nothing updates them at runtime. See [Media binaries (P22)](../operations/media-binaries.md).
- **Approvals.** Writes that leave the company go through an approval card; deploy and destructive server operations also need a second confirmation by LW Admin. See [Governance and approvals](../features/governance-and-approvals.md).
- **Taint.** Content read from outside, voice transcripts and MCP results are untrusted. They cannot unlock an approval-gated action. See [Workspaces](../features/workspaces.md) and [MCP servers and the plugin forge](../features/mcp-and-forge.md).
- **Removed integration.** Jira is removed from the code. The old Jira API token must still be revoked at the provider and its `JIRA_*` lines deleted from `env.local` (owner action R-1). See [Key and token rotation](../operations/rotation.md).
- **Recovery.** If the Mac is lost or compromised, reset the bot tokens and the Claude login and re-issue provider keys. See [Key and token rotation](../operations/rotation.md#if-the-mac-is-lost-or-compromised-d22).

Gate reports and specs: the [security folder](../security/) and the [plans folder](../plans/) in this repository, plus the design specs in `docs/superpowers/specs/`. Some reports are kept in the parent repository and are cited there by path.

Back to the [documentation index](../_index.md).
