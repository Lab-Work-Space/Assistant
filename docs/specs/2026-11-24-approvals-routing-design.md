# Approvals routing, work codes and channel settings — design (owner-approved 2026-11-24)

## Intent
The owner wants approvals split by level: each department approves its own routine work, and HQ approves big work. Every task and approval card must carry full details and a human-readable code so it can be referenced, edited or cancelled. Tunable values (thresholds, channel mapping) move out of `.env` into a settings system driven from the `⚙️-setting` Discord channel; `.env` keeps only fixed values and secrets.

## Owner decisions
- D1 Department-level approvals are decided by the department's AI head persona (e.g. มะลิ for account). HQ-level approvals are decided by humans holding the approver role (AI-Admin); มีรา may summarise and recommend but never decides.
- D2 A request goes to HQ when any of these hold: dangerous/irreversible kind (`destructive_cmd`, `config_change`, `artifact_enable`, `file_write_outside`, access grants); estimated value above the HQ threshold (default 10,000 THB); cross-department; the AI classifier rates it "major"; or the department head escalates it ("ส่งต่อ HQ").
- D3 Codes: tasks `<DEPT>-<NNNN>` (e.g. `FIN-0042`), approvals `APR-<DEPT>-<NNNN>` (e.g. `APR-FIN-0007`); HQ uses `HQ`. Counters are per department.
- D4 "Delete" = cancel (soft). Rows and history are kept; nothing is hard-deleted.
- D5 Settings: runtime-tunable values live in the DB and are changed in `⚙️-setting` (channel id 1565667791938387969) by approver-role humans only; `.env` keeps fixed values and secrets.

## Goals
- Per-department approval channels; HQ channel for big work.
- Full card fields: code, title, details, department, requester, assignee, priority, due date, estimated value (THB), status, level (dept/HQ), reason approval is needed.
- Commands: `/task show|edit|cancel <code>`, `/approval show <code>`; allowed for the requester, the department head and approver-role humans.
- Settings commands in `⚙️-setting`: view and change HQ threshold, department → approval channel map, department → head persona map, and similar tunables.

## Non-goals / anti-goals
- An AI must never approve its own request, and chat text must never be able to make an AI approve (decisions go through the system, not free text).
- No hard delete. No approval by persona for HQ-level items. No change to the reply gate.

## Guardrails for AI approvers (main-thread proposal, owner did not object)
- Department AI head may decide only department-level, non-dangerous kinds under the threshold, for its own department.
- Requester ≠ decider; every AI decision is logged with reason and shown on the card; approver-role humans can decide or override any department item.
- The AI decision is a structured tool call validated by the service (level, department, kind, value), never parsed from model prose.

## Known Discord facts
- Department approval channels: HR 1567005110243033228, Finance 1567005451516772513, Marketing 1567005741003313212, Sales 1567005947287568474, Operations 1567006095526858884, R&D 1567005024146554960, Software House 1567004690351128676; HQ 1567004873944211567 (current `APPROVAL_CHANNEL_ID`). IT, Legal, Procurement, Support, Data, Design, Product and Dev have no dedicated channel yet — the map must allow pointing a department at an existing channel or HQ.
- Personas carry `dept` in frontmatter (`prompts/*/*.md`). Dev members (bank, fon, qew, dew, anan) report to the Tech Lead (tek).
- AI heads currently cannot see department approval channels except via category allows; Discord-side access will be added by the main thread.

## Approaches considered
- A (chosen): extend the existing approvals service with `level`, `dept`, codes and a router; add a settings table + `⚙️-setting` commands. Reuses ApprovalService.decide, presenters and buttons.
- B: separate approval services per department — rejected, duplicates logic and audit.
- C: keep one channel and only tag departments — rejected, does not meet "each department has its own approvals".

## Left to the builder (sa/backend)
Schema/migration shape, code allocation (atomic per-dept counter), dept→head resolution, classifier prompt, slash command shapes, settings key list and validation, embed layout.
