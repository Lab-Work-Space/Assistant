---
title: "Gate 1 - R8 PROV-FALLBACK (Claude API backup when the CLI quota runs out)"
gate: 1
spec: docs/superpowers/specs/2026-11-16-prov-fallback-design.md (incl. "Open question resolutions")
plan: docs/plans/2026-11-12-growth-roadmap.md (row R8)
head: 33124b7
status: "CONDITIONAL_APPROVE"
date: 2026-11-16
---

# Gate 1: R8 PROV-FALLBACK

## Verdict

**CONDITIONAL_APPROVE.** The shape is sound:
- one route function, a hard-coded target (`'claude'`), a code-constant exclusion (`['praw']`) and fail-closed eligibility;
- requeue instead of switching mid-run, so local cap lifts never reach a metered run;
- the switch is a `HANDLER_KEYS` key, default off, with a card to turn it on;
- the API key stays in the app process. The CLI child gets an exact allowlist (`CHILD_ENV_KEYS = ['PATH','HOME','USER','LANG','TMPDIR']`, `providers/claude-code-local/spawn.ts`). `npx vitest run providers/claude-code-local/local.test.ts` passed 26/26 on this tree.

The spec's fix for the first-boot seed (§3.1) does not close the hazard (PV-C01, High). The server-side fallback beta and Haiku's long-prompt price make the meter under-count (PV-C04, PV-C05). These three conditions, plus the remaining ones below, must be met at the stated points.

Method: static review against the code at `33124b7`, plus one unit test file. Anthropic's pricing, errors and refusal-fallback pages were fetched on 2026-11-16 (platform.claude.com). Nothing was edited, run live or pushed.

## 1. Routing: can work reach the wrong provider?

| Path | Result |
| :-- | :-- |
| Non-praw head/persona to Gemini through R8 | No. Step 2 of `resolveEffective` returns the primary when it is not local; the fallback target is the constant `'claude'`. |
| Praw to the Claude API through R8 | No. Praw's dept row and prompt meta (`prompts/heads/praw.md` `model: gemini/gemini-3.8-flash`) give primary `gemini`, so step 2 returns it. A missing Gemini key makes `registry.resolve` throw, which means "Unavailable", never `claude`. A praw persona that resolves to local is `held` (excluded dept, `profile.deptId` from `resolveActor`). |
| Main work on the API while the CLI is healthy | Only through the seed hazard (PV-C01) or an explicit admin choice (OQ10). Otherwise step 3 (no hold) returns the local primary. |
| Seed hazard (`createApp`, "`if (!providers.has('claude') && (await new ConfigRepo(pool).get('provider.default')) === null)`") | The spec's fix (seed when `local?.ok` and the row is null) leaves two holes. **(a)** On the first boot after a data reset the guard fails, for example when a CLI update breaks the probe pin, which `scripts/dev.sh` warns about. With the key set, the code default `{claude, claude-sonnet-5-5}` (`config/defaults.ts` `'provider.default'`) then routes all main work to the API, whatever the switch says. **(b)** A row that is present but fails the schema is skipped by `ConfigStore.apply` ("invalid config row ignored"), so the code default applies and the seed (row null) never fires. See PV-C01. |
| Admin paths (pre-existing, human-confirmed) | `admin_op_propose` `bot_model` (`admin/ops.ts`) and `/bot model` call `planBotModel` with `risk: false`. A Bot Admin can confirm a card from the admin-console model that moves a non-praw dept to `gemini` or `claude`. `provider_default` has `risk: true`. This does not interact with the fallback (step 2 returns the primary). It is recorded as finding PV-F01 for an owner decision, not as an R8 gate. |
| Media tools (`agents/call/metered.ts`, `METERED_PROVIDER = 'gemini'`) | Unchanged. This is the owner-approved PH-03 exception (Gate 2 PROV-HELPER). |

## 2. API key distribution

| Place | Status |
| :-- | :-- |
| CLI child | Exact allowlist; `--setting-sources=` and `--strict-mcp-config` (`protocol.ts` `buildArgs`). The test asserts `sk-ant-secret` is absent from the child env. |
| Host tool children | `core/child-env.ts` `FORBIDDEN` includes `ANTHROPIC_API_KEY$`; only PATH, LANG, TMPDIR and a private HOME pass. |
| Docker launchers (ws runner, forge, MCP, devjob) | `workspaces/runner.ts` `dockerEnv` and `devjob/launcher.ts` pass only PATH, HOME and DOCKER_HOST to the docker CLI. Agents get only the per-job proxy credential. No compose file references `ANTHROPIC_API_KEY`; `docker-compose.devjob.yml` takes `DEVJOB_ANTHROPIC_API_KEY` only. |
| Executor | `executor/env.ts` refuses the key. |
| Same-uid environment read (rule 4) | The launchd job runs `scripts/app-service.sh run`, which runs `exec bash scripts/dev.sh`. `dev.sh` starts the app with `env -i ... node --env-file=...`, so the key is loaded after exec and is not in the exec-time environment that `ps -E` shows. This is the same residual as the existing Gemini key. |
| Logs, Discord, alerts, audit | `secretsOf` masks `env.anthropicApiKey`. For non-local providers, `providerFault` and `failureInfo` (`agents/call/call.ts`) keep only the error name and status. The A1-A4 texts are fixed. Audit outcomes are enums. |
| SDK environment reads | `new Anthropic({ apiKey, maxRetries: 3 })` still reads `ANTHROPIC_BASE_URL` (the key would go to that host) and `ANTHROPIC_LOG` (debug output to the console, bypassing the masking logger) from `process.env` (`@anthropic-ai/sdk` 1.3.0 `client.js`). `--env-file` loads every key in the owner's env file, so a hand-added line takes effect. See PV-C07 (Low). |
| Prompts and tools | No tool reads `process.env`; config holds no secrets (`ADMIN_READ_KEYS` comment, C13). |

## 3. The switch

- `HANDLER_KEYS` keeps it out of `config_propose`. A HANDLER key can still be written through `admin_op_propose` if an `AdminOp` exists for it, so PV-C08 forbids one.
- The target, the excluded set and the model map are code. `provider.default` and the dept rows are written only by human-confirmed cards (`requiresCard('provider.default')`, `planBotModel`). Prompt overrides cannot change `meta`, and `knowledge/lint.ts` rejects `model:`/`provider:`.
- "A read error counts as off" means nothing as written, because `cfg.get` never throws. While the LISTEN connection is down, only `halted` fails closed (`ConfigStore.get`). An owner who turns the switch off with psql may not be seen. See PV-C08 (global rule 14).

## 4. Spend

Bounded:
- `Budget.reserve` locks company, dept, bot and task rows in one transaction. The estimate is the estimated input plus `maxTokens` output at full price, so concurrent runs cannot pass a cap except by the gap between settle and estimate (input estimated as bytes/3). That gap is small and bounded per call.
- If the budget rows are lost, the code defaults (5 / 1 / 0.5) are stricter.
- `budget.taskUsd` is a lifetime cap per root tree (`TASK_DAY = '1970-01-01'`), not per day. A project tree uses the project's `maxUsd` instead. A project created under local mode may carry a large `maxUsd`, but bot $10 and company $50 still apply.
- Lifts: `liftsCap` and `localLiftOn` are true only for provider id `claude-code-local`. They stay off on the fallback only if `loop.ts:283` (`turnsLifted`), `:386` (`toolContextBase`) and `scheduler.ts` `ratesLifted` use the effective provider (G7).
- AI paths: `AiApprover.precheck` hard-denies anything without a tool name (`hard_deny:unknown`) and the `cost_or_lasting`/`money_doc` classes, so tree-cap, local-cap and dept raise cards stay human. `config_propose` raising `budget.*` or `warroom.*`, or lowering `pricing`, is a risk card.
- Loops: a refused reservation costs nothing. The gate marks hold the actor until the next UTC day. A restart clears the gate, but the persisted `budget_days` rows refuse the next reserve before any call is made.

Gaps:
- **Requeue hot loop.** `eventRejected` uses `snapshotRejectsHold` without the reset clock, while `quotaHoldUntil` drops a rejection whose reset is already past. The result is a requeue with no hold. With the new immediate `onTaskReady`, the task reruns on local, is rejected again, and repeats (PV-C03).
- **`onHoldStart`** must fire only on the not-held to held transition. `arm()` runs on every `publish` and on `load` (PV-C03).
- **The Console spend limit returns HTTP 400** `invalid_request_error` (errors page: "The API also returns a 400 when usage reaches an organization or workspace spend limit"). A tier spend cap returns 429 with no retry-after. The spec maps 400 to "block error", so with the owner's backstop engaged, fallback tasks would be blocked and handed to the healer instead of held. Because a user can also cause a 400, the mark must be per task, not global (PV-C06).
- **A mid-stream failure after `message_start`** is thrown without a `usage` chunk (`providers/claude/index.ts`, catch, then `toProviderError`). `callProvider` then releases the reservation at $0 although Anthropic bills the input (PV-C04).

## 5. OQ9 ruling: unwrapped `tool_result` on the API path

**Acceptable for R8. No change to `providers/claude/request.ts`**, which keeps the VPS byte for byte the same. Reasons:
- `tools/registry.ts` wraps every `untrustedOutput` tool result with `wrapUntrusted`, whatever the provider, and taints the run and the task. The comment reads "The registry owns the wrapper (PF11)". The tools covered are web, ocr, clickup, jira, github, forum, workspace, ws, lessons, music and MCP (`mcp/tool.ts`).
- `kb_search` wraps its own hits (`knowledge/service.ts`). The other builtin tools (`tools/builtin/*`) return fixed code text.
- `prompts/system/safety.md` rule 1 (the `<untrusted-...>` tags are data) is in every system prompt. Taint, approvals and the AI approver hard-deny do not depend on the provider.
- On the API, `tool_result` is a structural block, not text in a JSON array as on the CLI.

Residual (Low): a tool without the flag that returns text other people wrote loses the outer wrapper that local and Gemini add. None was found in `tools/builtin`. Required: test G11 (PV-C10).

## 6. Media parity

The agent loop never builds `media` blocks. They come only from `metered.ts` callers (ocr, receipt, STT), which stay on Gemini. The placeholder on the fallback route is defence in depth. `request.ts` `media()` would send image bytes and refuse PDFs, so G8 stays required. No new attachment bytes go to Anthropic.

## 7. Pricing (checked 2026-11-16 against platform.claude.com/docs/en/about-claude/pricing)

| Model | Official | `config/defaults.ts` `pricing` | Effect |
| :-- | :-- | :-- | :-- |
| Sonnet 5.5 | in $2, out $10, 5m cache write $2.50, cache hit $0.10 | 2 / 10 / cacheRead 0.2; write = in x 1.25 | Matches; cache read over-counts 2x (safe) |
| Haiku 5.5, prompt up to 100K | $0.10 / $0.50 / hit $0.01 | 0.1 / 0.5 / 0.01 | Matches |
| Haiku 5.5, prompt over 100K | $0.50 / $2.50 / hit $0.05 | not modelled | **Under-counts 5x** |

Other under-count sources:
- **Server-side fallback.** `buildParams` sends `betas: ['server-side-fallback-2026-07-01']` and `fallbacks: 'default'` for Sonnet. The docs say "top-level usage counts describe only the attempt that produced the returned message", a billed declined attempt is reported only in `usage.iterations`, and the served model (in `message_start.model`) can differ from `req.model`. The code prices at `req.model`, and each `message_start` resets the counters.
- **Data residency.** `inference_geo` is not sent, so global standard pricing applies (US-only would be 1.1x).

## Conditions

| Id | Sev | Condition | When |
| :-- | :-- | :-- | :-- |
| PV-C01 | High | Replace the §3.1 seed fix with an outcome guard. In local mode (the same `ALLOW_LOCAL_PROVIDERS` real-process-env input the guard reads, not in a container), no main work may resolve to `claude` because of the code default. That covers a `provider.default` row that is absent or invalid, and a guard that failed at that boot. Suggested mechanism: in local mode, seed `FIRST_LOCAL_DEFAULT` whenever the row is null, regardless of `local?.ok` or `providers.has('claude')`. In local mode an invalid row reads as "provider not ready" (idle plus incident), never as the code default. The VPS (flag unset) must never seed. Add G5b (key set, guard failing, flag set, no row: row seeded, zero `claude` `llm.call`) and G5c (invalid row in local mode: idle, no `claude` call). | before BE1 |
| PV-C02 | Medium | A `held` result never carries the `claude` provider. When the loop gets `held` at start, it requeues with the "waits" text and makes no call. The per-call `fb.usable` check also covers `wrapUp()` (the turn-cap call at `loop.ts:532`). Write G4 as an allowlist (rule 6): also flag `.get('claude')`, `FALLBACK_PROVIDER` and `providers.get(` outside `providers/route.ts`, `providers/registry.ts` and `agents/call/metered.ts`. | at Gate 2 |
| PV-C03 | Medium | `QuotaStore.onHoldStart` fires once on the not-held to held transition only (not on every `publish`/`load`). The immediate `onTaskReady` after a quota requeue runs only when `resolveEffective` for the task owner now returns `fallback`, and at most once per task per hold episode. Test: a rejected snapshot whose reset has passed (`eventRejected` true, `heldUntil` null) gives no re-offer. | at Gate 2 |
| PV-C04 | Medium | Metering must not under-count the fallback route. Either omit `betas`/`fallbacks` on R8 fallback calls (a refusal then ends as "Declined", the same as local; the VPS stays unchanged), or price every `usage.iterations` entry at its own model's price and treat an unpriced model as the highest configured Claude price. A failure after `message_start` settles at the reserved estimate, never $0. | before the switch goes on |
| PV-C05 | Medium | Haiku: leave `claude-haiku-5-5` out of `fromLocalModel` (route `held`) until the meter prices the over-100K tier, or set the Haiku price row to the over-100K tier. The owner re-checks the official pricing page on switch day and records the date and figures in the deploy note. | before the switch goes on |
| PV-C06 | Medium | Error table: on the fallback route an HTTP 400 must never block the task or reach the healer, because a Console spend limit returns 400. A 400 is a **per-task** mark: requeue that task and hold it (route `held` for that task) until the hold episode ends. A task-less run gets the fixed "waits" text and no gate mark. A3 is posted once per episode. A 400 must NOT set the global `apiOff`. Rule 10: anyone who can talk to a bot can cause a 400 (for example an oversized prompt), so a global mark would let them turn the backup off for all bots. A spend-limit 400 is not billed, so the narrow mark costs nothing. A 429 that repeats after `coolUntil` (tier spend cap) keeps cooling without a block. Status number only; vendor text is never read. | before BE1 |
| PV-C07 | Low | Build the SDK client with an explicit `baseURL: 'https://api.anthropic.com'` and `logLevel: 'off'` (or the app's masked logger), or refuse `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_LOG` at boot. Add a unit test. | at Gate 2 |
| PV-C08 | Low | `provider.fallback.enabled` gets no `AdminOp` and stays out of `ADMIN_CONFIG_KEYS` (G6 also covers the `AdminOp` union). `resolveEffective` reads the switch as off while `cfg.listenerHealthy()` is false, or reads the row directly. Spec §3.7 states this. | at Gate 2 |
| PV-C09 | Low | Gate marks come from every fallback-route caller: the loop, `JudgeCaller` and `smallCall` (classify). | at Gate 2 |
| PV-C10 | Low | Tests: G9 plants a canary in an `Anthropic.APIError` message and greps the real emitted log stream, the incident text and the alert bodies (rule 19), not only stored rows. G11: on the fallback route, an `untrustedOutput` tool result reaches the `claude` provider wrapped and the run is tainted. | at Gate 2 |
| PV-C11 | Low | Before turning the switch on, the owner: sets the budget rows (50 / 10 / 5); sets a Console spend limit on the main key; uses a separate dev-job key in its own workspace; enters the key through the dashboard env entry or `set-tokens.sh`, never a shell export; checks that `/usage` shows "Backup: off" with the key loaded and that one hold-free day has zero `claude` `llm.call` rows (acceptance 1). | before the switch goes on |

## Findings outside the R8 gate

- PV-F01 (Medium, owner decision, pre-existing). `planBotModel` (`risk: false`) lets a Bot Admin confirm a card that moves a non-praw department to `gemini` (against "only praw on Gemini") or to the metered `claude`. The card can be proposed by the admin-console model through `admin_op_propose` `bot_model`. Options:
  - refuse `gemini` for dept != praw in `planBotModel` and `planProviderDefault`;
  - set `risk: true` when the target is `claude`, so the LW Admin confirm applies.

  Owner: backend after the owner decides.
- PV-F02 (Low, pre-existing, VPS too). The server-side fallback and mid-stream under-count in PV-C04 also affect the VPS main path today.

## Missing context

`<PROJECT_ROOT>/CLAUDE.md` and `<PROJECT_ROOT>/.claude/rules/` do not exist. The live DB was not queried, so live rows (`provider.default`, budget, pricing) are assumed as the spec states.
