---
title: "Gate 1 - R5 RELEASE-1 (GROWTH-1)"
gate: 1
spec: docs/superpowers/specs/2026-11-12-release-design.md
status: CONDITIONAL_APPROVE
date: 2026-11-12
---

# Gate 1: R5 RELEASE-1

Verdict: **CONDITIONAL_APPROVE**. The design is sound: the card has its own table and token, routing only in `route()`, a status CAS, pinned bytes and no `approvals` row. Before BE1 starts, the spec must take in RL-C1 to RL-C6 (blocking). RL-C7 to RL-C14 are checked at Gate 2.

Code is cited by content anchor. Line numbers are hints taken at HEAD 6f0961e.

## What was verified (no condition needed)

- **Who decides.** decide() (discord/commands/index.ts `decide`, "if (i.channelId !== CONFIG_CHANNEL_ID) return { refusal") checks the guild, #setting and the live role. The only exception outside #setting is for `approval:` and `admincfg:`, so `relcard:` cannot use it. `handleInteraction` has one caller (app-start.ts:96, a real interaction), and bots cannot click buttons.
- **Release notes and other tools.** Outward publishing still needs a Bot Admin card:
  - github writes are `card/card` in tools/__golden__/autopilot-classes.json;
  - deploy, site and code match the frozen floor (tools/manifest/floor.ts `PATTERN`), so they are hard-denied to the AI approver and stay in #setting.
  - `RELEASE_NOTE` adds no new way out.
- **The zip.** The export is `WsService.export` unchanged (workspaces/service.ts `export`):
  - the write lock is held;
  - WS-C15(a)/(b) apply: validateRel on names, at most 2000 entries, 50 MB read in total, so no zip bomb beyond 50 MB;
  - workspaces/zip.ts writes no external attributes (no symlink or exec bits) and a fixed 1980 DOS date (no time-zone leak).
  - The bytes are pinned from the same Buffer, so no TOCTOU exists on the bytes themselves.
- **Evidence matching.** The slug matches `^[a-z][a-z0-9-]{1,39}$`, which has no `%`, `_` or `:`. So `LIKE '<slug>:%'` cannot match a neighbour slug. `ws.run` rows are written only at tools/plugins/ws/index.ts:187.
- **Masking.** `postFile` sets `allowedMentions.parse=[]` and sanitizes the file name (discord/port.ts `postFile`). `noHandles` defangs mentions (port.ts `outbound`).

## Findings

| ID | Sev | Where | Issue |
|---|---|---|---|
| F1 | High | spec §5.9 "import allowlist: releases/*.ts never imports …" | This test points the wrong way and is a denylist, against global rule 6. It proves the release code does not call the AI. It does not prove that no AI or tool path can reach `decide`/`claim`. `Pick<ReleaseService,'request'>` (§5.4) is type-only: tools/builtin/grow.ts receives the whole `ToolRequestService` at run time. |
| F2 | Medium | spec §2, §6 "manifest … backstop"; tools/registry.ts "if (approval && !approved && ctx.autopilot" | `autopilot.decide` runs only when the call needs approval. A kindless, `requiresApproval:false` tool never reaches it (the golden `plain/plain` confirms this). `always_card` + `cost_or_lasting` is an inert label, not defence in depth. |
| F3 | Medium | spec §3.3 step 6 "On throw: repo.revert"; port.ts `postFile` sends the file on msgs[0], then loops `msgs.slice(1)` | A throw after the first send, or a REST timeout after Discord accepted the message, reverts to pending. A second Approve then posts the zip twice. This contradicts "never re-post" (GW-C20). |
| F4 | Medium | spec §5.2 `evidence(slug)`, §5.3 changedAfter | (a) Evidence is read after the export lock is released, so a run or write made after the export shows on the card. (b) `db/repos/workspaces.ts:44` hard-deletes a workspace, so a re-created slug inherits the old `ws.run` rows. (c) changedAfter counts only ws_write/ws_delete, but any `run`/`node`/`install` changes /work. (d) The model defines what `test` runs (package.json is bot-written). |
| F5 | Medium | spec §3.6 `void releases.recover()` (app.ts:1047 precedent) | Recovery runs after the clients are up. A click during recovery can be claimed and then marked interrupted while it posts. |
| F6 | Medium | devjob/paths.ts `NON_SELF_MODIFIABLE`; spec §5.7 | `releases/` is added, but discord/commands/release.ts and the boundary test (F1) are not protected. A bot diff could weaken the guarantee or its test. |
| F7 | Low | spec §3.5 line 7, line 3 | The taint flag covers only the requesting run, not earlier runs that wrote the files (global rule 9). The project line comes from the task tree; the workspace row has no project (040_workspaces `created_by` only). |
| F8 | Low | spec §5.6 manifest entry | No `deptOnly:'software'`. Praw gets the tool through "*" (tools/policy.ts `effective` filters DEPT_ONLY after the wildcard). ws_* declare it. |
| F9 | Low | spec §5.5 HANDOFF_BODY `${title}`, `${summary}` | Bot text is defanged but not markdown-escaped, under a header that says "approved by a Bot Admin", so a model-chosen masked link would render. /release show and /release list escaping is not specified. |

## Conditions

### Blocking: amend the spec before BE1

**RL-C1. Structural "no AI path" (F1).**
- (a) An importer allowlist test, kept under `releases/` so it is protected (RL-C6).
  - It parses every non-test `.ts` file outside node_modules and dist: static imports, `import()` and `require`.
  - The only files that may import `releases/service.ts`, `releases/targets.ts` or `db/repos/releases.ts` are app.ts, discord/commands/release.ts, and type-only imports in discord/commands/types.ts, tools/builtin/releases.ts and agents/tasks/ai-digest.ts.
- (b) `releases/*.ts` import only from a named allowlist. This replaces the §5.9 denylist.
- (c) app.ts passes the tool `{ releases: { request: (a, r, i) => releaseService.request(a, r, i) } }`. A test asserts `Object.keys(dep.releases)` equals `['request']`.
- (d) A test asserts that admin/ (AdminOp, admin tools) has no `release` reference.
- (e) The report lists the bypasses that remain: any code holding the DB pool, and reflection through globalThis.
- (f) Gate 2 proves the allowlist with planted bypasses in a scratch copy (global rule 6): a barrel re-export, `import()` of a computed string, and `createRequire`.

**RL-C2. No approvals row, ever (F2).**
- A registry test calls `release_request` under project autopilot, under company autopilot and with the AI approver on.
- It asserts zero `approvals` rows and that `autopilot.decide` is never called.
- Spec §2 and §6 describe `always_card`/`cost_or_lasting` as an inert label; the guarantee is RL-C1 plus this test.

**RL-C3. Never re-post (F3).**
- A test asserts that the maximum-length HANDOFF_BODY is exactly one message.
- Decide by certainty. Revert only when Discord certainly refused the post: a target resolve failure, or a 4xx API error on the first send (for example Missing Access, Missing Permissions or Unknown Channel). This keeps spec §3.7 "thread deleted or denied".
- A 5xx, a timeout, a network error or any unknown throw → `repo.fail(id,'post_unknown')`, with the card note "could not confirm the post; check the task thread" and a head notice. No revert.
- Tests: a resolve failure or a 4xx → pending; a timeout or 5xx → failed, and a second click → not_pending.

**RL-C4. Evidence bound to the pinned bytes (F4).**
- `evidence(slug, since, until)`:
  - `until` = DB `now()` read right after `export` returns;
  - `since` = `workspaces.created_at` for the slug;
  - the run query adds `AND ts > since AND ts <= until` (no run can start during the export, which holds the write lock);
  - the write query adds only `AND ts > since`. It has no upper bound, because ws.write audits after the lock is released, and an upper bound could hide a write that is in the zip. This direction is conservative.
- Store `writesAfterLastRun` instead of changedAfter. The card line reads `ws_write/ws_delete after the last run: yes|no. A ws_run can itself change files.`
- The field name is `Evidence (recorded by code; each verb runs the workspace's own bot-written scripts)`.
- Tests:
  - a run audited after `until` is absent;
  - a write audited after `until` but after the last run shows `yes`;
  - a slug that was deleted and re-created shows no old runs.

**RL-C5. Boot recovery cannot hit a live claim (F5).** `recover(bootTime)` fails only `releasing` rows with `decided_at < bootTime`. `bootTime` is read from DB `now()`, because `decided_at` is DB time. This follows the `skillJudge.recover(bootTime)` precedent (app.ts:1048). Test: a row claimed after bootTime is untouched.

**RL-C6. Protect the guarantee (F6).**
- Add `discord/commands/release.ts` to `NON_SELF_MODIFIABLE`.
- The RL-C1/RL-C2 tests live under `releases/` (already protected by the prefix).
- A devjob paths test asserts that all four release paths are refused.

### Checked at Gate 2

**RL-C7 (F8).**
- `deptOnly:'software'` goes in the manifest entry and in privileged.json `deptOnly`.
- Test: Praw's effective list ("*") lacks `release_request`.
- The service check `not_software` stays.

**RL-C8. Card honesty (F7, R1).** Fixed strings, each tested exactly:
- (a) When the run is not tainted: `Whether earlier runs that wrote these files read outside content is not tracked.`
- (b) The project line reads `Project of the requesting task: …`, plus `The workspace is not linked to a project.`
- (c) The card and the copy body: `Do not run or install it on your own machine; open it in a sandbox.`
- (d) The maximum card is still 1 message.

**RL-C9. Same bytes everywhere.**
- The copy and the handoff are posted from the pinned Buffer with `contentType:'application/zip'`. A text-like type would be rewritten by `redactText` in port.ts `postFile`.
- Int test: the sha256 of both attachments equals the row's `sha256`.

**RL-C10. Text channels (F9, R4).**
- HANDOFF_BODY wraps title and summary in `escapeCardText(…, secrets)` and labels the summary `Summary (written by the bot):`. /release show and /release list escape the same way.
- /release show prints `released_message_id` as a link, so a forged "approved" chat line can be checked.
- Reject reason:
  - `screenText({max:200, multiline:false, secrets})` with PII masking on, and the returned text is stored;
  - the notice is `Reason from a Bot Admin: "<reason>"` through notifyHead (`noHandles`);
  - this is an explicit, scoped exception to GW-C22. GW-C22 (scheduler.ts `notifyHead`, "The caller passes code text only") records clean provenance. Spec §6 "Gate anchors still in force" must record the exception.
- Test probes: `@everyone`, `<@id>`, a markdown link and a planted secret.

**RL-C11. Approval integrity tests.**
- A `relcard:` id copied into another channel, or into a category approvals room, is refused.
- A stale or forwarded card → wrong_card.
- halted or off → the row stays pending.
- Two concurrent claims → one winner.
- Reject while releasing → not_pending.
- `claim` requires `expires_at > now()`. `expires_at` is computed in SQL as `now() + interval '7 days'`, never in JS.

**RL-C12. Request side.**
- No side effect before export (spec §5.9).
- The stored title and summary are the screenText output.
- Logs carry `{errName}` only.
- A regex test covers the audit outcome shape (`#<id> <slug> <sha16>`, `refused:<code>`).

**RL-C13. Kill switch.**
- `release.enabled` is in HANDLER_KEYS (psql only).
- A read error means off at request, at approve and in the note.
- Test: no AdminOp or tool writes it.

**RL-C14. Storage.**
- A grep test on db/repos/releases.ts: `zip` is selected only in `claim`; show and list never return it.
- `releases_zip` CHECK purges on every terminal state.
- At most 50 MB is live (5 open x 10 MB). There is no new DB role or connection, so project rule 1 does not apply.

## Residual risks (plain)

- **R1 (accept).** The zip is bot- and container-written. Note that `ws_export` can already post the same bytes to the same thread without approval. The card controls the record and the "approved" label, not distribution. A Bot Admin who runs the files runs untrusted code (RL-C8c).
- **R2 (accept, corrected).** Later workspace edits cannot reach the pinned bytes. What remains: a secret added to the list after the request is not re-scanned; the scan is literal only; files with a NUL byte are not scanned; encoded secrets pass.
- **R3 (accept).** A crash or an unconfirmed post marks the release failed although it may have posted. It is never re-posted (RL-C3, RL-C5).
- **R4 (accept).** The reject reason is Bot Admin text, trusted, screened and defanged, delivered to the head as clean text.
- **R5 (accept).** A failed audit append means missing evidence, and the card says "No test run recorded".
- **R6 (new, accept).** Any bot can type "Release #n approved" in chat. The source of truth is the card note and /release show (RL-C10).
- **R7 (new, accept).** The re-hash detects corruption only. A DB writer can change both `zip` and `sha256`.
- **R8 (new, accept).** Artefact copies stay in #setting after the DB purge. route() in discord/commands/index.ts is not devjob-protected, the same as the toolreq precedent.
