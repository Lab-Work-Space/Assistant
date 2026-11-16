---
title: "Security Gate 2: overtime requests (OT-1)"
gate: 2
status: APPROVED
date: 2026-11-08
task: OT-1
project: labworkspace (BOT/Assistant)
gate1: docs/security/2026-11-08-gate1-ot-request.md
spec: docs/superpowers/specs/2026-11-08-ot-request-design.md
migration: 030_ot_requests
---

# Security Gate 2: overtime requests (OT-1)

Verdict: **APPROVED**, with recommendations. Code and tests satisfy all of OT-C1 to OT-C17. Every finding below is Low or Info, and each one fails closed: a fault means no OT or held work, never wider OT. None of them has to land before release. Owner residual risks 1 to 4 from Gate 1 still apply unchanged.

## Scope

The OT-1 implementation is uncommitted. Audited files: migration 030 (up and down), `db/repos/ot-requests.ts`, `governance/ot.ts`, `discord/commands/approval.ot.ts`, and the OT parts of `discord/commands/{approval,settings,plans,types,index}.ts`, `discord/embeds/{approval,index}.ts`, `agents/{payload,warroom,scheduler,loop}.ts`, `core/events.ts`, `tools/types.ts`, `tools/builtin/createTask.ts`, `governance/budget.ts`, `config/{schema,defaults}.ts`, `admin/keys.ts`, `app.ts` and `app-start.ts`. Tests: every `*.ot.test.ts`, plus `db/repos/ot-requests.int.test.ts`, `governance/ot.int.test.ts`, `tests/integration/ot-acceptance.int.test.ts` and `agents/scheduler.offday.notice.test.ts`.

Verification run:
- `npx tsc --noEmit`: exit 0, before and after the fix below.
- Unit, 12 files and 158 tests passed: `discord/port.ot`, `admin/keys.ot`, `agents/scheduler.ot`, `agents/warroom.ot`, `tools/builtin/createTask.ot`, `discord/commands/settings.ot`, `discord/commands/approval.ot`, `discord/embeds/approval.ot`, `agents/scheduler.offday.notice`, `agents/warroom`, `discord/commands/approval`, `discord/commands/settings`.
- Int, against 127.0.0.1:54329/assistant_test:
  - `db/repos/ot-requests`, `governance/ot`, `tests/integration/ot-acceptance` and `db/migrate`: 4 files, 77 tests passed.
  - After the fix: `governance/budget`, `governance/budget.warroom` and `db/repos/ot-requests`: 3 files, 77 tests passed.
  - `db/executor-role`: 11 tests passed. It enumerates every base table, so it also shows that the executor role cannot read or write `ot_requests`.
- `governance/budget` unit: passed.

## Conditions verified (code + test)

| ID | Result | Evidence |
| :-- | :-- | :-- |
| OT-C1 | PASS | `admin/keys.ts` HANDLER_KEYS lists all seven `ot.*` keys. `settings.ts` has a `case 'ot.enabled'` that calls `planOtEnabled`. Other `ot.` keys get the "owner sets the OT caps in the database" text. No admin op touches `ot.*`. Tests: `admin/keys.ot.test.ts` (every key, plus a test that the schema has no uncovered key) and `settings.ot.test.ts`. |
| OT-C2 | PASS | `orWorkday`, `startRollup` (used by `recoverRollup` and `finalRollup`), the bot-talk branch of `handleMessage` and `releaseRoot` all start work through `otStart` (consume first). `settleReview` makes only the read-only `treeHeld(cur.rootId)` check. Tests: `scheduler.ot.test.ts` (i), (ii) and (iii), plus the restart test. |
| OT-C3 | PASS | `runOwnerInner` consumes after the `status !== 'todo'` check and before `ensureThread` and `approved()`. Repo-wide grep: `runApprovedCalls` is called only from `Scheduler.approved()`. `interruptedCalls` at boot only reports. `resumeApproved` only emits `task.ready`, which goes through `runOwnerInner`. Tests: "exhausted grant never reaches the approved tool calls" and "live grant: claim called once". |
| OT-C4 | PASS | `OtRequestRepo.revokeBeforeHaltedRow` (`decided_at < config.halted.updated_at`) is called in `app.ts` before the scheduler is built and before `recover()`. A boot while halted runs `revokeAll('halt')`. Tests: repo int OT-C4 and the acceptance boot tests. |
| OT-C5 | PASS | `WarroomGuard.hold(key, start, rootId?)` replaces the start and the tag together. `releaseHeldFor` returns only entries with that tag. The tag is `heldTask.rootId`, where `heldTask` is read from the DB through the router's `taskByThread`. Talk with no task stays untagged. Tests: `warroom.ot.test.ts` and the scheduler A/B thread test. |
| OT-C6 | PASS | `claimDay` is one conditional UPDATE with gates on digest, message, `card_channel_id = CONFIG_CHANNEL_ID`, `expires_at > now()` and `local_day = today(tz)` on the DB clock. `decideDay` opens `row.localDay`. `raise` expires the stale pending row of this root first. Tests: repo and governance int. |
| OT-C7 | PASS | The repo `gate()` reads `halt.isHalted()` and `ot.enabled` on every call, and a throw counts as `disabled`. `approve` has an `enabled()` gate. Switching off with `/settings` also revokes with reason `admin`. See G2OT-03 for the psql path. |
| OT-C8 | PASS (owner residual 2) | No per-root lock. The spec Security text is corrected. Test: 5 todo tasks with `max_runs` 3 start exactly 3. |
| OT-C9 | PASS | Three caps (per root, per day, per person) are counted under advisory lock `7_030_001` inside the raise transaction. When a cap is hit there is no card and one incident per day and kind. The card shows the person as a no-ping `<@id>`. Tests: concurrent raise int and the card render test. |
| OT-C10 | PASS | The title goes through `maskReason`, then `escapeCardText`: control and hidden characters become visible, the text is cut, then markdown is escaped, `@` is defanged and `<` is escaped. `HIDDEN` is used only with `.replace`, so its global flag cannot carry state between calls. Card posts and edits use `allowedMentions: { parse: [] }` (`embeds/index.ts:113`, `port.ts:399/851/866`). Tests: `embeds/approval.ot.test.ts` and `port.ot.test.ts`. |
| OT-C11 | PASS (deviation ruled below) | A failed post sets the row to `expired`, and the row still counts. If storing the message id fails, the row stays pending with no card: it blocks a second card and counts, and the orphan card loses its buttons. Tests: governance int. |
| OT-C12 | PASS | `usable` uses every consume term. `unexpired` ignores runs and USD and is used only for the `createTask` text and the exhausted audit. The raise refuses on a usable grant, not on an unexpired one. Test: exhausted grant, then seq 2 raised once, then supersede. |
| OT-C13 | PASS | `usd_base = spent_usd` only. The slice key comes from `taskBudgetKey`. In this audit, `reserve` was also changed to use the same helper (see Fixed). |
| OT-C14 | PASS | `expires_at` and `local_day` are computed in SQL from `now()` and the zone. `ot.raise` runs in its own `safe()` before the notice claim. Test: `scheduler.offday.notice.test.ts:119`. |
| OT-C15 | PASS | `treeHeld` returns true on a throw. `usable` and `consume` never throw and report a fixed text plus SQLSTATE. `revokeOwed` is paid in `precheck`. A stray `ot.approved` starts nothing. Tests: scheduler and repo int. |
| OT-C16 | PASS | `approval:ot:` is matched first in `approvalButton`, and a malformed `approval:ot:` id is refused without falling through. `otButton` refuses a null `messageId` or `channelId`. Each decision checks the stored channel, message and digest. `rootId` comes from `RETURNING`. The only entry is `approvalButton`, after the `index.ts` guard. Tests: `approval.ot.test.ts` and governance int races. |
| OT-C17 | PASS | The label is "Make today a workday (all work)" and the reply says it opens all held work. Tests: card and handler tests. |

## Hole audit (beyond the conditions)

- **Scope leakage across trees:** PASS.
  - Every grant lookup uses a DB `rootId`: the task row, the parent row, the router's `taskByThread`, or the committed OT row. Nothing comes from model input or the customId.
  - In bot talk, the tag is the target task's root. A grant for tree A cannot start tree B's held talk (tested).
  - `createTask` parent is still never taken from input.
- **Every start path consumes:** PASS.
  - Live paths consume: owner run, roll-up after a child ends, bot talk, and roll-ups from `settleReview`.
  - The boot recovery pass (through `runOwnerInner`), `sweepReview` and `releaseRoot` consume.
  - Approved-call replay comes after consume (OT-C3).
  - `dayTurned` releases without consuming only on a workday, as designed.
  - `warroom_say`, rhythm and meetings keep the raw off-day check (tested).
- **Halt, resume, boot and DB-fault revoke:** PASS.
  - `onHalted` and `onResumed` both revoke.
  - Boot revokes in two ways: `revokeBeforeHaltedRow`, and `revokeAll` when booting halted.
  - `precheck` re-fires the revoke while halted and pays an owed revoke after a fault.
  - `approve` refuses while halted, and a halt that lands after commit revokes before the emit.
- **customId forging and clicks in category rooms:** PASS.
  - The pattern is strict and anchored, and cannot overlap REVOKE, BATCH or APPROVAL ids.
  - The digest is a 48-bit random value.
  - A click in a WS7 room fails the stored-channel check and returns `wrong_card`. `day` also requires CONFIG_CHANNEL_ID.
  - `toPayload` builds the payload fresh, so a model cannot emit `otButtons`.
- **Whole-day path:** PASS.
  - It uses the same `planWorkday` / `applyPlan` and audit as `/holiday workday`, for the row's own day. `planWorkday` refuses past dates.
  - "Already a workday" counts as success. Any other error gives the claim back.
- **Budget interplay (SPEND-1) and lock order:** PASS.
  - OT never lifts a reservation: company, dept month, bot, tree and local caps still apply.
  - The slice reads `budget_days` without a lock, and the OT paths never lock `budget_days`.
  - Approve locks the root task, then the OT row, matching `decide()`.
  - Consume, the sweeps and the revokes take OT rows only.
  - One benign case: a raise that expires this root's stale pending row, then INSERTs (the FK takes KEY SHARE on the task row), can deadlock with an approve click on that same stale card (task FOR UPDATE, then OT row). Postgres aborts one side with 40P01, and both sides fail closed: the raise sends an incident and still the notice, and the click gets "nothing was changed". Info.
- **Card content neutralisation:** PASS. Free text is limited to the root title (OT-C10) and dept names, which also go through `escapeCardText`. Everything else is code values, snowflake-checked mentions and `<t:…>` stamps. Thread lines are fixed text.
- **Audit and log leakage:** PASS.
  - Audit outcomes carry ids, counts and reasons only. The title never reaches the audit (tested).
  - Fault reports carry a fixed text plus SQLSTATE. `otButton` logs `errName` only.
- **Migration:** PASS.
  - The CHECKs match the spec, and each zod bound sits inside its CHECK (tested).
  - There are partial unique indexes for one pending request and one live grant.
  - Down is `DROP TABLE IF EXISTS`.
  - The executor role has no grant on the table.
  - No production code deletes `tasks`, so the FK without `ON DELETE` cannot block a job.

## Deviations (ruled)

| Deviation | Ruling |
| :-- | :-- |
| Handler in `approval.ot.ts` | Accepted. It is reachable only from `approvalButton` after the guard (OT-C16 holds). |
| Per-person cap keyed on the root's human requester, falling back to `sourceUserId` | Accepted. For person-started roots this is the person who caused the request, which is what OT-C9 is for. |
| USD slice from `spent_usd` only | Accepted. It is exactly OT-C13. |
| Title: `maskReason`, then `escapeCardText`, with the cut before markdown escaping | Accepted. Cutting before escaping never leaves a broken escape sequence. Hidden characters are made visible before the cut, so the cut counts them. The result is at most about 3x of 100 characters, well under the 1024-character field limit. |
| A store fault after a post leaves a pending row with no buttons until midnight | Accepted. OT-C11 allows "leave the row counted". The row cannot be decided because no card is stored, it blocks a second card, it counts toward the caps, and the sweep or `closeMoot` ends it. |
| `otUntil` returns an HH:MM string | Accepted. It is read only and formatted in `schedule.timezone`. |
| Extra `peek()` | Accepted. It is a hot-path read only. The caller checks enabled, off day and halt before it, and `raise` re-checks everything under the lock. |
| No per-root advisory lock for consume | Accepted under the alternative OT-C8 allows and owner residual 2. The spec Amendments line "serialise consume per root" is stale (see Book updates). |
| Tests in `*.ot.test.ts` instead of the named files | Accepted. Every condition has a test, mapped above. |

## Findings

| ID | Severity | Evidence | Problem | Remediation | Owner |
| :-- | :-- | :-- | :-- | :-- | :-- |
| G2OT-01 | Low | `ot-requests.ts` `precheck` "void this.revokeAll('halt')"; `revokeBeforeHaltedRow`; `app.ts` `otRevokeHalt` repo branch; approve supersede UPDATE | Some revokes go through the repo only, so the card is never closed: halt re-revoke in `precheck`, the boot revoke, the hook before `otService` exists, and supersede of seq 1. The old card keeps showing "OT approved … runs 0/N" and the Revoke button. A click then answers "Already ended", so there is no power gain, but an admin can misread a revoked grant as live. | Return the revoked rows from these paths and close their cards through `OtService.revokedCard`: at boot after the port is up, in `approve` for superseded rows, and in `precheck` through an `onRevoked` callback. | backend |
| G2OT-02 | Low | `scheduler.ts` `releaseRoot` "if (!(await this.otStart(rootId, h.start))) this.guard.hold(h.key, h.start, rootId)" | (a) If the consume fails, re-holding can overwrite a newer start that was held on the same thread key during the await. That newer bot message is lost. (b) The return value of `guard.hold` is ignored, so when the hold is full the start is dropped without a log. Both lose work. Neither widens a grant. | Add a `holdIfAbsent` (re-hold only when no entry exists for the key), and log when `hold` returns false, as the `handleMessage` branch does. | backend |
| G2OT-03 | Low | `planOtEnabled` revokes only on the `/settings` path; the repo `gate()` only refuses while the switch is off | (a) If `ot.enabled` is set to false by psql (the owner path) and set back to true the same day, the old grants are usable again. (b) If the `/settings` revoke fails with a DB fault, the debt is not recorded (`revokeOwed` is tracked for halt only). Only the owner or a Bot Admin can do this, and only for grants they already approved. | Add `cfg.watch('ot.enabled', v => v === false && otService.revokeAll('admin'))`, or a `disabled`-owed flag like `revokeOwed`. | backend |
| G2OT-04 | Info | `unclaimDay` "SET status='pending' … WHERE status='workday'"; `ot_requests_one_pending_idx` | If a raise inserts a new pending row while a `day` claim is open and the plan then fails, `unclaimDay` hits the unique index. `safe()` swallows the error and the row stays `workday` although the day was not opened. This fails closed: one card is lost and nothing is widened. This is the open risk backend listed. | Optional: on 23505, set the claimed row to `expired` instead. | backend |
| G2OT-05 | Info | `claimDay` checks neither `ot.enabled` nor halt | "Make today a workday" still works on a card posted before OT was switched off. It is the same power and role as `/holiday workday` (owner residual 1), so no change is required. | None, or refuse `disabled` for parity with approve. | backend |
| G2OT-06 | Info | Repo and governance int tests use the real DB clock against midnight in `schedule.timezone` | The tests can be flaky close to local midnight (backend's open risk). This is not a security issue. | Pin the test timezone so local midnight is far from the CI run time, or skip within 2 minutes of it. | tester |
| G2OT-07 | Info | raise transaction (stale UPDATE, then INSERT with FK KEY SHARE) vs approve (task FOR UPDATE, then OT row) | A deadlock (40P01) is possible only for a click on that root's stale card at the same moment as a raise. Both sides fail closed (see the hole audit). | None. | none |

## Fixed in this audit

- `governance/budget.ts` `reserve`: `taskKey` is now built with the exported `taskBudgetKey(rootId)` instead of a second literal `{ day: TASK_DAY, scope: 'task', scopeId: rootId }`. The OT USD slice and the reservation can then never drift apart: before, if someone moved the key in one place and not the other, `max_usd` would fail open (G1OT-17). There is no behaviour change. Re-verified: tsc exit 0; `governance/budget.int`, `governance/budget.warroom.int` and `db/repos/ot-requests.int` pass (77 tests); `governance/budget` unit passes.

## Domain coverage

| Domain | Result |
| :-- | :-- |
| Secrets | PASS. No new secrets. The title goes through `maskReason` and `redactText`, and the port redacts again. |
| Injection | PASS. All SQL is parameterised. The timezone is a bound parameter cast with `::text`. The customId is a strict regex. |
| Prompt security | PASS. No new model tool or prompt. The `createTask` text is fixed. |
| AuthN/AuthZ | PASS. A live Bot Admin role check on each click, binding to the stored card, and `day` only in #⚙️-setting. A model cannot raise, approve or widen. |
| Transport / rate limiting | PASS. Per-root, global and per-person daily caps. |
| Native memory | N/A (TypeScript). |
| Log privacy | PASS. Fixed texts plus SQLSTATE, and no title in the audit. |
| Safety override (halt) | PASS. Every halt path revokes, boot revokes too, a failed halt revoke is owed, and resume restores nothing (G2OT-03 is an `ot.enabled` gap, not a halt gap). |
| Containers / supply chain | N/A. No new dependency or image. |

## Audited files (md5 at review end)

```
49c504bb94cf566f12ae11e6f3c24ec4 db/migrations/030_ot_requests.up.sql
d561c2532956994631cd5192a424b738 db/migrations/030_ot_requests.down.sql
2c90cf1e87c1856e30850fa5b5eadb67 db/repos/ot-requests.ts
7402d344a9b90782365de1bf3b8f489e governance/ot.ts
43bc4494434a1289d44aa7d611a5e5a4 discord/commands/approval.ot.ts
b460b4753ed40fc435823eb71f7cd375 discord/commands/approval.ts
649e0fabc369a345b895f04328b64f7d discord/commands/settings.ts
139ecc5acc0c341b030dbbf3dafeac64 discord/commands/plans.ts
3489f49bb58392f6f585d094b634fa87 discord/commands/types.ts
5c1a9b34a15b3bf2ed3ea61086c38d2e discord/commands/index.ts
c940a6d0d2c5a2f0ceb147d92f9a279e discord/embeds/approval.ts
7cd784ce3cae719ad709c8d5cbb05bba discord/embeds/index.ts
98ad8262711f0b33426d5813b3bd9f22 agents/payload.ts
943f9c5f42b668f6cdd52f4eca5f634f core/events.ts
07323820c9d7de17d9e1b9f0a1e051df agents/warroom.ts
a8007bb9f076ef38212dc7636b0516b4 agents/scheduler.ts
1805b8eab0c3fa760e32e320c8b9e53c agents/loop.ts
03f09842b161b9ad69e760a8cb2cf250 tools/types.ts
23260722b896c2cd8081213eedd89108 tools/builtin/createTask.ts
fb56d793691b5c8909684279a6973fce governance/budget.ts
1a1b2f6bd81e60deae58717f0e330d5f config/schema.ts
1d6a3219e91dc5204f221d8eb013db97 config/defaults.ts
764612cd14208080951aafcba3d8e584 admin/keys.ts
db0f4c56297378d02aa8434913d38b2f app.ts
1d4d6f5af8f4f94bb442b255efa67cb7 app-start.ts
29b9ab038997052366d267350b4e6580 docs/superpowers/specs/2026-11-08-ot-request-design.md
```

## Book updates

- `docs/superpowers/specs/2026-11-08-ot-request-design.md`, Amendments: the OT-C8 line ends "serialise consume per root", but the build has no per-root lock (owner residual 2). Reword it to "no per-root lock; overshoot accepted as residual 2".
- The same spec, "Card post fails": the base text still says `DELETE`. The Amendments win, but the base line should say the row ends as `expired`, or stays pending with no card on a store fault.
