---
title: "Gate 1 — STREAM-1 live reply streaming"
task_id: STREAM-1
gate: 1
status: CONDITIONAL_APPROVE
spec: docs/superpowers/specs/2026-11-08-reply-streaming-design.md
migration: none
last_updated: 2026-11-08
---

# Gate 1 — STREAM-1 (spec review)

**Verdict: CONDITIONAL_APPROVE.** The design shape is sound. Only the `respond` body is shown. Every preview goes through `compose()` with `noHandles`, which runs redaction, neutralise, defangHandles and the `defangMessage` throw. Edits never route (only `Events.MessageCreate` is subscribed, in discord/clients.ts `attach`). Delete stays banned. Unrecorded previews count as tainted. Halt is checked before every edit.

Four gaps must be closed before build (conditions S1 to S22 bind the build and Gate 2):
- **Holdback rule (b).** It does not cover every TEXT_PATTERNS value class (VULN-002).
- **Probe pin.** The pin does not bind the CLI argv, so the stream-json switch would run under the old probe result (VULN-001).
- **Local stream extractor.** It can be steered by the model's key order (VULN-004).
- **Fresh-post predicate.** It misses literal handles, which route on create today (VULN-005).

Code is cited by function name plus a quoted fragment. Line numbers are hints only.

Why the bar is "no transient leak": every edit is broadcast as a gateway `MESSAGE_UPDATE` to every bot in the guild, and logging bots keep before/after copies. A secret fragment shown for 1.5 s is therefore a permanent leak. The invariant below is "no edit reveals any character that the final full-text redaction masks".

## 1. Partial-secret exposure (holdback rules vs core/logger.ts TEXT_PATTERNS)

Pattern-by-pattern check of the spec's rules (a) to (f). The property that makes most patterns safe: `redactText(prefix)` already masks a partial value when the pattern's minimum length is reached from the left (key=, Cookie:, thought_signature: min 1 char).

| Pattern (core/logger.ts `TEXT_PATTERNS`) | Value class | Covered by | Gap |
| :--- | :--- | :--- | :--- |
| PEM `-----BEGIN ...(END\|$)` | multi-line | (c) | Must cut before the dashes, also for a partial header (`-----BEGIN RSA PRIV`) |
| gh*_ / github_pat_ / JWT / AIza / AQ. / sk-ant- / ATATT / pk_ / Discord token / webhook URL / Apps Script URL | `[\w.-]` plus `:/` | (b) trailing run | none |
| `\bBot\s+` / `\bBasic\s+` | run after whitespace | (b) | (e) is cosmetic only |
| `key=` / `token=` / `access_token=` value `[^&\s"'<>]+` | **any non-space char incl. `!#$*(),@[]{}\|` and Thai** | prefix masking (min 1) | safe today, but only by luck of min-length 1 |
| Cookie / Set-Cookie `:[^\r\n]*` | to end of line | prefix masking (min 0) | (e) must be case-insensitive (the pattern is `/gi`) |
| Netscape cookie-jar line (7 tab fields, `/gm`) | to end of line | (d) | none |
| thought_signature `[^"\s,}]+` | non-space | prefix masking | none |
| **postgres URL `(postgres(?:ql)?://user:)[^@\s]+(@)`** | **any non-space char except `@`; needs the trailing `@` to match** | (b) only | **LEAK (VULN-002)**: `postgres://u:pa$$w0rd!x@h` is cut by (b) at `$` (not in the class), so the prefix ends `...u:pa$$`. No `@` is in the prefix, so nothing is masked, and each later edit reveals more of the password until `@` is committed. The same happens with Thai or other non-ASCII password characters. The bot's own `databaseUrl`/`dbPassword` are literals in `secretsOf` and are caught by (f). The exposed case is any other DB URL covered only by the pattern: one read from a tool result, a fetched page, a pasted config, or a dev job's environment. Kept High, because a credential is shown publicly and that cannot be undone. |
| Literal secrets (app.ts `secretsOf`: DB URL, DB password, bot tokens, master key b64/hex, PEM lines, API keys) | arbitrary | (f), suffix ≥ 4 | up to 3 characters of a 5-character DB password (60 %) can show (VULN-003) |

Fix (S1): rule (b) becomes "cut before the trailing run of non-whitespace (JS `\S`, which is Unicode-aware, the same `\s` the patterns use)". This subsumes (b), fixes postgres, and covers every value class above. A missing right delimiter (`@`) can no longer leak, because no TEXT_PATTERNS value class contains whitespace except the ones handled by (c), (d) and prefix masking. Cost: Thai text with no spaces is held until the next space or punctuation that `\s` matches, which is acceptable because the final shows everything.

Other holdback points:
- Truncation to `PREVIEW_MAX` happens on the committed (already redacted) text or on raw before `committable`, never between the two in a way that makes `redactText` see less text than what is shown (S2). Add a fixture with a secret straddling char 1900.
- The rules are applied to a fixpoint: re-applying `committable` to its own output is a no-op (S1).
- The literal list is the port's live `opts.secrets` array (app.ts pushes the stored Gemini key after decrypt, `secrets.push(stored)`), never a copy taken at stream open (S3).
- A commit point never splits a UTF-16 surrogate pair (a lone surrogate may make the edit fail with 50035 and then freeze the stream) (S1).

## 2. Mention and handle defang on every edit — PASS with conditions

`compose(actor, target, {type:'chat', body, noHandles:true}, {}, true)` runs `outbound` with `defangHandles(neutralise(t))` on title, body and fields, then `defangMessage`, which throws on any surviving handle or `<@`. editBot and webhooks.edit both send `allowedMentions: { parse: [] }`. A handle cut by holdback (`@CF`) is not a handle for `handlesIn` (case-exact, full name), and the next edit defangs the whole body again. A throw skips that edit (S4: never fall back to an unchecked send).

## 3. Routing of the preview create — PASS with conditions

For a bot-authored create, the router routes on: (1) `<@id>` and literal handles via inbound `handlesIn` (both defanged); (2) warroom continuation (warroom is excluded); (3) `task_owner` when `authorIsRequester` (the spec's routing-neutral rule). The reply, dept and goal routes are human-only. The analysis is complete.

The task lookup is done once before the run. A task bound to the thread mid-run (e.g. a conversation task opened by the run) would make the create route a **partial** text into the owner's run as its input. The predicate must be re-evaluated right before the create and fail closed on a lookup error (S5). The actor used must be the actor that actually authors the message (post() re-maps a persona outside its room to its head; `openReplyStream` returns null there, so keep that).

DMs: `attach` drops messages with `m.guildId !== this.opts.guildId`, so a DM never reaches runMessage. No extra rule is needed.

## 4. Provenance, taint, fresh-post rule

- **Taint.** Verified: `runStartsTainted` treats an unknown bot message as tainted (`repliedTaints`: `!row || row.tainted`), so an unrecorded preview fails safe. `isAnswer` false means a human reply to a preview does not route (accepted in the spec).
- **Recording.** Every message the stream leaves behind is recorded via the same `store.record`, including on partial failure, mirroring `post()`'s catch (`await Promise.all(pending)`). That covers the preview, the pointer line, the stopped line, a frozen preview and msgs[1..]. The answer messages use `answer=true` and the run's taint. Code-fixed lines (pointer, stopped) use `answer=false` (S6). The id that carries the answer (msgs[0] edit, or the fresh post) is what reaches `noteFinal` and the TEAMTALK `finalReport` (S6).
- **Fresh-post predicate is too narrow (VULN-005).** `toMentions` leaves `@CFO` as plain text when the head is offline or cannot View the channel. Inbound `toIncoming` still reads literal handles from head and persona content (discord/inbound.ts: `if (author.kind === 'head' || author.kind === 'persona') for (const d of handlesIn(content))`), so today's create routes on it. An edit would silently drop that route. The predicate must be `/<@/.test(text) || handlesIn(text).length > 0` over all built messages (content, embeds and fields joined, the same join as `defangMessage`) (S7).
- **Card payloads.** `post()` composes with `!isCardPayload(p)`, but the spec says `true`. A final that is a card (or has `buttons`, `adminCardId`, `spendOverrideId` or governance origin) is never edited into the preview: it is sent fresh via `port.post`, and the preview gets the pointer edit (S8). Model payloads cannot be cards today (`toPayload`), but loop stops and future payloads might be.
- **Reply on create (RF12).** The preview create copies RF12 exactly: SNOWFLAKE-checked `replyToId`, no reply for personas, `repliedUser:false`, `failIfNotExists:false`. Finalize popts carry no `mentionUserIds`. Assert that runMessage passes none (`deliver(..., undefined, ...)`); streaming is refused if any are present (S9).

## 5. Halt, budget and error endings

- **Halt predicate.** The halt check uses the same predicate as the loop, i.e. app.ts `agentHalt.isHalted` (`stopping || halt.isHalted() || presence.paused()`), not the scheduler's bare `halt`. A throw counts as halted (S10).
- **Content replacement.** `finalizeStopped` and every alert ending **replace** the whole content (no partial body is kept under the line). After a halt the fixed line is the only write; typing stops and timers are cleared.
- **Refusal.** On a refusal stop the partial text the model wrote before the refusal was already visible. This is inherent to streaming and accepted as residual R-1; the Declined alert edit replaces it.
- **Exit paths.** On every exit path (including a throw from `run()`), the slot is released, timers are cleared, and one best-effort fixed edit is made (`-# (reply interrupted)`), all in `finally` (S11).
- **Provider retries.** A retry must start a new segment (S12). claude-code-local retries internally once on timeout or signal (index.ts `call`, `for (let i = 0; ; i++)`). The Claude SDK retries before the stream starts, and a new `message_start` (server fallback, `fallbacks: 'default'`) is also a restart. Deltas of attempt 2 must never be appended to attempt 1's extractor state. The contract needs an explicit reset chunk (or onDelta segment call), handled by its own branch in call.ts (the existing `else reason = c.reason` would treat it as a stop).

## 6. Rate limits and abuse caps

The per-channel, per-process, interval, backoff and freeze caps are adequate for Discord (≈0.7 edits/s per stream, 4 streams). Missing pieces:
- **Edit cap.** A hard cap of edits per stream across all segments (e.g. 120), so oscillating `respond` retries over MAX_TOOL_ITERATIONS cannot edit without bound (S13).
- **Typing.** Typing goes through `resolve()` (denylist, persona room), is heads only, stops at first preview, end, or halt, and has a maximum duration (S14).
- **10008 mid-stream.** This means the preview was deleted by a person: freeze (no new preview). Only finalize may make one fresh post. A moderator deleting repeatedly must not cause repeated creates (S13).
- **Error logging.** Edit and create failures log only the Discord `code`/`status`. A discord.js `DiscordAPIError` carries `requestBody.json.content` (the partial answer), and `sanitize` only pattern-masks it (S15).
- **Performance (Low).** `editBot` does `channel.messages.fetch(id)` per edit. Keep the Message from the create, or accept 2 requests per edit.

## 7. claude-code-local switch to streaming output

Current state: `buildArgs` uses `--output-format=json` plus `--json-schema` (structured output). `runCli` buffers stdout under `OUTPUT_CAP_BYTES` (1 MiB), and `interpretResponse` parses the single result object.

- **Pin does not bind argv (VULN-001, High).** guard.ts checks only `version=`, `realpath=` and `sha256=` (`pinnedVersion !== version`, `pinnedPath !== claudePath`, sha). The probe writes only those (`printf 'version=%s\nrealpath=%s\nsha256=%s\nchecked=%s\n'`). Changing `buildArgs` to `--output-format=stream-json --verbose --include-partial-messages` keeps the old pin valid, so the provider would register without the re-probe the spec requires. That breaks global rule 27 (a change to argv or settings loading re-runs every probe). The probe must write `argv_sha256=` over the fixed flag list from `buildArgs` (model and system-file path replaced by fixed placeholders). guard.ts must refuse a missing or mismatching value, and the old-format pin must be refused (S16).
- **Probe check.** `probe-local-cli.mjs check` calls `idx.parseResponse` on stdout, which cannot parse stream-json. It must call the new stream parser (the same code the provider uses). The probe must also fail when the stream-json `system`/`init` event lists any probe-planted name (`assistant-probe-canary` in skills, agents, slash_commands or plugins), any MCP server, or any tool other than the structured-output tool. Those are customization-load signals that `--output-format=json` never showed (S17).
- **Final blocks.** They come only from the terminal `result` event, parsed by the unchanged `CliResultSchema` + `ResponseSchema` + allowedTools filtering (`interpretResponse`). Deltas are display-only. Every other event type is dropped and never logged or forwarded: `system`/`init` (cwd, tools, paths), `assistant` snapshots, `text_delta`, `thinking_delta`, `signature_delta`, hook and retry events. **Reasoning isolation:** only `input_json_delta` of the structured-output content block reaches the extractor. The same applies to providers/claude/index.ts, where only `input_json_delta` of a `tool_use` block feeds `tool_input_delta` and `thinking_delta` never does (S18).
- **UTF-8.** stdout is split into lines on byte `0x0A` (or decoded with `StringDecoder`) before `JSON.parse`. A per-chunk `b.toString('utf8')` corrupts 3-byte Thai characters split across `data` events (S19).
- **Caps.** stream-json is many times larger than json (one event line per delta plus snapshots). Keep the per-call wall-clock `timeoutMs`, the kill-group path and the stderr cap. Delta lines are processed and dropped, not retained. Retained (non-delta) bytes stay under `OUTPUT_CAP_BYTES`. Add a total-bytes cap and a per-line byte cap checked before any `JSON.parse` (global rule 13). Size both from a measured `maxTokens` run of the pinned CLI, not guessed (S19).
- **Kept flags.** `--safe-mode`, `--setting-sources=`, `--tools=`, `--strict-mcp-config`, `--disallowed-tools`, `--no-session-persistence`, `childEnv` (5 keys), the 0700 temp dir and `resolveClaudePath` checks all stay unchanged. A static test asserts that `buildArgs` still contains each of them (S16).

## 8. Extractor robustness against hostile model JSON

Required behaviour of agents/stream-extract.ts and the local navigator (S20):
- **Navigation key order (VULN-004).** In the local response `{"tool_calls":[{"name":..,"input":{..}}]}` the model controls key order. Stream an item only when `"name"` was seen before `"input"` in that item, the name decodes to exactly `respond`, and `respond` is in `req.tools`. Otherwise do not stream that item. This applies to duplicate `name` keys too: with `{"name":"respond","name":"warroom_say","input":{"body":..}}`, JSON.parse takes the last name, so streaming the first would show another tool's input publicly.
- **Keys.** A duplicate top-level `body` freezes the block. Any key containing a backslash escape (`"body"`, which JSON.parse decodes to `body`) freezes the block, unless keys are fully decoded and compared.
- **Values and structure.** A non-string `body`, a top-level non-object, raw control characters in a string, an invalid escape, or non-JSON whitespace freezes the block. Depth is tracked, so a nested `body` (inside `fields`) is ignored.
- **Bounds.** Work is linear and incremental (no re-parse of the accumulated buffer per delta). The raw body is bounded in bytes, and extraction stops past `PREVIEW_MAX + HOLDBACK + 4 KiB`. Depth is capped. `committable` and the `compose` pass run at most once per edit tick, not per delta.
- **Escapes and surrogates.** A partial `\uXX` at a delta end is buffered. A lone surrogate is passed through like JSON.parse does, but never split at a commit point.
- **Segments.** Each new structured-output block (the CLI may re-ask after a schema failure) and each provider attempt starts a new segment.
- **Non-blocking sink.** The sink `delta()` is synchronous and O(delta). A slow Discord call can never back-pressure the provider loop.

## 9. Interplay with approval cards and TEAMTALK

- **Approval cards.** These are code-built in the approval rooms (post-only, excluded from routing), so a stream never targets them. Approval-resumed and batch runs are not human `runMessage` runs, so they are not streamed. The `awaiting` footer lines (loop `finish`, `awaitingFooter`) appear only at finalize. During the preview a model can claim an action is done before the footer says it waits. This is accepted as residual R-2, since the final always carries the footer. Model text cannot create components: plain build, `components` empty.
- **TEAMTALK.** Room lines, board, H1 to H4 and roll-ups are out of scope. `noteFinal`/`finalReport` get the answer-carrying id (S6). The `digests` map in the port is shared and keyed by message id, so no conflict.

## 10. Findings

| ID | Severity | Evidence | Description | Remediation | Owner |
| :--- | :--- | :--- | :--- | :--- | :--- |
| VULN-001 | High | guard.ts pin check (`field('version')`, `field('realpath')`, `field('sha256')`); probe-local-cli.sh `printf 'version=%s\nrealpath=%s\nsha256=%s...` | The probe pin does not bind argv, so the stream-json switch runs under the old probe | S16, S17 | backend |
| VULN-002 | High (pattern-only DB URLs; own URL caught by literals) | core/logger.ts postgres pattern `[^@\s]+(@)`; spec rule (b) class `[A-Za-z0-9_\-.=+/:?&;%~]` | Progressive leak of a DB URL password containing `!$#*`, Thai etc. | S1 | backend |
| VULN-003 | Medium | spec rule (f) "suffix (≥4)"; app.ts `dbPassword(env.databaseUrl)` | Up to 3 characters of a short literal (DB password) shown | S1: literal suffix ≥ 1 (cost: holds a few characters) | backend |
| VULN-004 | Medium | protocol.ts `RESPONSE_SCHEMA` items `{name, input}` (order free); JSON.parse last-wins | The model can make another tool's input stream as the answer | S20 | backend |
| VULN-005 | Medium | handles.ts `toMentions` keeps the handle when `idOf` is undefined; inbound reads `handlesIn(content)` for bot authors | Fresh-post predicate misses literal handles, so a routed final becomes a silent edit | S7 | backend |
| VULN-006 | Medium | index.ts `call` retry loop; request.ts `fallbacks: 'default'` | Retry and restart deltas concatenate into the old segment | S12 | backend |
| VULN-007 | Medium | spawn.ts `OUTPUT_CAP_BYTES = 1024 * 1024`, `out.push(b)` | stream-json volume overflows the cap (non-retryable fail); unbounded line parse; UTF-8 split | S19 | backend |
| VULN-008 | Low | spec Finalize "compose(..., true)" vs port.ts post `!isCardPayload(p)` | Card final could be edited into a plain preview | S8 | backend |
| VULN-009 | Low | spec Eligibility "checked once before the run" | Routing-neutral TOCTOU routes a partial text | S5 | backend |
| VULN-010 | Low | discord.js `DiscordAPIError.requestBody`; scheduler `log.error({ err, type }, 'post failed')` pattern | Partial answer content in error logs | S15 | backend |
| VULN-011 | Low | spec Halt "halt.isHalted()" vs app.ts `agentHalt` | Edits continue while paused or shutting down | S10 | backend |

## 11. Binding conditions (build and Gate 2)

1. **S1.** `committable` implements: (a) ≤ len − HOLDBACK; (b) cut before the trailing `\S+` run; (c) open `-----BEGIN` (including a partial header) with no `-----END ...-----` cuts before the first dash; (d) last line containing a tab is held; (e) case-insensitive `Cookie:`/`Set-Cookie:`/`Bot`/`Basic`; (f) a literal suffix ≥ 1 matching any literal prefix is cut. The rules are applied to a fixpoint, and no commit point falls inside a surrogate pair.
   **Tests:** `agents/stream-holdback.test.ts`, a property test over every TEXT_PATTERNS fixture from `core/logger.test.ts` plus every `secretsOf` literal shape (incl. a 5-character DB password, a one-line PEM, and postgres passwords with `!$#*()` and Thai). Each fixture is embedded in ASCII, Thai, NBSP/U+3000, code fence and markdown-link contexts and split at every character boundary. Two assertions:
   - No edit contains a substring of length ≥ min(4, len) of the secret's variable part that `redactText(fullBody)` masks. Threshold 4, not the spec's 8.
   - Literal-specific: the committed tail (before ` …`) is never a non-empty prefix of a literal that the full body contains at that position.
2. **S2.** Truncation to PREVIEW_MAX is ordered after `committable`/`redactText`.
   **Test:** `agents/stream-holdback.test.ts`, secret straddling char 1900.
3. **S3.** `committable` and `compose` read the port's live `opts.secrets` reference.
   **Test:** `discord/port.stream.test.ts` (literal pushed after `openReplyStream`).
4. **S4.** Every preview create and edit goes through `compose(..., {noHandles:true}, ..., true)`. A throw skips that write and never falls back.
   **Test:** `discord/port.stream.test.ts` with `<@id>`, `<@&id>`, `@everyone`, `@here`, `@CTO`, `@R&D`, `@CF|O` split across deltas, and a handle inside code and URLs. Every edit payload has `allowedMentions.parse` `[]`.
5. **S5.** The routing-neutral predicate is re-evaluated immediately before the create, and a lookup error means no preview.
   **Tests:** `agents/scheduler.stream.test.ts`; `company/router` re-run on the created message yields `[]`.
6. **S6.** Every left-behind id is recorded (preview, msgs[1..], pointer, stopped line, frozen preview), including on partial failure. Code lines use `answer=false`, and the answer-carrying id goes to `noteFinal`/`finalReport`.
   **Test:** `agents/scheduler.stream.test.ts`.
7. **S7.** Fresh post happens when any built message text has `<@` or `handlesIn(...)` is non-empty.
   **Test:** `discord/port.stream.test.ts` (offline head and cannot-view head cases).
8. **S8.** A card final is always posted fresh with the pointer edit, and plain is computed as in `post()`.
   **Test:** `discord/port.stream.test.ts`.
9. **S9.** The preview create applies RF12 (SNOWFLAKE `replyToId`, persona no reply, `repliedUser:false`). Streaming is refused when `mentionUserIds` is non-empty.
   **Test:** `discord/port.stream.test.ts`.
10. **S10.** The halt check uses the loop's `AgentDeps['halt']` predicate before every create, edit and typing call, and a throw counts as halted. The stopped and alert edits replace the whole content.
    **Tests:** `agents/scheduler.stream.test.ts`; existing `agents/scheduler.test.ts` halt cases unchanged when no preview.
11. **S11.** Slot release, timer clear and one fixed best-effort edit happen in `finally` on every exit path, including a throw from `run()`.
    **Test:** `agents/scheduler.stream.test.ts`.
12. **S12.** There is an explicit restart signal (a new chunk type or a segment call) for: claude-code-local internal retry, a new CLI structured-output block, Claude `message_start` after the first, and the SDK retry. It has its own branch in `agents/call.ts`.
    **Tests:** `agents/call.stream.test.ts`, `providers/claude-code-local/local.test.ts` (timeout then retry), `providers/claude/claude.test.ts`.
13. **S13.** A hard edit cap per stream. A 10008 mid-stream freezes with no new create, and finalize makes at most one fresh post.
    **Test:** `discord/port.stream.test.ts`.
14. **S14.** Typing goes through `resolve()` (denylist, persona room), is heads only, stops on halt, preview or end, and has a maximum duration.
    **Test:** `discord/port.stream.test.ts`.
15. **S15.** Stream failures log `code`/`status` only, never the error object.
    **Test:** `discord/port.stream.test.ts`, which captures the emitted log line (global rule 19).
16. **S16.** The probe (`probe-local-cli.mjs`) and guard.ts compute `argv_sha256=` with one shared exported function. It hashes `buildArgs` on one fixed canonical request (fixed local model id, no `effort`, placeholder system-file path), so per-request `--model=`/`--effort=` values never change the digest. guard.ts refuses a missing or mismatching value (old pins are refused). A static test asserts `--safe-mode`, `--setting-sources=`, `--tools=`, `--strict-mcp-config`, `--mcp-config={"mcpServers":{}}`, `--disallowed-tools=`, `--no-session-persistence`, `--disable-slash-commands` and `--permission-prompts=none` are still present.
    **Tests:** `providers/claude-code-local/guard.test.ts`, `providers/claude-code-local/protocol.test.ts`.
17. **S17.** `probe-local-cli.mjs check` uses the provider's stream parser and prints only the event-type sequence and field names, never values. If the pinned CLI does not emit `input_json_delta` for the structured-output block, claude-code-local gets typing only and never falls back to `assistant` snapshots or `text_delta`. The probe fails on planted names, MCP servers or extra tools in the init event. The owner re-runs `bash scripts/probe-local-cli.sh --yes` after the build, and the new pin is required before go-live.
    **Gate 2 evidence:** `claude --help` lines of the pinned binary for `--output-format`, `--include-partial-messages` and `--verbose`, plus the probe PASS output (booleans only; never print CLI output).
    **Test:** `scripts/local-mode.test.ts`.
18. **S18.** Final local blocks come only from the terminal `result` event via unchanged `interpretResponse` schemas. Only `input_json_delta` of the structured-output block (local) or of a `tool_use` block (Claude) feeds deltas. thinking, text, init, snapshot and hook events are dropped and never logged.
    **Tests:** `providers/claude-code-local/protocol.test.ts` (same final blocks as the buffered path for the existing fixtures; a stream containing `thinking_delta` with a marker never yields it), `providers/claude/claude.test.ts` (`streamToolInput` absent gives an identical chunk sequence).
19. **S19.** Byte-level line splitting or StringDecoder. Delta lines are not retained. Retained bytes stay ≤ `OUTPUT_CAP_BYTES`, with a measured total cap and a per-line cap checked before parse. `timeoutMs`, killGroup, the stderr cap and `childEnv` are unchanged.
    **Test:** `providers/claude-code-local/local.test.ts` (a Thai character split across chunks, one 200 KB line, total overflow, kill mid-stream).
20. **S20.** The extractor rules of section 8, including local key-order and duplicate-name handling.
    **Test:** `agents/stream-extract.test.ts` (escaped key, duplicate body, nested body, non-string body, control characters, 200 KB delta, 20,000-deep nesting, split `\uXXXX`, surrogate pair split across deltas, lone surrogate, `input` before `name`, duplicate `name`, `respond` not in `req.tools`).
21. **S21.** `.edit(` and `sendTyping` stay in `discord/port.ts`, and `discord/perm-apply.static.test.ts` is unchanged (no allowlist edit). If streaming code lives in a new file, that file contains no write verb.
22. **S22.** Eligibility is enforced in code exactly as listed (human author, ask/voice, admin/mod, warroom, `wr`, caps), and `stream.enabled` read errors count as off.
    **Test:** `agents/scheduler.stream.test.ts`. The existing `agents/scheduler.test.ts` checks around `:122` and `:458` hold with no preview.

## 12. Residual risks (owner to accept in writing)

- **R-1.** Text the model wrote before a refusal or provider failure was visible until the replacing edit, and copies persist in any third-party bot's `MESSAGE_UPDATE` log.
- **R-2.** A preview can claim an action before the code-written `awaiting approval` footer appears at finalize.
- **R-3.** A process crash mid-stream leaves a partial, unrecorded (tainted, non-answer) preview with ` …`. There is no delete and no boot cleanup.
- **R-4.** `stream.enabled` is admin-console and `config_propose` writable (configRisk false). Enabling it only changes timing, not content rules.

## 13. Files audited (md5 at end of review)

```
29e450c32891bf8ebca844fd93664483 docs/superpowers/specs/2026-11-08-reply-streaming-design.md
50b8bdb2e55a41761c97fd1ec7e54bd0 providers/claude/index.ts
4ea85dde08faea6e60a29d600b7dd4a9 providers/claude/request.ts
f2666fe53e470994f5213d0555472027 providers/claude-code-local/index.ts
989768ec5765f5dfd1d27298df4fadb3 providers/claude-code-local/protocol.ts
6c35d9d9118134ac48f94b595123028f providers/claude-code-local/spawn.ts
c002a19b493fb5204b9bde883ce446f5 providers/claude-code-local/guard.ts
89b2429e5d8dfa08bed6fd56a3954338 scripts/probe-local-cli.sh
fe601f63dad70e54263a87c04197075d scripts/probe-local-cli.mjs
e12adf8e57709e0e3b6d08bf2e41b352 providers/types.ts
923e989861e895fce18e1c24ccafe25a agents/call.ts
3d020bf0e6445e19c78fd8c0a044ecb1 agents/loop.ts
c979c764a68c6acca04ed19c9b0b88d2 agents/scheduler.ts
98ad8262711f0b33426d5813b3bd9f22 agents/payload.ts
97a25e68e8675b2b25280b9f84af0fd7 agents/context.ts
044e32dfe5176b282a6a9d6e795f58d4 tools/builtin/respond.ts
9b2bc2a1623efbaa1ca8f1f4c85edfde discord/port.ts
5fff940c6f8900e7dd3697acd3bae721 discord/webhooks.ts
0d6c1cc152122f5f337a94f93c4a0d10 discord/clients.ts
0fd5e40be2fcdf5430f11bb6b047392b company/router.ts
77ba8bd583ea95d964817c816e87d456 company/handles.ts
9b518cd3a4eff06ca2cca0402ec8f257 core/logger.ts
174f3d86b55fc74ef4c746e405275dca discord/perm-apply.static.test.ts
6f96fce54d80bd0bb1e92448a5d3862e prompts/protected.ts
d321d929edad302d6db1651ff1e8c71f discord/inbound.ts
7cd784ce3cae719ad709c8d5cbb05bba discord/embeds/index.ts
40bb019cd935e851baf891b3e1068e64 app.ts
```

## Owner sign-off (2026-11-08, recorded by controller from the owner's answer in chat)
The owner ACCEPTS residual risks R-1 to R-4.
