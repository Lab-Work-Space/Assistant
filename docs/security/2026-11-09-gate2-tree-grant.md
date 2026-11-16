---
title: "Security Gate 2: task-tree approval grant (TREEGRANT-1)"
gate: 2
status: APPROVED
date: 2026-11-09
task: TREEGRANT-1
project: labworkspace (BOT/Assistant)
gate1: docs/security/2026-11-09-gate1-tree-grant.md
spec: docs/superpowers/specs/2026-11-09-tree-grant-design.md
---

# Security Gate 2: "Approve the whole task"

Verdict: **APPROVED**. I made two small fixes during the audit (G2TG-01, G2TG-02) and one spec wording fix (TG-C22).

The other findings are Low or Info. They do not block, and they are listed as recommendations.

Every condition TG-C1 to TG-C22 holds in the code and has a test that proves it. The owner's narrowing is implemented:
- `write_file` is covered only for new files in a clean run;
- `forward_to` is covered only when the audience is not wider.

## Verification run

- `npx tsc --noEmit`: exit 0. I ran it before and after my fixes.
- `npx vitest run --project unit` (all files): 314 files, 4042 passed, 2 skipped. This was after my fixes. It covers the registry split between central and own approval, and the regression question for the loop and the approvals code.
- Integration tests on 127.0.0.1:54329/assistant_test, all green after my fixes:
  - `db/repos/task-grants.int`, `governance/approvals.treegrant.int` and `tests/integration/tree-grant-app.int`: 42 tests;
  - `tests/integration/tree-grant-acceptance.int`: 12 tests;
  - `db/migrate.int`: green.

## Condition by condition

| ID | Status | Evidence (code / test) |
| :--- | :--- | :--- |
| TG-C1 | PASS | `tools/tree-grant-tools.ts`: the nine names. `tree-grant-scope.ts` `assertTreeGrantScope` checks four things: kind is `write`, `isNonSensitiveTool`, not in the bot-talk or no-approval lists, and not in the admin or moderator lists. An unregistered entry is skipped. `app.ts` calls the assertion after every `tools.register(...)`; no register on the main registry comes after it, and none happens at runtime. Test: `tools/tree-grant-scope.test.ts`. |
| TG-C2 | PASS | `registry.ts` `exec`. `own` is computed only when `!approved`. A throw under central becomes `own = true` (a card). Without central, a throw takes today's fault path, where nothing is waivable. The card reason is `central \|\| own`. The waiver needs `own === false`, checked again inside `treeGrantCovers`. Test: `registry.treegrant.test.ts` (TG-C2 block, every DRAFT kind). The approved path still does not call `requiresApproval`. |
| TG-C3 | PASS | `treeGrantEligible(row, kindOf)` is one pure function. Five callers use it: the offer (`task-grant-offer.ts`), which both the solo and the batch card read; the batch refresh (`batchOffer`); `decideTaskGrant`; and `decideBatch({task})` for every member. It never builds a ToolContext. |
| TG-C4 | PASS | (a) `storedInputOk`: a `doc_create` kind must be in `DOC_KINDS` and not `isDraftKind`; `write_file` must have `overwrite !== true`. This runs at render, at decision and at consume. (b) `treeGrantRunOk` runs at consume only: `write_file` is refused when `ctx.tainted()` or `task.tainted`, and `forward_to` needs `forwardWider(...) === false`, the same helper `run()` uses. A throw counts as false, which gives a card. The sandbox `link()` refuses EEXIST, so an overwrite can only happen with `overwrite: true`. Tests: `tree-grant-scope.test.ts`, `registry.treegrant.test.ts`, `forwardTo.treegrant.test.ts`. |
| TG-C5 | PASS | The order is: allowlist, zod, precheck/pin, central, own, covered and owner check, run-time predicate, consume (whose gate checks halted, disabled and tainted before any SQL), audit, the halt re-check (a plain `toolError` with no `notRun`), then run. A miss gets the suffix from the closed `TaskGrantMiss` set. `ensureConversationTask` is never called. |
| TG-C6 | PASS | Two lines of defence. (1) `toolContextBase` adds `treeGrants` only when `trigger.admin !== true`; moderator-room runs also set `admin: true`, and `approvedToolContext` strips the port. (2) `ToolRegistry({treeGrants:true})` is set only on the main registry (`app.ts`); `exec` strips the port when the call is approved or the flag is missing. Tests: `loop.treegrant.test.ts`, `registry.treegrant.test.ts`. |
| TG-C7 | PASS | The halt and resume hooks call `revokeAll('halt')`. At boot, `revokeBeforeHaltedRow` runs, then `revokeAll('halt')` when booting halted, both before the scheduler. `revokeOwed` is paid first on the next consume, and a throw there gives `error`. The int tests mutation-check this. |
| TG-C8 | PASS | A live flip to off goes through `cfg.watch` to `revokeAll('disabled')`; the `/settings` plan revokes too. A boot with the switch off revokes. A failed revoke is owed. See L-4 for the process-local caveat. |
| TG-C9 | PASS | `revokeCompanions` revokes by id, in its own statement, with reason `admin`, `halt` or `superseded`, all inside the 027 CHECK. A failure never undoes the task-grant revoke. It is now also reported (G2TG-02). |
| TG-C10 | PASS | The companion is inserted with `card_message_id = NULL` (`makeGrant(..., null)`). `revokeButton` refuses it on every message. `refreshBatchCard` renders the task grant first, with its single revoke. Test: `approval.task.test.ts`. |
| TG-C11 | PASS (Low residual L-1) | `taskOfferText` is in the card body and states the scope, the covered list, the cap, the hours (the conversation cap when it applies), what still asks, and the web caps with the leak statement. The label is "Approve the whole task", at most 80 characters. The offer is dropped rather than cut when the card is near the limit. |
| TG-C12 | PASS | `hasLiveTaskGrant` runs after the root `FOR UPDATE`. It uses `LIVE_SQL`, the same predicate as the render. The unique partial index is the second line. Tested with concurrent clicks. |
| TG-C13 | PASS | Every member is checked with `treeEligible`, together with B5/B6. One failure refuses the whole click. The grant is made on `decided[0]` only when `decided.length > 0`. The card id follows the G2W-03 rule. `grant` together with `task` gives `not_found`. |
| TG-C14 | PASS | `approvalRow` and `batchRows` add exactly one extra button. There are at most 5 buttons and 5 rows, and ids are at most 100 characters. Test: `approval-task.test.ts`. |
| TG-C15 | PASS | `TASK_REVOKE_ID` is anchored (JS `$` without the `m` flag refuses a trailing `\n`). It is parsed before `REVOKE_ID` and `APPROVAL_ID`, and any other `approval:t:` id gets 'Unknown action.'. Revoke requires `g.cardMessageId === i.messageId`. The admin role is checked by the guard in `index.ts` and again in `decide*`. The malformed list is tested. |
| TG-C16 | PASS | `isConversation(root)` runs on the locked root. The expiry is `now() + hours` on the DB clock. Boot refuses `conversationHours > hours`. |
| TG-C17 | PASS (Low residual L-2) | `TaskGrantCards` re-reads the row through `editable()` before each edit, and `closed()` cancels the timer. `taskUsageLine` shows only covered names that match `SAFE_TOOL_NAME`, with safe non-negative integers. |
| TG-C18 | PASS | The `task.changed` root listener calls `revokeRoot('root_ended')`. The consume SQL checks the root status itself, which the int test covers. |
| TG-C19 | PASS after fix G2TG-01 | These were already written: `task_grant.use` (the run's taskId, the registry's name, `ok #gid used/max` or the reason); `approval.task_grant ... web_grant #wid`; the admin revoke; and the fault incident (`source task_grant`, fixed text plus SQLSTATE). System revokes were not audited; they are now. |
| TG-C20 | PASS | Migration 035 has every CHECK and the unique partial index. `used_by_tool` is written only through `jsonb_set(..., ARRAY[$2::text], ...)`. Down drops the table; the 027 CHECK is not widened, so there is nothing to restore. |
| TG-C21 | PASS | The covered call still passes its own precheck and its `run()` re-checks. The forward caps of 2 per run and 4 per root are tested under a grant. |
| TG-C22 | PASS after a wording fix | The spec has the §3.2 errata, the TG-C4 predicates, the "run path only" note, and §Security saying the child estimate is not a control and R3b is mitigated. One stale phrase in §3.2, "child estimate card stays", has been corrected. |

## Holes audited (the caller's list)

- **Split between central and own.** No regression. The full unit suite is green. `approval` keeps today's value exactly when no grant applies.
- **Consume binding.** `rootId` comes from `ctx.task` (the task row) and is never taken from input. `sameActor(task.owner, actor)` is required, and a non-owner falls through to I1. On who steers the run: WS13 in `company/router.ts` (`mayCommand`) lets only the root requester or a Bot Admin steer a task thread. Other members are ignored. Bots in the tree are within R3. No new human audience is exposed.
- **Allow-list and startup assertion.** Fail-closed: list, `kind === 'write'`, `isNonSensitiveTool`, strict `own`. There is no late registration.
- **Stored-input eligibility vs. run predicates.** These are separated correctly. The card's own call replays through `runApproved`, which never consumes.
- **`forward_to` wider check.** The same helper as RF11/G2RF-02. A missing `channelIsPublic` or a read fault counts as wider, which gives a card.
- **DRAFT detection.** It is checked twice: `own` (a reason from `requiresApproval`) and `storedInputOk`. An unknown kind is refused.
- **Halt, resume, boot, revokeOwed, disabled.** All wired before the scheduler. A halt after consume runs nothing. `haltedAfterCommitTask` revokes the task grant and its companion.
- **Supersede and one live grant.** Supersede runs under the root lock, and only after the live check, so only non-live rows are retired. The unique index is the backstop.
- **Companion revoke paths and CHECK.** Inside the CHECK. A failure is now reported. See also I-1.
- **customId forging.** Covered by TG-C15. Cards are edited only at stored ids or the clicked message.
- **Usage line content.** Code values only.
- **Admin registry.** It never gets the port; there are two lines of defence.
- **Audit.** Complete after G2TG-01.

## Rulings on the declared deviations

| Deviation | Ruling |
| :--- | :--- |
| `app.ts` `cards.close` forwards the revoke arg (fixes the missing WEBGRANT Revoke button; live behaviour change) | ACCEPT. Security-positive: it restores a control. `port.taskgrant.test.ts` and the acceptance int test cover the argument reaching the port. |
| `closeCard` 4th argument union, optional `noteCard` | ACCEPT. `noteCard` edits only the content of the hq client's own message, masked, with no pings. |
| `TaskGrantMiss` adds `tainted` and `not_covered` | ACCEPT. The set is still closed and code-only. |
| A throwing `own` counts as truthy only with central | ACCEPT. Without central, nothing can be waived and today's fault path applies. |
| Async offer injection | ACCEPT. A fault means no offer, which fails closed. |
| The admin revoke card is edited by the click handler | ACCEPT, with L-2. |
| The batch card keeps its buttons on halt, disabled or root_ended | ACCEPT. Pending items stay decidable. A stale task Revoke answers "Already revoked." A later refresh recomputes the offer, including the halted check. |
| Superseded and expired cards are not closed | ACCEPT (I-2). Only non-live rows are ever superseded. A stale card shows its own expiry. |
| Usage timers are not cleared on stop | ACCEPT. Timers are `unref`'d, and a late edit is caught and logged. |
| A companion web grant can be made without the pre-click statement if `web.taskGrant.enabled` flips between render and click | ACCEPT as Low residual L-1. |
| Resumed runs start tainted, so `write_file` is almost never covered (owner informed) | ACCEPT. The consent text says so ("or that resumes with the result of an approved call"). This errs on the safe side. |

## Fixed in this audit

- **G2TG-01 (Low, TG-C19).** `app.ts`, `TaskGrantRepo` `onRevoked`. System revokes (halt, resume, boot, disabled, root_ended) wrote no `task_grant.revoke` audit; only the admin click did. They now write `task_grant.revoke <reason> #gid` with actor `system`. Superseded rows are retired inside the decision transaction, and the new grant's `approval.task_grant` audit records them.
- **G2TG-02 (Low).** `db/repos/task-grants.ts` `revokeCompanions`. A failed companion revoke was swallowed silently. The companion web grant then stayed live for up to `web.taskGrant.hours` (4 h by default) after a task revoke with reason admin, root_ended or disabled, while the admin was told that web reading asks again. `disabled` flips only `taskGrant.enabled`, so the web gate stays open. The failure is now reported through `onFault` (fixed text plus SQLSTATE) as a #bot-log incident. The task-grant revoke is still never undone.
- **TG-C22 wording.** Spec §3.2 COVERED line: "child estimate card stays" became "covered only when the audience is not wider; the child estimate card is not a control".

## Recommendations (non-blocking)

| ID | Severity | Where | Finding and remediation | Owner |
| :--- | :--- | :--- | :--- | :--- |
| L-1 | Low | `governance/approvals.ts` `makeTaskGrant` → `this.grantEnabled()`; `discord/task-grant-offer.ts` | The card text and the click read `web.taskGrant.enabled` at different times. If the flag turns on in between, a companion web grant is made that the card never described. The post-click card text does state it. Remediation: add a distinct action, for example `approval:<id>:taskw` vs `:task` (both validated by a regex), recording whether the offer included web. Make the companion only when the click's action and the live flag agree; on a mismatch, return `not_grantable` (card stale). | backend |
| L-2 | Low | `discord/task-grant-cards.ts` `revoked()` returns early for `admin`; `discord/commands/approval.ts` `taskRevokeButton` | `closed()` stops new edits but does not wait for a `noteCard` already in flight. A late edit can repaint the live text ("Use Revoke ... to stop it") onto the card the click just closed. That is misleading only; the grant row is revoked. Remediation: expose `settle(grantId)`, which returns the in-flight promise, and await it in `taskRevokeButton` before `closeInPlace`. | backend |
| L-3 | Low/Info | `makeTaskGrant` → `makeGrant` → `supersedeAll` | Making the companion supersedes any live web grant on the tree, including one an admin made from a fetch_page card that has its own Revoke. That card is not updated, and the offer text does not mention it. Caps reset to the companion's snapshot. Remediation: say so in `taskOfferText` when a live web grant exists, or keep the existing web grant and skip the companion. | backend |
| L-4 | Low | `db/repos/task-grants.ts` `revokeOwed` (in memory) | A failed `disabled` or `halt` revoke followed by a process restart, with the flag back on and the process not halted, loses the debt, so the old grants come back. This needs a DB outage at the flip, a restart and a re-enable. Remediation (optional): at boot, revoke rows whose `created_at` is earlier than the `updated_at` of the `taskGrant.enabled` config row, mirroring `revokeBeforeHaltedRow`. | backend |
| I-1 | Info | companion lifetime | The companion is not revoked when the task grant only expires or reaches its call cap. It lives to its own `web.taskGrant.hours`, which can be up to 24 h, longer than a 1 h task grant. The offer states the web hours separately, so this is disclosed. | none |
| I-2 | Info | superseded or expired grant cards | They keep their live text and Revoke button. A click answers "Already revoked." | none |
| I-3 | Info | `registry.ts` `not_covered` branch | No `task_grant.use` audit is written for a run-time predicate miss. The card suffix records it, and the `awaiting_approval` tool audit row exists. | none |

## Residuals (unchanged from Gate 1, owner accepted)

R1, R2, R3, R4, R5, R6, R8 and R9 were accepted. R3b and R7 are mitigated by the TG-C4 narrowing: overwrite is refused, a tainted `write_file` is refused, and `forward_to` is covered only when the audience is not wider. Added at Gate 2: L-1 to L-4 above.

## Missing context

`PROJECT_ROOT/.claude/rules/security.md` and `PROJECT_ROOT/CLAUDE.md` are absent (the latter was deleted by the owner). I used the team global and labworkspace security rules plus Gate 1.

## Files audited (md5 at end of review, after the fixes)

- 4b738339e1d1a6a1a5b8db6381f66e93 db/migrations/035_task_grants.up.sql
- c70c08ab36e823eaea478bc417b938b0 db/migrations/035_task_grants.down.sql
- deb3dfa5314ce2f310f10fc10caca1d9 db/repos/task-grants.ts (fixed: G2TG-02)
- 1e1024bbf2eba7b48c71bc18f190f010 db/repos/index.ts
- b8f94f2969be9b2e4b428319e0ee2280 tools/tree-grant-tools.ts
- 727719e716ece2b5e4243b4c845f226d tools/tree-grant-scope.ts
- fbfe47b6f03e6b3359590b20932cb8af tools/registry.ts
- c2ac8f6e56fca333274501b78e6af299 tools/types.ts
- a5d4ae6b90ffe733744345fce08e97a4 tools/builtin/forwardTo.ts
- a8ef7841d6d63e760b2fcd98b4a73b9c governance/approvals.ts
- d65ec690fdb0e5ebfa7bf9f59b6be8d4 discord/commands/approval.ts
- 71037d08677d74b9d1e5a9efd66f88d7 discord/commands/plans.ts
- a34df653d820efeffb2d3966f88f35ae discord/commands/settings.ts
- 6561bab4156b1fe19eb40a75e776b670 discord/commands/types.ts
- 6d9b99fbd211add9b28793ed3067322f discord/commands/index.ts
- 1d253d9c9dd4e7b73bf5766c77bae6f6 discord/embeds/approval.ts
- a4a31b3a14cfba2907a0c91c2d7ef4da discord/embeds/index.ts
- ae351e861baca7ffee2c841c8dfea028 discord/port.ts
- 55ab5dd9f58ac3261b9ee474770a16c4 discord/task-grant-cards.ts
- 7130b55fa700317ae79a0fcdc69c4895 discord/task-grant-offer.ts
- 72a827ca573e1d3ec2bcdbc794e849a8 agents/payload.ts
- 7d5b950ceca095a672238dadb9135c4f agents/loop.ts
- b32b0a131b0f4e591ccb1b2268f8bf04 agents/scheduler.ts
- 0457af552b25c19e177664bda7666ba6 config/schema.ts
- cb468d61e330cb8bb2085129ed560af9 config/defaults.ts
- ef8116a249e0c7ccd319b968e549a784 admin/keys.ts
- 9836463baa478b52d0c0033e71c7f59e app.ts (fixed: G2TG-01)
- 9704127d1c115b2d2c99e1df31fcbabc docs/superpowers/specs/2026-11-09-tree-grant-design.md (TG-C22 wording)
