---
title: "Gate 1 - R4 PLUGIN-MANIFEST (GROWTH-1)"
gate: 1
spec: docs/superpowers/specs/2026-11-12-plugin-manifest-design.md
status: CONDITIONAL_APPROVE
date: 2026-11-12
---

# Gate 1: R4 PLUGIN-MANIFEST

Verdict: **CONDITIONAL_APPROVE**. The design keeps the trust boundary (only checked-in code declares a class) and adds a real fail-closed default. Before BE1 starts, the spec must take in PM-C1 to PM-C4 (blocking). PM-C5 to PM-C12 are checked at Gate 2.

Code is cited by content anchor. Line numbers are hints taken at HEAD 72de510. `git diff 6e85f0f HEAD` on tools/, governance/, discord/, admin/ and app.ts is empty, so the 6e85f0f baseline in spec §5.1 is valid. The 17 builtin names in spec §3.3 match app.ts `builtinNames` (:543) exactly.

## Findings that drive the conditions

| ID | Sev | Where | Issue |
|---|---|---|---|
| F1 | High | spec §3.3 `TOOL_CLASSES (a frozen Map)`, `FAIL_CLOSED` | `Object.freeze(new Map())` does not block `.set/.delete/.clear`. `FAIL_CLOSED` is one shared exported object. A single mutation would reclassify a tool or every unknown name. |
| F2 | High | spec §6 evidence (a)(b)(c) | The goldens cover only the autopilot path for the real set (autopilot.golden.test.ts `GOLDEN`, `real.names()`). That excludes `video_generate` and `sheets_append_receipt`, which are exactly the cost and money hard-denies, plus admin tools. They do not cover room routing, batching, skill grant or approvalFor. In BE2, (a) is tautological, because DERIVED and privileged.json then share one source. |
| F3 | Medium | spec §3.3 floor "never extended; new tools declare `sensitive`" vs §5.1 `classOf(n).sensitive === SENSITIVE_TOOL.test(n)` for every catalog name | These contradict each other: no future tool can be `sensitive:true`. Also, `sensitive:false` is a grant (it lets a tool leave #setting, be batched, be skill-granted and be AI-judged: approval-rooms.ts `routable`, skill-grant.ts `isNonSensitiveTool(name)`, ai-approver.ts `hard_deny:sensitive`), but it is not in DERIVED or privileged.json. |
| F4 | Medium | spec §3.4 app.ts `assertDeclared(tools, builtinNames, …)` | Only names that come from `builtinNames` and `pluginGroups` are checked. Any other future `tools.register` call site (app.ts:492-579 already has five) would get FAIL_CLOSED silently, not refuse boot. That contradicts "no production name is unknown" (§6). |
| F5 | Medium | spec §3.3 V6 | `no_approval`/`bot_talk` skips approval completely (policy-approval.ts `approvalFor`), yet V6 allows it on a sensitive tool. Today that needs a list edit. No current member is sensitive. |
| F6 | Medium | spec §6 "privileged.json must change in the same diff" | The AI self-code path (devjob) can edit a plugin manifest and privileged.json in one diff. devjob/paths.ts `NON_SELF_MODIFIABLE` protects the GitHub deny list and `deploy-repos.json`, but no policy-list file. |
| F7 | Low | spec §3.3 V5-V7, admin manifest | `discord_read` is kindless and non-sensitive, so V7 lets it declare `own_waive`. No admin entry needs any non-default field. |
| F8 | Low | spec §3.4 tools/autopilot.ts "drop the CLICKUP import" | This loses the single source with clickup/workspace-write.ts `CLICKUP_WORKSPACE_WRITE_NAMES`. That file imports runtime modules (calendar, logger), so a manifest must not import it. |
| F9 | Low | spec §3.4 `o.groups` | Test-only, and main.ts `createApp(env)` passes no options. Nothing pins this. An `o.groups` tool that reuses the name of a disabled catalog tool would take that tool's class. |

## Conditions

Blocking: the spec is amended before BE1.

- **PM-C1 (F1)** catalog.ts does not export the Map. `classOf` reads a private map. Every ToolClass, FAIL_CLOSED and the DERIVED record and arrays are deep-frozen (`Object.freeze` on each entry). `deptOnly` keeps the `Readonly<Record<string,string>>` shape and `Object.hasOwn` semantics (tools/policy.ts `effective`). Test: try `set`/`delete`/property writes on every reachable export, then assert that `classOf` and DERIVED are unchanged and that `classOf('zz_unknown')` still deep-equals the original FAIL_CLOSED values.
- **PM-C2 (F2)** BE1 adds two tests while the old literals are still live. (i) Every old constant (TREE_GRANT_TOOLS, NO_APPROVAL_TOOLS, BOT_TALK_TOOLS, AUTOPILOT_OWN_WAIVE, AUTOPILOT_ALWAYS_CARD, MONEY_DOC_TOOLS, COST_OR_LASTING_TOOLS, DEPT_ONLY), sorted, deep-equals privileged.json and DERIVED. The only allowed delta is the `schedule_*` names. (ii) A committed decision-matrix JSON (`tools/__golden__/decision-matrix.json`, observed from pre-swap code). It covers every catalog name plus `zz_unknown`, `stub_write` and `mcp_x`, and records: `isNonSensitiveTool`, `skillToolAllowed` (as registered with its kind), `precheckCall` code with input `{}`, `approvalFor` with direct and non-direct context, AUTOPILOT_ALWAYS_CARD/`isAlwaysCard` membership, AUTOPILOT_OWN_WAIVE membership, TREE_GRANT membership, and the `effective()` drop for a non-software department. In BE2 it may change only the `isNonSensitiveTool` row of the three unknown names (true to false). Any other change is stop-and-report.
- **PM-C3 (F3)** privileged.json gets a `sensitiveFalse` list: every catalog name declared `sensitive:false`. A test deep-equals it to the catalog. The regex-equality test applies only to names present at 6e85f0f. For every name, `SENSITIVE_TOOL.test(n) ⇒ sensitive` (V4). A new tool can then declare `sensitive:true` freely, but `sensitive:false` is reviewed membership.
- **PM-C4 (F4)** After the last `tools.register` call and after admin registration (app.ts, after `adminRegistry.register` at about :914), boot asserts that every name in `tools.names()` and `adminRegistry.names()` is in the catalog with an equal group and kind, except names that came from `o.groups`. A test asserts that main.ts calls `createApp(env)` with no `groups`.

Checked at Gate 2:

- **PM-C5 (F5)** V6 also requires `sensitive:false`, on top of its existing kind `write` rule. V5 also refuses ADMIN_TOOL_NAMES and MOD_TOOL_NAMES. Each new clause has a V-test.
- **PM-C6 (F7)** V10: every `group:'admin'` entry has approval `central`, treeGrant false, autopilot `default`, deptOnly null and aiReview `judge`. V7 also requires a non-null kind. Test: every ADMIN_TOOL_NAMES name is in the catalog with group `admin`, and every `admin` entry is in ADMIN_TOOL_NAMES.
- **PM-C7 (F8)** Test: the names whose clickup manifest entry has `own_waive` equal `CLICKUP_WORKSPACE_WRITE_NAMES` (imported in the test only).
- **PM-C8 (import order)** Allowlist import test (global rule 6): types.ts and floor.ts have zero imports. Each `*/manifest.ts` imports only `tools/manifest/types.js`. catalog.ts imports only types, floor and the 18 manifests. The test parses static `import`, `export … from`, dynamic `import()` and `require`, and is proven by four bypass probes in a scratch copy. tree-grant-tools.ts keeps no other import.
- **PM-C9 (mock seam)** Allowlist test: `vi.mock(` of `tools/manifest/catalog` appears only in the files listed in spec §5.3 and never in vitest.config.ts or setup files. No non-test file imports `tests/fakes/` (tsconfig.build.json excludes `tests`, but an import from product code would still compile it in). `withTestClasses` refuses names that are in the catalog, match SENSITIVE_TOOL, or start with `mcp_`. It wraps `classOf` only, and a test shows DERIVED is unchanged under the mock.
- **PM-C10 (F9)** registerGroups throws when an `o.groups` tool name is in the catalog.
- **PM-C11 (F6)** The owner or backend (devjob/ is itself protected) adds `tools/manifest/`, `tools/__golden__/`, `tools/plugins/*/manifest.ts`, `tools/builtin/manifest.ts` and `admin/manifest.ts` to devjob/paths.ts `NON_SELF_MODIFIABLE`. A real-tree path test (global rule 5) confirms each pattern matches at least one file and every manifest file matches. The privileged.json and decision-matrix tests live under `tools/manifest/` or `tools/__golden__/`. `GOLDEN_UPDATE` is also refused when `DEVJOB` or sandbox env is set.
- **PM-C12 (R6 boundary)** R4 ships no setter: no exported function mutates the class source, and a grep test checks it. Spec §7.1 is amended to bind R6 as follows. The extension input is a checked-in file covered by PM-C11, never config, DB, env or model text. It can be set once, before the first `classOf` call, and setting it later throws. It accepts only `mcp_` names and validates V1, V4 and V7. It never touches DERIVED.

## Residual risks (accepted)

- A human can still edit a manifest and privileged.json together. Review of that diff (and the R5 release-card hash) is the control.
- Stored approvals or open batches naming a tool removed in a later release now route to #setting and are AI hard-denied. A batch already open keeps that member (approval-batches.ts `eligible` is checked only on join). Running such a row fails as an unknown tool. This is safe.
- `deptOnly` is a restriction but is read from a static list, so an unknown name has no dept limit. Only `o.groups` test tools are affected.
- Whether R6 may set `sensitive:false` on `mcp_` names (making them batchable, skill-grantable and AI-judgeable) is for R6 Gate 1.

## Owner sign-off

Residual risks accepted under the owner's one-time approval of the growth roadmap (2026-11-12, in chat). Build may proceed under PM-C1 to PM-C12; release to the live bot needs the owner's release approval.
