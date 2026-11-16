---
title: "Gate 2 - R5 RELEASE-1 (GROWTH-1)"
gate: 2
spec: docs/superpowers/specs/2026-11-12-release-design.md
gate1: docs/security/2026-11-12-gate1-release.md
diff: 3c7ecc7..b43db1f (61dec91, 2fb6eb1, 6a972cb, b43db1f)
status: CONDITIONAL_APPROVE
date: 2026-11-12
---

# Gate 2: R5 RELEASE-1

Verdict: **CONDITIONAL_APPROVE**. Nothing blocks the deploy any more. The two RL-C1 test gaps found here (G2-RL-01, G2-RL-02) are fixed in this audit. G2-RL-03 and G2-RL-04 may follow, but must land before R6/R7 add new release targets.

Code is cited by content anchor. Line numbers are hints only.

## Tests run

- Before the fix, the release unit suites (releases/, tools/builtin/releases.test.ts, discord/commands/release.test.ts, loop/ai-digest release tests, devjob/paths.test.ts): 229 passed.
- Int tests (docker `assistant-test`, port 54329, brought down afterwards): releases.int, release.accept.int, migrate.int: **69/69 passed**.
- Full `npm test` after the fix: **424 files, 5619 passed**, 2 skipped.

## RL conditions against the code

| ID | Result | Evidence (anchor) |
|---|---|---|
| RL-C1 a/b | PASS after the fix | releases/boundary.test.ts `importerViolations`, `ALLOW`. The planted probes ran in a scratch copy outside the repo (table below). |
| RL-C1 c | PASS | tools/builtin/releases.ts `releaseToolDeps` (one own property). app.ts `releaseTools(releaseToolDeps(releaseService))`. Tested in tools/builtin/releases.test.ts and releases/wiring.test.ts. |
| RL-C1 d | PASS after the fix | `G2-RL-02` test added (see below) |
| RL-C2 | PASS | No `kind`, and `requiresApproval: () => false`. Tested in tools/builtin/releases.test.ts "RL-C2": with project autopilot, company autopilot and the AI approver on, it asserts approvalRequest, needsApproval and autopilot.decide are never called and `request` is called once. |
| RL-C3 | PASS | releases/targets.ts `certainRefusal`: DeniedChannelError, or an integer 4xx except 408. service.ts `release()`: a certain refusal → `revert`, anything else → `fail('post_unknown')`. The handoff body is one message (service.test.ts "RL-C3"). The int test covers 403 → pending and 500 → failed, then not_pending. |
| RL-C4 | PASS | db/repos/releases.ts `window` and `evidence`: the run query uses `ts > since AND ts <= until`; the write query uses `ts > since AND ts > newest`. Strict `RUN_OUTCOME`, and the slug is re-checked. Three int tests cover the bounds and the re-created slug. |
| RL-C5 | PASS | `failInterrupted`: `decided_at < $1` from `repo.now()`, read in createApp before startApp. The int test "a row claimed after bootTime is untouched" passes. |
| RL-C6 | PASS | devjob/paths.ts protects `releases/`, `db/repos/releases.ts`, `tools/builtin/releases.ts` and `discord/commands/release.ts`. |
| RL-C7 | PASS | manifest `deptOnly:'software'`, privileged.json, the Praw "*" test, and the service's `not_software` check. |
| RL-C8 | PASS | cardBody fixed strings, `SANDBOX_LINE`. Max card = 1 message (card.test.ts). |
| RL-C9 | PASS | Both posts use `contentType:'application/zip'` from the pinned Buffer. accept.int checks that the sha256 of both attachments matches the row. |
| RL-C10 | PASS (doc fixed) | `escapeCardText` is applied to title and summary in the handoff, card, list and show. The reject reason goes through `screenText` (PII on, single line, 200 characters). `noHandles`. The GW-C22 scoped exception is now recorded in spec §6. |
| RL-C11 | PASS | decide() has no relcard pre-check, so it needs #setting and the live role. route() is the only route. `decide` checks the stored channel/message, then pending, then live, then halted/off, then the CAS `claim … expires_at > now()`. Expiry is `now() + interval '7 days'` in SQL. |
| RL-C12 | PASS | Nothing has a side effect before `ws.export`. Logs carry `{errName}` only. Audit outcomes are codes. |
| RL-C13 | PASS | HANDLER_KEYS has the key. `on()`: anything but `true` (or a throw) is off. /settings refuses the key. |
| RL-C14 | PASS | `COLS` excludes zip; only `claim` returns it. The `releases_zip` CHECK holds. |

### RL-C1(f): planted bypasses (scratch copy, the repo was never edited for probes)

| Probe | Before the fix | After |
|---|---|---|
| p1 barrel `export * from '../releases/service.js'` | caught | caught |
| p2 computed `import(p)` | caught | caught |
| p3 `createRequire(...)('…/service.js')` | caught | caught |
| p7 template literal `` import(`…`) `` | caught | caught |
| p6 `/[/*]/; await import('../releases/service.js'); /* */` | **missed** | caught |
| p8 `/[//]/; import { ReleaseService } from '…'` | **missed** | caught |
| p4 `new Function('p','return imp'+'ort(p)')` | **missed** | caught |
| p5 `process.getBuiltinModule('module')[computed]` | **missed** | caught |
| p9 admin/ file calling `cmd.releases?.reject(...)` | **missed** | caught |
| a1 escaped specifier `'../releases/servic\u0065.js'` | **missed** | caught |
| a2 query specifier `import('../releases/service.js?x')` | **missed** | caught |
| a3 symlinked dir `grow/rellink -> ../releases` | **missed** | caught |

Bypasses that remain (RL-C1e): any code holding the DB pool (it can UPDATE `releases` directly); `globalThis` reflection; a child process that runs node; obfuscation the regex scan cannot see (for example a computed property on an object that already holds the service). The tests limit who can import the code. The runtime holders of the live service are pinned only by releases/wiring.test.ts and G2-RL-02.

## Findings

| ID | Sev | Where | Issue | Status |
|---|---|---|---|---|
| G2-RL-01 | Medium | releases/boundary.test.ts `stripComments` | It cannot tell a regex literal from a comment, so `/[/*]/` or `/[//]/` hid a real import of the guarded module (p6, p8). Reflection loaders (p4, p5) were not pinned. | **Fixed.** `scanRefs` unions the stripped and raw scans for the importer, ALLOW and non-literal checks. `tools/plugins/schedule/runner.ts` is added to the non-literal set (a comment only). Empty reviewed sets now pin: reflection loaders (`Function(`, `eval(`, `getBuiltinModule`, `._load`, `vm`/`module` imports); specifiers containing `\`, `?` or `#`; symlinks (`walk` uses `lstatSync` and never follows). tsconfig has no `paths`/`baseUrl`; package.json has no `imports`. |
| G2-RL-02 | Medium | app.ts `new AdminConsole({ … cmd: commands …})`; admin/ops.ts `cmd: CommandDeps` | At run time the AI-driven admin console holds the whole CommandDeps, so it holds the full ReleaseService (decide, reject, list, show). RL-C1(d)'s token list did not cover `cmd.releases`, and admin/ops.ts and admin/console.ts are not devjob-protected. No code uses it today. | **Fixed (test).** New RL-C1(d) test: no admin/ source touches a `releases` member (raw-text pattern plus a comment-stripped `\breleases\b`). |
| G2-RL-03 | Medium | db/repos/releases.ts `COLS` (includes `token`); service.ts `decide` trusts the caller's `userId/channelId/messageId` | Any holder of `CommandDeps.releases` can call `list()`/`show()` to get the token and the card ids, then `decide({action:'approve', userId:<any>})`. That approves a release and forges `decided_by`. Only route() supplies the real values today. | **Fixed (GROWTH-1 G2 fixes).** `token` is out of `COLS`/`ReleaseRow`; CommandDeps gets `releaseCommandDeps` (decide/list/show/reject closures); AdminConsole gets `adminCmd`, built before `releases` exists. Original advice: drop `token` from `COLS`/`ReleaseRow` (byToken does not need to return it). Narrow `CommandDeps.releases` in app.ts to a `{decide, list, show, reject}` closure object. Give AdminConsole only `{ cfg }`, not `commands`. |
| G2-RL-04 | Low | app.ts `aiDigest … releases: releaseRepo` | The digest holds the whole ReleaseRepo (claim, fail, …). It is code-only and calls `day()` only, and no model path reaches it. | **Fixed.** `releaseDigestDeps(releaseRepo)` returns `{ day }` only. |
| G2-RL-05 | Info | app.ts `releaseSweep`, service `sweep`/`after` | Sweeps and head notices keep running while halted. They carry fixed code text only. This matches the `toolRequests.sweep` precedent. | Accept. |
| G2-RL-06 | Info | app.ts `releaseBootTime … return '-infinity'` | `decided_at < '-infinity'` matches nothing, so a failed clock read skips recovery. Rows stay `releasing`, are never re-posted, and the next boot retries. Fails safe; the cost is availability only (the tree stays blocked and the zip stays held). | Accept. |
| G2-RL-08 | Low | @discordjs/rest default `retries: 3` (AbortError after 15 s, ECONNRESET, 5xx); discord/clients.ts sets no override | The library itself resends a POST that timed out or got a 5xx, below the app's never-re-post logic. A handoff the server accepted can therefore appear twice in the thread. This applies to every bot post, not only R5, and extends Gate 1 R3. | **Fixed.** The handoff file post carries `nonce` `rel-<id>-<sha8>` (no token: views no longer hold it) and `enforceNonce: true` (discord.js 14.28.0 supports it). Discord's dedup window is short; the app still never re-posts. |
| G2-RL-07 | Info | targets.ts `certainRefusal` | A plain-Error resolve failure (missing channel or thread) becomes `post_unknown`. This is safe, since nothing is ever re-posted; the cost is that the admin cannot retry. | Accept; type the port errors later. |

Checked with no finding:
- Secrets: none in the diff.
- SQL: every value is a bind parameter. `DAY(tz)` binds `$n::text`. The slug regex is checked before LIKE, and there is no regex in SQL.
- Migration 045: up, down and up again pass (int test). The down migration runs before 044 because of the projects FK.
- Markdown and mentions: escaped in title, summary and reason. The slug is regex-bound. The head notice has `noHandles`. The reject reason is admin-trusted text (scoped exception, R4).
- Zip: `WsService.export` is unchanged, with a 10 MB cap. Posted as application/zip, so it is not rewritten.
- Logs: errName only. The tool returns a fixed error text. Zod and model text are never logged.
- route() is not devjob-protected (R8, accepted). wiring.test.ts (protected) asserts that decide() does not mention relcard.

## Re-check of earlier diffs (no security record)

**39fb34a** (AUTO-2 G2-01) adds the company autopilot note to a taskless run only when it has a conversation hook. The note now reaches fewer runs. It is advisory text, not a guard. No finding.

**7c32a03** (R1 follow-up) changes four things:
- `eventRejected` uses the same `snapshotRejectsHold` predicate as the hold, so an unparsed event or a per-model rejection no longer counts as a quota rejection. This affects availability only.
- `staleReview` adds a parameterized recursive CTE over open task questions. It has no depth cap, but task trees are acyclic: the only reparenting is `adoptOne` under a fresh project root.
- Auto-close is skipped on off days.
- The heal summary gains one integer.

No finding.

## Residual risks (plain words)

- The import tests cover who imports the release code. They do not cover who is handed the live object. Today the live service sits only in app.ts, the slash/button layer (`App.commands` is consumed only by app-start.ts `handleInteraction`) and, through `cmd`, the admin console. A future code change in an unprotected file could call it. G2-RL-02 now fails such a change in admin/, and G2-RL-03 removes the token leak.
- Gate 1 R1-R8 still stand: untrusted zip contents, the literal-only secret scan, failed-but-maybe-posted, forged chat lines, DB writers.

## Fixed in this audit

- releases/boundary.test.ts: G2-RL-01 and G2-RL-02 (4 new tests, raw-text pass, alias and symlink pins). 24/24 pass; all 12 planted probes are caught. The full unit suite is green.
- docs/superpowers/specs/2026-11-12-release-design.md §6: the GW-C22 scoped exception line.

## md5 of audited files (at end of review)

```
d90bdab26b00e0a22a94a0a7c7ec1a20 releases/service.ts
c22124c4197a067faa57637765574b45 releases/targets.ts
e5525c0160f5f65f4f0ae23e242cb8e8 releases/boundary.test.ts
a40346ba6dc23342865a4487421e850d db/repos/releases.ts
c7e45d9b15cc03e48a908aa5758927b9 db/migrations/045_release.up.sql
5393aad74a4e41fcd3013073add025e6 db/migrations/045_release.down.sql
745d775e0f70a3ee81ef64ee88135f65 tools/builtin/releases.ts
ed7f0d4bab2d55050963c9605f7d690e discord/commands/release.ts
e247a3bc6ad9dc0c33e7fec67d4c31e4 discord/commands/index.ts
4cc6cd84cd35ef23a7a78668c1c4ee50 discord/commands/types.ts
a3afcdb940508c6d43189772f09bc4ca discord/embeds/approval.ts
418023061ca50f399465ceb6a1c10c2e discord/embeds/index.ts
69a5cee3a530cbf6ed14f6c58508ff3c discord/port.ts
a0ed01b90e19c00a28f9b2cd7b712331 devjob/paths.ts
6d1c0bc9c7be6b6f4f8b270ec31303fb app.ts
2afb96a8213876a20103544601f50dc7 agents/context.ts
3b1c22b48e2829b7ffc27b015734e507 agents/loop/loop.ts
a9e59d12aebc1582779b1abb9e8790ec agents/tasks/ai-digest.ts
a1f3cf10597a5ab0af6571fa32e96a18 admin/keys.ts
65f20e0c57abd20a46876d78133593e2 config/schema.ts
d3ad64974043962a3112b62589b3afe2 config/defaults.ts
66cbc0d23cff009b49a401b2e1535b5e tools/builtin/manifest.ts
31a8c951ef13f6acfba82f2eb11c5ad6 tools/manifest/privileged.json
a68ae617a2e4fbe88160f73896fedaa7 prompts/heads/software.md
094cd48a088ba6546674fd399b8f46b8 releases/wiring.test.ts
339a2eaa989ede391b8b9aa074800e19 releases/service.test.ts
fedfff241f04743bbfc200a76c85b3e4 releases/card.test.ts
a0ed5f18f03d4e75882cc6d89f9a40cc releases/releases.int.test.ts
6799e90f47dc95229dfda96d52c71d05 releases/release.accept.int.test.ts
bb4ba128992d131f3c681a69cbdbbbdf tools/builtin/releases.test.ts
baa5713e0214c3bd38f2ac04bf050ccf discord/commands/release.test.ts
93dd8810def28704cf3a025b2cbaaf5a devjob/paths.test.ts
be82f59a7ad38cc3339772b5cdba4357 admin/ops.ts
a902b25514cbd70e23006d0b073008eb admin/console.ts
c0b2d77fded0f84bc6aa5f4de165bd93 discord/clients.ts
```

## Fix re-check (c3d76cf)

Verdict: APPROVED (G2-RL-03, G2-RL-04, G2-RL-08 closed). Affected tests pass (releases/wiring, releases/service, discord/port: 125/125).

- (a) Token: `COLS` (db/repos/releases.ts:43) drops `token`, so `ReleaseRow`, `ReleaseView` and `ClaimedReleaseRow` (claim `RETURNING ${COLS}, zip`) carry no token. The token is only an input (`create`, `byToken`, `claim`, `reject` by token from the card button). Approval needs the card token via `claim`; `/release reject` uses `rejectById` (reject only, Bot Admin gated). No other approve path found.
- (b) app.ts:847 `adminCmd` has no `releases` key; app.ts:892 `commands = { ...adminCmd, releases: releaseCommandDeps(releaseService) }`; app.ts:916 AdminConsole gets `adminCmd`. `adminCmd` is never mutated (later writes go to `commands` only, a separate object) and admin/ has no `cmd.releases` use. `releaseCommandDeps` (releases/service.ts:394) returns four closures, no service reference. Text tests are adequate for the current code, but `CommandDeps.releases` is optional, so types do not stop a future `cmd: commands`. Recommended guard (Low, G2-RL-09, owner backend): in the AdminConsole constructor (admin/console.ts) throw if `'releases' in d.cmd`, with a unit test. Not a blocker.
- (c) app.ts:803 AiDigest gets `releaseDigestDeps(releaseRepo)` = `{ day }` only (releases/service.ts:399).
- (d) releases/targets.ts:36 `rel-<id>-<sha8>` sliced to 25 chars (13 + id digits, so unsliced up to a 12-digit id); discord/port.ts:658 sets `nonce` + `enforceNonce` on the first message, the one with the zip (the only one that must not duplicate). A nonce is a dedup key, not a secret; deriving it from id+sha instead of the token is the right choice (the token must never leave the card) and weakens nothing. Discord dedups only within a short window, which covers the REST library's own retry, the stated goal.
