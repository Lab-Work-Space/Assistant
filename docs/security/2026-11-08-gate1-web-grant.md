---
title: "Security Gate 1: task-scoped read-only web grant (WEBGRANT-1 / TASKWEB-1)"
gate: 1
status: CONDITIONAL_APPROVE
date: 2026-11-08
task: TASKWEB-1 (WEBGRANT-1)
project: labworkspace (BOT/Assistant)
spec: docs/superpowers/specs/2026-11-08-web-grant-design.md
---

# Security Gate 1: task-scoped read-only web grant

Verdict: **CONDITIONAL_APPROVE**. Conditions W-C1 to W-C14 below bind Gate 2. Each one names the file and the test it binds to. The design weakens the R17/P5 exfiltration guard on purpose, and the owner asked for that. The residual risk is bounded by time, count and host caps and an admin click, and it can be revoked. It is acceptable only with the conditions below and with the owner accepting the residual risks in the last section in writing.

## Scope

This gate reviews the sa spec (D1 to D11, migration 027, contracts, invariants W1 to W10) against the current tree. Anchors use the form function plus quoted fragment. Line numbers are hints only.

- `tools/registry.ts`: `exec()`. Order: "halt" (approved only), allowlist "is not allowed for you", zod, "tool.precheck", central `approvalFor`, `requiresApproval`, I1 "approval_not_owner", "approval_needs_task", run, "URL_SOURCES.has(name)" knownUrls add
- `tools/plugins/web/fetchPage.ts`: `requiresApproval` "ctx.run.knownUrls.has(key)"
- `tools/types.ts`: `newRunState` "knownUrls: new Set()", `ToolPlugin.precheck` "on both `run` and `runApproved`"
- `agents/loop.ts`: run start "trigger.approvedResults?.length) run.markTainted()", R17 "trigger.msg?.author.kind === 'human'", `toolContextBase`, `approvedToolContext` "...toolContextBase(actor, deps, task.origin"
- `governance/approvals.ts`: `decide()` "Lock order root -> approval -> tasks", `decideRow()` "else if (!halted)", `decideBatch()` B6 re-checks "x.taskId !== batch.taskId"
- `governance/halt.ts`: constructor "cfg.watch('halted'", `halt()` "emit('halt.changed', { halted: true", `isHalted()` "this.cfg.get('halted') !== false"
- `discord/commands/approval.ts`: `APPROVAL_ID`, `approvalButton` "isAdmin: true", `closeInPlace`, `refreshBatchCard` "batch.messageId !== i.messageId"
- `discord/commands/index.ts`: route "startsWith('approval:')", WS7 room guard "adminRoleId"
- `discord/embeds/approval.ts`: `toolCallView` "VALUE_MAX = 120", "TARGET_KEYS = ['target', 'repo', 'repository', 'url'", `HIDDEN` "/gu"
- `tools/plugins/web/webSearch.ts`: `HIDDEN` "/u" (no g flag)
- `net/fetch.ts`: `createCheckTarget` "addresses = await o.resolver(host)", `safeFetch` per-hop "checkTarget(current, o)"
- `tools/plugins/web/browser.ts` / `chrome.ts`: `readPage`, chrome "Early, cheap refusal ... checkUrl"
- `core/logger.ts`: `redactText` TEXT_PATTERNS (credential shapes only, no PII)
- README "Out-of-band halt"

## What the spec already gets right

- D1/W1: only `fetch_page` is affected. `approvalFor` stays central and the registry rule "can add approval, never remove it" holds. A grant only adds a key to `run.knownUrls`, which affects `fetchPage.requiresApproval` alone. `web_search`, `watch_add`, write and destructive tools are untouched.
- W3: `grantUrlCheck` is pure and sync and runs in `precheck`, before any resolver call. On the card path nothing resolves the URL: `requiresApproval` is sync, and an embed field is not unfurled by Discord. `createCheckTarget` keeps its per-hop scheme, userinfo, port and address checks on the fetch path, on both HTTP and Chrome.
- W5: the consume is one conditional UPDATE. Under READ COMMITTED, Postgres re-evaluates the WHERE (join included) on the updated row version for a concurrent UPDATE, so `used` and the host cap cannot overshoot. The row CHECKs `web_grants_used_cap` / `web_grants_hosts_cap` are a second line.
- E4 (no trailing dot) and E5 (label shape) together with a host cap counted per full hostname bound DNS-label exfiltration to at most `maxHosts` names of at most 64 chars.
- The decision rests on DB rows (approval row, stored `tool_input`, `input_sha256`, root status), never on model text or customId content. A forged customId only reaches checks an admin click would reach anyway (same reasoning as Gate 1 approval-batch "Notes").
- A batch grant is single-root by construction: `decideBatch` B6 refuses any member whose `taskId` differs from the batch's.
- Approved replays (D6) and resume both start tainted with an empty `knownUrls`. That is the root cause the spec names, and the grant applies exactly there.

## Findings

| ID | Severity | Evidence | Problem |
| :-- | :-- | :-- | :-- |
| G1W-01 | High | `exec()`: "tool.precheck" runs before "I1: an actor running in someone else's task thread" | D7 step 3 adds the key to `knownUrls` inside `precheck`, so `requiresApproval` returns false and the I1 branch is never reached. An actor running in a task thread it does not own (a head mentioned in another head's thread, a persona) can never file a card today (I1 refuses), but under a grant it would fetch freely. The grant path skips a refusal that the per-URL path enforces (global rule 3). |
| G1W-02 | High | `governance/halt.ts` constructor: the `cfg.watch('halted', ...)` path calls `abortAll()` and `blockDoing()` but never emits `halt.changed`; README: psql halt, "A database read error or a dead LISTEN connection also counts as halted" | D10/W7 revokes only on the `halt.changed` event, which only `/halt` (`halt()`) emits. A halt by psql, by another instance, by a DB read fault, or at boot while halted revokes nothing. After the README resume path (write `false` plus restart), every grant is live again. W7 "resume does not restore" fails for every halt path except `/halt`. |
| G1W-03 | High | `decideRow()` "else if (!halted)" approves while halted; D6 has no halt check | An admin can click "Allow web reading" during a halt. The grant row is inserted after the one-time revokeAll has already run, so it survives `/resume`. Same W7 hole as G1W-02, by a different path. |
| G1W-04 | Medium | `approvedToolContext` "...toolContextBase(actor, deps, task.origin"; `ToolPlugin.precheck` "on both `run` and `runApproved`" | W6 depends on wiring only: "approvedToolContext gets no webGrants port". The natural place to add the port is `toolContextBase`, which the replay context shares. The replay context is tainted (`task.tainted`) with an empty `knownUrls`, so a replay would consume: it burns caps, adds hosts, and counts the approved URL twice. The rule must be structural in `exec(approved=true)`. |
| G1W-05 | Medium | `discord/embeds/approval.ts` `toolCallView`: Target is `val(raw[target])` with `VALUE_MAX = 120`; E6 allows raw <= 256 | A grant-eligible URL of 121 to 256 chars shows cut on the solo card (the "Input truncated" note), and the compact batch field cuts too. The grant click also approves that card's own URL (D6 "decideRow ... approved"), so the admin grants on a URL they cannot fully see. On a "poisoned card", the granting URL is itself the first exfil carrier. |
| G1W-06 | Medium | `HIDDEN` exists twice: `webSearch.ts` `/.../u` and `embeds/approval.ts` `/.../gu` | D9 E9 says "reuse webSearch.ts export". If the implementation imports the `g` copy and calls `.test()`, `lastIndex` carries over and every second call on a hidden-char URL passes. |
| G1W-07 | Medium | spec D9 "R1 low-bandwidth leak via URL choice bounded by maxFetches×~256 chars" | The bound is right but "low-bandwidth" is misleading. E7 rejects token shapes (long, hex, digit runs) and E8 rejects credential shapes. Plain words, base62 chunks of 23 chars and split numbers ("081-234-5678") all pass. With 40 fetches at about 240 usable chars each, that is about 9 to 10 KB of model context per grant, to hosts the attacker picks, with no card. The owner must see this number (see Residual risks). |
| G1W-08 | Medium | D4 "enabled" is read at render; D7 consume has no `enabled` check; config is live-editable (settings panels, `cfg.watch`) | Setting `web.taskGrant.enabled=false` hides new buttons but does not stop live grants. The owner's kill switch must work immediately. |
| G1W-09 | Medium | Migration: `web_grants_one_live_idx ... WHERE revoked_at IS NULL`; D3 "live" also requires unexpired, not exhausted and root alive; D6 "supersede existing live grant" | An expired or exhausted grant keeps `revoked_at IS NULL`. If supersede only revokes D3-live rows, the INSERT hits the unique index and the tx rolls back on every later grant for that root (fail closed, but grant becomes impossible and every click is a #bot-log incident). |
| G1W-10 | Medium | D2 tree scope; D5 label "Allow web reading for this task" | The grant covers the whole root tree, including children owned by other heads (each with its own dept notes and lessons in context) and the root when the card came from a child. A tainted model can widen exposure by delegating (children inherit taint, G2-04), and each delegated head consumes the shared grant. The label understates the scope. |
| G1W-11 | Low | D9 is silent on which string each rule reads | Raw vs WHATWG-parsed differ: `\` becomes `/`, non-ASCII path is percent-encoded (so `%XX` counts and lengths grow), IDN host goes to `xn--`, `%2e` segments. Rules on raw only can pass a URL whose parsed form breaks E5 to E7, or the reverse. |
| G1W-12 | Low | `approvalButton` closes the solo card with `closeInPlace`; `refreshBatchCard` "batch.messageId !== i.messageId" | (a) `approval:<id>:grant` (or a forged one) on a batch member must follow B1 (re-render the batch card, never close it). (b) The revoke handler `approval:g:<gid>:revoke` must edit only the message that carries that grant's button, so a forged id cannot paint "revoked" onto another card (G2AB-04 pattern). |
| G1W-13 | Low | D7: consume in `precheck` before central approval and before the fetch | A consume is spent even when the fetch is then refused (blocked address, timeout). This fails safe and is accepted. `precheck` must not call `ensureConversationTask` (that would create tasks from a read path); with no `ctx.task` it returns null (W2). |
| G1W-14 | Info (pre-existing) | `exec()` "URL_SOURCES.has(name) ... knownUrls.add(u)"; R17 | Every URL on a fetched page or search result is free and uncounted. An attacker page that lists N URLs on its own domain lets the model leak about log2(N) bits per fetch by choosing among them, with no cap. This is R17 today, not introduced by the grant, but a grant makes tainted runs longer and busier. |

### Taint carry-over (global rule 9)

The grant creates no new store, but it raises how much web text flows into the existing ones. Under a grant, a tainted run can save:
- dept notes: `toolContextBase` `notes.add(..., { tainted: run.tainted() ...})` keeps the marker, and a later run that reads one is tainted (K1 "UNVERIFIED: ");
- lessons promoted from tainted notes: they keep the marker (G2K-01);
- child tasks: they inherit taint (G2-04 / `createTask.ts`), so they consume the same tree grant (G1W-10);
- task fields via `tasks.update`: the task row has `tainted`, and a later run on it starts tainted (`runStartsTainted`).
All four keep their taint, so a later run that reads them still needs a card or a live grant for an unseen URL. No new hole here.

## Binding conditions (Gate 2)

- **W-C1 (G1W-01, I1 parity).** `fetch_page.precheck` returns null (no consume) unless `ctx.task` is set AND `sameActor(ctx.task.owner, ctx.actor)`, so the call falls through to today's I1 refusal. List every refusal the per-URL path enforces (actor allowlist, zod, I1 owner, `approval_needs_task`, halt) and prove that the grant path enforces each one. Test: `tools/registry.test.ts`, "non-owner actor in a granted tree gets approval_not_owner and used stays 0".
- **W-C2 (G1W-04, W6 structural).** `ToolRegistry.exec(..., approved=true)` never consumes, whatever the context carries. Either the registry passes a flag the precheck honours, or the registry strips `webGrants` from ctx before `precheck` on the approved path. Test: `tools/registry.test.ts`, "runApproved with a ctx that carries webGrants leaves used unchanged and calls consume zero times".
- **W-C3 (G1W-02, G1W-03, halt on every path).**
  - (a) The consume port refuses (returns `why:'halted'` or null, never ok) while `halt.isHalted()`, checked live on each call.
  - (b) `decideGrant` and the batch variant return `{ok:false, error:'halted'}` while halted and insert nothing. The reply text is fixed. Deciding the row with plain Approve stays available.
  - (c) `revokeAll('halt')` runs from `halt()`, from the `cfg.watch('halted')` callback when the value is not `false`, and at boot when `isHalted()`.
  - (d) At boot, revoke every live grant whose `created_at` is earlier than the `updated_at` of the `config` row `halted`. That covers a halt and resume that both happened while the process was down.
  - Tests: `governance/halt.int.test.ts`, "psql-style config halt revokes grants"; `db/repos/web-grants.int.test.ts` (new), "grant created before halted row update is revoked at boot". Also a running-loop probe in `agents/loop.int.test.ts`: a tainted loop keeps calling `fetch_page` across a psql-style halt and `/resume`, and gets cards (not fetches) after resume. A state assertion alone is not evidence (global rule 14).
- **W-C4 (G1W-05, visible URL).** The grant button is rendered, and `decideGrant` accepts, only when the stored `input.url` is shown uncut on the card it sits on. That means the solo `toolCallView` reports `cut === false` and the escaped Target value is not ellipsised; on the batch card the same holds for every member's compact field. The simplest compliant option is E6 raw <= 120 for card eligibility. Tests: `discord/embeds/approval-grant.test.ts` (new), "121-char eligible URL: no grant button"; `governance/approvals.int.test.ts`, "decideGrant on a cut URL returns not_grantable".
- **W-C5 (G1W-06).** E9 uses the non-global `HIDDEN` from `webSearch.ts`, or a local non-global copy. Test: `tools/plugins/web/grant-url.test.ts` (new) runs `grantUrlCheck` twice in a row on the same `​` URL and expects `{ok:false, rule:'E9'}` both times.
- **W-C6 (G1W-11).** `grantUrlCheck` parses once with `new URL(raw)`. E1 to E7 run on the parsed parts (`protocol`, `username`/`password`, `port`, `hostname`, `pathname`, `search`/`searchParams`, `hash`). E6 length and E8/E9 run on BOTH `raw` and `u.href`. The host passed to `consume` is exactly that `u.hostname`. The key added to `knownUrls` is exactly `urlKey(input.url)` (the same function `requiresApproval` uses). Test fixtures in `grant-url.test.ts`: backslash path, Thai path (percent-encoded growth), IDN host, `%2e%2e` segment, raw-vs-href length boundary, uppercase host.
- **W-C7 (G1W-08, kill switch).** The consume port reads `web.taskGrant.enabled` live on each call and returns not-ok when it is false. Settings writes enforce `maxHosts <= maxFetches` as well as startup. Test: `db/repos/web-grants.int.test.ts`, "enabled=false at runtime: consume refuses on a live grant".
- **W-C8 (G1W-09).** Supersede is `UPDATE web_grants SET revoked_at=now(), revoked_by=$u, revoke_reason='superseded' WHERE root_id=$1 AND revoked_at IS NULL` (every unrevoked row, live or not), inside the decideGrant tx after the root lock. Test: `db/repos/web-grants.int.test.ts`, "grant after an expired/exhausted grant succeeds and the old row is superseded".
- **W-C9 (G1W-10, honest scope).** The button label is "Allow web reading for this task tree". The closing text (D10) names the root task id, says that "every department working on this task tree" may read, and gives the caps. Test: `discord/embeds/approval-grant.test.ts`, label and closing-text snapshot.
- **W-C10 (G1W-07, honest bandwidth).** The grant card's closing text and spec R1 carry this wording (or tighter): "If a page tricks the bot, it can send up to about N×240 characters of what it has read in this task tree to sites it picks, without asking you." Here N is the snapshotted `maxFetches`. Replace "low-bandwidth" in spec R1. Test: same snapshot as W-C9.
- **W-C11 (G1W-12).** (a) Grant on a batch member goes through `batchOf` and `refreshBatchCard` (B1), never `closeInPlace` of a live batch card. (b) The revoke handler edits `i.messageId` only after it checks that the message is that grant's card (store `card_message_id` on the grant row, or compare the approval id rendered on the message with `web_grants.approval_id`). Otherwise it replies ephemeral and edits nothing. Tests: `discord/commands/approval.test.ts`, "forged revoke on another card does not edit it" and "grant on batch member refreshes, does not close"; add `approval:g:` and `approval:<id>:grant` to the malformed-id list.
- **W-C12 (W5, consume contract).** These are the spec's tests, made binding in `db/repos/web-grants.int.test.ts`:
  - 50 concurrent consumes on `max_fetches=40` give exactly 40 ok;
  - 11 concurrent distinct hosts on `max_hosts=10` give exactly 10;
  - a root that is done or cancelled, an expired grant and a revoked grant each give not-ok;
  - consume never throws (a pg error becomes `why:'error'` plus one `web_grant`/`consume` incident and a card).
  The incident and audit text carry the host only, never the full URL (W9). That is asserted on the emitted incident and audit row (global rule 19).
- **W-C13 (W2, G1W-13).** `precheck` never calls `ensureConversationTask`. With `!ctx.tainted()`, with no `ctx.task` or with no `ctx.webGrants`, it returns null and does not call consume. Test: `tools/plugins/web/fetchPage.test.ts`, "untainted / no task / no port: consume not called".
- **W-C14 (D1/W1).** A write tool and `web_search` still ask under a live grant, and a `fetch_page` that fails `grantUrlCheck` gets a card whose reason carries `web grant not applied: <rule>` (D8, redacted, capped at 300 chars). Test: `tools/registry.test.ts`.

## Recommendations (not binding; owner options)

- R-a. Per-grant character budget: add `chars_used`/`max_chars` (for example 4,000) counting `pathname.length + search.length` of each consumed URL, in the same atomic UPDATE. This bounds the leak directly in characters instead of through the fetch count.
- R-b. Lower defaults if the owner has no need for 40 pages: 20 fetches and 5 hosts halve the bound.
- R-c. When a fallback card follows `cap_fetches` or `cap_hosts`, show that reason before the grant button (D8 already writes it), so a second grant (which resets the counters through supersede) is a conscious choice.

## Who can trigger revoke (global rule 10)

Any Bot Admin (revoke button, `/halt`, superseding by a new grant), anyone with DB access (psql halt), and a DB read fault or a dead LISTEN connection (counted as halted, W-C3). None of these can be triggered by the model or by a non-admin Discord user. A revoke only removes a privilege, so a spurious revoke costs at most more cards (a nuisance, not a lock-out).

## Residual risks the owner must accept (plain words)

1. **A tricked bot can send out what it has seen, without asking.** While a grant is live, a web page that hides instructions can make the bot open web addresses that carry text from the task: the conversation, task notes, earlier pages, other departments' notes in the same task tree. The URL checks stop obvious keys, long codes and ID numbers, but not text written as ordinary words. The upper limit is about 40 × 240 = **9 to 10 KB of text per grant**, to up to 10 sites the attacker can choose, for up to 4 hours. The bot has no API keys or passwords in its context, so those cannot leak this way.
2. **The card you click is itself approved.** "Allow web reading" also opens the address on that card, and that first address does not count against the caps. Read the address before you click (W-C4 makes sure it is shown in full).
3. **Redirects are not counted.** A site can bounce the bot to other sites, and an open redirect on a well-known site can forward the data to a third site. The site count limits where the bot goes first, not every place the data can end up.
4. **The whole task tree shares the grant.** Every department working under the same top task uses the same allowance, and a tricked bot can delegate work to bring more departments (and their notes) in.
5. **Links found on pages were already free before this change.** The bot can open any link it finds on a page or in search results without asking, with no limit. A malicious page can use that to leak small amounts by which link the bot picks. The grant does not change this; it was already true.
6. **A fetch already started can finish after revoke or halt.** Only new fetches stop.

## Missing context

- `BOT/Assistant/CLAUDE.md` and `BOT/Assistant/.claude/rules/`: not present (checked with `ls`). The defaults of the security agent file plus team rules applied.
- The R17/P5 rulings ledger is deleted (2026-11-08). R17/P5 semantics were taken from the code comments (`fetchPage.ts`, `registry.ts`).

## Files audited (md5 at end of review)

```
d4b3abf525d8b16d8594aea649763ae3 docs/superpowers/specs/2026-11-08-web-grant-design.md
3e80dc15f6f4e281fa123f26cab9e4e5 tools/plugins/web/fetchPage.ts
e330d975c4b6117989aab7f13a996aca tools/plugins/web/webSearch.ts
f3b71c76c32e11d90cf65c83118cf659 tools/plugins/web/browser.ts
12ebecaf13130cd963019446bcc3667f net/fetch.ts
1ee2f73bde0d151fac947395809fb661 tools/registry.ts
bc3f493f3a7de02be009d3204e16c852 tools/types.ts
a22e8e52477e25b987a6f3fcea7fa69f tools/urls.ts
a8654980b62b1751a13ccde3b120d907 tools/policy-approval.ts
8a5c35b4f08f1da4725d6943282f1b18 agents/loop.ts
e200c791c5137eb3ee36b93bfd0c19f2 agents/conversation.ts
6c64ab3dbb04d13067eadf065aa93a07 governance/approvals.ts
87af55912ccafec400d9979dfaebedfa governance/halt.ts
e5ebde2cb91e496df44b3fed2543713e discord/commands/approval.ts
10368aa78340d7de74eb1cc94946c656 discord/commands/index.ts
596324976035bd011350f8674d479fcc discord/embeds/approval.ts
9b518cd3a4eff06ca2cca0402ec8f257 core/logger.ts
0c0ff42992649b7e5844b8bc52892646 app.ts
```

## Owner sign-off (2026-11-08, recorded by controller from the owner's answer in chat)
The owner ACCEPTS residual risks 1–6 and chose option R-a + R-b: defaults lowered to maxFetches 20, maxHosts 5, hours 4, plus a per-grant URL character budget of 4,000 characters (path + query, summed over consumed fetches; consume refuses when the budget would be exceeded). Bound on leakage is therefore ~4 KB per grant.
