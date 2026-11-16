# APPROVAL-BATCH-1 — batched tool approval cards (spec)

Status: spec approved by owner request 2026-11-08; Security Gate 1 CONDITIONAL_APPROVE with binding conditions B1–B14 in
`docs/security/2026-11-08-gate1-approval-batch.md`. Where this spec and a Gate 1 condition differ, the condition wins
(notably: digest over `id:input_sha256` (B5), composite FK + immutable batch_id (B4), one-line quoted values (B3),
rendered-size eligibility (B2), per-item reason on the card (B6), failed post dissolves to solo cards (B9)).

## Current flow (file:line)
1. tools/registry.ts:129 → Approvals.request(kind 'tool'): canonical input + sha256 stored (governance/approvals.ts:114-118); task → awaiting_approval with awaiting_approval_id = NEWEST row (:122); emits approval.requested (:127).
2. Model gets awaitingText("card #<approvalId>") (registry.ts:13,134,142).
3. agents/scheduler.ts:176 postApprovalCard(port, a, secrets, channelFor(a)) (discord/commands/approval.ts:56-64); room post failure falls back once to #setting.
4. Routing discord/approval-rooms.ts:46-70: category room only if routable() (non-SENSITIVE_TOOL tool, or estimate) and the room passes the live check; else #setting.
5. Card: toolApprovalPayload (discord/embeds/approval.ts:69-125), D7 escaping, full query/prompt (G2-05/RF31), truncation Note (:113), sha256 prefix 12 (:112). Buttons `approval:<id>:approve|reject|ask`.
6. Click: APPROVAL_ID regex (commands/approval.ts:7) → decide(): locks root → approval → tasks; one conditional UPDATE requiring pending and not expired (approvals.ts:256-302). Only the row equal to task.awaiting_approval_id moves the task (WAITS_ON :44,:290,:294). Halted: not released.
7. One audit row (approval.ts:28) then closeInPlace (:40-49; port.ts:740-750 checks hq author).
8. claimTools claims each decided row once and re-checks the digest (governance/tool-claims.ts:35-53). expireOld uses DB clock (approvals.ts:305-330).

## Decisions
- D1 Eligibility (ALL): kind='tool'; tool does not match SENSITIVE_TOOL (reuse the export, never copy — B7); the compact item renders the full input on the RENDERED text (B2). Otherwise today's path, posted immediately. Estimate and cap approvals never batch.
- D2 Key: (task_id, requested_by). All members resolve to one channel. No channel I/O inside transactions.
- D3 Seal at post: first eligible item opens a batch and starts an in-process timer BATCH_WINDOW_MS = 10_000 (exported from governance/approval-batches.ts). Joiners within the window. Sealed at window end or at BATCH_MAX_ITEMS = 8, then posted. Nothing joins after a card exists. Timers cleared on scheduler.stop().
- D4 Batch of one: detach (batch_id cleared only via the allowed path; if B4 immutability forbids clearing, mark batch 'dissolved' and render today's card for that row) and post with today's postApprovalCard — payload deep-equals today's (B10).
- D5 Approve all / Deny all in ONE transaction (Approvals.decideBatch). Extract decide()'s body into private decideRow(c, id, status, userId, hours, halted, changes) used by both. Newest-row-moves-task preserved. Ascending order; emit changes once after COMMIT (one task.changed per task).
- D6 Render batchApprovalPayload (embeds/approval.ts): title `Approvals #<first>–#<last> needed (<n> calls)`; fixed body "Each call is approved separately; 'Approve all' approves exactly the calls listed on this card."; one field per item, name `#<id> · <tool>`; value lines (each value ONE line, JSON-quoted, labels bold — B3): Reason, Target, Item, Query/Prompt, Changes, Input sha256 (12 hex), Status. Shared fields Task, Requested by. Must be 1 message, 1 embed, field ≤ 1024, total ≤ 6000, nothing truncated (assert in builder). Components: row0 Approve all (Success) / Deny all (Danger) / Ask (Secondary); rows 1-4 two items each `Approve #id` / `Deny #id`. Decided/expired items: no buttons. No pending: all components removed, card closed. Never use the generic `buttons` field (B8).
- D7 Per-item customId unchanged `approval:<id>:approve|reject`.

## State machine (approval_batches.state)
open → open (join: count < 8, window open by DB clock) → sealed (timer / count 8 / boot sweep) → dissolved (1 pending member, posted solo; also on failed post per B9) | closed (0 pending) | posted (channel_id, message_id stored) → closed (no pending after decision/refresh).

Join tx (ApprovalBatches.add): lock batch row FOR UPDATE then approval row; never root/task locks. Expired window or full → seal (flush after commit) and INSERT new; unique violation → retry once → solo. `UPDATE approvals SET batch_id=$b WHERE id=$a AND batch_id IS NULL AND status='pending' AND kind='tool'` 0 rows → rollback, solo. Increment item_count; at 8 seal.

Flush(batchId): tx: lock batch FOR UPDATE, re-check state='open', read members FOR UPDATE, compute digest in app code (B5), `UPDATE SET state='sealed', sealed_at=now(), items_digest=$d WHERE id=$1 AND state='open'`; winner only posts. Apply D4. Post via hq head to channelFor(first member) with today's #setting fallback; postBatchCard returns {channelId, messageId} actually used. `UPDATE SET state='posted', channel_id, message_id, posted_at WHERE state='sealed'`. Both posts fail → B9 (dissolve, solo cards, one alert).

## Migration 026_approval_batches
Table approval_batches(id bigserial PK, task_id text NOT NULL REFERENCES tasks(id), requested_by text NOT NULL, state text CHECK in (open,sealed,posted,dissolved,closed) default open, item_count int CHECK 0..8, items_digest text CHECK null or ^[0-9a-f]{12}$, channel_id/message_id CHECK null or ^\d{17,20}$, opened_at default now(), sealed_at, posted_at, CHECK (state IN ('open','dissolved') OR items_digest IS NOT NULL)). Partial unique index (task_id, requested_by) WHERE state='open'. approvals.batch_id bigint with CHECK batch_id IS NULL OR kind='tool'; index on batch_id where not null. Plus B4: composite FK (batch_id, task_id, requested_by) → approval_batches(id, task_id, requested_by) (add a unique on those three) and an immutability trigger on approvals.batch_id once set. Down: drop in reverse; refuses while batched rows are pending (B13). Add 026 to db/migrate.int.test.ts lists and approval_batches to APP_TABLES. COLS (approvals.ts:25) gains `batch_id AS "batchId"`; Approval type gains `batchId?: number | null`.

## customId (≤ 100 chars)
- per item: `approval:<id>:approve|reject|ask`, `^approval:(\d{1,15}):(approve|reject|ask)$`
- batch: `approval:b:<batchId>:<digest12>:approve|reject|ask`, `^approval:b:(\d{1,15}):([0-9a-f]{12}):(approve|reject|ask)$` (max 47). One shared builder/parser (B8). Keep the `approval:` prefix so the router (commands/index.ts:72), ephemeral deferral (:88) and room/admin guard (:95-96) apply unchanged. approvalButton tries batch regex first.

## Click handling
- Batch approve/reject: decideBatch(batchId, digest, decision, user). not admin → not_admin. Tx: lock root task FOR UPDATE (via any member); lock batch FOR UPDATE, state must be 'posted', stored digest == recomputed digest == click digest else stale/not_found; members ORDER BY id FOR UPDATE; re-check kind/SENSITIVE/task per member (B6); decideRow each pending live member, skip others. Returns {decided, skipped:[{id, why:'not_pending'|'expired'}]}.
- Batch ask: no state change (B12).
- Per-item click: decide() unchanged; if the row has a batchId (and batch is posted) → refreshBatchCard instead of closeInPlace (B1). refreshBatchCard re-renders from DB via new port method updateCard(channelId, messageId, payload) reusing the hq-author check (port.ts:745); 10008 = gone. No pending left → close card, state 'closed'. Refresh failure: log, ephemeral reply falls back to "Decided by …".

## Race / expiry / restart
Partial unique + FOR UPDATE → one batch. Per-item vs Approve all serialize on root lock; second skips. Double Approve all → 0 decided, "already decided", refresh. Stale/forged digest → refused, refresh. Expiry per row unchanged. Halt as decide(). Boot (Scheduler.attach before listeners): seal all open (digest per B5), flush sealed with message_id NULL. Duplicate post after crash accepted.

## Audit
Per decided item as today plus taskId, tool and "#id" (B11): `{actor:'user:<id>', action:'approval.approve'|'approval.reject', outcome:'ok', taskId, tool}`. One summary row per batch click: action approval.batch_approve|batch_reject|batch_ask, outcome ok:<n>|stale|not_pending. No tool input in audit or logs.

## Replies (ephemeral)
not_admin "Only Bot Admins can do this."; not_found "Unknown action."; stale "This card changed; review it again." + refresh; ok `Approved n of m (k already decided/expired).` + refresh; 0 decided "These approvals were already decided." + refresh/close; ask "Batch stays pending; ask the requester for details, then decide."

## Tests
See Gate 1 B1–B14 (each names its test file) plus: join within window; new batch after window/at 8/different task/different requester; sensitive/estimate/cap never batched; batch of one == legacy card; decideBatch approves exactly frozen members, forced late member → stale; task.ready once after all decided; claimTools sees all rows; newest-row semantics; concurrent decideBatch vs decide; expired skipped; halted; boot seal+flush; down-migration round trip; tool-approval int: two fetch_page calls → one card, Approve all → both run once with digest checked.
