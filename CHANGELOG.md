# Changelog

All notable changes. Versions are git tags; full release notes are on the GitHub Releases page of the repository.

## Contents
- [0.4.0](#040) — company tools via MCP (Phase 2A)
- [0.3.2](#032) — real model prices, tier2 failure test
- [0.3.1](#031) — growth hardening
- [0.3.0](#030) — growth system
- [0.2.0](#020) — AI team on Discord
- [0.1.0](#010) — core engine

## 0.4.0
- **Company tools (Phase 2A).** Agents can reach ClickUp, GitHub, Google Calendar, Drive, Docs and Sheets (no Gmail), and Hostinger (VPS only), through pinned MCP servers behind one policy gateway. Praw has every service. Department heads have their own department's services and write only inside their scopes. Irreversible actions need an approval card for humans at HQ.
- **Gateway rules.** Tools default to blocked. Unknown or changed tools are blocked until classified. `settings` and `payment` classes are always refused. Every non-read call and every refusal is audited with a hash of its args, and the results come back as untrusted text.
- **`/mcp status`** shows each service's state, tool counts, restarts and calls in 24 hours (approver role, settings channel).
- **New settings.** `mcp.enabled` is the kill switch (default `on`). `mcp.calls_per_min`, `mcp.writes_per_min` and `mcp.calls_per_day` set the rate limits.
- **Install.** `scripts/mcp-install.sh` installs the pinned servers and checks each download against its sha256 pin.
- **Migration 0005.** Adds the `mcp_irreversible` approval kind and the `mcp` audit scope.
- **Docs.** Owner setup in `docs/helper/setup.md` §10, MCP sections in `docs/helper/local-dev.md` and `docs/development/architecture.md` §10.
- **Status.**
  - Security Gate 1 and Gate 2 were both conditionally approved, and the Gate 2 code findings are fixed.
  - MCP ships **disabled in practice**: every tool hash is PENDING, so nothing can be called until the owner installs the servers, fills the hashes and adds tokens.
  - Enabling MCP on production also needs the hashed lock regenerated (G2T040-03).

## 0.3.2
- **Budget price table.** It now uses verified prices instead of placeholders:
  - Claude Opus 5.5: $4 / $20 per 1M tokens (input / output).
  - Claude Sonnet 5.5: $2 / $10.
  - Claude Haiku 5.5: $0.10 / $0.50.
  - Gemini 3.1 Flash-Lite: $0.25 / $1.50.
  - Gemini 3.8 Flash: $1.50 / $7.50. This is the list price from 2027-01-01; the 2026 promo is half that, so budgets never under-count.
  - Gemini image: $0.067 per 1K image.
- **New test.** The reply-gate tier2 now has a test for a provider error or timeout: the gate stays silent and logs `gate.tier2_failed`.
- **Docs.** The test report has a re-check addendum, and this changelog was added.

## 0.3.1
- **`/dept add` reports partial setup.** When the department row is created but the channel or head step fails afterwards, the command replies `dept_partial`.
- **More G1 keyword forms.** G1 routing now also matches irregular and prefixed keyword forms.
- **Log hardening.** A log field built from an exception code is now converted to text before it is cut to length.
- **Security.** The Gate 2 re-check passed.

## 0.3.0
- **Lessons.** When a task finishes, the persona proposes reviewed lessons, coded `LSN-<DEPT>-NNNN`. Fixed G1 rules route each lesson to the department head or to the humans at HQ.
- **Versioned overlays.** Approved lessons go into a versioned secondary prompt for each persona and each department. It is appended last as untrusted data, and it can be rolled back. Main prompts are never written.
- **Staff commands.** `/hire`, `/fire`, `/move` and `/dept add`. Personas live in a runtime store and are hot-reloaded.
- **Lesson and overlay commands.** `/lesson` and `/overlay`.
- **New settings.** `growth.lessons_per_day` and `growth.overlay_max_chars`.
- **Migration 0004.**
- **Fixes from live testing:**
  - Task threads open in the tasks channel when the assignee cannot see the origin channel.
  - Thread creation now works on py-cord 2.8.
  - Gemini returned empty answers; `complete()` now floors the output-token limit at 256.
  - The classifier and the reply-gate tier2 now use Flash-Lite.
  - The classifier's money rule now follows `value_thb`.
  - A deadlock in overlay rebuild is fixed.

## 0.2.0
- **Discord bots.** 20 persona bots, plus a System log bot that posts to `#bot-log`.
- **Approvals.**
  - Department and HQ approvals.
  - Task and approval codes.
  - Edit and soft-cancel.
  - Audit log.
- **Runtime settings.** Changed in the settings channel with `/setting`.
- **`/task` and `/approval` commands.**
- **Typing indicator** shown while a persona replies.

## 0.1.0
- **Core.** Engine, tools, knowledge store, budgets, job runner and CLI harness.
- **Storage and deploy.** SQLite, with a native systemd deploy.
