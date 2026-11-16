# Slash commands

The slash commands and Praw-proposed admin operations named in these docs, with where each one works and the page that explains it.

## Slash commands

Admin commands work only in `#⚙️-setting`, and only for holders of the `Bot Admin` role (see the [owner setup checklist](../deployment/owner-setup-checklist.md), section 2). Commands marked "anyone" have no admin requirement. This table lists the commands named in the documentation; it is not the complete command list.

| Command | Who | What it does | Read more |
| :--- | :--- | :--- | :--- |
| `/halt`, `/resume` | Bot Admin | Stop all agent work; resume it | [Halt and resume](../operations/halt-and-resume.md) |
| `/provider`, `/provider add`, `/provider add gemini` | Bot Admin | Show provider status; add a provider key (stored encrypted) | [Providers and models](../configuration/providers-and-models.md) |
| `/settings set <key> <value>` (for example `/settings set autopilot.scope company\|project`, `/settings set spend.deptMonthlyUsd <dept> <usd\|none>`, `/settings web.search.openSources false`) | Bot Admin | Change a config key live | [Governance and approvals](../features/governance-and-approvals.md), [Web and Chrome](../features/web-and-chrome.md) |
| `/limits set turns 3`, `/limits set limit:vision_day value:<n>` | Bot Admin | Change call and reading limits live | [Budgets and quotas](../configuration/budgets-and-quotas.md), [Cutover M4](../deployment/cutover/m4.md) |
| `/budget`, `/budget set daily 1`, `/budget dept dept:<d> usd:<n>` (or `clear:true`) | Bot Admin | Show and set budgets | [Budgets and quotas](../configuration/budgets-and-quotas.md) |
| `/usage today\|week`, `/usage range:trend by:dept\|provider\|tool` | Bot Admin | Show spend | [Budgets and quotas](../configuration/budgets-and-quotas.md) |
| `/persona edit`, `/bot disable`, `/bot tools` | Bot Admin | Edit a persona; disable a bot; grant tools to a department | [Organisation](../features/organisation.md), [Tools and plugins](../features/tools-and-plugins.md) |
| `/channel map <#channel> <dept> work:true` | Bot Admin | Map a channel to a department (for example Praw's work channel) | [Praw](../features/praw.md) |
| `/holiday add\|remove\|list\|weekdays` | Bot Admin | Holidays and weekly off days | [Off days and holidays](../configuration/off-days-and-holidays.md) |
| `/clickup channel <#channel>` | Bot Admin | Where ClickUp notices go (no argument clears it) | [Cutover M3](../deployment/cutover/m3.md) |
| `/autoocr channel <#channel>` | Bot Admin | The auto-OCR channel (no argument switches it off) | [Cutover M4](../deployment/cutover/m4.md) |
| `/github allow action:add\|remove repo:<owner/repo>` | Bot Admin | Make a GitHub repository writable (or not) | [GitHub write tools](../features/tools-and-plugins.md#github-write-tools-ac10) |
| `/media allowlist action:add\|remove host:<host>` | Bot Admin | Change the music host allowlist | [Media, music and voice](../features/media-music-voice.md) |
| `/mcp add`, `/mcp approve`, `/mcp show`, `/mcp test`, `/mcp depts`, `/mcp disable`, `/mcp list` | Bot Admin | Add, approve and manage MCP servers | [MCP and plugin forge](../features/mcp-and-forge.md) |
| `/forge list`, `/forge show id:<n>`, `/forge cancel id:<n>` | Bot Admin | Plugin forge requests | [MCP and plugin forge](../features/mcp-and-forge.md) |
| `/dashboard` | Bot Admin | Get a one-time sign-in link to the local dashboard | [Settings panels](../features/settings-panels.md) |
| `/lesson enable <id>` | Bot Admin | Switch on a lesson (imported lessons start inactive) | [Cutover M2](../deployment/cutover/m2.md) |
| `/project list` | not stated | Show the autopilot scope | [Governance and approvals](../features/governance-and-approvals.md) |
| `/play <song or link>`, `/skip`, `/queue`, `/stop`, `/volume <0-150>` | any member (the requester must be in a voice channel) | Music | [Media, music and voice](../features/media-music-voice.md) |
| `/voice join`, `/voice leave` | `/voice join` needs you in a voice channel; `/voice leave` works for anyone | Voice chat | [Media, music and voice](../features/media-music-voice.md) |
| `/ocr`, `/receipt` | not stated (a per-person daily reading limit applies) | Read an image or a receipt | [Documents and receipts](../features/documents-and-receipts.md), [Cutover M4](../deployment/cutover/m4.md) |
| `/remind list` | not stated | List reminders | [Cutover M2](../deployment/cutover/m2.md) |
| `/ask` | not stated | Ask Praw | [Praw](../features/praw.md) |

Praw can also propose most of these changes in `#⚙️-setting` in plain language. Each change is still a confirmation card that only the proposing admin can press. See [Admin console and server management](../features/admin-console-and-server-management.md).

Back to the [documentation index](../_index.md).
