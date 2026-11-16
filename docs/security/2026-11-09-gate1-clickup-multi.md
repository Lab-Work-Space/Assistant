---
title: "Security Gate 1: CLICKUP-MULTI-1 (ClickUp all-workspaces mode)"
gate: 1
status: CONDITIONAL_APPROVE
date: 2026-11-09
spec: docs/superpowers/specs/2026-11-09-clickup-multi-workspace-design.md
prior: docs/security/2026-11-08-gate1-clickup-workspace.md (C1-C12, R1-R6 signed 2026-11-09), docs/security/2026-11-08-gate2-clickup-workspace.md (G2CW-01..04)
---

# Security Gate 1: CLICKUP-MULTI-1 (ClickUp all-workspaces mode)

- Gate: 1 (spec review). Task: CLICKUP-MULTI-1.
- Code read to check the spec's claims (current tree): core/env.ts (`CLICKUP_TEAM_ID: z.preprocess(blankToUndef, z.string().trim().regex(/^\d{1,20}$/` and the `clickup:` ternary), services/ids.ts (`CLICKUP_ID = /^[a-z0-9]{1,32}$/`), tools/plugins/clickup/client.ts (`createClickUpClient`, `resolveTeam`, `loadSpaces`, `inSpaces`, `listInScope`, `taskInScope`, `describeTask`, `hierarchy`, `resolveList`, `teamTaskPages`, `h6`, `listPathText`), tools/plugins/clickup/workspace-write.ts (`syntheticCard`, precheck pin compare), tools/plugins/clickup/index.ts (`Url: ${t.url ?? ''}`, `untrustedOutput: true`), tools/plugins/clickup/poller.ts (`pass()`), discord/embeds/approval.ts (`toolCallView`, `MAX_SUMMARY_FIELDS = 8`, `escapeCardText`), tools/policy-approval.ts (`REASON_MAX = 500`), discord/commands/plans.ts (`mode !== 'workspace'`), app.ts (`clickup.scope.team()`), scripts/set-tokens.sh (`ask()`, `CLICKUP_TEAM_RE`, VPS block), dashboard/envfile.ts (`CLICKUP_TEAM_RE`, CLICKUP_TEAM_ID note), config/schema.ts (`clickup.pollIntervalSec` min 30).
- No `~/.config/assistant` values were read. No code was edited. Spec amended (section appended, see end).

## Verdict: CONDITIONAL_APPROVE

The spec's core is sound:
- `all` is parsed into its own Env type branch and never travels as a team id string (the spec itself notes that `all` matches `CLICKUP_ID`).
- Scope stays a positive space-id check: SI maps space to team, a task needs `SI[space.id]` and a matching `team_id`, `describeTask` also checks the list's team, and a space seen under two teams is dropped.
- Refusals keep their fixed texts, so they reveal nothing about existence.
- Writes are bound to a workspace pin that is hashed over the team id and name and checked again in `run()` before `take()` (C10 extended).
- Approval, the run cap, the global daily cap and the absence of delete are all unchanged. No grant skips the card.
- More than 10 teams means off, never a truncated auto-pick.

Eight gaps must be closed (CM-C1..CM-C8). Two are High:
- A workspace that the token user is added to later can be named exactly like a real one, and the card cannot tell them apart.
- Name resolution over a capped hierarchy can send a write to the wrong workspace.

## Findings

| ID | Severity | Where (content anchor) | Finding |
| :--- | :--- | :--- | :--- |
| G1CM-01 | High | spec §3.5 `workspaceLabelText` = `seg(cleanVendorText(name))` + ` [h6(teamId+'\n'+name)]`; §3.2 R7 auto-include | **Same-name workspace spoof on the card.** The only thing on the card that tells two workspaces apart is a 6-hex hash, and approvers do not check hashes. Anyone who gets the token's ClickUp user into their workspace (R7, auto-included within 10 min) can name it like the company workspace, for example "Acme". A tricked run can then write company data into a list there, and the card reads "Workspace Acme [3f9a1c]". That is an exfiltration sink that looks identical to a normal write. `E.AMBIG_TEAM` only covers the `workspace` name input, not writes addressed by list or task id. |
| G1CM-02 | High | client.ts `resolveList`: `const h = await hierarchy(); ... hits.length === 1) return hits[0]!.id`; spec §3.4 "cap of 20 spaces is global across teams", "Teams are ordered by name" | **Name resolution over a truncated hierarchy picks the wrong list.** `resolveList` matches by exact name inside the capped hierarchy. In all mode the cap is global and teams are sorted by name. A joined workspace named "AAA" with a list named like a company list ("Roadmap") fills the cap first. Its list is then the only hit, and `clickup_create_task {project:"Roadmap"}` resolves into the foreign workspace. The spec's "more than one hit gives E.AMBIG_LIST" never triggers, because the real list lies beyond the cap. |
| G1CM-03 | Medium | spec §3.2 "keep the last good set on refresh failure"; "TeamError('too_many')" | **Refresh results are not classified.** The spec does not say whether a successful GET /team that returns 0 teams, more than 10, or a 401 counts as a "failure" (keep the last good set) or as an authoritative answer. Two problems follow: (a) a revoked token keeps a stale scope with no time limit (rule 12: stale is not the same as never loaded); (b) if `too_many` on a refresh turns all mode off, then an outsider who adds the token's user to their workspaces can switch the bots' ClickUp off (rule 10: list who can trigger a lockout). |
| G1CM-04 | Medium | spec §3.2 "A refresh that changes the team count writes audit `clickup.teams.changed`" | **Detecting changes by count misses a swap.** If one workspace leaves and another joins between refreshes, the count stays the same. No audit row and no notice are written, so R7 happens silently. |
| G1CM-05 | Medium | core/env.ts `clickup:` ternary (LIST wins); set-tokens.sh VPS block ("ask TEAM only if LIST not given"); dashboard/envfile.ts | **A leftover `CLICKUP_TEAM_ID=all` breaks the C3 rule that removing a setting never widens access.** If a LIST id is set while an old `TEAM_ID=all` stays in the env, later clearing the LIST, by accident on the dashboard or with a blank value, jumps from one list to every workspace. This already applied with a numeric team, but the blast radius is now every workspace. |
| G1CM-06 | Medium | spec §3.5 "If it can exceed the 300 used by syntheticCard, raise"; workspace-write.ts `reason: '['.repeat(300)`; tools/policy-approval.ts `.slice(0, REASON_MAX)` with `REASON_MAX = 500`; approval.ts `MAX_SUMMARY_FIELDS = 8` | **The card budget is not proven.** The central reason is `tool X on <target>: <change>`, sliced at 500 (not 300). With the new target (`Workspace` 40 + path 110 + list id 32 + task label 110 + task id), the worst case is about 330 characters before the change text. The synthetic card must model the real worst case. `in_workspace` adds a 4th pin field, so `clickup_update_task` with every optional field set can pass `MAX_SUMMARY_FIELDS` (cut becomes true, the C1b check refuses, and a valid call fails). |
| G1CM-07 | Low | index.ts workspace `clickup_get_task_detail` `` `Url: ${t.url ?? ''}` ``; spec §2 "Team ids never appear in tool output" | **The spec's claim is false today.** A task url with a custom id has the form `/t/<team_id>/<custom_id>` (G2CW-03), so team ids reach model output. The claim must either be made true or be corrected. |
| G1CM-08 | Low | spec §5 rate budget "comments excluded"; G2CW-02; config/schema.ts `clickup.pollIntervalSec` `.min(30)` | **The rate budget leaves out the comment checks** (2 requests each, up to 20 a tick). G2CW-02 already estimated about 90/min at 30 s in one-team mode. All mode adds up to 10 cold lookups. The bucket is shared by the tools and the poller, so tool calls get E_BUSY. |
| G1CM-09 | Low | client.ts `const wsTeam = !listId && o.teamId ? vendorId(CLICKUP_ID, o.teamId)`; `t.id === wsTeam` | **Defense in depth.** The client would accept `teamId: 'all'`. Team ids returned by GET /team are used as path segments without a digits check. |
| G1CM-10 | Info | spec §3.6 "Any team request that fails → the whole call throws" | One joined workspace that keeps failing (for example a plan downgrade or a 403) stalls notices for every team. This is an availability issue only. |

Checked and passing at spec level:
- Strict parsing: the env value is trimmed before the regex, and the regex is case-sensitive.
- A token alone stays off.
- LIST wins over `all`.
- `mode` keeps the value `'workspace'`, so every existing gate (app.ts, plans.ts, index.ts, write.ts) still applies.
- Team ids are kept out of errors, audit rows and logs (C12 extended).
- The `workspace` input passes `clean()`.
- `E.NO_TEAM` and `E.AMBIG_TEAM` are fixed texts.
- The C8 re-filter is per queried team.
- The global daily cap is kept, rather than one cap per team.
- Watched lists are capped at 10 and checked against the union, and the `skipped` set is removed before the baseline.
- C6 is held at one forced refresh per 60 s, at most 11 requests.

## Rulings on open questions

- **OQ-A: strict lowercase `all`.** `ALL` and `All` throw an error that names the key and not the value. The same rule applies in env.ts, dashboard/envfile.ts and set-tokens.sh (bash `[[ =~ ]]` is case-sensitive unless `nocasematch` is set, and the script must not set it).
- **OQ-B: cap of 10 teams.** Over 10 at boot means ClickUp is off with E.TEAMS. A refresh after a good boot follows CM-C3.
- **OQ-D: count only** in #bot-log and audit. Change detection uses the set difference (CM-C4). The approver sees the workspace name on every write card, which is where it matters.
- OQ-C goes to the owner (see residuals).

## Binding conditions

1. **CM-C1 (G1CM-01) No writes into a workspace whose name collides.**
   - Normalise every team name with `cleanVendorText` → NFKC → casefold → collapse whitespace.
   - If two teams in 𝒯 share a normalised name, every write (precheck and `run()`) whose target team is one of them is refused with fixed text, for example "ClickUp: two workspaces this token can see have the same name; rename one in ClickUp before writing". No card is created and nothing is taken.
   - Reads are not affected.
   - An empty normalised name counts as `?` and collides with any other empty name.
   - Test: tools/plugins/clickup/workspace-write.test.ts. Two teams named "Acme" and "acme " both refuse create, comment and update with no approval filed. A collision that appears between card and replay gives a refusal at `run()` with no `take()`.
2. **CM-C2 (G1CM-02) Name resolution never resolves across a truncated or multi-team hierarchy by guess.**
   - In all mode, `resolveList` by name returns a hit only when the hierarchy it searched was not truncated. Otherwise it refuses with E.AMBIG_LIST or a fixed text asking for a list id or `workspace`.
   - A `workspace` narrowing (exact name, CM-C1 normalisation) may be accepted to search one team's full hierarchy.
   - Matching by id is unchanged.
   - Test: tools/plugins/clickup/workspace.test.ts. Team "AAA" fills the 20-space cap and holds list "Roadmap", team "Acme" beyond the cap also holds "Roadmap": `resolveList('Roadmap')` refuses and never returns AAA's id.
3. **CM-C3 (G1CM-03) Refresh outcomes are classified.**
   - (a) A transport failure (network, timeout, 429, 5xx) keeps the last good 𝒯/SI, emits `log.warn` and is retried at most once per 60 s. The last good set is used for at most 60 min after its last success. After that, all mode refuses with E.TEAMS until a refresh succeeds.
   - (b) 401 and 403 on GET /team are authoritative: drop 𝒯/SI immediately and refuse.
   - (c) A successful answer with 0 teams drops the set (E.TEAMS).
   - (d) A successful answer with more than 10 teams after a good boot keeps the last good set (no widening, no outsider-triggered lockout). Any team not in the last good set stays out. Teams that have left drop out. Write audit `clickup.teams.too_many` (count only) and one #bot-log notice.
   - At boot, more than 10 teams means off (OQ-B).
   - A failed space GET for team t leaves t with its own last good spaces within the same 60-min bound, or none. It never borrows another team's spaces.
   - Tests: tools/plugins/clickup/clickup.test.ts. A 503 keeps scope for up to 60 min and then refuses. A 401 refuses at once. 11 teams after a good boot keeps the old 10 (a new 11th team is unreadable). 0 teams refuses.
4. **CM-C4 (G1CM-04) Detect changes by set, not by count.**
   - `clickup.teams.changed` fires whenever the id set differs.
   - Its outcome is `count:<a>-><b>,+<added>,-<removed>` (counts only, no ids, no names), and it posts one #bot-log notice with the same counts.
   - Test: clickup.test.ts. Swapping team B for team C at the same count writes one audit row `count:2->2,+1,-1` that contains no team id.
5. **CM-C5 (G1CM-05) No leftover `all` under a list id.**
   - (a) set-tokens.sh in both modes: when CLICKUP_LIST_ID is set, CLICKUP_TEAM_ID is cleared (local: `stage CLICKUP_TEAM_ID ""`; VPS: `lw env unset $APP CLICKUP_TEAM_ID`), just as giving a team clears the list.
   - (b) env.ts: when both a list id and `TEAM_ID=all` are present, boot emits one `log.warn` with no values ("CLICKUP_TEAM_ID=all is ignored while CLICKUP_LIST_ID is set; clearing the list id opens every workspace").
   - (c) The CLICKUP_LIST_ID note in dashboard/envfile.ts says that clearing it while CLICKUP_TEAM_ID is set widens access.
   - Tests: tests for set-tokens `--dry-run` (list given → TEAM staged empty), core/env.test.ts (warn emitted, value absent), a dashboard envfile test (the note is present).
6. **CM-C6 (G1CM-06) The card budget is proven against the real worst case.**
   - `syntheticCard` uses a reason of the real maximum length: `min(REASON_MAX, worst target + change)`, all characters escaping.
   - `in_workspace` and `list_path` are rendered whole on both the solo card and the batch item.
   - `clickup_update_task` with every optional field and all four pins gives `cut === false`. If it does not, the pins are excluded from the `MAX_SUMMARY_FIELDS` count or rendered as their own field. Never raise the cut by dropping a pin.
   - Tests: discord/embeds/approval-body.test.ts (worst-case reason at 500, 4 pins plus every update field, solo and batch, `cut === false`, within Discord limits). workspace-write.test.ts (the synthetic reason length equals the computed maximum).
7. **CM-C7 (G1CM-07, G1CM-09) Team ids stay out, and the sentinel never becomes an id.**
   - (a) In workspace mode (one or all), `Url:` is rebuilt as `https://app.clickup.com/t/<task id>` from a CLICKUP_ID-checked id, or dropped. The vendor `url` is never shown.
   - (b) `createClickUpClient` throws when `teamId === 'all'`, when `teamId` is not `/^\d{1,20}$/`, and when both `teamId` and `allTeams` are given.
   - (c) Team ids from GET /team are used only if they are strings that match `/^\d{1,20}$/`. Others are dropped and counted toward neither 𝒯 nor the cap. Write one `log.warn` with the count.
   - (d) `scope.team()` throws E.WORKSPACE_ONLY in all mode, and app.ts calls `teamsReady()` in that mode. Grep shows that `clickup.scope.team()` in app.ts is the only external caller.
   - Tests: clickup.test.ts (a planted team id and a custom-id url are absent from every tool result, error, audit row and log line in both modes; client constructor matrix; a team with id `"all"` or `"1/../x"` in GET /team is dropped).
8. **CM-C8 (G1CM-08) The poll budget includes comments.**
   - In all mode, either the poller reuses the scoped task it already re-filtered (no second GET /task per comment check), or the effective poll interval is at least 60 s.
   - The spec's rate table counts comment requests.
   - Test: tools/plugins/clickup/poller.workspace.test.ts (one tick with 10 teams and 20 comment checks stays at or under 40 requests at the configured floor).

The spec's TESTS list stays binding as written, adjusted for CM-C1..CM-C8.

## Non-binding recommendations
- G1CM-10: isolate per-team poll failures. Skip the failing team for that tick, and back off only when every team fails. Keep the C8 re-filter.
- A watched list that leaves scope and later returns: re-baseline it silently instead of comparing against its old baseline, to avoid a burst of notices.
- Repeat the strongest boundary: use a dedicated ClickUp member token that belongs only to the company workspaces, with "join workspace" invites handled by a person. In ClickUp, being added to a workspace normally requires accepting an invite (`assumed`, not verified here).

## Residual risks for the owner (plain words, need sign-off: OQ-C)
- **R7. New workspaces are included automatically.** If the ClickUp account behind the token is added to another workspace, a client's or a stranger's, the bots can read it and propose writes into it within about 10 minutes. You get a count notice in #bot-log, not a name. A stranger's workspace is then both a source of tricky text for the bots and a place a tricked bot could copy company data into. Every such write still needs your approval and shows the workspace name. CM-C1 blocks look-alike names.
- **R8. Text can cross workspaces.** One tricked run can read something in workspace A and propose writing it into workspace B. The card shows the destination workspace, the path and the full text. Read the destination before you approve.
- **R1, now wider. Every workspace can be read in Discord.** Any bot with ClickUp tools can read every project in every workspace the token can see, client and personal workspaces included, and repeat it in Discord rooms and the notice channel. Reads need no approval.
- **R2, now wider. Member emails from every workspace.** Member lists, with emails, of every workspace can appear in Discord rooms.
- **Lockout at restart.** At boot, more than 10 teams means ClickUp is off (OQ-B fail closed), so someone who adds the token's account to enough workspaces can switch ClickUp off at the next restart. After a good boot this cannot happen (CM-C3 d).
- R3 to R6 (signed 2026-11-09) still apply, now across every workspace. The daily cap of 50 is shared across all workspaces.

## Missing context
- Project rules `/Users/pakawat.tan/Desktop/Labworkspace/BOT/Assistant/.claude/rules/` do not exist. The team rules `/Users/pakawat.tan/.claude/team/rules/{_global,labworkspace}/security.md` were used.
- The Book 00-INDEX was not opened. The brief named the files.

## Owner sign-off (2026-11-09)
Owner accepted R7 (auto-include joined workspaces), R8 (cross-workspace text carry, every write still approved), widened R1/R2 (all workspaces and member emails readable in Discord), and the >10-workspace lockout at restart. Answer: "รับได้ ทำต่อ". Build proceeds under CM-C1..CM-C8.
