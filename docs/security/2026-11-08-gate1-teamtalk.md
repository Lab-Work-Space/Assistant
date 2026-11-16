---
title: "Gate 1 — TEAMTALK-1 visible handoffs and team-room work boards"
task_id: TEAMTALK-1
gate: 1
status: CONDITIONAL_APPROVE
spec: docs/superpowers/specs/2026-11-08-teamtalk-design.md
migration: 028_teamtalk
last_updated: 2026-11-08
---

# Gate 1 — TEAMTALK-1 (spec review)

**Verdict: CONDITIONAL_APPROVE.** The design is sound in shape: code-written posts only, no new model tools, memory read from the database (not from Discord), taint carried on room entries, `allowedMentions: {parse: []}`. But the F-1 fix as written (R-C `noHandles`) **does not close F-1**. Conditions T1 to T14 below bind the build and Gate 2.

Code is cited by function name plus a quoted fragment. Line numbers in the spec are hints only.

## 1. F-1 verification (existing defect): CONFIRMED, and the spec's fix is insufficient

Route chain today for `reportEnded` (agents/scheduler.ts):
1. `reportEnded` posts `{ type: 'chat', title, body: text }` with no `origin`. The text is `${who} finished "${task.title}": ${e.summary ...}`, and both the summary and the title are model-written.
2. `outbound` (discord/port.ts) sees `p.origin !== 'governance'` and turns a handle such as `@CFO` in the body into `<@id>` (`toMentions(neutralise(t), ...)`). Titles only get `neutralise`.
3. `buildPlainMessage` (discord/embeds/index.ts) puts the title **into the content** (`**${title}**`).
4. `toIncoming` (discord/inbound.ts) has two independent paths for head and persona authors:
   - (a) it reads `<@id>` markup from the content (`content.matchAll(/<@!?(\d{17,20})>/g)`);
   - (b) **it also reads literal handles**: `if (author.kind === 'head' || author.kind === 'persona') for (const d of handlesIn(content)) ...mentionedHeads.push(d)`.

   `contentOf` also folds embed title, description and fields into `content` for these authors.
5. `route` (company/router.ts, WS2) routes a bot's mention in any channel and thread: `for (const dept of mentions) ... add({ kind: 'head', dept }, ... 'mention')`. Only a self-mention is dropped.

R-C as written ("outbound neutralises raw mentions and skips toMentions") removes path (a) only. Path (b) still routes on the literal `@CFO` in the body **and in the title**. `neutralise` breaks only `<@` and `@everyone`/`@here`, not handles. So F-1 stays open unless the handle text itself is defanged (condition T1). The spec's H3 line says "handles defanged", but R-C defines `noHandles` without that step. T1 settles the conflict.

### Sibling relays of model text (rule: cover every write, not only the helper named)
| Relay | Model text in it | Routes today? | Under TEAMTALK |
| :--- | :--- | :--- | :--- |
| `reportEnded` "Subtask done/blocked/cancelled" (H3) | title, summary | yes (F-1) | T1 |
| `taskCard` via `ensureThread` / `refreshCard` (governance, type `task`) | title, description; H2 adds `acceptance` | **yes, by static trace**: `outbound` neutralises only, and inbound `contentOf` + `handlesIn` reads the card embed text of the owner (head or persona) → WS2 route in the child thread | **G1-02 / T2** |
| H1 handoff line (new) | title, acceptance | would route | T1 |
| Room lines (new, persona webhook, room top level) | title, summary, ideas, decisions | would route: persona author, `handlesIn` → head route; heads speak anywhere (`postsHere`) | T1 |
| Room board (new) | titles, ideas, decisions | first send and repost would route; edits do not | T1 |
| `logDirect` | title, text | no: #🔁-direct is in `IGNORED_CHANNEL_IDS` | none |
| `upsertTaskLog` / `upsertBoard` | titles | no: #📋-tasks is ignored | none |
| rhythm / meeting posts (`rhythmHost.post`, `meetingHost.post`) | model text | can route (posted as hq) | out of scope; listed for the owner, no condition |

`actorLabel` (agents/notices.ts) emits `head of <dept>`, `<personaId>` or `user <id>`. It never emits `@<Handle>`, so it is safe as the "Requester"/"Owner" text.

Only `Events.MessageCreate` is wired (discord/clients.ts `client.on(Events.MessageCreate, ...)`), so **in-place edits never route**. The routing exposure is each first send and each 10008 repost (`upsertStored` → `poster.send()`, and the same in the board path). History reads the edited content, so provenance still matters for edits (T5).

## 2. Findings

| ID | Severity | Evidence | Description | Remediation | Owner |
| :--- | :--- | :--- | :--- | :--- | :--- |
| F-1 | High | scheduler `reportEnded` → port `outbound` `toMentions(...)` → inbound `handlesIn(content)` → router WS2 `add(... 'mention')` | A child summary or title containing `@<Handle>` starts another head's run in the parent thread (turn/cost amplification; a tainted child can steer a clean head's thread) | T1 | backend |
| G1-01 | High | spec R-C; inbound `toIncoming` `handlesIn(content)` for head/persona authors | `noHandles` as specified (skip `toMentions` only) leaves the literal-handle route in place, so F-1 and every new relay (H1, H3, room lines, board) still route | T1: defang handle text in the final composed content | backend |
| G1-02 | Medium | notices `taskCard` (`origin: 'governance'`, title, `cardBody(task)`); port `outbound` "except task cards that quote titles" → neutralise only; inbound `contentOf` embed text | Handles in a delegated title or description route from the task card in the child thread. H2 adds model-written `Done when` to the card. No existing test pins this as a feature (searched discord/port.mentions.test.ts, discord/inbound.handles.test.ts) | T2 | backend |
| G1-03 | Medium | scheduler `handleChanged`/`reportEnded` run on `update_task` (the owner's run is still in progress); `deliver` posts only after the run ends | H3 "Full result: <link>" (`result_message_id`) and H4 "first 1500 chars of owner's final report" do not exist yet when `reportEnded` runs. An ad hoc fix that reads the report back from Discord history would take unattributed text and lose its taint | T6 | backend |
| G1-04 | Medium | spec R-B "`userId: ownUserOf(task)`"; context `historyTaints` `r.userId !== o.own` | It is unclear which task "task" means. H1 lands in the parent thread, and `ownUserOf(child)` is null (the requester is a head), so a human's later run there is tainted. The board aggregates many sources and is edited in place, so a single source taint is wrong for it. Edits keep the first provenance row | T5 | backend |
| G1-05 | Medium | migration 018 `board_messages.key ... CHECK (length(key) BETWEEN 1 AND 64)`; createTask `personaId: z.string().min(1).max(64)`; 001 `personas.id text` (unbounded); port `upsertBoard` sends, **then** `store.set(...)` | Key `room:<personaId>` can be 65 to 69 characters. `store.set` then fails after the send, the next debounce sees no stored id and **posts a new board every 60 s** (spam loop). The same send-then-store shape exists in `upsertBoard` | T8 | backend |
| G1-06 | Medium | port `upsertStored` "No stored id: send" | When H1 is edited on every `task.changed`, a status change that lands before the H1 claim (owner run starts → `doing`) posts a second H1. The spec's limit is "One H1 per child" | T7 | backend |
| G1-07 | Medium | spec §Memory; prompts/assemble `assembleContext` byte budget; loop `context.includes('UNVERIFIED: ')` | Room entries must enter the shared budget whole. A byte-cut tainted entry could lose its `UNVERIFIED: ` prefix and stop tainting the reading run. Entry taint must come from the producing run at write time (the event row can predate, cf. the `reportEnded` G2-04 comment). Summaries can carry secrets into the database and later prompts | T9, T10 | backend |
| G1-08 | Low | spec §Failures "Halt → nothing new posted (deliver :1360)"; H1, room lines and board are not posted through `deliver` | Halt is not enforced on the new code paths | T11 | backend |
| G1-09 | Low | port `webhooks.edit` sends `{ embeds, components }` only; port `editBot` likewise | Plain-text H1 and board edits would not update `content`. Any new edit path must still go through redact + neutralise + defang | T7 | backend |
| G1-10 | Low | perm-bits `SAFE_BITS ... F.PinMessages`; `HARD_FORBIDDEN_NAMES ... 'ManageMessages'` | The owner step must grant Pin Messages (bit 1<<51) as a channel overwrite, never Manage Messages. The pin system notice is a head-authored message with no provenance row; it taints later runs in the room top level (fail-safe, accepted) | T13 | owner / devops |
| G1-11 | Low | spec Zod `due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)`; column `due_on date` | `2026-02-31` passes the regex and fails at INSERT with a database error instead of the fixed refusal | T12 | backend |
| G1-12 | Low | spec "from update_task.ideas/.decisions"; `update_task` is also used by heads | It is undefined where a head's ideas/decisions go | T12 | backend |

## 3. Domain checklist

| Domain | Result | Note |
| :--- | :--- | :--- |
| Secrets | PASS with T10 | `redactPayload` runs first in `outbound`. Room entries must be redacted before INSERT |
| Injection / prompt injection | CONDITIONAL | Memory comes from the database only. Human room posts never become entries (only code paths write them). Nonce wrapper `wrapUntrusted` (`untrusted-${nonce}`, `escBody`). T9 |
| Reasoning isolation | N/A | No new model output path; posts are code-written |
| Mentions / routing | FAIL as written → T1, T2, T3 | See §1 |
| Provenance / taint | CONDITIONAL → T5, T6, T9 | |
| Webhook identity | PASS with T4 | Existing `assistant-personas` webhook, persisted id plus `applicationId` match in `authorOf`. Attribution failure → `foreign_bot` → no route and taint (fail-safe) |
| Edit-in-place races | CONDITIONAL → T7, T8 | `serial(key)` exists per process |
| Spam limits | CONDITIONAL → T8, T12 | Child creation is already bounded (`checkChildren`, `checkDepth`, `checkOpenTasks`) |
| Off-day / halt | CONDITIONAL → T11 | |
| Migration 028 | PASS with T14 | Snowflake CHECKs, length CHECKs, `tainted DEFAULT true` (fail-safe), clean down. `db/migrate.ts` applies by name set, so the 027 gap is harmless |
| AuthZ (DB roles) | PASS with T14 | `room_entries` must stay out of `EXECUTOR_TABLE_GRANTS` |
| Log privacy | PASS | Incidents on failure: no body text (T11) |
| Native memory, containers, supply chain | N/A | TypeScript only, no new dependencies or images |

## 4. Binding conditions (Gate 2 verifies each with the named test)

**T1 (F-1, G1-01). `noHandles` defangs handle text.**
- `company/handles.ts` gets `defangHandles(text)`. It breaks every match of the `HANDLE` pattern (for example `@` + ZWJ + name), **including inside code spans and URLs**. A code-written relay never needs a live handle, and composition or redaction can change which spans count as protected.
- It runs on the **final composed** title, body and field values, after `redactPayload` and composition, and before `build`.
- `noHandles` = `neutralise` + `defangHandles`, with no `toMentions`.
- Applies to H1 (send and repost), H3, room lines and the room board.
- Postcondition, asserted in code (refuse to send otherwise): `handlesIn(content) = []` and no `<@` in the built message content or embed text.
- Tests:
  - `company/handles.test.ts`: defang is idempotent; `handlesIn(defangHandles(x)) = []` for handles in plain text, in a code fence, in an unterminated fence, after a URL and inside a title.
  - `discord/port.mentions.test.ts`: a `noHandles` post contains no `<@id>` and no live handle in content.
  - `discord/inbound.handles.test.ts` + `company/router.test.ts`: round trip, posted message → `toIncoming` → `route()` = `[]`. Covered for: H3 from a head in the parent thread; a room line from a persona webhook in the room top level; a board first send.
  - `agents/teamtalk.test.ts` (new): spec test (c), `@CFO` in summary **and** title does not route, end to end through the scheduler.

**T2 (G1-02). The task card gets the same defang.**
- Defang applies to title, description and the new H2 fields (Done when, Due, Back to) of `taskCard`, on both the `ensureThread` post and the `refreshCard` edit.
- If the controller rules that card handles are a wanted feature, record that ruling in this file. In that case H2 `acceptance` must still be defanged.
- Test: `discord/port.mentions.test.ts` (card with `@CFO` in title/description/acceptance → no live handle), `agents/teamtalk.test.ts` (card round trip → zero routes).

**T3. The poster equals the owner of the receiving task or room.**
- H1 and H3: posted as `parent.owner`; the code asserts the actor equals it.
- Room lines and board: posted as the persona whose `directChannelId` is the room.
- Every TEAMTALK post sets `answer: false`, so the RF1–RF4 human-reply path never routes a reply to it.
- Test: `agents/teamtalk.test.ts` spec (a). Zero routes and no turn used for H1, H3, room lines and board. A human reply to an H1 yields zero routes.

**T4. Webhook identity.**
- Room lines and board go only through `WebhookSender` (the existing persisted `assistant-personas` webhook, `username: persona.name`). No new webhook is created per board.
- A message whose attribution fails maps to `foreign_bot` (no route) and taints history.
- Pins use the head client of the persona's department only.
- Test: `discord/port.test.ts` (`upsertRoomBoard` uses `webhooks.send`/`webhooks.edit` and pins via `clientOf(persona.deptId)`).

**T5 (G1-04). Provenance.**
- Every send records a provenance row with `answer: false`. That includes each split chunk via `onSent`, the 10008 repost inside `upsertStored`, and the board repost.
- `userId`:
  - H1 and H3: `ownUserOf({ task: parent })`, the task that owns the receiving thread.
  - Room lines: `ownUserOf({ task })` of the task the line is about.
  - Board: `userId: null, tainted: true`, always, because it aggregates sources and is edited.
- `tainted`:
  - H1: the child's taint at creation.
  - H3: `child.tainted` read fresh.
  - Room lines: the entry's taint.
- H1 edits may change only code-owned fields (status, hold note). A change to a model-derived field requires a new row with the OR'ed taint.
- Test: `agents/teamtalk.test.ts` spec (b): a later human-root run in the parent thread starts clean when the child was clean, and tainted when the child was tainted.

**T6 (G1-03). H3 link and H4 report come from the run, never from Discord.**
- The owner's final report text and its message id come from the in-process outcome of the owner's run (`deliver`'s return value and `outcome.tainted`), or from a database column written by `deliver`. Never from a Discord history read.
- H3 is either posted after `deliver` or posted without the link and edited once to add it (edit-only).
- H4 text is taken from that same outcome. `outcome.tainted || child.tainted` is OR'ed into the parent task before the roll-up run starts.
- When no outcome is available (restart, halt), H4 falls back to today's summary-only roll-up.
- Test: `agents/teamtalk.test.ts`: a tainted continuation after `update_task done` still taints the parent before the roll-up.

**T7 (G1-06, G1-09). One H1 per child; edits are edit-only.**
- Only `handleCreated` makes the first send of H1. Creation and status edits use the same `serial` key `handoff:<taskId>`.
- A status event with no stored id posts nothing (same semantics as `upsertTaskCard(..., editOnly)`).
- A status event with a stored id edits that message. Only when the edit returns 10008 does it repost, at most once per edit call.
- H1 and board edits set `content` (plain text), `allowedMentions: { parse: [] }`, and pass through redact + neutralise + defang.
- Test: `agents/teamtalk.test.ts`: a `doing` event racing creation yields exactly one H1. `discord/port.test.ts`: an edit updates content.

**T8 (G1-05). The room board cannot spam.**
- The board key has fixed length and passes the 64-character CHECK for any persona id, for example `room:` + the first 32 hex characters of sha256(personaId).
- If the board store write fails after a send, the room board is disabled for that room until restart, with one incident and no further sends.
- Debounce: at most 1 edit per 60 s per room, one timer per room.
- Test: `agents/teamtalk.test.ts` spec (e) (edited, not reposted; debounce), plus a 64-character persona id and a failing `store.set` → exactly one send. Also `db/repos/board.int.test.ts` (key length).

**T9 (G1-07). Room memory.**
- Entries enter the shared `KNOWLEDGE_BUDGET_BYTES` **whole or not at all**, never byte-cut.
- Each entry is wrapped by `wrapUntrusted`.
- A tainted entry is prefixed `UNVERIFIED: ` **and** the run is marked tainted structurally when any admitted entry has `tainted = true`, not only by the string check.
- Entry taint at write time:
  - assigned: the child's taint at creation;
  - done/blocked/cancelled: the fresh task row;
  - ideas/decisions: `ctx.tainted() || task.tainted`.
- Only code paths insert entries; no Discord read feeds `room_entries`.
- Test: `agents/teamtalk.test.ts` spec (d), `prompts/assemble.test.ts` (an entry that would be cut is dropped whole; a tainted admitted entry taints).

**T10 (secrets).**
- `body` is passed through `redactText(..., secrets)` and truncated to 400 characters in code before INSERT, so neither the database nor later prompts hold literal secrets.
- Test: `agents/teamtalk.test.ts` (a planted secret in a summary is absent from `room_entries` and from the room line).

**T11 (G1-08). Halt and off day.**
- Every TEAMTALK send and edit (H1, H3, room line, board) checks `halt.isHalted()` first and does nothing while halted.
- On an off day, H1 shows the hold by edit only and no bot run starts.
- Failure incidents carry ids and the stage only, never the post body.
- Test: `agents/teamtalk.test.ts` spec (f) plus a halted case (zero posts, zero edits).

**T12 (G1-11, G1-12). Limits and inputs.**
- Per-task caps (at most 4 lifecycle room lines, at most 6 idea/decision lines) are enforced by a database count on `room_entries.task_id`, so they survive a restart.
- Ideas and decisions are posted only when `task.owner` is a persona, and only in that persona's room; otherwise they are dropped with a fixed tool message.
- `due` is validated as a real calendar date in `schedule.timezone`, from today to +365, with the fixed refusal text "due must be a date from today to one year ahead". The refusal echoes nothing the model wrote.
- Test: `tools/builtin/createTask.test.ts` (`2026-02-31`, yesterday, +366), `agents/teamtalk.test.ts` (7th idea dropped).

**T13 (G1-10). Owner step.**
- Grant **Pin Messages** (bit 1<<51) as a channel overwrite for each head on its persona rooms only. Never Manage Messages; a guild-wide grant is already refused by `checkGuildPermissions`.
- If the pin is missing, log one warning; the board works unpinned.
- Test: `discord/permissions.test.ts` (the startup check still flags guild-wide Manage Messages; `PinMessages` stays in `SAFE_BITS`).

**T14. Migration and DB roles.**
- 028 up and down are clean on a database with and without 027 applied.
- `room_entries` is not added to `EXECUTOR_TABLE_GRANTS`.
- Test: `db/migrate.int.test.ts` spec (h), `db/executor-role.int.test.ts` (executor cannot SELECT `room_entries`).

Also re-run the existing assertions the spec lists: agents/scheduler.test.ts (one post in th-p; one directs entry), agents/workstyle.test.ts:507, agents/conversation.test.ts:255, agents/warroom.test.ts post counts, tests/integration/approval-batch.int.test.ts.

## 5. Residual risks (accepted unless the controller rules otherwise)
- **Taint amplification.** One tainted persona run makes every head run of that department tainted until 8 newer entries push the tainted one out (head context reads the last 8 across its personas). This is an availability cost, not a leak, and it is the same model as dept notes (K1).
- **Cross-person cleanliness.** A clean entry written while answering Bob is read as clean by a run answering Alice. This matches dept notes, and it is weaker than G2-04 history, which is per person.
- **Pin notices.** The pin system message (head author, no provenance row) taints later runs in the room top level. This is fail-safe.
- **Existing `upsertBoard` (recommendation, not binding).** It has the same send-then-store shape as the room board. It is not reachable today because its keys are fixed short code strings. Adding the T8 store-failure guard there is recommended.
- **Rhythm and meeting posts** still relay model text with live handles. They are outside this scope and listed for the owner.

## 6. Audited files (md5 at review end)
```
51f4e761eb55eb393b6494edb1c18a18 docs/superpowers/specs/2026-11-08-teamtalk-design.md
428f6a2d4a437d6fae7c5c9b2cd006a8 discord/port.ts
d321d929edad302d6db1651ff1e8c71f discord/inbound.ts
4133a35b7d136da3a1791db114b66ce7 discord/webhooks.ts
0fd5e40be2fcdf5430f11bb6b047392b company/router.ts
8b79af4c0fa93eba9673d6566106a7ba company/handles.ts
904f38acc742a2704d922b204207d368 agents/scheduler.ts
164d77195cbe655bffe7106000dc0834 agents/context.ts
8a5c35b4f08f1da4725d6943282f1b18 agents/loop.ts
fe47cbc355948ee1e35e7fe77e3d39a8 agents/notices.ts
abb20f1d0d288a98d25947bc215a2623 prompts/assemble.ts
302123e3bd7c8067e400464580014163 tools/builtin/createTask.ts
aae8b9cbec1c3cad593cfc18f7dd77cb tools/builtin/updateTask.ts
c3e1520988fb953c44f5048f974e817e db/repos/tasks.ts
aafaa83adba564c54e328466c488c76e db/migrate.ts
61f626cdf5507fa08bdc5f662754196d discord/perm-bits.ts
aebd243dc5cada9596b2c0fe5866ee15 discord/embeds/index.ts
64d0a6e7bec242a11793fc8b638d7a2b db/migrations/018_task_messages.up.sql
```
Evidence method: static review of the code and spec. No scanners apply (no dependency, image or native change), and no tests were run.
