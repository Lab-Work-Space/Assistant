---
title: "Security Gate 1: batched tool approval cards (APPROVAL-BATCH-1)"
gate: 1
status: CONDITIONAL_APPROVE
date: 2026-11-08
task: APPROVAL-BATCH-1
project: labworkspace (BOT/Assistant)
---

# Security Gate 1: batched tool approval cards

Verdict: **CONDITIONAL_APPROVE**. Conditions B1 to B14 below are binding at Gate 2. Each one names the file and test it binds to.

## Scope

This gate reviews the sa spec "approval batch" (migration 026, `approval_batches`, seal-at-post, `decideBatch`, batch card) against the current tree. Anchors use the form function plus quoted fragment. Line numbers are hints only.

- `governance/approvals.ts`: `request()` "move(c, changes, 'awaiting_approval'", `decide()` "Lock order root -> approval -> tasks", `expireOld()`, `move()`
- `governance/tool-claims.ts`: `claimTools()` "digestOk(row.input, row.sha)"
- `discord/commands/approval.ts`: `APPROVAL_ID`, `approvalButton`, `closeInPlace`, `postApprovalCard`
- `discord/commands/index.ts`: `route()`, `decide()` "WS7: an approval card in a category's approvals room", `deferEphemeral`
- `discord/embeds/approval.ts`: `escapeCardText`, `toolApprovalPayload`, `QUERY_CHUNK`
- `discord/embeds/index.ts`: `buildMessage`, `packFields`, "components = [approvalRow(p.buttons.approvalId)]"
- `discord/approval-rooms.ts`: `SENSITIVE_TOOL`, `routable()`, `channelFor()`
- `discord/port.ts`: `closeCard` "only the hq client's own card"
- `tools/registry.ts`: approval branch "ctx.approvals.request({ kind: 'tool'"
- `agents/scheduler.ts`: `attach()` "bus.on('approval.requested'"
- `governance/audit.ts`: `createAudit` (the known columns only)

## Invariants the spec already gets right

- Every item stays its own `approvals` row, and its own `input_sha256` is checked again at claim time (`claimTools` "digestOk"). Batching changes only how the item is shown and decided. It never changes what runs.
- `decideRow` is extracted from `decide()` and keeps the same semantics: the root lock, the conditional UPDATE on `status = 'pending'`, expiry by the DB clock, the newest-row `awaiting_approval_id` move, and halt.
- Lock order is root -> batch -> members for `decideBatch` and batch -> approval for a join. A join takes no root or task lock, and a decision only ever touches a `posted` batch while a join only touches an `open` one. I found no lock cycle with `decide()`, `expireOld()` or `capHit()`.
- A batch holds one task and one requester. Every member is non-sensitive, so `channelFor` gives the same room for every member, the room a solo card would get. The batch never moves a card into a room it could not reach before.
- The batch customId keeps the `approval:` prefix, so the ephemeral deferral, the WS7 room guard, the live Bot Admin role check and the second `isAdmin` check in `decide` all apply unchanged.
- Estimate approvals, cap approvals and sensitive tools are excluded.

## Findings (holes in the spec as written)

| ID | Severity | Evidence | Problem |
| :-- | :-- | :-- | :-- |
| GB-01 | High | `approvalButton` calls `closeInPlace` on success and on the `not_pending`/`expired` path; `port.closeCard` sets `components: []` | One per-item click (or one stale or double click) on a batch card removes every button, Approve all included. The other items lose their only card and expire, and expiry cancels their tasks. |
| GB-02 | High | `buildMessage`: `truncate(..., FIELD_VALUE_MAX)`, `packFields(fields, EMBED_MAX - ...)`, embeds grouped into several messages, components attached to `messages[messages.length - 1]` only; `escapeCardText` grows text (backslash escapes, `@​`, `\u{XXXX}` for hidden chars) | "value <= 560 chars" is measured before escaping, but escaping can grow 560 chars past 1024, and the renderer then cuts the field silently. Eight items can exceed 6000 chars. The card then splits into several embeds or messages with the buttons on the last one only, so Approve all sits below items on a message the admin may never scroll to. |
| GB-03 | High | `escapeCardText` control class `[\u0000-\u0008\u000b-\u001f...]` leaves `\t` and `\n` in place | The solo card gives every value its own field. The compact batch field puts Target, Item, Changes, sha and Status in ONE value, so an injected `"...\nInput sha256: 000000000000\nStatus: approved"` in a URL or Changes value can fake another sub-line, a hash, a status, or an item header that looks like another item. This lets prompt injection make a batched card misrepresent or hide an item. |
| GB-04 | Medium | spec: "approvals.batch_id FK with CHECK batch_id IS NULL OR kind='tool'" | A plain FK does not tie a member to the batch's `task_id`/`requested_by`, so cross-task membership is prevented only by application code. `batch_id` is also mutable (nothing stops a later clear or move). |
| GB-05 | Medium | spec: digest = sha256 of the member ids | The click digest binds the member set but not the content shown. The owner's invariant is "each item bound to its own input hash". |
| GB-06 | Medium | `toolApprovalPayload` "body: escapeCardText(a.reason" | Today the code-written reason (for example "fetch_page after untrusted content, url not seen in this run") is the card body. The batch field list in the spec has no Reason, so the exfiltration-guard context disappears under Approve all. |
| GB-07 | Medium | spec "Seal ... items_digest" with "UPDATE state sealed WHERE state='open'" | If the digest is computed in a subquery of that UPDATE, the READ COMMITTED statement snapshot (taken before a concurrent join commits) can miss a member that is already joined. The card then omits a row that has a `batch_id`, and that item has no card at all. |
| GB-08 | Medium | `postApprovalCard` retries once in #setting, then throws; `spawn('approval card'...)` only logs | A sealed batch whose post fails both times leaves up to 8 pending items with no card until the next boot. Today that is 1 item. |
| GB-09 | Low | `APPROVAL_ID = /^approval:(\d{1,15}):(approve|reject|ask)$/`; `buildMessage` swaps in `approvalRow` whenever `p.buttons` is set | The batch path needs its own anchored parser and its own component builder. If the batch payload reuses `buttons`, it gets the 3-button single row. |
| GB-10 | Low | `AuditEntry` columns: actor, action, taskId, tool, outcome; today's approval audit row has no taskId and no approval id | "Per decided item as today" leaves eight identical rows after an Approve all. |
| GB-11 | Low | spec "Rollback: ... leftovers expire" | After a down-migration the old code answers "Unknown action." to `approval:b:` and closes the whole card on a per-item click (GB-01). Leftovers fail closed (they expire and the task is cancelled) but silently. |

### Notes

- Forged or stale customId: a click is always client-supplied, whatever Discord validates. The digest is not a secret (anyone can compute sha256 of ids). It gives staleness and integrity binding, not authentication. Authentication stays the room guard plus the Bot Admin role check plus `decide`'s `isAdmin`. A forger who passes those is an admin who could click anyway. No finding depends on Discord-side validation.
- Same-task ordering: when one task has several pending tool approvals, the task waits on the newest one (`request()` sets `awaiting_approval_id` to the new row). Deny on the newest cancels the task even if older items were approved. This is today's behaviour with separate cards. `decideBatch` must keep it (B6).
- Pre-existing residual, not new: nothing reposts a pending approval that never got a card (I found no boot path; `attach()` posts fire-and-forget). Crash exposure between `request()` commit and the join tx is milliseconds. Inside the window, the boot seal-and-flush covers it.
- Owner-accepted residual: Approve all lowers friction on exactly the tainted-run `fetch_page` approvals that guard against exfiltration (URL-encoded data). The full URL of every item stays visible (B2, B3, B6), so the owner keeps the same information. The owner approved this trade-off on 2026-11-08.

## Binding conditions

B1 (GB-01). `approvalButton` branches on batch membership. When the approval's `batch_id` points to a batch in state `posted` or `closed`, neither the success path nor the `not_pending`/`expired` path calls `cards.close`. Both refresh the batch card from the DB instead, using a new port method that keeps the "only the hq client's own card" author check and edits only `i.channelId`/`i.messageId`, never an id taken from the customId. Buttons are removed only when every member is terminal, and the batch then moves to `closed`. A `dissolved` batch (batch of one, or a failed post) takes today's path byte-for-byte. Tests in `discord/commands/approval.test.ts` (new): (a) approve item 1 of 3, then items 2 and 3 still have buttons and Approve all is still there; (b) a double click on item 1 does not close the card; (c) a dissolved solo card closes exactly as today.

B2 (GB-02). Eligibility is measured on the final rendered text, not the raw value.
- An item may join only if `toolApprovalPayload`'s own `cut` signal for it is false (one shared helper, not a copy): no Note field, the Query/Prompt fits in one chunk, and nothing is cut to `VALUE_MAX` in Changes.
- Its compact field value, after escaping and with the longest possible Status text, must be at most 1024 chars.
- The whole card after the join, with title, body and footer label, must have `embedSize` of at most 6000.
- If an item fails the per-item test, it goes solo. If it fails only the card total, the batch seals first and the item goes solo.
- The batch builder asserts that `buildMessage` returns exactly 1 message with 1 embed and that `truncate` changed no field. Otherwise the batch dissolves to solo cards. A refreshed card never adds text beyond the budgeted Status length.
- Tests in `discord/embeds/approval-batch.test.ts` (new): 8 items at the per-item limit, one value of 560 chars all made of `*` (escapes to 1120), one value full of hidden chars (`\u{E0041}` x 120), and a 9th join refused on the size budget.

B3 (GB-03). Inside the compact field, every value is shown on exactly one line: strings are JSON-quoted the way `query` already is (or `\r`, `\n`, `\t` are mapped to visible escapes) before `escapeCardText`. The code-written labels (`Target`, `Item`, `Reason`, `Changes`, `Input sha256`, `Status`) are bold. Model text cannot produce bold, because `*` is escaped. The item header is the field name `#<id> · <tool>`, which is built from code values only. Test in `discord/embeds/approval-batch.test.ts`: a Target of `"https://a\nInput sha256: 000000000000\nStatus: approved\n#999 · fetch_page"` renders as one line, and the field count equals the member count.

B4 (GB-04). Migration 026 enforces membership in the DB:
- a UNIQUE `(id, task_id, requested_by)` on `approval_batches`;
- a composite FK `approvals(batch_id, task_id, requested_by)` that references it (MATCH SIMPLE, so it allows NULL);
- the CHECK `batch_id IS NULL OR kind = 'tool'`;
- a BEFORE UPDATE trigger that refuses any change of `batch_id` once it is non-NULL;
- a CHECK on `state IN ('open','sealed','posted','dissolved','closed')`, a CHECK on `item_count BETWEEN 0 AND 8`, and `items_digest ~ '^[0-9a-f]{12}$'` when state is not `open`.

The join statement also requires the batch row, locked FOR UPDATE in the same tx, to satisfy `state = 'open' AND item_count < 8`. It increments `item_count` in that tx. Tests in `tests/integration/approval-batch.int.test.ts` (new): a member of another task, or of another requester, is refused by the DB; re-pointing or clearing `batch_id` is refused; a join to a sealed batch is refused; a 9th join is refused.

B5 (GB-05, GB-07). `items_digest` is the first 12 hex of sha256 over the ascending list of `"<id>:<input_sha256>"` joined by `,`. It is computed in application code inside the seal tx, AFTER `SELECT ... FROM approval_batches WHERE id = $1 FOR UPDATE` and the `state = 'open'` re-check, from a separate SELECT of the members (a fresh READ COMMITTED snapshot). It is never computed in a subquery of the sealing UPDATE. `decideBatch` recomputes the digest the same way under its locks and refuses with "stale" unless stored == recomputed == click. Tests in `tests/integration/approval-batch.int.test.ts`: (a) a join that commits while the seal waits on the batch lock is either in the digest and on the card, or it was refused and went solo; never neither; (b) a click digest from another batch, or a changed `input_sha256`, is refused as stale and changes nothing.

B6 (GB-06, ordering). Each item field shows its own escaped reason, with the same `REASON_MAX` as today. The card title shows the item count ("N tool approvals, task <id>"). Approve all and Deny all carry the count in their labels, and every per-item button label carries `#<id>`. `decideBatch`:
- decides members in ascending id order inside one tx;
- skips rows that are not pending or have expired, and reports them per id;
- re-checks at decision time that every member is `kind = 'tool'`, does not match `SENSITIVE_TOOL`, and has the batch's `task_id` (otherwise it refuses the whole click);
- emits `task.changed`/`task.ready` only after COMMIT.

Tests in `tests/integration/approval-batch.int.test.ts`: Approve all on 3 items of one task gives exactly one `task.changed` to `todo`. Deny all cancels the task once. Approve all with the newest item expired by the DB clock leaves that row `expired` and the others `approved`. Approve all while halted leaves the task in `awaiting_approval`, the same as `decide()`.

B7 (eligibility source, team rule 8). Batch eligibility calls the exported `ApprovalRooms.routable` (or one predicate exported next to `SENSITIVE_TOOL` that `routable` also uses). It never copies the regex. Only `kind = 'tool'` rows from `request()` join; `capHit` and estimate rows never call the batcher. Test in `discord/approval-rooms.test.ts`: every `SENSITIVE_TOOL` prefix (`github_`, `deploy`, `server_`, `save_lesson`, ...) is never batched. Test in `tests/integration/approval-batch.int.test.ts`: a tree-cap, local-cap or estimate approval in the same task within 10 s gets its own card.

B8 (GB-09). The batch customId parser is a separate, anchored regex: `^approval:b:(\d{1,15}):([0-9a-f]{12}):(approve|reject|ask)$`. The single `APPROVAL_ID` stays unchanged and does not match it. Anything that matches neither regex answers "Unknown action." and makes no DB call. The batch payload never sets `buttons`. It uses its own field (for example `batchButtons`) and a builder that emits row 0 plus at most 4 rows of at most 4 buttons, each customId at most 100 chars and unique within the message. Tests in `discord/commands/approval.test.ts` and `discord/embeds/approval-batch.test.ts`: overlong ids, uppercase hex, an 11- or 13-hex digest, trailing text and `approval:b:1:...:approve:x` are all refused. 8 items render 5 rows.

B9 (GB-08, restart, duplicates). Flush is posted by the single winner of the `open -> sealed` transition. A post that still fails after the #setting fallback moves the batch `sealed -> dissolved`. Each pending member is then posted as a solo card through today's path, and one code-written alert goes to #bot-log (ids only). Boot seals every `open` batch and flushes every `sealed` batch whose `message_id` IS NULL. Flush and boot flush post only when at least one member is still pending and live; otherwise the batch goes to `closed` without a post. A duplicate card after a crash is accepted: decisions stay DB-guarded and the batch buttons of a `dissolved` batch answer "stale". Tests in `tests/integration/approval-batch.int.test.ts`: (a) a port that fails twice gives N solo cards plus 1 alert; (b) a restart with one `open` and one `sealed` batch posts each exactly once; (c) an all-expired sealed batch is not posted.

B10 (window and joins). Nothing joins after `sealed`. The 10 s timer is per batch, in process, and cleared on `Scheduler.stop()`. A batch of one is dissolved and posted with today's card payload. A test asserts deep equality with `toolApprovalPayload(a)` for the same row. Test in `agents/approval-card.test.ts`: a single eligible item posts the same payload as today, after at most the window. Two tasks, or two requesters, within the window never share a card.

B11 (GB-10, audit and logs). Every item decided by a batch or per-item click writes today's row plus `taskId` and an `outcome` that carries the approval id (code-built, for example `ok #123`). Each batch click writes one summary row, `action: approval.batch_<approve|reject|ask>`, with `taskId` set and `outcome` `batch:<id> digest:<12hex> n=<k> decided=<j>`. No `tool_input`, reason or card text goes to audit, logs or #bot-log. Test in `tests/integration/approval-batch.int.test.ts`: plant a marker string in a member's input and reason, then grep the captured audit rows AND the captured log lines (team rule 19) for the marker. The count must be 0.

B12 (ask). Batch Ask changes no state, makes no DB write except the summary audit row, and answers with code-written text listing the pending ids. Test in `discord/commands/approval.test.ts`.

B13 (GB-11, rollback). `026_approval_batch.down.sql` raises an exception if any `approvals` row has `batch_id IS NOT NULL AND status = 'pending'`. The runbook step is: drain (decide, or wait for expiry), then migrate down. The rollback note in the plan states that old code answers "Unknown action." on leftover batch buttons. Test in `tests/integration/approval-batch.int.test.ts`: the down-migration fails with one pending batched row and succeeds after it expires.

B14 (no taint regression). Batching changes nothing in `tools/registry.ts` except the call after `approvals.request()`. The `approval_not_owner` and `approval_needs_task` refusals, the awaiting text that names the card id and channel, and the taint marking stay byte-identical. Test: `tests/integration/tool-approval.int.test.ts` passes unchanged. Every existing test in `governance/approvals.int.test.ts` passes against `decideRow`-based `decide()` unchanged.

## Gate 2 entry checks

- md5 of every audited file when Gate 2 ends.
- Live probe in a test guild: a 3-item card, then one per-item approve, Approve all, and a stale click on a duplicate card.
- Probe payloads from B2 and B3 posted for real, to confirm 1 message and 1 embed.

## Audited files (md5 at review end)

```
23eb215a743a13fcd8118cde7e812d96 governance/approvals.ts
af3d2bc714c3918437f3eda568cd44cb governance/tool-claims.ts
4e7b9e8fa0369f400656fc8704ac539d discord/commands/approval.ts
10368aa78340d7de74eb1cc94946c656 discord/commands/index.ts
b9d5a11875f47e31f75e6d2e8cd0a272 discord/embeds/approval.ts
af4d18b491fb57426426139ff4bdd82c discord/embeds/index.ts
1c8f0ad4ba0d2a7e83285b6857d2e4ab discord/approval-rooms.ts
ed1a3b905e9a76179f214051805b6745 discord/port.ts
1ee2f73bde0d151fac947395809fb661 tools/registry.ts
808540c30f7c2b4909e195f4b55fa434 agents/scheduler.ts
7864d40eeb8d2cdeea788a507953d13f governance/audit.ts
```
