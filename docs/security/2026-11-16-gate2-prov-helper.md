# Gate 2 (small): hotfix PROV-HELPER

- Range: `153cfa7..6c442e4` (7051c83, 3616dd6, 6c442e4), branch `main`
- Scope: `knowledge/small.ts`, `knowledge/small.provider.test.ts`, `knowledge/classifier.ts`, `agents/review/{reflect,selfReview}.ts`, `app.ts` wiring; read-only look at `agents/context.ts`, `prompts/loader.ts`, `knowledge/lint.ts`, `agents/call/metered.ts`, `tools/plugins/ocr`, `voice/chat/stt.ts`, `config/defaults.ts`
- Method: static review; `npx vitest run knowledge/small.provider.test.ts` (7/7 pass)

## Verdict: APPROVED (helper path). The Gemini route through `metered.ts` and `image_generate` is still open and goes to the owner as an open decision (PH-03).

## 1. Can a non-praw actor still reach Gemini through the helper path?

No. `resolveSmall` (`knowledge/small.ts:32-46`) has one source: `resolveActor(...).sel`, then `providers.resolve(sel, cfg)`. The cross-provider ranking is gone.
- Head: `sel.dept` comes from the department row (provider/model); otherwise `sel.actor` comes from the file prompt's frontmatter `model` (`agents/context.ts:44-54`). Seed: only `praw` names Gemini.
- Persona: the persona row's provider/model, else the file frontmatter, else `PERSONA_DEFAULT_MODEL` (`context.ts:56-64`).
- Unknown or disabled dept/persona (resolveActor returns a string), a throw, or no `profiles`: `sel = {}`, which means `provider.default`. If the provider is not registered, the result is `no_model` and no other provider is tried.
- Prompt overrides (admin or AI-approved) replace only `body` and never `meta` (`prompts/loader.ts:95-96`), so an override cannot change the model or provider.
- No per-task provider override exists in the helper path. `smallCall` ignores `task` when picking the provider.
- HQ/system actors that use `JudgeCaller` (AiApprover, skill judge) resolve the same way under the HQ profile, which is Claude. That is fine.

## 2. Did this create an AI-writable exfil route?

No. The only inputs are department and persona rows and the file frontmatter. Rows are written only by the human slash commands `discord/commands/{bot,persona,plans}.ts` (admin-gated, `selectionError` checks registration). No tool plugin writes them. AI prompt proposals (`prompt_propose`) change only the body. On top of that, `knowledge/lint.ts:72` rejects `model:`/`provider:` frontmatter in a proposal. The fix also made one route smaller: a head's prompt proposal (classify) used to go to Gemini, and now stays on the head's own provider.

## 3. Guard test quality

`knowledge/small.provider.test.ts` runs the real `seed()` and `Org.load` over `SEED_DEPARTMENTS`/`SEED_PERSONAS` with the real `loadPrompts(PROMPTS_DIR)`. It covers every head and persona times reflect/review/classify, and it asserts the Gemini call count equals praw-head only. Commit 7051c83 records that this test failed before 3616dd6, so a regression back to "cheapest" (Gemini is priced, local is not) would fail it. It also covers the fallback, `no_model`, the hold and priority.
- PH-01 (Low, test gap): the overrides stub always returns null, and no case covers a persona or department row with an explicit `provider`. It is not needed for this fix. Optional addition: a test where the dept row sets `provider:'gemini'` for a non-praw dept, to show the row (admin-set) is followed and is the only lever.

## 4. Quota-hold fail-fast and priority

- The hold check (`small.ts:53`) returns `ok:false` before reserve or spawn and only when the provider is `claude-code-local`. Reflect and review swallow failures silently. They do not touch task status, so they cannot mark a task failed.
- PH-02 (Low, availability): during the hold, `classify` fails closed. A head's `prompt_propose` is then refused as `unavailable`, and the proposer is the AI head acting for a human. This is the intended fail-closed behaviour and not a security issue. Note it in the runbook.
- `priority:'bot'` applies only to reflect/review, so they queue behind human calls. Classify keeps the default. Human work cannot be starved by this change. In the other direction, bot helpers may wait, and timeouts (60/60/90 s) bound how long. On timeout the call is dropped (`call.catch`), and its reservation is settled by the call core.

## 5. Gemini through `agents/call/metered.ts` (as is, not changed)

`METERED_PROVIDER = 'gemini'` (`metered.ts:11`) is hard-coded whatever the actor's provider is. Callers today:
| Tool / path | Who can trigger (defaults, `config/defaults.ts:84-92`) | Content sent to Google |
| :-- | :-- | :-- |
| `read_image` (vision, `tools/plugins/ocr/index.ts:64`, `extract.ts:70`) | Every head: hq, rnd, sales, praw, software, it, ops, hr, marketing, finance (`VISION`) | Image bytes from the trigger message, the replied-to message or a forwarded message, plus a fixed system prompt |
| `extract_receipt` (ocr, `receipt.ts:67-70`) | finance | Receipt image or PDF (amounts, vendor, possibly personal data) |
| `ocr_image` (ocr, `extract.ts:52`) | Not in any default `tools.byDept` list; reachable only if an operator grants it | Image or PDF attachment text |
| Voice STT (`voice/chat/stt.ts:81`, actor defaults to PRAW) | Anyone allowlisted who speaks in a voice chat with Praw | Raw voice audio of the speakers |

Also outside `metered.ts`: `image_generate` (`tools/plugins/media`, Gemini image model) is granted to rnd, marketing and praw. The model-written prompt text, which can contain task context, goes to Google.
- PH-03 (Medium, policy, owner decision): non-praw departments send attachment images (all heads), receipts (finance), and image-generation prompts (rnd, marketing) to Gemini. This conflicts with the owner rule "only praw uses Gemini". Options: remove `read_image`/`extract_receipt`/`image_generate` from non-praw `tools.byDept` (config only, `/bot tools`), or route vision to a Claude multimodal model. Not changed here, as instructed.

## Findings
- PH-01 Low: guard test has no case for an explicit row provider. Owner: backend (optional).
- PH-02 Low: classify is unavailable during the quota hold (fail closed, as intended). Owner: none, document it.
- PH-03 Medium: hard-coded Gemini for media/vision/STT/image generation, used by non-praw departments. Owner: owner decision, then backend.

## Owner decision (2026-11-16)

PH-03: the owner chose to keep the media tools pinned to Gemini in `agents/call/metered.ts` (`read_image`, `extract_receipt`, `image_generate`, `ocr_image`, voice STT) for all departments that hold them. Status: accepted risk, owner-approved exception to the "only praw on Gemini" rule. Text LLM calls are not covered by this exception.

Deployed live 2026-11-16 09:24 together with R7 PLUGIN-FORGE (HEAD 76ba4f8).
