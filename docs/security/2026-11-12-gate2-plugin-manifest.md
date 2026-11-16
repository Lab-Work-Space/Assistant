---
title: "Gate 2 - R4 PLUGIN-MANIFEST (GROWTH-1)"
gate: 2
gate1: docs/security/2026-11-12-gate1-plugin-manifest.md
spec: docs/superpowers/specs/2026-11-12-plugin-manifest-design.md
scope: b44966f..66becde (BE1 3eba31a, BE2+BE3 66becde) plus one Gate 2 fix (uncommitted)
status: APPROVED
date: 2026-11-12
---

# Gate 2: R4 PLUGIN-MANIFEST

Verdict: **APPROVED**. I fixed one Medium finding in this audit (G2-01). One Low finding (G2-02) goes to backend and does not block release.

**Core question: no registered tool's effective class changed.**

- I compared `tools/__golden__/decision-matrix.json` at 3eba31a and at HEAD with a script. The key sets are equal.
- Exactly 9 cells differ, all in the three unregistered probe rows `mcp_x`, `stub_write` and `zz_unknown`. In each row, `nonSensitive`, `routable` and `eligible` changed from true to false.
- Every catalog row is identical.
- The harness `tools/manifest/decision-matrix.harness.ts` is unchanged since 3eba31a. It imports no catalog.
- I extracted 3eba31a into a scratch copy and its manifest and autopilot golden tests pass (54/54). The golden was therefore recorded from the old literals while they were still live.
- `tools/manifest/privileged.json` and `tools/manifest/floor.ts` are unchanged since 3eba31a.
- The `SENSITIVE_TOOL` pattern string is identical at b44966f (`approval-rooms.ts`), 3eba31a and HEAD.
- `tools/__golden__/autopilot-classes.json` (95 keys) deep-equals both old `GOLDEN` literal tables (`git show 3eba31a:tools/autopilot.golden.test.ts` and `tools/autopilot.company.golden.test.ts`).

## Tests run

| Run | Result |
|---|---|
| unit, full | 416 files, 5467 passed, 2 skipped |
| int, full (docker-compose.test.yml, 127.0.0.1:54329, brought down afterwards) | 128 files, 1582 passed |
| `tsc --noEmit -p tsconfig.json` | exit 0 |
| Static: every `name: '...'` tool literal under tools/plugins, tools/builtin, admin and the core tool modules vs CATALOG_NAMES | all declared (only `bots`, an admin panel field, is outside); `music_skip`/`music_stop` come from a helper and are declared |
| 3eba31a scratch copy: tools/manifest and the autopilot goldens | 54 passed |
| `GOLDEN_UPDATE=1 CI=1` on decision-matrix and the autopilot golden | both refused (`GOLDEN_UPDATE is refused when CI is set`); git tree unchanged |
| Gate probes in the scratchpad (P1-P5, below) | 6 passed |

The probes:

- **P1.** A core-site tool named `music_play` or `github_create_branch` fails `assertDeclared(..., 'builtin')` with "declared in group music but registered by group builtin". An admin name in the main registry is refused by both checks.
- **P2.** `GOLDEN_UPDATE` is refused under `CI`, `DEVJOB` and `DEVJOB_SANDBOX`, and also when `CI=0`.
- **P3.** An `o.groups` tool that reuses `web_search`, `clickup_create_task`, `config_get`, `discord_read` or `write_file` throws "reuses a declared tool name". This includes a test group whose id is `web`.
- **P4.** I tried mutating every export: DERIVED, its lists and `deptOnly`, `classOf` results, FAIL_CLOSED, `SENSITIVE_TOOL.test`, `SENSITIVE_TOOL.compile`, CATALOG_NAMES and DEPT_ONLY. Nothing changed. `classOf('__proto__')` and `classOf('constructor')` return FAIL_CLOSED.
- **P5.** The catalog exports only `CATALOG_DIGEST`, `CATALOG_NAMES`, `DERIVED`, `EXTERNAL_PREFIX`, `buildCatalog` and `classOf`.

## PM-C status

| Cond | Status | Evidence |
|---|---|---|
| PM-C1 | PASS | `catalog.ts` `buildCatalog`: the `map` is private, every entry goes through `Object.freeze({ ...c })`, and DERIVED, its lists and `deptOnly` are frozen. Covered by P4 and catalog.test "PM-C1". |
| PM-C2 | PASS (deviations D2 and D3) | (ii): the 9-cell diff above. (i): BE1 deep-equalled the live constants (green at 3eba31a). After the swap, identity checks and an unchanged privileged.json keep that equality. |
| PM-C3 | PASS | `sensitiveFalse` has 76 names and deep-equals the catalog. V4 is `!c.sensitive && SENSITIVE_TOOL.test(name)`. `isNonSensitiveTool` requires both that the floor does not match and that the tool declares `sensitive === false`. |
| PM-C4 | PASS | `app.ts` calls `assertDeclared(tools, coreToolNames, 'builtin')`, then `assertRegistryDeclared(tools, MAIN_GROUPS, testToolNames)`, then `assertRegistryDeclared(adminRegistry, ['admin'])` after `adminRegistry.register`. boot.test pins their order and the main.ts `createApp(env)` call. |
| PM-C5 | PASS (D4) | V6 includes `c.sensitive`. V5 refuses `c.group === 'admin'`. V-tests exist. |
| PM-C6 | PASS | V10 and V7 (`c.kind === null`). An ADMIN_TOOL_NAMES-to-admin-group bijection test exists. |
| PM-C7 | PASS | catalog.test checks that the clickup `own_waive` entries equal CLICKUP_WORKSPACE_WRITE_NAMES. |
| PM-C8 | PASS (D5) | imports.test covers the allowlist and four bypass probes. |
| PM-C9 | PASS (D6) | boot.test "PM-C9" has an exact 9-file allowlist. No setup file mocks the catalog, and no product file imports `tests/fakes/`. `withTestClasses` refuses declared names, floor matches and `mcp_` names. |
| PM-C10 | PASS | `registerGroups` throws "reuses a declared tool name" (P3). |
| PM-C11 | PASS after G2-01 | The five patterns are in place, and a real-tree test covers all 18 manifests. GOLDEN_UPDATE is refused under CI (run above). G2-02 is open. |
| PM-C12 | PASS | No setter (P5 and catalog.test "PM-C12"). |

## Deviation rulings

- **D1: SENSITIVE_TOOL is a frozen `{test}` wrapper. Accepted.**
  - The wrapper is stronger than a frozen RegExp, which `compile()` can still rewrite.
  - Every product caller uses `.test` only (grep). `tsc --noEmit` is clean.
- **D2: PM-C2(ii) also flipped `routable` and `eligible`. Accepted.**
  - Both are functions of `nonSensitive`. decision-matrix.test pins `routable === nonSensitive` and `eligible === nonSensitive` on every row, and that test was green at BE1.
- **D3: the PM-C2(i) live-constant test was replaced by identity checks. Accepted.**
  - The live comparison ran green at BE1. privileged.json has not changed since. `toBe(DERIVED.x)` together with the privileged.json deep-equal keeps the chain intact.
  - The probe expectation changed to false, and the golden was regenerated through the writer. Accepted, because the diff is exactly the 9 cells.
- **D4: V5 refuses group `admin` instead of the name lists. Accepted as equivalent.**
  - The bijection test makes every ADMIN_TOOL_NAMES name group `admin`. MOD_TOOL_NAMES (`discord_read`, `server_propose`) is a subset of ADMIN_TOOL_NAMES.
- **D5: `catalog.ts` imports `node:crypto`. Accepted.**
  - It is a builtin with no I/O, used only for `CATALOG_DIGEST`. The import is listed in the allowlist test.
- **D6: tree-grant-acceptance joins the allowlist (9 files, not 8). Accepted.**
  - Its diff only renames the four stubs to `stub_*` and adds the file-local mock. Each stub borrows the real tool's class.
  - Every expected outcome is unchanged, and the test passes in the int run.
  - Coverage note: name-keyed checks for those four real names are now covered by the unit decision matrix, not by this acceptance test.
- **D7: other test and build changes. Accepted.**
  - The four fail-open fixtures were renamed to declared-class stubs.
  - `**/*.harness.ts` is excluded in tsconfig.build.json. The harnesses are test-only, and product code imports neither harness.
  - `assert.ts` was created in BE2. It reads only the catalog.
  - `golden.ts` lives in `tests/fakes`. It reads `process.env` and is test-only.
- **D8: protect `tests/fakes/golden.ts` and `tests/fakes/tool-classes.ts`. Agreed and done, and widened (see G2-01).**

## Findings

| ID | Sev | Where | Issue | Remediation | Owner |
|---|---|---|---|---|---|
| G2-01 | Medium | devjob/paths.ts `NON_SELF_MODIFIABLE` | The protected decision-matrix harness imports `tools/autopilot.golden.harness.ts`. The autopilot golden is compared in two unprotected test files, both of which use `tests/fakes/golden.ts`. A bot diff could weaken a protected test through these helpers. | **FIXED in this audit.** Added `tests/fakes/golden.ts`, `tests/fakes/tool-classes.ts`, `tools/autopilot.golden.harness.ts`, `tools/autopilot.golden.test.ts` and `tools/autopilot.company.golden.test.ts`. devjob/paths.test.ts adds them to the refused list and adds two not-in-set controls. The existing "exact paths exist" test covers them. | security (done) |
| G2-02 | Low | devjob/launcher.ts `AGENT_ENV`, `agent` argv | `DEVJOB` and `DEVJOB_SANDBOX` are never set anywhere. The agent step also does not set `CI`; only the test step sets `CI=1`. The writer's DEVJOB clause is therefore inert where the model runs commands. The `tools/__golden__/` path refusal remains the real control. | Add `-e DEVJOB=1` to `AGENT_ENV`, and to the test and review argv, with a launcher test. | backend or owner (devjob/ is protected) |

## Release ruling

R4 may be deployed once the G2-01 fix (devjob/paths.ts, devjob/paths.test.ts, uncommitted) is committed with it. Live behaviour changes only in two ways: an undeclared name fails closed (it is not registered, so it cannot run; a stale stored approval naming a removed tool goes to #setting and is AI hard-denied), and boot refuses an undeclared or mismatched tool. Every tool-name literal the plugins can build in any mode is declared (static check above), and the real registry passes the boot check in the int suite. Dev jobs are disabled live, so G2-01 and G2-02 have no live effect today.

Owner, in plain words: (1) The bot's permission rules now come from one checked-in file per tool group, and every existing tool behaves exactly as before. (2) If a tool is ever added without being declared, the bot refuses to start and the boot log names the tool; the fix is to roll back the deploy.

## Audited files (md5 at review end)

- 83c6ec8815e63380c4355851b479e1de app.ts
- 7050267b8b89b4032991a453da5c2eb1 devjob/paths.ts
- 87e4b80556ce0b1dc1536406e42daebf devjob/paths.test.ts
- c8073c53314bce29a04ab82c1eb65e6f discord/approval/approval-rooms.ts
- b38f5b64c025136ff9f199330577aa6f governance/ai-approver.ts
- 7841d25ab4ca3039c7ed16b2318a38c6 governance/autopilot.ts
- 4a06beb3c906bb03d0f5429492764b66 tools/autopilot.ts
- ee63a0f3458b75054906fdd73d495dee tools/policy.ts
- a162a3efaa4fbc63527987144310f46b tools/policy-approval.ts
- 13b2b7540f26c2848fdba58bb6c65b5c tools/tree-grant-tools.ts
- d0db41e7536b9995c79de23cd89f4622 tools/plugins/index.ts
- b03aa3133fbd8c7f84f7c070398bc874 tools/manifest/assert.ts
- 551bc273ed74e8735756c7b68233d959 tools/manifest/boot.test.ts
- c3dc9839227aac2057b80e8c60d95b3f tools/manifest/catalog.test.ts
- be7b40b47b592478366aeb3e0722a9e4 tools/manifest/catalog.ts
- 018897f2836dffa917c0d0fb6df3b15e tools/manifest/decision-matrix.harness.ts
- 34585676303c2d9d5221ad2540e36ab5 tools/manifest/decision-matrix.test.ts
- a8b7283ededd5ade0d067966e931750b tools/manifest/floor.ts
- 1e622c9df4ec5b311be2ec917d7e3ac5 tools/manifest/imports.test.ts
- a6db0f067a5f34473ce315fe5a883ef7 tools/manifest/registry.test.ts
- 0821b8649760db602662f63803451233 tools/manifest/types.ts
- 8b13f888c3babb0eed943e405a8ae3b5 tools/manifest/privileged.json
- c502f43f09ff4c087a5da0b47cda14fe tools/__golden__/autopilot-classes.json
- 3427bdea7428ee3c2ce82833b5c0162d tools/__golden__/decision-matrix.json
- aab11d9cc648dc8519e43e67a9123456 tests/fakes/golden.ts
- 5c149b1e9ffa27d4c1b001282e4eca73 tests/fakes/tool-classes.ts
- f69478499460a3a32d1cf059381ee146 tools/autopilot.golden.harness.ts
- 87251eafc05f6ec8b9f9420827c8ce0c tsconfig.build.json
- 68c0b45704501666ff2b847b62688931 admin/manifest.ts
- 67d7ed32bdea9cf2b2857e78a8401b30 tools/builtin/manifest.ts
- 3075fc65b9490964201847977140a2d7 tests/integration/tree-grant-acceptance.int.test.ts
