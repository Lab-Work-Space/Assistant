# Self-knowledge and grow

How department notes, lessons and prompts improve themselves, and what a Bot Admin confirms.

## Self-updating knowledge (self-development part 2, Gate 1 K1-K18)

- What it is: department notes, lessons, a keyword-searchable knowledge base (`kb_docs`, versioned) and prompt/persona text improve themselves, and a Bot Admin confirms once at the end. Spec `docs/superpowers/specs/2026-11-02-self-knowledge-design.md` (parent repo); migration `015_knowledge` runs at boot (up/down are tested; old notes count as tainted, an old deleted prompt override becomes a tombstone).
- Automatic: when a head finishes its own task, one cheap-model "reflect" call (no tools, input = task title, status, result and final answer only, at most 1,500 input and 300 output tokens, charged to the task's budget) may add up to 3 notes of 400 characters. Notes from a tainted run are stored **unverified**, shown to the model as such, and a run that reads one becomes tainted. At most 200 notes per department (oldest unpinned roll off), 30 reflect notes per department per day.
- Proposals: heads and Praw call `knowledge_propose` (documents, note to lesson, pin, lesson edit/retire) or `prompt_propose` (their OWN head text or their own members only; never `system/*` or `fragments/*`; refused for a tainted run; the lint, a cheapest-model classifier and the size caps run first). A proposal only waits. Every Monday 09:00 (`schedule.timezone`, first workday of the week) each department head's notes are consolidated into at most 3 proposed documents; this job is always tainted, creates no task and posts nothing.
- Confirm: dashboard, **Knowledge** page. Read the full diff or text and every source; a tainted proposal first needs "I have read the sources", then "Make card" (your own single-use card), then Apply on the card. The same page shows documents with versions, notes, lessons and prompt versions, and starts a rollback (to an exact earlier version or the file default) or a purge (document and all versions). Stale cards are refused by compare-and-swap.
- Safety text (`system/safety`, `system/tool-use`, `fragments/approval-request`) can no longer be overridden: it is appended after the role text, followed by a fixed precedence line, and pinned by SHA-256 in `prompts/protected.ts`. Editing those files means updating the hash constant in the same commit (a test recomputes it); a mismatch stops the process at boot and refuses every run.
- Owner steps: none are required. Restart the app once to run the migration. Optional: watch the cost of the cheapest model (`pricing` keys decide which one is used) and the weekly review (cap 0.10 USD per ISO week).

Related: [Governance and approvals](governance-and-approvals.md), [Security notes](../reference/security-notes.md).

Back to the [documentation index](../_index.md).
