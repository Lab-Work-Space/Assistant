---
title: "Security Gate 1: task-tree approval grant (TREEGRANT-1)"
gate: 1
status: CONDITIONAL_APPROVE
date: 2026-11-09
task: TREEGRANT-1
project: labworkspace (BOT/Assistant)
spec: docs/superpowers/specs/2026-11-09-tree-grant-design.md
---

# Security Gate 1: "Approve the whole task" task-tree grant

Verdict: **CONDITIONAL_APPROVE**.

The design deliberately weakens R3/P2 ("delegated and tainted writes always ask"), and the owner asked for that. The weakening is bounded in four ways:
- a code allow-list of nine tool names;
- a strict `own === false` rule, so a tool's own always-ask still wins;
- a call cap, an expiry and an admin-only click;
- revoke, halt and root-end handling.

It is acceptable only with conditions TG-C1 to TG-C22 below. Each condition binds Gate 2 and names the file and test it binds to. The owner must also accept residuals R1 to R9 in writing. No finding needs a REJECT: every gap can be closed by a condition.

## Scope

Anchors are function names plus quoted fragments. Line numbers are hints only.

- `tools/registry.ts` `exec()`: the W-C2 strip "approved && ctx.webGrants", the halt check "approved && this.opts.halt.isHalted()", the allowlist, zod, `precheck` and the pin merge. Also `central = tool.kind ? approvalFor(...)`, the short-circuit "approved ? false : central || tool.requiresApproval(value, ctx)", I1 "approval_not_owner", "ensureConversationTask", and the run and audit steps.
- `tools/policy-approval.ts`: `approvalFor`, `BOT_TALK_TOOLS`, `NO_APPROVAL_TOOLS`.
- `tools/types.ts`: `ToolContext.webGrants`, `RunState`, `sameActor`, `ToolResult.notRun`.
- Every registered tool's `kind` and `requiresApproval`:
  - `tools/plugins/{workspace,pin,forum,docs,music,web,watch,media,schedule,reminders,lessons,ocr,clickup,jira,github}/**`
  - `tools/builtin/*.ts`
  - `admin/tools.ts`
- `tools/builtin/forwardTo.ts` and `tools/builtin/createTask.ts`: `delegate`, and `createChild` "needsApproval(input.estCostUsd)".
- `tools/plugins/docs/index.ts` and `kinds.ts`: `requiresApproval` "isDraftKind", `KIND_INFO`.
- `governance/approvals.ts`: `decide`, `decideRow`, `decideGrant`, `decideBatch`, `makeGrant`, `haltedAfterCommit`, `grantable`.
- `db/repos/web-grants.ts`: `consume`, `revokeAll`, `revokeOwed`, `revokeBeforeHaltedRow`, `unrevokedOfMessage`.
- `db/migrations/027_web_grants.up.sql`: the `revoke_reason` CHECK.
- `discord/commands/approval.ts`: `approvalButton` parse order, `revokeButton` "g.cardMessageId !== i.messageId", `refreshBatchCard` "unrevokedOfMessage(i.messageId)", `closeInPlace`.
- `discord/commands/index.ts`: the WS7 room guard "adminRoleId".
- `discord/embeds/approval.ts`: `approvalRow`, `batchRows`, `REVOKE_ID`, `BATCH_APPROVAL_ID`, `soloGrantEligible`.
- `discord/approval-rooms.ts`: `SENSITIVE_TOOL`, `isNonSensitiveTool`.
- `agents/loop.ts`: `toolContextBase` "...(deps.webGrants ? { webGrants", `approvedToolContext`, `adminRun ? deps.adminTools! : deps.tools`, the tool loop "registry.run(u.name".
- `agents/conversation.ts`: `isConversationTask`, `open` ("At most one open conversation per (head, person, thread or channel)").
- `agents/scheduler.ts`: `reopen` (review to doing only).
- `app.ts`: the `WebGrantRepo` wiring and halt hooks, `adminRegistry`, and `packWorkspaceDir(workspaceRoot, dir)` with the same `workspaceRoot` given to `registerGroups`.

## Tool classification check (every registered name)

I checked every name the main registry can hold against the spec's §3.2. The allow-list rule (`TREE_GRANT_TOOLS` plus `kind === 'write'` plus `own === false`) is fail-closed. A tool missing from §3.2 is therefore always-ask, never covered.

| Tool | kind | own requiresApproval | Under the spec |
| :--- | :--- | :--- | :--- |
| write_file | write | `() => false` | COVERED. See F-2: it feeds `site_publish_static` |
| pin_message | write | `() => false` | COVERED |
| forum_post | write | `() => false` | COVERED |
| forward_to | write | `() => false` | COVERED. See F-3 |
| doc_create | write | truthy for `isDraftKind(kind)` | COVERED for non-DRAFT kinds only. Correct, see "right" |
| music_play / music_skip / music_stop / music_volume | write | `() => false`; precheck limits origin to chat, slash or voice | COVERED |
| diagram_create, warroom_say | write | false | never ask today (NO_APPROVAL / BOT_TALK); n/a |
| schedule_add, schedule_remove, add_reminder, cancel_reminder, delete_lesson, save_lesson, sheets_append_receipt, watch_remove | write | false | not on the list: always ask |
| watch_add | write | truthy when tainted | not on the list: always ask (tainted or not) |
| image_generate, video_generate | write | always truthy | always ask |
| clickup_* writes (list mode), jira_* writes | write | false | not on the list: always ask |
| clickup_* writes (workspace mode) | write | always truthy | always ask. Same names as list mode; neither is on the list |
| clickup_delete_task, jira_delete_issue, github_create_branch, github_create_or_update_file, github_create_pull_request | destructive | false | always ask (`kind !== 'write'`) |
| fetch_page, web_search | read | truthy when tainted | never covered (`kind === 'read'`). The web grant stays separate |
| meeting_start | none | truthy when tainted | never covered (no kind) |
| respond, create_task, update_task, ask_requester, answer_subtask, knowledge_propose, prompt_propose, skill_propose, kb_search | none | false | never ask; n/a |
| all reads (list_*, read_file, *_list, *_get_*, ocr_image, read_image, extract_receipt, forum_read, music_queue, ...) | read | false | n/a |
| config_*, admin_op_propose, perm_propose, server_propose, deploy_*, site_publish_static, code_*, discord_read | adminRegistry only | own cards | unreachable if TG-C6 holds |

Spec errata. These are Info items and are fixed by TG-C22:
- §3.2 lists `knowledge_*`, `prompt_*` and `skill_*` as "always ask (sensitive)". The registered tools `knowledge_propose`, `prompt_propose` and `skill_propose` have no kind and never ask; they only file proposals.
- §3.2 does not list untainted `watch_add`, `music_queue` or `schedule_remove` (it calls the last one "deletion"). None of these changes coverage.

## What the spec already gets right

- **S2 / KEY RULE.** The grant waives only the central `approvalFor` result, and only when `own === false` (strict). Every tool with its own always-ask keeps its card:
  - `doc_create` DRAFT kinds (`requiresApproval` returns a reason from `isDraftKind(input.kind)`, which is input-only and deterministic);
  - image and video;
  - workspace-mode ClickUp;
  - tainted `watch_add`, `web_search` and `meeting_start`.
- **The allow-list holds up.** A name list combined with `kind === 'write'` fails closed for new tools and for destructive tools. It can never cover a `read` tool, so no `fetch_page` card ever qualifies. That makes the web-grant and task-grant buttons exclusive by construction.
- **Consume binding.** The consume needs all of:
  - `ctx.task` (code-set from the task row);
  - `sameActor(ctx.task.owner, ctx.actor)`, so a non-owner falls through to the existing I1 refusal;
  - the port;
  - `rootId` from the task row, never from input.
  It never calls `ensureConversationTask`.
- **One conditional UPDATE for the consume.** It joins `tasks` to check the root status, and the `used <= max_calls` CHECK backs it up. Under READ COMMITTED the WHERE clause is re-evaluated on the new row version, so concurrent consumes cannot overshoot, and a concurrent supersede or revoke wins. The same reasoning applied in WEBGRANT-1 W5.
- **Decisions use DB rows only.** `decideTaskGrant` locks the root FOR UPDATE, then the approval FOR UPDATE, the same order as `decide`, `decideGrant` and `decideBatch`, so it cannot deadlock with them. It re-checks halt both before and inside the transaction and revokes after commit. It reads the stored input with an sha check. customId content is never trusted (S7).
- **Supersede runs under the root lock, with a unique partial index as a second line.** Concurrent grant clicks on one tree serialize on the root lock.
- **Root end.** A root at done or cancelled stays ended: `reopen()` moves only review to doing. The consume SQL checks status itself, so the `task.changed` listener only affects the card and is not a security dependency.
- **The usage line is code-built** from registered names and integers.
- **Lounge conversations are per person.** A grant on a lounge conversation root never covers a different person: `conversation.open` keys one open conversation per (head, person, place).

## Findings

| ID | Severity | Where | Finding |
| :--- | :--- | :--- | :--- |
| F-1 | Medium (spec design gap, closed by TG-C3) | spec §3.3 step 2 "own recomputed from stored input"; `governance/approvals.ts` has no registry | "Recompute own" at render or decision time would need `tool.requiresApproval(storedInput, ctx)`, and no ToolContext exists outside a run. A synthesized ctx can drift from the run-time answer, and a ctx-dependent `own` (for example `ctx.tainted()`) would then read wrongly. The button, `decideTaskGrant` and `decideBatch` must share ONE pure stored-input predicate, as `soloGrantEligible` and `grantable` do for WEBGRANT. |
| F-2 | Medium | `tools/plugins/workspace/index.ts` `write_file` (overwrite allowed); `app.ts` `packWorkspaceDir(workspaceRoot, dir)` uses the same root as `registerGroups({ workspaceRoot })` | The spec's taint argument says "every covered tool stays inside Discord or the sandbox". That is false for `write_file`, because Praw's workspace is the source folder for `site_publish_static`. A tainted, grant-covered run can create or overwrite files that a later admin-approved publish puts on the public internet, and that card shows a folder and an sha, not the content. Separately, `overwrite: true` destroys an existing file with no human seeing it. That is irreversible, which counts as "dangerous work" under the owner's own scope. |
| F-3 | Medium | `tools/builtin/createTask.ts` `createChild` "needsApproval(input.estCostUsd)"; `forwardTo.ts` `estCostUsd: z.number().positive()` | "The child estimate card stays" is conditional. The model chooses `estCostUsd` (any value above 0), so it can pick a value below the threshold, and then a forward creates a delegated child in another department that no human sees. Before this change, the forward_to card itself was the human check (heads are never `direct`). The forwarded summary also reaches the target head's run and work room. The RF11 rule (`wider`, then `forwardCard: 'link'`) withholds it only from the card, not from what the child head later says in its room. |
| F-4 | Medium | `db/migrations/027_web_grants.up.sql` CHECK `revoke_reason IN ('admin','halt','superseded')`; spec §3.6 revokes the companion on `root_ended` and `disabled` | Revoking the companion web grant with reason `root_ended` or `disabled` violates the web_grants CHECK. Inside one transaction with the task-grant revoke, that throw rolls back the task-grant revoke too, so the task grant stays live after `enabled` is turned off. |
| F-5 | Medium | `discord/commands/approval.ts` `refreshBatchCard` "webGrants?.unrevokedOfMessage(i.messageId)"; `revokeButton` | If the companion web grant stores `card_message_id` equal to the task card, the batch refresh paints "Revoke web reading" and the web grant note onto the task card. The card then has two revoke buttons with different scopes, and the web revoke leaves the task grant live. |
| F-6 | Medium | spec §3.3 step 2 and OQ-5; `discord/embeds/approval.ts` `approvalRow` | The task click also creates a web grant, but the label "Approve the whole task" does not say so. The admin would accept WEBGRANT residuals 1 to 6 without the W-C9 and W-C10 statement shown before the click. Discord buttons have no confirm step, so the card body before the click is the only consent surface. |
| F-7 | Medium | `agents/loop.ts` `toolContextBase` adds `webGrants` to every run, including `adminRun` | S8 ("adminRegistry never gets the port") is not structural as written. The consume code sits in `ToolRegistry.exec`, which the admin registry shares, and the context builder is shared too. Today only the name allow-list stops it. |
| F-8 | Low | spec §3.5 order | `taskGrant.allowTainted` is defined (§5.3) but missing from the consume order. Its place relative to `consume` is undefined, so a slot could be spent and then refused. |
| F-9 | Low | spec §3.5 "if halted refuse notRun:'halted'"; `registry.exec` checks halt only when `approved` | `notRun` carries the R4 un-claim meaning for approved replays. On the run path a post-consume halt must be a plain `toolError` that runs nothing. It must sit after `consume` returns ok and before `tool.run`. |
| F-10 | Low | `tools/registry.test.ts` "requiresApproval is not asked again" | The spec's test note says "own now always computed". On the approved path `requiresApproval` must still NOT be called. Compute `own` only when `!approved`. |
| F-11 | Low | spec §3.3 step 3 | `decideTaskGrant` does not re-check "no live task grant", which the button render does. A click on a stale card would silently supersede a live grant and reset its counter and expiry. |
| F-12 | Low | spec §3.3 step 5 (15 s debounced edit) | A queued usage edit can race a revoke, root-end or halt close and repaint a live card with a Revoke button over a closed one. |
| F-13 | Low | spec §3.6 "enabled off → revokeAll('disabled')" | A failed `disabled` revoke (DB fault) is not owed, so a later re-enable brings the old grants back. A process that boots with `taskGrant.enabled = false` revokes nothing. |
| F-14 | Low | spec §3.1 "Startup assertion: every entry registered with kind 'write'" | The music, docs and workspace groups return `disabled` when media, the renderer or the root is missing. Asserting "registered" for all nine would refuse boot in those setups. |
| F-15 | Info | spec §3.6 conversation roots | Which predicate marks a root as a "conversation root" is not stated. `tasks.conversation` alone misses Praw schedule and import roots, which `isConversationTask` covers. |
| F-16 | Info | spec §3.2 | Classification errata (see the table above). |

## Binding conditions (Gate 2)

Each condition names the test file that must prove it. New test files are marked (new).

- **TG-C1 (S3, F-14).** `tools/tree-grant-scope.ts` holds `TREE_GRANT_TOOLS` exactly as the spec lists it.
  - The startup assertion checks that every entry that IS registered has `kind === 'write'` and `isNonSensitiveTool(entry)`, and that none is in `BOT_TALK_TOOLS`, `NO_APPROVAL_TOOLS`, `ADMIN_TOOL_NAMES` or `MOD_TOOL_NAMES`. An unregistered entry is skipped, not fatal.
  - A wrong `kind` refuses boot.
  - Test: `tools/tree-grant-scope.test.ts` (new). Assert that destructive, read and kind-less tools fail, and that boot works with music and docs disabled.
- **TG-C2 (S2, F-10).** In `registry.exec`:
  - `own = approved ? false : tool.requiresApproval(value, ctx)`, computed separately from `central`.
  - The card reason stays `central || own` (central's reason wins when both are truthy).
  - An `own` that throws is treated as truthy (card), never as covered.
  - The waiver applies only when `own === false` (strict).
  - Test: `tools/registry.test.ts`. Keep the "requiresApproval is not asked again" assertion on runApproved. Add one case each for own=true, own={reason}, own throws, and doc_create with every DRAFT kind from `KIND_INFO`: all stay carded under a live grant.
- **TG-C3 (F-1, S7).** One pure function, `treeGrantEligible(row)` in `tools/tree-grant-scope.ts`, takes the stored approval row: `kind`, `toolName`, `toolInput`, `inputSha256`. It returns true only when all of these hold:
  - `kind === 'tool'`;
  - the name is on the list and `registry.kindOf(name) === 'write'`;
  - `inputDigest(canonicalJson(toolInput)) === inputSha256`;
  - the per-tool stored-input predicates of TG-C4 hold.
  It never calls `tool.requiresApproval` with a synthesized context. The solo card render, the batch render and refresh, `decideTaskGrant` and `decideBatch(..., {task:true})` (for every member) all call this same function. Tests: `governance/approvals.int.test.ts` (tampered sha; uncovered tool; DRAFT doc kind; a fetch_page row is `not_grantable`) and `discord/embeds/approval-grant.test.ts` (button present or absent from the same rows).
- **TG-C4 (F-2, F-3). Per-tool predicates, in code (`tools/tree-grant-scope.ts`), in two groups:**
  - **(a) Stored-input predicates.** These are applied in TG-C3 (render and decision) AND at consume:
    - `doc_create`: `!isDraftKind(input.kind)`.
    - `write_file`: `input.overwrite !== true`.
  - **(b) Run-time predicates.** These are applied at consume only. They need run state, so they are never evaluated from the stored row and never through a synthesized ctx:
    - `write_file`: not covered when `ctx.tainted()` or `ctx.task.tainted`, whatever `taskGrant.allowTainted` says, because Praw's workspace is the `site_publish_static` source.
    - `forward_to`: covered only when the audience is not wider. Factor the RF11/G2RF-02 `wider` computation out of `run()` into a helper the consume can call. `wider === true` or any doubt means a card. As an alternative the owner may accept R3b in writing; record which one was chosen.
  - **Why (b) is safe at consume only:** the card's own call is approved by the click and replays through `runApproved`, which never consumes (TG-C6). So (b) only ever governs later calls, which go through the run path where the ctx is real.
  - **These narrow two owner decisions.** The owner said "covered set as specified" and `allowTainted` true. The controller must put both points back to the owner before Gate 2.
  - Tests: `tools/registry.test.ts` (each predicate: carded vs inline) and `tools/builtin/forwardTo.test.ts` (wider → card under a live grant).
- **TG-C5 (S4, F-8, F-9). Registry consume order on the run path only:**
  1. allowlist
  2. zod
  3. precheck and pin
  4. central
  5. own (TG-C2)
  6. covered: list, kind, own, TG-C4
  7. `ctx.task` and sameActor and `ctx.treeGrants`
  8. tainted check (`taskGrant.allowTainted`, read live; false means a card)
  9. `consume`
  10. on ok: audit, re-check `this.opts.halt.isHalted()` (when halted, return a plain `toolError`, no `notRun`, no run), else run inline
  Every miss falls through to today's card path unchanged, with the suffix ` (task grant not applied: <why>)`, where `<why>` comes only from the closed `ConsumeResult` enum. No consume ever calls `ensureConversationTask`. Test: `tools/registry.test.ts` (no task, non-owner keeps I1, tainted with allowTainted false, halted after consume runs nothing, a port fault gives a card and never throws).
- **TG-C6 (S1, S8, F-7).**
  - On `approved === true` the registry strips `ctx.treeGrants` before anything else, a twin of W-C2.
  - `toolContextBase` must NOT add `treeGrants` when the run is an admin run. Pass it only for `registry === deps.tools`. As a second line, the `ToolRegistry` constructor takes `{ treeGrants: boolean }` and only the main registry in `app.ts` sets it.
  - Tests: `tools/registry.test.ts` (approved replay never consumes) and `agents/loop.admin.test.ts` (an admin console run has no `treeGrants` in its context).
- **TG-C7 (S5, halt).** Twins of WEBGRANT W-C3:
  - `halt.onHalted` and `halt.onResumed` call `taskGrants.revokeAll('halt')`.
  - At boot, `revokeBeforeHaltedRow()`, then `revokeAll('halt')` when booting halted. Both run before the scheduler attaches.
  - A failed halt revoke sets `revokeOwed`, paid first by the next consume (a throw there means `error`, which gives a card).
  - The consume `gate()` reads halted and `taskGrant.enabled` live before any SQL.
  - Tests: `db/repos/task-grants.int.test.ts` (new): revokeAll, revokeOwed with a mutation check, revokeBeforeHaltedRow. `governance/halt.int.test.ts`: hooks.
- **TG-C8 (F-13).** On a live flip of `taskGrant.enabled` to false, call `revokeAll('disabled')`. On failure the revoke is owed: the next consume pays it while the flag is back on. At boot with the flag false, call `revokeAll('disabled')`. Test: `db/repos/task-grants.int.test.ts`.
- **TG-C9 (F-4).** The companion web grant is revoked by its id only, with reason `admin` (task revoke, root end, disabled), `halt` or `superseded`, so it stays within the 027 CHECK. As an alternative, migration 035 widens the 027 CHECK in the same migration, and the down migration restores it. A failure to revoke the companion never rolls back the task-grant revoke: use separate statements, or the same transaction with the web revoke after the task revoke inside a savepoint. Test: `db/repos/task-grants.int.test.ts` (revoke with `disabled` and `root_ended` leaves both rows revoked).
- **TG-C10 (F-5).** The companion web grant is inserted with `card_message_id = NULL`, so only the task card's Revoke ends it, and `revokeButton` refuses its id on any message. The task card shows exactly one revoke button (`approval:t:<gid>:revoke`). `refreshBatchCard` looks up the task grant of the message and renders its note and revoke. It never renders a web revoke for a companion. Test: `discord/commands/approval.test.ts`.
- **TG-C11 (F-6, W-C9/W-C10 parity).** Before the click, a card that shows the task button carries code-built text in its body (not only in the label). The text states:
  - the scope ("every department and persona in this task tree");
  - the covered tool list;
  - the call cap;
  - the expiry, using the conversation cap when it applies;
  - what still asks;
  - when `web.taskGrant.enabled`, that it also allows web reading, with the web caps and the WEBGRANT leak statement.
  The label stays within 80 characters and says "whole task". Test: `discord/embeds/approval-grant.test.ts`.
- **TG-C12 (F-11, S6).** Inside `decideTaskGrant` and the batch `:task` path, after the root lock, the decision re-checks "no live task grant" (unrevoked, unexpired, under the cap, root open) with the same predicate as the render, and refuses `not_grantable` when one exists. Supersede then only retires non-live unrevoked rows. Test: `governance/approvals.int.test.ts` (stale card click while a grant is live is refused and nothing is decided; two concurrent clicks on two cards of one tree produce exactly one grant).
- **TG-C13 (batch).** `decideBatch(..., {task:true})` runs all solo checks plus B5/B6 (digest, membership) and TG-C3 for every member. Any member that fails refuses the whole click and decides nothing. The grant is made on `decided[0]` only when `decided.length > 0`, and `card_message_id` follows the G2W-03 rule (the batch's own message). `{task:true}` and `{grant:true}` cannot both be set; that combination returns `not_found`. Test: `governance/approvals.int.test.ts`.
- **TG-C14 (exclusivity and layout).** The solo row is Approve, Reject, Ask, plus exactly one of grant or task. Batch row 0 is Approve all, Deny all, Ask, plus exactly one of grant, task or a revoke. Row 0 never holds more than 5 buttons and there are never more than 5 rows. Every customId is at most 100 characters. Test: `discord/embeds/approval-batch.test.ts` and `approval-grant.test.ts`.
- **TG-C15 (router, customId forging).**
  - `TASK_REVOKE_ID = /^approval:t:(\d{1,15}):revoke$/` is parsed before `APPROVAL_ID`, with its own guard: any other `approval:t:` shape gives 'Unknown action.', the same way `approval:ot:` is handled.
  - `APPROVAL_ID` and `BATCH_APPROVAL_ID` gain `task`.
  - Revoke is admin-only and requires `g.cardMessageId === i.messageId`; otherwise it answers privately and changes nothing.
  - Every card edit targets the stored `card_channel_id` and `card_message_id`, or the clicked message for the click itself, never ids from the customId.
  - Test: `discord/commands/approval.test.ts`, malformed list: `approval:1:task:x`, `approval:t:9`, `approval:t:x:revoke`, `approval:t:1:revoke:x`, `approval:b:1:<digest>:task:x`.
- **TG-C16 (conversation roots, F-15).** Inside the decision transaction, on the locked root row, call `isConversationTask(root)` (the existing predicate, which is broader than `tasks.conversation`). When it returns true, set `expires_at = now() + min(taskGrant.hours, taskGrant.conversationHours)`, computed on the DB clock. The startup refusal applies when `conversationHours > hours`. Test: `governance/approvals.int.test.ts`.
- **TG-C17 (usage line, F-12).** The debounced editor re-reads the grant row before each edit and skips it when the grant is revoked, expired or the root has ended. It renders only keys that are in `TREE_GRANT_TOOLS` and match `SAFE_TOOL_NAME`, with values that are `Number.isSafeInteger` and at least 0. It never shows task titles, inputs or model text. Closing the card (on revoke, root end or halt) cancels any pending edit. Test: `discord/embeds/approval-grant.test.ts` (render) and a fake-timer test in `discord/commands/approval.test.ts` (an edit after a revoke does not repaint).
- **TG-C18 (root end).** A `task.changed` event with `task.id === task.rootId` moving to done or cancelled revokes with `root_ended` and closes the card. The consume SQL keeps its own status check, so the listener is not the security boundary. Test: `db/repos/task-grants.int.test.ts` (consume after root done returns `root_ended`, even when the listener did not fire).
- **TG-C19 (audit).** Each inline grant run writes:
  - `task_grant.use`, with the actor, the run's `taskId` (not the root), the registered tool name and `ok #gid used/max` or the miss reason;
  - the normal `tool` row with its outcome.
  Decision audits: `approval.task_grant ok #aid grant #gid` (plus `web_grant #wid` when the companion is made) and `task_grant.revoke <reason> #gid`. Faults go to `incidents.report({ source: 'task_grant', stage: 'consume' })` with a fixed text plus SQLSTATE only. Test: `tools/registry.test.ts` and `db/repos/task-grants.int.test.ts`.
- **TG-C20 (migration 035).** The migration matches spec §5.1, including the CHECKs `granted_by` snowflake, `max_calls` 1 to 500, `used <= max_calls`, expiry within 72 h, revoked consistency, and the unique partial index. `used_by_tool` is only written by the parameterized `jsonb_set(..., ARRAY[$2::text], ...)`, where `$2` is the registry's own name. Down: `DROP TABLE task_grants` (plus the 027 CHECK restore when TG-C9 takes the widen route). Test: `db/migrations` round-trip in `db/repos/task-grants.int.test.ts`.
- **TG-C21 (unchanged gates).** None of these may move: OT, off days, SPEND-1 dept caps, tree and local caps, estimate cards, the forward_to caps of 2 per run and 4 per root, the forum daily cap, the doc_create RUN_CAP, and the music origin precheck. A covered call still passes its own `precheck` and the re-checks in `run()`. Test: `tools/builtin/forwardTo.test.ts` (third forward in a run is refused under a grant; fifth per root is refused).
- **TG-C22 (spec errata, F-16).** Fix §3.2 as noted in the classification table. Before Gate 2, fix the §3.5 test note ("own now always computed" becomes "own computed on the run path only"), add the TG-C4 predicates to §3.1, and remove "child estimate card stays" as a control from the Security section. The forward_to residual must be stated as R3b.

## Recommendations (not binding; owner options)

- Set `taskGrant.allowTainted` to false for `forum_post` as well. A forum post is the one covered tool that broadcasts to a whole department audience (see R6).
- A per-grant per-tool sub-cap could be added later (for example `pin_message` at most 5) if the 40-call bucket proves too coarse.
- The `site_publish_static` card could list files written by tainted runs (this needs a taint sidecar in the workspace). It would cover direct writes too, not only grant writes.

## Who can trigger what (global rule 10)

- Create and revoke: Bot Admin only. The guard in `discord/commands/index.ts` checks the live role in #⚙️-setting or a mapped approvals room, and the decision passes `isAdmin` again.
- Consume: only the registry, on the run path, for the task owner of a task in the tree.
- Revoke by the system: halt, resume, boot, disabled, superseded, root end.
- Nobody can create a grant from model text, a customId, config written through `/settings` (only `taskGrant.enabled` is a handler key), or psql. Note that psql can change the caps, and that is out of scope as with every config key.

## Residual risks the owner must accept (plain words)

- **R1.** After one click, up to 40 small actions can happen with no further approval card: writing a file, pinning, a forum post, a hand-off to another department, a non-financial document, music. They show only in the usage line on the card and in the audit log.
- **R2.** If a bot has read a web page, a ClickUp task or a file that contains hidden instructions, those instructions can steer these 40 actions, for example toward a misleading forum post, a junk document or a pinned scam message. Money, tax and offer documents, image generation, ClickUp, Jira and GitHub changes, reminders and schedules still ask every time.
- **R3.** The grant covers every department and persona that joins the task tree, including departments that join later through hand-offs.
- **R3b** (if TG-C4's audience rule is not chosen): a hand-off to another department can carry content from a private conversation into a room more people can see, and no human sees the hand-off. The bot itself picks the cost estimate, so it can keep the estimate below the level that would show a cost card.
- **R4.** A lounge conversation grant lasts up to 4 hours and covers that same person's later messages in that conversation, even on a new topic, because a parked conversation reopens into the same task tree.
- **R5.** The click also turns on web reading for the tree (when web grants are on). Everything accepted for WEBGRANT residuals 1 to 6 applies again.
- **R6.** A forum post the bot writes under a grant is never shown to a human first. Even before this change the card showed only the title, not the body. It can repeat something from a private thread to the whole department forum.
- **R7.** Files Praw writes under a grant (new files only, per TG-C4; never while it has read outside content) can later end up on the public website if an admin approves a site publish of that folder. The publish card shows a fingerprint, not the files.
- **R8.** Music can be played, skipped and set up to 150 percent volume in a voice conversation for the life of the grant.
- **R9.** Clicking "Approve the whole task" approves the card's own call too. Cards that were already waiting stay waiting and must be decided one by one.

## Missing context

- `.claude/rules/security.md` under PROJECT_ROOT: not present. `PROJECT_ROOT/CLAUDE.md`: deleted by the owner (see the Book index). I used the team global and labworkspace security rules and the WEBGRANT-1 gates.

## Files audited (md5 at end of review)

- 3fc3272f375d442319e1d6323e6a7923 docs/superpowers/specs/2026-11-09-tree-grant-design.md
- 6e4a7ad69f26590911df370925e53cfa tools/registry.ts
- a8654980b62b1751a13ccde3b120d907 tools/policy-approval.ts
- 9e540ddc173aeaa9f82685f073a99ce7 tools/types.ts
- 6791749b0b6c0d6bc070c9ffff32e2fe governance/approvals.ts
- d3c17954b12fddea775f671e2cc1d797 db/repos/web-grants.ts
- b460b4753ed40fc435823eb71f7cd375 discord/commands/approval.ts
- 6d9b99fbd211add9b28793ed3067322f discord/commands/index.ts
- 8a0afc0b614af82dd6890e338f8ea467 discord/embeds/approval.ts
- 1fbbb4d9a14d314821d6f988b14391ae discord/approval-rooms.ts
- c5c5bb65d87e545a5181265add2cbaa3 agents/loop.ts
- 9a7f8c1dc264d557d5ed2fad8c4f7fd4 agents/conversation.ts
- 884246046cd1e6db4c2d9d6cc1111160 app.ts
- 60717acf45b41cccf06ca26beb0a2e88 tools/builtin/forwardTo.ts
- 23260722b896c2cd8081213eedd89108 tools/builtin/createTask.ts
- 01503bfe6d34477782a7e0dbea4e73f4 tools/plugins/docs/index.ts
- 8ef54c5da6fd36874b39c081b87643b9 tools/plugins/docs/kinds.ts
- 7d3d4a2d06b2688dd8a9b1d96ad7accc tools/plugins/workspace/index.ts
- 34fad8570b4fa14a07923d19d92f766a tools/plugins/pin/index.ts
- 82b64b50c605d76374e9cc56b8fe2028 tools/plugins/forum/index.ts
- 5be11e4841faafa9ea230c7ae7b2499a tools/plugins/music/index.ts
- 81420f4c3cd25f9027b5e66fe5abc115 db/migrations/027_web_grants.up.sql
- db7fff7387a349480328c970b3995e74 agents/scheduler.ts
- d5f619c92f004dec598d72390fd63ba4 config/defaults.ts
- 1c5c62501142c310ef1419a292561f40 tools/skill-grant.ts
- d1eced2ced6a2340fcc0e6f1cfc54e03 governance/halt.ts

## Owner sign-off

Pending. The controller records the owner's acceptance of R1 to R9 here (and the TG-C4 forward_to choice: audience rule, or R3b accepted).

## Owner sign-off (2026-11-09, recorded by controller from the owner's answer in chat)
The owner ACCEPTS residuals R1, R2, R3, R4, R5, R6, R8, R9 and chose TG-C4 narrowing: write_file covered only for new files (overwrite !== true) and never in a tainted run; forward_to covered only when the target audience is not wider (so R3b and R7 are mitigated, not accepted).
