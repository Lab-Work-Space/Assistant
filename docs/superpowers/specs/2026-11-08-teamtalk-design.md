# TEAMTALK-1 — visible handoffs and team-room work boards (spec)

Owner request 2026-11-08: bots seemed not to record anything in their rooms or talk to each other ("they just take the job, think, and send the result back"). Proposals chosen: (1) models talk to each other clearly; (2) persona private rooms hold that team's work and ideas.
Decisions on open questions (defaults): OQ1 H5 two-way ask/answer NOT this round (phase 2); OQ2 board plain text; OQ3 head context includes last 8 entries across its personas; OQ4 H1 off in top-level conversations; OQ5 due date display only, no reminder.
Migration number: **028_teamtalk** (027 is reserved by WEBGRANT-1, docs/superpowers/specs/2026-11-08-web-grant-design.md).
Line numbers are hints; anchor by function name.

## Today (what is visible per hop)
- Delegation `createChild` (tools/builtin/createTask.ts:153-186): child to another head → warroom channel (`homeChannel`); child to persona → persona direct room. Model only gets "created task X". Nothing code-written in requester thread.
- `handleCreated` (agents/scheduler.ts:1056-1064): `ensureThread` (:1279-1294) creates thread with owner's head client ("LW R&D started a thread"); task card posted AS OWNER (persona → WebhookSender.send, discord/webhooks.ts:28); #📋-tasks upsert (`upsertTaskLog` port.ts:543); one #🔁-direct line (`logDirect` port.ts:594).
- Owner run (`runOwnerInner` :1032-1054) reads child thread history, posts outcome in child thread (`deliver` :1359). Personas have only update_task and respond. Default "Task marked done." (`endedPayload` loop.ts:359).
- Child ends (`reportEnded` :1091-1125): parent head posts "Subtask done: <who> finished "<title>": <summary>" in parent thread (:1117; skipped in top-level conversation :1116); #🔁-direct line; child taint copied to parent (:1104); on done requester roll-up run with only the summary (`rollupMessage` notices.ts:125).
- Internal only: tool rounds/results, full description beyond card, persona full report beyond its room, notes. No dialogue path between models.
- Empty room cause: persona webhook card dropped (webhooks.ts:93-95 "lacks Manage Webhooks"); fixed 2026-11-08 by channel overwrites. Top level of rooms still only shows "started a thread".
- **F-1 (existing defect, fix in this work):** "Subtask done" body has no origin, so `outbound` (port.ts:242-256) converts `@CFO` in model summary to `<@id>`; inbound.ts:127-128 reads it as head mention; router.ts:128-134 routes bot handles in any thread → a child's summary can start another head's run.

## Binding rules for every new post
- R-A posted as owner of the thread it lands in (parent head in parent thread; persona webhook in persona room) → never routes.
- R-B via `scheduler.post` with prov `{tainted: <source taint>, userId: ownUserOf(task), answer: false}` so historyTaints (context.ts:120) does not taint later runs.
- R-C new payload flag `noHandles: true`: outbound neutralises raw mentions and skips toMentions; people as plain actorLabel text.
- R-D plain text (owner rule: embeds only for settings/approval cards; task card stays governance card). Links bare `https://discord.com/channels/<g>/<c>/<m>` with SuppressEmbeds. allowedMentions {parse: []}; @everyone/@here neutralised; redactPayload first.

## (1) Handoffs (code only, no new model tools)
- H1 delegation line, in `handleCreated` after ensureThread, in the parent thread, once per child, id stored in tasks.handoff_message_id. ≤600 chars:
  ```
  ➜ Handoff #<id8>: <Requester> → <Owner>
  Ask: <title ≤120>
  Done when: <acceptance ≤200 | "see brief">
  Due: <YYYY-MM-DD | none>   Status: <status>
  Thread: <link to child thread>
  ```
  Edited in place on every task.changed (reuse `upsertStored` port.ts:364, new kind 'handoff'); status and off-day hold ("starts next workday") update by edit, never new posts. Skipped in top-level conversation (WS13; keeps workstyle.test.ts:507).
- H2 task card gains fields Done when, Due, Back to (parent thread link).
- H3 Subtask done/blocked/cancelled post kept (title pinned by tests): replyToId = H1; body = summary (≤800, handles defanged) + `Full result: <link to result_message_id>`; posted with noHandles (fixes F-1); `deliver` stores owner's final posted message id in tasks.result_message_id.
- H4 rollupMessage content = summary + first 1500 chars of owner's final report text, wrapped untrusted (taint already copied :1104).
- create_task optional input: `acceptance` (≤300) and `due` (YYYY-MM-DD, today..+365 in schedule.timezone; refusal text "due must be a date from today to one year ahead"). prompts/fragments/delegation.md: "set acceptance and due".

## (2) Team rooms
- Room log (persona room top level, webhook, plain, ≤400 chars): on assign `📥 New: <title> from <Requester> · due <d> · <thread link>`; on done `✅ Done: <title>: <summary ≤250> · <result link>`; blocked/cancelled one line same shape; from update_task.ideas/.decisions (new, each ≤3 items ×200 chars) `💡 Idea:` / `📌 Decision:` lines. Room lines must NOT use logDirect.
- Work board: one pinned message per room — Now (open tasks ≤8), Done (last 5), Ideas (last 5), Decisions (last 5); plain text ≤1900 chars; debounced ≤1 edit / 60 s (like agents/task-board.ts); stored in board_messages key `room:<personaId>`; new port method `upsertRoomBoard(persona, channelId, content)` posted by webhook, pinned with head client (existing upsertBoard uses hq client + embed, not reusable).
- Memory from DB `room_entries`, never Discord room history (humans can post in rooms; HIST-1 would read them). Persona run gets its last 8 entries; head run last 8 across its personas; wrapped untrusted within KNOWLEDGE_BUDGET_BYTES; tainted rows prefixed `UNVERIFIED: ` (taints reading run, loop.ts:225). Room content is NOT trusted provenance; each entry carries producing run's taint.

## Migration 028_teamtalk
up:
```sql
ALTER TABLE tasks ADD COLUMN acceptance text CHECK (length(acceptance) <= 300);
ALTER TABLE tasks ADD COLUMN due_on date;
ALTER TABLE tasks ADD COLUMN handoff_message_id text CHECK (handoff_message_id ~ '^[0-9]{17,20}$');
ALTER TABLE tasks ADD COLUMN result_message_id text CHECK (result_message_id ~ '^[0-9]{17,20}$');
CREATE TABLE room_entries (
  id bigserial PRIMARY KEY,
  persona_id text NOT NULL CHECK (length(persona_id) BETWEEN 1 AND 64),
  dept_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('assigned','done','blocked','cancelled','idea','decision')),
  task_id text,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 400),
  tainted boolean NOT NULL DEFAULT true,
  message_id text CHECK (message_id ~ '^[0-9]{17,20}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX room_entries_persona_idx ON room_entries (persona_id, created_at DESC);
```
down:
```sql
DROP TABLE IF EXISTS room_entries;
ALTER TABLE tasks DROP COLUMN IF EXISTS result_message_id, DROP COLUMN IF EXISTS handoff_message_id, DROP COLUMN IF EXISTS due_on, DROP COLUMN IF EXISTS acceptance;
```
Retention: last 200 rows per persona, prune on insert. Zod: createTaskInput `acceptance: z.string().trim().max(300).optional()`, `due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()` (range in code); updateTaskInput `ideas`, `decisions`: `z.array(z.string().trim().min(1).max(200)).max(3).optional()`.

## Failures
All via `safe()`; work never stops. H1/room line/board failure → one incident per channel, task continues. Missing Pin Messages → one warning, board unpinned. 10008 on edit → repost once (upsertStored). Halt → nothing new posted (deliver :1360).

## Limits
One H1 per child; edits only for status; ≤4 room lines per task (+ ideas/decisions lines ≤6); board edit ≤1/60 s/room.

## Tests
(a) H1 and room lines → zero routes, no turn used. (b) every new post has a provenance row; later run in that thread starts clean. (c) `@CFO` in summary does not route (F-1). (d) tainted child → tainted room entries → next reading run tainted. (e) board edited not reposted; debounce. (f) off day: H1 shows hold, no bot run. (g) webhook failure leaves task running. (h) 028 down clean.
Re-check existing assertions: agents/scheduler.test.ts:412 (one post in th-p), :415 (one directs entry — room lines must not use logDirect), workstyle.test.ts:507, conversation.test.ts:255, exact post counts in agents/warroom.test.ts, tests/integration/approval-batch.int.test.ts, agents/scheduler.test.ts (9 sites) where create_task runs.

## Security (Gate 1)
Injection via room content: memory from DB only, untrusted wrap, UNVERIFIED prefix, human room posts never become memory. Taint: room entries/H3/H4 inherit child taint; prov mandatory. Webhook spoofing: inbound attribution by persisted webhook id + application id (webhooks.ts:57; open R26 applicationId check); only existing `assistant-personas` webhook. Mentions: allowedMentions none, noHandles, @everyone/@here neutralised, redact first. Owner step: Pin Messages overwrite for each head on its persona rooms.

## Amendments after Gate 1 (binding; Gate 1 T1–T14 in docs/security/2026-11-08-gate1-teamtalk.md win where they differ)
- R-C: `noHandles` must DEFANG literal handle text (new defangHandles breaking every HANDLE match, incl. in code/URLs) on the final composed title, body and fields after redaction, assert handlesIn(content) is empty, round-trip test post → toIncoming → route() = [] (T1). Task card (governance) gets the same (T2).
- R-B: H1 and H3 use the PARENT task's ownUserOf; the board is recorded tainted:true, userId:null; every send incl. 10008 repost records provenance answer:false (T5).
- Owner decision (revised 2026-11-08): pinning ALLOWED. Controller sets a Pin Messages (1<<51) channel overwrite for each dept head bot on its persona rooms (never Manage Messages, T13). Board is pinned by the head client; missing permission → one warning, board stays unpinned.
