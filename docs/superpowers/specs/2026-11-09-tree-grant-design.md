# TREEGRANT-1 — "Approve the whole task" task-tree grant (spec)

Owner request 2026-11-09: approve only the big task once; the rest needs no approval until the task ends; a new task asks again. Owner decisions: grant offered on the FIRST covered approval card of a tree (extra button, like WEBGRANT-1); scope = everything except dangerous work; owner confirmed the covered set "as specified" (no ClickUp writes, image, tainted web_search, reminders/schedules). Requires security gate (deliberately weakens R3/P2 "delegated writes always ask"). Migration **035_task_grants**. Open questions resolved with defaults (end).

## Actors / boundaries
Bot Admin (isAdmin) only creates/revokes a grant. Model/runs consume only through the registry. Scope = one task tree (root_id) and every department/persona in it. Decision rests on DB rows + code allow-lists, never model text or customId content. adminRegistry (app.ts adminRegistry.register) never gets the port; admin, deploy, code, spendovr, OT card families untouched.

## 3.1 Coverage rule (code, fail-closed) — new tools/tree-grant-scope.ts
```ts
export const TREE_GRANT_TOOLS: readonly string[] = ['write_file','pin_message','forum_post','forward_to','doc_create','music_play','music_skip','music_stop','music_volume'];
export const treeGrantCovers = (name: string, kind: ToolKind | undefined, own: unknown): boolean =>
  TREE_GRANT_TOOLS.includes(name) && kind === 'write' && own === false && isNonSensitiveTool(name);
```
Allow-list of names (like BOT_TALK_TOOLS / NO_APPROVAL_TOOLS); any new tool is always-ask. Startup assertion + test: every entry registered with kind 'write' and isNonSensitiveTool(entry) true. KEY RULE: the grant waives only the central approvalFor result, never the tool's own requiresApproval.
TG-C4 predicates (code, in tools/tree-grant-scope.ts): (a) stored input, applied at card, decision AND consume: doc_create never a DRAFT kind; write_file never `overwrite: true`. (b) run state, consume only: write_file never in a tainted run (run or task); forward_to only when `forwardWider(...)` is false (the RF11/G2RF-02 helper the tool itself uses). One pure predicate `treeGrantEligible(row, kindOf)` serves the card, decideTaskGrant and decideBatch.

## 3.2 Classification
- Never ask today (reads; warroom_say, diagram_create; builtins with no kind: respond, create_task, update_task, ask_requester, answer_subtask, knowledge_propose, prompt_propose, skill_propose) — n/a.
- COVERED: write_file (sandbox), pin_message, forum_post (own forum), forward_to (internal; per-run 2 and per-root 4 caps stay; covered only when the audience is not wider; the child estimate card is not a control, TG-C22), doc_create (non-DRAFT kinds), music_play/skip/stop/volume.
- ALWAYS ASK (tool's own rule): doc_create DRAFT money/tax/offer kinds (RF21), image_generate, video_generate (off), workspace-mode ClickUp writes, tainted meeting_start, tainted web_search, tainted watch_add, tainted fetch_page (web grant only).
- ALWAYS ASK (not on list): list-mode clickup_create_task/update_task/update_status/assign_task/add_comment; jira_create_issue/update_issue/update_status/add_comment; sheets_append_receipt; schedule_add, add_reminder.
- ALWAYS ASK (deletion): cancel_reminder, watch_remove, schedule_remove, delete_lesson, clickup_delete_task, jira_delete_issue.
- ALWAYS ASK (sensitive, #setting): github_create_branch, github_create_or_update_file, github_create_pull_request, save_lesson (and any tool named skill_*, knowledge_*, prompt_* by the SENSITIVE_TOOL pattern). Erratum (TG-C22): the registered knowledge_propose, prompt_propose and skill_propose have no kind and never ask; they only file proposals. Untainted watch_add, music_queue and schedule_remove are not on the list and keep today's behaviour (watch_add, schedule_remove ask; music_queue is a read).
- Separate families, unreachable: config_*, admin_op_propose, perm_propose, server_propose, deploy_*, site_publish_static, code_* (adminRegistry); estimate/cap approvals (onTreeCapHit, onLocalCapHit); spendovr; OT.

## 3.3 Grant creation
1. Registry files a tool card for a covered call (kind tool, own=false, on list).
2. Card renders "Approve the whole task" (`approval:<id>:task`) only when taskGrant.enabled AND treeGrantCovers(stored toolName, kind, own recomputed from stored input) AND stored input hashes to input_sha256 AND tree has no live task grant. Never on fetch_page cards (they carry the web-grant button), sensitive or #setting-only cards; ≤5 buttons per row.
3. Admin click → Approvals.decideTaskGrant(id, user, {messageId}) one tx, lock root FOR UPDATE then approval FOR UPDATE: checks isAdmin, not halted (before and last in tx), pending, live, enabled, covered recomputed with sha check, root not done/cancelled; decideRow(approved); supersedeAllTaskGrants(root); INSERT task_grants with caps snapshotted; if web.taskGrant.enabled also makeGrant (companion web grant, web caps) and store web_grant_id.
4. After commit haltedAfterCommitTask(gid) (twin of haltedAfterCommit) revokes both grants, returns halted_after_commit; approval stands.
5. Card closes in place: grant text (scope, caps, expiry, "every department in this task tree", covered list, what still asks), Revoke button `approval:t:<gid>:revoke`, code-built usage line edited in place debounced 15 s `Used 7/40 · write_file×3 forum_post×2 forward_to×2` (registered tool names + integers only).

## 3.4 Batch card `approval:b:<bid>:<digest>:task` ("Approve all + whole task")
Only if every member covered; all-fetch_page batches show the web-grant button instead (exclusive). decideBatch(..., {task:true}) same checks as solo + B5/B6 digest checks; decides all members; grant created on decided[0].

## 3.5 Consume (registry exec, run path only)
Order: allowlist → zod → precheck (refusals/pins apply) → central = approvalFor(...). Compute own = tool.requiresApproval(value, ctx) SEPARATELY (today `central || tool.requiresApproval(...)` short-circuits — must change). If !approved && central && own === false && ctx.task && sameActor(ctx.task.owner, ctx.actor) && ctx.treeGrants && treeGrantCovers(name, tool.kind, own): r = await ctx.treeGrants.consume({rootId: ctx.task.rootId, tool: name}); r.ok → audit task_grant.use `ok #gid used/max`; if halted refuse notRun:'halted' (inline path has its own halt check); else run inline. Else card with reason suffix ` (task grant not applied: <why>)`. Never ensureConversationTask for a consume (no task → no grant). On approved=true strip ctx.treeGrants first (twin of W-C2).

## 3.6 Alternate / exception flows
No grant/expired/cap/revoked/root ended/disabled/halted/DB fault → normal card; fault → incident task_grant/consume, never throws. Non-owner → existing I1 refusal. Tainted run still covered (taskGrant.allowTainted default true). Root ends (task.changed to done/cancelled with task.id == rootId) → revoke root_ended, close card; consume also checks root status in SQL. Conversation roots: allowed but expires_at = now() + min(taskGrant.hours, taskGrant.conversationHours) (default 4 h). REROUTE child under open parent covered; new reroute root not. ASKBACK, forward_to, create_task children share the root → covered. Pending cards at grant time stay pending. Halt (WEBGRANT twins): onHalted/onResumed revokeAll('halt'); boot revokeBeforeHaltedRow + revokeAll when booting halted; revokeOwed paid by next consume; consume gate halted/disabled; enabled off → revokeAll('disabled'). Supersede inside the tx after the root lock; unique partial index second line. OT, off days, SPEND-1, tree/local caps, estimate cards unchanged; grant never starts held work or bypasses a budget reserve.

## 5.1 Migration 035_task_grants
```sql
CREATE TABLE task_grants (
  id bigserial PRIMARY KEY,
  root_id text NOT NULL REFERENCES tasks(id),
  approval_id bigint NOT NULL UNIQUE REFERENCES approvals(id),
  granted_by text NOT NULL CHECK (granted_by ~ '^[0-9]{17,20}$'),
  requested_by text NOT NULL,
  max_calls integer NOT NULL CHECK (max_calls BETWEEN 1 AND 500),
  used integer NOT NULL DEFAULT 0 CHECK (used >= 0),
  used_by_tool jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(used_by_tool) = 'object'),
  web_grant_id bigint REFERENCES web_grants(id),
  card_message_id text CHECK (card_message_id IS NULL OR card_message_id ~ '^[0-9]{17,20}$'),
  card_channel_id text CHECK (card_channel_id IS NULL OR card_channel_id ~ '^[0-9]{17,20}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by text,
  revoke_reason text CHECK (revoke_reason IS NULL OR revoke_reason IN ('admin','halt','superseded','disabled','root_ended')),
  CONSTRAINT task_grants_used_cap CHECK (used <= max_calls),
  CONSTRAINT task_grants_expiry CHECK (expires_at > created_at AND expires_at <= created_at + interval '72 hours'),
  CONSTRAINT task_grants_revoked CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);
CREATE UNIQUE INDEX task_grants_one_live_idx ON task_grants(root_id) WHERE revoked_at IS NULL;
CREATE INDEX task_grants_card_idx ON task_grants(card_message_id) WHERE card_message_id IS NOT NULL;
```
Down: `DROP TABLE task_grants;`

## 5.2 Consume ($2 = registered tool name, code-sourced)
```sql
UPDATE task_grants g SET used = g.used + 1,
  used_by_tool = jsonb_set(g.used_by_tool, ARRAY[$2::text], to_jsonb(coalesce((g.used_by_tool->>$2::text)::int, 0) + 1))
FROM tasks t
WHERE g.root_id = $1 AND t.id = g.root_id AND t.status NOT IN ('done','cancelled')
  AND g.revoked_at IS NULL AND g.expires_at > now() AND g.used < g.max_calls
RETURNING g.id, g.used, g.max_calls AS max;
```
ConsumeResult = {ok:true; grantId; used; max} | {ok:false; why:'none'|'revoked'|'expired'|'cap_calls'|'root_ended'|'halted'|'disabled'|'error'}. TaskGrantPort { consume(r:{rootId; tool}) } on ToolContext.treeGrants? (tools/types.ts).

## 5.3 Config (none in ADMIN_CONFIG_KEYS)
taskGrant.enabled bool true (HANDLER_KEYS, /settings); taskGrant.hours int 12 (1–72, psql only); taskGrant.conversationHours int 4 (1–hours, psql only); taskGrant.maxCalls int 40 (1–500, psql only); taskGrant.allowTainted bool true (psql only). Startup refusal if conversationHours > hours.

## 5.4 customIds (approval: router)
APPROVAL_ID `^approval:(\d{1,15}):(approve|reject|ask|grant|task)$`; BATCH action adds task; TASK_REVOKE_ID `^approval:t:(\d{1,15}):revoke$` + fall-through guard `approval:t:` → 'Unknown action.'. Revoke admin-only and g.cardMessageId === i.messageId (W-C11b); revokes task grant + companion web grant.

## 5.5 Replies / audit
Errors (ephemeral; refused click leaves card decidable): not_admin, not_pending, expired, not_grantable, root_ended, halted, halted_after_commit. Audit: approval.task_grant `ok #<aid> grant #<gid>`; task_grant.use `ok #gid n/max` or miss reason; task_grant.revoke `<reason> #gid`.

## Security (Gate 1)
Taint: covered even when tainted (every covered tool stays inside Discord or the sandbox; external writes, egress, persistent jobs keep cards via own or the allow-list); residual internal paths after injection: forum_post, pin_message, write_file, doc_create junk content; forward_to cross-audience closed by the TG-C4 audience rule (covered only when not wider) and bounded by FORWARDS_PER_RUN 2 / PER_ROOT 4; the child estimate card is NOT a control (the model picks estCostUsd), so it is not relied on. Residual R3b is mitigated by the audience rule, not accepted. Usage line: registered names + integers only. Invariants: S1 approved path strips port; S2 never waives truthy own; S3 allow-list only, new tools fail closed; S4 no consume without task + owner match + port; S5 halt refused before/inside tx, revoked after commit, on halt/resume/boot, revokeOwed; S6 supersede under root lock; S7 DB rows + recomputed sha, never customId content; S8 adminRegistry no port; S9 startup assertion.
Residuals for owner: R1 after one click up to 40 internal writes run unseen (usage line + audit only); R2 content planted in web/ClickUp can steer them; R3 grant covers every department joining the tree; R4 lounge conversation grant lasts up to 4 h and covers later requests; R5 companion web grant carries WEBGRANT residuals 1–6.

## Tests
Registry: covered/uncovered, own-truthy stays carded, tainted, non-owner, no task, approved-strip, halted inline. Repo int: concurrent consume to cap, expiry, root_ended, supersede, revokeAll, revokeOwed (mutation check), revokeBeforeHaltedRow. decideTaskGrant int: tampered sha, uncovered tool, root ended, halted after commit, companion web grant. Card render: button present/absent, exclusive with grant button, ≤5 buttons, ids ≤100. Router: malformed approval:t: and :task shapes. Update: approval.test.ts malformed list (+ approval:1:task:x, approval:t:9); own is computed on the run path only (TG-C22): the registry.test "requiresApproval is not asked again" assertion on the approved path stays.

## Defaults
OQ-1 owner accepted the small covered set ("ตามสเปก"); OQ-2 tainted web_search not covered; OQ-3 pending cards not auto-approved; OQ-4 first covered card of a tree with no live grant; OQ-5 task click also creates the web grant when web.taskGrant.enabled; OQ-6 add_reminder stays carded; OQ-7 no USD slice; OQ-8 conversation roots capped at 4 h.

## Amendments after Gate 1 (binding; TG-C1–TG-C22 in docs/security/2026-11-09-gate1-tree-grant.md win where they differ)
- Owner chose TG-C4 narrowing: write_file covered only when overwrite !== true AND the run is not tainted; forward_to covered only when the target audience is not wider (`wider` false). Residuals R1–R6, R8, R9 accepted.
- One pure stored-input predicate treeGrantEligible shared by card, decideTaskGrant, decideBatch; run-state predicates (taint, audience, overwrite) only at consume (TG-C3).
- Companion web grant: card_message_id NULL, exactly one revoke button on the task card; web_grants revoke_reason CHECK extended (or use an allowed reason) so root_ended/disabled revokes never roll back the task-grant revoke (TG-C9, TG-C10); card text says before the click that web reading is also enabled (TG-C11).
- No treeGrants port on admin runs + registry constructor flag (TG-C6). allowTainted in consume order; post-consume halt re-check returns a plain toolError (TG-C5). own computed only when !approved; card reason stays central || own; registry.test "requiresApproval is not asked again" holds (TG-C2). Decision re-checks "no live grant" (TG-C12). Usage-line edit re-reads the row and cancels on close (TG-C17). Disabled revoke owed + boot-with-flag-off revokes (TG-C8). Startup assertion skips disabled groups (TG-C1). Conversation root predicate isConversationTask(root) on the locked row (TG-C16). §3.2 errata per TG-C22.

## Amendment after tester (DEFECT-002)
- Real lifetime: Praw conversation roots close when the owner's run finishes, so the grant revokes with `root_ended`. In practice it covers the rest of the current run and the department tasks it starts; `taskGrant.hours` is only an upper bound. The offer text now says "for the rest of this run and the department tasks it starts (it ends when this conversation or task finishes, and after N hours at most)".
- write_file is effectively never covered after a card, because any approved card taints the resumed run (agents/loop.ts) and tree-grant-scope refuses tainted writes. The offer text now says so. Widening this is an owner decision (tester DEFECT-001), not done.
- Gate 2 lows L-1..L-4 are optional follow-ups.
