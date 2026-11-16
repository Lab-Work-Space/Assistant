---
title: "Security Gate 2: CLICKUP-MULTI-1 (ClickUp all-workspaces mode)"
gate: 2
status: APPROVED (re-check 2026-11-09; was CONDITIONAL_APPROVE)
date: 2026-11-09
gate1: docs/security/2026-11-09-gate1-clickup-multi.md (CM-C1..CM-C8, owner sign-off R7/R8/R1/R2/lockout)
spec: docs/superpowers/specs/2026-11-09-clickup-multi-workspace-design.md (+ amendments)
---

# Security Gate 2: CLICKUP-MULTI-1

- Gate: 2 (code audit). App root: BOT/Assistant.
- No `~/.config/assistant` values read. No commits, no `npm run build`, live app untouched. No code edited by the first pass. The re-check edited client.ts (`CONFUSABLE`, `workspaceNameKey`) and workspace-write.test.ts (one test).

## Verdict: APPROVED after re-check (code). Release precondition: owner acknowledges the outsider-lockout residual and G2CM-06. See "Re-check (fix round)" at the end. First pass was CONDITIONAL_APPROVE.

CM-C2..CM-C8 are met. CM-C1 is met as written. But G1CM-01 (High), which CM-C1 was meant to close, is still open: look-alike workspace names get through. G2CM-01 must be fixed test-first and re-checked by security before `CLICKUP_TEAM_ID=all` is used live. Numeric mode and list mode are not affected.

## Findings

| ID | Severity | Where (content anchor) | Finding | Remediation | Owner |
| :--- | :--- | :--- | :--- | :--- | :--- |
| G2CM-01 | High | client.ts `workspaceNameKey` (`cleanVendorText(name).normalize('NFKC').toLowerCase().toUpperCase().toLowerCase()`), `workspaceLabelText` (`clipUnits(c, SEG_MAX)`), `doRefresh` `byKey` | **CM-C1 is bypassed by look-alike names.** Probe (tsx against the real functions, real = "Acme"). These do NOT collide, yet the escaped card label reads as "Acme" plus a different 6-hex hash: <br>- Cyrillic `Аcme`; <br>- `Acmeㅤ`, `Acmeﾠ`, `Acmeᅠ` (Hangul fillers: category Lo and Default_Ignorable, so neither `HIDDEN_CTRL` nor the card's `HIDDEN` catches them); <br>- `Acme⠀` (Braille blank). <br>Also, two names that share their first 30 units have different keys but the same cut label (`Acme Holdings International Gr… [a2078b]` and `… [befcd0]`). <br>This reopens the G1CM-01 exfiltration sink. The R7 sign-off relied on "CM-C1 blocks look-alike names". | Test-first, in client.ts: <br>(1) In `cleanVendorText`, which feeds both the key and the label, replace `\p{Default_Ignorable_Code_Point}` and U+2800 (and similar blank glyphs) with a space, as HIDDEN_CTRL does. <br>(2) In `doRefresh`, add a second collision key: the `workspaceNameKey` of the displayed segment (the 30-unit clip), so equal prefixes collide. <br>(3) Fold confusables before comparing: a small Latin skeleton map for Cyrillic/Greek/fullwidth look-alikes (а→a, с→c, е→e, о→o, р→p, х→x, у→y, А→a, В→b, Е→e, К→k, М→m, Н→h, О→o, Р→p, С→c, Т→t, Х→x, Greek Α/Β/Ε/Ζ/Η/Ι/Κ/Μ/Ν/Ο/Ρ/Τ/Υ/Χ/ο/ν, and so on), or use a TR39 skeleton. No mixed-script refusal: Thai+Latin names are legitimate. <br>Tests in workspace-write.test.ts: every probe above refuses create/comment/update with no approval filed. "Acme" alone and a Thai name alone still write. | backend |
| G2CM-02 | Low | client.ts `hierarchyAll`: `const sp = sc.spacesOf.get(tid) ?? []` with `truncated` unchanged; `resolveList` CM-C2 check `all && h.truncated` | **A team whose space GET failed (and that has no last good spaces) counts as empty, not unknown.** Its lists are missing, `truncated` stays false, and a same-name list in another team becomes the only hit. `resolveList` is used only by read tools (index.ts list_open_tasks, list_members, analyze_project), so the impact is a wrong-list READ (a source of injected text), not a write. | In `hierarchyAll`, set `truncated = true` when `!sc.spacesOf.has(tid)` (or when that team's spaces are from a failed refresh). Test: team A spaces 503 + team B holds "Roadmap" → `resolveList('Roadmap')` refuses. | backend |
| G2CM-03 | Low | set-tokens.sh VPS block: `ssh -o BatchMode=yes "$HOST" "lw env unset $APP CLICKUP_TEAM_ID" >/dev/null && echo ...` (and the LIST_ID twin) | **A failed unset is silent.** Under `set -e`, a failure inside an `&&` list neither aborts the script nor prints anything. If the unset fails, the leftover `all` survives (CM-C5 a) and the operator is not told. | `... \|\| echo "  ✗ could not clear CLICKUP_TEAM_ID; clear it by hand (lw env unset $APP CLICKUP_TEAM_ID)" >&2` (same for LIST_ID). | backend |
| G2CM-04 | Info | app.ts `if (env.clickup?.teamAllIgnored) log.warn('CLICKUP_TEAM_ID=all is ignored ...')` | Only the env flag is tested (core/env.test.ts). The warn call itself is untested. The text is a constant literal with no values in it. | Optional: an app boot test that captures the warn. | tester |
| G2CM-05 | Info | plans.ts `labelledLists` (old + next, `listInScope` per id) | `/clickup watch` can make about 20 `listInScope` lookups per command (the comment says at most 10). This is bounded by the shared 80/min bucket, so availability only. | Optional: label only `next`, or reuse one lookup map. | backend |

## Conditions (CM-C1..CM-C8)

| Cond | Status | Evidence |
| :--- | :--- | :--- |
| CM-C1 | Met as written; intent NOT met (G2CM-01) | `workspaceNameKey`, `doRefresh` `collide`, `allWriteGuard` (`list.teamCollides` → E.NAME_COLLISION before `beforeWrite`), precheck `if (all && list.teamCollides) return { refuse: E.NAME_COLLISION }`. Test workspace-write.test.ts "CM-C1 two workspaces with the same normalised name". |
| CM-C2 | Met (G2CM-02 residual) | `resolveList`: `if (all && h.truncated && (hits.length === 1 \|\| !CLICKUP_ID.test(p))) throw ... E.LIST_NAME_TRUNCATED`. Test workspace.test.ts "CM-C2 ...". |
| CM-C3 | Met | `doRefresh`: 401/403 → `scopeAll = undefined`; transport failure keeps the set while `now() - teamsOkAt < STALE_MAX_MS`; `ensureScope` drops the set after 60 min; 0 teams clears the set; >10 after a good boot filters `basis`; per-team spaces use only that team's own `teamSpaces` entry. Tests clickup.test.ts (503/60 min, 401, 0, 11 after idle, 11 after 401). |
| CM-C4 | Met | `noteIds` set difference; `teamsEventAudit` `count:a->b,+x,-y`. Test "swapping workspace B for C". |
| CM-C5 | Met (G2CM-03, G2CM-04) | set-tokens.sh local `stage CLICKUP_TEAM_ID ""` and VPS `lw env unset $APP CLICKUP_TEAM_ID`; env.ts `teamAllIgnored`; envfile.ts LIST_ID note. Tests local-mode.test.ts, env.test.ts, envfile.test.ts. VPS branch reviewed by inspection only. |
| CM-C6 | Met | `SYNTHETIC_REASON_LEN = min(POLICY_REASON_MAX, …)` = 500; `WORST_TARGET_LEN` matches the label caps (40 / 110 / 32 / quoted 110 / 32); approval.ts `PIN_KEYS` excluded from `MAX_SUMMARY_FIELDS`. Tests approval-body.test.ts and workspace-write.test.ts "CM-C6". |
| CM-C7 | Met | (a) index.ts `Url: ${CLICKUP_ID.test(t.id) ? \`https://app.clickup.com/t/${t.id}\` : ''}`; (b) constructor throws for `all`, non-digit and both inputs; (c) `TEAM_ID` filter + `log.warn({ dropped })`; (d) `team: resolveTeam` throws E.WORKSPACE_ONLY when `!wsTeam`; the only external caller is app.ts boot, which branches on `teamScope`. Tests clickup.test.ts (constructor matrix, `"all"`/`"1/../x"` dropped, custom-id url absent in both modes). |
| CM-C8 | Met | `polled` WeakSet + `listCommentsFor` (no second GET /task). Test poller.workspace.test.ts "≤ 40 requests". |

## Rulings on declared deviations

1. **approval.ts: the 4 pins are excluded from MAX_SUMMARY_FIELDS and always shown — ACCEPTED.**
   - CM-C6 explicitly allows this.
   - Pins are still rendered through `val()`, so a pin over VALUE_MAX still sets `cut`. `cardShowsWhole` still enforces 1024/6000.
   - Only workspace ClickUp write schemas carry `in_list_id`, and no tool schema passes arbitrary keys through (grep for passthrough/catchall/z.record in tools: none). So no other tool can gain unchecked fields.
2. **Boot warning for list+all emitted in app.ts — ACCEPTED.** env.ts has no logger. The text is constant and has no values. See G2CM-04 for the test gap.
3. **"Last good teams" survives a cache drop, a 401 keeps the record, only 0 teams clears it — ACCEPTED.**
   - The record is used only as the basis when the answer is more than 10 teams. There it can only narrow (filter to ids still present), never widen.
   - `scopeAll` (the usable scope) is still dropped at once on a 401 or after 60 min, so reads and writes refuse as CM-C3 b requires.
   - Keeping the record removes an outsider-triggered mid-life lockout (rule 10).
4. **Url rebuilt from the task id in numeric mode too — ACCEPTED.** This is within CM-C7 a ("workspace mode (one or all)"). It removes the team id from numeric-mode output as well.
5. **Non-digit teamId throws in the constructor — ACCEPTED.** This is CM-C7 b itself.

## Residual for the owner (new, plain words)

- **Outsider can block writes into the real workspace.** Anyone who gets the token's account into their workspace can name it like the company workspace. CM-C1 then refuses every write into BOTH workspaces until one is renamed or left. Reads keep working. The G2CM-01 fix widens which names count as "the same". This is the intended fail-closed trade, but it is a lockout that someone other than the owner can trigger (rule 10). Gate 1 listed only the restart lockout. Needs owner acknowledgement along with the G2CM-01 fix.

## Checks run

- `npx vitest run tools/plugins/clickup core/env.test.ts dashboard/envfile.test.ts discord/embeds scripts/local-mode.test.ts discord/commands`: 39 files, 711 tests passed. Int tests were not run (excluded by the unit project).
- `npx tsc --noEmit -p tsconfig.json`: exit 0.
- CM-C1 look-alike probe: scratch tsx script against the real `workspaceNameKey`, `workspaceLabelText` and `escapeCardText` (results in G2CM-01). The fold cases (NBSP, U+3000, fullwidth Ａ) DO collide, as intended.
- Logs, errors and audit grep: `log.warn` payloads are `{status}`, `{dropped}` and `{reason}` only. `HttpError` messages are fixed codes (services/http.ts). Team events carry counts only.
- Callers of `scope.team()`: app.ts boot only. Callers of `resolveList`: read tools only.
- Supply chain: N/A. No dependency change in this task (the package.json diff is scripts from other tasks).
- Native memory, containers: N/A (TypeScript only, no image change).
- Prompt security: tool output stays `untrustedOutput: true`. The `workspace` input refuses Cc and HIDDEN characters. Workspace labels go through `cleanVendorText` + `escapeCardText`.

## md5 of audited files (at review end)

```
afc63720c1c8f5d41a4c0fa7d8814c05 core/env.ts
60f0dd6ec82f5c6ea8d455653b28d7b2 app.ts
6b1f15aa9875043677e72cd722888fcd tools/plugins/clickup/client.ts
bdd16c6d7a55b5159e41c91e29c3b440 tools/plugins/clickup/index.ts
2525c503fa4f7f211b55346a699fe1ef tools/plugins/clickup/workspace-write.ts
a60b5ffe12ad2377e9e85e933ea3f18e tools/plugins/clickup/poller.ts
86a1af571d26fd3a09a94148623aebaf tools/plugins/clickup/multi-helpers.ts
d93d06a4087ad3ea7cddd72a1c7d268d discord/commands/plans.ts
0176462a818476fc6262f1dc9b224b41 discord/commands/types.ts
e2e697d7cab344b3c76bdd531b836949 dashboard/envfile.ts
8a525ebfdd83a74d17805935897f9760 scripts/set-tokens.sh
691e8ca7270c2e02a114666c047e0aba .env.example
c88c9ee991a33650eaacd61f1c499ef5 README.md
15a76cd4bf691fcdc5dac0cba942a2c9 discord/embeds/approval.ts
fb655ecc9fc64397bfb1dedb1bdb9997 tests/fakes/clickup-workspace.ts
```

## Missing context

- `BOT/Assistant/.claude/rules/` does not exist. Team rules `_global/security.md` and `labworkspace/security.md` were used.
- The Book 00-INDEX was not opened (the brief named the files).

## Re-check (fix round), 2026-11-09

**Final verdict: APPROVED (code).** G2CM-01 (High) is closed. G2CM-02, G2CM-03, TST-01 and G2CM-05 are fixed. **Before `CLICKUP_TEAM_ID=all` goes live, the owner must acknowledge two things:** (a) the "outsider can block writes" residual above, which the wider fold makes slightly larger, and (b) G2CM-06 below.

| ID | Status | Evidence |
| :--- | :--- | :--- |
| G2CM-01 | Closed (audit added a small widening, see below) | client.ts `HIDDEN_CTRL` now has `\p{Default_Ignorable_Code_Point}` and U+2800. `workspaceNameKey` folds a `CONFUSABLE` table after NFKC and casefold. `workspaceDisplayKey` (the 30-unit segment) is the second key in `doRefresh`. No mixed-script refusal. The first probe (`probe-c1.mts`): Cyrillic A, U+3164, U+FFA0, U+1160, U+2800, NBSP, U+3000 and fullwidth all collide. The shared 30-unit prefix collides through `workspaceDisplayKey`. Tests: workspace-write.test.ts "G2CM-01 look-alike" (9) and "no mixed-script refusal". |
| G2CM-02 | Fixed | client.ts `hierarchyAll`: `if (!sc.spacesOf.has(tid)) truncated = true`. Test: workspace.test.ts "G2CM-02 ...". |
| G2CM-03 | Fixed | set-tokens.sh lines 280 and 283: `... && echo ✓ \|\| echo "! could not clear ..." >&2`. Under `set -e` this neither aborts nor stays silent. |
| TST-01 | Fixed | client.ts: `raw === null \|\| typeof raw !== 'object' \|\| !Array.isArray(raw.teams)` throws `E.TEAMS` (a transport failure, so the last good set stays). Tests: multi.tester.test.ts "TST-01" (3). |
| G2CM-05 | Fixed (comment) | plans.ts comment now matches the lookups. Availability only. |

**Extra probe** (`probe-c1b.mts`, `probe-c1c.mts` in the session scratchpad, run against the real functions):
- Homoglyph plus filler (`Acmе` + U+3164 + `Labs`, Cyrillic A + U+2800), Greek alpha, Hangul choseong filler, tag characters, RLO, math bold `𝐀`: all collide.
- Gaps found in the backend fix: Armenian `օ ս ո հ ց`, IPA `ɑ ɡ ɩ ǀ`, Cyrillic palochka `ӏ`/`Ӏ`, small capitals `ᴀ ʙ ᴄ ...`. Also, the existing `ϲc` (lunate sigma) entry could never match, because NFKC turns U+03F2 into `σ` before the map runs.
- **Fixed in this audit** (client.ts `workspaceNameKey` and `CONFUSABLE` only): added the entries above (an extension in the spirit of knowledge/lint.ts `CONFUSABLES`, not a copy of it). Added a map pass BEFORE NFKC (`CONFUSABLE.get(ch.toLowerCase())`), so lunate sigma `ϲ`/`Ϲ` folds to `c`. A probe check confirms that every table entry reaches the key. New test: workspace-write.test.ts "G2CM-01 re-check: Armenian, IPA, small-capital, palochka and lunate sigma fold to the same key".
- **Effect of the fold on legitimate names (fail closed):** `Москва`/`Mockba` and `Straße`/`Strasse` count as the same name. This is rare, and the result is the CM-C1 refusal, never a wrong write. Thai, Thai+Latin, `Café`/`Cafe`, `Ström`/`Strom`, `Δelta`/`delta` and `Ops`/`Ops 2` still do not collide.
- **Card display is not affected:** the fold changes only the comparison key. `workspaceLabelText` still shows the vendor text as it is (Cyrillic stays Cyrillic) plus the hash of the full id and name, so nothing on the card is rewritten into a misleading Latin form.
- **Other `cleanVendorText` consumers** (`listPathText`, `taskLabelText`, `workspaceLabelText`; numeric and list mode use the first two): the new HIDDEN_CTRL classes only turn invisible characters into a space. Numbers, punctuation, `%`, `#`, Thai, Korean syllables, CJK and emoji survive (`Fix #123: 1,234.56 items 50% ok 👍🏽`). ZWJ and VS16 emoji splitting already happened before this fix (Cf, FE0F). One-time effect: a list path that contains such a character gets a new C2 hash, so a card pinned before the deploy replays as E_MOVED (fail closed).

**G2CM-06 (Low, owner decision, does not block the code):** ASCII and multi-character look-alikes are not folded: capital `I` vs small `l` (`Acme IabS` vs `Acme Labs` look the same in Discord's font), `rn`/`m`, `1`/`l`, `0`/`O`. Scripts outside the table (for example Cherokee) are not folded either. The 6-hex hash on the card still differs. Remediation: a full TR39 skeleton plus an ASCII fold (I/l/1, rn->m, 0->o) in `workspaceNameKey`, test-first. This makes legitimate names collide (`Sales`/`Saies`) and widens the lockout, so the owner should either accept the residual or ask backend for the fold. Owner: owner + backend.

**Residual (Info, no action required):**
- Combining marks stay in the key (`Acmé`, `Ac̶me`, `Labṣ`). They are visible on the card. Stripping them would make `Café`/`Cafe` collide.
- Invisible characters inside a word (ZWSP, CGJ, soft hyphen, word joiner, Mongolian FVS) become a visible space (`Ac me`), so they are no longer look-alikes.

**Checks run (re-check):** `npx tsc --noEmit -p .`: exit 0. `npx vitest run --project unit tools/plugins/clickup env discord/embeds discord/commands scripts`: 43 files, 789 tests passed on the final file state (788 before the audit edit, plus 1 new). No `~/.config/assistant` values read, no commits, no build, live app untouched.

md5 after re-check:
```
0be9254545485ee428b3b40e282319b2 tools/plugins/clickup/client.ts
a20ade1b022337e35c899e94b1cfaddb tools/plugins/clickup/workspace-write.test.ts
3007f24ceaf916ffcdb3c1eb9cfa930e tools/plugins/clickup/workspace.test.ts
24d6a8545d513f7b7a3481314e3d7f4d tools/plugins/clickup/multi.tester.test.ts
918c5f3e22cda1a85fd05089f1629782 scripts/set-tokens.sh
c0188680e51413fa58401d44e3557ba6 discord/commands/plans.ts
```

## Owner sign-off (2026-11-09)
Owner accepted the outsider-lockout residual and G2CM-06 (ASCII look-alikes I/l, rn/m, 0/O not folded; the card hash differs). Answer: "รับได้ เปิด all เลย". Release precondition met.
