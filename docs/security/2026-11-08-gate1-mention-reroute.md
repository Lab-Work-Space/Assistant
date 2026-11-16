---
title: "Gate 1 — REROUTE-1 mentions of an unreachable head become tasks"
task_id: REROUTE-1
gate: 1
status: CONDITIONAL_APPROVE
spec: docs/superpowers/specs/2026-11-08-mention-reroute-design.md
migration: 032_reroute
last_updated: 2026-11-08
---

# Gate 1 — REROUTE-1 (spec review)

**Verdict: CONDITIONAL_APPROVE.** The design keeps `route()` pure, reuses the existing authorisation paths and fixes the title, which is the right shape. But the spec has one happy-path defect (C1). It also has three places where a bot post could create work with more power than the same bot has through `create_task` today (C2, C3, C8), and two concurrency holes (C4, C5). Conditions RR-C1 to RR-C20 below bind the build and Gate 2. None needs a redesign.

Code is cited by function name plus a quoted fragment. Line numbers are hints only.

## 1. Scope and method

Read: the spec. Read in code: `agents/scheduler.ts` (`handleMessage`, `withReplied`, `admit`, `runMessage`, `conversationFor`, `afterRun`, `settleReview`, `handleCreated`, `postHandoff`, `reportEnded`, `rollupJob`, `rollUp`, `deliver`, `post`, `deliverStreamed`, `exclusive`), `company/router.ts`, `agents/conversation.ts`, `discord/port.ts` (`clientOf`, `resolve`, `history`, `canMemberView`, `channelIsPublic`, `canStartThread`, `botCanView`, the STREAM-1 preview and fresh-post path), `discord/inbound.ts` (`contentOf`, the mention extraction, `handlesIn`), `db/repos/tasks.ts` (`findOpenConversation`, `takeForward`, `countOpenChildren`), `db/repos/botMessages.ts`, `tools/builtin/{createTask,forwardTo}.ts`, `company/forward.ts`, `company/org.ts` (`canDelegate`), `agents/context.ts` (`ownUserOf`, `runStartsTainted`), `tools/policy-approval.ts`, `admin/keys.ts`, `core/events.ts` (`emit`).

No scanners were run: Gate 1 is a spec review, and the migration adds no dependency.

Missing context: `<PROJECT_ROOT>/CLAUDE.md` and `<PROJECT_ROOT>/.claude/rules/` do not exist. Team rules `_global/security.md` and `labworkspace/security.md` were read.

## 2. What the existing powers are (baseline for "no widening")

| Mentioner | Today, in a channel the target CAN reach | Today's tasking power elsewhere |
| :--- | :--- | :--- |
| Head bot | A bot-talk run of the target in the source (guard: serialised, rate-limited, stall) | `create_task`: `canDelegate`, **only from a task it owns** (`delegate`: `"you can only delegate from a task you own"`), no member view check for non-Praw heads, kindless (no approval except estimate), root only through `rootTaskGate` (TW6) |
| Head bot through `forward_to` | — | `viewCheckAllHeads: true` (root requester must view target room), estimate > 0, `kind: 'write'` (always an approval card), chain check, takeForward 4 |
| Persona | Same | `canDelegate`: own head only |
| Praw | Same | `create_task` + P16d `memberCannotView` on the human |
| Human | One run per routed head, one non-Praw rate slot per message (`admit`) | Talk in the dept room directly (needs Send there); through Praw: the child is `delegated` (held on off days) and takes Praw's per-user slot |

Reroute sits between `create_task` and `forward_to`. It is code-made (like `create_task`), but it moves source text into another room (like `forward_to`). The conditions use whichever of the two is stricter wherever the source text crosses rooms.

## 3. Findings

Severity is CVSS-style qualitative, for a single-owner company Discord.

### G1RR-01 (High) — Adoption reply target cannot work, and adoption attribution is not proven
- `withReplied` returns early for bots: `if (msg.author.kind !== 'human' || !msg.replyToId ...) return msg;`. So `msg.replied` is never set on a bot message, and spec step 4(b)'s `originMessageId = msg.replied?.id only when ...` is always null. The roll-up would then post a loose CEO message instead of answering the owner, so the spec's own lounge happy-path test cannot pass.
- The bigger issue is attribution. `ownUserOf` gives `triggerUserId` = the run's human, or the **task's human requester** for a bot-triggered or task-owner run. Also, `deliver` defaults `answer = true` for task-owner final reports too (`runOwnerInner` → `this.deliver(...)`).
- So a head's top-level post that is *not* a reply to that person can still carry a `userId` and `answer=true`. Examples: a goal-task report, or a bot-talk turn inside a human tree.
- Step 4(b) would then adopt a human-requester conversation in a channel where that person never spoke. Three things follow:
  - WS13 steering rights over the new tree go to that person.
  - Roll-ups go into that channel.
  - The tree becomes human-origin, so its spend moves off the warroom pool (WS5) and it escapes TW6.
- Fix: RR-C1 and RR-C3.

### G1RR-02 (High) — Thread posts by a non-owner bot escape every tree limit
- Step 4 falls through to (c) "no parent → botRoots" whenever (a) fails. In a task thread, (a) fails when the mentioning bot is not the owner, e.g. the requester or a bot-talk participant.
- `create_task` refuses that same bot (`ctx.task` is the thread's task, so `"you can only delegate from a task you own"`).
- Reroute would instead create a fresh **root** (depth 0, empty chain, its own takeForward budget). That is a widening, and it lets a deep tree restart its depth and chain limits under TW6 alone.
- Fix: RR-C8.

### G1RR-03 (High) — Unknown provenance still creates work
- Spec step 2: no row after the poll → tainted, `triggerUserId` null → path (c), which creates a root task.
- Taint limits what the child's tools may do. It does not stop the effect itself: a task, a dept-room thread, a notice, a TW6 slot.
- Any bot post that does not go through `Scheduler.post` with a provenance record would create root tasks. Examples: `logDirect`, task log cards, port-side code posts, a future path.
- Fix: RR-C2. If the row is still absent after the poll, drop and warn.

### G1RR-04 (Medium) — Continuation routes are treated as mentions
- Split A checks routes with reason `warroom`. In `route()`, the TW2 continuation, `if (next) add(next, 'warroom')`, also has reason `warroom` with **no mention at all**.
- A plain warroom-thread post could therefore create a task for the previous speaker. The owner asked for mentions only.
- Fix: RR-C7.

### G1RR-05 (Medium) — Adoption lock and race with `settleReview`
- `this.locks.run(parent.id)` cannot serialise creating a parent that does not exist yet. Three things can each create a second open conversation for (hq, user, lounge):
  - two chunks of one long reply, which both carry the handle and both get their own provenance row;
  - two CEO posts in a row;
  - the CEO's own `create_task`, through `conv.open` → `openHead`, whose `opening` map is private to `createConversation`.
- On an existing conversation, `settleReview` does **not** take `locks.run(taskId)`. It reads `countOpenChildren` and then runs `update(..., { status: 'done' }, 'review')`.
- A reroute that re-reads `review` inside its lock can therefore still attach a child to a parent that `settleReview` closes in between. That is exactly the NO_ROLLUP silent loss the spec says it rules out.
- Fix: RR-C4 and RR-C5.

### G1RR-06 (Medium) — "Fail-closed" access check turns into more action
- `botCanWork` returns false on any throw, and false means **reroute**: a task, a copy of the source text in another room, a notice.
- A transient Discord error (timeout, 5xx, 429, cache miss during a reconnect) would therefore copy private source text into a dept room that did not need it. That widens residual R-1 without any decision by anyone.
- The safe direction for an *unknown* answer is today's behaviour (run in the source), not reroute.
- Fix: RR-C9.

### G1RR-07 (Medium) — Card mode for a private thread inside the target room
- The spec says `'full'` when "source is the target room". Rerouting is most likely exactly when the source is a private or locked thread, possibly under the target's own work room.
- A private thread is narrower than its parent room (G2RF-02). If the "same room" shortcut compares the parent channel, or runs before the thread check, the full quote lands on the room card.
- `forwardTo` gets this right. Its order is: thread → public check only, then direct, then same channel, then public.
- Fix: RR-C10.

### G1RR-08 (Medium) — Human mentioner: view-only member gains tasking and off-day power
- The human path checks `canMemberView` (ViewChannel only, in `discord/port.ts` `canMemberView`: `has(PermissionFlagsBits.ViewChannel)`). It then creates a **human-origin root** owned by the target head, and that root runs on off days.
- A member who can only read a dept room cannot talk to that head today. Through Praw the child would be `delegated` (held on off days) and would take Praw's per-user slot.
- Each human message (one rate slot) can open 3 persistent root tasks, which count against the company-wide `checkOpenTasks`. A member can fill that cap and block all delegation, which is a cheap company-wide DoS. Today's mention runs leave no open rows.
- Fix: RR-C11 and RR-C12.

### G1RR-09 (Medium) — Cross-room view check for bot mentioners
- Only Praw's trigger user is view-checked. Reroute carries source text (the quote) into the target room, and the roll-up carries the target's result back into the source channel.
- `forward_to`, the existing cross-room hand-off, checks the root requester's view for **every** head (RF9, `viewCheckAllHeads: true`).
- Fix: RR-C3 (iv).

### G1RR-10 (Medium) — Discord I/O and the 3 s poll inside the parent lock
- The spec does not say what runs inside `locks.run(parent.id)`. `rollupJob` → `exclusive(parentId)` and every reopen wait on that lock.
- Holding it across the provenance poll (up to 3 s), `history`, `botCanWork`, `canStartThread` or `channelIsPublic` would stall roll-ups. It would also widen every race above.
- No deadlock was found. The CEO run releases the conversation lock in `runMessage`'s `finally { conv.release(); ... }` and never awaits the spawned reroute. `bus.on('task.created', (e) => void this.onTaskCreated(e.task))` and `bus.on('task.changed', (e) => void this.onTaskChanged(e))` are void-dispatched, so `emit` and `afterRun` inside the lock do not wait on runs.
- Fix: RR-C6.

### G1RR-11 (Low) — Member label in the title
- `rerouteTitle(from)` → `Rerouted mention (from <deptId|member>)`. If `member` is a display name or username, person-controlled text reaches the thread name and the #tasks card, which is the exact thing RF9's fixed title prevents.
- Fix: RR-C13.

### G1RR-12 (Low) — Synthetic ids, 23505 scope, side effects before the insert
- The CHECK constraint `'^[0-9]{17,20}$'` turns a synthetic id (`stall-…`, `rollup-…`) into a 23514 error, not a skip.
- Catching every 23505 would hide other unique violations.
- `takeForward` runs before the insert, so a duplicate burns a per-root slot.
- An `adopt` followed by a failed child leaves an orphan `doing` conversation. `runOwner` only runs `todo` tasks, and `settleReview` only looks at `review`, so nothing would ever close it.
- Fix: RR-C5 and RR-C14.

### G1RR-13 (Low) — Halt window
- Step 1 checks halt once, before a poll of up to 3 s and a lock wait. A `/halt` in between would still create tasks and post notices.
- A `todo` task created while halted waits for `/resume`, so this is Low.
- Fix: RR-C15.

### G1RR-14 (Low) — Notices and the guard
- The notice and refusal posts are bot messages in the source. They go back through `talkSeen` → `guard.observeBot` and through `inbound` (`handlesIn(content)` for head and persona authors).
- `noHandles` should keep them from routing, but nothing proves it, and they could count as bot turns toward a stall.
- Fix: RR-C16.

### G1RR-15 (Info) — Cache staleness does not widen
- A stale positive gives today's behaviour, a run that fails to post. A stale negative gives a reroute, and that path still runs the full authorisation.
- TTL 60 s, definite-only, ≤1000 entries and cleared on `/resume` are accepted. Key the cache by `(dept, src)` with `src = threadId ?? channelId` as specified.

## 4. Checklist summary

| Domain | Result |
| :--- | :--- |
| Secrets | PASS (spec): the quote goes through `cleanCardText` (redactText with secrets); logs carry ids and codes only. Gate 2 must prove it with a planted secret (RR-C17). |
| Injection / prompt | PASS with conditions: fixed title (RR-C13); the quote is cleaned (zero-width, NFKC, control characters, neutralise, ≤1500) and read inside the untrusted wrapper; refusal codes are fixed; the notice uses `noHandles`. |
| Reasoning isolation | N/A: no new model call; the reroute itself is $0 code. |
| AuthN/AuthZ | CONDITIONAL: RR-C2, RR-C3, RR-C7, RR-C8, RR-C11. |
| Transport | N/A: no new endpoint. |
| Native memory / containers / supply chain | N/A: TypeScript only, no dependency or image change. |
| Log privacy | PASS (spec): dept, channel id, msg.id and a reason code only, never content. |
| Safety override (halt, off day, OT, budget) | PASS with RR-C15. Off day: the child is `delegated` and held (`runOwnerInner` `treeHeld`/`otConsume`), as in OFFDAY-1 and OT-1. SPEND-1 dept caps apply at run time. A tainted child gets per-tool approvals and batching. |
| Migration | PASS with RR-C14: nullable column with CHECK, partial unique index, clean down. |

## 5. Binding conditions (Gate 2 verifies each with the named test)

Test files:
- **S** = `agents/scheduler.reroute.test.ts`
- **P** = `discord/port.access.test.ts`
- **D** = `db/repos/tasks.int.test.ts`
- **R** = `company/router.test.ts` (existing, unchanged plus one assertion)

**RR-C1 — Reply target from the live reference (fixes G1RR-01). [S]**
- `originMessageId` comes from `msg.replyToId`, never `msg.replied`. It is accepted only when all of these hold:
  - it is a snowflake;
  - `port.fetchMessage(msg.channelId, msg.replyToId, mentioner)`, read as the mentioning bot, returns a message in the **same channel**;
  - that message's author is the human `row.userId`.
- Otherwise there is no adoption (see RR-C3).
- Tests:
  - lounge happy path: the roll-up replies to the owner's message id;
  - a reply to another person's message → no adoption;
  - a reply to a bot message → no adoption;
  - a fetch failure → no adoption.

**RR-C2 — Provenance or nothing (fixes G1RR-03). [S]**
- A bot mentioner needs a provenance row for `msg.id` within the poll: at most 6 × 500 ms, **outside any lock**. No row, or a lookup error → drop the moved routes, warn once per (dept, src), no task and no notice.
- `tainted = msg.forward || row.tainted`.
- Tests:
  - row arriving after 1 s → one task;
  - row absent → zero tasks, zero notices (replaces the spec test "absent → botRoots");
  - lookup throws → zero tasks.

**RR-C3 — Adoption gate (fixes G1RR-01 and G1RR-09). [S]**
- Path (b) adopts or attaches only when all of these hold:
  - (i) the source is top-level;
  - (ii) `row.answer === true` and `row.userId` is set;
  - (iii) the RR-C1 reply-target check passes;
  - (iv) `canMemberView(row.userId, target.workChannelId)` is true for **every** head mentioner, not only Praw (RF9 parity). It fails closed.
- (i)–(iii) failing → path (c) (TW6 slot). (iv) failing → refusal `not_allowed`.
- `msg.replyToId` is filled for bot authors too (`toIncoming` → `referenceOf(m, ctx)` is not gated by author kind), so (iii) can be built. A long reply, however, replies on its **first chunk only** while every chunk gets an `answer=true` row. So a handle in chunk 2 or later fails (iii). Without the parent-independent duplicate guard in RR-C4 it would open a second, unlinked root.
- Tests:
  - a goal-task report with `answer=true` but no reply to the person → no adoption;
  - CEO mentioner whose human cannot view the target room → refusal;
  - a bot-talk turn with an inherited `userId` → no adoption.

**RR-C4 — One conversation per key (fixes G1RR-05). [S]**
- `Conversation.adopt` and `openHead` share one serialisation on the key `${dept}|${userId}|${where}`. Either the existing `opening` map becomes a keyed lock that both use, or the scheduler wraps both in `locks.run('conv:'+key)`.
- These all run inside that one critical section:
  - `findOpenConversation`;
  - the status re-read (doing/review only);
  - the 15-minute duplicate-child guard;
  - the child insert.
- The duplicate guard does not depend on the parent. It skips when an open task already exists with all of these:
  - dept = target;
  - `reroute_source_id IS NOT NULL`;
  - the same mentioner (requester);
  - the same source (`src`);
  - created within the last 15 minutes.

  It also keeps the spec's per-parent check, which covers the mentioner's own `create_task`. It runs on paths (b) and (c) alike, under a keyed lock on `reroute:${dept}|${mentioner}|${src}` that the path (b) section is nested inside, always taken in that order (no lock-order inversion).
- Tests:
  - two chunks of one reply, both mentioning @Sales (the second chunk has no reply reference) → one conversation, one child, no second root;
  - adopt racing the CEO's own `create_task` → one conversation;
  - two CEO posts 10 ms apart → one conversation.

**RR-C5 — Atomic attach and cleanup (fixes G1RR-05 and G1RR-12). [S][D]**
- The child insert succeeds only if the parent is still `doing` or `review`, checked in the same SQL statement or transaction (`INSERT ... SELECT ... WHERE EXISTS (SELECT 1 FROM tasks WHERE id = $parent AND status IN ('doing','review'))`, or `SELECT ... FOR UPDATE` in a transaction). Otherwise there is no child, and the conversation path is retried once by adopting.
- All refusals run **before** `adopt`: authorisation, chain, depth, children, `checkOpenTasks` (which must admit two tasks for the adopt case), takeForward and room.
- If the child is not created after an adopt, the adopted conversation is closed (`cancelled`) in a `finally`, so no orphan stays `doing`.
- Tests:
  - [D] the insert against a `done` parent returns no row;
  - [S] `settleReview` racing the attach → the child never has a done or cancelled parent;
  - [S] the child insert throws after an adopt → the conversation ends `cancelled`.

**RR-C6 — Lock scope (fixes G1RR-10). [S]**
- Only DB reads and writes run inside the parent or conversation lock. The provenance poll, `history`, `botCanWork`, `canStartThread`, `channelIsPublic`, `canMemberView` and `fetchMessage` all run before the lock is taken.
- `bus.emit('task.created')` and the notice post run after the lock is released.
- Test: a fake port whose `canStartThread` never resolves does not block a concurrent `rollUp` on the same parent; it completes within the test timeout.

**RR-C7 — Mentions only (fixes G1RR-04). [S][R]**
- A route is checked or moved only if `r.actor.kind === 'head'`, `r.reason ∈ {mention, warroom}` **and** `r.actor.dept ∈ msg.mentionedHeads`. A TW2 continuation is never rerouted.
- Tests:
  - [S] a warroom-thread post with no mention, where the continuation target cannot work there → no task;
  - [R] the existing router tests are unchanged.

**RR-C8 — Non-owner in a task thread (fixes G1RR-02). [S]**
- If the source thread has a task (`findByThread`) and the mentioner is not its owner → refusal `not_allowed`, never path (c).
- Path (c) is allowed only when the source is not a task thread and RR-C3 (i)–(iii) failed.
- Tests:
  - the requester bot mentions in its child's thread → refusal, zero tasks;
  - the owner mentions → a child of that task.

**RR-C9 — Tri-state access (fixes G1RR-06). [P][S]**
- `botCanWork` returns `'yes' | 'no' | 'unknown'`, or a boolean plus a separate definite flag.
- `'no'` only for:
  - a bad snowflake;
  - an excluded channel;
  - 50001, 50013 or 10003;
  - a definite permission or membership result (thread not joined, locked without ManageThreads, a missing permission).
- Client offline, timeout, 5xx, 429 or any other error → `'unknown'`. An unknown answer keeps the route as today (it runs in the source) and is never cached.
- Tests:
  - [P] the matrix of the spec plus a timeout and a 500;
  - [S] `'unknown'` → the route runs as today and no task is created.

**RR-C10 — Card mode order (fixes G1RR-07). [S]**
- `forwardCard` is computed exactly as `forwardTo` does it. If `msg.threadId` is set, it is `'full'` only when `channelIsPublic(threadId)`, and the same-room shortcut never applies to a thread. Top-level: same channel → `'full'`; `channelIsPublic(channelId)` → `'full'`; anything else, or any error → `'link'`.
- Tests:
  - a private thread under the target's own work room → `'link'`;
  - a public channel → `'full'`;
  - `channelIsPublic` throws → `'link'`.

**RR-C11 — Human mentioner needs the power to talk there (fixes G1RR-08). [P][S]**
- The human path requires the member to be able to post in the target work room: ViewChannel + SendMessages + SendMessagesInThreads, read live and failing closed. This is a new port helper, e.g. `canMemberPost`.
- If the owner prefers view-only, the human child must instead be created `delegated` under the off-day hold. That choice must be written into the spec before the build.
- Tests:
  - [P] a member with view but no send → false;
  - [S] that member → refusal `no_access`.

**RR-C12 — Human open-task cap (fixes G1RR-08). [S]**
- A person may have at most 3 open rerouted root tasks, counted from the DB (`reroute_source_id IS NOT NULL AND requester @> {kind:human,userId}` and not done or cancelled). Over the cap → refusal `limit`.
- The 3-per-message cap stays, and the existing `admit` slot is the per-message charge.
- Test: the 4th open reroute by one member → refusal, zero tasks.

**RR-C13 — Fixed title (fixes G1RR-11). [S]**
- The `from` label is a dept id from `DEPT_IDS`, or the literal `member`. A display name, username or nickname is never used. A user id may appear only in the description's source line.
- Test: a member whose display name is `@everyone <@123> ‮x` → the thread name and card title match `/^Rerouted mention \(from (?:[a-z]+|member)\)$/`.

**RR-C14 — Ids and the unique index (fixes G1RR-12). [S][D]**
- Reroute is skipped (with a warn) when `msg.id` is not a snowflake.
- Only a 23505 whose `constraint === 'tasks_reroute_once'` counts as a duplicate. Any other database error is reported as an incident.
- A duplicate pre-check (`SELECT 1 ... WHERE reroute_source_id = $1 AND dept_id = $2`) runs before `takeForward` and before the TW6 acquire.
- Migration 032 up and down is applied twice in the integration test.
- Tests:
  - [D] a duplicate insert → 23505 on `tasks_reroute_once`;
  - [D] a non-snowflake → 23514;
  - [D] down then up again;
  - [S] the same msg.id delivered twice → one task, the forward counter unchanged on the second delivery.

**RR-C15 — Halt re-check (fixes G1RR-13). [S]**
- `halted || !canRun()` is re-checked right before `tasks.create` (or before adopt), and again right before the notice post.
- Test: halt set while the provenance poll waits → zero tasks, zero notices.

**RR-C16 — Notices are inert (fixes G1RR-14). [S]**
- Notices and refusals are posted with `noHandles: true`, `answer: false` and provenance as specified. For a human mentioner, `userId` is the human's id, not `triggerUserId`.
- Test: feed the rendered notice and refusal back through `mapInbound` and `route()` with a deptName that contains `@Sales` and `<@id>` → zero routes. The warroom guard's consecutive-turn counter does not move for a notice.

**RR-C17 — Quote hygiene. [S]**
- The quote is `cleanCardText(msg.content, 1500, secrets)`. The replied-to message, embeds of other messages and the forward snapshot are never included.
- Tests:
  - a planted secret in the CEO's post is masked in the description and absent from every log line (capture the emitted line, rule 19);
  - zero-width characters and full-width `＠` are neutralised;
  - the owner's replied-to text does not appear in the description.

**RR-C18 — Caps. [S]**
- A bot mentioner's cap comes from the router (3, CEO 5). Human: `REROUTES_PER_MESSAGE_HUMAN = 3` after deduplication.
- `takeForward(rootId, FORWARDS_PER_ROOT)` is taken for **every** rerouted child, the first child of a freshly adopted root included. `checkDepth`, `checkChildren` and `checkOpenTasks` run on every child.
- Tests:
  - a CEO message mentioning 6 heads → at most 4 children in one adopted root;
  - takeForward exhausted → refusal `limit`.

**RR-C19 — Chain check moved, not copied. [S]**
- `chainDepts` lives only in `company/forward.ts`, and `forwardTo` imports it from there. There is no second copy, per rule 8.
- Test: an existing `forward_to` chain test still passes, and the reroute chain refusal test passes.

**RR-C20 — Kill switch. [S]**
- `reroute.enabled` is read live at split time, and an error reading it counts as off. Off → moved routes are dropped with one warn per (dept, src).
- It is in `HANDLER_KEYS`, so `config_propose` cannot write it.
- Test: `ADMIN_CONFIG_KEYS` does not contain `reroute.enabled`; off → no run, no task.

## 6. Taint inventory (global rule 9)

Places where a rerouted, possibly tainted, item is stored and later read by another run:
1. **The child's `description`** (the quote) and its `tainted` flag. The owner run reads it inside the untrusted wrapper, and the flag starts the run tainted. Gate 2 checks that the flag is copied from the provenance row (RR-C2), and for a human from `runStartsTainted`.
2. **The adopted conversation's `tainted` flag** is set from the row. `reportEnded` copies child taint up (`if (tainted && !parent.tainted) await this.d.tasks.update(parent.id, { tainted: true })`). There is no new path.
3. **The roll-up text** (`noteReport` → `reports` map) carries the child's final report back into the source channel as the mentioner. That is the existing H4 behaviour, and taint is copied up first.
4. **The notice's provenance row**: `tainted = child.tainted` and `answer = false`, so a person's reply to the notice never routes, and history reads of it count as tainted when the child is.

Nothing else is stored. The notice map lives in memory, holds ids only and is lost on restart.

## 7. Residual risks for the owner (plain words)

- **R-1 — Lounge words can show up in a department room.** When the CEO mentions @Sales in the lounge, the CEO's message, which may retell what you said there, is copied into a Sales task. Cards hide it, but the Sales head reads it and may repeat parts in the Sales room, where other people may be able to read it. The same risk was accepted for `forward_to`. Needs your sign-off.
- **R-2 — Department results come back into the lounge.** The CEO's summary of the Sales result is posted in the lounge. This is fine while the lounge is only you, the CEO and Praw. If you later open the lounge to more people, they would see summaries of department work.
- **R-3 — Casual mentions become real work.** Any time the CEO (or another head) writes "@Sales" in a room Sales cannot see, a Sales task is opened and run, and it costs money. There is no cost-estimate approval for these tasks (the estimate is 0). They are still limited by department budgets (SPEND-1), the per-tree cap of 4, the daily cap on bot-started tasks and the open-task cap. You can turn the feature off with `reroute.enabled`.
- **R-4 — Off days.** A task rerouted on an off day waits for the next workday. It may raise an overtime request card (OT-1) that you then need to answer.
- **R-5 — Notices can go missing.** The "sent to Sales" notice is kept only in memory. If the app restarts at the wrong moment, the task still exists but the notice in the lounge is never posted. Also, if the database is slow to record the CEO's message (more than 3 seconds), the mention is dropped with only a log warning (RR-C2 picks "do nothing" over "guess").
- **R-6 — A wrong model can trigger it.** If a tricked (tainted) bot writes several @mentions, up to 3 tasks are opened (5 for the CEO). They start as "untrusted", so every write tool they try asks you first. This is the same power the bot already has through `create_task`.

## 8. Recommendation

Proceed to the build under RR-C1 to RR-C20. **Blocking before the build:** (1) the owner signs off R-1; (2) the owner picks one RR-C11 option, either send rights or a `delegated` human child; (3) the spec is amended so its flow and test list match RR-C1 to RR-C5 (for example, "provenance absent → botRoots" becomes "absent → no task", and the reply target comes from `replyToId`). Re-submit for Gate 2 with the three test files named above.

## 9. Audited files (md5, at review end)

```
ec9040fdac6ea41839124ee743449681 docs/superpowers/specs/2026-11-08-mention-reroute-design.md
0fd5e40be2fcdf5430f11bb6b047392b company/router.ts
52c435ce4b18b28f1d3f5a64fedeb274 agents/scheduler.ts
e200c791c5137eb3ee36b93bfd0c19f2 agents/conversation.ts
76f1924320c673d93f7dc8e85d7ee1d5 discord/port.ts
d321d929edad302d6db1651ff1e8c71f discord/inbound.ts
13fcd03a914a8f1ca264acc7b7d8edd9 db/repos/tasks.ts
a8bf99d82c9a2473a6ed1775bf0c96e3 db/repos/botMessages.ts
b323721e144c1a819d7f340853299daf tools/builtin/forwardTo.ts
23260722b896c2cd8081213eedd89108 tools/builtin/createTask.ts
8e765e2ca8d4f774590291f952ec1c21 company/forward.ts
5f306c5e50c0bcf10716138423779e13 company/org.ts
97786105bc4a6b61989389dd50fe3abd agents/context.ts
a8654980b62b1751a13ccde3b120d907 tools/policy-approval.ts
764612cd14208080951aafcba3d8e584 admin/keys.ts
```

## Owner sign-off (2026-11-08, recorded by controller from the owner's answer in chat)
The owner ACCEPTS residuals R-1 to R-6. RR-C11 option chosen: the human mentioner must be able to POST in the target work room (canMemberPost); the human child stays a human-origin root.
