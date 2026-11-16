# CLICKUP-ALL-1 — ClickUp workspace scope (read + write all projects) — spec

Owner request 2026-11-08: new CLICKUP_API_TOKEN set; bots should read and write ALL ClickUp projects (not only CLICKUP_LIST_ID); writes still need approval every time. Requires security gate. Migration **034_clickup_write_usage**. Open questions resolved with defaults (end).
Files: tools/plugins/clickup/{client,index,write,poller}.ts, core/env.ts, app.ts, admin/keys.ts, config/{schema,defaults}.ts, discord/embeds/approval.ts, dashboard/envfile.ts, .env.example, migration 034.

## Actors / boundaries
Model (heads/personas with clickup_* tools: config/defaults.ts CLICKUP_READ → software, it, ops, hr, marketing; Praw all), human approver, owner (env + slash), ClickUp API (external, untrusted), poller (no model). Everything ClickUp returns is untrusted. Token, team id, list id are env only, never reach a tool/model (tools/plugins/deps.ts). Workspace boundary = single team id T; every read is `/team/{T}/...` (server-scoped) or a scope check against S(T) = space ids in T.

## 3.1 Modes (core/env.ts)
CLICKUP_LIST_ID set → mode `list` (today's behaviour byte for byte; CLICKUP_TEAM_ID ignored). CLICKUP_LIST_ID absent + token set → mode `workspace`. No token → disabled ('CLICKUP_API_TOKEN not set', still matches clickup.test.ts:115). New optional env CLICKUP_TEAM_ID `/^\d{1,20}$/` (bad value throws naming the key, never the value). Env.clickup = { apiToken; listId?; teamId? } present whenever token set. Add CLICKUP_TEAM_ID to dashboard/envfile.ts (group ClickUp) and .env.example; core/child-env.ts unchanged.

## 3.2 Team resolution (workspace, lazy in client)
scope.team(): GET /team once; success cached for process life; failure not cached, retry ≤1/60 s. CLICKUP_TEAM_ID set → must be among returned teams else `mismatch`; unset → exactly 1 team → that id; 0 → `none`; ≥2 → `ambiguous` (never pick first). Unresolved → every call returns E_TEAM; app.ts fires `void clickup.scope.team()` after start; failure → one log.warn + audit `clickup.workspace.unresolved` (outcome = reason code only). S(T) = GET /team/{T}/space?archived=false, ≤100 spaces, cached 10 min; a miss refreshes once then decides.

## 3.3 Scope checks (replace listId equality in workspace mode)
taskInScope(id): GET /task/{id}; in scope only if task.space.id ∈ S(T) AND (task.team_id absent or == T); 404/403/out-of-scope → same E_SCOPE_TASK (no existence oracle). listInScope(id): GET /list/{id}; in scope only if list.space.id ∈ S(T) (GET /list has no team_id) → E_SCOPE_LIST. The token may see other workspaces: "fetch succeeded" is NOT proof of scope (IDOR). Statuses/members for update_status and assign come from the task's own list.id (from scoped getTask), never listPath (client.ts updateStatus/assign/analyze hard-code listPath today). One client createClickUpClient({ http, token, listId?, teamId?, now }) exposing mode, scope, list-parameterised methods; listId: string | null.

## 3.4 Reads (workspace)
- clickup_list_projects: hierarchy Space / Folder / List (id) via S(T), per space GET /space/{id}/folder?archived=false (lists embedded) and GET /space/{id}/list?archived=false; caps 20 spaces, 150 lines, "truncated" note; cached 10 min.
- clickup_search_tasks (NEW, both modes; list mode forces list_ids[]=listId): GET /team/{T}/task order_by=updated, subtasks=true, include_closed per input, filters list_ids[], space_ids[], statuses[], assignees[] (user id from cached /team members by exact username/email; unknown → error), date_updated_gt; `query` = client-side case-insensitive substring on name (API has no text search); ≤3 pages (300); shows 20 lines `- name (id, status, list: <list name>, assignees)`; note when cap hit; no description.
- clickup_list_open_tasks, clickup_analyze_project, clickup_list_members: `project` REQUIRED in workspace mode (list id or exact list name via hierarchy cache); several matches → E_AMBIG_LIST; empty/'all' → E_NEED_LIST; then listInScope, then today's logic on that list.
- clickup_get_task_detail, clickup_list_comments: taskInScope first; comments never fetched out of scope.
All reads keep untrustedOutput: true, untrustedSource 'clickup', redactText. Whitelist rendering only; never render inbound_address, creator/watcher emails, custom_fields, attachments, permission_level. HttpClient maxBytes 4 MiB, timeout 15 s; too large → fixed error. Model-facing descriptions per mode (drop "only the configured project" in workspace mode: index.ts:14, :53; write.ts:40).

## 3.5 Writes (workspace)
Tools create_task, update_task, update_status, assign_task, add_comment. clickup_delete_task NOT registered in workspace mode (kept in list mode).
Approval every call in workspace mode only: tool requiresApproval always returns {reason} (image_generate pattern), ORed with central (registry.ts:124) so direct+untainted no longer skips the card. List mode keeps approvalFor as today (write.test.ts:207, :233).
Inputs: create gains `list_id: CLICKUP_ID` (required in workspace); all writes gain optional pinned `in_list_id: CLICKUP_ID`, `list_path: string ≤300` (description "set by the system, leave empty").
precheck (run and runApproved): 1 run cap filed(ctx.run) ≥ 5 → E_RUN_CAP; 2 scope: create listInScope(list_id), others taskInScope(task_id) → list.id; 3 resolve path "Space / Folder / List"; 4 input in_list_id/list_path differing from fresh → E_MOVED (moved task, renamed list, forged pin); 5 return { summary: { target: q(path)+' (list '+id+')' [+ ' task '+q(name)+' ('+id+')'], change: today's change text }, pin: { in_list_id, list_path } } — pin merged into the stored digest (registry.ts:110-118) so the card shows list_path and the digest binds it.
Run cap counting: onApprovalTask increments filed(ctx.run) (WeakMap keyed on run) — request path only; approved replays and batch approve-all never count.
Body fully visible (exfiltration guard): workspace mode description/comment text ≤1500 chars; discord/embeds/approval.ts toolCallView code-defined FULL_BODY_TOOLS = ['clickup_create_task','clickup_update_task','clickup_add_comment'] show text/description in full in chunked fields like query/prompt (approval.ts:106-131), label "Body" (today cut at VALUE_MAX 120). Worst-case 1500-char escapable body must render cut === false within Discord limits (≤25 fields, ≤1024 each, ≤6000 total).
Daily cap: in run(), after scope re-check, immediately before the write HTTP call, ClickUpWriteUsage.take(cap = cfg 'clickup.writesPerDay'); refused → E_DAY_CAP; DB error → E_COUNTER (fail closed); no give-back; writesPerDay 0 = writes off.
Batching: ClickUp writes stay batchable; do NOT add clickup_ to SENSITIVE_TOOL (also gates skill grants, tools/skill-grant.ts:27). Batch items render full input incl. list_path; long bodies fail compactItemFits → solo card. Write results fixed text (no taint, write.ts:33).

## 3.6 Rate limiting
One token bucket per client shared by tools and poller: 80 req/min (ClickUp floor 100/min/token). acquire() waits ≤5 s else E_BUSY. After HTTP 429 pause 60 s. Existing 429 text kept (client.ts:59).

## 3.7 Poller
List mode unchanged. Workspace: polls only clickup.pollListIds (new, default [], max 10); empty → poller not started (app.ts:708 gated on mode==='list' || pollListIds.length > 0, read each tick). Fetch GET /team/{T}/task?list_ids[]=…&include_closed=false&subtasks=true ≤5 pages. Silent baseline per list row ('*','baseline',<listId>) in clickup_seen (no migration; legacy '1' row = list mode); new watched list baselined silently. Prune with union of live ids only when no page cap hit. `/clickup watch list_id:<id> action:add|remove` plan function: listInScope before add, cap 10, writes clickup.pollListIds, audit clickup.watch.

## 3.8 Exceptions
ClickUp down/timeout → fixed error, nothing written, poller backs off. Task moved between card and approve → E_MOVED. Space deleted → E_SCOPE_*. Halt → registry gate. Concurrent approvals → counter row lock, no over-run. Restart → counters durable, caches rebuilt. Single ClickUp call per write.

## Contracts
Env CLICKUP_TEAM_ID?: /^\d{1,20}$/; Env.clickup = { apiToken; listId?; teamId? }.
Config (schema + defaults, both in HANDLER_KEYS admin/keys.ts:12): 'clickup.writesPerDay' z.number().int().min(0).max(500) default 50 (/settings by a person; raising = risk ⚠, reroute.enabled pattern plans.ts:130-136); 'clickup.pollListIds' z.array(z.string().regex(CLICKUP_ID)).max(10) default [] (only via /clickup watch).
clickup_search_tasks input { query?: string≤100; list_id?: CLICKUP_ID; space_id?: CLICKUP_ID; assignee?: string≤200; status?: string≤100; include_done?: boolean; updated_within_days?: int 1..365 }.
Migration 034_clickup_write_usage:
```sql
CREATE TABLE clickup_write_usage (
  day  date    PRIMARY KEY,
  used integer NOT NULL DEFAULT 0 CHECK (used >= 0)
);
```
Down: `DROP TABLE clickup_write_usage;`. take: `INSERT INTO clickup_write_usage(day,used) VALUES ($1,1) ON CONFLICT (day) DO UPDATE SET used = clickup_write_usage.used + 1 WHERE clickup_write_usage.used < $2 RETURNING used` (no row = refused; also refuse when $2 = 0).
Fixed errors: E_TEAM "ClickUp: the workspace is not set up (the token sees no workspace or several; the owner sets CLICKUP_TEAM_ID)"; E_SCOPE_TASK "ClickUp: that task is not in this workspace"; E_SCOPE_LIST "ClickUp: that list is not in this workspace"; E_NEED_LIST "ClickUp: name a list by id or exact name (see clickup_list_projects)"; E_AMBIG_LIST "ClickUp: several lists have that name, use the id"; E_MOVED "ClickUp: the task or list changed since the card was made; nothing was done"; E_RUN_CAP "ClickUp: at most 5 write requests per run"; E_DAY_CAP "ClickUp: the daily write limit is reached; nothing was done"; E_COUNTER "ClickUp: the daily write counter is unavailable; nothing was done"; E_BUSY "ClickUp: too many requests right now, try again in a minute". Existing 401/403/429/5xx texts kept.

## Security (Gate 1)
Cross-project exfiltration: reads cover every project and results land in Discord rooms whose readers may lack ClickUp access → RESIDUAL for owner acceptance (alternative per-dept space allowlist). Tainted run copying project A into B: approval every write, full body on card (cut false), 1500 cap. Injection: all ClickUp text untrusted, run tainted, workspace writes always carded, poller has no model, vendor names via escapeCardText. IDOR: scope = space id ∈ S(T), uniform refusals, ids regex-checked and pathId-encoded. Blast radius: no delete in workspace mode, 5/run, 50/day (owner key), no assignee/notify-all on create, notify_all:false on comments. Rate: shared 80/min bucket, 60 s pause after 429, poller ≈25 req/tick. Logs: ids + status codes only; never bodies, names, descriptions, comments, emails; token stays in redaction secret list (app.ts:223); mask authorization header, emails, inbound_address. Model reachability: token/list/team env only (owner dashboard env page); both config keys HANDLER_KEYS.

## Tests
(a) env mode matrix; (b) team resolution 0/1/2/mismatch/TEAM_ID wins, 2 never picks first; (c) task/list in another workspace refused same text as 404, no write; (d) direct untainted workspace write → awaiting_approval; (e) approved replay after move/rename/forged pin → E_MOVED, no write; (f) 6th call refused, batch approve-all of 8 not refused by run cap; (g) daily cap 10 parallel takes cap 2 → exactly 2; 0 = off; durable across repo re-instance; (h) delete not registered in workspace mode; (i) worst-case 1500-char body cut false within Discord limits, 1501 refused by zod; (j) search sends no text param, 3-page cap, no description, no inbound_address/email; (k) limiter shared with poller, no request for 60 s after 429; (l) workspace poller with empty allowlist not started, new watched list baselined silently; (m) token/team/list id never in results, audit, errors (extend clickup.test.ts:123); (n) /clickup watch refuses other-workspace list and 11th list; (o) both keys HANDLER_KEYS, config_propose refuses.
Assertions to update: core/env.test.ts:121 (clickup now { apiToken:'pk_1_X' }, title :119); dashboard/envfile.test.ts:10-14 SPEC_KEYS + 'CLICKUP_TEAM_ID'; config/defaults.ts:19 CLICKUP_READ + clickup_search_tasks (check tests/acceptance-matrix.json, tools/plugins/index.test.ts snapshots). List-mode tests unchanged.

## Defaults for open questions
OQ-1 owner steps after build: clear CLICKUP_LIST_ID on the dashboard env page; set CLICKUP_TEAM_ID only if GET /team shows >1 workspace; restart; `/clickup watch list_id:1100430000013096 action:add` to keep notices for LW Tasks. OQ-2 approval every time only in workspace mode. OQ-3 ClickUp writes batchable. OQ-4 delete unregistered in workspace mode, kept in list mode. OQ-5 no per-dept space allowlist; owner accepts cross-audience residual. OQ-6 caps 5/run, 50/day, body 1500, search 3 pages, hierarchy 20 spaces, bucket 80/min.

## Amendments after Gate 1 (binding; C1–C12 in docs/security/2026-11-08-gate1-clickup-workspace.md win where they differ)
- C3: workspace mode requires an explicit CLICKUP_TEAM_ID (positive opt-in); token alone without list id stays DISABLED; no auto-pick from GET /team; boot audit row clickup.mode + #bot-log notice. OQ-1 owner steps: set CLICKUP_TEAM_ID (the workspace id) and clear CLICKUP_LIST_ID, restart, then /clickup watch the lists to keep notices.
- C1: drop the "1500 chars always fits" claim; refuse control and HIDDEN characters in bodies; precheck renders the card and refuses unless cut===false, ≤25 fields, ≤1024/field, ≤6000 total; Body chunks count in compactItem.
- C2: list path (per-segment cap, total ≤110) and task name (≤110 or shown in full) always shown whole, same deterministic builder for E_MOVED.
- C4: status validated in precheck with a fixed refusal; vendor status names only via a tainted read; no vendor strings in write results.
- C5: refuse a write when redaction would change the text. C6: ≤1 S(T) refresh per 60 s. C7: list-mode schemas/tools/snapshots unchanged (pin fields and list_id only in workspace mode); search in list mode uses /list/{id}/task or is not registered. C8: re-filter on our side by space ∈ S(T) and requested list/space; poller filters by watched lists. C9: day computed by the app in schedule.timezone; daily cap applies to workspace mode only (stated). C10: run() re-checks list.id === in_list_id before take(). C11: no AdminOp for the new keys; config_propose refuses; /settings and /clickup watch gated. C12: tests (a)–(o) kept, (m) also covers T and space ids.
