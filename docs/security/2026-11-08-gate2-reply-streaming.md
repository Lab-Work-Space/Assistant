---
title: "Gate 2 — STREAM-1 live reply streaming"
task_id: STREAM-1
gate: 2
status: CONDITIONAL_APPROVE
gate1: docs/security/2026-11-08-gate1-reply-streaming.md
spec: docs/superpowers/specs/2026-11-08-reply-streaming-design.md
migration: none
last_updated: 2026-11-08
---

# Gate 2 — STREAM-1 (code audit)

**Verdict: CONDITIONAL_APPROVE.** S1 to S22 are implemented and tested. Two small isolated fixes were made in this audit (G2S-01, G2S-02). Go-live needs three things:
- **C-1.** The owner accepts residual R-5 in writing.
- **C-2.** The owner runs the deploy steps in section 5 and gets a probe PASS whose real-CLI evidence matches S17.
- **C-3.** G2S-03 to G2S-05 are tracked for backend. They do not block go-live.

Code is cited by function name plus a quoted fragment. Line numbers are not used.

Verification run (2026-11-08, after both fixes):
- `npx tsc --noEmit -p tsconfig.json`: exit 0.
- Full unit suite (`vitest run --project unit`): 292 files, 3680 passed, 2 skipped, 0 failed.
- Targeted stream suites rerun after the fixes: `port.stream`, `scheduler.stream`, `protocol`, `local.stream`: 87/87.
- No int tests were run. STREAM-1 has no migration and no DB code.
- Test count change during the audit: the tester added three test-only files while this review ran. All of them use a scratch HOME and none touches `~/.config/assistant`. They were read briefly, and the two unit files pass 10/10. No source file changed during the review apart from the two fixes below.
  - `discord/port.stream.persona.qa.test.ts` (27368635b7e98df4694c1d6f5af5f9bf)
  - `providers/claude-code-local/guard.pin.qa.test.ts` (00d6f31380910d2b342825511dea5e85)
  - `tests/integration/stream-qa.int.test.ts` (f746cd8033e5a934a8fd72d8aedefab3, not run)

## 1. Condition-by-condition (S1 to S22)

| S | Result | Evidence (content anchor) |
| :--- | :--- | :--- |
| S1 | PASS | agents/stream-holdback.ts `safeLength`. The rules run in this order: (a) `raw.length - holdback`; (b) `while (cut > 0 && !/\s/.test(raw[cut - 1]!)) cut--` (Unicode `\s`, the same class the patterns use); (c) `PEM_BEGIN` without `PEM_END`; (d) `TAB_LINE_START`; (e) `COOKIE_TAIL` `/i`; (f) `literalTailStart` with suffix ≥ 1; then the surrogate check. They repeat to a fixpoint. Rule (b) makes every commit end on whitespace, so (f) only matters for literals that contain whitespace, and every other literal is covered by (b). Tests: `stream-holdback.test.ts` (every TEXT_PATTERNS class, 8 contexts incl. Thai-glued, NBSP and U+3000, every split, window 4, postgres `$!#*()` and Thai) and `stream-holdback.qa.test.ts` (400 random compositions; tab rows). My own adversarial run (Bot+NBSP, Basic+U+3000, closed PEM followed by an open one, `thought_signature :\n`, `token=` with a Thai value, `Cookie:`+NBSP) found no leak. One edge is listed as Info G2S-06. |
| S2 | PASS | `committable`: the cut to `PREVIEW_MAX` happens after `redactText`. Test: "S2: a secret straddling char 1900". |
| S3 | PASS | port `openStream` `secrets: () => opts.secrets ?? []`. app.ts passes the same array that `secrets.push(stored)` mutates. Test: "a literal pushed after openReplyStream is never shown". |
| S4 | PASS | port `io.preview` = `compose1({ type: 'chat', body: text, noHandles: true }, true)`. This runs redactPayload, then `defangHandles(neutralise())`, then the `defangMessage` throw. A throw is caught in `create`/`replace` ("preview skipped") and there is no fallback. editBot and webhooks.edit both force `allowedMentions: { parse: [] }`. |
| S5 | PASS | scheduler `openStream` `neutral()` is checked at open and passed as `canCreate`. Engine `create`: `ok = false` on a throw. Test: "re-evaluated right before the create". |
| S6 | PASS (see G2S-03) | deliverStreamed `onSent` → answer=true, `onCode` → answer=false. The engine's `finalize` finally records a non-answer preview. `release(recordLeft)` records tainted, non-answer. |
| S7 | PASS | port `io.final`: `fresh: card \|\| /<@/.test(text) \|\| handlesIn(text).length > 0` over `textOf` of all msgs. Tests cover offline and cannot-view heads. |
| S8 | PASS | `isCardPayload(p)` → fresh; plain = `!card`, as in `post()`. |
| S9 | PASS | `openStream` returns null when `mentionUserIds` is non-empty. RF12 is copied in `open` (SNOWFLAKE, persona no reply, `repliedUser:false`, `failIfNotExists:false`). |
| S10 | PASS after fix G2S-02 | scheduler `halted` = `this.d.agent.halt.isHalted()` (app.ts `agentHalt`), and a throw counts as halted. Engine: `tick`, `typing` loop, and now also right before every open/write. `finalizeStopped(HALT_LINE)` replaces the whole content. |
| S11 | PASS | runMessage `finally { conv.release(); await rs?.release(recordLeft); }`. `release` is idempotent, never throws, and frees the slot exactly once (`slotFreed`). |
| S12 | PASS | `stream_reset` chunk. Claude: on every `message_start`. Local: `if (i > 0) sink?.({ type: 'stream_reset' })`, a fresh `createStreamParser` per attempt, plus a reset on each `message_start` and each StructuredOutput `content_block_start`. call.ts has its own branch, and `else if (c.type === 'stop')`. The sink `reset()` drops the extractor. Engine `restart()` clears `raw`/`basis`. |
| S13 | PASS | `EDIT_CAP = 120` counts create plus edits. 10008 sets `gone` and freezes, so no create happens mid-stream. Finalize makes one fresh post. |
| S14 | PASS | typing goes through `resolve()` (denylist, thread check). `typingOk: !persona`. It stops at the first preview, on close or halt, and after `TYPING_MAX_MS`. |
| S15 | PASS | engine `codes(e)` keeps only `code`/`status`. finalize logs `{ outcome }` only. The deliverStreamed catch `log.error({ err, type })` has the same pattern as today's `post()` and holds final (not partial) content (pre-existing). |
| S16 | PASS | protocol `argvDigest()` (canonical request, placeholder path) is shared by guard.ts `field('argv_sha256')` (anchored `^k=`, so `sha256` cannot match `argv_sha256`) and probe `argv-digest`. A missing or mismatching value is refused with the re-run command. Static flag test in protocol.test.ts. |
| S17 | PASS in code; real-CLI evidence OUTSTANDING (C-2) | probe `check` uses `createStreamParser`. It prints only event types filtered by `safeName` and field names. It exits 1 when init is missing, when tools ≠ `['StructuredOutput']`, on any MCP server, or on a planted name. Hardened by G2S-01. |
| S18 | PASS | final blocks come only from `resultLine` → unchanged `interpretResponse`. Only StructuredOutput `input_json_delta` with `parent_tool_use_id` null reaches the sink. Claude: only `b.type === 'tool_use'`. Test with thinking/text/snapshot markers. |
| S19 | PASS (see G2S-05) | spawn `onLines` splits on byte `0x0a` and checks the per-line cap (1 MiB) and the total cap (16 MiB, measured 31x amplification) before `onLine`. Only `resultLine` (≤ 1 MiB) is retained. timeout, `killGroup`, the stderr cap and `childEnv` are unchanged. |
| S20 | PASS with residual R-5 | `RespondExtractor`: keys fully decoded; duplicate body/input/tool_calls before streaming freezes; name-before-input; `respondOffered`; depth 32; `BODY_LIMIT`; split `\u`; control characters freeze. |
| S21 | PASS | `perm-apply.static.test.ts` md5 is unchanged (174f3d86...). There are no write verbs in `reply-stream.ts`, `stream*.ts` (test "the engine and the sink files contain no write call"). |
| S22 | PASS | scheduler `openStream`: `stream.enabled !== true` or a throw → off; human only; `ask.deliver`; `wr`; warroom; `admin_console`; `isExcludedChannel` (a throw → off). |

Routing re-check: the router, handles, inbound, clients, webhooks and logger files are byte-identical to the Gate 1 md5s, so the Gate 1 routing analysis still holds. Edits never route, because only MessageCreate is subscribed.

## 2. Fixed in this audit

- **G2S-01 (Low, fixed).** `providers/claude-code-local/protocol.ts` `strings()` used `v.slice(0, 64)`. A planted skill, agent or command past entry 64 of an init array would pass the probe. The slice is removed (the array is bounded by the 1 MiB line cap). The probe now reads every entry. The change does not touch `buildArgs` or `argvDigest`.
- **G2S-02 (Low, fixed).** `discord/reply-stream.ts` `create`/`replace` checked halt before the async `io.preview` (compose → channel fetch) but not before the write. `if (this.halted()) return this.freeze();` was added right after each preview build. There is no regression test yet. Backend should add one where `halted()` flips to true while `io.preview` is pending, and assert that no open or write follows.

## 3. Findings (open)

| ID | Severity | Evidence | Description | Remediation | Owner |
| :--- | :--- | :--- | :--- | :--- | :--- |
| G2S-03 | Low | port `more`: `await sendAll(..., (x) => ids.push(...x)); return ids;`; engine `ids.push(...(await this.io.more(...)))` | If sending msgs[2..n] fails partway, the ids that were sent are lost and never recorded. This fails safe (unrecorded = tainted, non-answer), but it misses S6's "including on partial failure". | Pass an `onSent` callback through `StreamIO.more` (or return the ids in a finally) so the engine records the partial ids. Add a test. | backend |
| G2S-04 | Low | engine `finalize`: when `io.final` or `fresh()` throws, `point()` is skipped, and `release` returns early because `done` is set | After a failed final post, the preview keeps its partial text with " …" forever. No new leak (that text was already shown), but the message is stale and misleading. | In the `finalize` catch path, make a best-effort `INTERRUPTED` write before rethrowing. | backend |
| G2S-05 | Low (test reliability) | `providers/claude-code-local/local.test.ts` "timeout retries once", "onAttempt is awaited before each spawn", "escaped descendant…" | These failed under load in 2 of 13 runs (`seen=[1]`, so the first attempt was classified non-retryable). They passed in 11 later runs (8 sequential, 3 parallel) and in the full suite. Not reproduced, so the diagnosis is still unknown. These tests are on the kill/retry path that line mode touches. | Make the failing assertions print the ProviderError `diag`, run the file in a loop under CPU load, and fix the cause or the timing margin. | backend |
| G2S-06 | Info | `safeLength` rule (d) holds a tab line only once a tab has arrived | A Netscape cookie row whose FIRST field contains a space (`my domain\t...`) shows that first field before the first tab arrives. The cookie value is never shown. Real cookie domains have no whitespace. | None required. | — |
| G2S-07 | Info | README "Local mode" paragraph: "the provider can parse the real JSON result" | Stale: the probe now parses stream-json and checks the init event. | Fix the doc line. | backend |

## 4. Residual risk for owner acceptance

- **R-5 (new, Low).** Only text that is still part of a JSON object can show. In claude-code-local's structured output the model controls key order and can repeat keys. The extractor stops reading once the first `respond` item's `input` closes. So two cases stream as the answer and are then overridden by JSON.parse (last key wins):
  - `{"name":"respond","input":{"body":..},"name":"<other>"}`
  - a second top-level `"tool_calls"` after the first array

  A grep of `tools/` for `body: z.` finds only two other tools with a `body` input: `forum_post` (public) and `github_create_pull_request` (PR description, possibly a private repo). The preview is still fully redacted and defanged, it is model-authored text, and it is replaced by the real final or by `(reply interrupted)`. Extra keys (`"text"` next to `tool_calls`, extra item keys) also show briefly and then end in a malformed-output alert. That is R-1 class. A fix that holds the preview until the structured output closes would remove streaming for claude-code-local, so this is inherent to the design.

R-1 to R-4 are unchanged (accepted 2026-11-08).

## 5. Owner deploy steps (endorsed, in this order)

1. Accept R-5 in writing (C-1).
2. Stop the assistant service. The probe runs `npm run build` itself and rewrites `dist/`, which the live app runs from.
3. Close every other Claude Code session.
4. Run `bash scripts/probe-local-cli.sh --yes`. Go-live needs all of these:
   - The final `PASS:` line.
   - `structured-output input_json_delta events forwarded to the sink: yes`. If it says `no`, claude-code-local gets typing only. That is acceptable, but report it.
   - `init: tools are only the structured-output tool: true; MCP servers: 0; probe-planted names present: false`.
   - `~/.config/assistant/probe-ok` now contains an `argv_sha256=` line.
5. Record for the runbook (S17 evidence) the `claude --help` lines of the pinned binary for `--output-format`, `--include-partial-messages` and `--verbose`. Booleans and flag names only; never paste CLI output.
6. Start the service and check that the log has no "probe pin" refusal for claude-code-local.
7. Smoke test in a normal head channel: ask one question. Expect typing, then a preview with ` …`, then the final edit. Mention a head in the answer and expect a fresh post plus the `-# (answer posted below)` pointer.

Warning: if the app is restarted on a new `dist/` before step 4 passes, the old pin (no `argv_sha256`) is refused. The local provider then does not register, and every head on claude-code-local is unavailable until the probe passes. This fails closed by design. Rollback: set `stream.enabled` to false. Streaming stops, but the stream-json argv stays, so the new pin is still required.

## 6. Files audited (md5 at end of review, after the fixes)

```
bb6b4f11667e8fe70e536a6c3ed7b83b agents/stream-holdback.ts
e7100ba12e3dc706dec9e7a17e806cc5 agents/stream-extract.ts
bec0d61bc2344923b29b4088e3ae7e31 agents/stream.ts
888be72d875dd3a51ec62742fccb884f discord/reply-stream.ts
9bb58c17951f57bf74fb7aa13a738566 providers/types.ts
6a9abea29544c1fb8bfe1ad677eb79cf providers/claude/index.ts
fe7487bc36fece69a5021c83c96c7f1b agents/call.ts
af67a6cf1a967731a5ecedae29dde6c2 agents/loop.ts
24fe4367241c695e6161ec063be50c14 agents/scheduler.ts
d4701562e1b0b2d46eaac63169070e0f discord/port.ts
facf8fba4a20c598e95186643fb19e75 app.ts
e8614869f51a9aa90b5b0aff455ba8ec config/schema.ts
8546ffae4224805d1fce3b87be522696 config/defaults.ts
bde5d210586c96314cb7b451f6fe81db providers/claude-code-local/protocol.ts
f1b20f6aa09cd82a7d949386d145f0e4 providers/claude-code-local/spawn.ts
ef426c34b2d4582a92f8886f41003556 providers/claude-code-local/index.ts
4dc0cb6206b5ae34f62f48bb18bacfb2 providers/claude-code-local/guard.ts
098c8b196ae62ebd7b029aa9c1b9cfa1 scripts/probe-local-cli.sh
fcd2625e75632c8479fc8de6c33c63aa scripts/probe-local-cli.mjs
f174bc515fa72657377673f99df2ad27 README.md
517f260f05791c9a869f1ef53c43a6a8 tests/fakes/claude-cli.mjs
3f5c19dc32bdd6096ab1f2c4123860ae agents/stream-holdback.test.ts
6c99cee271f592929b9d367e21e368a3 agents/stream-holdback.qa.test.ts
c8497059c03a7f18a9b63481f3635449 agents/stream-extract.test.ts
fcf87fa0a98ab2ad962cb6f7e0f80421 agents/call.stream.test.ts
96ab0684bc1269a1f836aa0e9bdd9c74 agents/loop.stream.test.ts
d3bf3bf1224d85857ef5c87c9192d42e agents/scheduler.stream.test.ts
402c6dced2ffb366d6dce94e64057e74 discord/port.stream.test.ts
9a1a7bb0fe035b9551e0fc14afab31d8 providers/claude-code-local/local.stream.test.ts
ec94a5be2c6ffa9364dc3e7f3d205b51 providers/claude-code-local/local.test.ts
ecf93968cb27b24d2488e4f325cf38e4 providers/claude-code-local/protocol.test.ts
0a91fad683b65ef347eb5e71b5948b7b providers/claude-code-local/guard.test.ts
09be4ce0346685ce3523758fa83596bf providers/claude/claude.test.ts
810ae5a3d2b16ffb0b768d1a7f40aeb2 scripts/local-mode.test.ts
174f3d86b55fc74ef4c746e405275dca discord/perm-apply.static.test.ts
0fd5e40be2fcdf5430f11bb6b047392b company/router.ts
77ba8bd583ea95d964817c816e87d456 company/handles.ts
d321d929edad302d6db1651ff1e8c71f discord/inbound.ts
0d6c1cc152122f5f337a94f93c4a0d10 discord/clients.ts
5fff940c6f8900e7dd3697acd3bae721 discord/webhooks.ts
9b518cd3a4eff06ca2cca0402ec8f257 core/logger.ts
```

## Owner sign-off
R-5: pending.

## Owner sign-off (2026-11-08, recorded by controller from the owner's answer in chat)
C-1: the owner ACCEPTS residual R-5 (duplicate name / tool_calls key after input streams first, then the parsed final replaces it).
