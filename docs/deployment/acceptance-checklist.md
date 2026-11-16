# Live acceptance checklist

The owner's live end-to-end checks in the Discord test channel, run after the budget guard is set low.

The local acceptance kit (`deploy/acceptance/`) is described in [Media sidecar: deploy and live checks](../operations/media-sidecar-live-checks.md).

## Live E2E checklist (owner, in `#🧪-labs-sandbox`, after `/budget set daily 1`)

Spec §18 acceptance criteria 1 to 9 (10 is the automated suite):

1. All enabled heads come online with their own name and avatar; disable one (remove its token) and the others still start.
2. Post a goal to `@CEO`: a task, a thread, delegation to at least one head and persona, and a `report` rolled back to the CEO.
3. Persona messages arrive through the webhook with their own name, avatar and footer. Also verify that a persona webhook message has `message.applicationId` equal to the head bot's application id (this is what the service uses to attribute personas; Gate 1 D6). If it is null or different, personas will be treated as foreign bots.
4. Bots do not reply to bots unless mentioned or owner; the turn limit stops a loop.
5. `/limits set turns 3`, `/budget`, `/persona edit`, `/bot disable` take effect within 1 s without restart.
6. Exceed the daily budget: all bots pause and an `alert` is posted.
7. A task over the approval threshold waits for the approve button from `Bot Admin`; a click by anyone else is rejected.
8. `/halt` aborts in-flight streams within 2 s; `/resume` continues.
9. No bot can read or post in `#🔑-system-credentials` or `#moderator-only`, and the boot log shows no permission warnings.

Additionally, make one real call with a Sonnet model and confirm the provider request is accepted with the configured `fallbacks` and `output_config` parameters (no 400 from the API), and that the cost shown by `/usage` is non-zero and plausible.

Container hardening check (D20): `docker run --rm --entrypoint sh <image> -c 'ls -a /app'` shows no `.env`.

**Live reply streaming (STREAM-1).** With `stream.enabled` (config, default true) a person's typed message to a head gets a preview message that is edited while the model writes its `respond` body (plus the typing indicator; Praw/Gemini shows typing only). The preview is built from the respond body only, goes through the same redaction and handle defanging as every post, never pings, and is replaced by the final answer (or points to a fresh post when the answer must route a mention or is a card). claude-code-local reads the CLI's `stream-json` output; the probe checks it.

Back to the [documentation index](../_index.md).
