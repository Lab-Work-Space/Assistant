---
title: "Security Gate 2: Bot Admin task administration (TASKADMIN-1)"
gate: 2
status: APPROVED (re-check, fix round 1; was CONDITIONAL_APPROVE)
date: 2026-11-09
task: TASKADMIN-1
project: labworkspace (BOT/Assistant)
gate1: docs/security/2026-11-09-gate1-task-admin.md
spec: docs/superpowers/specs/2026-11-09-task-admin-design.md
---

# Security Gate 2: `/task list | cancel | retry | done`, `taskadm:` buttons, migration 036

Verdict: **CONDITIONAL_APPROVE**.

The authorisation boundary is met. `/task` and `taskadm:` are reachable only through `decide()`, with the guild, #⚙️-setting and the live Bot Admin role checked. There is no tool, AdminOp, config key or Praw path.

The rest of the design also holds:
- The nonce is single use and bound to the user, the subcommand, the target and the digest.
- Every SQL value is a parameter.
- Migration 036 drops the old CHECK without `IF EXISTS` and adds a backstop that holds.
- TA-C8's `FOR SHARE` re-check refuses a child under a cancelled parent after waiting on a lock.
- The loop stops at all three check points.
- The admin reason never reaches `noteReport`, `logDirect` or a roll-up.

Two binding conditions are not met in substance:
- G2-01 breaks TA-C7's "no deadlock".
- G2-02 breaks TA-C15's "masked with the secret list BEFORE the 300 cut".

Both are Low, both have small fixes, and neither exposes data. Fix them test-first, then send them for a re-check. There is no other blocker.

## Findings

| ID | Severity | Evidence (content anchors; line numbers are hints) | Issue | Remediation | Owner |
|---|---|---|---|---|---|
| G2-01 | Low (availability) | `db/repos/approval-batches.ts` `joinIn`: "FROM approval_batches WHERE task_id = $1 ... state = 'open' FOR UPDATE", then `sealIn`, then "INSERT INTO approval_batches (task_id, requested_by)" (`026` "task_id text NOT NULL REFERENCES tasks(id)"). `governance/approvals.ts` `adminCancel`: "SELECT id FROM tasks WHERE id = ANY($1) ORDER BY id FOR UPDATE", then "SELECT id, state FROM approval_batches ... ORDER BY id FOR UPDATE". | When the open batch is over its window or full, `joinIn` holds the batch lock and seals it. Its INSERT of a new batch then takes the FK KEY SHARE on the task row, which `adminCancel` holds FOR UPDATE. `adminCancel` meanwhile waits on that batch, which is a lock cycle. A probe on test PostgreSQL 54329 (private schema, raw SQL, same lock sequence) returned `['join 40P01', 'cancel ok']`. Postgres usually aborts the join. `enqueue` then posts a solo card for an approval that the cancel expires, and clicking it says "already decided". If the cancel is the victim, it rolls back, is audited `error`, and the admin runs it again. The cost is a stall of about 1 s, not a hang and not a leak. The 50-run test never takes this branch, because its batch is never over the window or full. | Choose one fix. (a) `joinIn` takes `SELECT 1 FROM tasks WHERE id = $1 FOR KEY SHARE` before it locks the batch, so both paths take the task first; check `decideBatch`'s order first. (b) `adminCancel` retries its transaction once on 40P01. Either way, add a test that ages or fills the batch (window 0 or `BATCH_MAX_ITEMS` members) and then races `join` against `adminCancel`. | backend |
| G2-02 | Low | `tools/builtin/updateTask.ts` `blockedText`: "redactText(s).replace(/\s+/g, ' ').trim().slice(0, BLOCKED_NOTE_MAX)". There is no secret list, because ToolContext deliberately has none. The literal mask happens only after this cut: `TaskRepo.maskNote` (stored note), scheduler `reasonLine` (post, card, #tasks field) and teamtalk `red` (room line). | TA-C15 and G2TT-02 require masking with `redactText(…, secrets)` BEFORE the 300-character cut. The pattern set runs first, but a literal secret (an env value that matches no pattern) that straddles character 300 is cut, so its prefix is no longer a match for the literal mask and survives in the stored note, the event summary, the card field and the room line. | Drop the `.slice(0, BLOCKED_NOTE_MAX)` in `blockedText` and keep the pattern mask and the fold. The zod schema already caps the summary at 4000, and every consumer masks with the secret list and then cuts. Update the `updateTask.test.ts` assertion "ev.length).toBeLessThanOrEqual(300)" to a consumer-side check, and add a test with a literal secret placed across character 300. | backend + tester |
| G2-03 | Low | `agents/loop.ts` `cancelledNow`: "!!task && (deps.taskRuns.cancelled(task.id) ...)". `openedTask` is assigned by `toolContextBase(... open && (async () => (openedTask = await open())))`. `agents/call.ts`: "task ? deps.taskRuns?.track(task.id, ac)". | A conversation run that starts with no task and opens its conversation task part-way through is never tracked or checked. If an admin cancels that task, the run goes on until it ends. TA-C8 refuses its `create_task` calls, but other tools still run. The confirm then shows "Running now: no". `/task done` is not affected, because the conversation lock makes it answer E_RUNNING. | Check `task ?? openedTask` in `cancelledNow`, and track the stream under the opened id. Or list this case under residual R1. | backend |
| G2-04 | Info | `agents/loop.ts` `cancelled()`: "A Bot Admin cancelled this task.", used whenever the fresh row status is `cancelled`. | A cancel caused by an approval rejection or expiry mid-run is reported as a Bot Admin cancel. The check after the tool batch now runs before `ENDS_TURN`, so the old "This task was cancelled." text is no longer reached. The stop itself fails safe. | Use neutral text when only the row status, not the `TaskRuns` mark, triggered the stop. | backend |
| G2-05 | Info | `discord/commands/task.ts` `taskadmButton`: "if (!n) return ephemeral(STALE);" | Clicks with an expired, reused, forged or wrong-user nonce are not audited. Digest-stale clicks are audited. | Optionally audit `task.<kind>` with outcome `stale`, using `taskId` null. | backend |
| G2-06 | Info | SQL `TaskRepo.acceptDigest` | No integration test calls it directly. The unit tests use the MemTasks fake, which has a different format (see the rulings). | Add one int test showing that the digest changes when `updated_at` changes and when the open-children count changes. | tester |

## Rulings on the declared deviations

1. **Retry ignores `liftsCap('limits.turnsPerTask')`.** ACCEPTED. This is stricter than the spec: an admin with an approved lift still has to add `reset_turns:true`. Nothing is bypassed.
2. **Any mid-run `cancelled` status ends with the fixed alert.** ACCEPTED as fail-safe. The text misattributes some cancels (G2-04, Info).
3. **The MemTasks `acceptDigest` format differs from the SQL repo.** ACCEPTED. It is a test fake only, and the scheduler compares digests only from the same source. Its 12-character cut can drop the open-children digit once `touched` is 10 or more, so it is a weaker oracle; G2-06 covers the SQL side.
4. **Files touched outside the listed scope.** ACCEPTED. Each change serves a condition:
   - `createTask.ts`: the TA-C8 `ParentCancelledError` becomes a tool error.
   - `jobs.ts`: `KeyedLock.busy`, a query that never waits, for TA-C19.
   - `teamtalk.ts`, `notices.ts`, `discord/port.ts`: show the blocked reason, as spec 3.4 and TA-C15 require.
   None of them adds a model path.
5. **`prompts/fragments/delegation.md` is modified.** No K6 impact.
   - It is not in `PROTECTED_REFS`, which lists only `system/safety`, `system/tool-use` and `fragments/approval-request`.
   - Its mtime is 2026-11-08 13:39, before this task. The added lines (acceptance/due, `warroom_say`, ideas/decisions) belong to earlier features.
   - `prompts/protected.test.ts` passes.
   - It was not reverted.

## Conditions checked (TA-C1..C24)

| Condition | Result |
|---|---|
| C1 | PASS. There are four `COMMAND_TABLE` rows. `'task'` and `taskadm:` are in `deferEphemeral`. `route()` handles buttons only, after the channel and role checks. Nothing is added to the WS7 branch. A static test checks the tool, AdminOp, Praw and config names. |
| C2 | PASS. The id is matched exactly by `TASKADM_ID`. The nonce is `randomBytes(8)`, bound to the user, kind, target and digest, deleted on every lookup, valid 5 minutes, and capped at 100 with the oldest evicted. |
| C3 | PASS. The regex runs before SQL, with `LIMIT 6`. The options are 6 to 36 characters long. |
| C4 | PASS. Every reply is ephemeral with `parse: []`. Titles and notes go through `escapeCardText(..., secrets)`. The list is bounded on the final text and the note is cut at 80. |
| C5 | PASS. The depth is `TASK_TREE_MAX_DEPTH = 20`, and `tooDeep` gives E_TOO_DEEP. |
| C6 | PASS. The lock order is as specified, and the second walk after the locks is compared against the digest. |
| C7 | PARTIAL. Open batches get a digest and are dissolved, sealed batches are dissolved, posted batches are closed. Fails on the deadlock (G2-01). |
| C8 | PASS. `FOR SHARE OF p` sits inside EXISTS, and a deterministic race test covers it. A `done` parent is still allowed. |
| C9 | PASS. `beforeEmit` aborts first. Then emit, grants, cards, audit and the reply follow in that order. |
| C10 | PASS. There are three check points, plus the fresh-row check. `taskRuns` is required, there is one instance (`app.ts`), and a wiring test covers it. One gap is G2-03. |
| C11 | PASS. No footer is added, and `CANCEL_LINE` goes through `finalizeStopped`. `parkInterrupted` stays halted-only. |
| C12 | PASS. The reason is masked before the 200 cut. It appears only in the posted body and the audit. `noteReport` and `logDirect` get the fixed text. |
| C13 | PASS. The migration has no `IF EXISTS`, adds the backstop, and its down migration drops the backstop first. The up/down/up int test runs green. |
| C14 | PASS. `update`, `unblockHalted` and `move()` all clear the note, and a grep test enforces it. No other raw writer was found. |
| C15 | PARTIAL. The note stays out of `taskCols` and `Task`, and only `listOpenAdmin` reads it. Fails on mask-before-cut (G2-02). |
| C16 to C24 | PASS. NULL and `owner` are treated the same. The refusal orders match the spec. `adminAccept` runs under `locks.run` with a fixed summary. Root done revokes with reason `admin`. Audits carry ids and codes only, and the admin reason appears only in the cancel `outcome`, as C12 allows. |

## Residuals (owner-accepted R1 to R6, plus one note)

Cancel locks and aborts only OPEN rows. An owner run that calls `update_task done` and then `create_task` in one batch can still add an open child under a done node inside a cancelled subtree. TA-C8 deliberately allows children under a done parent, and the owner declined the orphan sweep. This is a residual, not a finding.

## Checks run

- Unit tests (12 TASKADMIN-related files): 241 passed. The K6 prompt tests: 18 passed.
- Integration tests on test PostgreSQL 54329, each file in a private schema: the admincancel, `tasks.admin`, `task-admin`, migrate, web-grants and `tasks` files ran 95 tests and all passed.
- `tsc --noEmit`: 0 errors outside the tester's in-progress `tests/integration/task-admin.tester.int.test.ts`, which has 2 errors (`callsOf`). That file is not part of the audited code.
- `npm audit --omit=dev`: 0 vulnerabilities. There are no dependency changes.
- Deadlock probe: `/private/tmp/claude-501/-Users-pakawat-tan-Desktop-Labworkspace/579c65d8-4b91-4836-a02d-f5c651bf46ea/scratchpad/deadlock-probe.mjs` returned `40P01`.
- Not done, as instructed: no live app, no DB 54330, no `~/.config/assistant`, no build, no commits.

## Fixed in this audit

None. G2-02 changes a test the tester relies on, so it was filed rather than fixed.

## Files audited (md5 at end of review)

```
2b6bb195ec55531e9f4d80933d8ed01a db/migrations/036_task_blocked_note.up.sql
8341c4bf7436ffbf5776f08bbba453ed db/migrations/036_task_blocked_note.down.sql
428b061dc2bbf327bc17d1219465db28 agents/task-runs.ts
a7aa01a3c0ce4875e8336758c3ccb42f discord/commands/task.ts
ad0023f01572ac2a68f33a9aa2448814 discord/commands/task-nonce.ts
30633cc92d2c67f94a3a99beca0ae66b db/repos/tasks.ts
8800753d53afe0a7bf59abeaf8211312 db/repos/web-grants.ts
1a223a083f831eb0723e9d87318f740d governance/approvals.ts
67584262a5362f0c219f9974bde8ae6d core/events.ts
1ea711a903d81b4ffdf0bd623609ac3f tools/builtin/updateTask.ts
5a481dfae5c7d4a958ee3f75c9acb692 tools/builtin/createTask.ts
d21882a519aa1e2ca380c78424377542 agents/call.ts
bc8b88491b7f84fe2afae0435a592dbb agents/loop.ts
cfbe78a4e52675267e541805bde6b230 agents/scheduler.ts
5ce2d8f3b72bc9040f65d9d98ef6781f agents/jobs.ts
063d528dc0a2a2e24b6d31619afbbbc2 agents/teamtalk.ts
e563b932bb194c0698d6802ddcbaf565 agents/notices.ts
42d413eb6bb1efcd1ca0a7b71d676ab4 discord/port.ts
47afa4693f970b0bddd40cc3c56da133 discord/commands/index.ts
e69da1d3c81d156c5663f0817b47f030 discord/commands/definitions.ts
32b87304380b881143c42074c43851d2 discord/commands/types.ts
ffef982c80c6a265126ba1e6ca71999b app.ts
8925fdf72c83743814695468d7d14a18 prompts/fragments/delegation.md
6f96fce54d80bd0bb1e92448a5d3862e prompts/protected.ts
bc55e80e659bdd047d3e0bfce5ea30c0 db/repos/approval-batches.ts
29f0e5284c71d2a404c1a5d12fc66b40 governance/approval-batches.ts
d37f6083bc986d05e5722de634f0b6b0 docs/superpowers/specs/2026-11-09-task-admin-design.md
```

## Missing context

- `<PROJECT_ROOT>/CLAUDE.md` was deleted by the owner.
- No `.claude/rules/` exists in the project.
- The Book index was not opened. This audit relied on Gate 1 and the spec.

## Re-check (fix round)

Date: 2026-11-09. Final verdict: **APPROVED**. G2-01, G2-02, G2-03 and G2-04 are closed, and no new finding blocks.

### G2-01: CLOSED
- `db/repos/approval-batches.ts` `joinIn` now starts with "SELECT id FROM tasks WHERE id = $1 FOR KEY SHARE". The join therefore takes the task before the batch, the same order as `adminCancel`. `governance/approvals.ts` is unchanged (same md5), so no 40P01 retry was added.
- Deadlock probe, new lock order (`/private/tmp/claude-501/-Users-pakawat-tan-Desktop-Labworkspace/579c65d8-4b91-4836-a02d-f5c651bf46ea/scratchpad/deadlock-probe2.mjs`, test PostgreSQL 54329, private schema):
  - join-first: `["join ok","cancel ok"]`
  - cancel-first: `["join ok","cancel ok"]`
  - The old probe (old order) still returns `['join 40P01', 'cancel ok']`, so the probe can still detect the deadlock.
- Mutation check: with the KEY SHARE line removed, the new test `G2-01: a join that seals an aged batch ...` fails with `{ err: '40P01' }`. The line was restored and the md5 checked.
- Checked for a new cycle:
  - Every other path locks a task row before any batch or approval row: `decide`, `decideBatch`, `onTreeCapHit` and `expireOld` lock the root FOR UPDATE first, and `adminCancel` locks the root and then S.
  - `move()` and `blockWaiters()` change tasks only with `UPDATE tasks ... RETURNING`. That takes FOR NO KEY UPDATE, because no PK or full unique column changes (`tasks_reroute_once` is partial), so it does not conflict with KEY SHARE.
  - `TaskRepo.create` takes `FOR SHARE OF p`, which is compatible with KEY SHARE.
  - Result: no new cycle.

### G2-02: CLOSED
- `blockedText` no longer cuts. It applies the pattern mask and folds whitespace. `TaskRepo.maskNote` (unchanged) applies `redactText(raw, secrets)`, then the fold, then the 300 cut.
- I traced every reader of the uncut blocked `task.changed.summary`. Each one masks with the literal list before any cut or post:
  - Scheduler `reasonLine` ("redactText(s, secrets)... .slice(0, max)", 300). Its output feeds `upsertTaskLog`, `refreshCard` (both slice the field to 300), the "Subtask blocked" `text`, which goes to `post`, `noteReport` and `logDirect` (bounded and re-masked at `CONTENT_MAX`).
  - Teamtalk `ended` ("cut(oneLine(this.red(summary)), ROOM_SUMMARY_MAX)", 250).
- The uncut scheduler `summary` and the roll-up are used only when the status is `done`. A blocked summary reaches no model input: `rolled = text` (already bounded) and there is no roll-up. `askTaskEnded` does not read the summary.
- No other subscriber reads it. `app.ts` uses only ids and status. `EventBus` logs only the event name when a handler throws, never the payload.
- Mutation check: making `reasonLine` cut before it masks fails 1 scheduler unit test, so the consumer side is tested. `teamtalk.test.ts` already covers the 250 straddle.

### G2-03: CLOSED
- `agents/loop.ts`: `cancelledNow` uses `task ?? openedTask`. After each batch the opened row is read again ("else if (openedTask) openedTask = (await deps.tasks.get(...))"). The check before each tool and the stop after each batch now cover a task opened mid-run.
- `agents/call.ts`: `trackTaskId` is used only for `deps.taskRuns?.track(trackId, ac)`.
  - `taskId` for the audit rows, the `budget.reserve` `taskId` (first call and retries), `incidents` and the `treeCapHit`/`localCapHit` mapping in `loop.ts` all still come from `task` only.
  - The other callers (`agents/metered.ts`, `knowledge/small.ts`) do not pass it.
  - Budget and audit attribution are unchanged.
- The two `G2-03` tests in `agents/loop.test.ts` pass.

### G2-04: CLOSED
- The loop alert now reads "This task was cancelled. Nothing more will run." The scheduler `CANCEL_LINE` is "-# Stopped: this task was cancelled."
- "by a Bot Admin" now appears only when `e.admin` is set, which only `adminCancel` does.

### Info (new, non-blocking)
- G2R-01 (Info): `blockedText` folds whitespace before the literal mask runs in `maskNote`/`reasonLine`. A literal secret that itself contains whitespace would no longer match. Env and API secrets practically never contain whitespace. No action is required.

### Checks run
- `tsc --noEmit`: 0 errors.
- Unit tests (`updateTask`, `loop`, `loop.behaviour`, `scheduler`, `scheduler.admin`, `teamtalk`, `task-runs`, `discord/commands/task`, `notices`, `metered`, `prompts/protected`): 10 files, 243 tests passed.
- Integration tests on 54329: 9 files, 212 tests passed. The files were `approvals.admincancel`, `tasks.admin`, `task-admin`, `task-admin.tester`, `approval-batch`, `approvals`, `approvals.treegrant`, `tasks` and `loop.int`.
- I re-ran the touched tests after my comment edits: all green.
- Not done, as instructed: no live app, no build, no commits, no `~/.config/assistant`.

### Fixed in this re-check (comments only)
- `db/repos/approval-batches.ts`: the class doc said "a join takes no root or task lock", which is stale after G2-01. It now states the task (KEY SHARE), then batch, then approval order.
- `tools/builtin/updateTask.ts`: the emit comment said "masked and cut", which is stale after G2-02. It now says pattern-masked and uncut, with consumers masking and then cutting.

### md5 of changed files (end of re-check)

```
25eb2bed4a2debd1360fbdc3dc2bdae6 tools/builtin/updateTask.ts
34fcaf83ba7640f120d372c0d35eea0c agents/call.ts
28edce3ea3d8bd4d6bcb36cbd643392c agents/loop.ts
68b59b3a90ee0658d83032263b01b3b0 agents/scheduler.ts
2d0298cf51f81b9a7e83b63484aace00 db/repos/approval-batches.ts
8744740ebd6407487ce735e7c1a56af3 governance/approvals.admincancel.int.test.ts
d150f70830e768bfe71220d515584399 tools/builtin/updateTask.test.ts
c6e8891b54546174ea28d90a85669530 db/repos/tasks.admin.int.test.ts
8ff2eb1bdecd79185a70a3c2de29ff8d agents/loop.test.ts
```

All the other 22 files in the table above match their earlier md5, so none of them changed.
