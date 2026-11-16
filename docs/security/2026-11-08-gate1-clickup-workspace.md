# Security Gate 1: CLICKUP-ALL-1 (ClickUp workspace scope, read and write across all projects)

- Gate: 1 (spec review)
- Spec: docs/superpowers/specs/2026-11-08-clickup-workspace-design.md (migration 034)
- Code read (current state, to check the spec's claims): tools/plugins/clickup/{client,index,write,poller}.ts, tools/plugins/deps.ts, core/env.ts, app.ts (secretsOf ~219-225, client ~401, poller ~707-711), admin/keys.ts, admin/ops.ts, config/{schema,defaults}.ts, discord/embeds/approval.ts, discord/approval-rooms.ts, tools/skill-grant.ts, tools/policy-approval.ts, tools/registry.ts (exec 72-170), services/http.ts, core/logger.ts, discord/commands/plans.ts.
- No `~/.config/assistant` values were read. No code was edited.
- Date: 2026-11-08

## Verdict: CONDITIONAL_APPROVE

The design is sound in the places that matter most:
- The workspace boundary is a space id check against S(T). A fetch that merely succeeds does not count as proof of scope.
- Refusals are uniform, so they do not reveal whether a task exists.
- Every workspace write gets an approval card, and the card binds the target through the precheck pin and the digest.
- Delete is not registered in workspace mode. There is a cap per run and a daily cap that fails closed.
- The poller has no model in it.
- The token, team id and list id stay in env and never reach a tool.

Five places in the spec are wrong or fail open, and the conditions below fix them:
- The spec claims a 1500-character body always fits on the card. That is false for adversarial text (C1).
- The destination path on the card can be cut (C2).
- Choosing the mode fails open: clearing one env value widens the scope (C3).
- Vendor text can reach the model without tainting the run (C4).
- In list mode, `clickup_search_tasks` needs a team id that list mode never resolves (C7).

## Findings

| ID | Severity | Where | Finding |
| :--- | :--- | :--- | :--- |
| G1CW-01 | High | spec §3.5 "Body fully visible", Tests (i); discord/embeds/approval.ts:78-87 (escapeCardText), :112-124 (chunking), :204 | **The 1500-character body claim cannot hold.** Under `toolCallView`, a body expands as follows: `\` becomes `\\` in JSON and then `\\\\` after markdown escaping (4x). A control character becomes `\u0001` and then 7 characters. A zero-width or tag character becomes `\u{XXXX}` and then about 9 characters. So 1500 adversarial characters expand to about 13,500 characters, or about 54 chunks of 250. That breaks both Discord's 25-field limit and its 6000-character embed limit. Either the card fails to post, or something must be cut. A cut card is exactly the exfiltration channel the full-body rule exists to close. Precedent: generation prompts are bounded at 400 characters and refuse `\p{Cc}` (tools/plugins/media/prompt.ts:46, media/index.ts:44). |
| G1CW-02 | High | spec §3.5 precheck step 5 (`q(path)`), write.ts:14 (CHANGE_MAX 120), approval.ts:66 (VALUE_MAX 120), :60 (TARGET_KEYS includes `name`) | **The destination and the name can be cut.** `list_path` may be up to 300 characters, but both `q()` and the card's `val()` cut at 120. So the approver may not see which project a cross-project write goes into. `clickup_create_task.name` (up to 200) is the card's Target and is also cut at 120. That gives about 80 hidden characters per write. A "truncated" note would appear, but the write could still be approved. |
| G1CW-03 | High | spec §3.1; core/env.ts:163 today | **Choosing the mode fails open.** Today, a token with no list id means ClickUp is disabled (clickup.test.ts:115). After this change, the same env means workspace mode: every project the token owner can see, with writes. Clearing one value, by accident on the dashboard env page or with a blank value that `blankToUndef` turns into nothing, would widen privilege from one list to the whole workspace. Removing a setting must never widen access. |
| G1CW-04 | Medium | write.ts:164 (`updateStatus` error lists the vendor's status names); write tools are not `untrustedOutput` | **Vendor text can reach the model without tainting the run.** In workspace mode, anyone who can create or edit a list in any space controls the status names. Those names come back in a write tool's error text without tainting the run. Other tools in the same run that skip approval when the run is direct and untainted could then act on injected text. |
| G1CW-05 | Medium | core/logger.ts:17-31 (TEXT_PATTERNS, including `token=` and `key=`); approval.ts:96 (`sanitize` on the card) | **The card can show different text from what gets written.** If redaction rewrites part of a body (for example `key=...`), the card shows `[REDACTED]` while ClickUp receives the original, and `cut` stays false. |
| G1CW-06 | Medium | spec §3.2 "a miss refreshes once then decides" | **Probes can be amplified.** Every probe with an out-of-scope id costs a GET /task plus a forced GET /team/{T}/space. A probing model (prompt-injected or confused) can drain the shared bucket of 80 per minute and starve the poller. |
| G1CW-07 | Medium | spec §3.4 search in list mode; §3.5 "all writes gain optional pinned in_list_id/list_path" | **List mode is not unchanged byte for byte.** In list mode, search calls `/team/{T}/task`, but list mode never resolves T. List-mode write schemas would also gain new model-settable fields. The spec's own promise that list mode stays byte for byte the same requires schemas and tool sets that depend on the mode. |
| G1CW-08 | Medium | spec §3.4 search; §3.7 poller | **Server-side filters are trusted.** `list_ids[]`, `space_ids[]` and similar are sent to ClickUp, but the results are not filtered again on our side. A misspelled parameter or a vendor change would quietly return tasks from the whole workspace, or tasks from lists the poller does not watch, into notices. |
| G1CW-09 | Low | spec §Contracts (take) | The calendar day and timezone of the daily cap are not specified, and neither is whether the cap applies in list mode. |
| G1CW-10 | Low | spec §3.5 precheck step 4; registry.ts:110-118 | The pin is compared in precheck, but the spec does not say that `run()` compares the task's current `list.id` with `in_list_id` again after its own scope check. That leaves a small window between check and use. |
| G1CW-11 | Low | admin/keys.ts:8-10; admin/ops.ts:38 (`clickup_channel` op exists) | The spec calls HANDLER_KEYS "not model-reachable". In fact `admin_op_propose` can write handler keys through an op. Nothing in the spec stops someone from later adding a `clickup_watch` or `writes_per_day` op. |
| G1CW-12 | Info | spec §3.4 list_members | `clickup_list_members` renders member emails (index.ts:103). In workspace mode that covers every list, and the output reaches any room where a ClickUp-enabled persona answers. It is needed for `assign` by email, so it is accepted as a residual (R2). |

Checked and passing at the spec level:
- Scope check: space ∈ S(T) and team_id is either absent or equal to T. The uniform E_SCOPE_* refusals return the same text for 404, 403 and out of scope.
- Team resolution never picks the first team. Failure is not cached.
- Ids are checked against a regex and encoded with `pathId`. Statuses and members come from the task's own list.
- Approval is ORed into the central check (registry.ts:124). The pin is merged into the stored, digested input. Approved replays re-run precheck. Batch approve-all goes through `runApproved` and `exec`, so E_MOVED, scope and the daily cap apply to each item.
- The run cap counts only on the request path. Delete is unregistered.
- The daily cap is checked just before the HTTP call, takes a row lock, fails closed and gives nothing back.
- Responses are capped at 4 MiB with a 15 s timeout, and redirects are refused (services/http.ts:29, :37-42).
- The token stays in `secretsOf` (app.ts:223). Notices are escaped and capped by code (poller.ts:47). Errors use fixed text.

## Binding conditions

Each condition names the test file that must prove it. The file is new where marked.

1. **C1 (G1CW-01) A card is never cut and never too large.** For `clickup_create_task`, `clickup_update_task` and `clickup_add_comment` in workspace mode:
   - (a) The schema refuses control characters other than `\n` and `\t`, and refuses `HIDDEN` code points (approval.ts:73), with fixed error text.
   - (b) Before any card exists, precheck or a refine computes the rendered card size using the same `toolCallView` and `toolApprovalPayload` code. It refuses with fixed text unless the result has `cut === false`, at most 25 fields, every field at most 1024 characters, and at most 6000 characters in total.
   - (c) The Body is chunked like `query`/`prompt`, and in `compactItem` a Body with more than one chunk counts like `queryChunks.length > 1` (the item falls back to a solo card).
   - Tests: new discord/embeds/approval-body.test.ts. For each alphabet (`\`, `"`, `\n`, U+200B, tag characters, `@`, `<`, emoji, Thai), a 1500-character body is either refused before a card exists or rendered with `cut === false` within all limits. A 1501-character body is refused by zod. A long body never joins a batch (extend discord/embeds/approval-batch.test.ts). Also tools/plugins/clickup/write.test.ts: a refused body files no approval.
2. **C2 (G1CW-02) The destination and the name are shown whole.**
   - `list_path` is built deterministically: each segment is capped (for example at 34 characters plus an ellipsis), and the whole path is at most 110 characters. Precheck and the E_MOVED comparison use the same builder.
   - In workspace mode, `clickup_create_task.name` and `clickup_update_task.name` are at most 110 characters, or are rendered as a full field.
   - The precheck summary must not use the 120-character `q()` cut for the path.
   - Tests: discord/embeds/approval-body.test.ts asserts that a 3-level path of 100 characters per segment, and a maximum-length name, render with `cut === false` on both the solo card and the batch item. tools/plugins/clickup/write.test.ts asserts that renaming a segment beyond the cap still gives E_MOVED.
3. **C3 (G1CW-03) Workspace mode needs a positive opt-in.**
   - Workspace mode starts only when `CLICKUP_LIST_ID` is absent **and** `CLICKUP_TEAM_ID` is set. A token alone stays disabled, with today's text 'CLICKUP_API_TOKEN / CLICKUP_LIST_ID not set' or a successor that names both options.
   - At startup, workspace mode writes one audit row `clickup.mode` with outcome `workspace` (no ids) and one #bot-log notice.
   - Team resolution then only checks that T is among the teams GET /team returns (`mismatch` otherwise). The "exactly 1 team" auto-pick is dropped.
   - Update OQ-1 to match: the owner sets CLICKUP_TEAM_ID and clears CLICKUP_LIST_ID.
   - Tests: core/env.test.ts (mode matrix: token only = disabled; token and list = list; token, team and no list = workspace; a bad team id throws naming the key and not the value). tools/plugins/clickup/clickup.test.ts (a team id not returned gives E_TEAM, and no call reaches /team/{T}).
4. **C4 (G1CW-04) No vendor text in untainted write results.**
   - In workspace mode, `clickup_update_status` precheck checks the status against the task's own list before the card and refuses with fixed text that does not name any status (for example "ClickUp: that status does not exist in the task's list (see clickup_get_task_detail)").
   - Valid status names are shown only by a read tool with `untrustedOutput`, for example as a line in `clickup_get_task_detail`.
   - No write tool result, refusal or error contains any string ClickUp returned except ids that pass `CLICKUP_ID`.
   - Tests: tools/plugins/clickup/write.test.ts. Status names that try an injection never appear in any write result or refusal, and a refused status files no approval.
5. **C5 (G1CW-05) No redaction difference on body cards.** For the full-body tools, if `sanitize`/`redactText` would change any input string, precheck refuses with fixed text. Test: tools/plugins/clickup/write.test.ts (a body containing `key=abc` is refused before a card exists).
6. **C6 (G1CW-06) Limit forced refreshes.** A miss refreshes S(T) at most once per 60 s across the process. Inside that window a miss is decided on the cached set, so it is refused. Test: tools/plugins/clickup/clickup.test.ts (20 out-of-scope probes cause at most 1 space refresh in 60 s).
7. **C7 (G1CW-07) List mode really is unchanged.**
   - In list mode, write `inputSchema`s, tool descriptions and the registered tool set stay identical to today (the snapshots in tools/plugins/index.test.ts stay unchanged). `list_id`, `in_list_id` and `list_path` exist only in workspace mode.
   - In list mode, `clickup_search_tasks` either uses `GET /list/{listId}/task`, or is not registered in list mode. It must never call `/team/...` without a resolved T.
   - Tests: tools/plugins/clickup/clickup.test.ts and write.test.ts (list-mode schemas reject `in_list_id`; search in list mode makes no request to `/team`). tools/plugins/index.test.ts snapshots.
8. **C8 (G1CW-08) Filter results again on our side.** Every task returned by `/team/{T}/task` is kept only if its `space.id` ∈ S(T). If the model or the poller supplied `list_id`, `space_id` or `list_ids`, the task must also match that filter. List mode keeps only tasks with `list.id === listId`. Tests: tools/plugins/clickup/clickup.test.ts (a fake returns tasks from a foreign space and an unrequested list, and none are shown). tools/plugins/clickup/poller.test.ts (a task from an unwatched list produces no notice).
9. **C9 (G1CW-09) Daily cap semantics.** `day` is the calendar date in the company timezone that the scheduler already uses, computed by the app, not by `CURRENT_DATE`. The spec states whether the cap applies in list mode. If it applies only in workspace mode, the spec must say so. Tests: new db/repos/clickup-write-usage.int.test.ts (10 parallel takes with cap 2 succeed exactly 2 times; cap 0 refuses; the count survives a new repo instance; the date rolls over at local midnight). db/migrate.int.test.ts (034 up and down).
10. **C10 (G1CW-10) Re-bind at use.** `run()` (including the approved replay) checks again that the task's current `list.id` equals `in_list_id`. For create, it checks that `list_id` equals `in_list_id`. This comes after its own scope check and before `take()`. The status and member lookups use that list id. Test: tools/plugins/clickup/write.test.ts (the task moves between precheck and run, giving E_MOVED, no write and no counter taken).
11. **C11 (G1CW-11) No model path to the new keys.** No `AdminOp` (admin/ops.ts) writes `clickup.writesPerDay` or `clickup.pollListIds`. `config_propose` refuses both. `clickup.writesPerDay` changes only through `/settings` by a person (risk ⚠ when raised). `pollListIds` changes only through `/clickup watch`, which is gated like `/clickup channel` and runs `listInScope` with a cap of 10. Tests: new admin/keys.clickup.test.ts (both keys in HANDLER_KEYS, not in ADMIN_CONFIG_KEYS). admin/ops.test.ts (no op schema accepts them). discord/commands/clickup.test.ts (watch refuses a list from another workspace and an 11th list, and writes an audit row). discord/commands/settings.test.ts (raising the cap is flagged as a risk).
12. **C12 Spec tests (a) to (o) stay as written**, adjusted for C1 to C11. Test (m) also checks that T and every space id from S(T) appear in no error, audit outcome or log line (tools/plugins/clickup/clickup.test.ts, extending :123).

## Non-binding recommendations
- **The strongest real boundary sits in ClickUp, not in our code.** Make CLICKUP_API_TOKEN belong to a dedicated ClickUp member or guest whose access is limited to the spaces the bots should see. Our scope check cannot hide a private HR or finance list that the token owner can see.
- Before the first workspace write, log once to #bot-log the number of spaces in S(T), so the owner sees what got exposed.
- Consider a per-department space allowlist later (rejected as OQ-5 for now, see R1).

## Residual risks for the owner (plain words)
- **R1. Every project can be read in Discord.** Any bot with ClickUp tools (software, it, ops, hr, marketing, Praw) can read every project the token can see, private ones included. It can then repeat names, descriptions and comments in Discord rooms where some readers have no ClickUp access to that project. Approval is not needed for reading. The owner accepts this, or limits the token in ClickUp.
- **R2. Member emails are visible.** `clickup_list_members` shows the emails of members of any list, so emails reach Discord rooms.
- **R3. A tricked bot can copy one project into another.** A bot misled by text in a task can try to copy content from project A into project B. Each write shows a card with the full text and the destination. Approve only what you have read. The limits are 5 requests per run and 50 writes per day (your setting). Deleting is impossible in workspace mode. The approval card also shows that text to everyone who can read the approvals room.
- **R4. Skills and tool changes widen access.** An approved skill or a `bot_tools` change can give ClickUp tools, including writes, to any persona. ClickUp tools are not in the "sensitive" list, by design, so that writes can be batched. Reads granted this way cover the whole workspace.
- **R5. The rate limit is shared.** The bots' limit of 80 requests per minute is shared with anything else that uses the same ClickUp token (ClickUp allows about 100 per minute per token). Heavy use elsewhere can make bot calls fail with "too many requests".
- **R6. Watched-list notices reach the notice channel.** Task names and comments from every watched list (up to 10) are posted in the ClickUp notice channel, which its readers can see.

## Missing context
- Project rules: `/Users/pakawat.tan/Desktop/Labworkspace/BOT/Assistant/.claude/rules/` does not exist. Team rules at `/Users/pakawat.tan/.claude/team/rules/{_global,labworkspace}/security.md` were used.

## Owner sign-off (2026-11-09, recorded by controller from the owner's answer in chat)
The owner ACCEPTS residuals R1–R6.
