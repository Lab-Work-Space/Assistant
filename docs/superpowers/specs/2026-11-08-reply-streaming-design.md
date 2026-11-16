# STREAM-1 — live reply streaming (spec)

Owner request 2026-11-08: "add streaming". Bot replies in Discord should appear progressively while the model writes. Owner decision on OQ-1 (2026-11-08): **stream on claude-code-local (the live provider for all heads) + Claude API + typing indicator for every bot**; Praw (Gemini) gets typing only (no answer-contract change). claude-code-local change needs a CLI re-probe after the edit. No migration.

## Facts (from code)
- F1 Final answers go through the `respond` tool (prompts/system/output.md:3); text chunks are fallback/discarded (agents/loop.ts textToPayload branch). Streaming = decode the `body` string of the first `respond` call's JSON input as it arrives.
- F2 Providers: Claude API already sends `eager_input_streaming: true` (providers/claude/request.ts:58) but providers/claude/index.ts buffers input_json_delta until content_block_stop. Gemini does not stream functionCall args (partialArgs unsupported) → typing only. claude-code-local buffers output and parses after exit (providers/claude-code-local/index.ts `yield* chunks`) → must switch to incremental parsing of the CLI's streaming JSON output (e.g. `--output-format stream-json` with partial messages / input_json deltas, whichever the pinned CLI 2.1.319 supports — verify against the CLI and the probe script scripts/probe-local-cli.sh; keep `--safe-mode`, `--setting-sources=`; the probe pin must be updated deliberately and the owner re-runs `bash scripts/probe-local-cli.sh --yes`).
- Live config (2026-11-08): provider.default = claude-code-local / local/claude-sonnet-5-5 for all heads; praw = gemini / gemini-3.8-flash.
- F3 Only Events.MessageCreate routes (discord/clients.ts:121); edits never route/ping. Message delete is banned by the static guard (discord/perm-apply.static.test.ts); `.edit(` only in discord/port.ts. → no placeholder that gets deleted: preview created on first committed body text, every ending is an edit.

## Eligibility (checked once before the run in scheduler.runMessage, the `this.deliver(r.actor, sourceOf(msg), ...)` call)
- cfg `stream.enabled === true` (live; read error = off).
- msg.author.kind === 'human' and `ask` absent or `ask.deliver === true` (excludes voice, voice/chat/pipeline.ts:138).
- Not admin/mod run (handleAdmin/handleMod), not warroom (AI_WARROOM_CHANNEL_ID), not `wr` (bot talk / meeting).
- Routing-neutral author: if the target thread has a task whose requester is non-human and equals the actor while the owner is someone else → no stream (router authorIsRequester would route the preview create).
- ≤1 active stream per channel/thread (STREAM_PER_CHANNEL=1), STREAM_MAX_ACTIVE=4 per process; over cap → typing only, final posted as today.
- Out of scope: roll-ups, runOwner (pings sourceUserId), cards, TEAMTALK H1–H4/room lines/board, DMs, postFile, voice.
- Typing indicator applies to ALL eligible runs of head bots incl. Praw/Gemini, even without deltas.

## Happy path
1. Before first provider call: stream.typing() — head bots via channel.sendTyping(), refreshed every 8 s until first preview or end. Personas none (webhooks can't type).
2. Loop sets `req.streamToolInput = true`. Claude API and claude-code-local providers yield `{type:'tool_input_delta', index, name, partialJson}` for tool_use blocks. call.ts forwards to onDelta only, never into blocks; a throwing sink is ignored.
3. agents/stream-extract.ts: strict incremental state machine decoding only the top-level `"body"` string of the FIRST `respond` block in a call; handles \n, \", \\, \uXXXX, surrogate pairs split across deltas; any anomaly (second body key, invalid JSON so far) freezes that block.
4. committable(raw, secrets) gives displayable prefix. Preview created when committed ≥40 chars or 1.2 s after first body delta. Posted via `compose(actor, target, {type:'chat', body: committed + ' …', noHandles:true}, {}, true)` (redaction, neutralise, defang, final defangMessage throw). First send carries reply = msg.id (heads only) with repliedUser:false.
5. Edits: ≤1 in flight, every EDIT_INTERVAL_MS=1500 and only when committed grew ≥24 chars; latest wins. Bot path editBot; persona path webhooks.edit; parse [] on both.
6. One message only: preview stops at 1900 chars + " …"; rest at finalize.
7. Finalize: finish() payload (footer, awaiting lines) built with the same compose(actor, target, p, {}, true) as post. Fresh-post rule: if any built content contains `<@` (a live mention that must route) → today's port.post(...) with replyToId and edit preview to fixed `-# (answer posted below)`. Otherwise edit preview to msgs[0], send msgs[1..] via sendAll/webhooks.send. Return every id; scheduler records provenance for each with answer=true (same record as post). Unrecorded preview id counts as tainted (fail-safe).

## Alternate / exception flows (each = final edit of an existing preview; no preview → today's behaviour)
Tool-only turn → nothing created. viewHint retry / invalid respond input → next respond overwrites preview (each provider call a new segment). Halt mid-stream → previews stop (halt.isHalted() before every edit, fail-closed); finalizeStopped('-# Stopped: the company is halted.') one code-written edit. Provider failure/refusal/budget or meter stop/turn limit → finalize with alert payload (plain; respond is the only terminal tool). 10008 on preview edit → fresh port.post. 50001/50013/10015 → freeze, try edit then port.post; failure uses existing "post (bot reply dropped)" incident. 429 or latency >3 s → interval doubles to ≤6000 ms; 3 failures in a row → freeze, finalize still runs. stream.enabled off mid-run → previews stop, finalize normal.

## Contracts
- providers/types.ts: `ChatRequest.streamToolInput?: boolean` (opt-in; existing chunk-sequence tests unchanged); `ChatChunk |= { type:'tool_input_delta'; index:number; name:string; partialJson:string }`. Gemini ignores it.
- agents/call.ts `callProvider(..., onDelta?)`; explicit `else if (c.type === 'tool_input_delta')` branch (REQUIRED: otherwise last `else reason = c.reason` treats unknown chunk as stop).
- `AgentTrigger.stream?: ReplyStreamSink` { segment(), delta(c), typing() }; loop calls segment() before each provider call.
- `DiscordPort.openReplyStream(actor, target, { replyToId? }): ReplyStream | null` (null = over cap / persona outside its room). ReplyStream { typing(); update(committed); finalize(p, popts: Pick<PostOptions,'replyToId'|'onSent'>): Promise<string|null>; finalizeStopped(line): Promise<void>; active(): boolean }.
- Config `stream.enabled: z.boolean()` default true; joins ADMIN_CONFIG_KEYS automatically (UX switch, configRisk false) — acceptable.
- Code constants: EDIT_INTERVAL_MS=1500, EDIT_MAX_INTERVAL_MS=6000, MIN_FIRST_CHARS=40, FIRST_WAIT_MS=1200, MIN_DELTA=24, PREVIEW_MAX=1900, HOLDBACK=64, STREAM_PER_CHANNEL=1, STREAM_MAX_ACTIVE=4, TYPING_REFRESH_MS=8000.
- No storage. Budget/settle/cost unchanged. Audit unchanged; one info log per finalize with outcome edited|fresh|gone|halted|alert only.
- claude-code-local: streaming parse must keep every existing guard (providers/claude-code-local/guard.ts, spawn.ts limits, output size caps, timeouts, the MEMORY canary/--safe-mode behaviour) and produce the same final blocks as today; the probe script/pin updated accordingly.

## Security (Gate 1)
- Same pipeline on every edit: compose() over the whole committed body (redactPayload → neutralise, defangHandles, defangMessage throw); a throw skips that edit; parse [] ; previews never create `<@id>`.
- Holdback committable on raw accumulated body, then redactText(prefix, secrets): (a) cut to ≤ len − HOLDBACK; (b) cut back before trailing run of `[A-Za-z0-9_\-.=+/:?&;%~]`; (c) open `-----BEGIN` without END → cut before BEGIN; (d) hold last line containing a tab; (e) cut before trailing `Bot`/`Basic`/`Cookie:` followed by held run; (f) for each literal secret, if a suffix (≥4) of the prefix equals a prefix of the literal, cut before it. Patterns: core/logger.ts TEXT_PATTERNS.
- Only the respond body is shown; text before tool calls and other tools' inputs never shown.
- Routing: previews defanged from routing-neutral authors only; live mention in final goes out as fresh create; edits never ping.
- Provenance at finalize for every id, answer=true only there; until then preview = tainted non-answer (human reply not routed by RF1) — accepted.
- Halt fail-closed before every edit; only one fixed post-halt line.
- Limits as above; one edit in flight; delete stays banned; no static-guard allowlist change.

## Tests
Secret split across deltas (property test over every TEXT_PATTERNS fixture and literal at every split point; no edit shows ≥8 chars of the secret); `<@id>`/`@everyone`/`@CTO` mid-stream never live in an edit, final routes only via fresh post; >2000 chars (preview ≤1900, final split); tool-only turn leaves no message; viewHint retry reuses preview; halt mid-stream fixed line only; provider failure/budget stop → alert; 429 backoff + freeze after 3; 10008 → fresh post; extractor escapes/surrogates/malformed JSON; two streams same channel (second no preview); stream.enabled false live; preview create fires no route; persona webhook path; streamToolInput absent = identical chunk sequence; claude-code-local streaming parser: same final blocks as buffered path, guards/caps/timeouts kept, partial/garbled lines handled, process killed mid-stream; typing on Gemini/Praw runs. Existing agents/scheduler.test.ts:122 and :458 hold when no preview; with preview exactly one fixed edit.

## Defaults
Pointer line `-# (answer posted below)`; halt may make the one fixed edit; personas stream via webhook edits without typing; preview never grows past the first message; runOwner later phase; config_propose may write stream.enabled.
