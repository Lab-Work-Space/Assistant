---
gate: 2
task: CLICKUP-ALL-1
status: APPROVED
date: 2026-11-09
---

# Security Gate 2: CLICKUP-ALL-1 (ClickUp workspace scope, read and write across all projects)

- Gate: 2 (code audit of the uncommitted implementation)
- Gate 1: docs/security/2026-11-08-gate1-clickup-workspace.md (C1-C12; the owner accepted R1-R6 on 2026-11-09)
- Spec: docs/superpowers/specs/2026-11-08-clickup-workspace-design.md (+ Amendments)
- Constraints kept: nothing committed, no `npm run build`, no live DB (the integration tests ran on 127.0.0.1:54329/assistant_test), no real ClickUp or Discord, `~/.config/assistant` not read.
- Note: the live app runs from `dist/`. The fix below takes effect only after the next build.

## Verdict: APPROVED (after the fix made in this audit)

One High finding came up: the approval card could mask text that the write sends (G2CW-01, which breaks C5). I fixed it in this audit with an isolated change in one file and added a regression test. The remaining findings are Low or Info and do not block.

## Findings

| ID | Severity | Where (content anchor) | Finding | Status |
| :--- | :--- | :--- | :--- | :--- |
| G2CW-01 | High | discord/embeds/approval.ts `toolCallView` chunk loop (`const queryChunks = chunks.map((c) => escapeCardText(c, QUERY_CHUNK, secrets))`); tools/plugins/clickup/workspace-write.ts precheck (`JSON.stringify(sanitize(i, secrets)) !== JSON.stringify(i)`) | **C5 bypass: the card masks text that the write sends.** The C5 precheck runs `sanitize` on the whole raw text, but the card runs `redactText` again on each 250-unit chunk. Several patterns are anchored on `^` or `\b`: `key=`/`token=` with `(^\|[?&;,\s"'])`, `\b(Set-Cookie\|Cookie):[^\r\n]*`, `\bBot\s+`, `\bgh[pousr]_` and others. A chunk boundary can therefore start a match that the whole text does not have. Probe: `'x'.repeat(249) + 'Cookie: <secret data>'`. `sanitize` leaves it unchanged, so precheck passes. `cardShowsWhole` returned true. Body (cont.) showed `Cookie: \[REDACTED\]`, and `[^\r\n]*` masks the rest of the chunk, because the JSON-quoted body has no raw newline. So about 240 characters per chunk are hidden from the approver, and close to the whole 1500-character body across 6 chunks. ClickUp receives the original text. This is the exfiltration channel that C1 and C5 exist to close. **JSON layer:** JSON quoting turns `\n` / `\t` into `\` plus a letter, and the letter can extend a 23-character run to the 24 that the discord-token rule needs (`(?<![\w-])[\w-]{24,}\.[\w-]{6}\.[\w-]{27,}`). Probe: `'hi\n' + 'b'*23 + '.' + 'c'*6 + '.' + 'd'*27`. `sanitize` leaves it unchanged and the card shows `[REDACTED]`, on the solo Body and also on the one-line batch item for `name` / `status` / persons. The pattern repeats about 24 times in 1500 characters. A second, smaller gap: the pins (`list_path`, `in_task`) are merged after the C5 check, so a vendor list named like a credential (`token=...`) appeared masked on the card. | **Fixed in this audit** (see below) |
| G2CW-02 | Low | tools/plugins/clickup/poller.ts `comments()` -> client `listComments` -> `getTask` -> `taskInScope` | **The workspace poller can starve the shared bucket at the minimum interval.** In workspace mode each comment check costs 2 requests (a scoped GET /task plus GET comments). One tick can cost up to 5 task pages plus 20 x 2 = about 45 requests. At `clickup.pollIntervalSec` = 30 (schema minimum, an ADMIN_CONFIG key) that is about 90 per minute, above the 80-per-minute bucket. Tool calls then get E_BUSY. The default of 120 s gives about 23 per minute, which is fine. Gate 1 / spec estimated about 25 per tick. | Recommendation: backend could raise the workspace floor for pollIntervalSec to 60 s, or use the poller's own scoped task (already re-filtered by S(T) in `teamTaskPages`) and skip the second GET /task for comment checks. Non-blocking (owner accepted R5). |
| G2CW-03 | Info | tools/plugins/clickup/index.ts workspace `clickup_get_task_detail` (`` `Url: ${t.url ?? ''}` ``) | The ClickUp url of a task with a custom id has the form `/t/<team_id>/<custom_id>`, so T can reach the model inside untrusted read output. C12(m) covers errors, audit rows and logs, not vendor read output. T is not a credential. | Accepted as is. A later change could rebuild the url as `https://app.clickup.com/t/<id>` from a CLICKUP_ID-checked id. |
| G2CW-04 | Info | workspace-write.ts `clean` / approval.ts `escapeCardText` | U+2028 and U+2029 are not `\p{Cc}` and not in HIDDEN, so the body schema accepts them. The card shows them as spaces, while ClickUp receives a line separator. This is not hidden content (no characters are dropped). | Accepted. A later change could add `  ` to the body `clean` refusal. |

### Fix made in this audit (G2CW-01)

File: discord/embeds/approval.ts, one file, isolated. Only `cardShowsWhole` reads the new flag, so solo, batch, web-grant and media cards render exactly as before.
- `ToolView` gains `masked: boolean`.
- `toolCallView` checks redaction parity at every transform the card applies:
  - Raw values and pins: `let masked = JSON.stringify(raw) !== JSON.stringify(a.toolInput ?? {});`, where `raw` is the sanitized stored input.
  - JSON-quoted Body and each chunk: `masked ||= redactText(JSON.stringify(query)) !== JSON.stringify(query) || chunks.some((c) => redactText(c) !== c)`.
  - One-line (batch) values: in `val`, when `oneLine`, `masked ||= redactText(JSON.stringify(v)) !== JSON.stringify(v)`.
- `cardShowsWhole`: `if (v0.cut || v0.masked || toolCallView(a, secrets, true).masked) return false;`. Precheck then refuses with WE.TOO_LONG before any card exists, so a call whose batch item would mask text never gets a card at all. `compactItem` is unchanged. The only caller of `cardShowsWhole` is the workspace-write precheck (checked with `grep -rn --include='*.ts'`).
- Regression tests added to discord/embeds/approval-body.test.ts (`G2CW-01 (C5) ...`):
  - chunk-boundary probes: Cookie:, key= and Bot
  - JSON-layer probes (`\n` and `\t`) on the Body, a create `name` and a `status`
  - a plain control case that still passes
  - a credential-shaped pinned `list_path`
- Re-scan after the final edit:
  - `tsc --noEmit`: exit 0.
  - Full `--project unit`: 303 files, 3933 passed, 2 skipped.
  - Targeted integration tests: 9 files, 104 tests, all passed. The files: clickup-write-usage, clickup-workspace, poller.int, poller.workspace.int, migrate, praw-m3, questions, approval-batch, approval-batch-app.

## Condition-by-condition verification

| C | Verdict | Evidence (content anchors) |
| :--- | :--- | :--- |
| C1 (a) refuse controls and HIDDEN | PASS | workspace-write.ts `clean` (`\p{Cc}` except `\n` `\t`, plus `HIDDEN` non-global) on name, description, text, status and persons. approval-body.test.ts alphabets; workspace-write.test.ts "control characters ... refused". |
| C1 (b) the rendered card is checked before it exists | PASS (after G2CW-01) | precheck `cardShowsWhole(syntheticCard(toolName, { ...i, ...pin }), secrets)`. The synthetic card uses a 300-character all-escaping reason and 64-character ids, which covers the central `approvalFor` reason (`slice(0, REASON_MAX)`, escaped up to 2x). The test "C1b the whole-card check is worst case" passes. |
| C1 (c) Body chunked; multi-chunk Body never batched | PASS | `bodyKey` / `queryLabel: 'Body'`. `compactItem` refuses when `v.queryChunks.length > 1`. Test "C1c Body in batches". |
| C2 path and name shown whole | PASS | `listPathText`: segments cut at 30 units, total at most 108, plus `h6` over the full names and ids. E_MOVED compares that exact text. Names at most 110 (`NAME_MAX`). The current name of an existing task is shown through `taskLabelText` (whole up to 100, else 88 + hash). Deviation accepted: C2 bounds the name the write sets, and the `in_task` pin binds the old name through the hash. The precheck summary uses the path whole (no `q()`). |
| C3 positive opt-in | PASS | core/env.ts: `CLICKUP_API_TOKEN && CLICKUP_LIST_ID` -> list; `CLICKUP_API_TOKEN && CLICKUP_TEAM_ID` -> workspace; a token alone -> no `clickup`. client `resolveTeam` checks `find((t) => t.id === wsTeam)`, with no auto-pick and failures retried at most once a minute. app.ts boot: audit row `clickup.mode` / `workspace` (no ids), one #bot-log alert, and an unresolved team writes `reason` only. E_TEAM text names the key, never the value (deviation accepted). |
| C4 no vendor text in write results | PASS | precheck `E.STATUS` before the card. Client `updateStatus` returns E.STATUS when it refuses at the write. Results are fixed text (`Updated the status of task ${i.task_id}.`), and the id is regex-checked. The member-match errors are fixed text. Statuses are shown only in `clickup_get_task_detail` (untrustedOutput). |
| C5 refuse when redaction would differ | PASS (after G2CW-01) | precheck `sanitize` comparison, plus the card-side `masked` check (chunk boundaries, pins). |
| C6 at most 1 forced S(T) refresh per 60 s | PASS | `inSpaces` (`now() - spacesAt >= REFRESH_MIN_MS`). Test "20 probes ... at most 1 space request". |
| C7 list mode unchanged | PASS | `clickupWriteTools` branches on `cu.mode`, and the list-mode schemas have no pin fields. Search is not registered in list mode (allowed by C7), and client `searchTasks` gives `wsOnly()` in list mode. tools/plugins/index.test.ts has no diff. The list-mode limiter is not added (deviation accepted, behaviour as today). |
| C8 re-filter on our side | PASS | `teamTaskPages` keeps a task only when `space.id` is in S(T), `team_id` is absent or equal to T, and `keep` holds (search: list, space, name; poller: `want.has(x.list.id)`). Tasks with no space field are dropped. List mode keeps tasks with no list field (deviation accepted: the endpoint is the list's own). |
| C9 daily cap semantics | PASS | `guardFor.beforeWrite`: `localDay(clock, schedule.timezone).date`. `ClickUpWriteUsage.take` is one upsert with the `used < $2` guard, and cap <= 0 is refused. A DB error gives E_COUNTER (fail closed). It runs after the C10 re-check, right before `send`. The cap applies in workspace mode only (the spec says so). Int test: exactly 2 of 10 parallel takes succeed; local midnight rollover. |
| C10 re-bind at use | PASS | client `wsTask` (`list.id !== w.listId` -> E.MOVED) and `createTask` (`l.id !== w.listId`), both before `w.beforeWrite()`. A missing pin gives `listId ''`, so E_MOVED (fail closed). Test "the task moves AFTER the replay's precheck" passes. |
| C11 no model path to the new keys | PASS | admin/keys.ts HANDLER_KEYS has both keys. admin/ops.ts has only `clickup_channel` for ClickUp. `/settings` for writesPerDay goes through `planClickupWritesPerDay` (`risk: n > old`), and pollListIds is refused there. `/clickup watch` is behind `decide()` (Bot Admin in #setting), uses `listInScope`, a cap of 10 and an audit row, and `forgetBaseline` on remove. |
| C12 tests (a)-(o) | PASS | Present in workspace.test.ts, workspace-write.test.ts, poller.workspace*.test.ts, approval-body.test.ts, keys.clickup.test.ts, clickup-write-usage.int.test.ts and clickup-workspace.int.test.ts. (m) plants the token, T and space ids and checks results, audit rows and errors. |

## Audit of the requested holes

- **IDOR / a token that sees other workspaces**: `listInScope` checks `l.id === id` and the space against S(T). `taskInScope` checks space and `team_id`. Reads and writes give the same refusal for 404, 403 and out of scope. `describeTask` also scope-checks the task's own list. S(T) comes only from `/team/{T}/space` after T is confirmed against GET /team. PASS.
- **Team opt-in fails closed**: PASS (C3). A blank value goes through `blankToUndef`, so it is absent, so ClickUp is off, never widened.
- **Pin and digest binding, and E_MOVED including the run() re-check**: the registry merges `pre.pin` and re-parses it before `approvals.request`, so the digest covers the pin. Replays run precheck again (`approved` only skips the approval question). A forged pin gives E_MOVED before any card. PASS.
- **Worst-case card size**: checked by `cardShowsWhole` with the worst-case reason and ids. Values are capped before escaping, so markdown-heavy vendor names grow the field but are not flagged as cut (no DoS). PASS.
- **Refusal when redaction changes text**: was FAIL (G2CW-01, at the chunk, JSON-quoted and one-line layers), now fixed.
- **Vendor text in write results**: PASS (C4). Precheck refusals pass only `ClickUpError.message`, which is fixed text (the HttpError detail is a code word: timeout, network, http, too_large, parse).
- **Caps, timezone, concurrency**: tool calls in one model turn run in sequence (agents/loop.ts `for (const u of uses) ... await registry.run`), so the run cap cannot be raced. The daily cap is held under the row lock. PASS.
- **Rate limiter and 429**: one bucket per client, waits at most 5 s, a 429 pauses 60 s, shared by tools and the poller. Workspace mode only. PASS (see G2CW-02 for the budget at a 30 s interval).
- **Poller filtering**: watched lists are read every tick, and an empty list makes no request. Results are re-filtered by S(T) and the watched set. A new list is baselined silently. Notices are escaped and capped by code, with no model. PASS.
- **Logs and PII**: the client never logs. app.ts logs a reason code only. The poller logs task ids only. `teamMembers` emails stay in memory for exact matching only. The search and list lines show usernames, not emails. `inbound_address`, custom fields and creator emails are never rendered. The token is in `secretsOf`. List ids appear in the `clickup.watch` audit row (allowed: C12 covers T and space ids). `clickup_list_members` shows emails (R2, accepted). PASS.
- **HANDLER_KEYS / AdminOp reachability**: PASS (C11).
- **List-mode regression**: list-mode schemas, tool set and requests are unchanged. One tightening: `listOpenTasks` now drops tasks that name another list. PASS.

## Rulings on the declared deviations

All accepted:
- Extra `in_task` pin (hash over 100 units).
- Body shown only when the stored input carries `in_list_id`. Precheck always sets the pin, and list mode keeps today's cut rendering with its Note.
- Path segments cut at 30 units plus a 6-character hash.
- Limiter in workspace mode only.
- Search not registered in list mode.
- An empty watch list gives a tick with no request.
- E_TEAM text (names the key, not the value).
- C8 list mode keeps tasks with no list field.
- Run cap checked in precheck against `ctx.run`. The request path files sequentially; replays run in their own run.
- No one-time S(T) count notice (it was a non-binding recommendation).

## Residual risks (owner)

R1-R6 from Gate 1 stand, as accepted on 2026-11-09. Nothing new.

## Missing context

- `/Users/pakawat.tan/Desktop/Labworkspace/BOT/Assistant/.claude/rules/` does not exist. I used the team rules (`_global/security.md`, `labworkspace/security.md`).
- During the audit another agent was writing tools/plugins/clickup/acceptance.workspace.test.ts. `tsc` briefly reported an error in it (TS18047), and that error was gone on the final run. The file is not part of this audit's md5 list.

## md5 of the audited tree (taken at the end of the review)

```
6009b66c6c102f7b14da3f61f6a41e33 db/migrations/034_clickup_write_usage.up.sql
92102307a21c45a11af53fd3b1aadc3b db/migrations/034_clickup_write_usage.down.sql
b0db92ec18f8be93745596e8b11a77b7 db/repos/clickup-write-usage.ts
8407cc502d881b22c617f699160c721f db/repos/praw.ts
d7633d814d79258f5338cc2a84f26d05 db/repos/index.ts
db43f6e62ad00daf75fa4e9d3852afd1 core/env.ts
25d8f6ee5ebfaa1b1d12212c66391dd4 dashboard/envfile.ts
099779fcd0f70463221e46ed359f5571 .env.example
c8f73161e06987ce3ce31960d2ac132d tools/plugins/clickup/client.ts
407f6c17d91d9695529fe0be3d4f80c9 tools/plugins/clickup/index.ts
fb1c42ae214eeef15d5e19f773c7703b tools/plugins/clickup/write.ts
a2abf1a1cb217e33c122b284b63ee54f tools/plugins/clickup/workspace-write.ts
82ce22b02865ce88c8f2d8dfe2edb1ce tools/plugins/clickup/poller.ts
e2540794e7705e583993d03f851167d8 tools/plugins/deps.ts
8a0afc0b614af82dd6890e338f8ea467 discord/embeds/approval.ts
09278b6a8e23b82c82e3176b3056cfd5 discord/commands/plans.ts
ef40563624a35a4ef685534277b00a9f discord/commands/clickup.ts
6d9b99fbd211add9b28793ed3067322f discord/commands/index.ts
75f3199b43bb87777756d7917c98b881 discord/commands/definitions.ts
96bea1a5ceccf62dcfbada97e86aca27 discord/commands/settings.ts
366da5338c91a610c224b8cb10c997ed discord/commands/types.ts
647ab067f7064e37b1872cc8ac7676fb config/schema.ts
d5f619c92f004dec598d72390fd63ba4 config/defaults.ts
209b50a40db74a068cae90c17e325ce2 admin/keys.ts
be82f59a7ad38cc3339772b5cdba4357 admin/ops.ts
884246046cd1e6db4c2d9d6cc1111160 app.ts
6e4a7ad69f26590911df370925e53cfa tools/registry.ts
a8654980b62b1751a13ccde3b120d907 tools/policy-approval.ts
9b518cd3a4eff06ca2cca0402ec8f257 core/logger.ts
3cd8ec616dc62eafbf04e49b56821fc0 discord/embeds/approval-body.test.ts
0e744f9f06cde28122add7f91a945b7b tools/plugins/clickup/workspace.test.ts
a8fb7cffc13dcc367de5771eccdab3a9 tools/plugins/clickup/workspace-write.test.ts
e2de0eeeadb02d53bc40e8ace75ee9c7 tools/plugins/clickup/poller.workspace.test.ts
5aef532235041b523432c9bbedad7821 tools/plugins/clickup/poller.workspace.int.test.ts
06a5ccd3b0fe4192db4c8053121fb582 admin/keys.clickup.test.ts
452a6a693f5e10cd790e9ee5d6fca3af db/repos/clickup-write-usage.int.test.ts
5b1f543c788416a3e393cb279f2c06ec tests/integration/clickup-workspace.int.test.ts
```
