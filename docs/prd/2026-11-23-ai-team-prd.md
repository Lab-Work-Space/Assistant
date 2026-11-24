---
title: "AI Team on Discord — PRD (Phase 0)"
status: approved
date: 2026-11-23
---

# AI Team on Discord — PRD

## Contents

> Line numbers refreshed 2026-11-23; regenerate after edits.

- 1. Intent — L38
- 2. Goals — L52
- 3. Non-goals — L67
- 4. Anti-goals (failure even if it "works") — L74
- 5. Approaches (decided) — L83
  - 5.1 Agent engine — chosen: C (hybrid) — L85
  - 5.2 Discord identity — chosen: A (one bot + webhooks) — L95
- 6. Requirements (phase 1 unless stated) — L104
  - 6.1 Discord layer — L106
  - 6.2 Agents and prompts — L113
  - 6.3 When to reply (read-all, answer-when-addressed) — L119
  - 6.4 Agent-to-agent brainstorming and delegation — L129
  - 6.5 Tools, MCP, plugins, skills — L135
  - 6.6 Subprocess model — L140
  - 6.6a Brainstorm triggers (my call) — L148
  - 6.7 Knowledge (index-first) — L152
  - 6.8 Image generation — L158
  - 6.9 Voice — L161
  - 6.10 Security — L171
  - 6.11 Cost control — L178
- 7. Constraints — L183
- 8. Phase 1 acceptance — L192
- 9. Left to the builder — L205
- 10. Open items — L209

## 1. Intent

Build a team of AI agents that live in the company Discord and help the human team get work done. The company's operations are not blocked today; the goal is to develop AI that assists the team. Agents brainstorm with each other, use tools (MCP, plugins, skills, CLI), keep knowledge in an index-first store, and — in later phases — build their own tools and read/write files and code.

Delivery is phased (decided by the owner):

| Phase | Scope |
| :--- | :--- |
| 0 | This PRD |
| 1 | Core system + prompts (Discord bot, agent engine, personas, reply rules, knowledge index, voice, image, DM) |
| 2 | Self-management: agents create tools, MCP servers, plugins and skills |
| 3 | File read/write and code writing |
| 4 | Other (backlog) |

## 2. Goals

1. Department agents (praw/assistant, account, hr, it, legal, marketing, sales) each with its own persona from `prompts/<dept>/*.md`.
   - Amended 2026-11-23 (owner): the company is a software company; the team focuses on the management of every department plus a Dev team. Added: one top-level executive (exec), department heads for product, operations, support, procurement, and a Dev team (Tech Lead + Backend, Frontend, QA, DevOps). IT refocuses on internal IT support. Dev members discuss/plan/review in phase 1; code writing arrives in phase 3.
2. Agents talk to each other to brainstorm and delegate; humans can watch.
3. Streamed chat replies in Discord (message edited progressively as tokens arrive).
4. Discord embeds for requests: open a task, approval requests, status/reports, with buttons.
5. Knowledge stored as index files: agents read `_index.md` first, then open only the specific entry.
6. Image generation.
7. Speech: text-to-speech replies, join voice channels, transcribe, take meeting notes into knowledge.
8. Pull a person into a conversation (voice move, thread/private channel, or DM).
9. Read every message, reply only when addressed (rules in §6.3).
10. Subprocess support: long or risky work runs in separate OS processes (§6.6).
11. Later phases: agents build tools/MCP/plugins/skills for themselves (phase 2) and edit files/code (phase 3).

## 3. Non-goals

- Not a replacement for ClickUp/GitHub; agents integrate with them via MCP.
- No public/multi-tenant product; one company server.
- No per-department separate Discord bot accounts (see §5).
- No vector database / RAG in phase 1 — knowledge is index-first markdown.

## 4. Anti-goals (failure even if it "works")

- Bot replies to messages not addressed to it (spam).
- An agent runs code, writes files or enables a self-built tool without human approval.
- Secrets in `.env.local` leak to chat, logs, or third-party services.
- Recording voice without participants being told.
- An agent claims a tool succeeded when it did not (persona rule in `prompts/assistant/Praw.md`).
- Uncontrolled API spend (e.g. every message sent to an LLM).

## 5. Approaches (decided)

### 5.1 Agent engine — chosen: C (hybrid)

| Option | Trade-off |
| :--- | :--- |
| A. Own agent loop for everything | Any provider; phases 2–3 (skills, plugins, file/code editing) all hand-written — large. |
| B. Claude Agent SDK for everything | Phases 2–3 nearly free; every agent locked to Claude; conflicts with Praw's Gemini model. |
| **C. Hybrid** | **Own lightweight loop for chat/brainstorm (any provider, cheap models for chatty agents). Heavy work (code, files, building tools/MCP) is handed to a "worker" running Claude Agent SDK.** |

Why C: keeps multi-provider chat (folders `core/provider/{anthropic,google,local}` already exist), and avoids hand-writing phase 2–3 capabilities.

### 5.2 Discord identity — chosen: A (one bot + webhooks)

| Option | Trade-off |
| :--- | :--- |
| **A. One bot account + webhook personas** | **One token, one process; each agent posts with own name/avatar. Webhook personas cannot be @mentioned — name detection covers it (§6.3).** |
| B. One bot account per department | Real @mentions/presence; 7–8 tokens and processes, harder inter-agent routing. |

The main bot account handles voice, DMs, moves, and slash commands.

## 6. Requirements (phase 1 unless stated)

### 6.1 Discord layer
- Library: **py-cord** (Python, matches existing code; supports voice receive via sinks).
- Privileged intents: Message Content, Server Members, Voice States.
- Streaming: post a placeholder, edit it every ~1 s (respect rate limits) until done; split at 2000 chars without breaking code fences.
- Embeds with buttons for: task open, approval request (approve/reject), status report, recording notice.
- DM support: users can DM the bot; agents can DM users (task assignment, approvals, invites).

### 6.2 Agents and prompts
- One persona file per agent in `prompts/<dept>/<Name>.md` with frontmatter (`name, role, dept, model, effort, tools, traits, color, fragments`), as in `Praw.md`.
- Shared prompt fragments (`delegation`, `asking`, `approval-request`, `report-format`) referenced by `fragments:` — stored in `prompts/_fragments/` (my call).
- Praw is the front door: chats with humans and routes work to department heads via tasks.
- Agents reply through a `respond` tool (`type: chat | embed`), per `Praw.md`.

### 6.3 When to reply (read-all, answer-when-addressed)
Bot reads every message in channels it can see. It replies only if one holds:
1. The bot/agent is @mentioned, or the message replies to an agent's message.
2. Active conversation: same user, same channel, last agent reply to them < 5 minutes ago.
3. Called by name without @ (e.g. "พราวว่าไง"):
   - Tier 1 (free): match agent names/aliases from persona frontmatter.
   - Tier 2 (only if Tier 1 hits but is ambiguous): a cheap model classifies "is this addressed to the agent?" using the last few messages.
- DMs: always reply.
- Never send every message to an LLM. Unaddressed messages may be logged for context only.

### 6.4 Agent-to-agent brainstorming and delegation
- Agents talk in Discord threads (visible to humans), posting via webhooks.
- A brainstorm/task thread has: an owner agent, participants, a turn limit (default 10 turns) and a token budget, after which the owner summarises and stops.
- Delegation creates a task record (DB) and a task embed; the assignee agent picks it up.
- Loop guard: an agent never replies to itself; agent-to-agent replies only inside a thread with an open task/brainstorm.

### 6.5 Tools, MCP, plugins, skills
- Tool registry: built-in tools (respond, knowledge read/search/write, image, tts, task, pull-user) in phase 1. Phase 2 adds MCP servers configured in `mcp/<name>/` (clickup, discord, github, google, hostinger first) using the official `mcp` Python SDK.
- Per-agent tool allowlist from persona `tools:`.
- Phase 2: worker (Claude Agent SDK) writes new tools/MCP servers/skills/plugins into `tools/`, `mcp/`, `skills/`, `plugin/`. A new artifact is **disabled until a human approves it** via an approval embed showing what it does and what it accesses.

### 6.6 Subprocess model
- The Discord bot process never runs heavy or untrusted work in-process.
- Workers run as separate OS processes (job queue in DB; one subprocess per job), so a crash or hang does not kill the bot; timeouts and cancel supported.
- MCP servers run as stdio subprocesses.
- Shell/CLI commands (`tools/CMD`) run as subprocesses inside the sandbox (§6.10) with timeout, output cap, and approval rules.

- Phasing (my call): phase 1 ships only a simple DB-backed job runner that spawns subprocesses (timeout, cancel, crash isolation). The Claude Agent SDK worker and the Docker sandbox arrive in phase 2 (tool building) and are hardened in phase 3 (file/code).

### 6.6a Brainstorm triggers (my call)
- Started by a human (slash command or asking Praw) or by an agent itself.
- Agent-initiated brainstorms: max 10 open per day server-wide (raised from 3 by owner 2026-11-23; env BRAINSTORM_AGENT_DAILY_MAX), each under the turn limit and token budget in §6.4.

### 6.7 Knowledge (index-first)
- Layout: `knowledge/<area>/_index.md` + one file per entry; templates in `knowledge/_template/`.
- `_index.md` lines: `- [Title](file.md) — one-line hook | tags`.
- Agents always read the index, then open only the matched entries. Writes add the entry file and one index line.
- Areas: `memory/`, `rules/`, `meetings/` (voice notes), per-department areas as needed.

### 6.8 Image generation
- Via Google Gemini image model (`GOOGLE_API_TOKEN`); result posted as an attachment. Anthropic has no image generation.

### 6.9 Voice
- Bot joins a voice channel on request (slash command or agent action).
- Consent model (owner decided): opt-out. On join to record, it posts a recording notice embed with an opt-out button; opted-out users are not recorded (PDPA).
- Users who join after the notice get the notice by DM (with opt-out button) before their audio is captured.
- Raw audio is deleted right after transcription; only transcript + note are kept.
- Unaddressed text messages are held only in an in-memory recent-context buffer, never persisted.
- Per-user audio → speech-to-text (Thai + English) → transcript → summary note into `knowledge/meetings/`.
- Speaking: TTS of agent replies in voice.
- Pull user: if the user is in any voice channel, move them (Move Members permission). Otherwise create a thread or private channel and mention them, or DM an embed with a "join" button. Discord cannot force a user into voice who is not connected.

### 6.10 Security
- Secrets only from env; never passed to models, logs or chat; log masking.
- All Discord and tool text is untrusted data (prompt-injection defence).
- Sandbox for worker/shell subprocesses (amended 2026-11-23, no Docker): dedicated uid + OS-level sandbox (e.g. bubblewrap or systemd transient units) with only the workspace writable, no access to secrets, network allowlist. Details in spec §11.
- Approval required for: enabling a self-built tool/MCP/plugin/skill, file writes outside the workspace, destructive commands, config changes (Praw rule: config changes only via slash commands confirmed by the human).
- Approvers: a Discord role (default `AI-Admin`, my call).

### 6.11 Cost control
- Per-agent model choice; cheap models for chatty agents.
- Daily budget per agent/department; `/budget` slash command to view and set (referenced in `Praw.md`).
- Budget exhausted (my call): at 80% notify `AI-Admin`; at 100% fall back to the agent's cheap model; at 120% hard stop for that agent until reset or an admin raises it via `/budget`.

## 7. Constraints

- Python; existing skeleton `core/core.py` (`DiscordBot` stub) and `core/functions/logs/logsystem.py` (`Log` stub, ignores its `system` argument).
- Providers: Anthropic and Google keys exist in `.env.local`; `local` provider folder planned.
- Database (owner decided 2026-11-23): SQLite file (`DATABASE_PATH`), replacing the earlier PostgreSQL choice. Spec §11.
- Hosting (owner decided 2026-11-23, supersedes Docker Compose): native on the Hostinger VPS under systemd, dedicated service user, Python venv; ffmpeg from OS packages when voice lands. Development also moves to the VPS. Spec §11.
- Old bot code exists but is not reused (owner decided); build fresh, only the prompts carry over.
- MCP servers: none required in phase 1 (owner decided); phase 1 uses built-in tools only. MCP (clickup, discord, github, google, hostinger) moves to phase 2.

## 8. Phase 1 acceptance

1. Praw answers in a streamed message when @mentioned, replied to, called by name, or in an active conversation; stays silent otherwise.
2. Praw delegates a request to a department agent; the agent posts in a thread under its own name/avatar; a task embed appears.
3. Two agents brainstorm in a thread and stop at the turn limit with a summary.
4. An approval embed's buttons work and only `AI-Admin` can approve.
5. Knowledge: agent answers a question by reading `_index.md` then one entry (verified in logs), not the whole folder.
6. Image request returns an image.
7. Voice: bot joins, posts recording notice, produces a transcript + note in `knowledge/meetings/`, and speaks a TTS reply.
8. Pull-user works for both cases (in voice → moved; not in voice → thread/DM invite).
9. A crashing worker subprocess does not stop the bot.
10. No secret appears in logs or chat in any test.

## 9. Left to the builder

- Exact module layout under `core/`, ORM/migration tool, STT/TTS vendor (Google preferred, same key), job queue implementation, rate-limit tuning, embed visual design, which cheap model to use for Tier 2 classification.

## 10. Open items

- Department personas other than Praw are empty; content to be written in phase 1.
