---
title: "Security Gate 2: CLICKUP-HIER-1 (create ClickUp space / folder / list)"
gate: 2
status: APPROVED
date: 2026-11-09
spec: docs/superpowers/specs/2026-11-09-clickup-hierarchy-create-design.md (+ "Amendments after Gate 1")
gate1: docs/security/2026-11-09-gate1-clickup-hier.md (CH-C1..CH-C9, owner sign-off R9, R10, R3/R4 widened, R11)
---

# Security Gate 2: CLICKUP-HIER-1 (create ClickUp space / folder / list)

- Gate: 2 (code audit). Task: CLICKUP-HIER-1. App root: BOT/Assistant.
- Code is cited by content anchor (function name plus a short quoted fragment). Line numbers are not used.
- No `~/.config/assistant` values were read. No build was run, no commit was made, and the app was not started. No code was edited by this audit.
- Files of the concurrent TASKADMIN-1 work (discord/commands, agents/*, db/repos/*) were not audited. tools/registry.ts and agents/approved-tools.ts were read only to confirm the flow.

## Verdict: CONDITIONAL_APPROVE

All nine Gate 1 conditions are met in code, and each has a passing unit test. No security defect was found.

The verdict is CONDITIONAL for two reasons, both about the binding test list:
- The one binding integration test of the chain is red (G2CH-01). The cause is functional, not security.
- One binding integration test is missing (G2CH-02).

When both are closed and the suite is green, this becomes APPROVED without a new security review, provided the audited security files (client.ts, workspace-write.ts, approval.ts) are unchanged. Check them against the md5 list at the end.

## Findings

| ID | Severity | Where | Finding | Remediation | Owner |
| :--- | :--- | :--- | :--- | :--- | :--- |
| G2CH-01 | Low (functional, not security; release blocker as a binding test) | tests/integration/clickup-workspace.int.test.ts `it('a direct chat with praw: space -> list -> task, ...')`, the assertion after `await ask(t, 'add a backlog list in it')`, `expect(rows).toHaveLength(1)` | **The binding chain test is red, every time it runs (3 of 3 runs).** In a debug copy run from the scratchpad (since deleted), the approved space replay ran: one POST, and `tool_result = "ran:\nCreated space 8800."` was stored on the approval row. But `result_delivered_at` stayed null, and none of the 3 provider calls contained `Created space`. The model call made for the second message consumed the scripted turn `respond('report', 'd')` instead of the `clickup_create_list` turn, so no card was filed. Two causes fit this. (a) The script assumes a model turn after approval that this harness does not run. (b) The approved result does not reach the owner's next turn, and spec §3.3 step 10 relies on that delivery for the space -> list -> task chain. (b) would touch agents/*, which TASKADMIN-1 is editing right now. The security path itself passes in unit tests: hierarchy.test.ts "the all-mode round trip: create space -> list in it -> task in it, two teams". | Backend: find out whether the approved result of a mention-chat conversation task is meant to reach the next owner turn (agents/approved-tools.ts `pending`/`delivered`, the scheduler). Tester: fix the turn script for the behaviour that is intended. Then run the test green. | backend + tester |
| G2CH-02 | Low (test gap) | spec TESTS "Int: ... `/clickup watch add` of the new list succeeds" | **There is no integration test for `/clickup watch add` on a newly created list.** The only check is at unit level: hierarchy.test.ts `expect((await r.client.listInScope(lid)).teamId).toBe(TEAM_B); // usable at once, e.g. by /clickup watch add`. | Add the integration step after the list create in the G2CH-01 test, or in a test of its own. | tester |
| G2CH-03 | Info | client.ts `describeParent`, `if (e instanceof ClickUpError && (e.status === 404 \|\| e.status === 403)) throw parentRefusal(kind); throw e;` | **A 401 on `GET /space\|folder/{id}` gives the credentials text, not E.SCOPE_*.** If ClickUp answers 401 (the OAUTH_0xx family) for an object in a workspace the token cannot see, and 404 for an id that does not exist, the two texts differ. This weak oracle can only say "exists in a workspace this token cannot reach". It is the same pattern that `listInScope` and `taskScoped` already have, both accepted at earlier gates, so CH-C4 (which lists 404 and 403) is met. Mapping 401 to the scope text would hide a revoked token, so no change is required. | Optional, cross-cutting (sibling rule): if this is ever changed, change every object lookup in client.ts together. | none now |
| G2CH-04 | Info | discord/embeds/approval.ts `toolCallView` | The non-binding Gate 1 recommendation of a fixed `Visibility` field on the card was not built. The visibility statement is in the model-facing tool description ("A new space is visible to every member of that workspace and cannot be made private by the bots") and in the README row. The owner signed R9. | Optional. | none |

## Conditions (CH-C1..CH-C9): status

| Condition | Status | Evidence (code anchor; test) |
| :--- | :--- | :--- |
| CH-C1 a missing pin is E_MOVED | MET | workspace-write.ts `hierGuard`: `parentId: i.in_folder_id ?? i.in_space_id ?? '', parentPath: i.parent_path ?? '', workspace: i.in_workspace ?? ''`. client.ts `checkParentPins`: `if (!g.parentId \|\| g.parentId !== p.id \|\| !g.parentPath \|\| ...) throw new ClickUpError(E.MOVED)`, and all mode requires `g.workspace`. `createSpace`: `if (!g.workspace \|\| g.workspace !== workspaceLabelText(t.teamId, t.teamName))` in both modes. Every check runs before `await g.beforeWrite()`. Tests: hierarchy.test.ts "run() with the pins stripped: E_MOVED, no POST, no take (each tool; all mode too)" and "through runApproved, a stored input with full pins whose parent was renamed gives E_MOVED, no take". |
| CH-C2 a created space never overrides an authoritative list | MET | client.ts `noteCreatedSpace` does `if (inflight) await inflight.catch(...)` (all mode) and `if (spacesInflight) await spacesInflight...` (numeric). `loadSpaces` shares one load: `spacesInflight ??= doLoadSpaces()`. There is no TTL merge map. Duplicate owner: `if (sc.si.has(sid) \|\| [...teamSpaces].some(([t, v]) => t !== tid && v.m.has(sid)))` removes the id from every team. Tests: hierarchy.test.ts "numeric: the space is in scope at once ..., a later authoritative list without it removes it", "numeric: a refresh in flight ... does not drop the new space", "all mode: the space is inserted into SI ...", "all mode: an id that another team also lists is in no team's scope ...", "a refresh in flight ... the next full refresh without it removes it". |
| CH-C3 invalidate unless a definite 4xx | MET | client.ts `createPost`: E.BUSY before any request and a 429 return with no invalidate. A 4xx other than 408 gives `E.CREATE_REFUSED`. Every other failure calls `invalidate()` and then gives `E.CREATE_UNKNOWN`. A 2xx calls `invalidate()` before the id check. Space invalidate: `invalidateHier(t.teamId); spacesStale = true; if (all) scopeGoodAt = -Infinity`. Tests: "a 4xx: E.CREATE_REFUSED and the counter is spent", "a 429: E.BUSY", the `it.each` over a 500, a 2xx without an id, a 2xx with an invalid id and an unparsable 2xx, and "a POST timeout invalidates the hierarchy; the next hierarchy() refetches". |
| CH-C4 one refusal text per kind | MET (see G2CH-03) | client.ts `describeParent` / `parentRefusal`. Tests: hierarchy.test.ts `describe('CH-C4 one refusal text per parent kind, on both paths')`. The space table covers 404, 403, unknown id, another workspace, archived and id mismatch. The folder table adds hidden and a space out of scope. Each case is checked at precheck and at `run()`, with no card, no POST and no take. A separate test checks "E_MOVED only when a pin no longer matches a parent that is still in scope". |
| CH-C5 numeric create_space pinned | MET | workspace-write.ts `clickup_create_space` schema `...wsPin` in both modes. `describeTeam` reads the name fresh in numeric mode (`GET /team`). Test: "numeric: the team name changes between card and run -> E_MOVED, no take". |
| CH-C6 space counter on filed cards only | MET | workspace-write.ts `spaceCards` is incremented only in the `clickup_create_space` `onApprovalTask`, and checked in `hierPre` after RUN_CAP. Tests: "a 3rd space card in one run is refused; refused space calls do not count; an approved replay is never refused by it" and "a refusal at precheck (duplicate) does not use up the space cap". |
| CH-C7 SPACE_DEFAULTS shape | MET | client.ts `const SPACE_DEFAULTS = Object.freeze({ ... features: Object.freeze({ ... Object.freeze(...) }) })` is frozen at every level and not exported. The body is the literal `{ name: o.name, multiple_assignees: SPACE_DEFAULTS.multiple_assignees, features: SPACE_DEFAULTS.features }`, with `portfolios` off. Tests: "create_space (numeric): ... replay posts exactly {name, multiple_assignees, features}". `.strict()` refuses `features`, `private`, `multiple_assignees` and `admin_can_manage` (hierarchy.test.ts schema test). |
| CH-C8 approval unconditional, no grant surface | MET | All three tools spread `base` (`requiresApproval: () => ({ reason: REASON })`). Tests: "direct, untainted: each tool files a card and touches nothing; no grant surface" (also checks `treeGrantCovers` false and `isNoApproval` false). tools/policy.test.ts `describe('CLICKUP-HIER-1 (CH-C8) ...')` checks Praw only, by `*`. |
| CH-C9 strict schemas and names | MET | `.strict()` on all three schemas. `in_space_id`/`in_folder_id` use `regex(CLICKUP_ID)`, `parent_path` has `.max(80)` and `in_workspace` has `.max(60)`. `hierNameOk` covers 1-100 units, `clean`, `hasHiddenCtrl`, trim, `\s{2,}`, `/[/\\[\]]/` and the `workspaceNameKey !== '?'` check. Tests: the bad-name `it.each` (VS16, ZWJ, zero width space, NBSP only, U+2800 and others), "accepts a Thai name and a Thai name with combining marks". |

Spec test list (binding): the duplicate fold (case, Cyrillic look-alike, same first 30 units) at precheck and at run, the parallel-replay mutex (one POST), E.SPACE_CAP at 100, a failed sibling read refusing, ids-only results, an audit row with no ids, a solo 1500-unit card, and batch eligibility (approval-body.test.ts `compactItemFits` false for 1500 and true for short) are all present and passing. The exceptions are G2CH-01 (red) and G2CH-02 (missing).

## Rulings on declared deviations

1. **A folder under an archived space is not refused until the space cache expires. This drops a row from the CH-C4 table. ACCEPTED (Info).**
   - CH-C4 is about the refusal TEXT (no existence oracle), not about how fresh the data is. When the refusal comes, it is E.SCOPE_FOLDER, the same as for every other case.
   - The window is the C6 bound of S(T) and SI: at most 10 minutes, the same staleness `listInScope` already has for task writes into a list of a newly archived space.
   - Every create still needs a person's approval.
   - Optional hardening: one `GET /space/{spaceId}` with an `archived` check in `describeParent` for folders.
2. **A replayed space create costs 5 GETs. ACCEPTED (Info).**
   - Numeric mode: the replay precheck makes 2 GETs (`describeTeam` fresh `GET /team`, then `ensureNew`). `run()` makes 3 (`describeTeam` outside the lock and again inside it, then `ensureNew`). That is 5 GETs plus 1 POST. All mode reads the team from the cached scope, so it costs 2 GETs plus 1 POST.
   - Worst case: one run files at most 5 cards (RUN_CAP), so 5 replays cost 25 GETs plus 5 POSTs. Inside one minute that stays within the shared 80/min bucket. The limiter refuses with E.BUSY before any request, so this cannot cause a 429 loop.
   - The spec said "at most 4 GETs"; this is a small cost difference, not a security one.
3. **The G1CH-01 registry-replay gap is deferred. ACCEPTED, carried forward.**
   - Gate 1 CH-C1 put it explicitly out of scope: it needs an `approved` flag passed from tools/registry.ts into precheck.
   - It stays open for the next registry change. It cannot be reached today: the stored value always holds the pins, and the replay precheck re-binds them fresh.
4. **The space counter is keyed by `runKey(ctx)`. CONFORMS to CH-C6, so this is not a deviation.**
   - `ctx.run` is required (tools/types.ts `run: RunState`), so the `?? ctx` fallback never runs.
   - The counter shares its key with `filed`.
5. **A space id with two owners is removed from every team's scope until the next authoritative list. CONFORMS to CH-C2(d).**
   - This matches `doRefresh`, which drops a space id seen under two teams (fail closed).
   - The cost is availability only: the new space is unusable until a refresh settles who owns it.
6. **Not declared: in all mode, a workspace renamed to a different name between card and run gives E.NO_TEAM, not E_MOVED (spec §3.5 says E_MOVED). ACCEPTED.**
   - It is refused before the take, with a fixed text, and there is no POST (test "all mode: a workspace renamed to another name between card and run -> ... E.NO_TEAM, no take").
   - A rename onto another team's old name is still caught by the label hash (`workspaceLabelText` hashes the team id) and by `t.teamId !== first.teamId`.
   - A case-only rename gives E_MOVED on both paths (test "CH-C5 all mode: a case-only rename ...").

## Other checks (all PASS)

- **Secrets.** No credential in the changed code. The fake token is a test fixture. C5: `JSON.stringify(sanitize(i, secrets)) !== JSON.stringify(i)` refuses with WE.REDACTED before any card.
- **Injection and path.** Every path segment goes through `pathId(CLICKUP_ID, ...)`, with the team id passing TEAM_ID at refresh. The POST bodies are literals of typed fields: `{name}` for a folder, and `{name, content?}` for a list. There is no spread of the input, and no `parent_folder_id`, `markdown_content`, assignee, status or privacy key.
- **Card spoofing.** `hierName` blocks `/ \ [ ]`, invisible characters and doubled whitespace, so a created name cannot later spoof `listPathText` or the `[h6]` hash. Vendor names pass through `cleanVendorText` and `escapeCardText`. `name` is a TARGET_KEY shown whole (VALUE_MAX 120, while the name is at most 100). `cardShowsWhole(syntheticCard(...))` refuses any card that would not show whole. `PINNED_BY` widens the pinned set, but pins are always shown.
- **AuthZ.** The tools reach Praw only, by `*`. They spread `base`. There is no tree grant, no NO_APPROVAL entry and no bot-talk path. Folders and lists take their team from SI, never from input. A space in all mode takes it through `teamByName`, then `collide`.
- **Idempotency.** `withLock` is a per-parent promise chain held across re-resolve, pins, the fresh sibling read, `beforeWrite` and the POST. The map entry is deleted when the chain ends. The POST is never retried (`guardCall` has no retry).
- **Log privacy.** `warnSpace` logs `{ kind }` only. The audit row `clickup.hierarchy.created` holds the tool name and kind only. An audit failure is swallowed after a create that happened. The int test (before its red step) and the unit test "the audit row holds the kind only" assert that no ids or names appear.
- **Results.** Ids only (C4). Error texts are the fixed constants in `E` and `WE`; no vendor body is echoed.
- **Supply chain.** No dependency change in this task. The package.json diff touches scripts only and belongs to other work. `npm audit --omit=dev --audit-level=high`: 0 vulnerabilities.
- **Native memory, containers, prompt reasoning isolation.** N/A: TypeScript tool code, no container change, no prompt change.

## Checks run

- `npx vitest run --project unit tools/plugins/clickup discord/embeds/approval-body.test.ts tools/policy.test.ts tests/readme.test.ts`: 12 files, 394 passed, 1 skipped.
- `npx vitest run --project int tests/integration/clickup-workspace.int.test.ts`: 14 passed, 1 failed (G2CH-01), the same result on 3 runs.
- A debug copy of the failing int test, run from the scratchpad with absolute imports and then deleted. No project file was created or changed. It printed the approval row and the provider calls (evidence for G2CH-01).
- `npx tsc --noEmit -p .` filtered for clickup and embeds/approval: no errors in the audited files.
- `npm audit --omit=dev --audit-level=high`: 0 vulnerabilities.

Not run:
- eslint: the run failed with a config error (flat-config migration message), consistent with the repo-root `eslint.config.mjs` showing as deleted in the working tree.
- A live ClickUp check (no network actions). R9 default visibility and the `private` value ClickUp returns are still unverified live; the owner signed R9.
- A build, and the live app.

## Missing context

- `/Users/pakawat.tan/Desktop/Labworkspace/BOT/Assistant/.claude/rules/` and `BOT/Assistant/CLAUDE.md` do not exist. The repo-root `CLAUDE.md` is deleted in the working tree. The team rules `/Users/pakawat.tan/.claude/team/rules/{_global,labworkspace}/security.md` were used.
- The Book `/Users/pakawat.tan/.claude/team/knowledge/labworkspace/00-INDEX.md` was not read; the brief named the files.

## md5 of audited files (at review end)

- `497ad99863fd58e69988eb4cafc31ee5`  tools/plugins/clickup/client.ts
- `1abb580e112c00277e55d08e8e430492`  tools/plugins/clickup/workspace-write.ts
- `29799dc200929f03e33ee9dbda8b3bcc`  discord/embeds/approval.ts
- `206792ac40802d7e45d8aad30c16fc8c`  tests/fakes/clickup-workspace.ts
- `a2bdaf34816706d0b8db681d41fa5f5a`  README.md
- `1f106fbae3485904be861262461582f8`  tools/plugins/clickup/hierarchy.test.ts
- `8c7dd5642e87f0a5e287b73baaa7e1d0`  tools/plugins/clickup/workspace.test.ts
- `a5da19bcdb5a77cb8c429dd4d782c905`  tools/plugins/clickup/workspace-write.test.ts
- `0f048041dcc988551cabd188f86e6c42`  tools/plugins/clickup/clickup.test.ts
- `750a7a10b7a55a5eb3cd1b5530988bf3`  discord/embeds/approval-body.test.ts
- `73ea88c62e1de666bc3d92301f5dec99`  tools/policy.test.ts
- `275ca474c372b32273761150f2754fec`  tests/integration/clickup-workspace.int.test.ts
- `b072ccfc0575ca055452529d0ef6f973`  docs/superpowers/specs/2026-11-09-clickup-hierarchy-create-design.md

## Closure of G2CH-01 / G2CH-02 (tester, 2026-11-09)
- G2CH-01: closed. Cause was the int test script (turn count), not delivery. The approved "Created space <id>" result is delivered in the same task's continuation turn (`result_delivered_at` set); explicit assertions added to tests/integration/clickup-workspace.int.test.ts.
- G2CH-02: closed. The HIER chain test now runs `/clickup watch add` of the new list (plus a negative control).
- Full suites after the tester round: unit 4326/2, int 1152, tsc clean. Security files unchanged by the tester (tests only).
- Final: per §1 of this report, the condition (both int tests green, security files unchanged) is met — md5 of client.ts, workspace-write.ts and approval.ts verified equal to the list above on 2026-11-09 by the main thread. Status APPROVED. Deployed 2026-11-09.
