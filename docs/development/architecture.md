---
title: "Architecture — AI Team on Discord (Phase 1)"
doc_id: "DOC-ARCH-001"
version: 1.1.0
status: "Draft"
last_updated: 2026-11-24
author: Document Writer Agent
referenced_plan: "docs/plans/2026-11-23-phase1-plan.md"
---

# Architecture — AI Team on Discord (Phase 1)

## Contents

- 1. Summary — L29
- 2. Delivery in two slices — L40
- 3. Components and flow — L53
- 4. Interfaces — L96
- 5. Security posture (summary) — L109
- 6. Phase 2 and out of scope — L126
- 7. Open items — L131
- 8. Decisions — L140
- 9. Growth module (v0.3.0) — L155
- 10. Folder map — L211
- 11. Related documents — L230

> Status (2026-11-24, v0.2.0 release candidate): Slice A is built on the owner pivot (spec §11): one **SQLite** file at `DATABASE_PATH`, **native systemd** units on a Hostinger VPS, **no Docker, no Compose, no Postgres**. Slice B (Discord clients, reply gate, approvals routing, System log bot, `core/__main__.py`) is built in code; it is not enabled on the VPS until B1-ENABLE. Growth (v0.3.0, section 9) is built in code, with Gate 1 conditional approval. Section 10 lists what exists.

## 1. Summary

A team of AI agents that live in a company Discord server. Staff can watch them and talk to them. Agents can brainstorm with each other, call tools, and keep knowledge as index-first markdown. Phase 1 is built fresh in Python. Only the prompts carry over from the old bot. The team has 20 personas (`prompts/`, including the assistant Praw).

Authoritative sources:
- Scope and requirements: `docs/prd/2026-11-23-ai-team-prd.md`
- Current stack, deploy and data (overrides earlier spec sections where they differ): `docs/specs/2026-11-23-phase1-spec-s11-sqlite-vps.md`
- Build contracts and Gate 1 addendum (its SQLite and Docker parts are superseded by §11): `docs/specs/2026-11-23-phase1-spec.md` §10
- Security verdicts: `docs/security/2026-11-23-gate1-s11.md` (spec §11), `docs/security/2026-11-23-gate1-phase1.md` (Slice A), `docs/security/2026-11-23-gate2-sliceA.md` (Slice A, rejected on supply chain only)
- Task plan: `docs/plans/2026-11-23-phase1-plan.md`

## 2. Delivery in two slices

Phase 1 is delivered in two slices. The owner first deferred Discord until the owner's Discord setup was ready; the Discord code is now built and waits for the owner's live test.

| Slice | Scope | How it is verified | Status |
| :--- | :--- | :--- | :--- |
| **A — core-first** | Config, SQLite layer, migrations, backup and restore, engine, tools, knowledge, approvals, budget, jobs, tasks, personas, and the local CLI harness | Local CLI harness `python -m core.cli` and script mode; acceptance harness `tests/acceptance/run.sh` (re-run on SQLite, see `docs/test-reports/phase1-sliceA.md`); VPS re-run pending | Built on SQLite |
| **B — Discord** | Discord adapters: one client per persona (`core/discord/`), reply gate (`core/gate/`), slash commands `/task`, `/approval`, `/setting`, buttons, embeds, approval cards and routing, System log bot (`core/discord/syslog.py`), pull-user (`core/pulluser/`), voice (`core/voice/`, off unless `VOICE_ENABLED=true`) | Acceptance run in a test Discord server (TASK-021B); B1-SMOKE and B1-ENABLE wait for owner tasks OWN-B-01..07 | Built in code (B1 at commit 927c745, later changes in the v0.2.0 candidate); not live on the VPS |

Rules:
- Slice A never depends on Slice B. Slice B may depend on Slice A.
- The CLI uses the same interfaces (`ReplySink`, `SinkFactory`, `ApprovalPresenter`, `ApprovalService`, `JobRunner`, `AgentEngine`) and the same engine path that the Discord layer will use later. This is how Slice A checks the contracts that Slice B will implement.

## 3. Components and flow

```mermaid
flowchart TD
    subgraph SliceA["Slice A: core and CLI (built)"]
        CLI["core/cli (python -m core.cli)"]
        INIT["init_core (core/extensions.py)"]
        ENG["Agent engine (AgentEngine interface)"]
        KNOW["Knowledge store (KNOWLEDGE_DIR, markdown files)"]
        APPR["ApprovalService"]
        BUD["BudgetGuard"]
        JOBS["Job runner (subprocess worker)"]
        DB[("SQLite file (DATABASE_PATH)")]
        BKP["Backup and restore (core/db/backup.py)"]
    end
    subgraph SliceB["Slice B: Discord (built, not live on VPS)"]
        DISC["Persona clients (core/discord, py-cord, one app per persona)"]
        GATE["Reply gate (core/gate)"]
        LOG["JSON log (app.jsonl)"]
        SYS["System log bot (core/discord/syslog.py)"]
    end
    CLI --> INIT
    DISC --> INIT
    DISC --> GATE
    DISC --> APPR
    LOG --> SYS
    SYS --> DISC
    GATE --> ENG
    CLI --> ENG
    ENG --> KNOW
    ENG --> APPR
    ENG --> BUD
    ENG --> JOBS
    APPR --> DB
    BUD --> DB
    JOBS --> DB
    BKP --> DB
```

- `init_core` is the shared wiring path for the CLI and for Discord (spec §10.0, §10.1).
- `core/core.py` is empty today. In the target design it holds only wiring. Features register in `AppContext` through extensions (spec §3.0).
- Nothing under `core/` outside `core/cli/` imports `core.cli` (spec §10.15, §10.17 RC-1).

## 4. Interfaces

The contracts are defined in spec §10.1 (replacements for §5.1) and §5.2 to §5.6. This chapter does not copy them. Key points:
- `Actor(kind, user_id, display_name)` is built by the surface. Authorisation is decided only by `ApproverPolicy`. Decision outcomes are fixed strings (`approved`, `rejected`, `not_approver`, `already_decided`, `expired`, `not_found`).
- `AgentRequest` and `ToolContext` carry `origin` (`discord` or `cli`) and `human_actor`.
- Stable error codes are listed in spec §5.6 and §10.14. Startup refusals are listed in spec §10.14.
- CLI identities: `CLI_HUMAN_IDS` lives in `core/interfaces.py` (spec §10.17 RC-1). It is not in `core/cli/identity.py`.
- Knowledge: index-first markdown under `KNOWLEDGE_DIR`. Agents write only to `memory` and `notes`; `rules` and `meetings` are read-only to agents. Format and rules: `docs/development/knowledge-format.md`.
- Database: `core/db/sqlite.py` gives the `Database` API. Schema and migrations are in `core/migration/` (see section 9).
- Discord reply streaming: `STREAM_MODE` (`typing` by default, or `edit`) is read in `core/config.py`; the sink is in `core/discord/sinks.py`. `typing` renews the typing indicator every 8 s and then sends one final message. `edit` posts a placeholder and edits it live.
- Gemini: a tool call's `thought_signature` (`core/interfaces.py`) is echoed back on the next turn; the API returns 400 without it. Google HTTP deadlines are clamped to at least 10 s because the API rejects shorter ones; the adapter enforces the shorter local timeout itself (`core/provider/google/adapter.py`).
- Anthropic: `ANTHROPIC_API_KEY` must be a workspace-scoped key (`sk-ant-api03-...`). A key not scoped to a workspace is rejected with "must include the anthropic-workspace-id header". Setup note: [setup.md](../helper/setup.md#2-secrets-environment-only).

## 5. Security posture (summary)

Full controls and conditions: spec §6, §10 and §11; the Gate reports listed in section 1.

- **Secrets:** environment only. On the VPS they come from the root-only env file `/etc/employee/employee.env` (0600), loaded by systemd `EnvironmentFile`. Never sent to models, logs or chat. `mask_secrets` applies to logs (per field plus a fail-closed line check) and to all outbound text. Config refuses secrets shorter than 12 characters (spec §10.3).
- **Untrusted text:** Discord text, knowledge files, tool results and display names are untrusted and are wrapped before a model sees them (spec §6.2, §10.5).
- **Approvals routing (TASK-031, `docs/specs/2026-11-24-approvals-routing-spec.md`):** a department-level request is decided by that department's AI head in the department approvals channel. A request at or above `approval.hq_threshold_thb` (default 10,000 THB), and any request the classifier cannot route, goes to HQ. HQ items are decided by humans with the `AI-Admin` role, who can also override an AI decision. The classifier fails closed to HQ. Codes look like `DEV-0001` (tasks) and `APR-FIN-0007` (approvals). In dev mode the `admin` CLI identity is the approver. A handler acts only on the database row returned by `decide()` (spec §10.13.8).
- **Runtime settings:** `/setting view|set|reset` runs only in `SETTINGS_CHANNEL_ID`, for approver-role humans. Every change is audited and logged. Keys: [setup.md §4.1](../helper/setup.md#41-runtime-settings-task-031).
- **Config changes:** only through human-confirmed slash commands or CLI approver commands.
- **Subprocess isolation (spec §10.6):** heavy or untrusted work runs in a subprocess with an env allowlist and no bot token or DB path.
  - Same-uid limit (spec §10.17 RC-4): a same-uid worker can read `.env.local` (by absolute path), `KNOWLEDGE_DIR` and `LOG_DIR`. The phase-1 job runner uses a same-uid worker (option b).
  - A dedicated uid (option a) is mandatory for any job kind that decodes user-supplied containers, codecs or attachments, fetches URLs, or runs third-party or agent-chosen code. This includes the phase-2 launcher and job-spawning approval handlers.
- **Database access:** the runtime connection sets an authorizer (`_authorizer` in `core/db/sqlite.py`) that denies dangerous actions and all PRAGMAs except `wal_checkpoint`.
- **Process hardening (native systemd, `deploy/employee.service`):** dedicated `employee` user; `ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp=yes`, `NoNewPrivileges=yes`, empty `CapabilityBoundingSet`, `SystemCallFilter=@system-service` with `~@privileged`, `UMask=0077`, `MemoryMax=1G`, `CPUQuota=60%`, `TasksMax=100`, `Nice=5` (shared-host values in the unit; dedicated-host values are in [setup.md §8](../helper/setup.md#8-native-vps-deploy-spec-1111-1118)). Writable paths are only `/var/lib/employee`, `/var/log/employee` and `/run/employee`. `ExecStartPre` refuses an env file that sets `EMP_CLI_DEV`, `DATABASE_PATH`, `KNOWLEDGE_DIR`, `LOG_DIR` or `VOICE_TMP_DIR`.
- **Voice consent and restore:** voice consent is opt-out. A restore of an unreadable DB needs `--allow-optout-gap`, which writes a `consent_gap` marker in the DB directory. Voice stays off while the marker exists (spec §11.8). Details: `docs/specs/2026-11-23-phase1-spec-s11-sqlite-vps.md` §11.
- **CLI dev mode (TASK-025):** runs only when `EMP_CLI_DEV=1` is in the process environment and no Discord token (`DISCORD_BOT_TOKEN` or any `DISCORD_BOT_TOKEN_<ID>`) is set. Otherwise the CLI exits 2 (spec §10.7.6, §10.15).

## 6. Phase 2 and out of scope

- Phase 2 (planned): agents build tools, MCP servers, plugins and skills; the Agent SDK worker and Docker sandbox arrive here. Phase 1 ships no MCP (PRD §7). Phase 2 is the only place where a container sandbox is planned.
- Phase 1 acceptance does not include phase-2 items (PRD §8).

## 7. Open items

- Slice B: `deploy/employee.service` runs `python -m core` (`core/__main__.py` exists). The VPS service is enabled only at B1-ENABLE.
- Slice B: the ffmpeg carve-out in spec §10.6.4 must be resolved by the sa role before TASK-016 (spec §10.17).
- Slice B: Discord setup readiness is the owner's decision (plan, Slice B).
- Growth (v0.3.x): Security Gate 2 passed after re-check (`docs/security/2026-11-24-gate2-task033.md`); open follow-ups are residual G1 prefixed keyword forms (accepted risk) and VPS deploy (final phase).
- Off-host backup: none in Slice A (spec §11 OQ-3). Local backups do not survive loss of the disk.
- Spec §7 defaults (defaults stated for owner awareness, changeable without schema change): late-joiner DM failure is never captured; an agent can start recording only when the requester is in that voice channel; budget is per agent; a plain human message in an open task thread is treated as addressed to the assignee; spoken commands are not in phase 1.

## 8. Decisions

| Decision | Choice | Source |
| :--- | :--- | :--- |
| Agent engine | C — hybrid: own loop for chat and brainstorm, Claude Agent SDK worker for heavy work (phase 2) | PRD §5.1 |
| Discord identity | One Discord application per persona (20 personas), plus one optional System log bot; no webhooks. Supersedes the one-bot-plus-webhooks choice | Spec §12.10, §12.14 (supersedes PRD §5.2) |
| Hosting | Hostinger VPS with native systemd units in `deploy/`; no Docker (owner pivot; supersedes PRD §7 Docker Compose) | Spec §11 |
| Database | One SQLite file at `DATABASE_PATH` with numbered-SQL migrations (owner pivot; supersedes PRD §7 PostgreSQL) | Spec §11 |
| Old bot code | Not reused; build fresh | PRD §7 |
| Phase 1 MCP | None; built-in tools only | PRD §7 |
| Voice consent | Opt-out, notice embed plus DM for late joiners | PRD §6.9 |
| Growth learning | Reviewed lessons go into a versioned secondary overlay, rendered at run time. The AI never edits `prompts/**` | Growth spec §0, §1, §9 |
| Growth staffing | Hired personas are `personas_runtime` rows that speak via Praw until their own token is set; fired is a soft disable | Growth spec §0 OQ-1, OQ-2, §F |
| Growth cost | `growth.lessons_per_day` is seeded at 3 (not 6); 0 turns learning off | Growth spec §0 OQ-4 |

## 9. Growth module (v0.3.0)

Source: `docs/specs/2026-11-24-growth-spec.md` (requirements R1-R28, owner calls in §0, Gate 1 conditions G033-01 to G033-12 in §9). Gate 1 verdict: `docs/security/2026-11-24-gate1-task033.md` (CONDITIONAL_APPROVE). Gate 2 verdict: `docs/security/2026-11-24-gate2-task033.md` (PASS after re-check). Package `core/growth/` (`ext.py` wiring, `lessons.py`, `overlays.py`, `personas.py`, `g1.py` fixed routing rules, `__init__.py` with `OVERLAY_HARD_MAX_CHARS = 13300`). Slash commands: `core/discord/growth_commands.py`.

### 9.1 Lesson flow
- A task that ends `done` or `failed` starts a fire-and-forget lesson proposal. It never raises into `TaskService.update`.
- The assignee proposes with its cheap model, using `prompts/_system/lesson-propose.md`. The cap is `growth.lessons_per_day` per persona per day. The count is repeated inside the insert transaction (G033-07).
- A lesson is a `lessons` row with code `LSN-<DEPT>-<nnnn>`, scope `persona` or `dept`, one of nine categories, and a body of 20 to 400 characters on one line. It starts `pending` and is linked to an approval request (`approvals.request`, reason "Learned guidance proposal").
- `g1.py` routes by fixed rules, not by AI. Categories `permissions`, `money`, `policy` and `safety` go to HQ. Control and format characters are stripped first. Text with letters outside ASCII and Thai goes to HQ. `<`, `>`, URLs, mentions and runs of 15 or more digits are refused (G033-02, G033-03).
- Approve sets `approved` and adds the lesson to its scope's overlay. Reject, or a later change from approved, removes it. Each change writes a new `overlay_versions` row.

### 9.2 Overlay and prompt order
- `overlay_versions` keeps history. The body is capped at 6500 characters by CHECK. `overlay_active` points at the active version per scope (`0` = empty).
- The prompt is always rendered from the active version's `lesson_ids`, filtered to approved lessons (G033-01). A rollback cannot bring back rejected or deleted lessons.
- The block is the department overlay first, then the persona overlay, wrapped as `<untrusted source="overlay">`. The size follows `growth.overlay_max_chars`.
- The overlay is skipped for the `approval_review` trigger. Any error gives an empty overlay and logs `growth.overlay_failed`.
- Over the hard cap of 13300 characters the overlay is dropped, never sliced (G033-04). If the masked result differs from the text, it is dropped too.

```mermaid
flowchart TD
    A["wrapper.md, with the overlay pointer line"] --> B["persona body"]
    B --> C["fragments"]
    C --> D["Runtime: roster, time, channel"]
    D --> E["system_extra"]
    E --> F{"secret mask unchanged?"}
    F -->|no| X["PromptError prompt_contains_secret"]
    F -->|yes| G{"overlay present and at most 13300 chars?"}
    G -->|no| H["prompt without overlay"]
    G -->|yes| I["append department overlay, then persona overlay"]
    I --> J{"masked result unchanged?"}
    J -->|no| H
    J -->|yes| K["final system prompt"]
```

The mermaid above matches `build_system` in `core/agents/prompt_builder.py` and the overlay call in `core/agents/engine.py`.

### 9.3 Settings and departments
- Settings (in `core/settings/service.py`): `growth.lessons_per_day` 0..50, seed 3; `growth.overlay_max_chars` 500..6000, seed 3000. Both change through `/setting`.
- Runtime departments live in the `departments` table. At startup `load_departments` calls `register_dept` for each row. That mutates `DEPT_CODES`, `DEPT_SLUGS` (now a list) and `KEYS` in place, so modules that already imported them see the change.
- `/dept add` does not create a knowledge area (OQ-3), Discord channels or Discord apps.

### 9.4 Runtime personas and startup
- `RuntimePersonaRegistry` (`core/growth/personas.py`) wraps the file registry. `reload()` swaps the internal maps, so `ctx.personas` keeps its identity. `get`, `all` and `by_name` return active personas only. `known_ids()` includes fired ones.
- Hired personas are `personas_runtime` rows built from `prompts/_system/hired-persona.md`. Details are in [persona-format.md](persona-format.md#6-runtime-personas-and-the-overlay-pointer-growth-v03).
- Startup order (R23): the file registry loads, and token suffixes that match no file persona are deferred. The database opens, departments load, and the runtime registry loads. Each deferred suffix must match a known hired id, or startup refuses with `unknown_persona_token:<SUF>`. A fired id is skipped and logged as `persona.token_fired`.
- A hired persona without a token speaks through Praw. See [discord-apps.md](../helper/discord-apps.md#hired-personas-growth-v03).
- Heads: `/move … head:true` needs a Discord client (R24). `/fire` resets the department head setting to `none` if the persona was head.

### 9.5 Commands and audit
- Commands (settings channel, fresh approver check, ephemeral replies, logs carry ids and fixed tokens only, G033-11): `/lesson list|show|delete`, `/overlay history|rollback`, `/hire`, `/fire`, `/move`, `/dept add`. Arguments are in the commands table of [README.md](../../README.md). The growth commands are in `core/discord/growth_commands.py`.
- Every change writes an audit row. Reasons and free text are masked before they are written (G033-11).

### 9.6 Migration 0004
- `core/migration/versions/0004_growth.sql` (`growth`) creates `lessons`, `overlay_versions`, `overlay_active`, `departments` and `personas_runtime`. It rebuilds `audit_log` and `code_counters` to widen their CHECK lists. `personas_runtime` rejects reserved ids by CHECK (G033-12).
- It runs at the next start, after the service is stopped (see [setup.md](../helper/setup.md#41-runtime-settings-task-031)).

## 10. Folder map

| Folder | Status |
| :--- | :--- |
| `core/config.py`, `core/interfaces.py`, `core/extensions.py` | exist. `core/core.py` exists and is empty |
| `core/db/` | exists: `sqlite.py` (connection, path checks, authorizer, `Database` API) and `backup.py` (backup and `restore` CLI) |
| `core/migration/` | exists: `runner.py`, `__main__.py` (`python -m core.migration`), `versions/0001_phase1.sql` (schema 0001), `0002_approvals_routing.sql`, `0003_audit_decide.sql`, `0004_growth.sql`, `retention.py`, `retention_main.py`, tests |
| `core/growth/` | exists (v0.3.0): `ext.py`, `lessons.py`, `overlays.py`, `personas.py`, `g1.py`, `__init__.py`. Section 9 |
| `core/cli/` | exists: `python -m core.cli` (harness, script mode) |
| `core/functions/logs/` | exists: `logsystem.py` (JSON logger, `install_logging`) and `masking.py` |
| `core/agents/`, `core/provider/`, `core/agent_tools/` | exist: persona loader, providers, built-in tools |
| `core/knowledge/`, `core/jobs/`, `core/budget/`, `core/tasks/`, `core/approvals/` | exist (Slice A; `core/approvals/` also holds the TASK-031 routing: `router.py`, `service.py`, `depts.py`, `cards.py`) |
| `core/__main__.py`, `core/gate/`, `core/discord/` (persona clients, approval cards, `syslog.py` System log bot), `core/voice/`, `core/pulluser/` | exist (Slice B). Voice stays off unless `VOICE_ENABLED=true` |
| `deploy/` | exists: `install.sh`, `employee.service`, `employee-backup.service` and `.timer` (03:30 Asia/Bangkok), `logrotate-employee`, `grype.sha256`; `user/` holds the weekly `employee-audit` service and timer |
| `constraints/`, `pyproject.toml` | exist: `requirements.lock` (runtime) and `dev.lock` (dev and test) |
| `prompts/` | exists: 20 persona files in department folders, plus `_fragments/` and `_system/` |
| `knowledge/` | exists: 14 department areas plus `memory`, `notes`, `drafts`, `rules`, `meetings` and `_template/`, mostly empty. On the VPS `install.sh` seeds `/var/lib/employee/knowledge` from it |
| `docs/` | exists; PRD, plan, specs, security reports, test reports, spike and index |

## 11. Related documents

- Setup, env names and VPS deploy: `docs/helper/setup.md`
- Knowledge store format: `docs/development/knowledge-format.md`
- Persona file format: `docs/development/persona-format.md`
- Current stack and data rules: `docs/specs/2026-11-23-phase1-spec-s11-sqlite-vps.md`
- Growth (v0.3.0) spec and design: `docs/specs/2026-11-24-growth-spec.md`, `docs/specs/2026-11-24-growth-design.md`
- Discord rollout (one app per persona, System bot): `docs/specs/2026-11-23-phase1-spec-s12-discord-rollout.md` §12.10, §12.14
- Approvals routing: `docs/specs/2026-11-24-approvals-routing-spec.md`
