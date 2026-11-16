---
title: "Security Gate 2: task-scoped read-only web grant (WEBGRANT-1 / TASKWEB-1)"
gate: 2
status: APPROVED
date: 2026-11-08
task: TASKWEB-1 (WEBGRANT-1)
project: labworkspace (BOT/Assistant)
gate1: docs/security/2026-11-08-gate1-web-grant.md
spec: docs/superpowers/specs/2026-11-08-web-grant-design.md
---

# Security Gate 2: task-scoped read-only web grant

**Final status after the re-check: APPROVED** (see "Re-check" below). First-pass verdict, kept for the record: **CONDITIONAL_APPROVE**. W-C1 to W-C14 are met in code. One Medium gap in the halt path (G2W-01: a read-fault halt followed by database recovery brought grants back) was fixed in this audit inside `db/repos/web-grants.ts`. Two binding test gaps (W-C6 raw-vs-href fixture, W-C11 malformed-id list) were closed with test-only edits. The conditions left are Low: G2W-02 (halt vs COMMIT race) and G2W-03 (card id written after commit). `config/defaults.ts` ships `web.taskGrant.enabled: true`, so the feature is live as soon as it merges.

**Binding before commit:**
1. `npm run test:int` passes on `db/repos/web-grants.int.test.ts`, `governance/halt.int.test.ts`, `governance/approvals.int.test.ts` and `agents/loop.int.test.ts`.
2. Backend adds a test for the `revokeOwed` path (G2W-01). The test must fail when the fix is reverted.
3. G2W-02 and G2W-03 are either fixed test-first, or the owner records in this report that they accept them as follow-ups. Both are Low. The race window is a few queries, and when the revoke button is dead, `/halt` still revokes every grant.

The owner's sign-off on residual risks 1 to 6 still applies, with the narrowing below.

Anchors use function name plus a quoted fragment. Line numbers are hints only.

## Evidence run

- `npx tsc --noEmit -p .`: exit 0 (after the fixes).
- `npx vitest run --project unit`: 256 files, 3170 passed, 2 skipped (after the fixes). The targeted files (`grant-url.test.ts`, `fetchPage.test.ts`, `approval-grant.test.ts`, `registry.test.ts`, `approval.test.ts`, `approval-batch.test.ts`) all pass.
- **Not run:** the `int` project (`*.int.test.ts`) needs `TEST_DATABASE_URL`, and the brief allows no live DB. W-C3 (halt.int, loop.int, web-grants.int boot), W-C8 and W-C12 were checked by reading the code and confirming that each named test exists and asserts the condition. They were not executed. The final pre-commit run must execute `npm run test:int` on these files: `db/repos/web-grants.int.test.ts`, `governance/halt.int.test.ts`, `governance/approvals.int.test.ts`, `agents/loop.int.test.ts`.
- G2W-01 fix check: a scratch script ran `WebGrantRepo` against a fake pool with node `--experimental-transform-types`. It covered four steps: outage (hook revoke fails), recovery (the next consume runs `UPDATE web_grants SET revoked_at` before its consume UPDATE), debt paid (no extra revoke), and recovery while still down (`why:'error'`, one fixed-text fault). The script lives in the scratchpad and is not in the repo.

## Conditions W-C1 to W-C14

| ID | Status | Code evidence | Test evidence |
| :-- | :-- | :-- | :-- |
| W-C1 I1 parity | PASS | `fetchPage.precheck` "if (!sameActor(ctx.task.owner, ctx.actor)) return null" sits before any consume, so the call reaches registry I1 "approval_not_owner". The other refusals: allowlist "is not allowed for you" and zod both run before `precheck` in `exec()`. With no task there is no consume, and registry "approval_needs_task" or `ensureConversationTask` applies. Halt: consume `gate` "halt.isHalted() ? 'halted'". | `registry.test.ts` "non-owner actor in a granted tree gets approval_not_owner and used stays 0 (W-C1)" |
| W-C2 approved never consumes | PASS | `exec()` "if (approved && ctx.webGrants) { const { webGrants: _stripped, ...rest } = ctx" runs first, before any check. `approvedToolContext` still carries the port through `toolContextBase`, but the strip makes that irrelevant. `precheck` is called only from `exec()` (repo grep). | `registry.test.ts` "runApproved with a ctx that carries webGrants leaves used unchanged and calls consume zero times (W-C2)" |
| W-C3 halt on every path | PASS after G2W-01 fix; G2W-02 open (Low) | (a) `app.ts` `gate` reads `halt.isHalted()` on every call. (b) `decideGrant` "if (this.halt.isHalted()) return { ok: false, error: 'halted' }" runs before the tx and again before any write. `decideBatch` does the same when `wantGrant`. (c) `Halt` constructor `cfg.watch('halted'` calls `runHooks()`, `halt()` calls `runHooks()`, and `app.ts` "if (halt.isHalted()) await webGrants.revokeAll('halt')". (d) `revokeBeforeHaltedRow` "created_at < (SELECT updated_at FROM config WHERE key = 'halted')" runs at boot before the scheduler. | `halt.int.test.ts` "psql-style config halt revokes grants; so does /halt …"; `approvals.int.test.ts` "halted: nothing is decided and no grant row exists after resume (W-C3b)"; `web-grants.int.test.ts` "revokeAll and the boot revoke (W-C3c, W-C3d)"; `loop.int.test.ts` "a granted tainted loop fetches without a card; after a config halt and a resume the same loop gets a card, not a fetch" (not run here, see above) |
| W-C4 URL shown whole | PASS | `soloGrantEligible` uses `soloShowsWhole` → `toolCallView(...).cut`. `cut` is set by `show(v).length > max \|\| e.endsWith('…')`, which also catches escape growth. `batchGrantEligible` uses `compactItem(...) !== null`. `Approvals` gets the same predicates from `app.ts` "{ solo: (a) => soloShowsWhole(a, secrets), batch: (a) => compactItemFits(a, secrets) }". With no predicate injected, `grantable` fails closed. | `approval-grant.test.ts` "121-char eligible url: the card shows it cut, so no grant button (W-C4)"; `approvals.int.test.ts` "… a cut url are not_grantable …" |
| W-C5 non-global HIDDEN | PASS | `grant-url.ts` imports `HIDDEN` from `webSearch.ts` (`/u`, no `g`). Repo grep `HIDDEN\.(test\|exec\|lastIndex)`: only the three `/u` users. The `/gu` copy in `embeds/approval.ts` is used only with `.replace`. | `grant-url.test.ts` "E9 … the second call on the same url gives the same answer" (3 calls) |
| W-C6 raw + parsed | PASS | One `new URL(raw)`. E1 to E7 read the parsed parts. E6 checks "raw.length > 256 \|\| u.href.length > 256" and also `raw.includes('#')`. E8 and E9 check both `raw` and `u.href`. The host passed to consume is `u.hostname`. The `knownUrls` key is `urlKey(input.url)`, the same function `requiresApproval` uses. | Fixtures for backslash, Thai, IDN, `%2e%2e` and uppercase. **Added in this audit:** "W-C6 (Gate 2): length is checked on the raw text AND the parsed href". Raw is 256 and href is 272, so the result is E6. The control (raw 236, href 252) is ok. Only the href rule trips (checked: pathname 112, search 93, 6 escapes, 7 segments). |
| W-C7 kill switch | PASS (deviation accepted, see below) | `gate` "cfg.get('web.taskGrant.enabled') === true ? null : 'disabled'" is read live. `decideGrant` and `decideBatch` read `grantEnabled()` live. The reverse caps are clamped in `grantCaps` "Math.min(…maxHosts, maxFetches)", and the boot refuses them in `app.ts` "must not exceed". There is no settings write path (HANDLER_KEYS, `/settings` refuses), so the "settings writes enforce" part is moot. | `web-grants.int.test.ts` "enabled=false at runtime: consume refuses on a live grant and spends nothing (W-C7); halted too (W-C3a)" |
| W-C8 supersede | PASS | `supersedeAll` "WHERE root_id = $1 AND revoked_at IS NULL" runs inside the tx after the root lock (`decideGrant` root "FOR UPDATE"; `decideBatch` root lock "FOR UPDATE"). Two grants on one root are serialised by that lock. `revokeAll` and the unique index cannot conflict, because they only set `revoked_at`. | `web-grants.int.test.ts` "grant after an expired/exhausted grant succeeds …"; `approvals.int.test.ts` "… concurrent grants end with one unrevoked row" |
| W-C9 honest scope | PASS | `GRANT_LABEL = 'Allow web reading for this task tree'`. `grantClosingText` "Web reading allowed for task tree … every department working on this task tree may read up to N pages on up to M sites". | `approval-grant.test.ts` closing-text snapshot |
| W-C10 honest bandwidth | PASS (wording follows the owner's R-a choice) | "If a page tricks the bot, it can send up to about ${g.maxUrlChars} characters of what it has read in this task tree to sites it picks, without asking you." The number is the snapshotted character budget, which replaces N×240 (spec Amendments). Spec D9 R1 no longer says "low-bandwidth". | same snapshot |
| W-C11 batch + revoke card | PASS | (a) `grantButton` on a batch member calls `refreshBatchCard`, and `closeInPlace` only when `b.kind === 'none'`. (b) `revokeButton` "if (!g \|\| !i.messageId \|\| g.cardMessageId !== i.messageId) return ephemeral(…nothing was changed)" runs before the revoke. `refreshBatchCard` keeps G2AB-04 "batch.messageId !== i.messageId" and finds the grant by `unrevokedOfMessage(i.messageId)`. | `approval.test.ts` "forged revoke on another card does not edit it and does not revoke (W-C11b)", "grant on a batch member refreshes … never closes it (W-C11a)". **Added in this audit:** 11 malformed `approval:g:` / `:grant` ids in the B8 list ("Unknown action.", no DB call, no audit). |
| W-C12 consume contract | PASS (static) | One conditional UPDATE. Its WHERE includes `used < max_fetches`, the host cap, the char cap "url_chars_used + $3::int <= g.max_url_chars", the root status, `revoked_at IS NULL` and `expires_at > now()`. Row CHECKs `web_grants_used_cap`, `_hosts_cap` and `_chars_cap` back it up. `chars` is `pathname.length + search.length >= 1`, never negative. The try/catch returns `why:'error'`. `onFault` gets a fixed text plus an SQLSTATE that must match `^[0-9A-Z]{5}$`. Audit outcomes: `url:<rule>`, `ok #gid used/max` and the miss reason. No host and no URL anywhere (stricter than the spec, which allowed the host). | `web-grants.int.test.ts` "50 concurrent … exactly 40", "11 concurrent distinct hosts … exactly 10", "character budget …", "done/cancelled/expired/revoked …", "consume never throws …", "a database fault becomes one #bot-log incident that carries neither the host nor the url" (not run here) |
| W-C13 no consume without taint/task/port | PASS | `precheck` "if (!ctx.tainted() \|\| key === null \|\| ctx.run.knownUrls.has(key) \|\| !ctx.task \|\| !ctx.webGrants) return null". It never calls `ensureConversationTask`. The catch returns null, which leads to a card. | `fetchPage.test.ts` "untainted / no task / no port: consume is not called (W-C13)", "with no task, precheck never opens a conversation task (W-C13)" |
| W-C14 scope D1 | PASS | Only `fetchPage.precheck` consumes. `approvalFor` is central and unchanged. `requiresApproval` reason "(web grant not applied: ${miss})" goes through `redactText` and is cut to 300 chars. | `registry.test.ts` "a write tool still asks under a live grant", "web_search still asks under a live grant"; `fetchPage.test.ts` "a url that fails grantUrlCheck … gets a card naming the rule, redacted (W-C14)" |

## Rulings on backend deviations

1. **`web.taskGrant.*` in HANDLER_KEYS with no handler (kill switch via psql only).** Accepted. No model-reachable path writes the caps, which is stricter than C1. The README said "enabled = false stops live grants at once" but gave no recipe. The row does not exist by default, so a bare `UPDATE` matches 0 rows, and without `pg_notify` nothing is live. **Fixed in this audit:** README now has an upsert plus `pg_notify` recipe. It warns that the value must be the JSON boolean (`ConfigStore.apply` ignores an invalid row and keeps `true`). It also names `/halt` and the per-card revoke as the Discord-reachable stops.
2. **maxHosts clamped to maxFetches.** Accepted. Stricter than required.
3. **`consume` gains `chars`; `why` adds `cap_chars`/`halted`/`disabled`/`error`.** Accepted. `halted` and `disabled` come from the gate before any SQL. `chars` is computed in code from the parsed URL, never from the model.
4. **Registry strips `webGrants` on the approved path.** Accepted. This is the structural option W-C2 asked for.
5. **Batch card shows the closing text as message content.** Accepted. It is code-written text built by `grantClosingText`, and `escapeCardText` handles the root id. There is a test.
6. **onFault fixed text + SQLSTATE.** Accepted. Meets W9 and global rule 19.

## Rulings on open risks named by backend

- **revokeAll failure during a DB-fault halt, retried only by a later consume.** Not acceptable as built. Raised as **G2W-01**, fixed in this audit, see below.
- **Halt between the last in-tx check and COMMIT, "covered by hook ordering".** Not covered. Raised as **G2W-02** (Low).
- **setCard after commit failure → revoke button answers "does not belong".** Raised as **G2W-03** (Low).
- **Extra query + audit per unseen URL.** Accepted. Bounded by the number of tool calls, and every such call already files a card.

## Findings

| ID | Severity | Evidence | Problem | Remediation | Owner | State |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| G2W-01 | Medium | `config/store.ts` `get` "if (k === 'halted' && !this.healthy) return true"; `Halt.runHooks` "catch { /* the halt itself must not depend on a hook */ }"; `WebGrantRepo.consume` retried `revokeAll` only "if (gate === 'halted')" | In a full DB outage the store reads as halted and the watcher runs the hook, but `revokeAll` throws and the hook swallows it. When the DB comes back, the effective `halted` drops to `false` with no row write. So the gate returns null, the boot revoke never runs, and the pre-outage grant consumes again. This contradicts W-C3c ("a read fault … revokes") and the README. | Done in this audit: `WebGrantRepo.revokeOwed` is set when `revokeAll('halt')` throws and cleared when it succeeds. `consume` (after the gate) runs "if (this.revokeOwed) await this.revokeAll('halt')". A throw there is the existing `why:'error'` path, which leads to a card and a fixed-text incident. Backend must add a test-first unit or int case for the owed path. Residual: the flag lives only in process memory. A restart during the outage, with no `halted` row write, leaves the grant live. A read fault is not an operator halt, so this is recorded rather than blocking. Side effect, fail-safe and intended: the debt is paid with a full `revokeAll`, so a grant an admin made between recovery and the first fetch is also revoked. That first fetch gets a card. A created_at cut-off would depend on the app and DB clocks agreeing, so it was not used. | backend (test) | FIXED (test pending) |
| G2W-02 | Low | `decideGrant` "if (this.halt.isHalted()) return { ok: false, error: 'halted' }; // last check before anything is written", then `decideRow`, `makeGrant` and COMMIT; `Halt.halt` "const hooks = this.runHooks()" | READ COMMITTED: if `halt()` latches after the last check, the hook's `UPDATE … WHERE revoked_at IS NULL` cannot see the uncommitted INSERT. It blocks only on the superseded row, which it then skips. The grant commits unrevoked. The consume gate refuses while halted (and its `void revokeAll` would catch it if a consume is attempted). But after `/resume` with no consume attempt during the halt, the grant is live again. A restart is covered by the boot revoke. Window: a few queries, and it needs a grant click to coincide with a halt. | Revoke on the way out of a halt: in `Halt.resume()` (and the boot path) revoke every unrevoked grant with `created_at` before the resume. By W-C3b every such row is a race leftover. Alternatively, in `decideGrant`/`decideBatch` after COMMIT: `if (halt.isHalted())` revoke that grant id. Test: a deterministic interleaving (hold the grant tx open, `halt()`, commit, `resume()`, consume returns not-ok). | backend | OPEN |
| G2W-03 | Low | `grantButton` "await deps.webGrants.setCard(r.grant.id, i.messageId).catch(…)" runs after `decideGrant` committed; `batchOf` → `'unknown'` (sealed batch) records no card at all; `revokeButton` "g.cardMessageId !== i.messageId" | If `setCard` fails, or the batch is sealed, the grant has no card. Its revoke button then answers "That button does not belong to this card" forever. The owner loses the per-grant stop. `/halt` (all grants), a superseding grant, or psql remain. | Pass `i.messageId` into `decideGrant`/`decideBatch` and write `card_message_id` in the INSERT (same tx). Make the "does not belong" reply mention `/halt` as the fallback. | backend | OPEN |
| G2W-04 | Info | `soloGrantEligible` uses `grantUrlCheck(url)`, whose E8 is `redactText(raw)` with no literal secret list; the card uses `escapeCardText(…, secrets)` | A URL containing a literal secret from the shared secret list (not a generic credential shape) passes E8 and shows masked on the card. The model has no literal secrets in context (Gate 1 residual 1), and E7 rejects tokens of 24 or more characters, so impact is theoretical. | Optional: pass the secret list into `grantUrlCheck` (or compare `redactText(raw, secrets)`) in the precheck and in `grantable`. | backend | OPEN (optional) |
| G2W-05 | Info | `approval:<memberId>:grant` (forged, admin only) on a batch member: `decideGrant` checks `grantable(a,'solo')`, the solo view | The batch card shows the compact view. A URL whose JSON quoting grows it (raw `"` or `\`) could be whole in the solo view but cut in the compact view. Only an admin can send this click, and they would be forging their own button. Same reasoning as Gate 1 "Notes". | none required; optionally choose the `batch` predicate in `decideGrant` when `ofApproval` finds a live batch. | — | ACCEPTED |
| G2W-06 | Info | `loop.int.test.ts` web grant probe | The halt probe runs separate `runAgent` calls before and after the halt, not one loop that keeps calling across the verb (global rule 14). A halt aborts every running loop, so one loop cannot outlive it, and the sequence matches production. Accepted as evidence once it has actually been run. | Run it in the int suite before commit. | tester | OPEN (run) |

## New-hole sweep (objective list)

- **I1 bypass:** none. The grant path stops at `sameActor` before consume. Allowlist and zod run earlier. See W-C1.
- **Approved-path consume:** none. Structural strip at the top of `exec()`. See W-C2.
- **Halt/resume restore:** G2W-01 (fixed) and G2W-02 (Low, open). The psql halt, `/halt`, boot while halted, and boot after psql-resume-plus-restart paths are covered.
- **DNS before checks:** none. `grantUrlCheck` is sync with no resolver. On the card path nothing resolves. `safeFetch` re-checks every hop.
- **HIDDEN regex:** non-global copy used. See W-C5.
- **Cut URL on card:** covered for solo and batch. See W-C4. `escapeCardText` escapes markdown link brackets, so a masked link cannot render. IDN hosts show in Unicode on the card (homograph display), but the fetch goes to the same host. This is a pre-existing card property, and the first URL is owner residual 2.
- **Consume races:** none. One conditional UPDATE, re-evaluated under READ COMMITTED. Supersede, revoke and consume serialise on the row lock.
- **customId forging incl. `approval:g` revoke:** anchored regexes (JS `$` without `m` does not match before `\n`, now tested). Revoke is bound to `card_message_id`. Grant re-checks everything from DB rows. Admin guard on both the room path and `#⚙️-setting`.
- **Supersede/unique index:** every unrevoked row is superseded under the root lock, so the index cannot be hit. See W-C8.
- **Audit/log leakage of URLs:** none found. Audit outcomes and incidents carry no host and no URL. The raw pg error is not logged by consume. The card reason carries the URL by design (approver view, redacted).

## Taint carry-over (global rule 9)

No change from Gate 1. The grant adds no store. Notes, lessons, child tasks and task rows keep their taint markers, so a later run that reads them still needs a card or a live grant for an unseen URL.

## Residual risks (owner-accepted 1 to 6, narrowed)

The owner chose R-a and R-b: 20 pages, 5 sites, 4 h, 4,000 URL characters. The card wording states the bound in characters. Precisely, the bound is `max_url_chars` of path and query, plus up to 5 hostnames of at most 64 characters (the hosts are not counted in the character budget), plus the first approved URL (residual 2). Redirects (3), the shared tree (4), free page links (5) and in-flight fetches (6) are unchanged. The read-fault-plus-restart case from G2W-01 is added as a residual.

## Fixed in this audit

1. `db/repos/web-grants.ts`: `revokeOwed` flag in `WebGrantRepo.revokeAll`, paid in `consume` after the gate (G2W-01).
2. `README.md` (Web reading grant section): psql kill-switch recipe (upsert plus `pg_notify`, JSON boolean warning) and the Discord-reachable stops.
3. `discord/commands/approval.test.ts` B8 list: 11 malformed grant and revoke ids (W-C11).
4. `tools/plugins/web/grant-url.test.ts`: raw-vs-href length boundary fixture (W-C6).

After the edits, tsc passes and the full unit suite passes (numbers above).

## Re-check (2026-11-08, after backend fixes): APPROVED

The first-pass verdict above was CONDITIONAL_APPROVE. All three binding items are now met, so the final status is **APPROVED**. One non-blocking Low (G2W-07) is open.

| Item | Code evidence | Test evidence | State |
| :-- | :-- | :-- | :-- |
| Binding 1: int suites | n/a | Run on the local test DB at `127.0.0.1:54329` with `npx vitest run --project int … --no-file-parallelism`. Files: `db/repos/web-grants.int.test.ts`, `governance/halt.int.test.ts`, `governance/approvals.int.test.ts`, `agents/loop.int.test.ts`, `tests/integration/web-grant-acceptance.int.test.ts`, `tests/integration/web-grant-app.int.test.ts`, `tests/integration/approval-batch.int.test.ts`. Result: 7 files, 150 passed. | MET |
| Binding 2: G2W-01 test | `WebGrantRepo.revokeOwed`, unchanged from this audit's fix | `web-grants.int.test.ts` "G2W-01: a halt-revoke owed after a database outage". Mutation check by this gate: removing "if (this.revokeOwed) await this.revokeAll('halt')" makes that test fail (1 failed / 11 passed). The file was restored and the md5 matched the backup. | MET |
| G2W-02 halt vs COMMIT | `Approvals.haltedAfterCommit` "if (!this.halt.isHalted()) return false; … WHERE id = $1 AND revoked_at IS NULL" runs after COMMIT in `decideGrant` and in `decideBatch` (grant). `Halt.onResumed` runs from `resume()` "await this.runHooks(this.resumeHooks)". `app.ts` "halt.onResumed(async () => void (await webGrants.revokeAll('halt')))". A failed resume revoke sets `revokeOwed`, so the next consume pays it. | `approvals.int.test.ts` "G2W-02: a halt landing after the last in-transaction check but before COMMIT …". Mutation check by this gate: making `haltedAfterCommit` return false makes the test fail (1 failed / 70 passed). Restored, md5 matched. | FIXED |
| G2W-03 card id in tx | `insertGrant` writes `card_message_id` (snowflake regex, otherwise null) in the INSERT. `decideGrant` takes the clicked message, set to null when the member's batch already has a different `message_id`. `decideBatch` records it only when `batch.messageId === null \|\| batch.messageId === opts.messageId`. The handler no longer calls `setCard`. The "does not belong" reply now ends "/halt stops every web grant." | `approvals.int.test.ts` "G2W-03: the clicked message id is written inside the grant transaction (solo)" | FIXED |
| DEFECT-1 UUID path (tester) | `grant-url.ts` `runBad`: a `UUID` regex, plus the hex-16 and 10-digit rules on each path segment and each query value with `[-._~+,;=]` stripped | `grant-url.test.ts` "DEFECT-1: a UUID in a path segment or a query value is E7 …" and "… ordinary dashed and dated urls still pass"; `web-grant-acceptance.int.test.ts` "(b2) a UUID path under a live grant gets a card (E7)" (now `it`) | FIXED |

Also after the re-check: `tsc --noEmit` exit 0; unit 256 files, 3172 passed, 2 skipped.

New finding:

| ID | Severity | Evidence | Problem | Remediation | Owner |
| :-- | :-- | :-- | :-- | :-- | :-- |
| G2W-07 | Low (non-blocking) | `decideGrant` "if (await this.haltedAfterCommit(res.grant.id)) return { ok: false, error: 'halted' }"; `GRANT_REPLIES.halted` "… Approve or Reject still decide this card." | In the post-commit race the approval row is already approved: its single URL replays after resume, and the grant is revoked. The admin is told nothing was decided, and the card keeps its buttons. This fails safe for the grant: the click meant to approve that URL, and the card closes as "already decided" on the next click. But the reply misstates the approval. | Return a distinct error (for example `halted_after_commit`) with this text: "Approval #N was approved, but web reading was not allowed because the company halted; the call runs after /resume." Close the card in place. | backend |

Remaining notes (Info, unchanged): G2W-04 (literal secret list not used in E8), G2W-05 (solo predicate used for a forged member grant). Splitting an ID across path segments (each under 16 hex characters) still passes E7. That is ordinary leakage bounded by the 4,000-character budget (owner residual 1), not a new hole. The read-fault residual from G2W-01 (a restart during the outage) stands.

## Missing context

- `BOT/Assistant/CLAUDE.md` and `BOT/Assistant/.claude/rules/`: not present. The security agent defaults plus the team rules (`_global/security.md`, `labworkspace/security.md`) applied.
- No live DB: the int tests were not executed (see Evidence run).
- Book: `~/.claude/team/knowledge/labworkspace/00-INDEX.md` has no entry yet for the WEBGRANT-1 spec and gates, and `modules/assistant.md` does not mention migration 027 or the web grant (BOOK_UPDATES).

## Files audited (md5 at end of re-check)

```
81420f4c3cd25f9027b5e66fe5abc115 db/migrations/027_web_grants.up.sql
df6097893fddcc724efc4b729476f354 db/migrations/027_web_grants.down.sql
d3c17954b12fddea775f671e2cc1d797 db/repos/web-grants.ts
66231558802213beaa03b1260b354a8d db/repos/web-grants.int.test.ts
7711630b0486544ea2f7bcbddc87c06d tools/plugins/web/grant-url.ts
2908bf344f873272026e885c06b94696 tools/plugins/web/grant-url.test.ts
6e9780986bc2f4389df31695e77e4ef5 tools/plugins/web/fetchPage.ts
9c68e696ef009f9d835fe6b917c8ba09 tools/plugins/web/fetchPage.test.ts
e330d975c4b6117989aab7f13a996aca tools/plugins/web/webSearch.ts
7d771855514059dca8bf128b6812cb52 tools/types.ts
0c65caf91cd54c9917b701116e345963 tools/registry.ts
0e69e188140a9aca2f67f98eddc8d356 tools/registry.test.ts
367ea442f216509be46e22dc9dff8ae5 governance/approvals.ts
f71f511b7d46fae2a7cf1c742feb915d governance/approvals.int.test.ts
d1eced2ced6a2340fcc0e6f1cfc54e03 governance/halt.ts
19dcb59aac9e53e11f79950b68c5dd5e governance/halt.int.test.ts
e6ddde3582a0ec008cc955b10dfaeeec discord/embeds/approval.ts
c60fef9babb522afeb46ba16d374553d discord/embeds/index.ts
ad011475d1e9efc180d74e82f550cb34 discord/embeds/approval-grant.test.ts
f165ef9ac0f7f19d0f295251c5922b22 agents/payload.ts
14fa6c70f559b7993d00ffcf23635b5e discord/commands/approval.ts
db84b1d336016ac9c1cf1240eeed326d discord/commands/approval.test.ts
51074c4c92d8e49a25e84854a7010454 discord/commands/types.ts
10368aa78340d7de74eb1cc94946c656 discord/commands/index.ts
222a8f61c02a70c17c382bdbe3cbba43 discord/port.ts
742008bfa4df0901e3bc0283e93d12d0 agents/loop.ts
22291bdef7a4d19e04373ad6841b4fca agents/loop.int.test.ts
76a8ee4cd4126b47e5348f283f154a70 agents/scheduler.ts
5a37586d596f93e7571d68979ab97ded config/schema.ts
3d369acb8c7e965165898a79ff43fa69 config/defaults.ts
24d3877fb9398d0bd403cb47463ed0c1 config/store.ts
20585e89415f3f1559fce1879a18d346 admin/keys.ts
ea74c0981f872fb0804547a9f99d0d62 discord/commands/settings.ts
2fda652dfd55f41a3391620de2a0d052 app.ts
ac8320a1ce8642e203ea38a5ac891b70 README.md
527181f2e3176bdc396b428f6f11fc21 docs/superpowers/specs/2026-11-08-web-grant-design.md
5b304b620e00a984625ab281d6710b05 tests/integration/web-grant-acceptance.int.test.ts
3ba0723413668f185c9b6f5526a40007 tests/integration/web-grant-app.int.test.ts
1ddcdc3a48bb38337af16eda2ff3f756 tests/integration/approval-batch.int.test.ts
```
