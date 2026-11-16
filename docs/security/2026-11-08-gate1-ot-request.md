---
title: "Security Gate 1: overtime requests (OT-1)"
gate: 1
status: CONDITIONAL_APPROVE
date: 2026-11-08
task: OT-1
project: labworkspace (BOT/Assistant)
spec: docs/superpowers/specs/2026-11-08-ot-request-design.md
migration: 030_ot_requests
---

# Security Gate 1: overtime requests (OT-1)

Verdict: **CONDITIONAL_APPROVE**. Conditions OT-C1 to OT-C17 below bind Gate 2, and each names the file and the test that proves it. None of them needs a redesign. The core of the design is sound: code raises the request (there is no model tool), a Bot Admin decides by a live role check on each click, the decision rests on the DB row, scope comes from the stored `root_id`, consume is a conditional UPDATE, and halt is refused and revoked. Four gaps would still let work run past the grant or let a model widen the caps (G1OT-01 to G1OT-04). They must be closed before build.

## Scope

The sa spec (Decisions D1/D2, happy path, alternate flows, sites changed, migration 030, consume/approve SQL, customIds, config, card, errors, audit, tests, Security section), reviewed against the current tree. Anchors are function plus quoted fragment. Line numbers are hints only.

- `agents/scheduler.ts`: `offDay()` "isOffDay((this.d.now ?? Date.now)()).off"; `dayTurned()`; `orWorkday()` "heldForWorkday.length < MAX_HELD"; `noteHeld()` "claimOffdayNotice"; `handleMessage` bot-talk branch "if (this.offDay() && !humanTask)" + "this.guard.hold(wr.key, start)"; `warroomSay` "bots do not talk to each other on an off day"; `settleReview()` "if (this.offDay()) return" + "recoverRollup(cur)" + "finalRollup(cur)"; `recoverRollup()`/`finalRollup()` "this.rollupJob(...)()"; `runOwnerInner()` "!isHumanOrigin(cur.origin) && this.offDay()" and "const approved = await this.approved(task, task.owner)"; `approved()` "runApprovedCalls(port, task"; `postHandoff()` "const held = this.offDay()"; roll-up hold "this.orWorkday(this.rollupJob(parent.id"
- `agents/approved-tools.ts`: `runApprovedCalls` "port.claim(task.id)" then "port.run(task.owner, task"
- `agents/warroom.ts`: `hold()` "at most one per thread (the newest)", `releaseHeld()`
- `company/calendar.ts`: `localDay`, `isOffDay` "cfg.get('schedule.timezone')"
- `governance/halt.ts`: constructor "cfg.watch('halted'" + "void this.runHooks()", `onHalted`, `onResumed`, `isHalted` "latched || ... !== false"
- `governance/budget.ts`: `TASK_DAY = '1970-01-01'`, task key "scope: 'task', scopeId: rootId", local path "calls = calls + 1", boot "SET reserved_usd = 0 WHERE reserved_usd <> 0"
- `governance/approvals.ts`: `maskReason` (secret redaction only)
- `discord/commands/index.ts`: `decide()` WS7 "approvals.channelByCategory" + "memberRoleIds.includes(deps.adminRoleId)", `deferEphemeral`
- `discord/commands/approval.ts`: `approvalButton` order "REVOKE_ID ... parseBatchCustomId ... APPROVAL_ID", "isAdmin: true", revoke "g.cardMessageId !== i.messageId"
- `discord/embeds/approval.ts`: `REVOKE_ID`, `BATCH_APPROVAL_ID`, `HIDDEN` "/gu"
- `discord/commands/plans.ts`: `planWorkday` "const today = localDay(" + "is already a workday", `applyPlan`
- `discord/commands/settings.ts`: `handlerSet` default branch "web.taskGrant."
- `admin/keys.ts`: `ADMIN_CONFIG_KEYS` "filter((k) => !NEVER.includes(k) && !HANDLER_KEYS.includes(k))"; `admin/names.ts` "config_propose"
- `db/repos/web-grants.ts`: `revokeOwed`, `revokeAll`, `revokeBeforeHaltedRow` "created_at < (SELECT updated_at FROM config WHERE key = 'halted')"
- `app.ts`: "halt.onHalted(async () => void (await webGrants.revokeAll('halt')))", "revokeBeforeHaltedRow()"
- `app-start.ts`: approval expiry "setInterval(() => void expire(), HOUR_MS)"
- `tools/builtin/createTask.ts`: "parent = the current task (never from input"

## What the spec already gets right

- D1: there is no `request_ot` tool. The request is raised from `noteHeld` by code, the card is built only by code, and bots cannot click buttons, so a model cannot raise, approve or widen a request by tool. Card text has no model free text apart from the root title (see G1OT-10).
- D2: a separate table keeps OT out of `resumeApproved`/`releaseWaiters`/`expireOld`/`decide()` and out of batching. A generic `decide()` cannot approve OT with no grant.
- The decision rests on the row. The customId carries only id + digest + action, `OT_ID` cannot match `REVOKE_ID` (`approval:g:`), `BATCH_APPROVAL_ID` (`approval:b:`) or `APPROVAL_ID` (a digit after `approval:`), and the handler checks the stored `card_channel_id`/`card_message_id`. That closes the WS7 category-room route in `decide()` for OT cards, which are posted only in #⚙️-setting.
- Lock order for approve (root row, then the OT row) matches `decide()`. Consume holds only the OT row and reads `tasks` without a lock, and halt revoke takes only OT rows, so there is no deadlock cycle. Concurrent consume cannot overshoot `max_runs`: under READ COMMITTED Postgres re-checks the conditional UPDATE, and the `ot_requests_runs_cap` CHECK backs it up.
- Supersede (approve step 5) revokes every unrevoked approved row of the root before the new approval, so `ot_requests_one_live_idx` never blocks a later grant. This applies the G1W-09 lesson.
- Halt: approve is refused while halted, revoked after commit if a halt lands, revoked on `onHalted` (every halt path, W-C3c) and `onResumed` (G2W-02), and owed through `revokeOwed`. Resume never restores a grant.
- `createTask` parent is never taken from input, so a model in tree B cannot hang a child under tree A's grant. createTask alone cannot move work across trees.
- `warroom_say`, rhythm, meetings and the app.ts consumers (schedules, watches, devjob, selfReview, praw) keep the raw `offDay()`. OT reaches only the four tree sites.
- The config zod bounds sit inside the DB CHECKs (hours ≤ 12 vs `grant_window` 12 h, runs 1–200, usd ≤ 50, seq 1–5), and the caps are snapshotted per grant.

## Findings

| ID | Severity | Evidence | Problem |
| :-- | :-- | :-- | :-- |
| G1OT-01 | High | `admin/keys.ts` `ADMIN_CONFIG_KEYS` = every schema key "!NEVER.includes(k) && !HANDLER_KEYS.includes(k)"; `admin/names.ts` "config_propose" | The keys are default-allow. Adding `ot.hours/maxRuns/maxUsd/requestsPerRootPerDay/enabled` to `config/schema.ts` makes them writable through `config_propose`, which is a model tool in the admin console (confirmed through `admin/names.ts`), and through the raw schema write in `/settings set` (`settings.ts` "if (isHandlerKey(key)) return handlerSet(...)", otherwise a raw write). The spec says "caps psql-only" but never names `admin/keys.ts`. A tricked admin-console model could propose `ot.maxUsd 50`, `ot.maxRuns 200`, `ot.hours 12`. That breaks the owner's "the model must never widen scope". WEBGRANT-1 already had to list its caps in `HANDLER_KEYS`. |
| G1OT-02 | High | `settleReview()` "if (recovering && (await this.recoverRollup(cur))) return" and "(await this.finalRollup(cur))"; both call "this.rollupJob(...)()" directly, not through `orWorkday` | The spec changes ~977 to a read-only `if (await held(cur.rootId)) return` and adds no consume. Under a live grant, every roll-up started from `settleReview` runs on an off day without `runs_used += 1`. That covers release step 6(d) "settleReview(id, true) for each review task", the boot/resume `sweepReview()`, and the restart flow "sweepReview → settleReview → recoverRollup". Because `live()` ignores the runs/USD terms (spec "live(rootId, day) = same WHERE ... without runs/USD terms"), an exhausted grant still makes `held()` false, so these roll-ups keep running after the cap. This is a consume bypass, and the cap does not bound it. |
| G1OT-03 | High | `runOwnerInner()`: "const approved = await this.approved(task, task.owner); if (!approved) return;" before "this.run"; `approved()` calls `runApprovedCalls`, which does "port.claim(task.id)" then "port.run(task.owner, task, ...)" | The spec puts consume "inside exclusive after todo check and approved(), just before this.run". `approved()` claims and executes admin-approved tool calls, which have real side effects. So on an off day with an exhausted, expired or revoked grant, those tool calls run and only then is the start refused, with "task stays todo". Work runs outside the grant, and the results are claimed but go undelivered until a later run (R4 hold). Today the off-day check returns before `approved()`. |
| G1OT-04 | High | `app.ts` "await webGrants.revokeBeforeHaltedRow()"; `web-grants.ts` `revokeBeforeHaltedRow` "created_at < (SELECT updated_at FROM config WHERE key = 'halted')"; spec "Halt revokes grants: onHalted, onResumed ..., at boot while halted" | The spec has no boot revoke of grants that lived through a halt while the process was down. If halt then resume is written by psql while the bot is stopped (the README's out-of-band halt path), the bot boots not halted with the grant live, which breaks "Resume never restores". Hooks on the running process do not cover this, because neither hook fires. |
| G1OT-05 | Medium | Release step 6(b) "guard.releaseHeldFor(rootId)" (no `otStart`); `warroom.ts` `hold()` "at most one per thread (the newest)" | (a) The released bot-talk starts are not specified to go through consume, unlike step 6(a) "start each via otStart". (b) `hold(key, start)` overwrites by thread key, so a tagged entry must have its tag overwritten together with its start. Otherwise a newer start from a different task (or no task) inherits an old tag. The tag must be the DB `rootId` of the target task (`r.taskId` → `tasks.get`), never the sender's tree. Entries with no task (warroom channel, dept channel) must stay untagged and must never be released by `releaseRoot`. |
| G1OT-06 | Medium | `app-start.ts` expiry "setInterval(..., HOUR_MS)"; `planWorkday(null, ...)` "const today = localDay(" at click time | A request for day D can still read `pending` for up to an hour after local midnight. If D+1 is also off (Sat→Sun) and the admin clicks "Approve whole day" at 00:30, the claim "pending→workday" succeeds and `planWorkday(null)` opens D+1, a day nobody asked for. The approve path has the "expires_at > now()" gate, but the spec gives the day path only "Conditional UPDATE pending→workday (claim)". The same unswept row also blocks a new raise on D+1 until the sweep, because `ot_requests_one_pending_idx` makes ON CONFLICT DO NOTHING silent. |
| G1OT-07 | Medium | Spec consume: "Code refuses consume while halt.isHalted()"; `ot.enabled` is checked only at raise and approve | This is the G1W-08 lesson again: turning `ot.enabled` off would stop new cards but not live grants. The owner's switch must stop OT work immediately, and an error reading the switch must count as off. |
| G1OT-08 | Medium | Spec Security "USD slice checked before each start (overshoot ≤ one run)"; `budget.ts` reserves at provider call time; release step 6(c) "onTaskReady(id) for each non-human todo task" | Release starts N tasks together. All N consume before any reservation exists, so the USD slice can be overshot by up to N concurrent runs, not one. N is bounded by `max_runs`, the concurrency slots and the tree cap, which all still apply. Local-provider runs only bump `calls` ("calls = calls + 1"), so for local mode the only OT bound is `max_runs`, and `max_usd` never moves. The spec statement is false as written. |
| G1OT-09 | Medium | Spec abuse limit "requestsPerRootPerDay, person-started roots only" | The cap is per root only. Any member who can start a human-origin root (chat, slash, voice, under the human rate limit) can start many roots that delegate on an off day, and each raises up to 2 cards in #⚙️-setting. That floods the decider's channel and makes approval fatigue likely. There is no global or per-person daily cap. |
| G1OT-10 | Medium | Card field "Task tree (root title via maskReason, ≤100 chars ...)"; `maskReason` = `redactText` + secret-tail redaction only; `HIDDEN` "/gu" in `embeds/approval.ts` | The root title is user- or model-derived text and the only free text on a decision card. `maskReason` removes secrets but not mentions, masked links, bidi or zero-width characters, or markdown that can fake card lines (for example "Approved by owner"). It needs the same neutraliser the approval embed uses. A `.test()` call on the global-flag `HIDDEN` copy repeats the G1W-06 bug. |
| G1OT-11 | Medium | Spec "Card post fails: `DELETE ... WHERE id=$1 AND card_message_id IS NULL`, incident, next noteHeld raises again" | (a) A deleted row no longer counts toward "today's count < requestsPerRootPerDay", so repeated failures get unlimited retries. (b) If the post succeeds but storing the message id fails (DB fault), the card is in #⚙️-setting with no row, and the next `noteHeld` (every recovery pass) posts another. That spams cards on every pass with no cap. |
| G1OT-12 | Medium | Raise precondition "no live grant"; `live()` "without runs/USD terms"; flow "Grant exhausted ... next noteHeld may raise seq+1" | The flows contradict each other. With `live()` as defined, an exhausted grant still counts as live until `grant_expires_at`, so seq+1 can never be raised. If an implementer "fixes" this by loosening the raise check, it could allow a pending row alongside a usable grant. Two predicates need defining: `usable` (all consume terms) and `unrevoked-unexpired`. Each call site must name the one it uses. |
| G1OT-13 | Low | Approve step 6 "usd_base = COALESCE((SELECT spent_usd + reserved_usd ...)"; `budget.ts` boot "SET reserved_usd = 0" and settle "GREATEST(reserved_usd - $4, 0), spent_usd = spent_usd + $5" | When base includes in-flight reservations, the slice gains headroom when they settle below the estimate or are zeroed at boot. The gain is bounded by the reservations open at approve time. `usd_base = spent_usd` only is the stricter choice: pre-approval reservations then count against the slice, which fails closed. |
| G1OT-14 | Low | Spec "expires_at = next local midnight" computed in JS; CHECK "expires_at > created_at" uses DB `now()` | A request raised in the last seconds before midnight, with app/DB clock skew, violates the CHECK. The insert then throws inside `noteHeld`. A raise fault must not suppress the OFFDAY-1 notice. |
| G1OT-15 | Low | Card "Requested by (actorLabel(root.owner))" | This shows the bot owner of the root, not the person whose request started it. The admin needs to see the person (`root.sourceUserId` as `<@id>`, with no ping) to judge an approval and to spot abuse (G1OT-09). |
| G1OT-16 | Low | `approvalButton` passes "isAdmin: true"; the role check is only in `index.ts` `decide()` | This matches the existing approval pattern and is acceptable. It means the OT handler must not be reachable from any other router (for example the panel or a Praw path), and must refuse when `i.messageId` or `i.channelId` is null (web-grant pattern "!i.messageId ||"). |
| G1OT-17 | Info | SPEND-1 (migration 029) is next | The USD slice SQL hard-codes the task budget key (`DATE '1970-01-01'`, scope `task`, `scope_id = root`). If SPEND-1 moves tree spend, or adds a dept scope that the tree counter no longer mirrors, the slice silently reads 0 and `max_usd` stops binding (it fails open). |
| G1OT-18 | Info | `createTask` text "It will start now under approved OT (until HH:MM)" | The text is wrong when the grant runs out before the child starts. It is not a security issue, but a person reading the reply could expect work that will not run. "Can start now while OT runs remain (until HH:MM)" is more accurate. |

## Binding conditions (Gate 2)

- **OT-C1 (G1OT-01)**: add all five `ot.*` keys to `HANDLER_KEYS` in `admin/keys.ts` with a comment like the WEBGRANT-1 one. Add a `handlerSet` case for `ot.enabled` only. Extend the default-branch text in `discord/commands/settings.ts` to cover `ot.` caps ("the owner sets the OT caps in the database"). Tests: `admin/keys.test.ts` asserts `isAdminConfigKey(k) === false` for each `ot.*` key; `discord/commands/settings.test.ts` asserts that `/settings set ot.maxUsd 50` is refused and `ot.enabled false` is accepted and audited.
- **OT-C2 (G1OT-02)**: bind by hold point, not by task origin. Every start from `orWorkday`, from the guard hold, from the `settleReview` recover/final roll-up, and past the `runOwnerInner` off-day gate goes through `otStart` (consume first, start only on success, re-hold tagged on failure), whatever the origin of the target task. A roll-up runs on the parent, which is usually the human-origin root. That includes `recoverRollup` and `finalRollup` when they are reached from `settleReview`, release step 6(d), `sweepReview` and boot recovery. `settleReview` may still close a task to `done` without a run under the read-only check. Tests: in `agents/scheduler.ot.test.ts`, (i) a live grant plus a review task whose last child is done gives `runs_used + 1` and one roll-up; (ii) an exhausted grant (`runs_used = max_runs`) plus the same review task gives no roll-up and the task stays `review`; (iii) two sweeps in a row consume once.
- **OT-C3 (G1OT-03)**: in `runOwnerInner`, consume after "task.status !== 'todo'" and before `this.approved(...)`. A failed consume returns before `runApprovedCalls` is reached. Test in `agents/scheduler.ot.test.ts`: a todo task with an approved tool claim and an exhausted grant ends with `approvedTools.claim` not called and the task still `todo`. Repeat it with a live grant: claim called once, `runs_used + 1`.
- **OT-C4 (G1OT-04)**: add an `OtRequestRepo.revokeBeforeHaltedRow()` that revokes approved, unrevoked rows with `decided_at < (SELECT updated_at FROM config WHERE key='halted')`. Call it at boot next to the web-grant one in `app.ts`, before the scheduler attaches or the recovery pass runs. Test in `db/repos/ot-requests.int.test.ts`: a grant decided before a halted-row write, then `halted=false` written, means the boot revoke marks it `halt` and `consume` refuses. A grant decided after the write is untouched.
- **OT-C5 (G1OT-05)**: `WarroomGuard.hold(key, start, rootId?)` stores start and tag together and replaces both. `releaseHeldFor(rootId)` returns only entries whose tag equals `rootId`. `releaseRoot` starts each one through `otStart`. The tag is `tasks.get(r.taskId).rootId` read from the DB, and entries with no task are untagged. Tests: `agents/warroom.test.ts` covers tag overwrite on re-hold, untagged entries never released, and `releaseHeldFor('A')` leaving B's entries in place. `agents/scheduler.ot.test.ts` covers a bot message from tree A posted into tree B's task thread: it is held and tagged B, and a grant for A does not start it.
- **OT-C6 (G1OT-06)**: the "day" claim is one conditional UPDATE that carries the same gates as approve: digest, `card_message_id`, `card_channel_id = CONFIG_CHANNEL_ID`, `status='pending'`, `expires_at > now()`, and `local_day = today(schedule.timezone)`. The workday plan is `planWorkday(row.local_day, false, deps)`, never `null`. The raise path expires this root's stale pending row (`expires_at <= now()`) in the same statement or transaction before the insert. Tests in `governance/ot.int.test.ts`: an unswept pending row from yesterday is refused `expired` for both `day` and `approve`, and `schedule.workDays` is unchanged. After midnight a new raise succeeds without waiting for the sweep.
- **OT-C7 (G1OT-07)**: `consume` and `live` refuse when `ot.enabled !== true`, read live on each call, and a read error counts as disabled. Optionally the `/settings` write of `false` also revokes with `revoke_reason 'admin'`, which the CHECK already allows. Test in `db/repos/ot-requests.int.test.ts`: a live grant, then `ot.enabled=false`, means consume refuses and `held()` is true.
- **OT-C8 (G1OT-08)**: correct the spec Security text to "USD overshoot ≤ the runs started concurrently before the first reservation (bounded by max_runs and the scheduler concurrency); local-provider runs are bounded by max_runs only". Owner accepts this as residual risk 2 below. Alternatively, serialise consume per root through a per-root advisory lock held until the run's first reservation. Test in `agents/scheduler.ot.test.ts`: release of 5 todo tasks with `max_runs=3` starts exactly 3 and re-holds 2.
- **OT-C9 (G1OT-09, G1OT-15)**: add a global daily card cap `ot.requestsPerDay` (default 20, int 1–100, in `HANDLER_KEYS`, psql-only) and a per-requester daily cap `ot.requestsPerPersonPerDay` (default 4) keyed on `root.sourceUserId`. Hitting a cap means no card plus one #bot-log incident per day. The card shows the requesting person as a no-ping mention. Tests: `db/repos/ot-requests.int.test.ts` for both caps under concurrent raise; `discord/embeds/approval.test.ts` for the requester field with `allowedMentions` parse `[]`.
- **OT-C10 (G1OT-10)**: the root title on the card and in the audit goes through `maskReason`, then the approval-embed neutraliser (hidden and bidi characters stripped with a non-global regex or a fresh instance, handles defanged, markdown links and code fences escaped), and is cut to 100 characters after neutralising. Card posts and edits carry `allowedMentions: { parse: [] }`, and the "approved by <@u>" edit pings nobody. Test in `discord/embeds/approval.test.ts`: a title with `@everyone`, `<@123…>`, `[x](https://evil)`, U+202E and U+200B renders inert, and two calls in a row on the same hidden-character input give the same result.
- **OT-C11 (G1OT-11)**: a failed card post does not delete the row. It moves it to a terminal state that still counts toward the daily caps (`status='expired'` with `card_message_id` NULL is allowed by the CHECKs). If the post succeeded but storing the id failed, delete the orphaned message (best effort) or leave the row counted. Test in `governance/ot.int.test.ts`: three post failures in a row on one root give at most `requestsPerRootPerDay` attempts, and a store fault after a successful post gives no second card on the next `noteHeld`.
- **OT-C12 (G1OT-12)**: define `ot.usable(root, day)` (every consume term, read only) and `ot.unexpired(root, day)` (status approved, unrevoked, unexpired, same local_day, root alive). The raise precondition uses "no usable grant" and "no pending". `held()` uses `usable` at every hold point, whatever the origin of the target task, so that an exhausted grant re-holds and re-raises instead of falling through to unconsumed paths. Every call site names its predicate. Test in `agents/scheduler.ot.test.ts`: an exhausted grant plus a held task raises seq 2 exactly once, and approving seq 2 supersedes seq 1.
- **OT-C13 (G1OT-13, G1OT-17)**: `usd_base = spent_usd` only. The slice SQL takes the task budget key from one exported helper in `governance/budget.ts` (not a literal `1970-01-01`). The SPEND-1 Gate 1 must re-check the slice against its new keys. Test in `db/repos/ot-requests.int.test.ts`: reserve and settle through `Budget` on the root, and consume refuses once settled spend minus base ≥ `max_usd`.
- **OT-C14 (G1OT-14)**: compute `expires_at` and `local_day` in SQL from `now()` and the configured zone (`(date_trunc('day', now() AT TIME ZONE $tz) + interval '1 day') AT TIME ZONE $tz`), or clamp to `> now()`. `ot.raise` runs in its own `safe()` so a raise fault never skips the OFFDAY-1 notice claim. Test in `agents/scheduler.offday.notice.test.ts`: a throwing `ot.raise` still posts the one notice.
- **OT-C15 (fail closed, consume)**: `held(rootId)` returns true when `live`/`usable` throws, and `otStart` does not start when consume throws. Both report through `incidents` with fixed text plus a SQLSTATE code only (W9 pattern), with no root title or thread content. `live`/`consume` pay `revokeOwed` first and refuse while it cannot be paid. A stray `ot.approved` event with no usable grant starts nothing, because every `releaseRoot` start is consume-gated. Tests in `agents/scheduler.ot.test.ts`: a DB fault in `usable` keeps work held, and emitting `ot.approved` with no grant starts nothing. In `db/repos/ot-requests.int.test.ts`: a halt revoke that fails sets `revokeOwed`, and the next `live` pays it.
- **OT-C16 (G1OT-16, decision binding)**: the OT handler is reached only from `approvalButton`, after the `index.ts` guard. It refuses when `i.messageId`, `i.channelId` or the stored `card_message_id` is null. `releaseRoot` takes `rootId` from the committed row (`RETURNING root_id`), never from the customId. Tests: `discord/commands/approval.test.ts` covers malformed `approval:ot:` shapes, null messageId, an OT customId clicked in a category approvals room (`wrong_card`), and a non-admin refused by the guard. `governance/ot.int.test.ts` covers a digest tamper, a wrong message, approve vs day vs deny races (exactly one wins), and halted-after-commit revoking before `ot.approved` is emitted.

- **OT-C17 (whole-day label, G1W-10 lesson)**: the day button label or its confirmation reply states that it opens all held work for the day, not just this tree (for example "Make today a workday (all work)"). Test in `discord/embeds/approval.test.ts`.

The spec's own test list (repo int, decision int, scheduler unit, card render, the `scheduler.offday.notice.test.ts` notices at :32/:45/:69) stays binding in addition to the above.

## Domain coverage

| Domain | Result |
| :-- | :-- |
| Secrets | PASS. No new secrets, and the card has no tokens. |
| Injection | PASS with OT-C10. All SQL is parameterised, the customId is a strict regex, and the root title is the only free text. |
| Prompt security | PASS. Prompts are untouched (D1). createTask text is fixed (G1OT-18 wording). |
| AuthN/AuthZ | PASS with OT-C1, OT-C16. Live Bot Admin role per click, card bound to its channel and message, `day` only in CONFIG_CHANNEL_ID. |
| Transport / rate limiting | Conditional on OT-C9 (global and per-person caps). |
| Native memory | N/A (TypeScript). |
| Log privacy | PASS with OT-C10, OT-C15. Masked title, no thread content, fault text fixed. |
| Safety override (halt) | Conditional on OT-C4, OT-C7, OT-C15. |
| Containers / supply chain | N/A. No new dependency or image. |

## Residual risks for the owner to accept in writing

1. "Approve whole day" opens every tree, schedules, watches and bot talk for the day. This is the same power and role as `/holiday workday` (see OT-C17 for the label).
2. USD overshoot can reach the number of runs started at once, bounded by `max_runs` and the tree, bot and company caps. Local-mode runs are bounded by run count only (OT-C8).
3. A grant covers the whole root tree, including children delegated by any head in it. A tainted run can delegate within the tree and consume the shared grant (same as G1W-10).
4. A run already consumed finishes after revoke. Halt aborts it, but admin revoke does not.

## Audited files (md5 at review end)

```
f1c29a13326c4645bffc34a16c9f027c docs/superpowers/specs/2026-11-08-ot-request-design.md
d0230f3e068c0cbec6af044f094abc5b agents/scheduler.ts
08df3ddf057637823c99207d55c3528e agents/warroom.ts
278c470c944459c9f32bc1154804fb59 agents/approved-tools.ts
628927d05ccf582a9a2337c31966155e company/calendar.ts
6791749b0b6c0d6bc070c9ffff32e2fe governance/approvals.ts
d1eced2ced6a2340fcc0e6f1cfc54e03 governance/halt.ts
5691102d781607a1694bd6610decbfbf governance/budget.ts
322a37aa90da5948d67e4019c5f901c5 discord/commands/approval.ts
10368aa78340d7de74eb1cc94946c656 discord/commands/index.ts
6cd098d50db0628822621ff07cacee36 discord/commands/plans.ts
ea74c0981f872fb0804547a9f99d0d62 discord/commands/settings.ts
e6ddde3582a0ec008cc955b10dfaeeec discord/embeds/approval.ts
20585e89415f3f1559fce1879a18d346 admin/keys.ts
aa3b77b2ff1829a829797437cb16c74e tools/builtin/createTask.ts
d3c17954b12fddea775f671e2cc1d797 db/repos/web-grants.ts
979168b103848d2de84313756d11e9c8 app.ts
c41c8fb818f8baff69ff7be8f371698b app-start.ts
```

## Owner sign-off (2026-11-08, recorded by controller from the owner's answer in chat)
The owner ACCEPTS residual risks 1–4 (whole day opens everything; USD overshoot by runs started at once, local bounded by runs; grant covers whole tree incl. children of any head; consumed run finishes after revoke).
