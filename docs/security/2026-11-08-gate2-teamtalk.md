---
title: "Gate 2 — TEAMTALK-1 visible handoffs and team-room work boards (+ G2W-07)"
task_id: TEAMTALK-1
gate: 2
status: APPROVED
gate1: docs/security/2026-11-08-gate1-teamtalk.md
spec: docs/superpowers/specs/2026-11-08-teamtalk-design.md
migration: 028_teamtalk
last_updated: 2026-11-08
---

# Gate 2 — TEAMTALK-1 (code audit)

**Verdict: APPROVED.** Every Gate 1 condition (T1 to T14) is met in code and pinned by a test. F-1 is closed. One Medium defang gap (G2TT-01) was found during this audit and fixed in place: one function in `company/handles.ts`, with regression samples added. Two Low findings and one Info stay open. None of them blocks the release. G2W-07 is resolved.

Evidence method:
- static review of the scoped files;
- random fuzz of `defangHandles` against `handlesIn` and `toMentions`: single strings, joined fields and every prefix cut;
- a joined-field probe through the real port → `toIncoming` → `route` pipeline (`tests/fakes/roundtrip.ts`);
- `npx tsc --noEmit -p .`: clean, before and after the fix;
- the full unit suite after the final fix: 260 files, 3306 passed, 2 skipped. This includes a parallel `discord/teamtalk.adversarial.test.ts` (55 passed). One earlier full run had one transient failure while that file was being written; the re-run and the targeted re-runs are green;
- integration on the local test database (`127.0.0.1:54329/assistant_test`, not the live DB): `db/migrate.int.test.ts`, `db/executor-role.int.test.ts`, `db/repos/room-entries.int.test.ts`, `db/repos/board.int.test.ts`, `governance/approvals.int.test.ts`, `tests/integration/approval-batch.int.test.ts`: 151 passed.

No scanners apply: no dependency, image or native change.

## 1. Gate 1 conditions

| T | Result | Code evidence | Test |
| :--- | :--- | :--- | :--- |
| T1 | PASS (after G2TT-01 fix) | `defangHandles` (handles.ts). Port `outbound`: `p.noHandles \|\| p.origin === 'governance'` → `defangHandles(neutralise(t))`, no `toMentions`. `compose` → `defangMessage` re-defangs the BUILT message, after cut and split, and throws when `handlesIn(text).length \|\| /<@/` | handles.test.ts, port.mentions.test.ts, inbound.handles.test.ts, router.test.ts:395, teamtalk.test.ts:283 (spec c) and :295 (holds without TeamTalk) |
| T2 | PASS | governance `task` card goes through the same defang + `defangMessage` on `ensureThread` and `refreshCard` (`upsertTaskCard` → `compose`) | port.mentions.test.ts:160, teamtalk.test.ts:244 |
| T3 | PASS | H1 and H3 `this.post(parent.owner, …)`. Room line and board: `{kind:'persona', personaId: task.owner.personaId}` in `directChannelId`. `answer:false` on all of them. Router reply routing is human-only (router.ts:145) | teamtalk.test.ts:93, :144, :160, :397, :599 |
| T4 | PASS | `upsertRoomBoard` uses `webhooks.send/edit` only. Pin through `where.channel` resolved by `clientOf(persona.deptId)`. No new webhook | port.teamtalk.test.ts:164, :222 |
| T5 | PASS | `post()` records each split chunk through `onSent` plus the returned id. `upsertHandoff` passes `onSent` into `upsertStored` (10008 repost). Board: `prov.record(id, room, true, null, false)` on every send, repost included. H1/H3 `userId: ownUserOf({task: parent})`. Room line `ownUserOf({task})` | teamtalk.test.ts:119, :133, :550; port.teamtalk.test.ts:127, :192 |
| T6 | PASS | `noteFinal` → `tt.finalReport(task, posted, outcome.payload.body, outcome.tainted ?? true)`, in process, redacted, 1500 characters. `reportEnded` waits on `locks.run(task.id)`, then ORs `child.tainted \|\| final.tainted` into the parent before `rollupJob`. Never reads Discord | teamtalk.test.ts:267, :309, :348, :361 |
| T7 | PASS | `serial('handoff:<id>')`. `editOnly` with no stored id → `null`. 10008 → one repost. `editBot` and `webhooks.edit` now send `content` with `allowedMentions:{parse:[]}`. The edit payload comes from `compose` (redact + neutralise + defang) | port.teamtalk.test.ts:96, :115, :139; teamtalk.test.ts:171 |
| T8 | PASS | `roomBoardKey` = `room:` + 32 hex of sha256. `disabledBoards` after a failed `store.set`. One timer per room, `BOARD_INTERVAL_MS` 60 s | port.teamtalk.test.ts:179, :203; teamtalk.test.ts:526 |
| T9 | PASS | `assembleContext`: room entries enter whole or are dropped (`need > budget → continue`, prefix counted). Each entry is wrapped by `wrapUntrusted`. `report.roomTainted` → `run.markTainted()` (loop.ts:233). Entry taint: assigned = `child.tainted`; ended = fresh row OR final; notes = `ctx.tainted()` read in the tool, OR `task.tainted` | assemble.test.ts:152, teamtalk.test.ts:456, :464 |
| T10 | PASS (see G2TT-02) | `lineNow`: `redactText(text, secrets).slice(0, 300)` before `rooms.add`. Port redacts again on send | teamtalk.test.ts:448 |
| T11 | PASS | `postHandoff`, `lineNow`, `runBoard` and H3 (`!(tt && halted)`) check halt first. Incidents carry `{stage, channelId, code}`, never the body | teamtalk.test.ts:205, :386, :502, :570 |
| T12 | PASS | `INSERT … SELECT … WHERE (SELECT count(*) …) < $8` under the per-task `KeyedLock`. Ideas/decisions only for a persona owner (fixed tool text). `dueOk` checks a real calendar date, today to +365, with `ctx.today` from `schedule.timezone` (loop.ts:437), and returns a fixed refusal | createTask.test.ts:99, teamtalk.test.ts:464, :491 |
| T13 | PASS (owner step pending) | `PIN_CODES` → one warning per room, board unpinned. Manage Messages is still forbidden | permissions.test.ts:93, teamtalk.test.ts:577, port.teamtalk.test.ts:213 |
| T14 | PASS | 028 is additive with CHECKs and `tainted DEFAULT true`. Down drops cleanly. `room_entries` is not in `EXECUTOR_TABLE_GRANTS` | migrate.int.test.ts:227, executor-role.int.test.ts:102 (both run, green) |

The re-run assertions named in Gate 1 are green: scheduler, workstyle, conversation, warroom and approval-batch integration.

## 2. Findings

| ID | Severity | Evidence | Description | Remediation | Owner | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| G2TT-01 | Medium | company/handles.ts `defangHandles` (before the fix: a single whole-text `replace(HANDLE)`); `handlesIn`/`toMentions` use `outsideProtected` | `handlesIn` reads each segment between code/URL spans on its own, so a segment end acts as a boundary. `@CFOhttps://x`, `@CFO.https://x` and `@R&Dhttp://a.b` were therefore not handles in the whole text (lookahead `(?![\w&]\|\.\w)` fails), but they were handles in their segment. Repro before the fix: `handlesIn(defangHandles('@CFOhttps://x.test'))` = `['finance']`. **No routing hole**, because `defangMessage` refused to send. But model text (a delegated title, summary or acceptance, possibly from tainted content) could suppress the H3 report, H1, room lines and the governance task card at will, and each attempt raised a "post (bot reply dropped)" incident | A first fix (a per-segment second pass) still left a refusal you could trigger at will across **joined** fields. Probe through `tests/fakes/roundtrip.ts`: a card with title `` x``` `` and description ```` ```@CFOhttps://a.b ```` threw in `defangMessage`, because the send check joins fields with `\n` and pairs the fences differently from a single field. Inbound `embedText` joins in yet another format (`name: value`). **Final fix: `defangHandles` is context-free**: `/@(?=CEO\|CTO\|R&D\|…\|Praw)/g` → `@`+ZWJ, with no boundary checks. No segmentation, join, cut or split can then form a handle. The probe now gives zero routes and no throw. Fuzz: 200k triples of random pieces, defanged one by one, then joined with `\n` and `: `, and every prefix truncation checked; zero handles for `handlesIn`/`toMentions`; idempotent; removing ZWJ restores the input. handles.test.ts: three regression samples; the `@ITEM`/email "unchanged" assertion now expects the invisible ZWJ | security | FIXED |
| G2TT-02 | Low | teamtalk.ts `ended`: `cut(oneLine(summary), ROOM_SUMMARY_MAX)` runs before `lineNow`'s `redactText`. scheduler.ts `reportEnded` H3: `summary.slice(0, 800)` runs before the port's `redactPayload`. `handoffPayload`: `cut(title, 120)` / `cut(acceptance, 200)`. Board: `cut(t.title, 80)` | Text is truncated **before** redaction. A literal secret that straddles the cut point keeps a prefix that no longer matches the literal, so a partial secret can reach `room_entries`, later prompts and Discord. A pattern-matched token may still match if it is long enough. Before TEAMTALK, H3 posted the summary uncut, so this is new for H3 | Redact model text at the source, before any `cut`/`slice`: `redactText(summary, secrets)` in `TeamTalk.ended` and in `reportEnded`, and in `handoffPayload`/`boardText` for titles and acceptance. Test: a literal secret at offset 245 of the summary leaves no 4+ character prefix in the entry, the room line or H3 | backend | OPEN (non-blocking) |
| G2TT-03 | Low (test gap) | loop.ts:211 `!adminRun && deps.rooms ? await roomEntriesFor(…) : []` | Admin and mod-room runs get no room memory, and the guard is correct in code. No test pins it (the "admin run room memory guard untested" risk named in the brief), so a refactor could feed persona-room text into an admin-console run | Add a test to agents/loop test: an admin run with `deps.rooms` set never calls `recent`, and its context has no "Team room records" | backend | OPEN (non-blocking) |
| G2TT-04 | Info | app.ts:452-455, 499 (TeamTalk and `rooms` wired unconditionally) | No feature flag. The next restart enables H1, room lines, boards and room memory in prompts at once. The Pin Messages overwrites (T13) are not in place yet: boards post unpinned, with one warning per room | Owner: grant Pin Messages per head on its persona rooms before or right after the restart, and know that room memory starts from an empty table | owner | ACCEPTED risk |

## 3. Audit targets from the brief

- **Model text reaching Discord with live handles** (rhythm and meeting excluded as accepted):
  - H1, H3, room lines, board and task card: `noHandles` / governance-task defang plus the postcondition.
  - `logDirect` and `upsertTaskLog`: ignored channels.
  - `recoverRollup` text: never posted, it is the roll-up's input only.
  - `forwardRefused`, `warroomGuardAlert` and `noteHeld`: code text or actor labels only.
  - Approval cards (governance, non-task) are pre-existing and out of scope.

  No remaining routing path found.
- **Unicode lookalikes and zero-width.** `HANDLE` is case-exact ASCII, and nothing on the inbound path normalises (no `normalize`, NFKC or case folding in inbound.ts, router.ts or handles.ts). So `＠CFO`, a Cyrillic `С`, or `@`+ZWSP+`CFO` never route, and they need no defang. Inbound `cut(…, 8000)` cannot shorten our own messages (content ≤ 2000, embeds ≤ 6000). Outbound split/cut is covered by `defangMessage` per built message.
- **Webhook and bot edit content path.** The edit message is the `compose` output (redact → neutralise → defang → `defangMessage`). `webhooks.edit` and `editBot` set `content` and `allowedMentions:{parse:[]}`. Edits never route (MessageCreate only).
- **Pin abuse.** Only the board id just sent is pinned, in the persona's own room, by its department's head client. Re-pins happen only after a 10008 (a human deleted the board), so they are bounded by human action. Manage Messages stays forbidden.
- **Room memory injection and budget.** Database only, written by code paths only. Bodies ≤ 300 characters, redacted. Entries are whole or dropped and wrapped untrusted with a nonce tag. A tainted entry taints the run structurally. Residual cross-person and amplification risks are as in Gate 1 §5.
- **Provenance on every send, reposts included.** Verified (T5). H1 edits re-record with the OR'ed taint: `bot_messages` upsert `ON CONFLICT (message_id) DO UPDATE SET tainted = bot_messages.tainted OR EXCLUDED.tainted, answer = bot_messages.answer OR EXCLUDED.answer` (db/repos/botMessages.ts:16), so a later clean record never clears a tainted row. The board is always tainted and has no user.
- **Lock waits and deadlocks in `reportEnded`.**
  - `bus.on('task.changed', e => void this.onTaskChanged(e))` spawns the job and is not awaited, so the run that emits from `update_task` never waits on its own handler.
  - The only holders of `locks[child]` are the child's owner run and `ensureThread`. Neither waits on a parent lock or on a `task.changed` job.
  - A conversation's held lock (`conversationFor`) is released in `finally` after `afterRun`.
  - `jobs.idle()` is used only by tests and shutdown.
  - No cycle found. Cost: H3 and room lines wait for the owner's full run, which is the accepted deviation.
- **Migration up/down.** Clean, run on the test DB with and without 027 (migrate.int.test.ts:227).

Backend deviations:
- H3 waits for the child lock;
- H3 is posted as the parent's owner;
- under halt, H3 is skipped only when TeamTalk is wired (F-1 defang applies either way);
- the entry body has no link;
- one incident per channel;
- `KeyedLock` per task for the caps;
- a persona parent cannot reply to H1;
- a head-owned task drops ideas and decisions with a fixed message.

All are **accepted**: none weakens a T condition. The `recoverRollup` wording ("the notice is in this thread") can be false after a halt-skipped H3. That is accuracy, not security: no model text is posted, and the taint was already copied in `reportEnded` before the halt check.

## 4. G2W-07 (from gate2-web-grant)

RESOLVED.
- `decideGrant` and `decideBatch` return `halted_after_commit` together with the decided approval(s).
- The solo card closes in place with the code-written text: approved, no web reading, runs after /resume.
- A batch card is re-rendered, never closed, on a member click.
- The audit row records `ok #N halted_after_commit`.

Tests: approvals.int.test.ts:1093 (approval stays approved, grant revoked, runnable after /resume) and approval.test.ts:324, :341, :351.

## 5. Domain checklist

| Domain | Result |
| :--- | :--- |
| Secrets | PASS. G2TT-02 Low is open (partial secret through cut-before-redact) |
| Injection / prompt injection | PASS (DB-only memory, nonce wrapper, structural taint) |
| Reasoning isolation | N/A (code-written posts only) |
| Mentions / routing | PASS (G2TT-01 fixed) |
| Provenance / taint | PASS |
| AuthZ (DB roles) | PASS (`room_entries` not granted to the executor) |
| Log privacy | PASS (incidents carry ids and stage only) |
| Off-day / halt | PASS |
| Native memory, containers, supply chain | N/A |

## 6. Fixed in this audit

- `company/handles.ts` `defangHandles`: made context-free with the new `ANY_HANDLE_AT` pattern (G2TT-01). This supersedes the Gate 1 T1 wording "breaks every match of the HANDLE pattern". A near-handle such as `@ITEM` or `a@IT.com` in a relay now carries an invisible ZWJ (accepted: relays never need live handles).
- `company/handles.test.ts`: added three regression samples (`@CFOhttps://…`, `@CFO.https://…`, `@R&Dhttp://…`); the near-handle assertion now expects the ZWJ.

## 7. Audited files (md5 at audit end)
```
466a242e2037f7337f1889967f8d3680 db/migrations/028_teamtalk.up.sql
a47bbd90108888759e54739392faeb2d db/migrations/028_teamtalk.down.sql
7078828e6eb023b979193c04d84eed73 agents/teamtalk.ts
f214cf474101f7ca6bce0417554bc47b db/repos/room-entries.ts
77ba8bd583ea95d964817c816e87d456 company/handles.ts
24e05cfade357f35ea5f22f097b35b70 company/handles.test.ts
22061ead366107c382abc9705da25754 agents/payload.ts
0a2ca216c03f99eb8c80eb66c6bc34a4 discord/port.ts
5fff940c6f8900e7dd3697acd3bae721 discord/webhooks.ts
9c68d1ee352e765ed523b1236154bf13 discord/embeds/index.ts
d321d929edad302d6db1651ff1e8c71f discord/inbound.ts
0fd5e40be2fcdf5430f11bb6b047392b company/router.ts
50482ac3f0986a79aefd6729e5f05cf5 agents/scheduler.ts
3a79c2d1ccfbc7f6e6fc68d6206a19a0 agents/notices.ts
b0d660452111a2b5391e5c92fca5c381 agents/loop.ts
5325dd5232c60349ef1489e2a62d90cd agents/notes.ts
3d32dcef3712c9bfe614fc3eb0e7dd1c prompts/assemble.ts
8925fdf72c83743814695468d7d14a18 prompts/fragments/delegation.md
aa3b77b2ff1829a829797437cb16c74e tools/builtin/createTask.ts
bfb9e8b9dd8981cedf5ec3db99b9f252 tools/builtin/updateTask.ts
7ecce080f8934acc852b3d4bb2ff584a tools/types.ts
fce67167bc2551b8a8cafa7f528d17c7 core/events.ts
13fcd03a914a8f1ca264acc7b7d8edd9 db/repos/tasks.ts
5c5ac36f89eddbb049d831c60f3798fc app.ts
d94931da8c0f4e3b77bce541cba881b4 tests/fakes/roundtrip.ts
6791749b0b6c0d6bc070c9ffff32e2fe governance/approvals.ts
322a37aa90da5948d67e4019c5f901c5 discord/commands/approval.ts
01a9957620cb77d04c2a7eaf25e40ff3 agents/teamtalk.test.ts
e133a9163cf70d8a41ffaf99a473c989 discord/port.teamtalk.test.ts
```
`discord/inbound.ts` and `company/router.ts` are unchanged since Gate 1 (same md5).
