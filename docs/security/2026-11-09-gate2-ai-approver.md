---
title: "Security Gate 2: AI-APPROVE-1 AI approver for tool approval cards"
gate: 2
status: APPROVED
status_code: APPROVED
date: 2026-11-10
recheck: 2026-11-10 (switch-on blockers SW-1..SW-3, HEAD ecbcea4 plus SW-3 tests in the working tree)
task: AI-APPROVE-1
project: labworkspace (BOT/Assistant)
diff: git diff 2c76d1d..HEAD (branch refactor/folders, HEAD 108a5ff); re-check git diff 108a5ff..ecbcea4
gate1: docs/security/2026-11-09-gate1-ai-approver.md
spec: docs/superpowers/specs/2026-11-09-ai-approver-design.md (Amendment SA-1)
---

# Security Gate 2: AI-APPROVE-1

## Final verdict (re-check, 2026-11-10)

**APPROVED. The owner may turn `approval.ai.enabled` on.** SW-1, SW-2 and SW-3 all pass (table below). The residual risks RR-1 and onward in Gate 1 still need the owner's sign-off, and the switch should go on only after the deploy confirms the default is false (C17).

| Item | Status | Evidence |
| :--- | :--- | :--- |
| SW-1 / G2-01 | PASS | `Approvals.decideAi` "`on = await r.stillOn(c)`". `AiApprover` `stillOn: async (q) => (await this.gate(tz, q)) === null`, then `repo.pausedToday(tz, q)`. `AiApproverRepo.pausedToday(tz, q = this.pool)`. The only other `gate()` call runs outside the transaction. Test: `approvals.ai.int.test.ts` "pool safety (G2-01)" (N = pool max + 2 = 6, real reader). **Mutation check by this auditor:** with the reader switched back to the pool, the test reports `HUNG` after 10 s. With the fix it passes. |
| G2-02 | FIXED | `tools/registry.ts` "`if (ctx.run.tainted() && !task.tainted) await ctx.tasks.update(...)`" runs before `approvals.request`. Test: `registry.test.ts` "G2-02". |
| SW-2 / AA-C24 | PASS | Ruled on the backend's recorded run. This auditor may not run network-facing commands. CLI 2.1.319 matches the live pin: `~/.config/assistant/probe-ok` `version=2.1.319 (Claude Code)`, which equals `claude --version` locally. `guard.ts` refuses to start on any other version. argv has `--tools=`, `--setting-sources=` and `--json-schema`. One clean review approved in 5.5 s. 20 concurrent reviews: 20 approved, `judge_bad_output` 0/20, which is under the 10 % bar. **Info:** the probe used `timeoutMs` 110 s against the production 30 s, so in production a burst of about 10 or more reviews escalates on timeout. That gives a card, so it fails safe. **Condition:** re-run the probe after any CLI upgrade. |
| SW-3 / AA-C23 | PASS (tests added by this auditor) | The tester's mapping had no `forum_post` case end to end. Added in `tests/integration/ai-approver.int.test.ts`, describe "forum_post end to end (AA-C23 / SW-3)": (1) a clean post with an injection in its body. The body appears only inside the `tool-input` `untrusted-*` wrapper and never outside it. The line "Read outside text" says `yes`, because a watch task is an outside origin (`runStartsTainted`). A fake approve stands: the approval is `approved` by `ai-approver`, the post is made once and no card is posted (D6). (2) A Bearer token in the body gives `masked_input`. The judge is not called, 1 card is posted and nothing is posted. (3) A 4001-character body is refused by `PostInput.body.max(4000)` before any approval is filed (no judge, no card, no post), and a 4000-character body is judged whole with no `input_cut`. So a cut can't be reached through `forum_post`. C3 cutting stays covered by unit tests (`ai-approver.test.ts` 4000/4001). |

**Re-check runs:** `npx tsc --noEmit -p tsconfig.json` exit 0. Int tests (`approvals.ai.int`, `ai-approver.int`, `migrate.int`): 53 passed. The two AI int files passed again (34) after the final test edit. `npm test`: 4593 passed, 2 skipped. One run had 1 unidentified failure that did not come back in 2 more full runs. `ai-approver.test.ts` and `registry.test.ts` ran 3 times, 105/105 each time. The SW-3 change touches only an int file. The tester's note on governance.int "halted on boot" (fails 4/12 under load at 5a5856f) is accepted: it predates this feature and does not block.

## Verdict at first audit (superseded)

**CONDITIONAL_APPROVE.**
- **Merge:** allowed. `approval.ai.enabled` defaults to false (`config/defaults.ts`), and with the switch off the hook writes no row and posts today's card (int test "disabled (the default)").
- **Turning the switch on is blocked** until all three of these are done:
  - **SW-1.** G2-01 (pool deadlock) is fixed, with a DB test.
  - **SW-2.** The AA-C24 live judge probe has been run and recorded. This auditor may not run network-facing commands.
  - **SW-3.** The AA-C23 end-to-end `forum_post` cases have landed (the tester is adding them).

Anchors are function names plus quoted fragments. Line numbers are hints only.

## Checks run

- `npx tsc --noEmit`: exit 0.
- `npm test`: 342 files, 4592 passed, 2 skipped. The full run is after the single comment edit below.
- Int tests `approvals.ai.int` and `migrate.int`: 36 passed.
- **Bearer ReDoS bench** (`redactText`, inputs of 200-230 KB):
  - inputs: `Bearer` followed by 200k spaces; `Bearer ` x30k; short tokens x10k; `Bearer\t` followed by 200k chars; `BearerBearer...`;
  - result: each took 2.5-3.3 ms, so it is linear.
- **Bearer masking probes:** the backslash tail, quoted, repr tuple, header, lowercase and NBSP forms are all masked, and each is idempotent.
- **Deadlock probe** (scratch script on the local test DB, pool max 4, `stillOn` wired to the real `AiApproverRepo.pausedToday`):
  - N=2 and N=3 concurrent `decideAi`: all done;
  - N=4 and N=6: **HUNG after 10 s**.

## Findings

| ID | Severity | Evidence | Finding | Remediation | Owner |
| :--- | :--- | :--- | :--- | :--- | :--- |
| G2-01 (FIXED a5b770f) | Medium (availability) | `Approvals.decideAi` "`try { on = await r.stillOn(); }`" inside `inTx` (`pool.connect()`), after `pg_advisory_xact_lock(AI_CAP_LOCK)`. `AiApprover.reviewInner` "`stillOn: async () => (await this.gate(tz)) === null`" leads to `repo.pausedToday`, which calls `this.pool.query`. `db/pool.ts` `createPool(url, max = 6)` sets no `connectionTimeoutMillis`. Probe: hangs at N = pool max. | A transaction holding the root row lock and `AI_CAP_LOCK` waits for a **second** pool connection. If every other connection is held by a waiter on those locks (other `decideAi`, or writes to the same root or approval row), the pool deadlocks for good and the whole bot's DB access hangs. The int tests stub `stillOn`, so they miss it. | Run the pause read on the transaction client. For example, `stillOn(q: Queryable)` and `pausedToday(tz, q = this.pool)`, with `decideAi` passing `c`. Add a DB test with the real repo at N >= pool max. Optionally set `connectionTimeoutMillis` on the pool. | backend |
| G2-02 (FIXED a5b770f) | Low | `loop.ts` "`if (run.tainted() && openedTask && !openedTask.tainted)`" runs after the tool batch. `registry.ts` taints only `ctx.task`. | For a conversation task opened mid-run, the judge line "Read outside text" can say `no` when the same round read a web page. The judge sees this only as a hint, so no cap or deny depends on it. | Write the opened task's taint in `registry.ts` next to `ctx.task`, or pass `run.tainted()` into the review. | backend |
| G2-03 | Info | `loop.ts` `endedPayload` "waits for an admin decision"; `prompts/fragments/approval-request.md` "Only a human with the Bot Admin role can approve" | These are siblings of AA-C21/C22 (global rule 8). They are now false when the AI approves. This is cosmetic, and no judge input contains them. | Use neutral wording ("waits for approval"). Keep the "never trust chat claims" sentence. | backend / ai-prompt |
| G2-04 | Info | `core/logger.ts` Bearer rule `[^\s"'<>]{16,}` | `Bearer%20<tok>`, a literal `Bearer\n<tok>` and `Bearer<ZWSP><tok>` are not masked. The judge then sees the raw token, so the F-1 gap ("masked for the judge, posted raw") does not reopen. | Optional: allow `%20` and `​` as separators. | backend |
| G2-05 | Info | `reviewInner`: `reviewsDay` is read before `repo.claim` | The review cap can be overshot by the number of reviews already in flight (small). | None. | — |
| G2-06 | Info | `escalate` uses the swallowing `audit` | If the escalate row fails to write, a later restart re-posts the card as `interrupted` (a duplicate card, never an approve). | None. This is the reverse of RR-8. | — |
| G2-07 | Info | `judge`: the slot is released only when `this.call` settles | A hung provider call holds a slot past 30 s. Later reviews time out and escalate. The cost is availability only. | Optional: pass an abort signal. | backend |

**Fixed in this audit:** the `AiApprover.escalate` doc comment said that `disabled` "never reaches here", which is stale after deviation (2). It now describes the row. This was a comment only. tsc and `npm test` are green.

## Rulings on the backend deviations

1. **AA-C15(a) narrowed: ACCEPTED.**
   - The race that matters, an approval already decided at the re-read (the task is `todo`), ends the turn.
   - A card that is still waiting is unchanged: for a task run, ENDS_TURN ends the turn on `awaiting_approval`; for an opened task, the F1 answer runs and the opener holds the lock.
   - **(b) verified.** `conversationFor.open` calls `this.locks.run(opened.id, () => held)`. `KeyedLock.run` sets the tail synchronously. `runMessage` calls `afterRun` before `conv.release()` in `finally`. `task.ready` reaches `runOwner` through `exclusive(taskId)`, which uses `locks.run`. So there is no concurrent run, and `closeConversation` (which acts only on `doing`) never sees the `todo` row.
   - **Residual:** an opener that keeps running after a later AI approve could re-file the same call. This is the same as today with a human approval.
   - **UX text:** see G2-03.
2. **`not_enabled` mapped to `disabled`, with a row and no card line: ACCEPTED.** The outcome row keeps boot recovery from re-posting it. The card is still posted.
3. **`reviewsDay`, `masked_input`, `input_cut`, `hard_deny:input`, and `sheets_append_receipt` under `money_doc`: ACCEPTED.** `doc_create` money kinds now fall under `hard_deny:input` (Gate 1 R7 widened `storedInputOk` to every tool). The decision is still a deny.
4. **Bearer added to the global `redactText`: ACCEPTED.**
   - It is linear (bench above) and idempotent, and the backslash tail is masked.
   - **Siblings:** `redactText` is the only text masker. `dashboard/envfile.ts` `JIRA_TOKEN_RE` is a validator, checked and not affected.
   - **Side effect:** ClickUp's masked-text refusal (C5) and other redacting paths now also refuse or mask "bearer" followed by 16 or more non-space characters. This fails closed.
   - **Gaps:** see G2-04.
5. **`JUDGE_CONCURRENCY` semaphore per instance: ACCEPTED.** There is one app instance. The slot wait is inside the 30 s race (`if (timedOut) return null`). See G2-07.
6. **AA-C21/C22 text edits: ACCEPTED.** No match remains in non-test code for `person approves`, `Bot Admin to approve` or `approved by a person`. G2-03 lists the two remaining sibling texts.
7. **Solo card AI field under a 200-character margin below `EMBED_LIMIT`: ACCEPTED.**
   - It uses the same margin as the TG-C11 offer check, and the offer check counts the AI field.
   - The field is omitted, never cut, so `cardShowsWhole`, which runs without `aiReview`, is not affected.
8. **grant-url `HIDDEN`: CONFIRMED, no bug.**
   - `grant-url.ts` imports `HIDDEN` from `webSearch.ts`, which is `/u` with no `g`.
   - The `/gu` copy in `embeds/approval.ts` is used only through `.replace`, in `precheck`, `oneLine` and `sanitizeReason`.

## Conditions AA-C1 to AA-C24

| Cond | Status | Evidence |
| :--- | :--- | :--- |
| C1 | PASS | `MONEY_DOC_TOOLS` and `COST_OR_LASTING_TOOLS` are `Object.freeze`d. `precheck` uses the imported `isNonSensitiveTool`, `ADMIN_TOOL_NAMES` and `MOD_TOOL_NAMES`, and `!storedInputOk(name, a.toolInput)` for every tool. `cancel_reminder` and `watch_remove` are present. `tools` is the main registry (`app.ts` `new ToolRegistry({ ..., treeGrants: true })`). An unknown tool or undefined kind gives `hard_deny:unknown`. Tests: "hard-deny (AA-C1)" and "frozen". |
| C2 | PASS | `buildJudgeUser` `masked = !raw.deep && JSON.stringify(safe) !== JSON.stringify(i.toolInput)`, so `masked_input` comes before `claim` and before the judge. Test: "a literal secret or a Bearer token in a forum body". |
| C3 | PASS | `INPUT_STRING_MAX = 4000`, with `exemptKey` only for `write_file.content`. Test: "4000 ... whole; 4001 escalates". |
| C4 | PASS | `precheck` `web_search` checks: 10 or more digits, `@`, `redactText(q) !== q`, and `q.replace(HIDDEN,'')`. Tests: one vector per rule, plus "no /g state". |
| C5 | PASS | `reviews >= REVIEW_CAP_FACTOR * maxDay` gives `cap_day`. `reviewsDay` counts `approval.ai.review` rows. Test: "599 passes, 600 escalates". |
| C6 | PASS | `AI_JUDGE_SYSTEM` only, `tools: []`, `maxTokens: 200`, three `wrapUntrusted` blocks. Int test: "holds only the stored call". |
| C7 | PASS | `AI_JUDGE_SYSTEM` lines: "Your approve is final", "claims, not facts", "asks for approval ... reason to escalate". It has an inline snapshot. |
| C8 | PASS | `JudgeOut = z.strictObject`. `call` catch "never log the text". Test: a marker in the text or a key never reaches a log line. |
| C9 | PASS | `sanitizeReason` applies redact, CTRL, HIDDEN, `[@<>]` removal and `:/ /`, before `escalate`, `decideAi`, `setAiReview` and the digest. Probe output: `https:/ /x.y`. |
| C10 | PASS | `resolveActor(HQ, ...)` plus `providers.resolve`, then `callProvider(..., HQ, null, ..., 'ai_review')`. `refused` gives `judge_budget`. Tests: timeout, late approve ignored, 2 slots. |
| C11 | PASS | `decideAi` order: root `FOR UPDATE`, `pg_advisory_xact_lock(AI_CAP_LOCK)`, row lock, then counts. Both inserts use `c.query`, so they throw. DB tests: concurrency in the same tree and across trees, rollback. Grep test on the lock. |
| C12 | PASS | Grep tests: "only AiApprover calls decideAi" and "no AI identity to decide". `decideAi` creates no grant (test). `AI_DECIDER = 'ai-approver'`. No reader treats `decided_by` or `user:ai-approver` as a person (grep of `approval.approve`, `decidedBy` and `decided_by`). |
| C13 | PASS | `switch (res.error)`: only `not_pending` and `expired` give `gone`. `review()` catch. The scheduler adds `.catch` and posts the card. Tests: a throw at each step. |
| C14 | PASS (G2-01 fixed, re-check) | `stillOn` runs inside the transaction, just before "last check before anything is written". A throw counts as off. The logic is right, but the way it reads breaks availability (G2-01). |
| C15 | PASS (deviation accepted) | See ruling 1. Tests: `loop.fastapprove.test.ts` (3), int test "conversation task opened mid-run", and the AI-off F1 test. |
| C16 | PASS | `AiApproverRepo.interrupted` uses the brief SQL. `claim(... '#id start')` comes before `judge()`. `recoverAiReviews` runs next to `recoverApprovalBatches` in `app.ts`. Int test: "restart in the middle". |
| C17 | PASS | Defaults are `false`, `40` and `300`, and all three keys are in `HANDLER_KEYS`. `planAiApprovalEnabled` has `risk: v === true`. Tests: `keys.ai` and `settings.aiapproval`. The deploy confirmation of false is for devops at release. |
| C18 | PASS | `'approval:ai'` is in `COMMAND_TABLE`, reached only after `decide()` checks the guild, the channel and `adminRoleId`. The `pausedToday` regex is `^user:[0-9]{17,20}$`, and the day start is in `tz`. Tests: `approval.ai.test` and `AiApproverRepo pausedToday`. |
| C19 | PASS | The 038 up migration is verbatim from SA-1 §5. The down migration also deletes the `ai_digest` rows, which is needed for the old CHECK. `ai_review` is written only in `setAiReview`. It is rendered only through `escapeCardText` (solo 200, batch 80), and the field is omitted when it does not fit. Consumer grep: there is no `SELECT *`, `row_to_json` or `to_jsonb` on approvals, and `approved-tools.ts` notices use only the id and name. So no model sees `aiReview`. |
| C20 | PASS | `AiDigest`: the `ai_digest` claim is taken only when there are 1 or more reviews. It posts as hq to `BOT_LOG_CHANNEL_ID`, uses `escapeCardText` 64/120 with secrets, and logs `errName` only. Tests: 6. |
| C21 | PASS | `REASON` and 8 descriptions now say "needs approval", plus `clickup/index.ts` `emptyHint`. See G2-03. |
| C22 | PASS | `awaitingText` says "waiting for approval of ...". The footer is unchanged. |
| C23 | PASS (re-check: SW-3 tests added) | `clickup_delete_task` and `github_create_branch` always give a card (int tests). The `forum_post` clean, secret and cut cases are covered only at unit level (`ai-approver.test.ts`). The end-to-end cases are pending from the tester (SW-3). |
| C24 | PASS (re-check: SW-2 probe recorded) | `protocol.ts` argv has `'--tools='`, `'--setting-sources='` and `--json-schema`. The judge text arrives as `structured_output.text` and is then put through `JSON.parse`. The live probe has not been run (SW-2). Steps for the main thread or devops, on the pinned CLI with the switch still off: (1) one review of a clean `forum_post` through `AiApprover.review` with a real hq provider; (2) capture argv and confirm both flags; (3) run 20 reviews and record the share of `judge_bad_output`. If it is above 10 %, revisit the JSON-in-`text` wrapping before switch-on. |

## Missing context

`<PROJECT_ROOT>/CLAUDE.md` and `.claude/rules/` are absent. The defaults of the team rules were used.

## Files audited (md5 at end of review)

`tests/integration/ai-approver.int.test.ts` is being changed by the tester, so its hash will move.

Re-check hashes (supersede the matching lines below):

```
559f9dc139ab02bbc59bcc8bd2ebea30 governance/ai-approver.ts
2e3142c67ab8f7fc70afb6c785b7246d governance/approval/approvals.ts
15016cbf2bd7e8b624ef9d898bb1547a db/repos/ai-approver.ts
d026ddf2ea1c5fddbbfa18355a5b395a tools/registry.ts
8d405b58c452bbcf10744723354b7d6d tests/integration/ai-approver.int.test.ts
b558117bfeb5463eb7ce2ea4dcdb2495 governance/approval/approvals.ai.int.test.ts
a891f9e64596854e63b5044d31c1d27c scripts/ai-judge-probe.net.test.ts
```

First audit:

```
4483d5e5b88883c5d6b2cacdd325bb0a governance/ai-approver.ts
439dc7d2e76de14f1b6b1291c07d0d39 governance/ai-approver-prompt.ts
71b4712798a402155439e57d4511e2ae governance/approval/approvals.ts
26b3d732c6b1c492193febd0c09d6f57 db/repos/ai-approver.ts
20345e390c1f972ac017ca06e431302e db/migrations/038_ai_approver.up.sql
6ecb601f0a544d6b553b2296f6cf7664 db/migrations/038_ai_approver.down.sql
4d0ff4090c9b2c0fca32d63a78454279 agents/loop/loop.ts
f05ca921f68c0d3ae6ea06b112be0c15 agents/scheduler/scheduler.ts
5ce2d8f3b72bc9040f65d9d98ef6781f agents/scheduler/jobs.ts
124fec4e134dd0f9a01ea806ef1c364c agents/tasks/ai-digest.ts
305b626fc61da39bea79957fa51be134 core/logger.ts
1642a0f45da780fa1b72f6095faed81e tools/registry.ts
facf65e2a553ea975b2917d2dce0696f discord/embeds/approval.ts
620dc0c2e4f92dad9d9e9384aacdf91d discord/commands/approval.ai.ts
bfb95794a649528ab3939ae994c445d6 discord/commands/index.ts
b340b090a65babda23c16fde27be080d discord/commands/plans.ts
d209c20958bb4d473a35dc4682cfa60f discord/commands/settings.ts
8014be294dc27ecd1d3bc65a2a13889d admin/keys.ts
8a8d0c6f7738af37772953ed2cb1aabd config/defaults.ts
3a942dc7c287e8b90d9e37252406c927 config/schema.ts
545ed7dd05e217977135d3f0e5892051 app.ts
74fa931e3016d186af761ba0b7a0c640 tools/plugins/clickup/workspace-write.ts
a133344e9b268c2ee0e09b2205ff41b2 tools/plugins/clickup/index.ts
7711630b0486544ea2f7bcbddc87c06d tools/plugins/web/grant-url.ts
d9a979c719f963ec84102e9f8041bdca tools/plugins/web/webSearch.ts
f89933d36ed1e47d025581abba58f468 providers/claude-code-local/protocol.ts
576beed77dc8a32f6a3bc9f06ee5d954 db/pool.ts
93b47cc22745919d9ab33f9986202900 tests/integration/ai-approver.int.test.ts
```
