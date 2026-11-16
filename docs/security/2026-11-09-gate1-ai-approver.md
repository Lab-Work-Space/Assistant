---
title: "Security Gate 1: AI-APPROVE-1 AI approver for tool approval cards"
gate: 1
status: APPROVED WITH CONDITIONS
status_code: CONDITIONAL_APPROVE
date: 2026-11-09
task: AI-APPROVE-1
project: labworkspace (BOT/Assistant)
spec: docs/superpowers/specs/2026-11-09-ai-approver-design.md
brief: SA handoff brief ai-sa-brief.md (Amendment SA-1; contradictions C1-C16 bind over the spec)
plan: docs/plans/2026-11-09-ai-approve-1-plan.md
---

# Security Gate 1: AI-APPROVE-1

Verdict: **APPROVED WITH CONDITIONS**. Conditions AA-C1 to AA-C24 bind AA-P1, AA-BE1..BE3, the tester (AA-T1/T2) and Gate 2 (AA-S2). Owner decisions D1-D6 are taken as given. This gate bounds them; it does not reopen them.

What the design gets right:
- The judge sees only the stored, validated row (`approvals.tool_input`, sha-checked).
- Untrusted text goes inside nonce wrappers, and the judge has no tools.
- The judge output is strict JSON and can only add "approve" to a row that code has already filtered.
- Every error escalates.
- Caps are claimed first, inside the decide transaction, behind one advisory lock.

Gaps that must close before build:
- **F-1.** A secret in the input is masked for the judge but posted raw on replay.
- **F-2.** The judge would approve text it never saw, because of the 1500-character cut (R5).
- **F-3.** The fast-approval race is also open for conversation tasks opened mid-run.
- **F-4.** The kill switch and pause are not re-checked after the judge's 30 s window.

Anchors are function names plus quoted fragments. Line numbers are hints only.

## Scope

- **Read:** spec §1-§11, SA brief §1-§7 (C1-C16), the plan, and the style of the prior gates (heal, tree-grant, clickup-multi).
- **Code checked against the brief:**
  - `approvals.ts`: `request` ("await this.bus.emit('approval.requested', a)"), `decide` (root lock), `decideRow` ("else if (!halted)"), `decideGrant` (halt re-check "last check before anything is written"), `claimToolOutcomes` ("if (this.halt.isHalted()) return []").
  - `loop.ts`: `ENDS_TURN`, the tool batch loop ("const pendingBefore = run.pending.length"), the round end ("if (task && before !== task.status && ENDS_TURN.includes").
  - `scheduler.ts`:
    - the `approval.requested` handler is spawned (`void this.spawn('approval card'`), so `request()` returns before the review;
    - `runOwnerInner` ("if (!task || task.status !== 'todo') return");
    - `runMessage` ("await this.exclusive(r.taskId,");
    - `exclusive` (no lock when taskId is undefined).
  - `conversation.ts`: `closeConversation` (acts only on `doing`).
  - `registry.ts`: `awaitingText`, `kindOf`.
  - `policy-approval.ts`: `approvalFor` (the reason quotes model values).
  - `tree-grant-scope.ts`: `storedInputOk`.
  - `grant-url.ts`: `grantUrlCheck`.
  - `forum/index.ts`: `createForumPost(... body: i.body`, raw, not redacted.
  - `forwardTo.ts` / `company/forward.ts` (`SUMMARY_MAX = 1500`).
  - `clickup/write.ts` (`DESC_MAX = 4000`).
  - `workspace-write.ts`: `REASON`, the descriptions "A person approves every write", and the C5 masked-text refusal.
  - `workspace/index.ts`: `content` up to 1 MB, `overwrite`.
  - `approval-rooms.ts`: `SENSITIVE_TOOL`.
  - `embeds/approval.ts`: `escapeCardText`, `HIDDEN`.
  - `commands/index.ts`: `decide()`, the channel check and the live admin role check.
  - `plans.ts`: `planHealEnabled`.
  - `admin/keys.ts`: `HANDLER_KEYS`.
  - `assemble.ts`: `wrapUntrusted`.
  - `call.ts`: `callProvider` argument order.
  - `claude-code-local/protocol.ts`: `'--tools='`, `--json-schema`.
  - `budget.ts`: `localRefusal`, `limits.localCallsPerDay`.
  - `037_heal.up.sql`: the constraint name.

## Cited facts checked

- The brief's anchors hold. C1, C2, C3, C4, C7, C9, C12 and C14 are confirmed in code.
- The `callProvider` call in brief §5 is correct: arguments 6 to 8 are `started`, `pool` and `tool`, so `'ai_review'` lands as the label.
- **C9 is real, and it also applies to `openedTask`.**
  - `runMessage` locks only `r.taskId`, and that is undefined for a new conversation.
  - So the `task.ready` sent by `decideAi` can start `runOwner` on the opened task while the chat run is still looping.
  - `closeConversation` then sees the owner run's `doing` and closes the task under it.
  - The brief's "safe because closeConversation acts only on doing" covers orphaning, not two runs at once.
- **The forum body is posted raw** (`body: i.body`). The `forward_to` summary is redacted, and ClickUp refuses masked text (C5). The judge sees `sanitize(input)`, so a literal secret in a forum body would look `[MASKED]` to the judge and still be posted for real.
- **Judge calls draw on hq's budget and the company-wide `limits.localCallsPerDay`** (`localRefusal`). Escalated reviews are not counted by any cap.
- **R6's premise is used in signed gates.** CLICKUP-HIER Gate 1 "Every card is approved by a person" (create space, folder and list) and CLICKUP-MULTI "every write still approved" (R8).
- **`SENSITIVE_TOOL` does not match some tools.** `jira_*` writes, `sheets_append_receipt` (receipt rows to the accounting sheet), `cancel_reminder` and `watch_remove` all fall outside it, while `schedule_remove` is hard-denied through the prefix.

## Findings

| ID | Severity | Evidence | Finding |
| :--- | :--- | :--- | :--- |
| F-1 | Medium | forum/index.ts `body: i.body`; brief §5 `sanitize(a.toolInput, secrets)` | A literal secret or token pattern is masked for the judge but runs raw on replay. This is the cleanest way out for a secret on an AI approve. |
| F-2 | Medium | brief §5 `cutStrings(...,1500)`; forum body max 4000; clickup `DESC_MAX = 4000` | The judge approves text it never saw (R5). D6 accepts a fooled judge, not a blind one. |
| F-3 | Low | scheduler `runMessage` "exclusive(r.taskId"; `exclusive` with no lock when undefined | Two runs on the same opened conversation task, and the task closed while the owner run is still working. |
| F-4 | Low | brief §3 step 1 only | Pause and the enable flag are read once. A pause set during the 30 s judge window does not stop the approve. |
| F-5 | Low | brief §3 step 3 `/\S{20,}/` | The `web_search` heuristic misses phone or ID digit runs, email addresses, secret shapes and hidden characters. |
| F-6 | Low | budget.ts `limits.localCallsPerDay`; brief caps count approvals only | The number of judge calls has no bound. Anyone who can make bots file approvals can drain hq's daily or local budget. |
| F-7 | Low | tree-grant-scope `storedInputOk`; tool list | Gaps in the hard-deny list: `write_file` overwrite (R7), `sheets_append_receipt` (money records), and `cancel_reminder` and `watch_remove` (siblings of tools that are already denied). |
| F-8 | Low | workspace-write.ts `REASON`, descriptions (R6) | The judge's own input says "A person approves every write", which pushes it towards approving. |
| F-9 | Low | escapeCardText (no link defang) | A URL in a judge reason auto-links on the card next to Approve, and in bot-log (precedent: HEAL F-7). |
| F-10 | Info | brief §3 step 6 | `not_tool` and unknown decide errors are not mapped. |
| F-11 | Info | registry.ts `awaitingText` (R8) | The message says "waiting for a Bot Admin" even when the AI approved, and it names a card that is never posted. |
| F-12 | Info | brief recovery SQL `NOT EXISTS ... escalate` | A crash after the escalate row but before the card leaves no card until expiry. This is the same class as today's solo-card crash window. Dropping the exclusion would re-post every pending escalated card on each restart, so it is kept as residual RR-8. |

## Rulings

- **R5 (1500-character cut): not acceptable as written.**
  - The cut becomes 4000 characters per string, and any string still cut escalates with `input_cut` (AA-C3).
  - The only exception is `write_file.content` (private workspace, never an overwrite under AA-C1).
  - `forward_to` (1500) is seen whole.
- **R6 ("every change is approved by a person"): the text changes** (AA-C21).
  - ClickUp writes stay AI-approvable, because D6 names them. The run cap (5), the daily caps (50 for hierarchy, `clickup.writesPerDay` taken at write time) and the audit still bound them.
  - The broken premises of the CLICKUP-HIER and CLICKUP-MULTI gates go to the owner as RR-2.
- **R7 (`write_file` overwrite): yes, hard-deny it.** Apply `storedInputOk(name, input)` to every tool, not only `doc_create`. That also fails closed on input that is not an object (AA-C1).
- **R8 (awaiting text): accepted as cosmetic.** The text becomes neutral at almost no cost (AA-C22).
- **R9 (`a.reason` quotes model text): wrapping is correct and required.** It is proven by a payload test (AA-C6).

## Binding conditions

### Decision order and deny list (AA-BE1)

- **AA-C1 (F-7, R7).** The hard-deny arrays are `Object.freeze`d constants in `governance/ai-approver.ts`.
  - `isNonSensitiveTool` is imported, never copied. `ADMIN_TOOL_NAMES` and `MOD_TOOL_NAMES` are checked too.
  - `!storedInputOk(name, a.toolInput)` applies to every tool and gives `hard_deny:input` with the text "Not reviewed: money document, file overwrite or bad input".
  - `sheets_append_receipt` is added under `money_doc`.
  - `cancel_reminder` and `watch_remove` are added under `cost_or_lasting`.
  - Kinds are read from the main registry only. An unknown tool gives `hard_deny:unknown`.
  - Test: every class, including `write_file` with `overwrite:true` and a non-object input, escalates with a fake approving judge, and the judge is never called.
- **AA-C2 (F-1).** Before the judge, if `sanitize(input, secrets)` or `redactText` changes any string field, escalate with `masked_input` ("Not reviewed: the call contains a secret") and make no judge call.
  - Test: a `forum_post` body holding a planted literal secret, and one holding `Bearer abc...`, both escalate.
- **AA-C3 (F-2, R5).** Per-string cut of 4000 characters. Any string still cut gives `input_cut` ("Escalated: too long to review in full"). The only exception is `write_file.content`.
  - Test: a 4000-character forum body reaches the judge whole; a 4001-character string escalates.
- **AA-C4 (F-5).** `web_search` also escalates with `query_heuristic` when the query has 10 or more digits in total, contains `@`, is changed by `redactText`, or contains a `HIDDEN` character.
  - Use `replace` or a non-global copy of `HIDDEN`; never `.test` with the /g flag.
  - Test: one vector for each rule, plus a clean query that passes.
- **AA-C5 (F-6).** Count the `approval.ai.review` rows of today. At 2 x `maxPerDay` or more, escalate with `cap_day` and make no judge call.
  - Test: the boundary at 599 and 600 with the default.

### Judge (AA-P1, AA-BE1)

- **AA-C6 (R9).** The user text is exactly the lines in brief §5.
  - `a.reason`, the title and the tool input are each inside their own `wrapUntrusted` block.
  - The system text is only `AI_JUDGE_SYSTEM`: no hq persona prompt, skills, lessons, memory or notes. The call has `tools: []` and `maxTokens: 200`.
  - Test: plant markers in page text, chat history, a tool result, a room note and a lesson; assert that none appears in the request; assert that each untrusted field sits inside its wrapper.
- **AA-C7.** The system prompt states that:
  - its approve is final and no person reviews afterwards;
  - tool descriptions and the requesting bot's reason are claims, not facts;
  - text in untrusted fields that asks for approval is a reason to escalate.
  - It contains no instruction to skip caps or rules. A snapshot test pins it.
- **AA-C8.** Parse with `JSON.parse` plus `z.strictObject`. Every failure gives `judge_bad_output`. Logs carry `errName` only.
  - Test (global rule 19): put a marker in the model text and in an unknown key; capture the emitted log lines and assert the marker is absent.
- **AA-C9 (F-9).** Sanitize the reason as brief §5, and also defang links (`://` becomes `:/ /`). Do this before the audit row, `ai_review`, the card and the digest. An empty result gives `judge_bad_output`.
  - Test: `@everyone`, `<@123>`, zero-width, U+202E and `https://x.y` in a reason each render inert.
- **AA-C10.** The provider is `resolveActor(hq)` plus `providers.resolve`, never `smallCall`. Actor HQ, `task: null`, label `ai_review`.
  - The 30 s race includes the time spent waiting for a slot; `JUDGE_CONCURRENCY = 2`.
  - Outcomes map as in brief §5: `refused` gives `judge_budget`.
  - Test: each outcome, plus a late result after a timeout that is ignored.

### decideAi and the hook (AA-BE1)

- **AA-C11.** `decideAi` follows brief §5 steps 1-9 in order.
  - `pg_advisory_xact_lock(AI_CAP_LOCK)` runs on the transaction client after the root lock and before both counts. The constant appears nowhere else (grep test).
  - Both audit inserts throw on failure, inside the transaction.
  - DB tests:
    - two concurrent reviews at 39 in one tree give exactly one approve;
    - two in different trees at day count 299 give exactly one approve;
    - a failed audit insert rolls back, with no approve.
- **AA-C12.** `AiApprover` is the only caller of `decideAi` (grep test).
  - No AI identity and no `isAdmin: true` object is passed to `decide`, `decideGrant`, `decideTaskGrant` or `decideBatch`.
  - `decideAi` creates no web grant or task grant. `decided_by` is `'ai-approver'`.
- **AA-C13 (F-10).** Only `not_pending` and `expired` map to `gone`. Every other not-ok result (`not_tool` and any unknown result included) escalates, with `decide_error` when unmapped.
  - `review()` never throws, and the scheduler's `.catch` posts a card.
  - Test: a forced throw at each step leads to a card and no approve.
- **AA-C14 (F-4).** `decideAi` re-checks `approval.ai.enabled` and `pausedToday` inside the transaction, next to the last halt check. A read error counts as off or paused.
  - Test: a pause written while the fake judge is pending, and the flag turned off in the same window, both escalate with no approve.
- **AA-C15 (C9, F-3).**
  - (a) `loop.ts` ends the turn when `run.pending.length > pendingAtRound` for `current()` (task or `openedTask`).
  - (b) No owner run of a task starts while the run that holds or opened it is still running. The approved call then runs exactly once, after that run ends.
  - DB test with a judge that approves at once: covers a task run and a new conversation, checks that no second round or concurrent run happens, and that `closeConversation` does not move the task under an owner run.
- **AA-C16.** `recoverAiReviews` uses the brief SQL. It escalates with `interrupted` and never judges again. The start row is written before the slot wait and the judge call. It runs at boot next to `recoverApprovalBatches`.
  - Test: start row only gives a card; start plus escalate gives nothing; approved gives nothing.

### Controls (AA-BE1, AA-BE2)

- **AA-C17.** Keys and defaults are as in brief §5: `enabled` is false.
  - All three keys are in `HANDLER_KEYS`.
  - Only `approval.ai.enabled` is in `/settings`, through `planAiApprovalEnabled` with `risk: v === true`, which gives the risk notice on enable.
  - Test: `config_propose` is refused for all three; the default is false; the deploy confirms false.
- **AA-C18.** `/approval ai` is routed only after the guild check, the channel check and the live Bot Admin check in `decide()`.
  - `pausedToday` reads only `approval.ai.pause` and `approval.ai.resume` rows whose actor matches `^user:\d{17,20}$`, since the day start in `schedule.timezone`. The newest row wins.
  - Test: non-admin, wrong channel and other guild are refused; yesterday's pause is ignored; pause, then resume, then pause ends paused.

### Card, digest, migration, texts (AA-BE1..BE3)

- **AA-C19.** Migration 038 is applied verbatim, and the migrate tests are updated.
  - `ai_review` is written only by `setAiReview`, with fixed text or a sanitized reason of 200 characters or fewer.
  - It is rendered only through `escapeCardText`, and omitted when field or embed limits would break.
  - It never enters a model prompt, task context or tool result (Gate 2 greps every consumer of `Approval`).
- **AA-C20.** The digest uses its own `ai_digest` claim and is posted as hq only to `BOT_LOG_CHANNEL_ID`.
  - Body: counts, tool names (`escapeCardText` 64), codes, and 5 sanitized reasons (`escapeCardText` 120 with secrets).
  - It posts once a day, survives a restart, and posts nothing on a day with 0 reviews. Errors are logged as `errName` only.
- **AA-C21 (R6).** In `REASON` and every tool description that says a person approves (grep "person approves"), the text becomes "every change needs approval". The tests that pin it are updated.
- **AA-C22 (R8).** `awaitingText` says "waiting for approval" and does not name a Bot Admin. The footer is unchanged.

### Tests and Gate 2

- **AA-C23.** Acceptance follows C14 and C15:
  - `github_create_branch` and `clickup_delete_task` always produce a card;
  - for a clean `forum_post`, the wrapper is present and a fake approve stands (D6);
  - a `forum_post` with a secret (AA-C2) or one that is cut (AA-C3) still produces a card.
- **AA-C24.** Gate 2 includes a live probe of one judge call on the pinned local CLI:
  - argv contains `--tools=` and `--setting-sources=`;
  - the JSON survives the `--json-schema` wrapper;
  - the share of `judge_bad_output` results is recorded.

## Who can trigger what (global rule 10)

- **AI approvals:** any run that files a tool approval. That includes runs started by any guild member through Praw `/ask`. They are bounded per tree (40) and per day (300 approvals, 600 reviews).
- **Using up the caps** (which turns everything back into human cards): the same people. No one can use the caps to approve more.
- **Pause, resume and the enable flag:** Bot Admins only, in #⚙️-setting. The caps are psql only.

## Residual risks the owner signs (plain words)

- **RR-1.** A tricked AI can approve internal writes built from text planted on a web page: forum posts, forwards, ClickUp and Jira writes, new files in a bot's own folder, music and pins. The limit is up to 40 per task and 300 a day. You see them only in the audit and the 18:00 digest.
- **RR-2.** The earlier ClickUp gates assumed a person approves every ClickUp change. That is no longer true. New ClickUp spaces are visible to everyone in that workspace and could be created by the AI (still at most 5 per run and 50 a day).
- **RR-3.** Small amounts of data can still leak through approved web searches and page addresses: short words, fewer than 10 digits, any public site. The web grant's per-task fetch limits do not apply to AI approvals; only the 40-per-task cap does.
- **RR-4.** A forward can carry text from a private room into a wider room. The AI does not know who can read each room.
- **RR-5.** The judge is the same model family as the bots. Text that fools a bot may fool the judge.
- **RR-6.** Anyone who can make the bots ask for approvals can use up the day's AI reviews. Everything then comes to you as cards, and the reviews use part of hq's budget and the local daily calls.
- **RR-7.** A halt in the last instant can still let one AI approval through. It runs only after `/resume`.
- **RR-8.** If the app crashes between an AI escalation and its card, that request has no card until it expires (same as today's crash window).

## Missing context

`<PROJECT_ROOT>/CLAUDE.md` and `.claude/rules/` are absent. No project security rule covers this area beyond `team/rules/labworkspace/security.md`.

## Files audited (md5 at end of review)

```
76fd255230b23b481472d24e35678403 docs/superpowers/specs/2026-11-09-ai-approver-design.md
acf9e55d65ea19946bb874a2a2c8aaf3 docs/plans/2026-11-09-ai-approve-1-plan.md
b1f347657b995c39535f2290cdff4a2c (scratchpad)/ai-sa-brief.md
588f79c26579e9546c76db6599a56781 governance/approval/approvals.ts
7a3797f50d576bcbd7e7b789ccf8cd13 agents/loop/loop.ts
74f83c6c509b49e43b2f06817057b2b5 agents/scheduler/scheduler.ts
688d7ee86a8bc3f2f5fc920dc0983e40 agents/conversation.ts
fd13fdf41947ddf62f96b7c2a37cd739 tools/registry.ts
a8654980b62b1751a13ccde3b120d907 tools/policy-approval.ts
19ac2e5331f465f0d8f9fdcd5bbc6e52 tools/tree-grant-scope.ts
7711630b0486544ea2f7bcbddc87c06d tools/plugins/web/grant-url.ts
1abb580e112c00277e55d08e8e430492 tools/plugins/clickup/workspace-write.ts
fb1c42ae214eeef15d5e19f773c7703b tools/plugins/clickup/write.ts
82b64b50c605d76374e9cc56b8fe2028 tools/plugins/forum/index.ts
7d3d4a2d06b2688dd8a9b1d96ad7accc tools/plugins/workspace/index.ts
a5d4ae6b90ffe733744345fce08e97a4 tools/builtin/forwardTo.ts
8a0d3f3ec4f5c9214b8f48ff8f01b0cd company/forward.ts
2a8d3a65d4798646479efe4a3cdac907 discord/approval/approval-rooms.ts
8c635cc83bd433a16d3f6a5775e08098 discord/embeds/approval.ts
47afa4693f970b0bddd40cc3c56da133 discord/commands/index.ts
0ccd3a1e8ceee592c608b5a92b5fe515 discord/commands/plans.ts
f6bd433e312cd78a52f89f05b626ded4 admin/keys.ts
1aca29ce908af6ab2f759838dd881e06 prompts/assemble.ts
b2630313f90594418bc15e5854db4789 agents/call/call.ts
f89933d36ed1e47d025581abba58f468 providers/claude-code-local/protocol.ts
a860d5fa03548df970d277818158ed85 governance/budget.ts
67584262a5362f0c219f9974bde8ae6d core/events.ts
337129bd19463539b43fa3a435de05b0 db/migrations/037_heal.up.sql
```

## Owner sign-off

Signed by the owner on 2026-11-09 (in chat): RR-1 to RR-8 accepted (including D6). Build may proceed under AA-C1 to AA-C24.
