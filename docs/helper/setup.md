---
title: "Setup — environment names, local CLI and native VPS deploy"
doc_id: "DOC-HLP-001"
version: 2.1.0
status: "Draft"
last_updated: 2026-11-24
author: DevOps Agent
referenced_plan: "docs/plans/2026-11-23-phase1-plan.md"
---

# Setup — environment names, local CLI and native VPS deploy

## Contents

- 1. Before you start — L39
- 2. Secrets (environment only) — L45
- 3. Process-only flag (CLI dev mode) — L57
- 4. Required configuration (spec §5.7) — L70
- 4.1 Runtime settings (TASK-031) — L99
- 4.2 Reply streaming (STREAM_MODE) — L116
- 5. Retention settings (spec §10.0) — L119
- 6. Startup checks you will hit — L126
- 7. Local run (CLI) — L137
- 8. Native VPS deploy (spec §11.11, §11.18) — L153
  - 8.1 Accounts (owner checklist, spec §11.18.2) — L157
  - 8.2 Deploy or upgrade — L179
  - 8.3 Editing the env file — L194
  - 8.4 Weekly dependency scan (dev account) — L210
  - 8.5 Restore a backup (spec §11.18.3) — L222
  - 8.6 Restore the knowledge directory (spec §11.19.9) — L240
  - 8.7 Restoring a Hostinger backup (spec §11.19.10) — L256
- 9. Checks for a new environment — L266
- 10. Related documents — L272

> Status (v0.2.0 release candidate): the owner pivoted to SQLite and a native systemd service on the Hostinger VPS (spec §11, `docs/specs/2026-11-23-phase1-spec-s11-sqlite-vps.md`). There is no Docker, Compose or Postgres. Deploy files live in `deploy/`. The Discord layer (one client per persona, System log bot, approvals routing) is built in code. It is not live on the VPS; the service is enabled only at B1-ENABLE.

This document lists environment variable **names only**. Values are never written in the repository, in docs, in the Book or in chat. Keep your real values in `.env.local` at the project root (dev) or in `/etc/employee/employee.env` (VPS). On the Mac the same `.env.local` also holds the Discord tokens and ids (`.env.discord.local` is retired); `dev-local.sh` unsets them before the CLI starts ([local-dev.md](local-dev.md)). Git ignores `.env.local` (`tests/test_ignore_files.py`).

## 1. Before you start

- Owner decisions and Slice order: `docs/plans/2026-11-23-phase1-plan.md`. Slice A (core, CLI) is built first. Slice B (Discord) waits for the owner's Discord setup.
- Architecture: `docs/development/architecture.md`.
- Target host: Debian 13 (trixie), KVM 1 (1 vCPU, 4 GB RAM), Python 3.13 from Debian's `python3.13` (spec §11.19). Dev machines on 3.12 still work. Dependencies in `pyproject.toml`, hashed locks in `constraints/` (`requirements.lock` runtime, `dev.lock` runtime + test + audit).

## 2. Secrets (environment only)

These three names are secrets. The bot never prints them, never passes them to a model and never writes them to logs (spec §5.7, §10.3, §11.9).

| Name | Used by | Notes |
| :-- | :-- | :-- |
| `DISCORD_BOT_TOKEN_<ID>` | Discord bot token, one per persona (Slice B1) | `<ID>` is the persona id in upper case, e.g. `DISCORD_BOT_TOKEN_PRAW`. Each token is its own Discord application (spec §12.10). Must be **unset** for CLI dev mode. A plain `DISCORD_BOT_TOKEN` is refused (`use_per_persona_tokens`); two personas sharing one token are refused (`token_shared`). The full persona list is in [discord-apps.md](discord-apps.md). `DISCORD_BOT_TOKEN_SYSTEM` is the optional log bot (spec §12.14, not a persona); its app id is `DISCORD_APP_ID_SYSTEM`. |
| `ANTHROPIC_API_KEY` | Anthropic provider | At least 12 characters. Must be a workspace-scoped key (`sk-ant-api03-...`). A key not scoped to a workspace is rejected with "must include the anthropic-workspace-id header". |
| `GOOGLE_API_TOKEN` | Google provider, image, and preferably STT/TTS | At least 12 characters. |

Path variables `DATABASE_PATH`, `KNOWLEDGE_DIR`, `LOG_DIR`, `VOICE_TMP_DIR` are set by the systemd unit (or the dev shell), never in the env file. `/etc/employee/employee.env` must not contain them or `EMP_CLI_DEV`; `install.sh` and the unit's start guard refuse such a file (spec §11.11.2, §11.18.6).

## 3. Process-only flag (CLI dev mode)

| Name | Value that enables CLI dev mode | Rule |
| :-- | :-- | :-- |
| `EMP_CLI_DEV` | `1` | Set in the **process environment** only (see the subshell command in section 7). Never put it in `.env.local` (both scripts set or refuse it) or the VPS env file. The bot never stores it as a config field and reads it only through `os.environ` (spec §10.0, §10.7.6). |

The CLI refuses to start (exit code 2) in these cases (spec §10.7.6, §10.14, §10.15):
- `EMP_CLI_DEV` is not `1` in the process environment: `cli_dev_disabled`.
- Any `DISCORD_BOT_TOKEN*` name (plain or `DISCORD_BOT_TOKEN_<ID>`) is set to a non-empty value in the process environment: `cli_dev_disabled`.
- `.env.local` contains a line that sets `EMP_CLI_DEV`: `cli_flag_in_env_file`.

`Config.load` never writes to `os.environ` (spec §10.17 RC-3). An env file that sets `LOG_LEVEL` does not change the process environment.

## 4. Required configuration (spec §5.7)

These names are required by spec §5.7. Which of them the CLI requires is not stated in spec §10; `DISCORD_GUILD_ID` in particular is used by the Discord layer, and the CLI uses `guild_id=0` (spec §10.15). Treat the CLI requirement as **open** until the sa role confirms it.

| Name | Notes |
| :-- | :-- |
| `DISCORD_GUILD_ID` | Discord server id. |
| `DISCORD_APP_ID_<ID>` | Application id of each persona with a token; required for every `DISCORD_BOT_TOKEN_<ID>` (`app_id_mismatch:<id>` if the client logs in as another app). Same suffix rule as the token. |
| `CHANNEL_ALLOWLIST` | Comma-separated channel or category ids the bot may read and answer in. Empty is refused in `coexist` (`allowlist_empty`). Every id must be a digit snowflake (`invalid:CHANNEL_ALLOWLIST`). |
| `ROLLOUT_MODE` | `coexist` (default, bot runs beside the old bot) or `full`. Any other value is refused (`invalid:ROLLOUT_MODE`). |
| `PERSONA_NAME_SUFFIX` | Display-name suffix for persona bots during `coexist`, e.g. `(ใหม่)`. Empty uses the built-in coexist suffix; whitespace only is refused (`bounds:PERSONA_NAME_SUFFIX`). The reply gate strips it before name matching. |
| `INTAKE_PERSONA` | Persona id of the one intake client (the only client with message-content intents). Default `praw`. |
| `DISCORD_MAX_CLIENTS` | Hard cap on persona clients. Default 25; bounds 1..100 (`bounds:DISCORD_MAX_CLIENTS`); more tokens than the cap is refused (`too_many_clients`). |
| `APPROVAL_CHANNEL_ID` | Channel for approval embeds. Must be inside `CHANNEL_ALLOWLIST` (`channel_not_allowlisted`). |
| `ADMIN_NOTIFY_CHANNEL_ID` | #bot-log: where System posts admin notices and forwarded logs (spec §12.14). Praw never reads or writes there, so it is not allowlisted. Must differ from `APPROVAL_CHANNEL_ID` and `TASKS_CHANNEL_ID` (`admin_channel_shared`). |
| `SETTINGS_CHANNEL_ID` | Optional. The ⚙️-setting channel where approver-role humans run `/setting view|set|reset`. Must be inside `CHANNEL_ALLOWLIST` (`settings_channel_invalid` otherwise) and must differ from `ADMIN_NOTIFY_CHANNEL_ID` (`admin_channel_shared`). While unset, `/setting` replies "not configured". |
| `TASKS_CHANNEL_ID` | Channel for task threads. Must be inside `CHANNEL_ALLOWLIST` (`channel_not_allowlisted`). |
| `APPROVER_ROLE_ID` or `APPROVER_ROLE_NAME` | One of the two. `APPROVER_ROLE_NAME` defaults to `AI-Admin` (spec §5.7). The bot refuses a role id equal to the guild id or a managed role (`approver_role_invalid`). |
| `DEFAULT_CHEAP_MODEL` | Model id for cheap calls. Model ids are never hard-coded. |
| `REPLY_TIER2_MODEL` | Model id for the tier-2 reply classifier. |
| `IMAGE_MODEL` | Image model id. |
| `TTS_MODEL` | Text-to-speech model id. |
| `TTS_VOICE` | Text-to-speech voice name. |
| `STT_PROVIDER` | Speech-to-text provider. Value to be set by the Slice B build (TASK-016). |
| `STT_MODEL` | Speech-to-text model id. |
| `GEMINI_PAID_TIER_CONFIRMED` | Voice only. Default `false`. With `STT_PROVIDER=gemini`, live recording and STT refuse (`paid_tier_not_confirmed`) until you set `true` after confirming billing is active on the Google Cloud project (free tier lets Google use audio to improve products; spec §12.12.23). |

The defaults for all other settings (agent limits, timeouts, budgets, voice, job runner, paths) are in spec §5.7. Do not copy them here; check that table when you change a value.

### 4.1 Runtime settings (TASK-031)
`.env` keeps fixed values and secrets. Tunables live in the database and change in the ⚙️-setting channel (`/setting view [key]`, `/setting set key value`, `/setting reset key`; approver role only; every change is audited and logged). Effective value = database row, else the seed below.

| Key | Values | Seed |
| :-- | :-- | :-- |
| `approval.hq_threshold_thb` | 1..100,000,000 (commas allowed); a value at or above it goes to HQ | 10,000 |
| `approval.ttl_h` | 1..168 hours, new approvals only | `APPROVAL_TTL_H` (24) |
| `approval.rate_per_day` | 1..100 requests per requester per day | 10 |
| `approval.ai_enabled` | `on` / `off` (off = every request goes to HQ) | on |
| `approval.ai_daily_max` | 0..200 AI decisions per head per day | 20 |
| `approval.channel.<code>` | `hq` or a channel id inside the allowlist (not the settings or #bot-log channel). Codes: fin hr mkt sal ops it leg prc sup dat dsn prd dev | Finance, HR, Marketing, Sales, Operations, R&D (`prd`) and Software House (`dev`) channels; every other code `hq` |
| `approval.head.<code>` | `none` or the id of an enabled persona of that department | account mali, hr fahsai, marketing somo, sales bass, operations ploy, it phupha, legal thara, procurement pat, support sai, data kawin, design nicha, product pim, dev tek |

Approval routing: a request below `approval.hq_threshold_thb` goes to its department's AI head; a request at or above it goes to HQ, where a human with the AI-Admin role decides. Codes: tasks `DEV-0001`, approvals `APR-FIN-0007`. Discord commands: `/task show|edit|cancel`, `/approval show|cancel`, and `/setting view|set|reset`. `/setting` works only in `SETTINGS_CHANNEL_ID`, not in its threads. Spec: `docs/specs/2026-11-24-approvals-routing-spec.md`.

`APPROVAL_CHANNEL_ID` stays the HQ approvals channel and the fallback when a department channel is unset, unresolved or not allowlisted. `APPROVAL_TTL_H` is now only the seed for `approval.ttl_h`. Migrations 0002 (`approvals_routing`) and 0003 (`audit_decide`) run at the next start: stop the service first (`python -m core.migration` takes a pre-migration backup). Pending department approvals are reviewed again by their head after a restart.

### 4.2 Reply streaming (STREAM_MODE)
`STREAM_MODE` is optional and defaults to `typing`. `typing` shows the Discord typing indicator, renews it every 8 s, then sends one final message. `edit` posts a placeholder message and then edits it live. Any other value is refused (`bounds:STREAM_MODE`). Set it in `.env.local` or the VPS env file (names only in [`.env.example`](../../.env.example)).

## 5. Retention settings (spec §10.0)

| Name | Default | Bounds |
| :-- | :-- | :-- |
| `KNOWLEDGE_MEETINGS_RETENTION_DAYS` | 90 | 1..3650 |
| `TASKS_RETENTION_DAYS` | 180 | 1..3650 |

## 6. Startup checks you will hit

Config refuses to start with these codes (spec §10.14). Each code is the message printed on a non-zero exit.

- `secret_too_short:<NAME>`: a set API secret is shorter than 12 characters.
- `db_path_invalid`, `schema_not_head`, `bounds:MEMORY_MAX`: database path, migration state and the unit memory bound (spec §11.9).
- `voice_tmp_dir_invalid`: `VOICE_TMP_DIR` is relative, is `/`, is inside the project or knowledge folder, or is a symlink (Slice B).
- `budget_guard_missing`, `approver_role_invalid`, `cli_flag_in_discord_mode`: see spec §10.14.

Empty environment values count as unset (spec §10.3.2).

## 7. Local run (CLI)

Run the CLI in a **subshell** so secrets never stay in your login shell (spec §11.18.2):

```text
bash scripts/dev-local.sh [--fake] [--script FILE]   # sources .env.local, unsets every DISCORD_* token, sets EMP_CLI_DEV=1
```

Leave every `DISCORD_BOT_TOKEN*` unset. To run the Discord bot on the Mac instead, see [local-dev.md](local-dev.md). Dev venv: `python3.13 -m venv .venv && .venv/bin/pip install --require-hashes -r constraints/dev.lock`. No unhashed `pip install`.

- Default identity is `--as user`, default agent is `DEFAULT_AGENT_ID` (`praw` by default).
- Commands: `/agent`, `/as`, `/approvals`, `/approve`, `/reject`, `/budget set`, `/jobs`, `/cancel`, `/brainstorm`, `/wait-idle`, `/quit` (spec §10.15).
- Script mode: `#` lines are comments; `/expect <regex>` checks printed output. Exit codes: 0 all passed, 1 failed expectation or agent failure, 2 startup refusal.
- Approvals in the CLI use `cli:admin` only. `cli:user` gets `not_approver`.
- The CLI refuses to run as the service user `employee` (spec §11.18.11).

## 8. Native VPS deploy (spec §11.11, §11.18)

Debian 13 only (`install.sh` refuses any other release: `host_not_debian13`). Bot memory cap `MemoryMax=2G` (dedicated host) or `1G` with `CPUQuota=60%`, `TasksMax=100`, `Nice=5` (shared host); `JOB_MAX_CONCURRENCY` defaults to 1 (1 vCPU, spec §11.19.6). Layout: code in `/opt/employee/app` (root-owned git checkout), venv in `/opt/employee/venv`, secrets in `/etc/employee/employee.env` (root, 0600), data in `/var/lib/employee`, logs in `/var/log/employee`. The service runs as the unprivileged user `employee` under systemd hardening. The bot needs no inbound port. **Shared host is the default** (spec §11.20, VM 1754227: other services run there; admin account `lw`): `install.sh --shared-host` never touches ufw, sshd, unattended-upgrades, reboot policy or needrestart, prints `skip:<step> shared-host` for each, and exits 1 `host_config_changed` if ufw, `sshd -T`, `/etc/apt/apt.conf.d/` or the Docker container list differ from the pre-install snapshot (`/var/lib/employee-install/pre/`). Use `--dedicated-host` only on a host that runs just this app. `install.sh --plan` prints the commands it would run. The code default for `JOB_MEMORY_LIMIT_MB` is 1024, so on the shared host add to `/etc/employee/employee.env`: `JOB_MAX_CONCURRENCY=1` and `JOB_MEMORY_LIMIT_MB=512` (bot baseline 512 + 512 fits the 1G cap).

### 8.1 Accounts (owner checklist, spec §11.18.2)

Three separate roles. Keep one root or admin SSH session open throughout. On the shared host the admin account is `lw` (existing, full sudo, root SSH disabled); steps 0 to 5 below are not applicable on the shared host.
- **Admin account** (`<admin>`): in group `sudo`, SSH key only. Runs deploys and edits the env file.
- **Dev account** (`<dev>`): runs the CLI and tests. In none of the groups sudo, admin, lxd, docker, adm, systemd-journal, employee.
- **Service user** `employee`: created by `install.sh`; no password, no shell.

Steps, in order:
0. Owner step 0 (spec §11.19.3), as root over the existing root SSH key, before anything else. A minimal Debian 13 image may lack `git` and `sudo`: (Not applicable on the shared host: install.sh installs git itself.)
   ```sh
   apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git sudo ca-certificates
   timedatectl show -p Timezone --value   # must print Etc/UTC, UTC or Asia/Bangkok; otherwise: timedatectl set-timezone Etc/UTC
   ```
   Timezone note: `install.sh` never changes the host timezone. On UTC the auto-reboot is 21:30 (04:30 Bangkok); a zone such as `Asia/Kolkata` makes it refuse (`reboot_tz_unknown`), so set `Etc/UTC` here. The backup timer names `Asia/Bangkok` itself and fires at 03:30 Bangkok on any host zone. (Not applicable on the shared host.)
1. As root: `adduser <admin>`, `usermod -aG sudo <admin>`, put your public key in `/home/<admin>/.ssh/authorized_keys` (0600, owned by `<admin>`). (Not applicable on the shared host.)
2. From a **new** terminal prove `ssh <admin>@<vps>` and `sudo -v` work. Do not continue until they do. (Not applicable on the shared host.)
3. Drop the dev account's privileges, as admin: `for g in sudo admin lxd docker adm systemd-journal employee; do getent group "$g" >/dev/null && gpasswd -d <dev> "$g" 2>/dev/null; done`, then `rm -f /run/sudo/ts/<dev>` and `loginctl terminate-user <dev>`. (Not applicable on the shared host.)
4. Verify: `id -nG <dev> | tr ' ' '\n' | grep -Exq 'sudo|admin|lxd|docker|adm|systemd-journal|employee'` exits 1, and `runuser -u <dev> -- sudo -n true` fails. (Not applicable on the shared host.)
5. Deploy (8.2). Then check `sshd -T | grep -Ei '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin) '` prints `no`, `no`, `without-password`. Test a new login before closing the old session. (Not applicable on the shared host.)
6. (Removed: Debian has no Ubuntu Pro; spec §11.19.4.) Patch coverage is Debian-Security via unattended upgrades plus the mandatory weekly dpkg scan (8.4).
7. As dev: `loginctl enable-linger <dev>` (the weekly audit timer needs it). On the shared host the timer runs as `lw`: `loginctl enable-linger lw`.

### 8.2 Deploy or upgrade

As root, pin the commit first, then run the script with the same 40-hex SHA (the script never checks out code itself):

```text
git -C /opt/employee/app fetch origin && git -C /opt/employee/app checkout --detach <sha>
/opt/employee/app/deploy/install.sh <sha>
```

First install: clone the repository to `/opt/employee/app` before the commands above. The script is idempotent: it verifies the SHA and a clean tree, installs packages and the service user, rebuilds the venv from the hashed lock, seeds knowledge as `employee`, installs units and logrotate, sets unattended upgrades, then the firewall (ufw: default deny, one allow rule for the sshd port from `sshd -T`, not the OpenSSH profile) and sshd (key-only; refuses if no authorized key exists, if any sshd config has a `Match` block (`sshd_match_block`), or if sshd listens on more than one port (`sshd_multiple_ports`)). The venv checks (including loading `libopus.so.0` for voice; no ffmpeg) run as `employee`; if the host has swap, a `MemorySwapMax=0` drop-in is written for the bot and backup units. In shared-host mode (default) the unattended-upgrades, firewall and sshd parts are skipped and only `python3.13 python3.13-venv sqlite3 git ca-certificates tzdata libopus0` are installed (no `libpam-systemd`; `lw`'s audit timer needs it already present). `apt-get` runs with `--no-upgrade` (installed host packages are never upgraded) and `-o DPkg::Lock::Timeout=600` (waits up to 10 minutes for unattended-upgrades, then refuses; never kills). Snapshots of ufw, `sshd -T`, `/etc/apt/apt.conf.d/` and Docker containers go to `/var/lib/employee-install/` (root 0700, refused if it is a symlink; never under `/var/log/employee` or `/var/lib/employee`). An EXIT trap re-snapshots after any exit, success or failure, and prints `host_config_changed:<which>` on a difference (exit code 1, or the original failure code). It also prints report-only `report:services_changed` and `report:packages_changed` with the diff of running services and `dpkg-query` versions; these never fail the run.

Kernel reboots: `AUTO_REBOOT` at the top of `deploy/install.sh` defaults to `true` (owner decision, spec OQ-7): after unattended upgrades the host reboots at 04:30 Asia/Bangkok (21:30 if the host clock is UTC; any other timezone makes the script refuse). Run `AUTO_REBOOT=false deploy/install.sh <sha>` to opt out and reboot by hand when `/var/run/reboot-required` exists. Not applicable on the shared host: the host keeps `Automatic-Reboot "false"`; reboot by hand when `/var/run/reboot-required` exists.

The backup timer is enabled only once `/var/lib/employee/employee.db` exists; the service unit is enabled only once `core/__main__.py` exists.

### 8.3 Editing the env file

Only from the admin account, leaving no editor residue. Either paste the whole file:

```text
sudo install -o root -g root -m 0600 /dev/stdin /etc/employee/employee.env
```

(paste, then Ctrl-D), or:

```text
SUDO_EDITOR="vim -n -i NONE -c 'set nobackup nowritebackup noundofile'" sudoedit /etc/employee/employee.env
```

Then `sudo systemctl restart employee`. The unit refuses to start if the file sets a forbidden name.

### 8.4 Weekly dependency scan (dev account)

`deploy/user/employee-audit.{service,timer}` run `pip-audit` (from `constraints/dev.lock`) and grype weekly, Monday 05:00 Asia/Bangkok. Install as the dev user:

```text
install -m 0644 deploy/user/employee-audit.* ~/.config/systemd/user/ && systemctl --user daemon-reload && systemctl --user enable --now employee-audit.timer
```

The unit also scans the host's installed Debian packages (a copy of `/var/lib/dpkg/status`, `--distro debian:13 --only-fixed`, fails on high); this scan is mandatory (spec §11.19.4, G2S11-02).

grype is a pinned release tarball; verify with `sha256sum -c deploy/grype.sha256` before extracting to `~/.local/bin/grype`. Failures are read manually with `systemctl --user --failed` for now; a Discord alert comes in Slice B (spec OQ-8).

### 8.5 Restore a backup (spec §11.18.3)

Run as root from the admin account. Restore is a CLI that runs all-or-nothing as the service user, and it keeps every current `voice_optouts` row (a user who opted back in after the backup stays opted out; that is the safe direction).

```sh
cd /opt/employee/app   # python -m imports `core` from the cwd; never run these from another directory
systemctl stop employee.service employee-backup.timer employee-backup.service
runuser -u employee -- env DATABASE_PATH=/var/lib/employee/employee.db /opt/employee/venv/bin/python -m core.db.backup restore <backup-name> [--allow-optout-gap]
runuser -u employee -- env DATABASE_PATH=/var/lib/employee/employee.db /opt/employee/venv/bin/python -m core.migration.retention_main
systemctl start employee.service employee-backup.timer
```

- `<backup-name>` is a file name under `/var/lib/employee/backups/` (for example `daily-20261124T033012345678Z.db`), never a path.
- The `retention_main` line is the one-shot retention sweep (spec OQ-6): exit 0 is ok, exit 2 is failure. Do not start the service if it fails.
- If the current DB is unreadable, the restore refuses unless you pass `--allow-optout-gap` (owner decision, spec OQ-9). With the flag it restores anyway and writes the marker `/var/lib/employee/consent_gap`.
- While `consent_gap` exists, voice must re-ask consent from everyone at the next recording. Clearing it is a manual owner step, done only after consent has been re-collected: `runuser -u employee -- rm /var/lib/employee/consent_gap`.
- Privacy notice: backups are kept locally for 14 days, Hostinger snapshots have their own retention, and snapshots also capture `/var/lib/employee/knowledge` (transcripts). Data is stored in Mumbai, India (spec §11.19.11).

### 8.6 Restore the knowledge directory (spec §11.19.9)

Each daily backup also writes `knowledge-<UTC stamp>.tar.gz` (0600) next to the DB backups; the newest 14 are kept, none older than 14 days. Run as root from the admin account; every write happens as `employee`:

```sh
K='<knowledge backup file name, e.g. knowledge-20261124T033012345678Z.tar.gz>'
case "$K" in ''|*/*) echo bad_backup_name >&2; exit 1;; esac
systemctl stop employee.service employee-backup.timer employee-backup.service
cd /opt/employee/app && umask 077
runuser -u employee -- env DATABASE_PATH=/var/lib/employee/employee.db KNOWLEDGE_DIR=/var/lib/employee/knowledge \
  /opt/employee/venv/bin/python -m core.db.backup restore-knowledge "$K"
systemctl start employee.service employee-backup.timer
```

- A restore brings back knowledge entries erased after the archive date. Re-apply those erasures before restarting (spec OQ-13).

### 8.7 Restoring a Hostinger backup (spec §11.19.10)

Hostinger's weekly whole-disk copies include the DB, local backups, knowledge and `/etc/employee/employee.env` (secrets in plaintext). Their retention and region are unknown (OQ-11), so erased data can persist there beyond the 14-day bound. Rotate the three API secrets if such a copy may be exposed.

A Hostinger restore rolls back the whole disk, including `voice_optouts`. Before starting `employee.service`: if the pre-restore host was readable, export its `voice_optouts` first and re-apply them with 8.5; otherwise create the consent-gap marker:

```sh
runuser -u employee -- sh -c 'umask 077; date -u +%Y-%m-%dT%H:%M:%S.000Z > /var/lib/employee/consent_gap'
```

## 9. Checks for a new environment

- No secret value appears in the repository, in logs or in chat. Only names are documented.
- `.env.local` is ignored by git (`tests/test_ignore_files.py`) and no `.env*` file exists under `/opt/employee` (spec §11.18.10).
- Discord tokens are only `DISCORD_BOT_TOKEN_<ID>`, one per persona with its `DISCORD_APP_ID_<ID>`. The plain `DISCORD_BOT_TOKEN` is refused (`use_per_persona_tokens`, spec §12.10). Any other spelling is a defect.

## 10. Related documents

- Architecture: `docs/development/architecture.md`
- Persona format: `docs/development/persona-format.md`
- Knowledge format: `docs/development/knowledge-format.md`
- Full spec: `docs/specs/2026-11-23-phase1-spec.md` (§5.7 defaults, §10 overrides)
- Discord applications (owner guide, persona ids and env names): `docs/helper/discord-apps.md`
- Local dev on a Mac, including the Discord bot: `docs/helper/local-dev.md`
