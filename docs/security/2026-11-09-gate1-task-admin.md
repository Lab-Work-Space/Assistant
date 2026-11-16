---
title: "Security Gate 1: Bot Admin task administration (TASKADMIN-1)"
gate: 1
status: CONDITIONAL_APPROVE
date: 2026-11-09
task: TASKADMIN-1
project: labworkspace (BOT/Assistant)
spec: docs/superpowers/specs/2026-11-09-task-admin-design.md
---

# Security Gate 1: `/task list | cancel | retry | done` and the blocked note (migration 036)

Verdict: **CONDITIONAL_APPROVE**.

The design is sound in its main points:
- It is human-only behind the existing `decide()` guard.
- No tool, AdminOp, admincfg card, config key or Praw command is added.
- Every SQL value is a parameter.
- The confirm nonce is bound to one user and can be used once.
- Events are emitted after COMMIT.
- Lock order is root first.

Three gaps in the spec text, as written, would break a guarantee the spec itself promises:
- **F-1.** The batch SQL violates a CHECK constraint, so every cancel that meets an open batch fails.
- **F-2.** The subtree walk stops 10 levels down, but delegation can go 20 deep.
- **F-3.** A child created by a tool that is mid-flight survives under a cancelled parent and then runs.

None of these needs a REJECT. Each is closed by a condition below, TA-C1 to TA-C24. These bind Gate 2. The owner must also accept residuals R1 to R6.

## Scope

Anchors are function names plus quoted fragments. Line numbers are hints only.

**Spec:** `docs/superpowers/specs/2026-11-09-task-admin-design.md`, including "Owner decisions (2026-11-09)":
- OQ-1 is option (b), migration 036;
- OQ-3 adds `/task done`;
- OQ-5 adds a cancel `reason`.

**Code read:**
- `discord/commands/index.ts`: `decide()` and its guard order (guild, the WS7 approvals-room branch, "Use this in #⚙️-setting.", "Only Bot Admins can do this."); `route()`, `deferEphemeral` and `handleInteraction`.
- `discord/commands/register.ts`: `toInteractionLike`. It gets live `memberRoleIds` from the interaction payload. Autocomplete returns null.
- `discord/praw/definitions.ts`: `PRAW_COMMANDS` (ask, remind, schedule, watch, lesson, ocr, receipt, play, skip, queue, stop, volume, voice). There is no `task`.
- `app-start.ts`: "The only interaction path: ClientManager listens on hq only". Praw uses a separate `handlePrawInteraction` path.
- `agents/call.ts`: `callProvider`. "const untrack = deps.halt.track(ac);" covers ONLY the provider stream; `untrack()` runs in its `finally`.
- `agents/loop.ts`:
  - the iteration top, "if (deps.halt.isHalted()) return finish(halted());";
  - "if (call.aborted) return finish(halted());";
  - the tool loop "const r = await registry.run(u.name, u.input, ctx);";
  - `finish()`, whose pending footer runs "s.stopped !== 'halted'";
  - `ENDS_TURN`, `SETTLED` (which includes cancelled), `block()` and `setStatus()`.
- `agents/scheduler.ts`: `handleChanged`, `reportEnded` ("!(tt && this.d.halt.isHalted())", "'Subtask cancelled'", `noteReport`), `settleReview` / `settleReviewLocked` ("!isConversationTask(cur)"), `finalRollup`, `parkInterrupted`, `deliver`, the STREAM-1 "finalizeStopped(HALT_LINE" branch, `NO_ROLLUP` and R31.
- `agents/jobs.ts`: `KeyedLock`. It has no try-lock.
- `db/repos/tasks.ts`:
  - `update()`: "A reason belongs to one blocked spell", "blocked_reason = NULL";
  - `insert()`: plain `create()` does no parent-status check; only `createUnderOpenParent` checks;
  - `unblockHalted`, `countOpenChildren`, `taskCols`.
- `tools/builtin/updateTask.ts` (`LOCKED`, the optimistic "task.status") and `tools/builtin/createTask.ts` (`createChild` → `ctx.tasks.create`).
- `governance/approvals.ts`:
  - `request` ("t.status NOT IN ('done','cancelled')", rollback on miss);
  - `capHit` ("last.rows[0].status !== 'approved'" → `block()`);
  - `decideRow` (rejected → cancelled), `expireOld` (root locks sorted), `blockWaiters`, `emitChanges`, `move()`.
- `db/repos/approval-batches.ts`: `sealIn` (computes `items_digest`), `joinIn` (locks the batch, then the approval), `markPosted`, `dissolve` and `close`. All are conditional on state.
- `db/repos/task-grants.ts` `revokeRoot` (reason `root_ended`, with companions); `db/repos/web-grants.ts` `consume` → 'root_ended'; `db/repos/ot-requests.ts` "return refuse('root_ended')"; `app.ts` "TG-C18: the root of a task tree ending revokes its grant".
- `governance/limits.ts` `checkDepth`; `config/schema.ts` "'limits.depth': count(20)".
- `discord/embeds/approval.ts` `escapeCardText` (redact before cut, then escape); `db/repos/ledger.ts` `AuditEntry` and the dashboard audit `query`.
- Migrations:
  - 001: tasks status CHECK, `parent_id REFERENCES tasks(id)`, approvals `decided_by`;
  - 003: the inline `blocked_reason` CHECK;
  - 026: `approval_batches_digest_check`;
  - 027: the web_grants `revoke_reason` CHECK;
  - 035: the task_grants `revoke_reason` CHECK;
  - `db/migrate.ts` runs each file in one transaction.

## Cited facts checked

| Spec claim | Result |
|---|---|
| `decide()` order: guild → #⚙️-setting → live `adminRoleId` | TRUE. Roles come from the interaction payload, so they are live on every click. The WS7 approvals-room branch only matches `approval:`, so `taskadm:` cannot use it. |
| hq-only interaction path; Praw never sees these; no `task` in PRAW_COMMANDS | TRUE |
| `TaskRepo.create` uses `randomUUID()` ids | TRUE. "const id = t.id ?? randomUUID()". |
| `update` clears `blocked_reason` on any status change | TRUE. "if (patch.status !== undefined && patch.blockedReason === undefined) sets.push('blocked_reason = NULL')". |
| Lock order root first, as in `decide()`, `decideBatch` and `expireOld` | TRUE |
| web_grants CHECK allows only `admin\|halt\|superseded` (027) | TRUE |
| TG-C18 revokes the task grant (and its companion) on root done or cancelled | TRUE. The listener is fire-and-forget (`void`). |
| `reportEnded` skips the parent post while halted; `settleReviewLocked` returns for non-conversation tasks | TRUE |
| OT click refuses `root_ended`; hourly sweep revokes | TRUE |
| `postApprovalCard` return value dropped | TRUE. "await postApprovalCard(this.d.port, a, ...)" in the scheduler. |
| CHECK constraint name `tasks_blocked_reason_check` | CONFIRMED by inference, not read from a live catalog. Migration 003 is the only migration that touches the column ("ADD COLUMN blocked_reason text CHECK (...)", unnamed). PostgreSQL names an unnamed column CHECK `<table>_<column>_check`. Reproduced in a rolled-back temp table on the local test PostgreSQL 17, which returned `tasks_blocked_reason_check`. The test DB had no `tasks` table to read directly. TA-C13 makes a wrong name fail loudly. |
| Retry with `budget`/`approval` "asks for a cap approval" | WRONG. `capHit` blocks again with `budget`, without asking, when the tree's last decided cap approval is not `approved` (rejected or expired). This fails closed: a human cap rejection cannot be bypassed by retry. It is still a wrong claim and the reply text is misleading (TA-C17). |
| "Only `done` spawns a roll-up" | TRUE. "if (e.to !== 'done' \|\| NO_ROLLUP.includes(parent.status)) return false". |
| Batch SQL `ELSE 'dissolved'` for `open` | WRONG. It violates `approval_batches_digest_check CHECK (state = 'open' OR items_digest IS NOT NULL)`, finding F-1. |
| CTE depth 10 | INSUFFICIENT. `limits.depth` can be set up to 20, finding F-2. |
| "Nothing more will run" after cancel | NOT GUARANTEED. Finding F-3. |

## Findings

| ID | Severity | Evidence | Issue |
|---|---|---|---|
| F-1 | High (availability of the feature; no data exposure) | `026_approval_batch.up.sql` "CONSTRAINT approval_batches_digest_check CHECK (state = 'open' OR items_digest IS NOT NULL)" against the spec SQL "SET state = CASE WHEN state = 'posted' THEN 'closed' ELSE 'dissolved' END ... state IN ('open','sealed','posted')" | An open batch has `items_digest` NULL. Moving it to `dissolved` raises 23514 and rolls back the whole cancel. Admins cannot cancel any task that has a batch collecting tool approvals, which is exactly the busy-task case. Lock order also matters: `joinIn` locks the batch and then updates the approval row, while the spec expires approvals before it touches batches, which can deadlock. |
| F-2 | Medium | Spec CTE "WHERE s.lvl < 10" against `config/schema.ts` "'limits.depth': count(20)" | Descendants more than 10 levels below the target are not in S. They escape E_OPEN_CHILDREN, the digest and the cancel, and stay open (and runnable) under a cancelled ancestor. |
| F-3 | Medium | `createChild` → "ctx.tasks.create({ ... parentId: parent?.id ?? null, status: needsApproval ? 'awaiting_approval' : 'todo'"; `TaskRepo.insert` checks the parent only when `requireOpenParent` is set; FK `parent_id REFERENCES tasks(id)` | A `create_task` (or the loop's delegation `tasks.create({ ...t, origin: 'delegated' })`) that started before the cancel inserts its child after COMMIT. The FK KEY SHARE lock waits on the S row lock and then succeeds. The child is `todo` under a cancelled parent and `runOwnerInner` runs it. This contradicts "Nothing more will run". It also leaks spend, and the admin cannot see it in the confirm list. Remediation: TA-C8, a locked parent re-check at insert that refuses a `cancelled` parent. |
| F-4 | Medium | Writers of `blocked_reason`: `TaskRepo.update`, `TaskRepo.unblockHalted`, `governance/approvals.ts` `move()` "blocked_reason = $${params.length + 1}" | With option (b), the spec only makes `TaskRepo.update` clear `blocked_note`. `move()`, which cancel itself uses, would keep a stale model-written note on cancelled or moved rows. Without a DB backstop, a missed writer goes unnoticed. |
| F-5 | Medium (taint) | Option (b) `blocked_note` is the `update_task` summary, written by a model (possibly tainted) | Global rule 9: a tainted turn saves text that later reads may surface. If the note joins `taskCols`/`Task`, every model-facing reader of a Task row (tools, headers, roll-ups) could carry it without the task's taint. |
| F-6 | Low | OQ-5 reason: `reportEnded` builds `text` for "Subtask cancelled" and passes it to `noteReport(parent.id, ..., rolled)`, which `finalRollup` reads | Admin free text would reach a head conversation's model input. That breaks the spec's claim that "the only text a model or a room sees is fixed". |
| F-7 | Low | `finish()` "pending.length && s.stopped !== 'halted'"; `deliver` → `rs.finalize(outcome.payload)` for any stop other than halted | A `cancelled` stop would add "awaiting approval" footers for approvals that cancel just expired. The STREAM-1 preview path for a non-halt stop is unverified. |
| F-8 | Low | `/task list`: 25 rows × (40-character title + reason/note) | With option (b) notes, the reply can go past Discord's 2000-character content limit. The reply then throws and only the generic error is shown. |
| F-9 | Info | Retry table, `capHit` | This is the wrong-claim row above; it is fixed in TA-C17. |

## Binding conditions (Gate 2)

### Shared and authorisation
- **TA-C1.** All four subcommands are `COMMAND_TABLE` rows only:
  - the rows are `task:list`, `task:cancel`, `task:retry` and `task:done`;
  - `'task'` is added to `deferEphemeral`;
  - `taskadm:` is routed in `route()` (buttons only), after the #⚙️-setting and live admin-role checks of `decide()`;
  - nothing is added to the WS7 approvals-room branch, `admin/ops.ts`, `ADMIN_TOOL_NAMES`, `MOD_TOOL_NAMES`, HANDLER_KEYS, ADMIN_CONFIG_KEYS or `PRAW_COMMANDS`.

  Test: a non-admin user and a wrong channel are each refused for every subcommand and for both buttons. A static test asserts that no tool or AdminOp name contains `task_cancel`, `task_retry` or `task_done`.
- **TA-C2.** The button custom id must match `^taskadm:(cancel|dismiss|done):[0-9a-f]{16}$` exactly; anything else gets 'Unknown action.'. Nonces:
  - come from `crypto.randomBytes(8)`;
  - are bound to `userId`, the subcommand, the target and the digest;
  - are single use and deleted on any lookup;
  - live 5 minutes and are held in memory only;
  - are capped at 100 entries, and when full the oldest is evicted or the new one refused (no unbounded growth).

  Test: wrong user, expired, reused, a nonce from cancel used on a done button (and the reverse), and a forged id.
- **TA-C3.** `resolveTaskRef` runs the regex `^[0-9a-f-]{6,36}$` on the trimmed, lowercased value before any SQL, and uses `LIMIT 6`. Discord option lengths are 6–36, and the server re-checks them.
- **TA-C4.** Every reply is ephemeral and uses `allowedMentions: { parse: [] }`.
  - DB-sourced text is limited to id8, dept, status and the title (and the note, under option b). The title and note go through `escapeCardText(value, max, secrets)`, which masks before the cut, folded to one line.
  - The whole `/task list` reply is bounded below 2000 characters. Rows are dropped from the end and "… and N more" is shown. The note is cut to at most 80 characters in the list (F-8).

  Test: a title or note holding a secret, `@everyone`, a role mention and markdown; and a 25-row list of maximum-length rows stays under the limit.

### Cancel
- **TA-C5 (F-2).** The subtree CTE's depth bound is at least the schema maximum of `limits.depth` (20), taken from one shared constant. If any row at the bound still has a child, cancel refuses with E_TOO_DEEP (fixed text).

  Test: a 12-level chain is fully cancelled, and a chain past the bound is refused.
- **TA-C6. Lock order inside `Approvals.adminCancel`, one transaction:**
  1. Lock the root `FOR UPDATE`.
  2. Run the CTE.
  3. Lock the S task rows `ORDER BY id FOR UPDATE`.
  4. Re-run the CTE AFTER those locks, then compute the digest and compare it with the nonce's digest. A mismatch, or a different set, gives E_STALE.
  5. Lock the batches of S `ORDER BY id FOR UPDATE`.
  6. Expire the pending approvals of S.
  7. Move S to `cancelled`.
  8. Run `blockWaiters`.
  9. Update the batches.

  The S row locks block new child inserts, through the FK KEY SHARE lock, until COMMIT. Locking batches before approvals matches `joinIn` (F-1).

  Test: a child created between the confirm and the click gives E_STALE.
- **TA-C7 (F-1).** An `open` batch of S leaves `open` only with `items_digest` set. Compute it as `sealIn` does, over the members under the batch lock, then move it to `dissolved`. Do not use the spec's CASE as written. `sealed` becomes `dissolved`; `posted` becomes `closed`. A `markPosted` that loses to the flip leaves a card whose buttons answer stale. That is acceptable, but test it.

  Test: cancel with one batch in each of the states open, sealed and posted succeeds. A concurrent `join` on the same task either joins before the lock (and its approval is then expired) or is refused, with no deadlock across 50 runs.
- **TA-C8 (F-3).** A child must never be created under a cancelled parent. `TaskRepo.insert`, when `parentId` is set, refuses when the parent is `cancelled`. Every path goes through it: `create_task`, the loop delegation and the conversation creates.
  - The check must still hold after waiting on a lock. Either take the parent row `FOR SHARE` in the same transaction before the INSERT, or put `FOR SHARE` in the EXISTS subquery so READ COMMITTED re-evaluates the row.
  - A refused insert returns a tool error ("the parent task was cancelled"); it never throws past the tool.
  - Only `cancelled` is refused, not `done`. Refusing `done` would change today's "update_task done, then create_task in the same batch" behaviour.
  - Rule 4 step for Gate 2: grep the tests for children created under a `cancelled` parent, and list any assertion this change invalidates.

  Test: a `create_task` racing `adminCancel` (the tool paused just before its INSERT, cancel committed, tool resumed) leaves no open child under the cancelled parent and starts no run.

  The run-start auto-cancel is NOT binding; see Recommendations. Existing paths already end a parent while its children stay open (`update_task` done, a rejected approval in `decideRow`). An auto-cancel would let a model's own `done` cancel children.
- **TA-C9.** Order after COMMIT:
  1. `TaskRuns.abort(S)`, FIRST;
  2. emit;
  3. revoke the web grants (only when the root is in S);
  4. close the cards;
  5. write the audit;
  6. reply.

  `abort` adds every id of S to the cancelled set whether or not a controller is tracked at that moment. Between model calls nothing is tracked, because `callProvider` tracks only the stream.
- **TA-C10 (loop).** The stop checks are:
  - at the iteration top after the halt check;
  - at "if (call.aborted)" (cancelled only when not halted, so a shutdown abort stays `halted`);
  - before each `registry.run`.

  Each check uses `taskRuns.cancelled(task.id)` OR the fresh row status `cancelled` (the row comes back from the `turnsUsed` update after every model call). This is a cross-process backstop.

  `deps.taskRuns` is REQUIRED in the production wiring, not optional. A wiring test proves the app passes it. `track` holds a set of controllers per task id, because owner and mention runs can overlap, and it is untracked in the same `finally` as `deps.halt.track`.

  Test: `stopped: 'cancelled'` with a fixed alert. The second tool in a batch is refused with "task cancelled". A halt abort still says Halted. The `task: null` shutdown test is unchanged.
- **TA-C11 (F-7).** Changes for the `'cancelled'` outcome:
  - It joins `AgentOutcome.stopped`.
  - `finish()` skips the pending-approval footer for `'cancelled'` as it does for `'halted'`.
  - `noteFinal` already returns on any stop.
  - Every `stopped ===` site is reviewed, and `parkInterrupted` stays `'halted'` only.
  - STREAM-1: a cancelled run with a live preview ends the preview with a fixed line through `finalizeStopped` (or an equivalent tested path). No partial model text stays as the final message.

  Test: a stream preview interrupted by cancel.
- **TA-C12 (OQ-5, F-6).** The admin `reason` rules:
  - Optional, at most 200 characters (the Discord option and a server check).
  - Masked with `redactText(…, secrets)` BEFORE the cut, then folded to one line.
  - It may appear in the ephemeral reply, in the audit `outcome` (masked, capped by `createAudit`), and in the posted "Subtask cancelled" message through `escapeCardText` with `noHandles: true`.
  - It must NOT enter the text passed to `noteReport`, `rolledText`, `logDirect`, or any roll-up or model input. The report text stays the fixed "… was cancelled by a Bot Admin."
  - It never goes to pino logs.

  Test: a reason holding a secret and a handle, and a check that the noteReport entry contains no reason text.

### Migration 036 and the blocked note (option b)
- **TA-C13.** 036 up must use the plain `ALTER TABLE tasks DROP CONSTRAINT tasks_blocked_reason_check;`, with NO `IF EXISTS`. A wrong name then fails the migration transaction instead of leaving the old CHECK active, which would block `'owner'` at run time.
  - The CHECK is re-added with `'owner'`.
  - Add `blocked_note text CHECK (blocked_note IS NULL OR char_length(blocked_note) <= 300)` and the backstop `CONSTRAINT tasks_blocked_note_owner CHECK (blocked_note IS NULL OR (status = 'blocked' AND blocked_reason = 'owner'))`.
  - Down drops the backstop first and keeps the spec's order.

  Test: migrate up, down and up on PostgreSQL 54329; insert `'owner'`; prove a stale note on a non-blocked row is rejected.
- **TA-C14 (F-4, global rule 8).** Every writer of `blocked_reason` also writes `blocked_note`:
  - `TaskRepo.update` sets it to NULL whenever it clears or sets a reason other than `'owner'`;
  - `TaskRepo.unblockHalted` sets it to NULL;
  - `governance/approvals.ts` `move()` adds `blocked_note = NULL`.

  A grep test fails if any SQL in the repo writes `blocked_reason` without `blocked_note`.

  Test: cancelling a task blocked by `'owner'` succeeds (the `move()` path under the backstop CHECK).
- **TA-C15 (F-5, global rule 9).** The note is model-written data:
  - It is masked with `redactText(…, secrets)` BEFORE the 300 cut and before storage, then folded to one line.
  - It is NOT added to `taskCols` or the `Task` type. Only `TaskRepo.listOpenAdmin` reads it, for `/task list`.
  - The STORED column is never read into any prompt, roll-up, handoff line, board or `ownTasksHeader`.
  - Display-time `escapeCardText` is applied again.
  - The EVENT summary is a different matter: it is the same text, carried on `task.changed`. It may appear in the "Subtask blocked" post, the room line and the card field, and may reach the parent's head-conversation roll-up through `reportEnded` → `noteReport`. That is allowed only after the existing taint copy ("if (tainted && !parent.tainted)"), which is today's mechanism for done summaries. It is masked before the 300 cut, as G2TT-02 requires.

  `update_task` blocked writes `{ status: 'blocked', blockedReason: 'owner', blockedNote }` with the optimistic `task.status`. The `superRefine` minimum is 5 characters after trim.
- **TA-C16.** Retry and list treat a NULL reason (legacy rows) and `'owner'` the same. The `task.retry` audit `tool` is `owner` for both.

### Retry
- **TA-C17.** Retry refusal order and the move:
  - Order as in the spec: E_HALTED, then E_NOT_BLOCKED, then E_TREE_ENDED, then the reason rules.
  - The move is `update(id, {status:'todo', ...}, 'blocked')`, where null means E_STALE.
  - The spec text is corrected: for `budget`/`approval`, retry re-blocks at once with `budget` when the tree's last decided cap approval was rejected or expired (`capHit`). A human cap rejection is never overridden. The reply says: "Queued; it will block again unless the cap was raised or a new cap approval is granted."
  - `reset_turns` is audited as `ok reset_turns`.

  Test: retry after a rejected cap re-blocks and starts no provider call.

### Done (OQ-3), now fully specified
- **TA-C18. AuthZ.** `/task done task:<id>` follows TA-C1 exactly. It is a two-step confirm like cancel, with `taskadm:done:<nonce>`, because done is terminal (`LOCKED` for models) and starts a parent roll-up that costs model spend.
  - Digest: `id:status:updated_at` of the target plus its open-children count.
  - The confirm card shows id8, dept, status, owner, the masked title, the parent id8 and the parent status, and whether a parent roll-up will run.
- **TA-C19. Refusals**, in this order, all with fixed text:
  1. E_HALTED: halted. Done starts a roll-up run, and the posts are halt-gated.
  2. E_NOT_REVIEW: status is not `review`.
  3. E_OPEN_CHILDREN: `countOpenChildren > 0`. Accepting would leave live children whose roll-ups hit `NO_ROLLUP`.
  4. E_PENDING: the task has pending approvals.
  5. E_RUNNING: `TaskRuns.active(id)`, or the scheduler `KeyedLock` already holds the task id. Add a `busy(key)` query to `KeyedLock`; never wait for the lock without a bound inside an interaction.
  6. E_STALE: digest mismatch.
- **TA-C20. The move runs inside the scheduler**, through a new `Scheduler.adminAccept(taskId, userId)`, under `this.locks.run(taskId, …)`, the same lock `settleReview` and the reroute attach use (RR-C5).
  - Under the lock: re-check open children = 0, then run `tasks.update(id, { status: 'done' }, 'review')`; null gives E_STALE.
  - Then emit `task.changed { from: 'review', to: 'done', summary: 'Accepted by a Bot Admin.' }`, a fixed code-written summary.
  - No admin free text, no dept notes, no reflection, and no `task.ready`.
- **TA-C21. Roll-up path.** The existing `handleChanged` → `reportEnded` path, with no new spend gate bypassed. It covers:
  - the parent post, "Subtask done";
  - the roll-up only when the requester is not human and the parent is not in `NO_ROLLUP`;
  - the off-day hold through `orWorkday` / `noteHeld`;
  - the taint copy from the child and its final report to the parent;
  - the roll-up run itself, which goes through the normal budget, cap, turn and OT gates.

  Test: done on a delegated child starts exactly one parent roll-up. Done on a human-requested or root task starts none. Done on an off day is held.
- **TA-C22. Root done.** TG-C18 revokes the task grant (`root_ended`, existing). Also call `WebGrantRepo.revokeRoot(rootId, by)` with reason `admin`, the same as cancel. That is housekeeping only, because consume already refuses an ended root.
- **TA-C23. No model access.** No tool, AdminOp, config key or Praw entry. The only model-visible text added is the fixed summary "Accepted by a Bot Admin." and the fixed cancel line.
- **TA-C24. Audit** (ids and codes only; titles and notes never):
  - `task.done`: actor `user:<id>`, taskId, outcome `ok` | `refused:<code>` | `stale` | `error`.
  - `web_grant.revoke`: outcome `admin #<gid>`, when the target is the root.
  - Plus the spec's cancel and retry rows.

  Pino logs carry ids and codes only.

## Recommendations (not binding; owner options)

- **Run-start orphan sweep.** `runOwnerInner` and the roll-up start could cancel, instead of running, a `todo` task whose parent or root has ended, auditing `task.cancel.orphan`.
  - It would also catch older orphans and any created before TA-C8 shipped.
  - Plain-words effect: a model that marks its own task done, or a human who rejects a parent's approval, would then also stop that task's not-yet-started subtasks, but not the ones already running. Choose it only if that behaviour is wanted.
- **`/task done` and roll-ups.** `/task done` could also refuse while a roll-up is queued for the task (`this.rollups.has(id)`), the same guard as `settleReviewLocked`. Otherwise accepting a conversation task that is waiting for a roll-up drops the person's summary. This is functional, not security.

## Who can trigger what (global rule 10)

- **Cancel, retry and done:** only a member holding the Bot Admin role at the moment of the click, in #⚙️-setting.
- **Models:** no path. A model can already move its own task to `review`, `blocked` or `done` through `update_task` (owner-only, `LOCKED` respected). The new commands do not widen that.
- **Who a cancel can hurt:** a malicious or mistaken admin can cancel up to 50 tasks per confirm, and can repeat that. This is accepted as admin power, and it is audited.
- **Retry:** cannot bypass a human cap rejection (`capHit`). It cannot bypass approvals either, because a rejected tool approval cancels the task and retry only acts on `blocked`.

## Residual risks the owner must accept (plain words)

- **R1.** A tool that is already running when cancel lands finishes its work. Examples are a file write, a ClickUp update or a deploy step. Only the tools after it in the same model step are stopped.
- **R2.** Cancelling a task does not undo anything it already did. Files, posts and external changes stay.
- **R3.** Old approval cards for a cancelled task stay visible in Discord. Clicking them only says "already decided". Old web-grant Revoke buttons say "Already revoked."
- **R4.** If you cancel the last open child of a conversation task that is waiting in review, that conversation may close or run one final summary on its own. This is today's behaviour, and you accepted it (OQ-2).
- **R5.** The stop signal for running work is held in this app's memory. If the app restarts at the exact moment of a cancel, the in-memory signal is lost. The database status still stops the run after its current model call, and nothing restarts a cancelled task.
- **R6.** A Bot Admin can cancel up to 50 tasks per confirmation, and can retry a turn-limited task with a full fresh turn budget. Both actions are logged with the admin's user id, but they are not limited further.

## Missing context

- `<PROJECT_ROOT>/CLAUDE.md` (deleted 2026-11-08 by the owner).
- `<PROJECT_ROOT>/.claude/rules/security.md` and `BOT/Assistant/.claude/rules/` do not exist.
- `~/.config/assistant` was not read, as instructed.
- The live `tasks` catalog was not read. The test DB had no tables. The constraint name was proven by migration history plus a rolled-back temp-table reproduction (TA-C13 is the safety net).

## Files audited (md5 at end of review)

The spec md5 in the list was taken before the "Amendments after Gate 1" section was appended. After the amendment, the spec's md5 is `d37f6083bc986d05e5722de634f0b6b0`.

```
7cc0a9aea7ba3cf48d309a5c24a632d6 docs/superpowers/specs/2026-11-09-task-admin-design.md
6d9b99fbd211add9b28793ed3067322f discord/commands/index.ts
cb2ca1c57434f8ab63758aa27e5380b3 discord/commands/register.ts
3b39a5213014fc6d1b113d9ca7ccbec0 discord/praw/definitions.ts
f23028376beef28f575af7379e6115ce app-start.ts
60f0dd6ec82f5c6ea8d455653b28d7b2 app.ts
fe7487bc36fece69a5021c83c96c7f1b agents/call.ts
7d5b950ceca095a672238dadb9135c4f agents/loop.ts
b32b0a131b0f4e591ccb1b2268f8bf04 agents/scheduler.ts
a3f88b508dfd7b058957f8c0d73c41eb agents/jobs.ts
66adb9c65c14c3820769de0e64cb766f db/repos/tasks.ts
bc55e80e659bdd047d3e0bfce5ea30c0 db/repos/approval-batches.ts
deb3dfa5314ce2f310f10fc10caca1d9 db/repos/task-grants.ts
d3c17954b12fddea775f671e2cc1d797 db/repos/web-grants.ts
96256f8d73334fc34ec553c2043f2caa db/repos/ot-requests.ts
a7bf423952e4e76daeccbc797af2c16e db/repos/ledger.ts
a8ef7841d6d63e760b2fcd98b4a73b9c governance/approvals.ts
d1eced2ced6a2340fcc0e6f1cfc54e03 governance/halt.ts
8cde4ec8a092e8e826df74f87baaf282 governance/limits.ts
0457af552b25c19e177664bda7666ba6 config/schema.ts
bfb9e8b9dd8981cedf5ec3db99b9f252 tools/builtin/updateTask.ts
23260722b896c2cd8081213eedd89108 tools/builtin/createTask.ts
15a76cd4bf691fcdc5dac0cba942a2c9 discord/embeds/approval.ts
5f6a9ca5bbf16aa7464d45d299dae3df db/migrations/001_init.up.sql
035182339a9579a2854834c3c07fff64 db/migrations/003_blocked_reason.up.sql
5df2364b42572ffc6bb5e3c148b04f0a db/migrations/026_approval_batch.up.sql
81420f4c3cd25f9027b5e66fe5abc115 db/migrations/027_web_grants.up.sql
4b738339e1d1a6a1a5b8db6381f66e93 db/migrations/035_task_grants.up.sql
aafaa83adba564c54e328466c488c76e db/migrate.ts
```

## Owner sign-off

Pending: residuals R1 to R6.

## Owner sign-off (2026-11-09)
Owner accepted residuals R1–R6. Answer: "รับได้ ทำต่อ". The optional run-start orphan sweep is NOT taken. Build proceeds under TA-C1..TA-C24.
