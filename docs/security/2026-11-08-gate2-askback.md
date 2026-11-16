---
title: "Gate 2 — ASKBACK-1 two-way ask/answer between task owner and requester (TEAMTALK phase 2, H5)"
task_id: ASKBACK-1
gate: 2
status: APPROVED
gate1: docs/security/2026-11-08-gate1-askback.md
spec: docs/superpowers/specs/2026-11-08-askback-design.md
migration: 033_task_questions
last_updated: 2026-11-08
---

# Gate 2 — ASKBACK-1 (code audit)

**Verdict: APPROVED after the final re-check (§9). The first pass was CONDITIONAL_APPROVE.**

Who may ask, who may answer, which question, the caps and the taint are all decided from DB rows and code. The model passes text only.

- Every state change is one conditional UPDATE.
- The wake tool list is enforced at dispatch.
- Every code line is redacted, neutralised, defanged and posted `noHandles`.
- The resume claim is taken inside the child's task lock.

The audit found three Low defects and fixed each with a small isolated edit:
- G2AB-01: an AB4 hole on the Praw slash path.
- G2AB-02: the wake consumed the parent's approved-call outcomes.
- G2AB-03: head-of-line starvation in the resume sweep.

One Low finding stays open as a condition:
- G2AB-04: `bootClose` is unscoped, so a second boot close can strand live questions.

Code is cited by function name plus a quoted fragment. Line numbers are not used.

## 1. Gate 1 conditions (AB1–AB13): verification

| AB | Result | Code evidence | Tests |
| :--- | :--- | :--- | :--- |
| AB1 who can be asked | PASS | scheduler `askRequest`: `if (req0.kind !== 'head' \|\| !task.parentId) return no('noRequester')`, `!sameActor(req0, parent.owner)`. Human path: `task.parentId !== null \|\| !SNOWFLAKE_ID.test(req0.userId)`. Also `isConversationTask(task)` → noRequester | askback.int "AB1 who can be asked" (persona requester, requester ≠ parent owner, bot root, human root / conversation, parent thread and open); (1b) persona-owned child asking its head |
| AB2 restart (option b) | PASS, with condition G2AB-04 | app-start `taskRecovery` `once()`: `await Promise.all([d.scheduler.bootAsk(), d.tasks.resetDoingToTodo()])` runs before `for (const t of await d.tasks.listByStatus('todo')) void d.scheduler.onTaskReady(t.id)`. repo `bootClose` closes open rows `moot` + `resumed_at` and claims closed-unresumed rows. `askTick` is gated by `askBooted` | askback.int AB2 `it.each(['pending','asked','answered'])`; "the tick stays off until the boot close ran" |
| AB3 one owner run per answer (alternative taken) | PASS | `askAnswer` posts 💬 as `child.owner` (inert, `authorIsOwner`). `askUp` → `resumeOwner(after, 'answer')` → `resumeRun`: `if (!(await qs.markResumed(questionId))) return;` inside `exclusive(t0.id, …)` after the `doing` check. The tick resumes closed-unresumed rows after 60 s | askback.int "AB3 resume claim" (Praw owner waits for a slot; answer path vs tick race); router.test "AB3 alternative: the 💬 line … routes nowhere" |
| AB4 an asking run posts nothing | PASS after fix G2AB-01 | loop: `if (run.asked) { … ASK_REFUSALS.ended …}` and `return finish({ … asked: true })`. scheduler `deliver`: `if (outcome.asked) return null;`. `deliverStreamed` / `runMessage`: `finalizeStopped(ASKED_LINE, …)`. `noteFinal`: `outcome.asked`. Praw slash `outcomeReply` (fixed here) | loop.askback AB4 ([respond, ask], [ask, create_task]); askback.int AB4 (i) owner run, (ii) person-triggered, (iii) streamed |
| AB5 wake allowlist at dispatch | PASS | loop `allowedFor`: `if (trigger.askWake) return deps.ask ? ['answer_subtask', ...names.filter((n) => … deps.tools.kindOf(n) === 'read')] : []`. The same function feeds `tools` and `toolBase.org.toolsFor` (registry dispatch). `kindOf` returns `undefined` for kind-less built-ins (create_task, update_task, respond, ask_requester), so they are excluded | loop.askback "a wake run is offered answer_subtask only … registry enforces"; askback.int "`askWake: {` appears in exactly one non-test source file" |
| AB6 resume author and taint | PASS | notices `resumeMessage`: `author: { id: 'system:ask', name: 'ask', kind: 'head' }`, id `ask-${questionId}-${kind}`. repo `answer` stores `answer_tainted = $4`. `answerHuman` stores attachments. `resumeRun`: `q.answerTainted !== false && !task.tainted` → taint. `askUp`: `claimed.questionTainted && !parent.tainted` → taint before the wake | askback.int AB6 (5a), (5a-crash), (5b) "never direct", NULL taint |
| AB7 human path and ping | PASS (router deviation accepted, §2) | `handleMessage` → `humanAskOf(msg, r)` on the admitted routes. It requires `q.requester.userId === msg.author.id`, `sameActor(r.actor, q.asker)` and, for `reply`, `msg.replyToId === q.questionMessageId`. `runMessage` claims via `claimHumanAnswer` inside the lock, right before `this.run`. `answerHuman` sets `resumed_at`. The ping is `post(…, [req0.userId], …)` on the first send only | askback.int (10) (Bot Admin and stranger do not close; reply closes; one run; restart adds nothing); attachment taint; port.mentions "AB7: the human ❓ line pings exactly one id" |
| AB8 wake idempotency and ordering | PASS | `askUp`: `markAsked` claim → child re-read (`moot` with `noResume`) → parent re-read (NO_ROLLUP → `moot` + `requester_unavailable`) → only then `reopen`. `startAsk` re-checks `pending` before `orWorkday` and counts `rollups`. `askJob` `finally { this.unqueue(parentId); … }` | askback.int AB8 (held wake + day turn = one wake; full hold releases count; losing duplicate consumes no OT; child ends in the same instant) |
| AB9 routing and defang | PASS | ⏳ by `task.owner`, parent ❓ by `parent.owner`, 💬 by `child.owner`, all `noHandles: true` with provenance `answer: false`. Tool: `defangHandles(neutralise(redactText(…)))`, then the length check; the port re-applies with secrets (`askText`). Refusals are fixed tables | router.test AB9 / AB3 alt; askback.int "@CFO and a raw user mention …", "provenance answer=false except the human ❓" |
| AB10 halt, switch, config | PASS | `askRequest` / `askAnswer`: `this.d.halt.isHalted()`. `askTick`: `if (!qs \|\| !this.canRun()) return;`. `askEnabled()` read live; the offer is `askOn && …`. `ask.*` are in HANDLER_KEYS with zod int bounds. app.ts refuses `ask.perRoot < 2` | askback.int (11), (12); keys.askback |
| AB11 migration and repo | PASS | `revertAnswer` clears `answer`, `answer_tainted`, `closed_at` `WHERE … answer_message_id IS NULL`. CHECK `task_questions_actors`. `canonicalActor`. `task_questions` is absent from `db/executor-role.ts` | questions.int (transitions, revert, concurrent caps, CHECKs, cascade, 033 up/down/up); migrate.int; keys.askback "not in executor grants" |
| AB12 logs | PASS (Info G2AB-10) | `askUp` logs `{ questionId, taskId, parentId, stopped, costUsd }`; `bootAsk` logs counts; refusals carry keys | askback.int "marker text … never reaches a log line or an incident" |
| AB13 review-close race | PASS | `startAsk` `this.rollups.set(parentId, …+1)`; `askUp` `closeUnlessHeld(parent, true)` | askback.int (14) and "a held wake dropped by a full hold on an off day" |

## 2. Rulings on the build's deviations

1. **`bootAsk` runs concurrently with `resetDoingToTodo` (AB2 said "before"). ACCEPTED.**
   - Both are awaited in one `Promise.all` before the `onTaskReady` loop in `taskRecovery` `once()`, so no **scheduled** owner run starts before the rows are closed.
   - The tick cannot wake or resume before boot: `if (!this.askBooted) await this.bootAsk(); if (!this.askBooted) return;`.
   - Message-triggered runs can start before recovery, because `d.clients.start(...)` precedes `await recover()` in app-start (G2AB-08). That gap is pre-existing for `resetDoingToTodo` and was equally true under the original "before" wording.
   - The tick fallback's second `bootAsk` is the real hazard: G2AB-04.
2. **Conversation tasks cannot ask. ACCEPTED** (a narrowing). `askRequest`: `isConversationTask(task)` → `noRequester`. The tool is still offered to a conversation owner (`askOffered` has no conversation check) and is refused by fixed text, which is harmless.
3. **No router change for AB7: the human ❓ is recorded `answer: true`. ACCEPTED.**
   - RF4 adds a `reply` route only for human authors, only when `msg.replied.author` is one of our bots, and only **after** the WS13 `mayCommand` early return. In a task thread only the root requester or a Bot Admin can route at all, and both could already reach the owner via `task_owner`. No new principal reaches the owner.
   - `humanAskOf` still requires the asked person's id and `replyToId === question_message_id`, so a Bot Admin's reply routes but never answers (tested).
   - The only other consumer of the provenance `answer` flag is reroute's `conv` path (`msg.threadId === null && c.mentioner!.kind === 'head' && c.answer`). It needs a bot mentioner outside a thread, so the in-thread, `noHandles` ❓ cannot reach it.
   - Provenance `userId = ownUserOf({ task })` is the requester, and taint is the asking run's, so RF5 `repliedTaints` treats a reply correctly.
4. **AB1 port tests live in askback.int instead of askRequester.test. ACCEPTED.** The decision is in the port (`askRequest`), and the int tests exercise it against real rows.
5. **AB8 test re-expressed. ACCEPTED.** The four AB8 cases are covered (table above).
6. **`ask.*` has no /settings path. ACCEPTED.** HANDLER_KEYS only. `config_propose` cannot write them (keys.askback).
7. **The wake's final payload is logged only. ACCEPTED.** `askUp` never calls `deliver` or `noteFinal`, and the log line carries ids, `stopped` and `costUsd` only.

Praw prompt: `prompts/heads/praw.md` lists neither tool by name. It has `tools: ["*"]` and the `asking` fragment, so this is not a finding. `allowedFor` drops `answer_subtask` from every non-wake run.

## 3. Findings

| ID | Severity | Evidence | Description | Remediation | Status / owner |
| :--- | :--- | :--- | :--- | :--- | :--- |
| G2AB-01 | Low | `discord/praw/commands.ts` `askCmd`: `deps.ask(msg, { deliver: false, … })` then `return outcomeReply(out)`; same in `discord/praw/ocr.ts` `viaPraw`. `scheduler.runMessage`: `else if (!ask \|\| ask.deliver)` is skipped and `ask?.done(outcome)` hands the outcome back. `org.canDelegate` lets a head delegate to `praw` (`to.dept !== from.dept && this.depts.has(to.dept)`), and the create_task assignee enum is `DEPT_IDS`, which includes `'praw'` (core/env.ts). `syntheticMessage` sets `threadId` when /ask is used in a thread | AB4 hole. /ask, /ocr or /receipt used in a Praw-owned delegated task thread routes `task_owner` to Praw with the task, so `ask_requester` is offered. A successful ask made the slash reply the literal `NO_REPLY` (public). Voice is not affected: `voice/chat/pipeline.ts` builds `threadId: null`, and `askOffered` needs `trigger.task` at run start | `outcomeReply`: `if (o.asked) return ephemeral('Asked a question in the task thread; waiting for the answer.');` | **FIXED in this audit.** A unit test is still needed (backend): `outcomeReply({ asked: true, … })` → ephemeral fixed line |
| G2AB-02 | Low | `askUp` called `const approved = await this.approved(parent, requester)`. The requester equals `parent.owner` (AB1), so `runApprovedCalls` ran and `onModelStart` → `port.delivered(...)` marked the outcomes delivered on the wake's first model call, while the wake's output is dropped | R4 break. An approved tool call's outcome went only to the wake model. The person never saw it, and the parent's next run did not get it (already "delivered") | `askUp` no longer calls `approved()`. The parent's next owner or roll-up run reports them. Halt is still re-checked by `exclusive()` and the loop | **FIXED in this audit** |
| G2AB-03 | Low | repo `staleUnresumed`: `… resumed_at IS NULL … ORDER BY id LIMIT $2`. The caller `resumeOwner` drops rows whose child is not `doing` without claiming them | Rows of ended or parked children (e.g. answered, then the child cancelled before the resume ran) stayed unresumed forever. Twenty of them fill the LIMIT, and the tick then never sees newer stranded resumes (halt mid-resume, held tree) until a restart | SQL now also requires `EXISTS (SELECT 1 FROM tasks t WHERE t.id = task_questions.task_id AND t.status = 'doing')`. questions.int asserts the non-`doing` exclusion | **FIXED in this audit** (repo + one test assertion) |
| G2AB-04 | Low | scheduler `bootAsk` has no once-guard and calls repo `bootClose`, which updates **every** open or unresumed row (`WHERE status IN ('pending','asked')`, no time bound). `askTick`: `if (!this.askBooted) await this.bootAsk();`. If recovery's `bootAsk` failed (transient DB error), recovery still resets and reschedules, and the first successful tick then closes questions created **by this process**, with `resumed_at = now()`. Evidence: untracked `agents/askback.e2e.int.test.ts` (c) calls `bootAsk()` mid-life and a live `asked` row becomes `moot` | The asking child stays `doing` with no wake, no expiry and no resume until the next restart, so the task is stranded. An in-flight wake's answer is refused `closed`. Not attacker-triggerable; needs a boot-time DB fault | Scope `bootClose` to rows created before this process started: capture `bootStartedAt` in the Scheduler constructor and use `AND created_at < $1`, or use a DB `now()` captured by the first recovery pass. Make `bootAsk` a no-op once it has succeeded. Test: a failed first `bootAsk`, a new question, then a tick → the new row stays open and wakes | **OPEN, CONDITION** / backend |
| G2AB-05 | Low | `resumeOwner` / `resumeRun`: `if (!child \|\| child.status !== 'doing') return;` with no claim | A closed, unresumed row whose child is parked (`todo` / `blocked:halt`) stays claimable. When recovery re-runs the owner (`todo`→`doing`), that run already reads the 💬/⏳ lines. A tick during or after it can then add one more owner run that replays a stale answer | When the child is not `doing`, claim the row (`markResumed`) instead of returning. The next ordinary owner run is the resume, as in AB2(b) | Recommendation / backend |
| G2AB-06 | Info | `askTick`: `for (const q of await qs.stalePending(ASK_PENDING_GRACE_S)) … this.startAsk(q)` | While a wake waits more than 120 s for the parent lock or a Praw slot, every tick queues another `askJob`. `rollups` stays balanced and `askUp`'s claim makes the extras no-ops, but jobs pile up (at most 20 rows per minute) | Keep an in-memory set of in-flight wake ids, and skip `startAsk` for them | Recommendation / backend |
| G2AB-07 | Info | `askUp` re-reads the parent but never checks `sameActor(claimed.requester, parent.owner)` | If the parent's owner changed after the ask (reroute or conversation adoption), the wake runs as a non-owner on the parent. The tool list is still `answer_subtask` + read tools, so there is no privilege gain | Treat it like NO_ROLLUP: `moot` + `requester_unavailable` | Recommendation / backend |
| G2AB-08 | Info | app-start: `d.clients.start(...)` precedes `await recover()` | Before recovery, a requester's reply can claim a human question, and `handleChanged` → `askTaskEnded` → `resumeOwner` can resume an owner. The later reset then adds one more owner run. This is the same window `resetDoingToTodo` already had | Accept; G2AB-04's scoping keeps it from closing new rows | Accepted |
| G2AB-09 | Info | Test inventory | Gaps against the Gate 1 test list: AB2 "owner run in flight at crash" case; AB7(ii) a rate-limited / busy reply leaves the row `asked` (code order verified: the claim is inside `runMessage` after `exclusive` admission); AB5 with a plugin `read` tool offered and a plugin `write` tool refused in a wake (loop.askback covers built-ins only); G2AB-01 unit test | Add the tests | Recommendation / tester |
| G2AB-10 | Info | `this.safe(...)` and `claimHumanAnswer` log `{ err }` | A pg constraint error's `detail` can echo row values (question or answer text). No constraint is reachable with the current slicing and CHECKs, so this is theoretical | Log `err.code` / `constraint` only on ASKBACK paths | Recommendation / backend |
| G2AB-11 | Info | `askRequest` checks halt at entry, then posts; `askAnswer` likewise | Halt can land between the check and the post (milliseconds). T11 is satisfied at call time | Accept | Accepted |

## 4. Domain checklist

| Domain | Result | Note |
| :--- | :--- | :--- |
| Requester binding / answer privilege | PASS | DB row requester, `askWake.questionId` set only in `askUp`, repo `answer` `WHERE id = $1 AND status = 'asked' AND requester = $2::jsonb`; human path id + route + asker checks |
| Wake dispatch allowlist | PASS | One `allowedFor` for offer and dispatch; kind-less tools excluded |
| asked / NO_REPLY suppression | PASS after G2AB-01 | owner, human, streamed, resume, roll-up, rhythm (postOnly cannot ask), admin (cannot ask), Praw slash (fixed), voice (cannot be offered) |
| Resume exactly-once / claim races | PASS (G2AB-04/05 open) | `markResumed` in lock; `answerHuman` sets `resumed_at`; tick grace |
| Taint | PASS | both directions, crash window, NULL = tainted, resume never direct |
| Defang / redaction / routing of ⏳ ❓ 💬 | PASS | inert authors, `noHandles`, provenance `answer:false` except human ❓ |
| Human ping scope | PASS | one SNOWFLAKE id from the root row, first send only, `parse: []` |
| Caps / advisory lock | PASS | `pg_advisory_xact_lock(hashtext('task_questions'))`, concurrent-create test |
| Halt / off-day / OT | PASS | halt refusals, tick gated, `orWorkday` + `treeHeld`, pending re-check before OT |
| Boot race | PASS with condition G2AB-04 | §2.1 |
| Migration 033 | PASS | CHECKs, partial unique, cascade, clean down, no executor grant |
| Logs | PASS | ids only (G2AB-10 Info) |
| Secrets | PASS | no secrets added; `redactText(…, secrets)` on every stored text |
| Reasoning isolation | N/A | no new model-output channel beyond redacted, capped tool text |
| Native memory, containers, supply chain | N/A | TypeScript only, no new dependencies or images |

## 5. Runs

- `npx tsc --noEmit -p .`: exit 0, after the fixes.
- Unit, whole project (`vitest run --project unit`): 297 files, 3782 passed, 2 skipped, after the fixes.
- Int, targeted (`agents/askback.int`, `db/repos/questions.int`, `db/migrate.int`, `db/executor-role.int`): 4 files, 89 passed, after the fixes.
- Int, `agents/askback.e2e.int.test.ts`: **red** (11, then 5 of 11 failed across two runs).
  - The file is untracked and was being edited during the audit (mtime 23:04). It is not in the brief's test list and does not gate this verdict.
  - Classified:
    - (h) is a test bug: the posted ⏳ / ❓ lines legitimately carry the question text, which contains "PWNED".
    - (c) calls `bootAsk()` mid-life and moots a live row, which is evidence for G2AB-04.
    - (i) is likely counting the `no_answer` resume as a second owner run (not proven).
  - Unclassified: (a) and (g).
  - It must be green, or removed, at the final run.

## 6. Fixes made in this audit

1. `discord/praw/context.ts` `outcomeReply`: `if (o.asked) return ephemeral('Asked a question in the task thread; waiting for the answer.');` (G2AB-01).
2. `agents/scheduler.ts` `askUp`: removed `const approved = await this.approved(parent, requester)` and its spread into the wake trigger (G2AB-02).
3. `db/repos/questions.ts` `staleUnresumed`: `AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = task_questions.task_id AND t.status = 'doing')` (G2AB-03). Test: `db/repos/questions.int.test.ts` "expiry, stale pending and stale unresumed selectors" now asserts the exclusion, then sets the child `doing`.

All three edited files were re-scanned after the edit, and `tsc`, the unit suite and the targeted int suites were re-run green.

## 7. Conditions to close (re-check at the final run)

1. **G2AB-04** fixed, with the stated test.
2. The G2AB-01 unit test is added.
3. `agents/askback.e2e.int.test.ts` is green, or removed from the tree.
4. Recommendations G2AB-05, -06, -07, -09 and -10 are done or explicitly deferred by the owner.

## 9. Final re-check (2026-11-08)

| Item | Result | Evidence |
| :--- | :--- | :--- |
| G2AB-04 | CLOSED | repo `bootClose(before: Date = new Date())`: both UPDATEs add `AND created_at < $1`. scheduler `private readonly startedAt = new Date()`; `bootAsk`: `if (this.askBooted) return;` then `qs.bootClose(this.startedAt)`. Tests (askback.int "G2AB-04 boot close is scoped …"): a failed first bootAsk, a new question, then the tick → the new row stays open and wakes, the old row is closed, and a later bootAsk is a no-op; OBS-1 (a question created before bootAsk finishes is not closed). The AB2 restart test backdates `created_at` |
| G2AB-01 test | CLOSED | discord/praw/praw.test.ts "ASKBACK-1 G2AB-01: /ask in a Praw-owned delegated thread whose run asked a question"; `outcomeReply` fix unchanged |
| G2AB-05 | CLOSED | `resumeOwner`: `if (!child \|\| child.status !== 'doing') { await qs.markResumed(q.id); return; }`. `resumeRun` (inside the lock): same claim before `return`. A halt is refused by `exclusive` before the body, so a halted resume is not claimed. Test "resumeOwner with a parked child claims the row and runs nothing; a later doing child is not resumed with the stale answer" |
| G2AB-10 | CLOSED | `safeAsk` logs `errName`, `code` and `constraint` only, and is used on the ask paths (`ask ended`, `ask wake`, ASKBACK `handoff` edits). `claimHumanAnswer` logs `{ questionId, errName, code }` |
| e2e suite | GREEN | agents/askback.e2e.int.test.ts 12/12 on 3 runs here (unchanged since the first pass, md5 `a454ce6a…`) |
| G2AB-06, -07 | OPEN, Info | Not blocking: the extra jobs are no-ops, and the wake's tools stay `answer_subtask` + read |
| G2AB-09 | Partly closed | The G2AB-01 test was added; the AB2 in-flight, AB7(ii) and AB5 plugin-tool cases are still Info |
| G2AB-12 (new) | Info | `startedAt` is the app clock, while `created_at` is the DB clock. With the app ahead of the DB, a question created within the skew right after boot could be closed by the boot pass (the child then waits for its next ordinary run). The DB runs on the same host, so the skew is about 0. Optional: take the bound from `SELECT now()` at construction or first boot |

Runs at re-check:
- `npx tsc --noEmit -p .`: exit 0.
- Int: `agents/askback.int`, `agents/askback.e2e.int` and `db/repos/questions.int` gave 3 files, 77 passed. `askback.e2e.int` was run 2 more times, 12/12 each.
- Unit: `discord/praw/praw.test`, `agents/loop.askback.test` and `tools/builtin/askRequester.test` gave 3 files, 41 passed.

**Final verdict: APPROVED.** Only Info items remain open (G2AB-06, -07, -09 remainder, -12).

## 8. Files audited (md5 at the final re-check)

```
80b2603d3dc09375fbf52698ff733ab6 db/migrations/033_task_questions.up.sql
3b7f76da0abf45b3ca00671e80913d80 db/migrations/033_task_questions.down.sql
fadf0748dfa444e5dc4d9791110ee69e db/repos/questions.ts
5d87420db1dffd1992be7b7653a92dca tools/builtin/askRequester.ts
834672e7c295ba8155e1b3598ca3e80e tools/builtin/answerSubtask.ts
806cd432bb4d37a44e46cddaeec85196 tools/builtin/index.ts
23260722b896c2cd8081213eedd89108 tools/builtin/createTask.ts
9e540ddc173aeaa9f82685f073a99ce7 tools/types.ts
6e4a7ad69f26590911df370925e53cfa tools/registry.ts
a8654980b62b1751a13ccde3b120d907 tools/policy-approval.ts
db7fff7387a349480328c970b3995e74 agents/scheduler.ts
c5c5bb65d87e545a5181265add2cbaa3 agents/loop.ts
51e0f957c2be3c7fe2d621062d81681d agents/notices.ts
cb97b58fd9389b6a14ac422d438d10c6 agents/teamtalk.ts
97786105bc4a6b61989389dd50fe3abd agents/context.ts
a641cc0861d2db6e30d9155750e9e488 agents/reroute.ts
278c470c944459c9f32bc1154804fb59 agents/approved-tools.ts
0fd5e40be2fcdf5430f11bb6b047392b company/router.ts
5f306c5e50c0bcf10716138423779e13 company/org.ts
d5f4d90d7dcf1f572d0a2127c386f5c9 config/schema.ts
41ec7f62d34e54c5c6b7c526e30794d2 config/defaults.ts
9529735a0d0bd5221c597512b619e8a7 admin/keys.ts
20400da15b00d188056b8a267eaf4735 db/executor-role.ts
43d00e6efe0efce909594967ec75451e app.ts
f23028376beef28f575af7379e6115ce app-start.ts
d2064eb53c5bb165b042f855828dc62d discord/port.ts
ccd90b5bb8bbf7cc0c821aae090028ac discord/reply-stream.ts
d61bb62c86bcf65ac1d2aceff6557193 discord/commands/types.ts
e8cdf4664dc44fe7ec1eeb61b7dc96fd discord/praw/context.ts
356e5f87ff3f780ea59feb6766d32aaf discord/praw/commands.ts
e5de524324cad6177427dfb115e319dc discord/praw/ocr.ts
06eff0a2579545ebb55b59f9fce9248f voice/chat/pipeline.ts
94f89cba2e62ee7176fecd6c3e0d3648 prompts/fragments/asking.md
9b0b2a9d34ee594ec8831bd97cf897c3 prompts/heads/finance.md
f627f82076aa66de2ab08b3033e53bb4 prompts/heads/hq.md
f4a029e0fd9496ad1f2ec41d22104fb4 prompts/heads/hr.md
ced11b997265fed2aad1ae2e92b86fb2 prompts/heads/it.md
446be8449cbc97aa8a29db9b2356841b prompts/heads/marketing.md
02d0b66c3c2657b0544df9c3b17b7574 prompts/heads/ops.md
00649d13129aa80bdf93ea1c7d16fcf5 prompts/heads/praw.md
d40aeb73a65d3d3210dbacd986c71bff prompts/heads/rnd.md
ab356a08370b85e71c463b998bf994c0 prompts/heads/sales.md
ee1b27d97c01caa2919afca57b397497 prompts/heads/software.md
8281e16f86b69cf616f06de52a751932 prompts/members/ceo-business-advisor.md
6ad5365865ded575142d2bb5bbd2ad7f prompts/members/code-reviewer-qa.md
baf2d053bd1766d9310187dca8054c29 prompts/members/innovation-brainstorm.md
3f47dc572d863c4cc82d7ac8c6ac2e4f prompts/members/legal-and-contracts.md
e7887d2a52c38500c92db26eb2a457de prompts/members/pair-programmer.md
6a7feccb83b082bb66474b65a7b6e765 prompts/members/project-admin.md
da5c9e337a76d0a578cd109cd714bccf prompts/members/project-manager.md
936471db4775c3cf942808b94cb3b013 prompts/members/research-scientist.md
b2f3daf6735ec21df2dde8d1ed7e7707 prompts/members/system-analyst.md
a3edda6d443db300ccda86fd93433f71 prompts/members/ux-ui-consultant.md
70873997c93aa5a9b5e2b7842cd43909 agents/askback.int.test.ts
86497f7416266a5381d76183364ef8d5 db/repos/questions.int.test.ts
27b551e30528d75b231af5d4ebf68437 agents/loop.askback.test.ts
19cfef9af5faf3d38184cbfdf72ded79 tools/builtin/askRequester.test.ts
324a44d2c67284326cbfb45d3c75f094 admin/keys.askback.test.ts
47d594801631b3d07933b363cb796fb5 company/router.test.ts
371d1341285c5708cbf816a376557d23 discord/port.mentions.test.ts
7c9e73ac207164d5869d87ae161ad0fc discord/praw/praw.test.ts
f37f1154db075b24e95be110a387694a prompts/loader.test.ts
ba99f41fda6130f8fe5da162a0557002 tools/registry.test.ts
bab20aeff9c33ad31f5188b837cc6ec6 agents/loop.behaviour.test.ts
a454ce6a4f20980c7882682ad0a4bcb7 agents/askback.e2e.int.test.ts
9dc5c4695dcaace9568bda3391445e4c docs/superpowers/specs/2026-11-08-askback-design.md
```
