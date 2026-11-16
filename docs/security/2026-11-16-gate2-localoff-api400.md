# Gate 2 — LOCAL-OFF-1, API400-1, Jira removal (2026-11-16)

Task: G2-LOCALOFF-API400. Commits: 15637bc, 1b8b38f, 4be9bdd, 4b986e8; image pins e6048a1, 52920ec, 5dcf0e5.

**Verdict: APPROVED** (no blocking findings; owner action R-1 recommended).

## Evidence
- `npx vitest run` guard, mode, schema, local-mode, envfile, media/graph, child-env: 7 files, 157 tests passed. `npx tsc --noEmit`: clean.
- No dependency or Dockerfile change in range. Supply chain: N/A. Native memory: N/A.

## Checks
- **Guard provenance unchanged.** `providers/claude-code-local/guard.ts:89` still requires `ALLOW_LOCAL_PROVIDERS=1` first. The env-file and `SKIP_PIN` rules are untouched. The OFF check (`guard.ts:91`) runs before any file read or spawn and can only return not-ok. `localFlagOk` and `localModeOf` are unchanged (tested in `mode.test.ts`). In `dev.sh`, the marker only adds `ASSISTANT_LOCAL_PROVIDER_OFF=1` to the `env -i` child, and an exported parent var is ignored (tested).
- **Jira removal.** `core/child-env.ts:6` still forbids `JIRA_API_TOKEN`. `core/logger.ts:41-42` still redacts ATATT. The dashboard cannot write or show non-allowlisted keys (`envfile.ts:54`, `:163`). Approved or pending calls to a removed tool fail closed (`tools/registry.ts:145-148`). The `byDept` and privileged edits only remove entries; nothing was widened.
- **Schema flatten.** It changes only what the model sees. `registry.ts:154` still validates every call with the strict zod union. MCP schemas are always top-level strict objects (`mcp/schema.ts`), so the flatten is a no-op for them.
- **Image pins.** Both ids are `sha256:` digests and match the local images (`docker image inspect`). Base images are still digest-pinned, and the Dockerfiles have not changed since G2-01.

## Findings
- **F-1 Info** (`app.ts:482`). An env-file `ASSISTANT_LOCAL_PROVIDER_OFF=1` also skips the first-boot seed. With no stored default, the bot then falls to the metered `claude/claude-sonnet-5-5` default, which R8 PV-C01 was meant to avoid. This is accepted because it is the owner's intent, env.local is 0700, the dashboard cannot set the key, and the spend caps still apply.
- **F-2 Info** (`tools/schema.ts`). The flattened view drops per-branch `additionalProperties:false`, keeps only the keys every branch requires, and types a non-string `const` as `string`. `allOf` is not flattened. `props` is a plain object, so a property named `__proto__` would throw. That path is only reachable from first-party schemas. No fix was made, because another agent is editing the tests at the same time.
- **F-3 Info** (`mcp/snapshot.ts:73`). The comment says it mirrors `specsFor`, which is no longer exact. The behaviour is the same for MCP tools.
- **F-4 Info.** Tool specs going to the Claude API is not a new exposure (see the R8 ANTHROPIC-WS addendum). Descriptions contain only static text and workspace-mode wording, with no ids or secrets.
- **R-1 Owner action.** Revoke the Jira API token at id.atlassian.com and delete the `JIRA_*` lines from env.local. Removing the code does not retire the credential.

Fixed in this audit: none.
