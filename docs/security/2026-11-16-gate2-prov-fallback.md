---
title: "Gate 2 - R8 PROV-FALLBACK (Claude API backup when the CLI quota runs out)"
gate: 2
spec: docs/superpowers/specs/2026-11-16-prov-fallback-design.md (incl. "Binding amendment (Gate 1, 2026-11-16)")
gate1: docs/security/2026-11-16-gate1-prov-fallback.md
range: 76a29cc..6bd93db (backend b94bc37..1e20038, plus Gate 2 fixes ba9f0e7..6bd93db)
status: "CONDITIONAL_APPROVE"
date: 2026-11-16
---

# Gate 2: R8 PROV-FALLBACK

## Verdict

**CONDITIONAL_APPROVE.**
- **Deploy with the switch off: allowed now.** No open finding is tagged "before deploy with switch off".
- **Turning `provider.fallback.enabled` on** needs:
  - the Low fix G2-PV-04;
  - the owner's acknowledgment in G2-PV-09;
  - the owner steps in PV-C05 and PV-C11.

Every Gate 1 condition was checked against the code, not against the developer's notes. Three findings were small and isolated, so they were fixed in this audit: G2-PV-01, G2-PV-02 and G2-PV-03. Each was fixed test first, with the test and the fix in separate commits.

Method:
- Static review of `76a29cc..HEAD`.
- The `@anthropic-ai/sdk` 1.3.0 constructor in `node_modules/@anthropic-ai/sdk/client.js` and `internal/tracing.js`.
- These unit test files:
  - `providers/route.test.ts`, `route.guard.test.ts`, `fallback-gate.test.ts`, `fallback-canary.test.ts`, `fallback-text.test.ts`, `registry.test.ts`
  - `providers/claude/*`
  - `providers/claude-code-local/local.test.ts`
  - `agents/loop/loop.fallback.test.ts`
  - `agents/scheduler/scheduler.fallback.test.ts`
  - `agents/call/call.fallback.test.ts`
  - `governance/quota/quota.fallback.test.ts`
  - `governance/judge-call.fallback.test.ts`
  - `knowledge/small.fallback.test.ts`
  - `admin/keys.fallback.test.ts`
  - `discord/commands/bot.fallback.test.ts`, `bot.test.ts`, `settings.test.ts`
  - `admin/tools.test.ts`
- Results: all green; `npx tsc --noEmit` clean.
- Not run (left to the caller): the full suite and the integration stack (`tests/integration/local-mode.int.test.ts` G5/G5b/G5c, `prov-fallback.int.test.ts`).
- Not touched: the live DB, launchd, the containers and the env files.

## 1. Gate 1 conditions

| Id | Status | Evidence (content anchors) |
| :-- | :-- | :-- |
| PV-C01 | **Met** (residual G2-PV-05) | See section 2. `localModeOf` (guard.ts) feeds `ProviderRegistry({ defaultUsable })`. `resolve` throws "provider.default is not set to a valid value" whenever the selection needs the default and `cfg.hasRow('provider.default')` is false. `hasRow` reads `versions`, which `apply` sets only for a row that passes the schema ("invalid config row ignored" returns before `versions.set`). The seed runs when "`localMode && (await new ConfigRepo(pool).get('provider.default')) === null`", whatever `local?.ok` or the key say. `providerReady` = `defaultBacked() && providers.has(...)`. |
| PV-C02 | **Met** | `resolveEffective` builds `held` as "`{ ...primary, route: 'held' }`", so a held route never carries `claude`. The loop does "`if (resolved.route === 'held') return finish(...WAITS_TEXT)`" before any status change or call. `apiBlocked()` runs before every loop call and before the wrap-up call ("the wrap-up is a call too"). G4 (`providers/route.guard.test.ts`) is an allowlist (`route.ts`, `registry.ts`, `metered.ts`) for `providers.resolve(`, `providers.get(`, `.get('claude')` and `FALLBACK_PROVIDER`. A grep found no other `.resolve(sel`, `.has('claude')` or registry use. Bypasses the regex does not catch (rule 6): an alias (`const r = deps.providers; r.resolve(`), destructuring (`const { resolve } = ...`), bracket access (`providers['resolve'](`) and an unrelated variable name for the registry. None exist today. |
| PV-C03 | **Met** | `QuotaStore.arm(fromPublish)` calls `onHoldStart` only when "`starting && fromPublish`", where `starting = !this.wasHeld`; `load()` calls `arm(false)`. `Scheduler.reoffer` checks `holdUntil()`, then `routeOf(owner, taskId) === 'fallback'`, then `claimReoffer`, so a held or stale case never uses up the claim. Test: "eventRejected true but heldUntil null: no hold" leaves `runs` at length 1. |
| PV-C04 | **Met after G2-PV-01** | `buildParams` sends betas/fallbacks only for "`isSonnet(req.model) && req.route !== 'fallback'`", and the provider uses `client.messages` on the fallback route. `callCore` settles at `est` when "`req.route === 'fallback' && !aborted && ... diag === MID_STREAM_DIAG`". `toProviderError(err, started)` tags failures after `message_start`. G2-PV-01 closed the one throw after a billed stream that had no tag. An abort after the start already yields `usage()`. |
| PV-C05 | **Met in code**; owner step open | `FALLBACK_MODEL_IDS` holds only `'local/claude-sonnet-5-5' -> 'claude-sonnet-5-5'`, so Haiku is `null` and the route is `held`. The owner still re-checks the official pricing page on switch day. |
| PV-C06 | **Met** | `markFromError` maps "`if (s === 400) return { kind: 'task_400' }`". `reportFallback` marks only "`if (ctx.taskId !== undefined)`" and returns `'wait'` either way. The loop calls `waitsStop()` (requeue) before `block(...'error')`, so a 400 never blocks and never reaches the healer. `apiOff` is set only for 401/402/403. A 429 after `coolUntil` sets a new cool-down; there is no block. Only status numbers are read. |
| PV-C07 | **Met** (residual G2-PV-06) | `buildClientOptions` = "`{ apiKey, maxRetries: 3, baseURL: API_BASE_URL, logLevel: 'off', authToken: null }`". SDK 1.3.0 behaviour checked: an explicit `baseURL` wins over the default parameter that reads `ANTHROPIC_BASE_URL` and sets `_baseURLIsExplicit`; `options.logLevel` is parsed before `ANTHROPIC_LOG`; a passed `apiKey` means "the environment is not read for another" credential. |
| PV-C08 | **Met** | The key is in `HANDLER_KEYS`. The test reads `admin/ops.ts` and finds no `provider.fallback` or `planFallbackEnabled`. `isAdminConfigKey` is false, and `doProposeConfig` refuses keys that are not admin keys, so no card or config_propose path reaches it. `fallbackEnabled` returns false unless "`cfg.listenerHealthy() === true`". The weekly summary line reads `cfg.get` directly, but only to decide whether to show a number. |
| PV-C09 | **Met** | `reportFallback` is the single mapper. Callers: the loop (`fbx.report`), `JudgeCaller.call` ("`if (onApi) reportFallback(...)`") and `smallCall` (same). |
| PV-C10 | **Met** | G9 (`providers/fallback-canary.test.ts`) builds a real `Anthropic.APIError` carrying a canary. For 400, 401, 429 and 500 it captures the real `createLogger` stream, the `IncidentReporter` posts, the audit rows and the alert bodies. G11 ("an untrustedOutput tool result reaches the claude provider wrapped and the run is tainted") is in `agents/loop/loop.fallback.test.ts`. |
| PV-C11 | **Open (owner)** | Before the switch goes on: budget rows 50/10/5; a Console spend limit; a separate dev-job key; the key entered through the dashboard or `set-tokens.sh`; `/usage` shows "Backup: off" with the key loaded; one hold-free day with zero `claude` `llm.call` rows. |
| PV-F01 | **Met**, sibling closed by G2-PV-03 | `planBotModel` returns "Only the praw department uses Gemini." for `gemini` when the department is not `praw`, and sets "`risk: provider === METERED_CLAUDE_PROVIDER`". Persona rows are created with "`model: null, provider: null`" (`personaCreate`), and no persona model writer exists. |

## 2. Rulings on the backend's deviations

1. **`/settings provider.fallback.enabled` is a direct set plus a risk notice, not a card.** Acceptable from a security view, with an owner acknowledgment (G2-PV-09). PV-C08 (binding) forbids an `AdminOp` for this key. The only other card path, `proposeConfig`, refuses keys that are not admin config keys. A card would therefore need new plumbing, which the binding conditions effectively rule out. The direct set is slash-only, checks the live Bot Admin role, is audited (`config.set`) and posts "Setting changed (risk)" to #bot-log (`settings.notice` is wired in app.ts). Residual: any Bot Admin, not only the LW Admin, can turn on metered spend. That spend stays inside the budget rows, whose raises are cards, and inside the Console limit.
2. **`onHoldStart` re-offers only when the switch is on, and never from `load()`.** Acceptable. After a restart during a hold, work waits until a new todo event, a gate mark expires or the hold ends. That fails safe: no spend.
3. **`planProviderDefault` could set `gemini`.** Closed now under global rule 8 (fix the sibling of a shared policy): G2-PV-03. The default serves every department that has no row of its own, so a Gemini default breaks "only praw on Gemini".
4. **PV-C01 mechanism.** It closes both Gate 1 holes:
   - (a) First boot after a reset with the guard failing: the flag outside a container means local mode, so the seed writes the local row. The local provider is not registered, so `providerReady` is false and the app idles with the incident. There are zero `claude` calls (G5b).
   - (b) An invalid row: `apply` ignores it, so `hasRow` is false. `resolve` throws for every selection that needs the default, so the app idles. The row is never overwritten (G5c).
   - A row that turns invalid while running keeps the last valid value: `apply` returns before touching `versions` or `cache`.
   - A row deleted and notified at runtime makes `hasRow` false, so the app idles. There is an integration test for this.
   - **Can it brick the VPS?** Not as deployed. The VPS runs the app in Docker (`deploy/docker-compose.yml`, `image: lw-local/apps-assistant`), where `/.dockerenv` makes `inContainer` non-null, so `localModeOf` is false and nothing changes there (integration test "the VPS path is unchanged").
   - Residual G2-PV-05 covers a host outside a container with the flag in an env file.
5. **`ANTHROPIC_CUSTOM_HEADERS` is still read by the SDK.** Accepted as a residual. The SDK also reads `ANTHROPIC_OPEN_TELEMETRY*`. See G2-PV-06.
6. **A halt on the fallback route stops as `halted`, not as a requeue.** Acceptable. This is the same path as the primary route. Halt recovery owns `doing` tasks, and no call is made after the halt check.
7. **Failed fallback calls do not `noteUsed()`.** Acceptable as Info (G2-PV-08). The spend is still settled and visible in `/usage` and `spend_days`. Only the A2 line can leave it out.
8. **Gate marks end at the next UTC day, but spend figures use the schedule-timezone day.** Acceptable as Info (G2-PV-07). The figures are display only, and every cap and mark uses UTC (`isoDay`).
9. **`FallbackGate.onExpire` timers call `resumeHeld()` while the hold is on.**
   - No hot loop: each timer is one-shot and `unref`'d. `schedule()` clears the timer it replaces, the day timer is armed only when none exists, and `clear()` (hold end) cancels both.
   - Burst: one re-offer per expiry. A repeated 429 re-arms the 5-minute cool-down on the first failure. After that, `mayRunAs`, `isHeld` and the loop's `apiBlocked()` stop further starts. So each cycle sends at most about `limits.concurrency` (4) unbilled calls. The UTC-midnight re-offer is bounded by the reset budget rows.
   - One defect: tasks held by a per-task 400 are re-run and re-posted on every expiry (G2-PV-04).
10. **A route held at loop start leaves the task `todo` without `requeued`.** Acceptable. Nothing was moved to `doing`, and `resumeHeld`, an expiry or the hold end offers it again. A conversation task that is already `doing` stays as it is. That is the same as the existing scheduler gate ("a task left behind here stays as it was").

## 3. Cross-cutting checks

- **The API key never reaches a child, container, log, prompt or alert.**
  - No new env reader was added except `ALLOW_LOCAL_PROVIDERS` in app.ts.
  - The CLI child allowlist test (`local.test.ts`) is green.
  - Every alert builder in `providers/fallback-text.ts` takes numbers or code-built strings only (`usd()`, `count()`, `http()`).
  - `providerFault` and `failureInfo` keep only the name and status for `claude`.
  - G9 is green.
- **Praw is never on `claude`.** Step 2 of `resolveEffective` returns a non-local primary, `FALLBACK_EXCLUDED_DEPTS` covers praw, and an empty or missing `deptId` gives `held`. `smallCall` without a profile has `deptId ''`, so the route is `held`.
- **Non-praw work is never on `gemini`.** The fallback target is the constant `'claude'`. `planBotModel` and now `planProviderDefault` refuse Gemini outside praw.
- **No main work on the API while the CLI is healthy.** `resolveEffective` returns the primary while `heldUntil()` is null. PV-C01 removes the code-default path in local mode.
- **SDK dependency unchanged.** `git diff 76a29cc..HEAD -- package.json package-lock.json` is empty, and `@anthropic-ai/sdk` is 1.3.0.

## 4. Findings

| Id | Sev | Where (anchor) | Scenario | Fix | Tag |
| :-- | :-- | :-- | :-- | :-- | :-- |
| G2-PV-01 | Medium | `providers/claude/index.ts` `chat`, "`throw new ProviderError('model produced unparseable tool input'`" | A fallback call streams a full `tool_use` message (billed), then the JSON fails to parse. The throw comes before `yield usage()` and carried no diag, so `callCore` **released the reservation at $0** (a PV-C04 gap). This repeats once per affected task, and then the task blocks. | **Fixed:** the error carries `diag: MID_STREAM_DIAG` when `started`, so the fallback route settles at the estimate. The VPS meter is unchanged (the diag only acts when `route === 'fallback'`, and `providerFault` drops it for non-local providers). Commits `ba9f0e7` (test) and `84f8ec0` (fix). | before the switch goes on (fixed) |
| G2-PV-02 | Low | `providers/fallback-gate.ts` `mark`, case `'task_400'` used `refusedAlerted` | Rule 10: anyone who can talk to a bot can cause a 400 (for example an oversized prompt). The first per-task 400 used up the shared A3 claim, so a later 401/403 (backup off for **everyone**) posted no A3. The owner would only see the audit row. | **Fixed:** a separate `taskRefusedAlerted` claim, reset in `clear()`. Commits `ff895e0` (test) and `5272fa7` (fix). | before the switch goes on (fixed) |
| G2-PV-03 | Low | `discord/commands/plans.ts` `planProviderDefault` | An LW Admin confirms a card (a slash command or the admin-console model's `provider_default` op) that sets the company default to `gemini`. Every department without its own row, which is all of them in local mode, moves to Gemini, against the owner rule. | **Fixed:** "`if (provider === GEMINI_PROVIDER) return { error: 'Only the praw department uses Gemini; ...' }`". Integration fixtures insert the row directly and are unaffected. Commits `582ed1d` (test) and `6bd93db` (fix). | may follow (fixed now) |
| G2-PV-04 | Low | `agents/scheduler/scheduler.ts` `exclusive` then `mayRunAs(who)` then `isHeld(actor)` then "`routeOf(actor)`" (no `taskId`); `resumeHeld` "`for (const t of await this.d.tasks.listByStatus('todo')) void this.onTaskReady(t.id)`" | A task held by a per-task 400 stays `todo`. Every `onExpire` (each 5-minute cool-down during a 429 storm, each UTC midnight) and every hold start re-offers it. The scheduler gate does not see `taskOut`, so it starts the run. The loop resolves with `taskId`, gets `held`, and posts the "waits" alert in the task thread again. No call and no spend, but a user can trigger repeated posts (up to about 12 an hour per task during a 429 storm). | Pass the task id into the gate for task runs: `isHeld(actor, taskId)` calls `routeOf(actor, taskId)`, with `exclusive` passing its `taskId`. Or skip ids that `FallbackGate` has in `taskOut` in `resumeHeld`. Add a test: a task_400 task plus `onExpire` gives no second run and no second post. Owner: backend. | before the switch goes on |
| G2-PV-05 | Low | `providers/claude-code-local/guard.ts` `localModeOf`: "`return i.guardOk \|\| (i.flag === '1' && !i.inContainer)`"; app.ts passes `process.env.ALLOW_LOCAL_PROVIDERS` | PV-C01 asked for "the same real-process-env input the guard reads". The guard also refuses a flag defined in an env file (`DEFINES_FLAG` over `envFilesOf`) and requires `darwin`; `localModeOf` does neither. On a host outside a container with `ALLOW_LOCAL_PROVIDERS=1` hand-added to an env file and no `provider.default` row, the seed writes `claude-code-local`, which is not registered, so all work idles until someone fixes the row. It fails safe for spend, and it is unreachable on the VPS (Docker) and on the Mac (the local-mode scripts strip or refuse the flag in `env.local`, per `scripts/local-mode.test.ts`). | Make `localModeOf` require the same flag provenance as `localProviderAllowed` (env-file refusal plus `platform === 'darwin'`), for example by having the guard return a `flagOk` field and using that instead of the raw env. Add a unit test. Owner: backend. | may follow |
| G2-PV-06 | Low | `@anthropic-ai/sdk` 1.3.0 `client.js` "`readEnv('ANTHROPIC_CUSTOM_HEADERS')`"; `internal/tracing.js` `optionFromEnv` (`ANTHROPIC_OPEN_TELEMETRY`, `..._TRACES_CONTENT_MODE`) | `--env-file` loads every line of the owner's env file. `ANTHROPIC_CUSTOM_HEADERS` adds request headers; the host is fixed, so it cannot redirect the key. Traces are on by default and use the global tracer provider from the installed `@opentelemetry/api`. If a future dependency registers a provider, `CONTENT_MODE=content` would put prompts into spans that bypass the masking logger. No provider is registered today. | Pass `openTelemetry: { traces: { enabled: false }, propagation: false }` (check the exact option shape against `resolveOpenTelemetryOptions`). Refuse `ANTHROPIC_CUSTOM_HEADERS` and `ANTHROPIC_OPEN_TELEMETRY*` at boot, or delete them from `process.env` before the client is built. Add a unit test like `client.test.ts`. Owner: backend. | may follow |
| G2-PV-07 | Info | app.ts `claudeSpendToday` ("`localDay(now(), cfg.get('schedule.timezone'))`"); the `/usage` "Backup:" line | The line puts spend for the schedule-timezone day next to a company cap counted on the UTC day. Near 07:00 Asia/Bangkok the two days differ, so the line can mislead the owner about headroom. The caps themselves are enforced correctly. | Label the figure ("today, local time") or read `budget_days` for the UTC day. | may follow |
| G2-PV-08 | Info | `providers/fallback-gate.ts` `reportFallback` (`noteUsed` only "`if (o.failed === undefined)`") | If every fallback call in an episode failed after the start (settled at the estimate), A2 leaves out "Claude API spend today". The spend is still recorded. | Call `noteUsed()` when the call's `costUsd > 0`, or always read the spend at the end of the episode. | may follow |
| G2-PV-09 | Low | `discord/commands/plans.ts` `planFallbackEnabled` (`risk: v === true`), via `handlerSet` `run` (direct `applyPlan` plus `settings.notice`) | Any Bot Admin can turn on metered API spend for every department except praw, without the LW Admin confirm that OQ7 expected. It is bounded by the budget rows (raises are cards), the Console spend limit, the audit row and the #bot-log notice. | Owner acknowledgment recorded in the deploy note (or a spec amendment) that the direct set is accepted under PV-C08. Otherwise, a later card path that adds no model-reachable `AdminOp`. | before the switch goes on |

## 5. Fixed in this audit

- `ba9f0e7` test, `84f8ec0` fix: G2-PV-01 (`providers/claude/index.ts`, `providers/claude/claude.fallback.test.ts`).
- `ff895e0` test, `5272fa7` fix: G2-PV-02 (`providers/fallback-gate.ts`, `providers/fallback-gate.test.ts`).
- `582ed1d` test, `6bd93db` fix: G2-PV-03 (`discord/commands/plans.ts`, `discord/commands/bot.fallback.test.ts`).

Re-scan after the fixes:
- No new validation refuses valid input: claude and local defaults still pass in the new test.
- The VPS request and meter are unchanged.
- `tsc` is clean, and the affected test files pass (claude provider 4/4, gate 19/19, plan files 41/41, canary, call and loop fallback).

## 6. Owner steps before the switch goes on

PV-C05 (official pricing re-check, recorded with date and figures), PV-C11 (all items), G2-PV-09 (acknowledgment), and the G2-PV-04 fix deployed.

## Missing context

- `<PROJECT_ROOT>/CLAUDE.md` and `<PROJECT_ROOT>/.claude/rules/` do not exist.
- The live DB was not queried, so the live rows (`provider.default`, budget, pricing) are as the spec states.
- The integration tests were not run by this audit; the caller runs them.

## Audited files (md5, taken at the end of the review, HEAD `6bd93db`)

```
d3e7bc07f9ff3cfa18a50bd555498b81 admin/keys.fallback.test.ts
9175259cdd2fcbcc44f4a303c1a8fcad admin/keys.ts
cd8cedfb38456a40dc593d5d154e5683 agents/call/call.fallback.test.ts
867ceceb153c69ae93cf23e7652fb505 agents/call/call.ts
4170262cfc301b817d5411253b9ef3a1 agents/loop/loop.fallback.test.ts
cbc02e7b92aa827855760fcc430d27fa agents/loop/loop.ts
0acfcea2ee89d4ae60a76d8c27e13bd3 agents/scheduler/scheduler.fallback.test.ts
3ef39e4ea7f88c037f6fe1fe107c13e8 agents/scheduler/scheduler.ts
8573b3712d412b8f6b1f738af9c966b6 app.ts
39a7003936b37ae3364dbd724ff053c4 config/defaults.ts
41ec151e86b649c0a26c746e89051b3d config/schema.ts
17764e71e7c8883a999437bce1195831 config/store.ts
0fffd20103f86795803445849c46d5a8 discord/commands/bot.fallback.test.ts
7e4de7c64cbbeff585c24f35b5673a15 discord/commands/plans.ts
f02de3cb2c3313cb38accab2202d884f discord/commands/settings.fallback.test.ts
e0be6eebb2da3f025993d558f14a5f10 discord/commands/settings.ts
4ba19d89d176554dc459566c0cdb4f4d discord/commands/types.ts
80e9108a1cb123cf5f06ba2772118a4f discord/commands/usage.fallback.test.ts
5df386a144008693d2571ee88ca83fb0 discord/commands/usage.ts
56205001bca3e21901b29087123943dd governance/ai-approver.ts
b58154aadd4e592737bb51d886280ae8 governance/budget.ts
066ff0f3e3bd6bf7ff58200852548f3a governance/judge-call.fallback.test.ts
28df7d0d7d84a56c1ab7eb6c796a6966 governance/judge-call.ts
0773659b1241fe3c6e61d9b65506b18a governance/quota/quota.fallback.test.ts
4c437a71c6079bd7030ffa2944ab7401 governance/quota/quota.ts
9813f54af7810c9804db5ebe96e28a00 governance/skill-judge.ts
c0394474ecc6bceb17160bc14b91f541 governance/spend/spend.fallback.test.ts
54f73efe7c545e9b1b5202ac5a11d728 governance/spend/spend.ts
9eb4eb8d365b9cd8f5296e1f45793353 governance/test-helpers.ts
3c581a405c4a5ec711be6216bfabaf62 knowledge/small.fallback.test.ts
c7d52cb3286bc78419c5cab82d834911 knowledge/small.ts
fcc5b659ac197406bd799500e4641a77 media/graph.test.ts
3e6438531d52912dd5e2c7c764ab802d providers/claude-code-local/guard.ts
60ee11714d6d0c3cd7fd58d3e0f1051b providers/claude-code-local/index.ts
1cc2e34b5dfdcdccb4334fdeecacd576 providers/claude-code-local/mode.test.ts
1322e0fb590f2dcbe93cac6280ac66d6 providers/claude-code-local/protocol.ts
19d3a45619693afd758a9f5537322d0c providers/claude/claude.fallback.test.ts
a83e3358bf2c1034e5eace67c195b896 providers/claude/client.test.ts
ca4eaee6ad9a908a98d8c83a46b5afb9 providers/claude/index.ts
034be2d94343e3a0fd51c89451455831 providers/claude/request.ts
45707c06e380ae09e57d663479d32083 providers/claude/tool-result.test.ts
41c19558b3a11430bbef445344c37bec providers/fallback-canary.test.ts
277a6a7e92292471be3d23089a98d5b1 providers/fallback-gate.test.ts
af4d188d4c2107408ccbbc8299ca1ca5 providers/fallback-gate.ts
f8971097a689f454f1cb2e8ba31ee6a0 providers/fallback-text.test.ts
0de4dec4f4cf8e0fdc9255bb4bc69aa5 providers/fallback-text.ts
3ce1e869921816095108b867dcd9810d providers/registry.test.ts
61ef17d293d1b5e71cfa004d9e9592a4 providers/registry.ts
0366589bf86dbe147ee8a64e0daae782 providers/route.guard.test.ts
ea2e328a1c1ae6a81fd6ebc91528858f providers/route.test.ts
99788d227fa92be801b2214419b97d78 providers/route.ts
416d8b51326d1be66b93c80d1e1d87aa providers/types.ts
658f6c751bc424432132a02fafbcb019 tests/integration/helpers.ts
d65438bb5be2cea5c4149a3a91253f96 tests/integration/local-mode.int.test.ts
8104f05b28675a3596af8815b7294037 tests/integration/prov-fallback.int.test.ts
```

Evidence files (unchanged in the range; rulings 1 and 4, PV-F01 and G2-PV-03 depend on them, so a change re-opens those rulings):

```
9167fada81af1e6767017e20576b216e admin/console.ts
be82f59a7ad38cc3339772b5cdba4357 admin/ops.ts
baf8e756b2d5a6123fa075b32bb457c6 deploy/docker-compose.yml
12c62cd4bb1aeb83a4aec052a5c023e5 discord/commands/persona.ts
848767b81164f4bfab1ce2b8a2685d0e providers/claude-code-local/local.test.ts
```

## Fix re-check (d1d94ed)

Range `3d379b3..d1d94ed`. Static review plus the four touched unit files (`scheduler.fallback`, `mode`, `env`, `client`: 46/46 pass). Full suites not run here (caller).

- **G2-PV-04: CLOSED.** `isHeld(actor, taskId?)` passes `taskId` to `routeOf`; `mayRunAs(actor, taskId?)` forwards it; all three `mayRunAs` calls in `exclusive` (`scheduler.ts:1879/1883/1891`) pass `taskId`. `resumeHeld` and `onExpire` both go through `onTaskReady -> runOwner -> exclusive`, so a task held after a per-task 400 is refused at the gate and does not re-run or re-alert. Other callers that omit `taskId` (`ask` :577, `keepRunnable` :734, `botTurn` :808, `healWake` :2380, `retroStart` :2491, dashboard `held` app.ts:916, healer `isHeld` healer.ts:159/165) are message, decider or new-task paths with no task under a per-task hold, so actor-level is correct. Residual (Info): healer.ts:159 checks the blocked task's owner at actor level; if a per-task-held task could also be `blocked`, the healer could claim a retry, but the retry runs through `exclusive` and is refused there. No action needed.
- **G2-PV-05: CLOSED, live Mac not affected.** `localFlagOk` (guard.ts) requires the flag to be exactly `1`, darwin, and no env file in `envFilesOf(execArgv, home)` defining it; any read failure means false. `localModeOf = guardOk || (flagOk && !inContainer)`; app.ts wraps it in try/catch so it fails closed (false). The files checked are `~/.config/assistant/env.local` plus every `--env-file[-if-exists]` path in the main process's execArgv. `dev.sh:249/267/271` start main as `node --env-file="$ENVF"` (env.local) with `ALLOW_LOCAL_PROVIDERS=1` only in `CHILD_ENV` (`dev.sh:219`); `dev.sh:53` refuses env files that define it. `env.admin` goes only to the executor (`dev.sh:262`), not to main's execArgv; `env.local.bak-2026-11-01` and `backups/` are never checked (no glob). Checked file metadata only: env.local is `-rw------- pakawat.tan`, the same user the service runs as, so it is readable. The launchd plist env keys are `HOME`, `LANG`, `PATH` only. Result: `localFlagOk` is true on the live service, so local mode stays on.
- **G2-PV-06: CLOSED, no boot risk.** `buildClientOptions` sets `openTelemetry: { propagation: false, traces: { enabled: false } }`. `loadEnv` refuses a non-empty `ANTHROPIC_CUSTOM_HEADERS` or `ANTHROPIC_OPEN_TELEMETRY*` and the error names the key only, never the value. Live exposure: `grep -c` on env.local finds 0 matching lines; the plist sets none; `dev.sh` starts main with `env -i`, so shell exports cannot leak in. The refusal cannot brick the current deploy.

**Verdict: APPROVED.** G2-PV-04/05/06 are closed; there are no new findings and the remaining Info item needs no action.

## Addendum: ANTHROPIC-WS (0344154, bc07d1f), reviewed by the caller 2026-11-16

Optional `ANTHROPIC_WORKSPACE_ID` (strict `^wrkspc_[A-Za-z0-9]{10,64}$`, invalid value refuses boot naming only the key) is sent as SDK `defaultHeaders` `anthropic-workspace-id`, needed because the owner's key is organization-scoped (API answered 400 without it, 200 with the Default workspace id). The id is not a secret and is never logged. The R8 client hardening is unchanged (`baseURL` fixed, logging off, OpenTelemetry off, `ANTHROPIC_CUSTOM_HEADERS` still refused). Single construction site (`providers/claude/index.ts`); devjob untouched. No new finding.
