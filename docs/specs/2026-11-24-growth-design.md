# Growth: learning from work + company expansion — design (owner-approved 2026-11-24, target v0.3.0)

## Intent
The owner wants the AI team to get better from the work it does, and the company to grow (new staff, new departments) without code changes. Start after v0.2.0 is tagged and released.

## Owner decisions
- G1 Lessons are reviewed before use: work-method lessons → the department's AI head approves (department approvals channel); lessons touching permissions, money or company rules → HQ, humans (AI-Admin) approve. Routing to HQ is decided by fixed rules (keywords + category), never by the AI's own choice.
- G2 **AI never edits a main prompt** (`prompts/<dept>/<Name>.md`). Learning lives in a **secondary (overlay) prompt** per persona and per department, which the main prompt points to. Overlays are versioned; the active pointer can be moved back to any earlier version (rollback).
- G3 Expansion is driven from `⚙️-setting` by AI-Admin: `/hire`, `/fire` (soft disable, history kept), `/move`, `/dept add`. A new persona works at once (hot reload); without its own Discord app it speaks through Praw with a name prefix, and switches to its own bot once a token is added.
- G4 Not in scope: AI editing its own main prompt, automatic promotion. Creating Discord apps and channels stays manual (owner or main thread via Chrome).

## Learning flow (proposal for sa)
1. After a task ends (done/failed), the assignee may propose ≤3 lessons (cheap model, optional).
2. Each lesson becomes a card with a code `LSN-<DEPT>-<NNNN>` and goes through the TASK-031 approvals routing (dept head vs HQ by G1 rules).
3. Approved lessons are appended to a new overlay version (`overlay` = generated secondary prompt, persona- or department-scoped); the pointer moves to it. The main prompt contains a fixed include/pointer line, never rewritten.
4. Overlay size is capped (token budget); oldest/low-value lessons are dropped from the active version but kept in history.
5. `/lesson list|show|delete <code>`, `/overlay history|rollback <persona|dept> <version>`; every change is audited (audit_log).
6. Overlay text is treated as data with guards: wrapped/marked as learned guidance, cannot grant permissions, cannot override safety/approval rules (prompt-builder ordering: main prompt and safety fragments win).

## Expansion flow (proposal for sa)
- `/hire name aliases role dept head model` → persona generated from a template into a runtime persona store (not the git-tracked main prompts), validated (reserved ids, unique names, dept exists), hot-loaded.
- `/dept add code name head approval_channel` → extends the department table (code stays 2–4 upper-case letters) and settings maps.
- `/fire` disables; `/move` changes dept/head.

## Constraints
- Reuse: approvals routing/codes/audit (TASK-031), settings (⚙️-setting), knowledge store, persona loader, System log bot.
- Security gate required (learning = persistent prompt influence; hire = new agents).

## Left to sa/backend
Overlay storage (DB vs files), include mechanism in the prompt builder, G1 keyword/category list, persona runtime store and hot reload, command shapes, caps, migration.
