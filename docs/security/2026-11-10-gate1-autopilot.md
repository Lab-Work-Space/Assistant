---
title: "Security Gate 1: AUTO-1 project autopilot (one confirmation per project)"
gate: 1
status: APPROVED WITH CONDITIONS
status_code: CONDITIONAL_APPROVE
date: 2026-11-10
task: AUTO-1
project: labworkspace (BOT/Assistant)
spec: docs/superpowers/specs/2026-11-10-autopilot-design.md
brief: SA handoff brief auto-sa-brief.md (Amendment SA-1; contradictions C1-C16 bind over the spec)
---

# Security Gate 1: AUTO-1

Verdict: **APPROVED WITH CONDITIONS**. Conditions AP-C1 to AP-C18 bind BE1-BE3, AI-PROMPT, the tester and Gate 2.

The owner asked for this autonomy, and the gate takes that as given: one Bot Admin click per project, then no per-call cards except hard-deny. This gate bounds the autonomy; it does not reopen it.

In this report, "Brief" means the SA brief, cited by its own section numbers. Code is cited by a content anchor; line numbers are hints only.

What the design gets right:
- The decision is made inline in the registry, after the allowlist, zod and the tool `precheck` (pins and ClickUp `cardShowsWhole` still run first).
- It applies only when `sameActor(ctx.task.owner, ctx.actor)` holds, and never on the approved path.
- Every error falls back to today's card. The claim and its audit row commit in one transaction, and halt is re-checked after the claim.
- The "in a project" fact is a DB join, never tool input. The project budget is never lifted (C12).
- Buttons carry 128-bit tokens on the stored card and are routed through `route()` (#setting, then a live Bot Admin).

## Code checked

- registry.ts `exec`: TG-C2 "Only a strict `false` can be waived", the TREEGRANT block, "I1: an actor running in someone else's task thread", and `onApprovalTask`.
- ai-approver.ts `precheck`: "info.kind === undefined) return 'hard_deny:unknown'", `isNonSensitiveTool`, `storedInputOk`, `COST_OR_LASTING_TOOLS`, `grantUrlCheck`, and the query heuristic.
- tree-grant-scope.ts `treeGrantRunOk`: "write_file: never in a tainted run (Praw's workspace is the site_publish_static source)" and "forward_to: only when the target audience is not wider".
- policy-approval.ts: `NO_APPROVAL_TOOLS` includes `ws_run`, and `approvalFor`.
- ws/index.ts `ws_run`: "requiresApproval: () => false, // named in NO_APPROVAL_TOOLS" and `E_NOTASK`.
- clickup/workspace-write.ts `base`: "requiresApproval: () => ({ reason: REASON })", `onApprovalTask` `filed`, `usage.take`, and `cardShowsWhole`.
- jira/write.ts `base` "requiresApproval: () => false".
- Every `requiresApproval` that can return non-false: webSearch, fetchPage, clickup workspace-write, docs (draft kinds), watch, media image/video, meetingStart.
- grow/tool-requests.ts `request` ("if (run.tainted || run.task?.tainted) return this.refuse(who, 'tainted')", `skillToolAllowed`).
- skill-grant.ts `skillToolAllowed` (rule G; excludes NO_APPROVAL and bot-talk; allows read and destructive kinds).
- budget.ts: `taskBudgetKey`, "TASK_DAY = '1970-01-01'", `localRefusal` "!lifted('limits.localCallsPerTask')", and the metered `limits.task`.
- tasks.ts `insert`: the parent `root_id` is read on the pool, outside any transaction, before the INSERT.
- context.ts: `runStartsTainted` (`OUTSIDE_ORIGINS`, `historyTaints`).
- loop.ts: "const personAdmin = personStarted && trigger.msg?.isAdmin === true".
- Taint laundering (global rule 9): every read-back of the new card-less writes taints the run, so a tainted write cannot unlock a later "untainted" check. The tools that read back are `forum_read` (`untrustedSource: 'forum'`), `read_file` (`'workspace'`), the Jira reads (`base` `untrustedOutput: true`) and the ClickUp reads (`'clickup'`). Bot posts in history taint through provenance (`repliedTaints`, `historyTaints`). `create_task` has no kind, so it never asked and is not part of this change.
The brief's C1-C9 and C13-C16 hold as stated. C11 is partly wrong (F-3).

## Findings

| ID | Sev | Evidence | Issue | Condition |
| :--- | :--- | :--- | :--- | :--- |
| F-1 | High | Brief 3.3 branch `if (approval && !approved && ctx.autopilot ...)`; registry.ts TG-C2 "Only a strict `false` can be waived" | The branch waives a tool's OWN approval reason, not only the central write rule. The only thing in its way is the hard-deny denylist, so any future tool with its own safety reason that `precheckCall` misses would auto-run. Today only web_search, fetch_page and the ClickUp workspace writes reach it (the others are caught as cost, input or unknown). Global rule 6 requires an allowlist. | AP-C1 |
| F-2 | Medium | tree-grant-scope.ts `treeGrantRunOk`; Brief 3.3 step 3 uses `precheckCall` only (which calls `storedInputOk`, not the run-time predicates) | Autopilot widens TREEGRANT to every write tool but drops TG-C4(b). A tainted run could `write_file` into Praw's workspace, which is the `site_publish_static` source. `forward_to` could reach a wider audience. C16 also removes the estimate card that tree-grant F-3 relied on. | AP-C2 |
| F-3 | Info | ws/index.ts `ws_run` "named in NO_APPROVAL_TOOLS" | C11's `ws_run` half is wrong: `ws_run` never asks today. The log's blocker was `E_NOTASK` in a chat run. C11 is also too narrow: Jira writes, forum_post, pin_message, doc_create (non-draft), write_file, and forward_to also become card-less in projects. | AP-C8, table below |
| F-4 | Medium | Brief 3.2a: "A tree in another project can never be adopted, because only roots qualify and a project tree's root is the project root" | The reasoning is wrong. A project root is itself a root (parent NULL, root_id = id). An idle root of another project passes every 3.2a code and would be re-parented. The old project would then still be `active` but would match no task (projectOf join), and its tree would move under the new budget. | AP-C4 |
| F-5 | Low | tasks.ts `insert` reads the parent `root_id` on the pool before the INSERT, with no lock | A child created while an adoption commits can keep the old `root_id` and `depth`. This fails safe (the child falls back to today's rules), but it breaks tree invariants that scheduler maps and budget keys rely on. | AP-C15 |
| F-6 | Low | Brief 3.1 projectOf; 3.2 deadline | The mandate never ends at its deadline. Only close or the root ending stops it. The deadline the Bot Admin approved is display only. | AP-C9 |

### What becomes card-less inside an active project (the owner's acceptance covers exactly this)

| Class | Tools today (main registry) | Bound kept |
| :--- | :--- | :--- |
| Tainted outside reads | web_search, fetch_page | url and query heuristics, then refusal; `grantUrlCheck`; hidden-character refusal |
| ClickUp workspace writes | clickup_create_task, clickup_update_task, clickup_update_status, clickup_assign_task, clickup_create_space, clickup_create_folder, clickup_create_list | `cardShowsWhole`, daily `usage.take` (fails closed), `filed` run cap via `onApprovalTask`, 1500-character cut refusal |
| Other writes, from runs that are not direct | jira_create_issue, jira_update_issue, jira_update_status, forum_post, pin_message, doc_create (non-draft), write_file (no overwrite; untainted per AP-C2), forward_to (audience not wider per AP-C2), music_* | existing per-tool caps (TG-C21 list) |
| Still a card | destructive (clickup_add_comment, clickup_delete_task, jira_add_comment, jira_delete_issue), SENSITIVE_TOOL, admin/mod, sheets_append_receipt, draft docs, overwrite, cost or long-lived, unknown | hard-deny, unchanged |
| Unchanged | ws_* (already card-less) | WS caps |

## Rulings on the SA gate items

- **C10 (GW-C16 weakened): ACCEPTED, bounded by AP-C7.**
  - A grant is project-scoped, gives no new config write, is capped at 10, and is made only from an untainted owner run of a task in an active project.
  - Name-level hard-deny tools still go to the card.
  - The grant dies with the project.
  - The project card's fixed text already tells the Bot Admin that tool requests are granted inside the project, so this is informed consent.
- **C11 (ClickUp writes without per-call approval in projects): ACCEPTED** with AP-C8, under the owner's mandate. The `ws_run` part grants nothing new (F-3); correct the brief.
- **C12 (project local cap ignores localUnlimited): ACCEPTED.** It tightens. Test it under AP-C6.

## Conditions

- **AP-C1 (own-answer allowlist, F-1).**
  - In the registry branch, if `own` is not the boolean `false`, autopilot may run the call only when `name` is in a frozen code list `AUTOPILOT_OWN_WAIVE`. The list holds `web_search`, `fetch_page` and the ClickUp workspace-write names, exported from workspace-write.ts and imported, never copied.
  - Any other non-false `own` falls through to today's card. The same applies to a throw, which the registry already turns into `own = true`.
  - Test: a golden table over `registry.names()` with the real plugin set asserts the `decide()` class (card, refuse or run) for every tool, with tainted and untainted contexts. A fixture tool with kind `write` and `requiresApproval: () => ({reason})` that is not on the list must give a card.
- **AP-C2 (TG-C4(b) carried over, F-2).**
  - Before `decide()`, the branch calls the imported `treeGrantRunOk(name, value, ctx)` for `write_file` and `forward_to`. False, or a throw, means a card.
  - The `forward_to` caps (2 per run, 4 per root) and every TG-C21 gate stay.
  - Tests:
    - a tainted `write_file` in a project gives a card;
    - `forward_to` to a wider audience gives a card;
    - `forward_to` to a narrower audience runs;
    - the third `forward_to` in one run is refused by its cap.
- **AP-C3 (the approved path stays untouched).**
  - `decide` is never called when `approved` is true.
  - The admin registry never receives `ctx.autopilot`.
  - Tests: a spy proves no `decide` call on the replay; an admin run carries no port.
- **AP-C4 (adoption, F-4).** Add two codes to 3.2a, checked in the transaction after the row locks:
  - `project_root`: the candidate id equals any `projects.root_task_id`, whatever its status.
  - `outside_origin`: the root's origin is `watch`, `import` or `poll`. These are recurring outside feeds; see `OUTSIDE_ORIGINS`.
  - Remove the incorrect sentence from 3.2a.
  - Tests: adopting another project's idle root is skipped with `project_root`; a watch root is skipped with `outside_origin`.
- **AP-C5 (claim reads the real key).**
  - Step 5 of `claimApproval` builds its key with `taskBudgetKey(root)` from budget.ts, never with a literal.
  - Test: seed spend equal to `maxUsd` (and, separately, `calls` equal to `maxCalls`) on the root's key, and expect `budget`. With 500 approvals used, also expect `budget`.
  - Test: 10 parallel claims at `used = max-1` give exactly one `run`.
- **AP-C6 (C12).** Unit tests with `limits.localUnlimited = true`:
  - the project call cap still refuses with scope `project`;
  - a snapshot shows `LIFTED_CAPS` unchanged;
  - a project root never returns `local_task`;
  - with `maxUsd = 0`, every metered call in the tree is refused.
- **AP-C7 (C10 bounds).**
  - `projectGrant` runs only when all of these hold: `run.task` is set; `sameActor(task.owner, actor)`; `projectOf(task.id)` is non-null; the existing `tainted` refusal has passed.
  - `precheckCall(tool, {})` returning `hard_deny:*` goes to today's card flow. This covers destructive and cost tools.
  - `toolsFor` returns rows only for the active project that `projectOf` returned.
  - `toolsForTask` (replay) joins `projects.status = 'active'`, so paused or exhausted projects still replay a card a human approved. After `done` or `cancelled`, no rows are returned and the replay fails closed at the allowlist (`denied`). This is the accepted behaviour.
  - The digest Autopilot part lists the grants made that day (`#pid dept tool`).
  - Tests: a non-owner run is refused with `not_project`; an 11th grant is refused; after close, the tool is absent from the offer and the dispatch list.
- **AP-C8 (C11 bounds).** Inside a project, a ClickUp workspace write still:
  - runs the tool `precheck` (scope, pins, `cardShowsWhole`) before the branch;
  - increments `filed` through `onApprovalTask`;
  - takes the daily counter in `run`, where an absent or throwing counter refuses.
  - Tests cover each of these three inside a project, plus a 1501-character description refused with `input_cut`.
  - Correct brief C11 and 6 ("ws_run per-call approval") to say that ws_run is unchanged.
- **AP-C9 (deadline bound, F-6).**
  - `projectOf` and claim step 4 also require `p.deadline >= <today in schedule.timezone>`. After that, the tree runs under today's rules; `capFor` keeps capping.
  - `/project list` shows `(past deadline)`.
  - A new `/project extend <id> <date>` (Bot Admin, #setting, `dueOk`) does a CAS `... WHERE id=$1 AND status='active'` and writes the audit row `project.extend`.
  - When a project passes its deadline, post one notice to #setting, using the same claim-first CAS pattern as `exhaust` on a new `deadline_noticed_at` column in migration 042. Its text names `/project extend`. This keeps the change from becoming a silent new wait.
  - Test: the day after the deadline, a non-hard-deny call gives a card, and exactly one notice is posted.
- **AP-C10 (fail-safe).**
  - Each of these throws: `decide`, `projectOf`, `claimApproval`, `toolsFor`, the `autopilot.enabled` read and `capFor`.
  - In every case the result must be a card, today's rules, or no extra tools. It must never be a run or a lifted cap.
  - One test for each.
- **AP-C11 (buttons and slash).**
  - `projcard:` and `projbud:` are handled only in `route()`, after the #setting check and the live Bot Admin check.
  - Tests:
    - a non-admin click is refused;
    - a click outside #setting is refused;
    - a token on a different message gets `wrong_card`;
    - a second approve gets `not_pending`;
    - an expired proposal is cancelled;
    - `/project *` from a non-admin is refused.
- **AP-C12 (one budget notice).**
  - `exhaust` is a CAS. Concurrent claim and budget-refusal paths post exactly one card.
  - Raise unblocks only `blocked_reason='budget'` rows of that root.
  - The CHECK overflow returns `raise_max`.
  - Tests cover each of these.
- **AP-C13 (halt).** Under halt, these refuse: propose, decide, raise, extend, `project_task` and the autopilot branch (the post-claim halt gives no run). Test each.
- **AP-C14 (no model text out).**
  - A planted marker in goal, title, instruction, adopt entries and tool input must never appear in log lines, refusal texts, the `update_task` error, the digest, or the card body except in the escaped Goal and adopt-title fields.
  - Capture the emitted log lines, not the stored rows.
  - Log `errName` only.
- **AP-C15 (adoption race, F-5).**
  - `TaskRepo.insert` with a parent reads the parent with `SELECT ... FOR SHARE` and inserts in the same transaction.
  - Test: a child created concurrently with an adoption ends with `root_id` equal to its parent's `root_id` and `depth` equal to the parent's depth plus 1.
- **AP-C16 (project_task).**
  - Each refusal in Brief 3.8 order gets a test, including a tainted chat (another human's message in history) refused.
  - `personAdmin` comes only from `trigger.msg.isAdmin`.
  - The new task is created with `tainted false` only after the untainted check passes.
- **AP-C17 (update_task prefix).**
  - The prefix regex has no `%` or `_`, and the query keeps the `owner @>` filter.
  - The error lists id8, status and dept only (no titles), and never echoes input.
  - The existing marker test ("MARKER-PLANTED absent") stays.
- **AP-C18 (Gate 2).** Gate 2 receives:
  - the AP-C1 golden table output;
  - the md5 list of every audited file;
  - the acceptance replay (the 14:17-15:05 log as a project), showing no card for tainted web_search, fetch_page or ClickUp creates, and a card for one hard-deny call;
  - proof that `assertTreeGrantScope` and the AI approver tests are unchanged.

## Residual risks (owner accepts under the standing instruction)

- R1-R3 (spec), R4, R5, R6, R7 and R8 are accepted as written in the brief.
- R9 is accepted: the no-ask behaviour is prompt-only. The authority comes from code, not from the prompt, so a model that ignores the note only produces extra questions.
- R10: a run that read outside content can still make the writes in the table above with no person or AI judge looking. An injected page can put wrong content, or short private snippets (up to 1500 characters), into ClickUp, Jira or the forum. This is limited by who can see those systems, the daily and run caps, and the audit.
- R11: a tainted web search under 200 characters with fewer than 10 digits can carry short private facts to a public search backend. The heuristics catch long or dense data, not a short sentence.
- R12: a project grant can give a department a read tool of another department with no card. This is bounded by rule G, the cap of 10, project scope and the digest.

## Owner sign-off

Residual risks (R1-R12) accepted on 2026-11-10 under the owner's standing instruction in chat ("OK, just do it, don't wait for me to order") and the owner's explicit request for project autopilot. Build may proceed under AP-C1 to AP-C18.
