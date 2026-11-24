# Slice B wave B1 common brief

PROJECT: employee
PROJECT_ROOT: <PROJECT_ROOT>
TEAM_DIR: <TEAM_DIR>
STAGE: 5 Build (Slice B, wave B1 parallel tasks after TASK-008)

## Sources
- Plan: docs/plans/2026-11-23-phase1-plan.md — your task row and the **B1 file-scope table** are the contract. Edit only files your row owns; if you need a change elsewhere, stop and report it.
- Specs: docs/specs/2026-11-23-phase1-spec.md (§10 overrides earlier text), docs/specs/2026-11-23-phase1-spec-s12-discord-rollout.md (§12.7 and §12.10.1 conditions bind; §12.10.1 S1210-07 = no webhooks: persona without token is disabled and routed to Praw). Use each file's Contents block line numbers.
- Security: docs/security/2026-11-23-gate1-s12.md (incl. "§12.10 delta"), docs/security/2026-11-23-gate2-sliceA.md (G2-07).
- Code to build on (do not rewrite): core/discord/** (TASK-008: Gate/allowed_channel, Router with message binding, DiscordSinkFactory/for_target, embeds, DiscordApp with persona clients, persona_by_user_id), core/__main__.py, core/agents (AgentEngine.run), core/approvals, core/tasks, core/budget, core/knowledge.
- Extension points left by TASK-008: `ctx.discord_message_handler(app, message)` (009), `app.router.register(kind, handler)` + replace `DenyAllApproverPolicy` in `setup_discord` (013B), `ctx.threads` + `task` button handler (012B), `pull_user` currently returns `voice_not_available` (017 keeps that for voice, adds thread/DM).

## Shared rules
- Tests use fakes only (tests/discord_fakes.py); no network, no real tokens.
- Every outbound send goes through `for_target`/sinks (allowlist + AllowedMentions.none + masking). Every listener/handler you add must be behind the Gate (the gate-first test must keep passing).
- Run the FULL suite at the end and report the real line (baseline 304 passed): `.venv/bin/python -m pytest -q tests core/migration`.
- Do NOT read .env.local. Do not commit.
- Report: files, acceptance item → test, real output, deviations, gaps. Follow your Context Loading section and the token policy.
