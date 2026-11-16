---
title: "Gate 2 — REROUTE-1 mentions of an unreachable head become tasks"
task_id: REROUTE-1
gate: 2
status: CONDITIONAL_APPROVE
gate1: docs/security/2026-11-08-gate1-mention-reroute.md
spec: docs/superpowers/specs/2026-11-08-mention-reroute-design.md
migration: 032_reroute
last_updated: 2026-11-08
---

# Gate 2 — REROUTE-1 (code and release audit)

**Verdict: CONDITIONAL_APPROVE.** All of RR-C1 to RR-C20 are met in code, and each has a test. No mentioner class gains more tasking power than it has today.

The one blocking defect was DEFECT-001 (Critical, functional): `provenanceOf` called `BotMessageRepo.lookup` unbound, so in the real wiring every bot mention was dropped. It failed closed, so nothing was widened. The tester found it, the controller fixed it during this audit (a bound call), and I re-verified it against the real repo. The audit hashes below are taken after that fix.

Three Low findings remain. They are recommendations and do not block the release: G2RR-01, G2RR-02 and G2RR-03.

The working tree was being changed by other agents during the audit. The int test file and `agents/reroute.ts` both changed while I was working. The md5 list in §7 is the state that was verified.

## 1. Scope and method

- **Code read:** `agents/reroute.ts` (all of it), and in `agents/scheduler.ts` the wiring, `handleMessage` split, `settleReview`/`settleReviewLocked`, `handleCreated`, `handleChanged`, `reportEnded`, `rollupJob`, `startRollup`, `otStart`, `exclusive`, `conversationFor`, `runMessage` close path, `afterRun` and `ensureThread`/`placeInOrigin`.
- **Also read:** `agents/conversation.ts`, `agents/jobs.ts` `KeyedLock`, `db/repos/tasks.ts` (`insert`, `createUnderOpenParent`, `rerouteExists`, `recentRerouteOpen`, `countOpenRerouteRoots`), migration 032 up and down, and in `discord/port.ts` `botCanWork`, `canMemberPost`, `canMemberView`, `fetchMessage` and `channelIsPublic`.
- **Also read:** `company/forward.ts`, `tools/builtin/forwardTo.ts`, `governance/limits.ts`, `company/router.ts`, `admin/keys.ts`, `discord/commands/{plans,settings}.ts`, `core/incidents.ts` (`boundedErr`, `msgOf`), `db/repos/botMessages.ts` `lookup`, the `app.ts` wiring and the fake port/client changes.
- **Runs:**
  - `tsc --noEmit`: clean, before and after the fix.
  - Unit suite: 294 files, 3748 passed.
  - Targeted unit tests after the fix: 222 passed (`scheduler.reroute`, `port.access`, `router`, `scheduler`, `conversation`).
  - Int, full suite before the fix: 82 of 83 files passed. Only `agents/scheduler.reroute.int.test.ts` failed (DEFECT-001, while the tester was still editing it).
  - Int after the fix: `scheduler.reroute.int`, `tasks.int` and `migrate.int` gave 55 of 55. The migration ran up, down and up again.
- **Scanners:** none. No dependency or image changed, so supply chain is N/A.
- **Missing context:** `<PROJECT_ROOT>/CLAUDE.md` and `<PROJECT_ROOT>/.claude/rules/` do not exist. The team rules `_global/security.md` and `labworkspace/security.md` were read.

## 2. Condition verification

| Cond | Code evidence | Test | Result |
| :--- | :--- | :--- | :--- |
| RR-C1 | `originOf`: `replyToId` is a snowflake; `fetchMessage(channel, id, mentioner)`; same channel; author is the human `triggerUserId` | S "RR-C1 …" (2), int (a) | PASS |
| RR-C2 | `provenanceOf`: 6 polls × `pollMs`, outside any lock; no row or a throw → null → warn, no task, no notice; `tainted = msg.forward \|\| row.tainted` | S "RR-C2" (2), int DEFECT-001 (real `BotMessageRepo` as wired in `app.ts`) | PASS (after the fix) |
| RR-C3 | `one()`: conversation path only if top-level, mentioner is a head, `answer`, `triggerUserId`, origin verified, then `view(triggerUserId, work)` for every head (→ `not_allowed`) | S "RR-C3" (3) | PASS |
| RR-C4 | `Conversation.exclusive` = one `KeyedLock` shared by `openHead` and `adopt` (key `dept\|user\|where`); outer key `reroute:dept\|mentioner\|src`; parent-independent `recentRerouteOpen`, plus the per-parent check inside `attach` | S "RR-C4" (4), int (e) | PASS |
| RR-C5 | `insert` is `INSERT … SELECT … WHERE $25 IS NULL OR EXISTS(… status IN ('doing','review'))`; refusals and `checkOpenTasks(2)` run before `adopt`; `closeOrphan` in `finally`; `settleReview` now runs under `locks.run(taskId)` | D (null against done/cancelled/blocked parent), S "RR-C5" (5), int (f) | PASS (see G2RR-01) |
| RR-C6 | Every Discord read (provenance, history, `canMemberPost`/`View`, `fetchMessage`, `canStartThread`, `channelIsPublic`, `categoryOf`) runs in `context`/`one` before `locks.run(key)`; `emitCreated`, `afterRun` and notices run after it | S "RR-C6" | PASS |
| RR-C7 | `split`: head actor, reason `mention`/`warroom`, **and** `msg.mentionedHeads.includes(dept)` | S "RR-C7", router tests unchanged | PASS |
| RR-C8 | Thread task with a non-owner mentioner → `not_allowed`, never a root; the root path only outside task threads | S "RR-C8" (5) | PASS |
| RR-C9 | `botCanWork` returns `'yes'\|'no'\|'unknown'`; `'no'` only for a bad id, an exclusion, 10003/50001/50013, another guild, a definite permission miss, locked/archived without ManageThreads, or a private thread with no member (10007/10013); offline, other errors and throws → `'unknown'`; the cache keeps definite answers only and is cleared on `halt.changed` | P matrix (10), S "RR-C9" (2) | PASS |
| RR-C10 | `cardMode`: thread → `channelIsPublic(threadId)` only; top-level → same room, then public; a throw → `link` | S "RR-C10" | PASS |
| RR-C11 | `canMemberPost`: View + Send + SendInThreads, fail closed, with snowflake and deny checks | P (2), S | PASS |
| RR-C12 | `countOpenRerouteRoots(userId) >= 3` → `limit` (from the DB) | S "4th open reroute" | PASS (see G2RR-02) |
| RR-C13 | `rerouteLabel`: a `DEPT_IDS` member or `member`; a persona maps to its dept; the adopted conversation title is the fixed `Conversation (mention reroute)` | S hostile display name, title-shape test | PASS |
| RR-C14 | Not a snowflake → warn and return; `rerouteExists` before any slot; `isDuplicate` = 23505 **and** `tasks_reroute_once`; other errors → `fault` → incident | D (23505, 23514), S (3), migrate.int up/down/up | PASS |
| RR-C15 | `canRun()` checked at start, after `context`, at the start of `create`, before each insert, in `refuse` and in `notice` | S "RR-C15" (2) | PASS |
| RR-C16 | Notices and refusals: `noHandles: true`, `answer: false`, `userId` = the human or `triggerUserId`; `inertName` on the dept name; no notice in the warroom (TW2 continuation) or by a requester-poster in a task thread (it would steer the owner) | S "RR-C16" (2) | PASS |
| RR-C17 | Quote = `cleanCardText(msg.content, 1500, secrets)` only; `fault` logs code/constraint only; incidents show the SQLSTATE only (`msgOf` G2BL-04); `boundedErr` drops pg `detail` | S "RR-C17" | PASS |
| RR-C18 | Router cap 3/CEO 5, human `slice(0,3)`; `takeForward` on every child, including the first child of an adopted root; depth, children and open-task checks on every attach | S "RR-C18" (2) | PASS |
| RR-C19 | Only `chainDepts` in `company/forward.ts`; `forwardTo.ts` imports it (grep finds one definition) | S chain refusal, forward_to tests | PASS |
| RR-C20 | `enabled()` read live, an error = off; in `HANDLER_KEYS`; `/settings` only, through `planRerouteEnabled` (risk notice when turned on) | S "RR-C20" | PASS |

## 3. Holes audited beyond the conditions

### Privilege per mentioner class

| Class | Reroute power | Baseline | Widening? |
| :--- | :--- | :--- | :--- |
| Head bot, top level, not adoptable | A root with requester = the bot, origin `delegated`, TW6 slot, open-task cap, tainted from its row | `create_task` root via TW6 | No |
| Head bot, adoptable | A human-origin conversation, only for a person whose message it replied to (live fetch), and that person can view the target room | `forward_to` (RF9) | No |
| Head bot, in a task thread | Owner only, as a child (`attach`: lock, depth, children, open-task cap, chain, `takeForward`) | `create_task` from its own task | No |
| Persona | `canDelegate`: its own head only; it never adopts | Same | No |
| Praw | Also requires `view(triggerUserId)` | P16d | No |
| Human | Needs Post rights in the target room; at most 3 per message and 3 open per person; the `admit` slot already taken | Could post in that room directly | No |

### Lock order and deadlock

- **Lock order** is always `reroute:` key → conversation `serial` key → `locks.run(parent.id)`.
- **Holders of `locks.run(id)`** (owner runs, conversation runs through the held promise, roll-ups, `settleReview`) never wait on a `serial` or `reroute:` key:
  - `conv.open` is only reached from a run with no task lock;
  - roll-ups started from `settleReviewLocked` are spawned (`rollupJob` → `void this.spawn`), not awaited;
  - bus handlers are void-dispatched.
- **`settleReview`** is now locked and is non-reentrant. All five callers (`releaseRoot`, `sayRollup` finally, `sweepReview`, `handleChanged`, `rollupJob` finally) run outside the same task's lock.
- **Conversation closers** in `runMessage` (`afterRun(conv.opened())`, `closeUnlessHeld`) run before `conv.release()`, so under the held lock.
- **One exception:** the reroute's own `afterRun(made.settle)` runs with no lock (G2RR-01).

### TaskRepo.create rewrite

- Every insert now goes through `INSERT … SELECT`, with explicit casts matching the column types (all ids are `text`, `numeric(12,6)`, `integer`, `jsonb`, `boolean`, `date`).
- `$25 IS NULL` keeps today's behaviour for every other caller:
  - a parent that does not exist still throws;
  - defaults (`description ''`, `status todo`, `tainted` by origin) are unchanged.
- `origin_category_id` and `origin_message_id` are snowflake-filtered to null rather than tripping their CHECK.
- The full int suite (82 other files) and the unit suite pass on the rewrite.

### Other checks

- **Privacy and injection.**
  - Titles are fixed.
  - The quote is cleaned and capped, and it is the mentioning message only (never the replied-to text).
  - Cards follow `cardBody` and `forwardCard`.
  - The notice links only to ids.
  - DB errors never reach Discord with row data.
- **Loops and spam.**
  - No bot turn runs in the source.
  - Chain, depth, children and `takeForward` (4 per root) apply, plus TW6 for roots.
  - Duplicate guard: 15 min, plus the unique index.
  - Refusals: at most 1 per 10 min per (src, dept).
  - Notices are inert.
  - Moved routes skip the warroom guard's per-thread turn counter, but they create no bot turn in the source. The Gate 1 caps bound them instead (Info).
- **Halt, off day, OT and budget.**
  - Halt is re-checked as listed under RR-C15.
  - A delegated child is held (`treeHeld`, `noteHeld`, OT-1), and the notice adds the next-workday suffix.
  - A human root runs on off days (owner-chosen option for RR-C11).
  - SPEND-1 applies at run time; the reroute itself costs $0.
- **Migration.** Both columns are nullable, with snowflake CHECKs. Partial unique index `tasks_reroute_once`, plus the partial index `tasks_reroute_recent`. The down migration drops both. Up, down and up again pass.
- **Wiring.** `app.ts` passes `agent.botRoots` (BotRoots) and `limits`, and the scheduler hands them to the Rerouter. The `ready` gate is therefore true in production, so the as-wired risk of DEFECT-001 does not repeat there.

### Rulings on the deviations

| Deviation | Ruling |
| :--- | :--- |
| Extra column `reroute_where` and its index | Accepted. CHECKed snowflake; needed for RR-C4 (same source). |
| Optional Task fields | Accepted. |
| Tri-state `botCanWork` | Required by RR-C9. Accepted. |
| Notice links to the thread | Accepted. Ids only. |
| Attach under the parent task lock; `settleReview` locked | Accepted. No reentrancy found; see G2RR-01 for the one unlocked closer. |
| `openHead` serialised by KeyedLock | Accepted (RR-C4). |
| `checkOpenTasks(slots)` | Accepted. Equivalent for `slots = 1`. |
| `TaskRepo.create` rewritten for every insert | Accepted. Suites are green and the casts are correct. |
| Fake channel perms widened | Accepted, test-only. Residual: tests that relied on view-only fakes now get Send; `port.access.test.ts` covers the negative cases. |
| Praw dropped on a definite no | Accepted. Matches the spec default. |
| Notices not posted when not inert | Accepted. Narrows. |
| Human path skips the 15-min duplicate guard | Accepted. Bounded by `admit`, 3 per message, 3 open per person and the unique index. |
| Adopted conversation has a fixed title | Accepted. Better than spec. |
| A persona never adopts | Accepted. Narrows. |
| Tests written after the code | Accepted for this gate. The M1–M7 mutation evidence, plus the int e2e that caught DEFECT-001, show the tests bite. **But all 61 unit tests passed against the broken wiring**, because the fakes pass closures. See LEARNINGS. |

## 4. Findings

### DEFECT-001 (Critical, functional; FIXED during the audit by the controller; verified)
- **Where:** `agents/reroute.ts` `provenanceOf`.
- **What was wrong:** `this.d.provenance?.lookup` was called detached. `BotMessageRepo.lookup` reads `this.pool`, so the call threw, and the catch returned "no row". Every bot mention was dropped in production. It failed closed, so nothing was widened.
- **Fix:** `const lookup = (ids) => prov.lookup!(ids)`.
- **Proof:** int test `DEFECT-001 … as app.ts wires it` passes, along with the other 10 of 11.

### G2RR-01 (Low) — Adopted conversation moved to review without its lock
- **Where:** `agents/reroute.ts` `one()`: `if (made.settle) await d.afterRun(made.settle);` runs with no `locks.run(made.settle.id)`.
- **Two effects:**
  - **(a) Status flip during a run.** A CEO run that has meanwhile opened the same conversation (`openHead` finds it) holds the lock and works on a task that `afterRun` flips doing→review under it. That breaks the "review works as doing while a run is on it" invariant.
  - **(b) Narrow RR-C5 race.** If the first child has already ended, `closeConversation` (count 0 → done) can interleave with a second reroute's `attach` to the same conversation.
- **Remediation (owner: `backend`):** `if (made.settle) await d.locks.run(made.settle.id, () => d.afterRun(made.settle!));`. It is safe, because no other lock is held at that point and `afterRun` takes none. Add an S test: a held conversation lock delays the review move.
- **Why I did not fix it:** other agents were editing `agents/reroute.ts` during the audit.

### G2RR-02 (Low) — RR-C12 per-person cap is not serialised across channels and departments
- **Where:** `createHuman` runs under `reroute:${dept}|${userId}|${src}`.
- **Impact:** Two messages from one person in different channels, or to different depts, processed at the same moment can both pass `countOpenRerouteRoots` at 2 and end at 4 or 5 open roots. The overshoot is bounded by `admit` rate slots.
- **Remediation (owner: `backend`):** inside the existing key, wrap `createHuman`'s count and insert in `d.locks.run('reroute-person:' + userId, …)`. This keeps the lock order.

### G2RR-03 (Low) — Persona mentioner's notice poster is not access-checked
- **Where:** `context()` → `headOfActor(persona)` posts as the persona's head without `canWork(head, src) === 'yes'`.
- **Impact:** In a persona direct room the head bot may not be able to post. The notice is then lost, and a "bot reply dropped" incident is raised. This is noise; there is no privacy impact.
- **Remediation (owner: `backend`):** for a persona mentioner, use the head as poster only if `canWork` gives `'yes'`, else null.

### Info
- **Lost reroute in an owner's own thread.** An owner run that mentions another head and closes its own task in the same run leads to `attach` → `stale` → refusal `not_allowed`. Functional only.
- **Unvalidated source id.** `rerouteWhere = c.src` is not snowflake-checked in code. The column CHECK makes a bad id a 23514 → incident (SQLSTATE only, no row data). Real Discord ids always pass.

## 5. Checklist summary

| Domain | Result |
| :--- | :--- |
| Secrets | PASS: quote redacted with secrets; logs carry ids and codes only |
| Injection / prompt | PASS: fixed titles; cleaned quote read inside the untrusted wrapper; fixed refusal map; `inertName` and `noHandles` |
| Reasoning isolation | N/A: no model call |
| AuthN/AuthZ | PASS: §3 table |
| Transport | N/A: no new endpoint |
| Native memory / containers / supply chain | N/A: TypeScript only, no dependency or image change |
| Log privacy | PASS: `fault()` logs code/constraint only; incidents withhold the pg message and `detail` |
| Safety override | PASS: halt re-checks, off-day hold, OT, SPEND-1, kill switch |
| Migration | PASS |

## 6. Next action

Proceed. G2RR-01 to G2RR-03 are recommended for a follow-up and do not block. If `agents/reroute.ts` changes again before release, re-run `agents/scheduler.reroute.test.ts`, `agents/scheduler.reroute.int.test.ts` and `db/repos/tasks.int.test.ts`.

## 7. Audited files (md5, after the DEFECT-001 fix)

```
139877a8cfc903b4a6f875e55560f3d1 agents/reroute.ts
79ead08323d908bd27be4eed9656d4bb agents/scheduler.ts
9a7f8c1dc264d557d5ed2fad8c4f7fd4 agents/conversation.ts
66adb9c65c14c3820769de0e64cb766f db/repos/tasks.ts
7cbe9096890b7de25a8d0fc004648a5a db/migrations/032_reroute.up.sql
b92b5339937eb2ca1fcd173b8c79ee54 db/migrations/032_reroute.down.sql
d2064eb53c5bb165b042f855828dc62d discord/port.ts
8a0d3f3ec4f5c9214b8f48ff8f01b0cd company/forward.ts
60717acf45b41cccf06ca26beb0a2e88 tools/builtin/forwardTo.ts
2e8243cb0df558ced3a3eb035a99b41a governance/limits.ts
df577bfa2fa24f474775d5cd2f2d8158 config/schema.ts
aa8d6d6a928343b3ff501347518024dd config/defaults.ts
090786dc1f84e42c2f01dfdbe646870c admin/keys.ts
6a62772cff5b358d42642522f3a79d67 discord/commands/plans.ts
968febc3fa0a784be9852504015b55e6 discord/commands/settings.ts
f422eeef728711d5e20ba153dd5a0b40 app.ts
1b6219305ccae130dcf336889a5a5e5e tests/fakes/discordPort.ts
2d6963af928f798b54854bfb4b28bd61 tests/fakes/discordClient.ts
d4bd5ad81c599e2a17855c8c222b5e2a agents/test-helpers.ts
71e1238195842684ca92cb56ed2836e3 agents/scheduler.reroute.test.ts
2c9c6fbbc03d6b377473a377e0061138 agents/scheduler.reroute.int.test.ts
267f6d180ecfbefcc3cc891315adb876 discord/port.access.test.ts
f954b9baf078ffc7017b2fe0e866c204 db/repos/tasks.int.test.ts
404d4de196c13d53b42c784203959b36 core/incidents.ts
d7b7986b227ebc213001c4ec0845860a docs/superpowers/specs/2026-11-08-mention-reroute-design.md
```
