---
title: "Security Gate 2: batched tool approval cards (APPROVAL-BATCH-1)"
gate: 2
status: CONDITIONAL_APPROVE
date: 2026-11-08
task: APPROVAL-BATCH-1
project: labworkspace (BOT/Assistant)
gate1: docs/security/2026-11-08-gate1-approval-batch.md
spec: docs/superpowers/specs/2026-11-08-approval-batch-design.md
---

# Security Gate 2: batched tool approval cards

Verdict: **CONDITIONAL_APPROVE**.

Code conditions B1 to B14 are met. One Medium hole is fixed in this audit (G2AB-01). Two conditions are open:
- a pre-release live probe in the test guild, which the brief forbids here;
- one Medium robustness fix for backend (G2AB-02).

## Scope and method

Scope: the batch feature only, on the uncommitted working tree.
- `db/migrations/026_approval_batch.{up,down}.sql`
- `db/repos/approval-batches.ts`
- `governance/approval-batches.ts`
- `governance/approvals.ts`: `decideRow`, `decideBatch`, `request()` "return { ...r.rows[0]!, kind }"
- `governance/canonical.ts`: `itemsDigest`
- `discord/embeds/approval.ts`: `toolCallView`, `compactItem`, `batchFits`, `batchApprovalPayload`, `batchRows`, `BATCH_APPROVAL_ID`
- `discord/embeds/index.ts`: `buildBatchCard`
- `discord/commands/approval.ts`, `discord/commands/types.ts`, `discord/port.ts`: `updateCard`
- `discord/approval-rooms.ts`: `isNonSensitiveTool`
- `agents/scheduler.ts`: the `approval.requested` handler and `recoverApprovalBatches`
- `agents/payload.ts`: `batchButtons`
- `app.ts`: the batching wiring

The other uncommitted work in the tree (WORKDAY-1, P5, HIST-1, F1 and others) is out of scope.

Runs:
- `npx tsc --noEmit`: clean, before and after the fix.
- Final run on the md5-listed tree, after the fix:
  - Unit (vitest `unit`): `discord/commands/`, `discord/embeds/approval-batch.test.ts`, `discord/embeds.test.ts`, `discord/port.test.ts`, `agents/approval-card.test.ts`, `discord/approval-rooms.test.ts`. 19 files, 270 tests, all green.
  - Integration (vitest `int`, local test DB `127.0.0.1:54329/assistant_test` only): `approval-batch.int`, `approval-batch-app.int`, `approval-batch-owner-case.int`, `tool-approval.int`, `governance/approvals.int`, `tests/integration/approvals.int`. 6 files, 130 tests, all green.
- No real Discord or Gemini call was made, and the live DB was not touched.

## Binding conditions B1 to B14

| ID | Status | Evidence |
| :-- | :-- | :-- |
| B1 | MET (after G2AB-01) | `approvalButton` calls `batchOf()` and then `refreshBatchCard()` on the success path and on the `not_pending`/`expired` path, and `closeInPlace` only for kind `none`. `port.updateCard` keeps the "only the hq client's own card" author check and edits `i.channelId`/`i.messageId`. The batch moves to `closed` when every member is terminal. Tests: `approval.test.ts` (a), (b), (c), plus "last pending item closes" and "lookup fails, card left alone". |
| B2 | MET | `compactItem` returns null when `toolCallView(...).cut` is set or the query has more than one chunk. This is one shared helper with the solo card, not a copy. The value is measured after escaping, with `STATUS_LONGEST`, against 1024. `batchFits` checks title plus body plus fields against 6000, and `batchApprovalPayload` checks again at the longest status. `buildBatchCard` throws instead of truncating, and `postBatchCard` asserts 1 message and 1 embed. `buildBatchCard` counts the footer through `embedSize`, but `batchFits` does not (see Note N1). |
| B3 | MET | `oneLine`: every model value goes through `JSON.stringify` before `escapeCardText`, and `oneLineOf` runs after. Labels are bold and written by code. The field name `#<id> · <tool>` comes from code values. `escapeCardText` maps U+2028/U+2029 and C0 controls to spaces, and escapes `*`, `[`, `(`, `#`, `>` and `@`. Test: "an injected Target stays one line". |
| B4 | MET | Composite FK `approvals_batch_fk (batch_id, task_id, requested_by)`. `approvals.task_id` and `approvals.requested_by` are `NOT NULL` in 001, so MATCH SIMPLE binds whenever `batch_id` is set. Also present: the kind CHECK, the immutability trigger (`BEFORE UPDATE OF batch_id`), the state, count and digest CHECKs, and the unique open index. In the join, the batch row is taken `FOR UPDATE ... state='open'`, and `item_count < 8` is incremented in the same tx. Test: B4 int. |
| B5 | MET | `sealIn`: `FOR UPDATE`, then the `state='open'` re-check, then a separate SELECT of the members, then `itemsDigest` in app code. `decideBatch` checks stored == click == recomputed under root -> batch -> members locks. Tests: B5 race, foreign digest, changed sha, late forced member. |
| B6 | MET | Members are decided in ascending order in one tx. Expired or not-pending members are skipped and reported. `kind`, `batchable(toolName)` and `taskId` are re-checked. `emitChanges` runs after COMMIT. Labels carry `(n)` and `#id`, the title carries the count, and each item has its own reason (`REASON_MAX`). Tests: B6 int (single `task.changed`, deny cancels once, expired newest, halted). |
| B7 | MET | `eligible = rooms.routable(a) && compactItemFits(a)`. `routable` uses the exported `isNonSensitiveTool`, and `decideBatch` gets the same predicate through the `Approvals` constructor. `enqueue` and `compactItemFits` also require `kind === 'tool'`. Tests: `approval-rooms.test.ts` B7 and int B7. |
| B8 | MET | `BATCH_APPROVAL_ID` is anchored. `APPROVAL_ID` is unchanged. Anything that matches neither regex answers "Unknown action." with no DB call. Buttons come from `batchButtons` and `batchRows`: at most 5 rows, ids at most 47 chars and unique. Tests: the strict-parser vectors (16-digit id, uppercase, 11 and 13 hex, `:x`, trailing `\n`, prefix) and "8 items render 5 rows". |
| B9 | MET with residual G2AB-02 | Only the single winner of `seal()` publishes. A failed post dissolves the batch, posts solo cards and sends one alert (ids only). Boot runs `flushAll` from `app.start()`. All-expired goes to `closed` with no post. Tests: B9(a) (both room and #setting posts fail, because the fake throws on every `batchButtons` post), (b), (c). |
| B10 | MET | The timer is per batch, cleared on `stop()`. A batch of one is dissolved and posted with `toolApprovalPayload` (deep-equal test). Two tasks or two requesters never share a card (test). |
| B11 | MET (test weakness N2) | Per-item rows carry `taskId`, `tool` and `ok #<id>`. There is one summary row `approval.batch_<action>` with `batch:<id> digest:<12hex> n= decided=`, where the digest is regex-checked. The alert carries ids only. The logger serialises only `name`, `message` and `stack` of errors, never pg `detail`. Test: a planted marker is absent from the audit rows and from the log calls. |
| B12 | MET | Batch Ask makes no decision call and no card edit, writes one summary row, and replies with code-written text listing the ids (test). |
| B13 | MET | The down migration raises while a batched pending row exists (test). |
| B14 | MET (batching off in that suite) | The md5 of `tools/registry.ts` (`1ee2f73b...`) is identical to the Gate 1 md5. `tool-approval.int` and `governance/approvals.int` pass; their diffs are unrelated earlier work (the incident title, `limits.localUnlimited`). That suite runs with `approvalBatching: false` (deviation 1). |

## Findings

| ID | Severity | Location | Description | Remediation | Owner |
| :-- | :-- | :-- | :-- | :-- | :-- |
| G2AB-01 | Medium (FIXED) | `discord/commands/approval.ts` `batchOf()` | This was the open risk in the brief. If `markPosted` fails after a successful post, the batch stays `sealed` while a live card exists. `batchOf` then returned `none`, so a per-item click took `closeInPlace` and removed every button, Approve all included. That is GB-01 again: the other items lose their only card and expire, and expiry cancels the task. | Fixed: state `sealed` now returns `unknown`, so the card is left alone and the click gets the plain reply. Regression test added to `discord/commands/approval.test.ts`: "G2AB-01: a card of a batch left sealed ... is never closed". | security (done) |
| G2AB-02 | Medium | `governance/approval-batches.ts` `publish()` "await this.d.repo.markPosted(id, ...)"; `sealAndPublish()` | (a) The `markPosted` result is ignored, and a throw is only logged. Batch buttons on that card answer "stale" (`decideBatch` refuses `sealed`) until a restart reposts the card, and nobody is told. (b) A seal that throws in the timer is logged once and never retried. The batch then stays `open` with no card until another join from the same task and requester, or a restart, and the items can expire silently. Both fail closed, but the loss is silent. | Retry `markPosted` (for example 3 tries with backoff). On final failure, send a code-written #bot-log alert (ids only) that tells the admin to decide per item or restart. Add a periodic sweep, for example on the existing expiry tick: seal and publish `open` batches whose `opened_at + window` has passed, and `sealed` batches with `message_id IS NULL` older than about 1 minute, guarded by the in-process `publishing` set. Tests: a `markPosted` that throws gives one alert; a seal that throws once is published by the sweep. | backend |
| G2AB-03 | Low | `governance/approvals.ts` `decideBatch` "FROM approvals WHERE batch_id = $1 ORDER BY id FOR UPDATE"; `governance/tool-claims.ts` `claimTools` "UPDATE approvals SET executed_at = now() WHERE ... task_id = $1" | `decideBatch` locks every member, including rows already approved per item. `claimTools` takes no root lock and updates the task's approved rows in heap order, not id order. A per-item approval of the newest row releases the task, so an Approve all that overlaps the worker's claim can deadlock. Postgres then aborts one of the two transactions. Nothing is corrupted, but either the click fails ("That failed") or the claim fails and the run errors. | Lock only `status = 'pending'` members `FOR UPDATE` (claimTools never touches pending rows). Read the full member list for the digest with a plain SELECT under the batch lock: `input_sha256` is re-checked at claim time anyway. Or give `claimTools` an ordered CTE (`SELECT id ... ORDER BY id FOR UPDATE`). | backend |
| G2AB-04 | Low | `discord/commands/approval.ts` `refreshBatchCard()` | The batch is found from the customId (an approval id, or a batch id), but the edited message is `i.messageId`. A forged customId (a click is always client-supplied) on batch card Y that names an item of batch Z re-renders Z's content onto Y's message. Y's items then lose their card. Only an admin who passes the room guard and the role checks can do this, and decisions stay DB-guarded, so this is integrity of the display only. | In `refreshBatchCard`, refuse the refresh (plain reply) unless `batch.messageId === i.messageId`. Accepted cost: the old duplicate card after a crash repost is no longer refreshed, but its clicks are still answered correctly. | backend |

### Notes (no finding)

- **N1.** `batchFits` and `batchApprovalPayload` measure without the footer, and the port's redaction can lengthen the text. Both fail closed: `buildBatchCard` throws, the post fails, and the batch dissolves into solo cards plus an alert. A refresh that throws leaves the old card, and the decision is already stored. Acceptable.
- **N2.** The B11 test captures the fake logger's arguments, not the emitted pino line, so team rule 19 is only partly met. The batch code logs only `{ err }` objects with fixed messages, and the logger drops pg `detail`. Recommended: when the suite is next touched, capture through a real `createLogger` stream.
- **N3.** Lock order check:
  - join: batch -> new approval row, with no root lock;
  - seal: batch only;
  - decideBatch: root -> batch -> members, ascending;
  - decide: root -> approval;
  - expireOld: sorted roots -> pending rows.

  The only cross-path wait is decideBatch on the batch lock held by a join. The join then waits only on an approval row that `decide()` can hold, and `decide()` needs the root before it touches any row. So there is no cycle. The only exposure is G2AB-03, against `claimTools`.
- **N4.** The 23505 retry in `join` handles two joins that open the same (task, requester) batch at once. A second 23505 falls back to a solo card.
- **N5.** The WS7 room guard does not bind an approval id to its room. This is pre-existing and unchanged by batching.

## Rulings on the backend deviations

1. **Batching off in int `boot()`, on in production: ACCEPTED.** Production `createApp` without the override builds `ApprovalBatching`, and the batch suites opt in. Condition C2 below: run `tool-approval.int` once with `approvalBatching: { windowMs: 1 }` in a scratch copy, or add a batching-on variant, before release.
2. **Migration name `026_approval_batch`: ACCEPTED.**
3. **Task id in the title, requester in the body: ACCEPTED.** Both go through `escapeCardText`, and B6 needs only the count and the task in the title.
4. **Boot seal and flush from `app.start()`, not `attach()`: ACCEPTED, and better.** The clients are up, and the B9(b) test covers it.
5. **Audit format changed for all approval clicks (taskId, tool, `ok #<id>`): ACCEPTED.** All values are built by code, and no consumer matches `outcome === 'ok'` for approvals (the executor's `outcome === 'ok'` belongs to another table path).
6. **`itemsDigest` in `governance/canonical.ts`: ACCEPTED.** It sits next to `inputDigest`, and both the seal and `decideBatch` use the same function.
7. **Out-of-scope files touched: ACCEPTED.** The changes are minimal and typed. `batchButtons` is a separate field, so the single `buttons` path is unchanged. The single-embed branch is used only when `batchButtons` is set. `batchable` is optional, and `decideBatch` refuses when it is absent. The `types.ts` additions are optional deps.
8. **An expired, unswept row shows "expired" with no buttons: ACCEPTED.** Fail closed: `decide()` would refuse it anyway, and `expireOld` sweeps it later.

**Open risk (markPosted failure): RULED.** The worst part, closing the whole card, is fixed as G2AB-01. The silent stale state left over is G2AB-02 (Medium, backend).

## Conditions to release

- **C1.** The Gate 1 live probe in the test guild, run by the owner or devops, since the brief forbids real Discord calls here:
  - a 3-item card;
  - one per-item approve (the card stays, with a lower count);
  - Approve all;
  - a stale click on a duplicate card;
  - the B2 and B3 probe payloads posted for real, confirming 1 message, 1 embed and one line per value.
- **C2.** The B14 suite run once with batching on (deviation 1).
- **C3.** Fix G2AB-02 test-first. G2AB-03 and G2AB-04 are recommended and do not block. (Closed in the re-check: all three are fixed, and C2 is met.)

## Fixed in this audit

- `discord/commands/approval.ts` `batchOf()`: a `sealed` batch now returns `unknown`, so its card is never closed (G2AB-01).
- `discord/commands/approval.test.ts`: added the regression test for G2AB-01.
- I re-checked the changed file: tsc is clean, and the unit and int batch suites are green.
- Re-check: in `governance/approvals.ts` `decideBatch`, the pending-member `FOR UPDATE` now runs BEFORE the plain SELECT that feeds the digest (G2AB-03-H). The existing B5 and B6 int tests stay green.

## Re-check after the backend fixes (2026-11-08)

Backend reported that G2AB-02, G2AB-03, G2AB-04 and C2 are fixed. I checked each one in the code.

- **G2AB-02: FIXED.**
  - `governance/approval-batches.ts` `record()` retries `markPosted` 3 times with backoff. It then sends ONE alert, built by code: batch id, task id and approval ids only. No tool input, reason or card text goes into it. The test asserts that the alert does not contain `example.com`.
  - The batch then goes into the in-process `unrecorded` set, so the sweep never posts it a second time. A restart may repost it, which is the accepted duplicate.
  - `sweep()` runs on a 30 s unref'd interval that starts in `enqueue`/`flushAll` and is cleared in `stop()`.
    - It seals `listDue(windowMs)` (open batches whose `opened_at + window <= now()` by the DB clock) through the single-winner `seal()`.
    - It publishes `listStaleSealed(60 s)` (`state='sealed' AND message_id IS NULL`).
    - Both are guarded by the `publishing` set.
  - If the timer and the sweep race, only one wins `seal()`.
  - The alert tells admins to decide per item. That path is safe because G2AB-01 leaves the sealed card in place.
  - Tests: the `G2AB-02` describe block (failing 3 times: one alert, no duplicate; failing once: recorded, no alert; a seal that threw is retried by the sweep).
- **G2AB-03: FIXED, with one hardening by security.**
  - `decideBatch` now takes `FOR UPDATE` only on the pending members, in ascending order. `claimTools` touches only decided rows, so the two can no longer deadlock.
  - The digest is still recomputed in the transaction from ALL members and compared with the stored and clicked values. The kind, sensitive-tool and task re-checks are unchanged.
  - Backend's version read the members with a plain SELECT BEFORE the pending lock. That left a window between the two statements.
    - No app path writes `input_sha256` or `tool_input` (grep: none).
    - The only write of `batch_id` is the join. The join needs the batch to be `open` and holds its lock, and this batch is `posted`/`closed` and locked by `decideBatch`.
    - So the window was reachable only by direct DB tampering.
  - I still swapped the two statements (`G2AB-03-H`, one spot in `governance/approvals.ts`): lock the pending rows first, then run the plain SELECT. Its READ COMMITTED snapshot is then taken after the locks, so the rows that get decided are exactly the locked rows the digest was computed from. The lock order is unchanged: root -> batch -> pending members, ascending.
- **G2AB-04: FIXED.** `refreshBatchCard` returns false (plain reply) unless `batch.messageId === i.messageId`. Test: "a click on another message (forged custom id) edits nothing".
- **C2: MET.** `tests/integration/tool-approval.batching.int.test.ts` is `tool-approval.int` with `approvalBatching: { windowMs: 1 }`. The only other change is a wait for the window in `start()`; I checked this with diff. All tests pass.

Final runs on the md5-listed tree, after the hardening:
- `npx tsc --noEmit`: clean.
- Unit (vitest `unit`): `discord/commands/`, `discord/embeds/approval-batch.test.ts`, `discord/embeds.test.ts`, `discord/port.test.ts`, `agents/approval-card.test.ts`, `discord/approval-rooms.test.ts`. 19 files, 271 tests, all green.
- Integration (local test DB only): `approval-batch.int`, `approval-batch-app.int`, `approval-batch-owner-case.int`, `tool-approval.int`, `tool-approval.batching.int`, `governance/approvals.int`, `tests/integration/approvals.int`. 7 files, 146 tests, all green.
- I did not re-run backend's full-suite numbers (unit 3127, int 661).

Final status: **CONDITIONAL_APPROVE**. The only open condition is C1, the live Discord probe, which the coordinator will run after restart. All code findings are closed.

## Audited files (md5 at review end)

```
5df2364b42572ffc6bb5e3c148b04f0a db/migrations/026_approval_batch.up.sql
83e1bd806dbaf537a8489ec7313a4257 db/migrations/026_approval_batch.down.sql
bc55e80e659bdd047d3e0bfce5ea30c0 db/repos/approval-batches.ts
29f0e5284c71d2a404c1a5d12fc66b40 governance/approval-batches.ts
6c64ab3dbb04d13067eadf065aa93a07 governance/approvals.ts
ad72ee263425666df5558ef2f158a04a governance/canonical.ts
af3d2bc714c3918437f3eda568cd44cb governance/tool-claims.ts
596324976035bd011350f8674d479fcc discord/embeds/approval.ts
aebd243dc5cada9596b2c0fe5866ee15 discord/embeds/index.ts
e5ebde2cb91e496df44b3fed2543713e discord/commands/approval.ts
10368aa78340d7de74eb1cc94946c656 discord/commands/index.ts
ee5f336993686db03a94db15e937236a discord/commands/types.ts
428f6a2d4a437d6fae7c5c9b2cd006a8 discord/port.ts
d03ae103c12179d4fc01ac2b011ce0b6 discord/approval-rooms.ts
904f38acc742a2704d922b204207d368 agents/scheduler.ts
adcc2c930133bbd048a5c5710053c338 agents/payload.ts
0c0ff42992649b7e5844b8bc52892646 app.ts
1ee2f73bde0d151fac947395809fb661 tools/registry.ts
ad447a96a520c3b36b794b6dbc8d190d discord/commands/approval.test.ts
7df369b0efd844ecf412d126f722403c discord/embeds/approval-batch.test.ts
0dbe29976541d6851cce85922410a26e tests/integration/approval-batch.int.test.ts
f980aca6b7a93ce5941028276106b560 tests/integration/approval-batch-app.int.test.ts
27efc1ea0eacbffa3f9d5cc92a6b821d tests/integration/approval-batch-owner-case.int.test.ts
a420c594067a87211d45034bfb8bf5ff tests/integration/tool-approval.batching.int.test.ts
727068ab172f82aa8fc36c89cd24014a agents/approval-card.test.ts
38322968dd0dbe2f7113272190f63998 discord/approval-rooms.test.ts
```
