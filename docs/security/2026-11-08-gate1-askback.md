---
title: "Gate 1 — ASKBACK-1 two-way ask/answer between task owner and requester (TEAMTALK phase 2, H5)"
task_id: ASKBACK-1
gate: 1
status: CONDITIONAL_APPROVE
spec: docs/superpowers/specs/2026-11-08-askback-design.md
migration: 033_task_questions
last_updated: 2026-11-08
---

# Gate 1 — ASKBACK-1 (spec review)

**Verdict: CONDITIONAL_APPROVE.** The overall design is sound:
- who may ask, who may answer, which question, the caps and the taint all come from DB rows and code, never from tool input;
- every post is code-written with `noHandles`;
- question and answer reach the other run only as wrapped untrusted text;
- every state change is a conditional UPDATE;
- the human ping deviation is narrow.

The spec does rest on four assumptions that the current code breaks:
1. "restart → sweep" ignores boot `resetDoingToTodo`.
2. "the tool returns NO_REPLY so nothing is posted" ignores `deliver(..., quiet=false)`.
3. "wake runs have create_task / forward_to / meeting_start filtered out" ignores dispatch-time permission checks.
4. "requester is always a head or Praw" ignores persona delegation.

The gateway-echo design (OQ1) also loses an answer whenever the warroom guard drops the echo, and it can run the owner twice because the echo can arrive before `answer_message_id` is stored. Conditions AB1–AB13 bind the build and Gate 2.

Code is cited by function name plus a quoted fragment. Line numbers are hints only.

Related gates whose conditions stay in force:
- TEAMTALK T1–T14: defang, provenance, `noHandles` postcondition, halt on new paths.
- MENTION-REROUTE RR-C*.
- OT-REQUEST OT-C*.
- REPLY-STREAMING S*.

## 1. Code facts the spec depends on (verified)

| # | Spec assumption | What the code does | Consequence |
| :--- | :--- | :--- | :--- |
| C1 | "Restart, pending row → sweep re-runs the wake; answered with resumed_at NULL → resumeOwner('answer')"; resumeOwner requires "child must be doing" | app-start.ts `taskRecovery` → `once()`: on boot `d.tasks.resetDoingToTodo()` (`UPDATE tasks SET status = 'todo' ... WHERE status = 'doing'`), then `for (const t of await d.tasks.listByStatus('todo')) void d.scheduler.onTaskReady(t.id)` → `runOwnerInner` | Every waiting child (status `doing`) gets a **fresh owner run on every restart**. Then the sweep re-wakes the requester, or `resumeOwner` fails its `doing` check. Then the answer echo runs the owner a **second** time. The fresh run's own ask is refused "open". This is G1-01 |
| C2 | Step 4: "isNoReply ends the run, no further post" | scheduler `deliver`: `if (quiet && !outcome.stopped && isNoReply(outcome.payload)) return null;`. `runOwnerInner` calls `deliver(..., false, ...)`. `runMessage` passes `msg.author.kind !== 'human'`. `deliverStreamed` is a separate path | An owner run started by `task.created` / `task.ready`, by a human message, or by resume posts the literal text `NO_REPLY` in the thread. This is G1-03 |
| C3 | "create_task, forward_to, meeting_start filtered out of wake runs" (offer filter in loop.ts) | loop.ts filters only the offered `tools` (`deps.org.toolsFor(actor).filter((n) => !(noSay && n === 'warroom_say'))`). tools/registry.ts dispatch checks `if (!ctx.org.toolsFor(ctx.actor).includes(name))`, which is the unfiltered list. Only `postOnly` and admin runs override `toolsFor` (`toolBase = trigger.postOnly ? { ...base, org: { ...base.org, toolsFor: () => [] } }`) | An offer-only filter is advisory: a model can call a tool it was not offered (local providers do not enforce the declared tool list). This is G1-04 |
| C4 | "Delegated children always have requester = parent owner … always a head or Praw" | company/org.ts `canDelegate`: `if (from.kind === 'persona') { ... return !!p && to.kind === 'head' && to.dept === p.deptId; }`. createTask: `requester: ctx.actor` | A persona can be a requester (persona → its own head). The spec has the "requester's head client" post 💬, so the post is authored by the **child owner** (the same head). In router `route()`, `authorIsOwner` is true, so nothing routes and the answer is lost. Reroute is consistent: RR-C8 `if (!sameActor(c.mentioner!, c.threadTask.owner)) return 'not_allowed'`, and `conv` adopts the mentioner as owner. Human requesters are roots only (`createHuman` → `this.child(c, dept, plan, null)`). This is G1-05 |
| C5 | Step 12: the answer reaches the owner by the gateway echo, "NO code wake for answers"; step 13: the hook matches `msg.id = answer_message_id`; answered rows are resumed "boot and resume only, never on the tick" | `handleMessage`: `if (wr && msg.author.kind !== 'human' && (this.d.meetings?.isOpen(...) \|\| this.guard.isStalled(wr.key) \|\| this.guard.paused())) routes = [];`. `botTurn` returns on `stalled` / `limited`. Off-day `guard.hold` drops when full. `exclusive` with a Praw owner in `mode: 'refuse'` calls `refuseBusy` and runs nothing. Discord's gateway MESSAGE_CREATE can arrive before the REST `send` resolves, i.e. before `answer_message_id` is written | (a) A dropped echo leaves the row `answered` with `resumed_at IS NULL`. Nothing ever times it out, so the child stays `doing` until a restart, which then hits C1. (b) An early echo misses the id match, so the owner runs but `resumed_at` stays NULL, and a later restart or fallback resumes it **again**. This is G1-02 |
| C6 | Human path: the human's reply "already routes to the owner" | router `route()` P1-B: `if (!addressed && (msg.otherMentions \|\| msg.replyToId)) return [];`. RF4 routes a reply only to a message recorded `answer: true`. The ❓ post is recorded `answer: false` | A person who uses Discord "Reply" on the ❓ message gets **zero routes**, and the question silently times out. The spec also never sets `resumed_at` (or `answer_message_id`) on the human path, so every restart re-resumes the owner with the stored answer. This is G1-07 |
| C7 | Resume message "author system:ask" (§resumeOwner) vs. "stored answer as a message from the requester actor" (restart) | `isDirectHumanRun` / `ctx.direct` exempt write tools from approval when a human talks straight to Praw and the run is clean (tools/policy-approval.ts `approvalFor`). context.ts `runStartsTainted`: a human author equal to `ownUserOf` starts clean | If the synthetic restart message has `kind: 'human'` with the requester's id, stored text (which may come from an attachment-tainted reply) starts a clean, possibly direct run. This is G1-06 |
| C8 | Taint ordering (steps 5 and 10) | Step 5 taints the parent after the INSERT and the ⏳ post. Step 9 does not store `answer_tainted` for the bot path | A crash between the INSERT and step 5 leaves a pending row with `question_tainted = true` under a clean parent. The restart sweep then wakes the requester clean. A NULL `answer_tainted` gives resume no taint source. This is G1-09 |
| C9 | Warroom guard stall | agents/warroom.ts `start()` counts runs (`t.count >= stallTurns`), not posts | The ⏳ / ❓ / 💬 code posts do not push a thread toward a stall (no finding). The answer-triggered owner run does count as one bot turn |
| C10 | Human ping via the existing `mentionUserIds` path | discord/port.ts `post()`: `ids = (popts?.mentionUserIds ?? []).filter((id) => SNOWFLAKE.test(id))`, prefix `<@id>` added **after** `compose` (where the T1 `noHandles` postcondition runs), `allowedMentions = { parse: [], users: ids }`. The S9 stream refusal exists (`if ((o.mentionUserIds ?? []).length > 0) return null`) | The mechanism already gives exactly one deliberate ping, and the defang postcondition is not tripped by the code prefix. A head-authored `<@human>` does not route (inbound maps only bot ids into `mentionedHeads`) |
| C11 | Conversation review-close race | `settleReviewLocked` returns while `this.rollups.has(taskId)`, and `countOpenChildren > 0` keeps the parent in review anyway (the asking child is open). `holdForWorkday` with `rollupOf` calls `unqueue` on a full hold | The mirroring is correct, provided the wake passes `rollupOf = parentId` and releases its count in `finally` |

## 2. Findings

| ID | Severity | Evidence | Description | Remediation | Owner |
| :--- | :--- | :--- | :--- | :--- | :--- |
| G1-01 | High | C1: app-start.ts `once()` `resetDoingToTodo` → `onTaskReady`; spec "Restart" lines | Every restart re-runs every waiting child from scratch, then the question machinery resumes it again: two owner runs, contradictory instructions, wasted budget. `resumeOwner`'s "child must be doing" check makes the spec's own recovery a no-op after the reset | AB2 | backend |
| G1-02 | Medium | C5: `handleMessage` guard drop, `botTurn` `limited`, `exclusive` refuse mode, echo-before-id race | A bot answer can be lost (the task is stuck in `doing` with no timer) or applied twice (a missed id match, then a restart or fallback resume). This breaks "owner never runs twice" and "no blocking" | AB3 | backend |
| G1-03 | Medium | C2: `deliver` `quiet` parameter | The asking run posts the literal `NO_REPLY` in owner runs, human-triggered runs and streamed runs | AB4 | backend |
| G1-04 | Medium | C3: registry `ctx.org.toolsFor(ctx.actor).includes(name)` | Wake-run exclusions are advisory. Injected text in a (possibly tainted) question can drive `create_task` / `forward_to` / `meeting_start` in the requester's context, which is the grandparent chain OQ2 forbids | AB5 | backend |
| G1-05 | Medium | C4: `canDelegate` persona branch; createTask `requester: ctx.actor` | With a persona requester, 💬 is authored by the child owner and routes nowhere (the answer is lost). The wake also runs a persona in a thread under a different owner's rules | AB1 | backend |
| G1-06 | Medium | C7: spec §resumeOwner vs. §Restart; `approvalFor` `ctx.direct && !ctx.tainted()` | The resume author is ambiguous. A human-kind synthetic author can start a clean or direct run on stored text | AB6 | backend |
| G1-07 | Medium | C6: router P1-B early return; RF4 `isAnswer` | Human path: a reply-to-❓ never routes. An answer can be recorded when no run follows (admit refusal, Praw busy). There is no `resumed_at`, so every restart re-resumes | AB7 | backend |
| G1-08 | Low | spec step 7 / §Restart; `releaseRoot` / `dayTurned` start held work, and the sweep starts again | A held wake plus the day-turn sweep start twice. Only the conditional pending→asked keeps it single. A losing start on an off day may have consumed an OT run (`otStart` consumes before `start`). Moot / resume decisions must be made only by the winner, and child status must be re-checked (ask + `update_task done` can share one tool batch) | AB8 | backend |
| G1-09 | Low | C8 | Crash windows lose taint: the parent is not tainted from `question_tainted` on a recovered wake, and the bot path has no stored `answer_tainted` | AB6 | backend |
| G1-10 | Low | migration 033 | (a) Revert answered→asked must clear `answer`, `answer_tainted` and `closed_at`, otherwise `task_questions_answer` / `task_questions_closed` reject it and the row stays `answered` with no post. (b) There is no shape CHECK on `asker` / `requester` jsonb. (c) `requester = $actor` jsonb equality depends on the exact key set (it fails closed, but a stray key silently breaks every answer) | AB11 | backend / database |
| G1-11 | Low | loop.ts `terminal ??= r.terminal`, `for (const u of uses)` | Within one tool batch, a `respond` before `ask_requester` makes the respond payload the terminal one (it is posted, and the run may continue after a `viewHint`). Tool calls after `ask_requester` in the same batch still execute | AB4 | backend |
| G1-12 | Info | spec §Human requester "deviation from R-D parse:[]"; C10 | The human ping deviation is accepted under AB7 (one id, from the DB, only on the human ❓ post) | AB7 | — |

## 3. Domain checklist

| Domain | Result | Note |
| :--- | :--- | :--- |
| Privilege (who answers) | PASS with AB1, AB5, AB7 | DB-row requester. The `askWake.questionId` binding is set by code only. A conditional UPDATE on `id`, `status='asked'` and requester. Human path: `author.id === requester.userId` |
| Routing | CONDITIONAL → AB3, AB7, AB9 | ⏳ and ❓ are inert (authored by the landing-thread owner, `authorIsOwner`). 💬 routes only to the child owner via `authorIsRequester`, if the echo design is kept |
| Injection / defang / redaction | PASS with AB9 | redact → neutralise → defang before the length check. Port `outbound` re-applies them (idempotent). T1 postcondition. Wrapped untrusted (`rollupMessage` twin). Code instruction is constant |
| Taint (both directions) | CONDITIONAL → AB6 | Question → parent before wake. Answer → child before post. Provenance `userId = ownUserOf(landing task)` |
| Loops / caps / spam | PASS with AB5, AB8 | 1/run, 1 open, 2/task, 6/root, 40/day under one advisory lock. A wake cannot ask (noAsk), and with AB5 it cannot delegate, forward or meet. The owner's reply in its own thread does not route (no ping-pong) |
| Human ping deviation | ACCEPTED under AB7 | |
| Off-day / OT / budget / halt | PASS with AB8, AB10 | `orWorkday`, OT consume, warroom pool for bot-rooted trees, R23 and the guard on the echo run. Halt: refuse at call time, posts checked (T11) |
| Restart recovery | FAIL as written → AB2, AB3 | C1, C5 |
| Review-close race | PASS with AB8, AB13 | C11 |
| Migration 033 | PASS with AB11 | Snowflake and length CHECKs, partial unique "one open", `question_tainted DEFAULT true`, cascade, clean down |
| AuthZ (DB roles) | PASS with AB11 | `task_questions` must stay out of `EXECUTOR_TABLE_GRANTS` |
| Config | PASS with AB10 | `ask.*` in HANDLER_KEYS only (`ADMIN_CONFIG_KEYS` is the complement, so `config_propose` cannot write them) |
| Secrets / log privacy | PASS with AB12 | Logs carry ids, seq and status only |
| Reasoning isolation | N/A | No new model-output channel beyond the tool text, which is redacted and capped |
| Native memory, containers, supply chain | N/A | TypeScript only. No new dependencies or images |

## 4. Binding conditions (Gate 2 verifies each with the named test)

**AB1 (G1-05). Who can be asked.**
- `ask_requester` proceeds on the bot path only when all three hold:
  - `child.requester.kind === 'head'` (Praw included);
  - `sameActor(child.requester, parent.owner)`;
  - the parent has a thread.
- A persona requester, or any mismatch, returns the fixed `noRequester` refusal.
- The human path requires `task.parentId === null` and `task.requester.kind === 'human'`, and the thread must not be a top-level conversation (OQ3).
- All of this is read from the DB rows at call time, never from tool input.
- Tests:
  - `tools/builtin/askRequester.test.ts`: persona requester → noRequester; head requester ≠ parent.owner (constructed row) → noRequester; root with bot requester → noRequester.
  - `agents/askback.test.ts`: persona-owned child asking its head (the supported direction) still works end to end.

**AB2 (G1-01). One deterministic restart path.**
- The build picks ONE of these and documents it in the spec:
  - (a) `resetDoingToTodo` / `onTaskReady` skip tasks with a `pending`, `asked`, or `answered`-unresumed row, and the ask sweep alone resumes them; or
  - (b) at boot, before `resetDoingToTodo`, every open row is closed (`moot`, `resumed_at = now()`) and every answered-unresumed row gets `resumed_at = now()`. The reset owner run is then the single resume, and it reads the ⏳ / 💬 posts from its thread history (provenance-tainted as recorded).
- Whichever is chosen:
  - after any restart there is **exactly one** owner run per waiting child;
  - there is **at most one** wake per pending row;
  - `resumeOwner` never needs a `doing` child that the reset already moved.
- Test: `agents/askback.test.ts` restart matrix: rows `pending`, `asked`, `answered` with `resumed_at` NULL, and `answered` with an owner run in flight at crash. Each case gives exactly one owner run and zero or one wake (spec test 6 extended).

**AB3 (G1-02). Every answer starts exactly one owner run.**
- The claim is a conditional `UPDATE ... SET resumed_at = now() WHERE id = $q AND resumed_at IS NULL`. It is taken **inside `exclusive(childId)` immediately before the model run**, never earlier. A run whose claim returns 0 rows **does not run**.
- The echo hook identifies the answer by the DB row, not by `answer_message_id`: row for this child with status `answered` (or `asked` after a revert, see AB11), author actor = row requester, route `task_owner` on the child. This makes an echo that arrives before the id is stored still count.
- `askTick` also resumes, through `resumeOwner('answer')`:
  - `answered` rows with `resumed_at IS NULL` older than a fixed grace (≤ 10 min);
  - `moot` / `expired` rows with `resumed_at IS NULL` whose child is still `doing`.
- This removes "never on the tick" from the spec. A dropped echo (guard stall, rate limit, pool paused, hold full, Praw busy) therefore never strands a task.
- Accepted alternative that satisfies AB3 more simply: post 💬 as the **child owner** (the landing-thread owner, TEAMTALK T3, inert like ⏳/❓) and always resume by code with `resumeOwner('answer')`. If chosen, record the change to OQ1 in the spec.
- Tests (`agents/askback.test.ts`):
  - the echo is delivered before the post promise resolves → one owner run, `resumed_at` set;
  - the echo is dropped by a stalled guard → one resume after the grace;
  - echo and tick race → one run;
  - a Praw owner at its cap → the answer still resumes once.

**AB4 (G1-03, G1-11). An asking run posts nothing.**
- A successful `ask_requester` sets a RunState flag, and the loop ends after the current batch with an outcome marker (e.g. `outcome.asked = true`).
- Every delivery path honours that marker, independent of `quiet` and `isNoReply`: `runOwnerInner`, `runMessage` → `deliver`, `deliverStreamed` (it closes the preview without a final post, per S6/S11), and the resume runs.
- `noteFinal` / `finalReport` are skipped.
- Tool calls after `ask_requester` in the same batch get a fixed refusal ("the run ended with a question").
- A `respond` earlier in the batch does not override the ask ending.
- Tests:
  - `agents/askback.test.ts`: an ask from (i) a `task.created` owner run, (ii) a human-triggered run, (iii) a streamed run → zero posts besides ⏳ / ❓.
  - `agents/loop.behaviour.test.ts`: [respond, ask_requester] and [ask_requester, create_task] batches.

**AB5 (G1-04). Wake-run tools are an allowlist enforced at dispatch.**
- A wake run (`askWake` set) overrides `toolBase.org.toolsFor`, so both the offer and `registry.run` see the same list (the `postOnly` pattern in loop.ts).
- The list is exactly `answer_subtask` plus tools whose declared kind is `read`. Everything else is excluded: `ask_requester`, `create_task`, `forward_to`, `meeting_start`, `warroom_say`, `update_task`, `respond`, every write or destructive tool, and skill-granted writes.
- `answer_subtask` refuses (`notWake`) unless `ctx.askWake` is set.
- Only `askUp` constructs a trigger with `askWake` or `noAsk`.
- Tests:
  - `agents/askback.test.ts`: a wake run whose model calls `create_task`, `forward_to` and `meeting_start` without their being offered → "not allowed" from the registry, and no row is written.
  - `tools/registry.test.ts`: the allowlist.
  - A grep test (`agents/askback.test.ts`): `askWake:` appears only in the scheduler's `askUp`.

**AB6 (G1-06, G1-09). Resume author and taint.**
- Every resume message has:
  - author `{ id: 'system:ask', kind: <non-human actor kind>, actor: <child owner or a system actor> }`;
  - a non-snowflake id (`ask-<questionId>-<kind>`);
  - `origin: 'chat'`.
- It is never a human author. Stored question and answer text goes only into the wrapped message content, never into the instruction.
- `answer_tainted` is written on both paths:
  - bot path: `ctx.tainted()` in the same UPDATE that sets `answered`;
  - human path: attachments present, or the run's own taint.
- NULL counts as tainted.
- Before any resume, `answer_tainted` is OR'ed into the child under the child lock.
- `askUp` ORs `question_tainted` into the parent under the parent lock before the wake run, not only in step 5.
- Tests (`agents/askback.test.ts`, spec test 5 extended):
  - crash after INSERT, before step 5 → the recovered wake runs tainted;
  - resume after a tainted answer → the run is tainted;
  - the resume run is never `direct`.

**AB7 (G1-07, G1-12). Human path and the ping deviation.**
- The answer hook runs on the **admitted** routes (after `admit` and the reroute split). It accepts a route to the child owner on this task with reason `task_owner`, or reason `reply` when `msg.replyToId === question_message_id`.
- To make that reply route exist, the human ❓ post is recorded `answer: true` (the reply target is the owner itself), or the router gets an equivalent narrow special case. Choose one and pin it in `company/router.test.ts`.
- The row moves to `answered`, with `answer_message_id = msg.id` and `resumed_at`, only through AB3's in-lock claim of the owner run that the message started. A message dropped by admit or Praw-busy leaves the row `asked`.
- Ping rules:
  - `mentionUserIds = [task.requester.userId]`, read from the root row, which is `kind: 'human'`, SNOWFLAKE-checked, and holds exactly one id;
  - only on the human ❓ first send;
  - never on an edit, a repost, a stream or any other ASKBACK post;
  - the content prefix is added after the T1 postcondition;
  - `allowedMentions = { parse: [], users: [id] }`.
- Tests:
  - `discord/port.mentions.test.ts`: the ❓ post pings exactly that id, and a model-written `<@other>` or `@everyone` in the question does not ping.
  - `agents/askback.test.ts`: (i) a reply-to-❓ closes the row and runs the owner once; (ii) a rate-limited reply leaves the row `asked`; (iii) a restart after a human answer → no extra run; (iv) a Bot Admin's reply does not close the row.

**AB8 (G1-08). Wake idempotency and ordering.**
- Inside `askUp`, in this order:
  1. claim pending→asked (0 rows → stop with no side effects);
  2. re-read the child (not `doing` → `moot`, no resume) and the parent (NO_ROLLUP → `moot` + `resumeOwner('requester_unavailable')`);
  3. `reopen` only after both checks.
- Only the claim winner may close or resume.
- The wake is started with `orWorkday(job, childId, parentId /* rollupOf */, parent.rootId)`. The `rollups` count is incremented before the start and released in `finally`. A dropped hold leaves the row `pending` for the sweep.
- On an off day, a start re-checks that the row is `pending` before `otConsume`, so a losing duplicate consumes no OT run.
- Tests (`agents/askback.test.ts`):
  - a held wake plus the day-turn sweep → one wake;
  - ask + `update_task done` in one batch → the row is `moot` and nothing runs;
  - a full hold → the `rollups` count is released and the row stays pending.

**AB9. Routing round trip and defang.**
- ⏳ is posted by the child owner and ❓ by the parent owner (= requester per AB1). Both are `noHandles`, with provenance `answer: false` (except the human ❓ per AB7).
- 💬 is `noHandles`, provenance `answer: false`, posted per AB3.
- Text pipeline: redact → neutralise → defang, then the length check, then the T1 postcondition at send.
- Refusals are fixed strings and never echo model text.
- Tests:
  - `company/router.test.ts` + `discord/inbound.handles.test.ts`: ⏳ and ❓ → zero routes; 💬 → exactly `[task_owner → child owner]` when authored by the requester (or zero routes under the AB3 alternative).
  - `agents/askback.test.ts`: spec test 2 with `@CFO` and `<@id>` in both the question and the answer, in both threads.

**AB10. Halt, off switch, config.**
- On halt, both tools refuse at call time, every ASKBACK post checks halt first (T11), and `askTick` is a no-op. Expiry and resume continue after `/resume`.
- `ask.enabled` is read live. When off, the tools are neither offered nor dispatched (AB5 pattern), and `askTick` still expires and resumes.
- `ask.enabled`, `ask.timeoutHours`, `ask.perRoot` and `ask.perDay` are in HANDLER_KEYS with the stated zod bounds (finite integers). Startup refuses `perRoot < 2`.
- Tests: `admin/keys.test.ts` (not in `ADMIN_CONFIG_KEYS`); `agents/askback.test.ts` spec tests 11 and 12.

**AB11 (G1-10). Migration 033 and repo.**
- `revertAnswer` sets `status = 'asked'`, `answer = NULL`, `answer_tainted = NULL`, `closed_at = NULL`, `WHERE status = 'answered' AND answer_message_id IS NULL`. It keeps `resumed_at` (an early echo that already ran is not undone, and the later expiry then does not resume).
- Add `CHECK (jsonb_typeof(asker) = 'object' AND jsonb_typeof(requester) = 'object' AND requester->>'kind' IN ('head','persona','human'))`.
- Actor values are serialised canonically: `{kind, dept}`, `{kind, personaId}` or `{kind, userId}`, nothing else. That form is used for both the INSERT and the `requester = $actor` comparison.
- `task_questions` is not in `EXECUTOR_TABLE_GRANTS`.
- The down migration drops cleanly.
- Tests:
  - `db/repos/questions.int.test.ts`: every transition is conditional; revert passes the CHECKs; two concurrent creates → caps hold; 23505 is mapped.
  - `db/migrate.int.test.ts`: 033 up/down/up.
  - `db/executor-role.int.test.ts`: no grant.

**AB12. Logs and incidents.**
- Log lines, incidents and audit rows about ASKBACK carry only question id, task ids, seq, status and refusal key. That includes the wake run's undelivered final payload, which is logged as ids, `stopped` and `costUsd` only, never its body.
- Test: `agents/askback.test.ts` captures emitted log lines with marker text in the question and the answer, and asserts the marker is absent.

**AB13. Review-close race.**
- Spec test 14 is kept, plus: a conversation parent in `review` whose wake is held on an off day and then dropped by a full hold is neither closed nor stuck. It is settled after the child ends.
- Test: `agents/askback.test.ts`.

## 5. Residual risks (plain words, accepted)

- A task owner whose own run is tainted can still put attacker-chosen text in front of its requester. That is the purpose of the feature, so the text is wrapped and the parent is tainted before the requester reads it. A tainted child permanently taints its parent (same as subtask reports today).
- Asking and answering post to Discord without an approval card even in tainted runs (like `update_task`). The text is code-framed, redacted, defanged, capped and stays in the task's own threads.
- A requester's bot may lack permission to post in the child's thread (for example a persona room). The answer then fails, and the owner continues after the timeout. Nothing leaks, but the answer is lost.
- A Bot Admin or anyone other than the true requester cannot answer. Their message still reaches the owner as today, and the question later times out.
- Question and answer text (redacted) is kept in the database with no purge, like other task text.
- A person can be pinged at most twice per task they started. No per-person daily ping cap exists beyond the global 40/day.
- After a restart under AB2 option (b), a pending question is dropped and the owner restarts fresh. It may spend its second question asking again.

## 6. Files reviewed (md5 at review end)

```
23f15eaf7c8f3326bf138f6a1b152b4f docs/superpowers/specs/2026-11-08-askback-design.md
79ead08323d908bd27be4eed9656d4bb agents/scheduler.ts
0fd5e40be2fcdf5430f11bb6b047392b company/router.ts
af67a6cf1a967731a5ecedae29dde6c2 agents/loop.ts
38d991a8e7eec3ec4aeadb1b87f0bbd4 agents/notices.ts
98ad8262711f0b33426d5813b3bd9f22 agents/payload.ts
97786105bc4a6b61989389dd50fe3abd agents/context.ts
a641cc0861d2db6e30d9155750e9e488 agents/reroute.ts
1d4d6f5af8f4f94bb442b255efa67cb7 app-start.ts
f422eeef728711d5e20ba153dd5a0b40 app.ts
090786dc1f84e42c2f01dfdbe646870c admin/keys.ts
ea3d585174915016f86f292316302c85 tools/policy.ts
a8654980b62b1751a13ccde3b120d907 tools/policy-approval.ts
6e4a7ad69f26590911df370925e53cfa tools/registry.ts
23260722b896c2cd8081213eedd89108 tools/builtin/createTask.ts
bfb9e8b9dd8981cedf5ec3db99b9f252 tools/builtin/updateTask.ts
5f306c5e50c0bcf10716138423779e13 company/org.ts
d2064eb53c5bb165b042f855828dc62d discord/port.ts
20400da15b00d188056b8a267eaf4735 db/executor-role.ts
```

## Owner sign-off (2026-11-08, recorded by controller from the owner's answer in chat)
The owner ACCEPTS the listed residuals (wrapped attacker text to requester; no approval card for ask/answer; lost answer if requester cannot post; only true requester answers; redacted text kept in DB; up to 2 pings per task; restart closes open questions — AB2(b)).
