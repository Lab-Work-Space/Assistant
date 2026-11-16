---
title: "Security Gate 1: CLICKUP-HIER-1 (create ClickUp space / folder / list)"
gate: 1
status: CONDITIONAL_APPROVE
date: 2026-11-09
spec: docs/superpowers/specs/2026-11-09-clickup-hierarchy-create-design.md
prior: docs/security/2026-11-08-gate1-clickup-workspace.md (C1-C12, R1-R6 signed), docs/security/2026-11-09-gate1-clickup-multi.md (CM-C1..C8, R7/R8 signed), docs/security/2026-11-09-gate2-clickup-multi.md (G2CM-*)
---

# Security Gate 1: CLICKUP-HIER-1 (create ClickUp space / folder / list)

- Gate: 1 (spec review). Task: CLICKUP-HIER-1.
- No `~/.config/assistant` values were read and no code was edited. The spec was amended: a section was appended at its end.
- Code is cited by content anchor. Line numbers are hints only.

## Code facts checked

| Spec claim | Result | Evidence (content anchor) |
| :--- | :--- | :--- |
| Praw gets every registered tool through `tools: ["*"]` | TRUE | prompts/heads/praw.md `tools: ["*"]`; tools/policy.ts `WILDCARD_DEPT = 'praw'`, `if (dept === WILDCARD_DEPT && promptTools.includes('*')) for (const n of all) out.add(n)` |
| No other head gets the new tools by default | TRUE | config/defaults.ts `const CLICKUP_READ = [...]` (read names only), `'tools.byDept'` rows `...CLICKUP_READ` |
| A skill or `bot_tools` change can grant them (R4) | TRUE, and wider | tools/skill-grant.ts `skillToolAllowed` admits any registered non-sensitive `write` tool; discord/approval-rooms.ts `SENSITIVE_TOOL` does not match `clickup_` |
| `HIDDEN_CTRL`, `listPathText` (SEG_MAX 30, h6), `workspaceNameKey`/`workspaceDisplayKey`, `collide`, `teamByName` | TRUE | tools/plugins/clickup/client.ts at the named functions; `collide` is built over both keys in `doRefresh` |
| `MAX_SPACES` is 100 and both space loads slice at it | TRUE | client.ts `const MAX_SPACES = 100`; `loadSpaces` and `doRefresh` `.slice(0, MAX_SPACES)` |
| The in-flight refresh can overwrite SI | TRUE | client.ts `refreshScope` `inflight ??= doRefresh()`; `scopeAll = { teams: next, si, spacesOf, collide }`. Numeric mode: `loadSpaces` sets `spaces = m` with NO in-flight dedupe, which the spec leaves out (see G1CH-02) |
| `WriteGuard.listId` is required | TRUE | client.ts `export type WriteGuard = { listId: string; ...` |
| `WORST_TARGET_LEN`, `SYNTHETIC_REASON_LEN` = 500, `filed` per run | TRUE | workspace-write.ts at those names. New targets are about 170 units at most, so 500 holds |
| `PIN_KEYS`, `FULL_BODY_TOOLS`, Body gate and `pinned` keyed on `in_list_id` | TRUE | discord/embeds/approval.ts `const PIN_KEYS`, `bodyKey = ... typeof raw['in_list_id'] === 'string'`, `const pinned = typeof raw['in_list_id'] === 'string'` |
| The approved replay's result reaches the model's next turn | TRUE | agents/approved-tools.ts `pending(taskId)`, `delivered(ids)`, `resultText` |
| Registry `tool` audit row | TRUE | tools/registry.ts `ctx.audit({ ... action: 'tool', tool: name, ... outcome })` |
| `treeGrantCovers` stays false | TRUE | tools/tree-grant-scope.ts `treeGrantCovers` requires `own === false`; the `base.requiresApproval` returns `{ reason: REASON }`, so `own` is truthy |
| "Every create still needs approval", even for a direct untainted Praw chat | TRUE, if the tools use `base` | `approvalFor` returns false for `ctx.direct && !ctx.tainted()`, but the registry ORs the tool's own `requiresApproval` (`central \|\| own`). The card relies on `own` alone (CH-C8 test) |
| A 1500-unit description card goes solo | TRUE | discord/commands/approval.ts `eligible: (a) => d.rooms.routable(a) && compactItemFits(a, d.secrets)` |
| Run caps cannot race inside a run | TRUE | agents/loop.ts `for (const u of uses) { ... await registry.run(...)` runs calls one after another; registry `onApprovalTask` is called once per filed card |
| The POST is never retried | TRUE | client.ts `guardCall` has no retry; services/http.ts `AbortSignal.timeout(timeoutMs)` with a default of 15 s, so the per-parent mutex is time-bounded |
| "Every schema is strict zod" | NOT ACCURATE | The workspace-write.ts schemas are plain `z.object` (unknown keys are stripped, not refused). Harmless, because the parsed value is what gets stored, but the wording must be corrected (G1CH-08) |
| ClickUp Create Space has no privacy field | VERIFIED (vendor docs) | developer.clickup.com/reference/createspace: body is `name`, `multiple_assignees`, `features` (all required). `private` appears only in the response. Update Space accepts `private` and `admin_can_manage`, but no update tool exists |

## Verdict: CONDITIONAL_APPROVE

The design reuses the controls that matter:
- one approval card per create, with no grant path, no tree grant and no direct-chat waiver;
- the shared run cap of 5 and the global daily cap of 50;
- C5 redaction refusal and the C1b whole-card check;
- a CM-C1 refusal when two workspace names collide;
- re-binding of pins at `run()` before `take()`;
- a fresh sibling check under a per-parent lock, which also guards against a duplicate after a timeout;
- POST bodies built from typed fields only, with members, privacy, statuses and assignees out of reach;
- result texts that contain ids only;
- audit rows that contain no ids or names;
- no delete.

Nothing here is High. Nine gaps (one Medium, the rest Low or Info) must be closed before Gate 2 (CH-C1..CH-C9).

## Findings

| ID | Severity | Where | Finding |
| :--- | :--- | :--- | :--- |
| G1CH-01 | Low | spec §5 `HierGuard = {parentId?: string; parentPath?: string; workspace?: string; beforeWrite()}`; §3.3 step 4; tools/registry.ts `const merged = tool.inputSchema.safeParse({ ...(value as object), ...(pre.pin as object) })` | **The guard fields are optional, so `run()` can skip the re-bind.** If `run()` compares a pin only when it is present, a call that reaches `run()` without pins writes with no C10 re-bind. Through the registry this cannot happen today, for two reasons. First, the card stores `value` AFTER the pin merge, so a stored row of a new tool always holds its pins. Second, on `runApproved` the registry runs precheck again and merges fresh pins before `run()`, so a pin-less stored row would get fresh pins and pass. That is a precheck-level gap, but `ToolContext` has no replay flag (tools/types.ts), so precheck cannot tell the two paths apart. Risk needs a future code path. The existing `guardFor` has the same pattern (`listId: i.in_list_id ?? ''`). |
| G1CH-02 | Medium | spec §3.3 step 9 "createdSpaces ... doRefresh merges it in only when that team's space GET succeeded without the id" | **The cache merge overrides an authoritative answer, and numeric mode is not covered.** (a) A successful space GET that leaves the id out is ClickUp's answer: the space may already have been deleted, archived, or made inaccessible to the token. Re-adding it from a local map for 10 minutes keeps an id in scope against that answer. This conflicts with "a positive space-id check" (C6, CM-C3), even though a GET on a deleted space would 404. (b) Numeric mode has the same race: `loadSpaces` runs without an in-flight dedupe and sets `spaces = m`, but the spec covers only `doRefresh`. |
| G1CH-03 | Low | spec §3.3 step 9 "Cache, after a 2xx" | **No cache refresh after an unknown outcome.** After a timeout, 5xx or network error, the object may exist in ClickUp but stay invisible to the cached hierarchy and spaces for up to 10 minutes. The model then sees no duplicate in `clickup_list_projects` and proposes the create again under a slightly different name, which slips past the duplicate key. The run-time sibling GET is fresh, so an exact-name retry is caught. |
| G1CH-04 | Low | spec §3.2 "A 404 or 403 is refused with a fixed text"; §5 `E.SCOPE_SPACE / E.SCOPE_FOLDER` | **The refusal texts can become an existence oracle.** The spec does not say which text covers not found, forbidden, out of scope, archived and hidden, nor that precheck and `run()` must use the same text. A different "archived" text for an out-of-scope id would tell the model that the id exists in some workspace the token can reach. |
| G1CH-05 | Low | spec §3.1 "Numeric mode targets T through resolveTeam"; workspace-write.ts `pins = { ...basePins, ...(all ? { in_workspace ...} : {}) }` | **Numeric `create_space` carries no pin at all.** Nothing in the stored input binds the approval to a workspace. If CLICKUP_TEAM_ID is changed and the app restarted while a card is pending (cards live 24 h), the approved replay creates the space in the new workspace. Folder and list are safe, because their parent id is scope-checked against the new T. The card also shows no workspace at all in numeric mode. |
| G1CH-06 | Low | spec §3.4 "at most 2 clickup_create_space cards per run (in-memory, same runKey)" | **Where the space counter counts is not specified.** `filed` counts in `onApprovalTask`, the request path only, and precheck checks it on both paths. If the space counter were incremented in precheck or `run()`, an approved replay could be refused, or refused cards would use up the cap. |
| G1CH-07 | Low | spec §6 R9 "probably visible" | **R9 is now partly verified.** The vendor docs confirm that Create Space offers no privacy field, so the bots cannot create a private space. The default visibility (every workspace member) is still to be confirmed live. The approver needs to know this when approving, and the card does not say it. |
| G1CH-08 | Info | spec §3.1 "Every schema is strict zod" | The schemas are not `.strict()`. Either use `.strict()` on the three new schemas or correct the claim. Recommended: `.strict()`, so a forged extra key is an error instead of being silently dropped. |
| G1CH-09 | Info | spec §3.1 `hierName` | Validation may be too strict for real names. The owner writes Thai. Thai letters and combining marks pass `HIDDEN_CTRL` and `clean()`, but nothing tests this. Emoji built with ZWJ (U+200D, Cf) or VS16 (U+FE0F) are refused by design; the spec should say so. |

Checked and passing at spec level:
- Tool grant: Praw only, by `*`. The heads' byDept lists read tools only.
- Workspace mode only. List mode registers none of the three tools, and the snapshot is unchanged.
- In all mode, `workspace` is required for a space and passes `teamByName` (CM-C1 key), then `collide`.
- Folder and list derive their team from SI, never from input.
- `hierName` blocks `/ \ [ ]`, controls, invisible characters, leading, trailing and doubled whitespace, and an empty key. This stops spoofing of the path separator and the `[h6]` hash on the card.
- Duplicate detection uses both the full key and the displayed-segment key (look-alikes, the first 30 units).
- POST bodies use typed fields only: no `parent_folder_id`, `assignee`, `status`, `priority`, `due_date`, `markdown_content`, `private` or members.
- `content` is plain text, covered by C5 and shown whole as Body.
- The SI insert happens only when no other team owns the id, and the id must pass CLICKUP_ID.
- E.SPACE_CAP at 100 or more keeps a new space from falling outside `MAX_SPACES`.
- A 4xx gives the fixed text E.CREATE_REFUSED, so no vendor message is echoed.
- The audit row `clickup.hierarchy.created` holds only `space|folder|list`. Logs hold counts only (C12, CM-C7).
- The result is ids only (C4) and needs no untrusted wrapper.
- The rate cost (at most 4 GETs plus 1 POST) is within the 80/min bucket. Rule 10 check: no new lockout path. A stranger can fill a joined workspace to 100 spaces, which blocks space creates there only (E.SPACE_CAP). That is not a lockout of the bots.

## Rulings on open questions (security side)

- **OQ-1 (SPACE_DEFAULTS): the spec's proposed values are accepted. The shape is binding, the values are not (CH-C7).**
  - The constant is a deep-frozen module constant.
  - The POST body is exactly `{ name, multiple_assignees, features }`, built by a literal.
  - No config key, env value or tool input reaches it.
  - It must never contain `private`, `admin_can_manage`, members, or any key outside those three.
  - The developer may change the toggle values after the live check without a new gate. Adding any other top-level key needs a security review.
  - None of the nine features grants access to anyone. `portfolios` stays off.
- **OQ-2 (space cards per run): 2 is accepted.**
  - Every card is approved by a person, the run cap of 5 and the daily cap of 50 still bound volume, and an empty workspace needs some room to start.
  - Where the counter counts matters more than 1 versus 2 (CH-C6).
- **OQ-4 (#bot-log notice per created space): no.**
  - The approval card, the registry `tool` row and the `clickup.hierarchy.created` audit row are the record.
  - A notice would add a channel that carries the same information and nothing more.

## Binding conditions

1. **CH-C1 (G1CH-01) In `run()`, a missing pin is "moved", never "skip the check".**
   - In `createSpace`, `createFolder` and `createList`, the guard fields required for that kind must be present and must equal the freshly resolved values:
     - folder and list: `parentId` and `parentPath`;
     - all mode: `workspace`;
     - numeric `create_space`: the team pin from CH-C5.
   - An absent or empty value gives E_MOVED before `beforeWrite()`.
   - Scope note: this closes the gap in the client and the tool's `run()`. It does NOT cover a pin-less stored row on `registry.runApproved`, because precheck refills the pins there and cannot see the path. Closing that needs the registry to pass an `approved` flag into precheck. tools/registry.ts is not in the spec's touched files, so this is NOT required here. It is recorded for a later registry change.
   - Tests: workspace-write.test.ts. (a) Calling the tool's `run()` with the pins stripped gives E_MOVED, with no POST and no take, for each of the three tools. (b) Through `registry.runApproved`, a stored input with full pins whose parent was renamed or moved gives E_MOVED with no take.
2. **CH-C2 (G1CH-02) A created space never overrides an authoritative space list; both modes are covered.**
   - Use the spec's alternative: apply the local insert after awaiting any in-flight refresh, with no TTL merge map.
   - In numeric mode, add the same in-flight dedupe to `loadSpaces` (one shared promise) and insert after it.
   - A later successful space GET that leaves the id out removes it from scope. For the next 60 s a create that fails is an availability cost, not a security one.
   - The insert must also respect the duplicate-owner drop: if any team other than the creator lists the id, it is in no team's scope.
   - Tests: clickup.test.ts. (a) A refresh in flight during `createSpace` ends with the space in scope. (b) The next successful refresh that leaves the id out removes it from scope. (c) Numeric mode: the same race keeps the space. (d) An id that a second team also returns is in no scope.
3. **CH-C3 (G1CH-03) Invalidate on every outcome except a definite 4xx.**
   - After a POST that returns 2xx, times out, gets a 5xx or a network error, or returns an unparsable response, invalidate the hierarchy cache (`teamHier.delete(tid)` or `hierAt = -Infinity`) and mark the spaces cache for refresh at the next use. The C6 limit of one forced refresh per 60 s still applies.
   - For a timeout, a 5xx, a network error, an unparsable response, or a 2xx whose `id` fails CLICKUP_ID (the object was probably created), the result is the fixed text E.CREATE_UNKNOWN: "ClickUp did not confirm the create; check clickup_list_projects before trying again", and the cache is invalidated.
   - A 4xx keeps E.CREATE_REFUSED and a 429 keeps the existing pause and E.BUSY (spec §3.5).
   - Test: clickup.test.ts. A POST timeout invalidates the hierarchy, and the next `hierarchy()` refetches.
4. **CH-C4 (G1CH-04) One refusal text per parent kind, the same on both paths.**
   - For a space parent: not found (404), forbidden (403), out of scope (no SI owner, or another team), archived, and an id mismatch all give exactly E.SCOPE_SPACE.
   - For a folder parent: the same list plus `hidden` and a space out of scope give exactly E.SCOPE_FOLDER.
   - Precheck and `run()` use the same text.
   - E_MOVED is used only when a pin no longer matches a parent that is still in scope.
   - Test: workspace.test.ts. A table of the six cases per kind gives one identical text, at precheck and at run.
5. **CH-C5 (G1CH-05) Numeric `create_space` is pinned to its workspace.**
   - In numeric mode, `clickup_create_space` alone also takes `in_workspace` = `workspaceLabelText(T, teamName)`.
   - The card shows it, and `run()` compares it with the label of `resolveTeam()` now, giving E_MOVED on a mismatch.
   - This is an explicit exception to "numeric schemas unchanged", limited to this new tool. The existing tools are unchanged.
   - The `pinned` predicate already counts `in_workspace` (spec §5), so the card renders it as a pin.
   - Test: workspace-write.test.ts. A numeric client whose team name changes between card and run gives E_MOVED with no take.
6. **CH-C6 (G1CH-06) The space counter counts filed cards only.**
   - It is a second WeakMap keyed by `runKey(ctx)`.
   - It is incremented in `onApprovalTask` only when the tool is `clickup_create_space`.
   - It is checked in precheck (`>= 2` gives a fixed refusal, no card), after the RUN_CAP check.
   - Tests: workspace-write.test.ts. (a) A third space card in one run is refused. (b) A space call refused at precheck does not count. (c) An approved replay is never refused by the space counter.
7. **CH-C7 (OQ-1) SPACE_DEFAULTS shape.**
   - SPACE_DEFAULTS is deep-frozen (`Object.freeze` at every level), not exported for writing, and not read from config or env.
   - The POST body is built by an object literal `{ name, multiple_assignees: SPACE_DEFAULTS.multiple_assignees, features: SPACE_DEFAULTS.features }`.
   - Test: clickup.test.ts. A snapshot of the exact POST body JSON, which has exactly 3 top-level keys and no `private`, `admin_can_manage` or `members`. A tool input with an extra `features`, `private` or `multiple_assignees` key is refused by `.strict()` (CH-C9) and never reaches the body.
8. **CH-C8 Approval is unconditional, and the grant surfaces stay closed.**
   - The three tools spread `base` (`requiresApproval: () => ({ reason: REASON })`).
   - They are not in TREE_GRANT_TOOLS, NO_APPROVAL_TOOLS or any bot-talk list.
   - Tests: workspace-write.test.ts. (a) A direct, untainted Praw context (`ctx.direct = true`, not tainted) still files a card for each tool. (b) `treeGrantCovers(name, 'write', own)` is false for each. (c) `isNoApproval(name)` is false. tools/policy.test.ts: the three names appear for `praw` and for no default head.
9. **CH-C9 (G1CH-08, G1CH-09) Schemas and names.**
   - The three input schemas use `.strict()`.
   - The new pins are typed:
     - `in_space_id` and `in_folder_id` must match CLICKUP_ID;
     - `parent_path` has `.max(80)`;
     - `in_workspace` has `.max(60)`, as today.
   - The spec states that emoji sequences with ZWJ or VS16 are refused.
   - Tests: a Thai name ("โครงการ ทดสอบ") and a name with a Thai combining mark are accepted. An emoji with U+FE0F is refused with WE.BAD_NAME.

The spec's TESTS list stays binding, adjusted for CH-C1..CH-C9. Batch: a `clickup_create_list` with a 1500-unit description is not batch-eligible (`compactItemFits` false), and a short one renders whole as a batch item. Both are tested in approval-body.test.ts.

## Non-binding recommendations

- Make the approval card say that a new space or list will be visible to every workspace member, for example as a fixed `Visibility` field that code adds for the three tools. In a direct run the card shows REASON, not the change text, so this field is the only way to carry it.
- Key `pinned` on a code-defined set of ClickUp tool names, in addition to the presence of the pin keys. A non-ClickUp tool with a loose schema then cannot borrow the pin rendering. It cannot hide anything today, because pins are always shown.
- After the live check, record the `private` value that ClickUp returns for a new space in the README ClickUp rows. Do not log it per create.

## Residual risks for the owner (plain words, need sign-off: OQ-3: R9, R10, R3 and R4 widened, R11)

- **R9. Everyone in the workspace sees what the bots create.** ClickUp gives no "private" option when a space is created, so a new space, and the folders and lists in it, are expected to be visible to every member of that workspace as soon as you approve. In all-workspaces mode this also applies to other workspaces the token can see, including a client's: a space created there is visible to that client's people. To hide one, make it private in ClickUp by hand afterwards. The bots cannot do it.
- **R10. Fixed space settings.** Every new space gets one fixed set of features: due dates, tags, checklists and custom fields on; time tracking, time estimates, dependency features and portfolios off. A bot cannot change these. You can change them in ClickUp.
- **R3, now wider. A tricked bot can propose creating structure.** One run can ask for at most 5 creates, including at most 2 spaces. They share the daily limit of 50 with task writes, so creating structure uses up writes. Each create needs your approval and shows the destination and the name. The bots cannot delete, rename or move anything, so you remove unwanted spaces, folders and lists by hand in ClickUp. A name or list description is also a place where copied text can end up (R8).
- **R4, now wider. Skills can hand out create.** An approved skill or a `/bot tools` change can give space, folder and list creation to any bot, not only Praw. Every create still needs approval.
- **R11. Who ClickUp shows as the creator.** ClickUp records the account behind the token as the creator, and probably as the owner of a new space (`assumed`, not verified). Anyone reading ClickUp will see that account, not the bot.
- R1, R2 and R5 to R8 (signed) still apply.

## Missing context

- `/Users/pakawat.tan/Desktop/Labworkspace/BOT/Assistant/.claude/rules/` does not exist. Team rules `/Users/pakawat.tan/.claude/team/rules/{_global,labworkspace}/security.md` were used.
- The Book `00-INDEX.md` was not opened. The brief named the files.
- The default visibility of a space created through the API, and the `private` value ClickUp returns, were not verified live (no network actions against ClickUp).
- No `CLAUDE.md` exists at `/Users/pakawat.tan/Desktop/Labworkspace/BOT/Assistant/`. The repo-root `CLAUDE.md` is deleted in the working tree (git status). Neither was read.

## Owner sign-off (2026-11-09)
Owner accepted R9, R10, R3 and R4 widened, and R11. Answer: "รับได้ ทำต่อ". Build proceeds under CH-C1..CH-C9.
