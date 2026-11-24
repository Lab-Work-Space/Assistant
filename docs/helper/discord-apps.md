# Discord applications (owner guide)

Spec: section 12.8 and 12.10 of `docs/specs/2026-11-23-phase1-spec-s12-discord-rollout.md`. One Discord application (one bot, one token) per persona.

## Contents
- [Persona ids and env names](#persona-ids-and-env-names)
- [Create each application](#create-each-application)
- [Intents](#intents)
- [Permissions](#permissions)
- [Approval channels and ⚙️-setting (TASK-031)](#approval-channels-and-️-setting-task-031)
- [Server-side View Channel deny](#server-side-view-channel-deny)
- [Invite](#invite)
- [Env file](#env-file)
- [Token rotation](#token-rotation)
- [Single-instance rule](#single-instance-rule)
- [Voice (B2, Praw only)](#voice-b2-praw-only)
- [Check after start](#check-after-start)
- [System (log bot, spec 12.14)](#system-log-bot-spec-1214)

## Persona ids and env names
Env suffix = persona id in upper case. Each persona needs `DISCORD_BOT_TOKEN_<ID>` and `DISCORD_APP_ID_<ID>`.

| Persona | Id | Token env | App id env |
|---|---|---|---|
| พราว (intake) | praw | `DISCORD_BOT_TOKEN_PRAW` | `DISCORD_APP_ID_PRAW` |
| มะลิ | mali | `DISCORD_BOT_TOKEN_MALI` | `DISCORD_APP_ID_MALI` |
| กวิน | kawin | `DISCORD_BOT_TOKEN_KAWIN` | `DISCORD_APP_ID_KAWIN` |
| ณิชา | nicha | `DISCORD_BOT_TOKEN_NICHA` | `DISCORD_APP_ID_NICHA` |
| อนันต์ | anan | `DISCORD_BOT_TOKEN_ANAN` | `DISCORD_APP_ID_ANAN` |
| แบงค์ | bank | `DISCORD_BOT_TOKEN_BANK` | `DISCORD_APP_ID_BANK` |
| เดฟ | dew | `DISCORD_BOT_TOKEN_DEW` | `DISCORD_APP_ID_DEW` |
| ฝน | fon | `DISCORD_BOT_TOKEN_FON` | `DISCORD_APP_ID_FON` |
| คิว | qin | `DISCORD_BOT_TOKEN_QIN` | `DISCORD_APP_ID_QIN` |
| เทค | tek | `DISCORD_BOT_TOKEN_TEK` | `DISCORD_APP_ID_TEK` |
| มีรา | mira | `DISCORD_BOT_TOKEN_MIRA` | `DISCORD_APP_ID_MIRA` |
| ฟ้าใส | fahsai | `DISCORD_BOT_TOKEN_FAHSAI` | `DISCORD_APP_ID_FAHSAI` |
| ภูผา | phupha | `DISCORD_BOT_TOKEN_PHUPHA` | `DISCORD_APP_ID_PHUPHA` |
| ธารา | thara | `DISCORD_BOT_TOKEN_THARA` | `DISCORD_APP_ID_THARA` |
| ส้มโอ | somo | `DISCORD_BOT_TOKEN_SOMO` | `DISCORD_APP_ID_SOMO` |
| พลอย | ploy | `DISCORD_BOT_TOKEN_PLOY` | `DISCORD_APP_ID_PLOY` |
| ปัตตี้ | pat | `DISCORD_BOT_TOKEN_PAT` | `DISCORD_APP_ID_PAT` |
| ปิ่น | pim | `DISCORD_BOT_TOKEN_PIM` | `DISCORD_APP_ID_PIM` |
| เบส | bass | `DISCORD_BOT_TOKEN_BASS` | `DISCORD_APP_ID_BASS` |
| สายชล | sai | `DISCORD_BOT_TOKEN_SAI` | `DISCORD_APP_ID_SAI` |

Only `praw` is required. A persona without a token, or whose login fails, is disabled: its work goes to Praw and #bot-log gets `persona_disabled:<id>` (posted by System). There is no webhook fallback. At most `DISCORD_MAX_CLIENTS` (default 25) tokens are accepted. `INTAKE_PERSONA` (default `praw`) names the intake persona.

## Create each application
1. Discord Developer Portal, New Application, name = persona display name, set the avatar.
2. Bot tab: **Public Bot off**. Reset Token, copy it once into the env file (never into chat, git or a ticket).
3. General Information: copy the Application ID into `DISCORD_APP_ID_<ID>`.
4. Discord may limit how many applications one account or team can own; if you hit the limit, stop and leave the rest disabled.

## Intents
- Intake app (praw) only: **Message Content** and **Server Members** (privileged, toggle on the Bot tab). Voice States is a standard intent (already enabled in code) and is used by voice (B2).
- Every other persona app: no privileged intents. The bot only posts and receives clicks on its own messages.

## Permissions
Per persona role: View Channel, Send Messages, Send Messages in Threads, Create Public Threads, Read Message History, Embed Links, Attach Files, Use Application Commands, Add Reactions. No Administrator. Voice permissions: see "Voice (B2)" below.
**No** Manage Webhooks, Mention Everyone or Administrator anywhere (webhooks are not used). Non-intake personas also need no Read Message History.

## Approval channels and ⚙️-setting (TASK-031)
Praw (the intake client) posts every approval card, so it needs **View Channel and Send Messages** (plus Embed Links) in each of these, and each must be allowlisted (a category overwrite or a `CHANNEL_ALLOWLIST` entry): the HQ approvals channel (`APPROVAL_CHANNEL_ID`), every department approvals channel you map with `/setting set approval.channel.<code>` (Finance, HR, Marketing, Sales, Operations, R&D, Software House), and the ⚙️-setting channel (`SETTINGS_CHANNEL_ID`). A department channel that Praw cannot see falls back to the HQ channel with a log line. Department heads (AI personas) decide through the system, not through these channels, so they need no access there; humans in the approver role click Approve/Reject (HQ items) or override an AI decision (department items). `/task`, `/approval` and `/setting` are guild-scoped slash commands registered by the intake app: keep **Use Application Commands** on for the people who use them in the allowlisted channels. `/setting` works only in the ⚙️-setting channel itself (not its threads).

## Voice (B2, Praw only)
Only Praw (the intake client) joins voice, and only when `VOICE_ENABLED=true`. Grant **channel overwrites on the allowlisted voice channels only** (never a server-wide role permission): View Channel, Connect, Speak, Send Messages (the voice channel's text chat). **Never** Move Members, Mute Members, Deafen Members or Priority Speaker. Persona apps get no voice permissions. Host needs `libopus0` (no ffmpeg). `VOICE_LIVE_CAPTURE` stays false until the TASK-002 DAVE probe passes.

## Server-side View Channel deny
Deny View Channel for every persona role on the whole server, then allow it back on the test category (a category overwrite) that holds the channels in `CHANNEL_ALLOWLIST`, `TASKS_CHANNEL_ID`, `APPROVAL_CHANNEL_ID` and `SETTINGS_CHANNEL_ID`. Keep #bot-log (`ADMIN_NOTIFY_CHANNEL_ID`) denied to the persona role (see System below). Other server content then never reaches a token on the Mac. Put all persona bots in one shared role to do this once.

## Invite
OAuth2 URL generator per app: scopes `bot` and `applications.commands` (slash commands are registered only by the intake app, guild-scoped), the permissions above, then open the link and pick the LabWorkSpace server. The bot leaves, and logs, any other server it finds.

## Env file
Mac: `.env.local` (one file for the CLI and Discord runs, mode 0600; see [local-dev.md](local-dev.md)); VPS: `/etc/employee/employee.env` (root, 0600). Values: every token and app id above, `DISCORD_GUILD_ID`, `CHANNEL_ALLOWLIST` (channel or category ids, comma separated; empty is refused in `coexist`), `APPROVAL_CHANNEL_ID`, `TASKS_CHANNEL_ID` and `SETTINGS_CHANNEL_ID` (if used), which must be inside the allowlist; `ADMIN_NOTIFY_CHANNEL_ID` (#bot-log), which must not be; `ROLLOUT_MODE=coexist` while the old bot runs. Optional: `DISCORD_BOT_TOKEN_SYSTEM` and `DISCORD_APP_ID_SYSTEM` for the System log bot. Two personas must not share a token (`token_shared`).

## Token rotation
1. Stop the bot (Mac script or `systemctl stop employee.service`).
2. Portal: Bot tab, Reset Token for that persona; copy it.
3. Replace the one value in the env file (keep mode 0600), start the bot.
4. The old token is dead at once. If a token leaked, rotate first, investigate after.

## Single-instance rule
Each token may be connected from one place at a time: two sessions answer every message twice. Stop the Mac run before starting on the VPS, and the reverse. Once all clients are up (or 120 s pass) System posts one summary line `online: <host> <git describe> clients=<up>/<total>` in #bot-log, then one `persona_disabled:<id>` line per disabled persona; a second `online` line without a stop means a second instance. The database check named in spec 12.9 cannot see across the Mac and the VPS, so this line is the real signal.

## Check after start
- #bot-log shows one `online` line from System (and the `persona_disabled` lines you expect).
- A message in a channel outside the allowlist gets no reply (the log shows only `gate.outside_allowlist` with the channel id).
- A slash command outside the allowlist gets an ephemeral refusal.
- A DM from someone without the approver role gets silence (while `coexist`).

## System (log bot, spec 12.14)
A 21st application named `System` posts every line in #bot-log (`ADMIN_NOTIFY_CHANNEL_ID`): `online:` and `persona_disabled:` lines, budget notices, the weekly scan alert and forwarded WARNING/ERROR/CRITICAL logs. It has no persona, no LLM and no commands. `system` is a reserved id, not a persona (`persona_id_reserved:system`).

| Item | Value |
| :-- | :-- |
| Env | `DISCORD_BOT_TOKEN_SYSTEM`, `DISCORD_APP_ID_SYSTEM`. Optional: without them lines go to the log file only. Never falls back to Praw. |
| Intents | None privileged (guilds only). |
| Permissions | A channel overwrite on #bot-log only: View Channel and Send Messages. No Embed Links, no Read Message History, no Mention Everyone, no Administrator, no app commands. System refuses to start posting if it has Administrator or Mention Everyone (`system_over_privileged`). |
| Roles | System is not in the persona role and has no guild-level permissions beyond the #bot-log overwrite. |
| #bot-log | A text channel, and not the same channel as `APPROVAL_CHANNEL_ID` or `TASKS_CHANNEL_ID` (`admin_channel_shared`). Deny View to `@everyone`, the persona role and the intake bot role; allow View to the approver role (it must be mentionable for budget pings). Praw is in every room except #bot-log. |
| Residual | Guild Administrators can still read #bot-log. It shows user, persona and channel ids. |
| Leak | If `DISCORD_BOT_TOKEN_SYSTEM` leaks, rotate it in the Developer Portal and update the env file. |
