# Local dev on a Mac

Run the agents from a terminal (the CLI, no Discord), or run the Discord bot on the Mac. Data lives outside the repo in `~/.local/share/employee-dev` (mode 0700; override with `EMP_DEV_DIR`).

## Contents
- [Prerequisites](#prerequisites)
- [Run](#run)
- [Commands](#commands)
- [Reset](#reset)
- [Cost](#cost)
- [Run the Discord bot on the Mac](#run-the-discord-bot-on-the-mac)
  - [Env names](#env-names)
  - [Slash commands and System log bot](#slash-commands-and-system-log-bot)
  - [Logs](#logs)
  - [Troubleshooting](#troubleshooting)

## Prerequisites
- `.venv` in the repo root with the project installed (`python3 -m venv .venv && .venv/bin/pip install -e .`).
- Voice (Discord bot on the Mac): `brew install opus` (libopus; no ffmpeg needed).
- Real mode only: `.env.local` in the repo root with `ANTHROPIC_API_KEY`, `GOOGLE_API_TOKEN` and the model/channel vars from `.env.example`. It is the single local env file for both scripts and may also hold the Discord tokens; `dev-local.sh` unsets every `DISCORD_BOT_TOKEN*` and `DISCORD_APP_ID_*` before starting the CLI. It must not set `EMP_CLI_DEV`. Empty lines (`NAME=`) from the template are fine.
- `ANTHROPIC_API_KEY` must be a workspace-scoped key (`sk-ant-api03-...`). See [setup.md §2](setup.md#2-secrets-environment-only).

## Run
- `scripts/dev-local.sh --fake` - fake providers, no keys, no cost. Replies start with `[fake]`.
- `scripts/dev-local.sh` - real providers (keys from `.env.local`, never printed).
- Extra args pass through, e.g. `scripts/dev-local.sh --fake --script my.txt`.

The script migrates the DB, seeds `knowledge/` from the repo on first run, then starts `python -m core.cli --as admin`.

## Commands
| Command | What it does |
|---|---|
| plain text | chat with the current agent |
| `/agent <id\|name>` | switch persona |
| `/as admin\|user` | switch identity (only admin can approve) |
| `/delegate <agent> <title>` | ask the current agent to create a task for `<agent>` |
| `/brainstorm "<topic>" <id> <id> [turns]` | multi-agent discussion |
| `/thread <n>` / `/main` | enter a task/brainstorm thread / go back |
| `/approvals`, `/approve [id]`, `/reject [id]` | list or decide approvals (default: last) |
| `/budget set <agent> <usd>` | set a daily limit |
| `/jobs`, `/cancel <id>` | list or cancel jobs |
| `/wait-idle [s]` | wait for background work |
| `/quit` | exit |

Fake-mode triggers: a message containing `NEEDAPPROVAL` raises an approval, `KNOWQ` reads knowledge (try "alpha"), `IMAGEQ` generates a fake image.

## Reset
Stop the CLI, then `rm -rf ~/.local/share/employee-dev` (all dev chats, approvals, knowledge edits, and the Discord run's DB and logs).

## Cost
Real mode calls paid APIs on every message and delegation; keep budgets low with `/budget set`.

## Run the Discord bot on the Mac
Needs the owner setup in [discord-apps.md](discord-apps.md) first. The script is `scripts/dev-discord.sh`. Single-instance rule: stop the VPS service before starting here, and the reverse.

### Env names
- Put the tokens and ids in `.env.local` in the repo root (the same file as the CLI run; `.env.discord.local` is retired; override with `EMP_DISCORD_ENV_FILE`): `chmod 600`, owned by you, a regular file (a symlink is refused). It holds `DISCORD_BOT_TOKEN_<PERSONA>` and `DISCORD_APP_ID_<PERSONA>` per persona, `DISCORD_GUILD_ID`, `CHANNEL_ALLOWLIST`, `TASKS_CHANNEL_ID`, `ADMIN_NOTIFY_CHANNEL_ID`, `APPROVAL_CHANNEL_ID`, the approver role, model and provider keys. `dev-discord.sh` refuses a non-empty `EMP_CLI_DEV`, `DATABASE_PATH`, `KNOWLEDGE_DIR`, `LOG_DIR`, `VOICE_TMP_DIR` or plain `DISCORD_BOT_TOKEN` in the file (empty values are fine). Names only: see `.env.example`.
- Optional: `DISCORD_BOT_TOKEN_SYSTEM` and `DISCORD_APP_ID_SYSTEM` for the System log bot. Without them the log lines go to the log file only.
- Optional: `SETTINGS_CHANNEL_ID` for the ⚙️-setting channel, and `STREAM_MODE` (`typing` by default, or `edit`; see [setup.md §4.2](setup.md#42-reply-streaming-stream_mode)).
- The file must not set `EMP_CLI_DEV`, `DATABASE_PATH`, `KNOWLEDGE_DIR`, `LOG_DIR` or `VOICE_TMP_DIR` (the script owns them; data goes to `~/.local/share/employee-dev/discord/`), and `CHANNEL_ALLOWLIST` must not be empty.
- `scripts/dev-discord.sh` migrates the DB and runs `python -m core`. It never prints the file.

### Slash commands and System log bot
- `/task show|edit|cancel`, `/approval show|cancel` and `/setting view|set|reset` are registered by the intake app (Praw). `/setting` works only in `SETTINGS_CHANNEL_ID`, for approver-role humans. Approval routing: [setup.md §4.1](setup.md#41-runtime-settings-task-031).
- Once all clients are up (or after 120 s), System posts `online: <host> <git describe> clients=<up>/<total>` in #bot-log (`ADMIN_NOTIFY_CHANNEL_ID`), then one `persona_disabled:<id>` line per disabled persona. Two `online` lines without a stop in between mean two instances.
- System forwards WARNING and above from the log to #bot-log.

### Logs
- JSON lines: `~/.local/share/employee-dev/discord/logs/app.jsonl`. The bot never writes secret values to it.

### Troubleshooting
- Startup refusals print a code only (for example `allowlist_empty`, `channel_not_allowlisted`, `allowlist_unresolved`, `app_id_mismatch:<persona>`, `token_shared`, `use_per_persona_tokens`, `cli_flag_in_discord_mode`, `settings_channel_invalid`, `admin_channel_shared`).
- `/setting` replies "not configured" while `SETTINGS_CHANNEL_ID` is unset.
- An Anthropic error "must include the anthropic-workspace-id header" means the key is not workspace-scoped. Replace it with a workspace key (`sk-ant-api03-...`).
