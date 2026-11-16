# Documentation index

Table of contents for everything under `docs/`. Start with the [README](../README.md) for the overview, or pick a category below.

## Getting started

| File | What it covers |
| :--- | :--- |
| [local-development.md](getting-started/local-development.md) | Install, test and build the service from source |
| [local-mode-setup.md](getting-started/local-mode-setup.md) | Running the whole service on your Mac: setup, the bot tokens, and the local provider probe |
| [env-file.md](getting-started/env-file.md) | Where the local secrets file lives, its permissions, and what must never go into it |
| [first-run.md](getting-started/first-run.md) | Starting the local containers and the app, in the right order, and what to check after boot |

## Configuration

| File | What it covers |
| :--- | :--- |
| [environment-variables.md](configuration/environment-variables.md) | Every environment variable, whether it is required, and what it does |
| [providers-and-models.md](configuration/providers-and-models.md) | The Claude API default, the Gemini key, the optional local provider, and how to switch the local provider off |
| [budgets-and-quotas.md](configuration/budgets-and-quotas.md) | Spend caps, department budgets, local call limits and the budget and approval rules |
| [off-days-and-holidays.md](configuration/off-days-and-holidays.md) | Weekly off days and holidays, and what pauses on them |

## Features

| File | What it covers |
| :--- | :--- |
| [organisation.md](features/organisation.md) | The AI company: department heads, personas, tasks and how they hand work over |
| [praw.md](features/praw.md) | Praw, the Gemini-backed head: setup, pricing, data terms and her keys |
| [admin-console-and-server-management.md](features/admin-console-and-server-management.md) | Changing settings through Praw, server management through the LW Admin executor, and the delegated Moderator and Manager tiers |
| [settings-panels.md](features/settings-panels.md) | The Discord settings panel and the local web dashboard, with their guards |
| [governance-and-approvals.md](features/governance-and-approvals.md) | Company autopilot and the second confirmation for deploys and destructive server operations |
| [tools-and-plugins.md](features/tools-and-plugins.md) | How tools declare their class, how to add a plugin, and the GitHub write tools |
| [web-and-chrome.md](features/web-and-chrome.md) | Headless Chrome for the web tools, the open-source search fallback, and the web reading grant |
| [documents-and-receipts.md](features/documents-and-receipts.md) | The document and diagram renderer, receipt reading, and the optional Google Sheets export |
| [media-music-voice.md](features/media-music-voice.md) | The media sidecar, image generation, music playback and voice chat, with the owner's live checks |
| [workspaces.md](features/workspaces.md) | The sandboxed project workspace and why its write tools need no approval |
| [mcp-and-forge.md](features/mcp-and-forge.md) | Allowing Docker-packaged MCP servers, and the plugin forge that lets bots build plugins |
| [self-knowledge.md](features/self-knowledge.md) | Self-updating department notes, lessons and prompts, and what a Bot Admin confirms |

## Operations

| File | What it covers |
| :--- | :--- |
| [start-stop-restart.md](operations/start-stop-restart.md) | Running the agent under launchd (`net.labworkspace.assistant`), restarting it, and stopping local mode |
| [health-and-logs.md](operations/health-and-logs.md) | The health endpoint and the log commands |
| [incidents-and-bot-log.md](operations/incidents-and-bot-log.md) | What `#🧾-bot-log` posts and how to find an incident in the live log |
| [halt-and-resume.md](operations/halt-and-resume.md) | Stopping all agent work from outside Discord, and resuming safely |
| [backups-and-restore.md](operations/backups-and-restore.md) | Local database backups, the restore list after a Docker reset, and how to restore |
| [rotation.md](operations/rotation.md) | Rotating bot tokens, provider keys and the master key, and recovering after a lost Mac |
| [executor.md](operations/executor.md) | The LW Admin executor and how it runs under its own macOS user |
| [media-sidecar-live-checks.md](operations/media-sidecar-live-checks.md) | The media sidecar deploy order and the live checks that only the VPS can show |
| [media-binaries.md](operations/media-binaries.md) | The pinned yt-dlp and ffmpeg binaries, their checks, and the bump procedure |
| [troubleshooting.md](operations/troubleshooting.md) | A symptom index that points to the page that owns each fix |

## Deployment

| File | What it covers |
| :--- | :--- |
| [owner-setup-checklist.md](deployment/owner-setup-checklist.md) | The one-time Discord, role, database and secrets steps |
| [running-next-to-discord-bot.md](deployment/running-next-to-discord-bot.md) | What must be true before the Assistant shares a server with the old Gemini bot |
| [before-moving-to-the-vps.md](deployment/before-moving-to-the-vps.md) | The checks to run before the local setup moves to the VPS |
| [vps-deploy-lw-git.md](deployment/vps-deploy-lw-git.md) | How lw-git builds and deploys the image on the VPS, and the parent infra overlay |
| [vps-deploy-from-discord.md](deployment/vps-deploy-from-discord.md) | Asking Praw to deploy a website to the VPS through a Bot Admin card |
| [acceptance-checklist.md](deployment/acceptance-checklist.md) | The owner's live end-to-end acceptance checks in Discord |
| [cutover/m2.md](deployment/cutover/m2.md) | Moving reminders, scheduled tasks, watches, lessons and pins to Praw, with the rollback |
| [cutover/m3.md](deployment/cutover/m3.md) | Moving ClickUp and GitHub to Praw, with the rollback |
| [cutover/m4.md](deployment/cutover/m4.md) | Moving OCR and receipts to Praw, with the rollback |
| [cutover/retiring-discord-bot.md](deployment/cutover/retiring-discord-bot.md) | Retiring the old Python bot and revoking its credentials |

## Reference

| File | What it covers |
| :--- | :--- |
| [slash-commands.md](reference/slash-commands.md) | The slash commands named in these docs, with who can use them |
| [data-note.md](reference/data-note.md) | Where the messages the bots see are sent, and which account and terms apply |
| [security-notes.md](reference/security-notes.md) | A summary of the main security rules, with a link to where each one is explained |

## Existing folders and files

These were already in `docs/` and are not moved.

| Path | What it covers |
| :--- | :--- |
| [security/](security/) | Security gate reports (Gate 1 and Gate 2), one per feature, dated |
| [plans/](plans/) | Implementation plans and roadmaps |
| [superpowers/](superpowers/) | Design specs (`specs/`) for each feature |
| [self-code.md](self-code.md) | Owner guide for the self-code (dev jobs) feature |
| [sheets-webapp.gs](sheets-webapp.gs) | The Google Apps Script web app that receives receipt rows |
