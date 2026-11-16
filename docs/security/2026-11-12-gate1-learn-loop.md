---
title: "Security Gate 1: LEARN-1 learn loop (taint hygiene, incident log, on-demand retro, seed skills)"
gate: 1
status: APPROVED WITH CONDITIONS
status_code: CONDITIONAL_APPROVE
date: 2026-11-12
task: LEARN-1 (GROWTH-1 R2 + R3)
project: labworkspace (BOT/Assistant)
spec: docs/superpowers/specs/2026-11-12-learn-loop-design.md
extends: docs/security/2026-11-10-gate1-grow.md (GW-C1..), docs/security/2026-11-10-gate2-grow.md
---

# Verdict

**CONDITIONAL_APPROVE.** D1 is the right shape: tainted text is excluded, not let in unmarked. But the ratchet was hiding two older gaps where steered text reaches clean runs without carrying taint (LL-F1 High, LL-F2 Medium). Once D1 lands, both are live paths to `skill_propose`, which the AI judge can apply with no person involved. BE1 fixes both test-first (LL-C1, LL-C2) in the same dispatch as D1. D1 must not ship without them.

Citations use the function or quoted fragment as the anchor. Line numbers are hints only.

# 1. Invariant check (D1)

Invariant: "no text written by a model in a tainted run reaches an untainted run's prompt without tainting it".

D1 holds for the two inputs it touches. `deptNotesFor` and `roomEntriesFor` have exactly one call site, loop.ts `runAgent`, before `assembleContext`. `assembleContext` has one call site as well.

The other channels into a non-admin prompt were checked:

| channel | how taint travels | state |
| :--- | :--- | :--- |
| kb_search hit, same task | run only; no copy onto `task` (only `openedTask`) | **gap: LL-F1 (same-task variant)** |
| task title/description (delegated) | createTask.ts "tainted: ctx.tainted()"; runStartsTainted "t.task?.tainted" | OK |
| child result roll-up | scheduler "child.tainted \|\| final?.tainted" → parent | **gap: LL-F1** (child row not tainted on a cross-task write) |
| room done/blocked lines | teamtalk `ended` "child.tainted \|\| this.final(child.id)?.tainted" | **gap: LL-F1** |
| room ideas/decisions | updateTask "runTainted: ctx.tainted()" | OK |
| room board | `runBoard` "always tainted" | OK |
| thread history, reply, forward | historyTaints / repliedTaints (unknown = tainted); RF8 forward | OK |
| handoff lines | scheduler `handoffPayload` "tainted: child.tainted" | OK, provided LL-F1 is fixed |
| heal wake (blocked_note) | scheduler HL-C11 "blocked.tainted" → decide task | **gap: LL-F1** |
| ask/answer | askRequest/askAnswer/askUp taint the parent or child | OK |
| warroom say, roll-up | "tainted: req.tainted"; LF3 marks roll-up tainted | OK |
| open-tasks header | `ownTasksHeader`: ids, status and dept only | OK |
| lessons | heads/personas `confirmedOnly` (app.ts "confirmedOnly: !(... praw)"); Praw is marked UNVERIFIED and tainted | OK (unchanged) |
| kb docs | `kb_search` "hits.some((h) => h.tainted)" | OK |
| approved results | loop "approvedResults?.length) run.markTainted()" | OK |
| untrusted tools | registry "tool.untrustedOutput" taints run + task | OK |
| scheduled job prompt | runner.ts `fire` submits without `tainted`; tasks.ts `defaultTainted` clean for 'schedule' | **gap: LL-F2** |
| reminder text (list_reminders, kind read, trusted output) | none | **gap: LL-F2** |
| incident block (new) | code-only, see LL-C6 | OK with LL-C6 |
| retro facts F9 (new) | codes via `code()` | OK |
| skill text | proposals refuse taint (service.ts "run.tainted \|\| run.task?.tainted"); seeds are repo text (LL-C10) | OK |
| autopilot/company/duty notes | fixed code text | OK |

# 2. What un-tainting widens (rule: re-apply containment to the widened action)

D1 does not change any `ctx.tainted()` consumer. It returns runs whose only taint came from the ratchet to the behaviour each gate below approved for clean runs. All the consumers:

| consumer | clean-run behaviour | approved in |
| :--- | :--- | :--- |
| policy-approval `approvalFor` "ctx.direct && !ctx.tainted()" | a write in a direct human run needs no card | R3/P2 |
| fetch_page / web_search approval, WEBGRANT | no card | web-grant G1 |
| watch, media, forum, meeting_start | no extra approval | respective gates |
| forward_to "wider" | narrower scope | RF |
| tree grants, write_file `treeGrantRunOk` | may be consumed | TREE-GRANT G1/G2 |
| tool_request (`projectGrant`, granted_tree, no card) | grant inside a project or company tree | AUTO-1/AUTO-2 |
| skill_propose, prompt_propose, knowledge_propose, project_task | allowed | GROW, KNOWLEDGE, AUTO-1 |
| AI approver "Read outside text: no" | hint is "no" | AI-APPROVE G2 |
| warroom lift (HL-C5 "!req.tainted") | may lift | HEAL G1 |
| project_propose | still needs a Bot Admin card (projects.ts `submit` → `postCard`) | AUTO-1 |
| autopilot `decide` | does not read taint, so no change | AUTO-2 |

Each of these is safe only if clean really means clean. LL-F1 and LL-F2 break that, so they are blocking.

# 3. Findings

| id | severity | evidence | issue | remediation, owner |
| :--- | :--- | :--- | :--- | :--- |
| LL-F1 | High | tools/builtin/updateTask.ts `run`: the target is any task the actor owns ("sameActor(task.owner, ctx.actor)", `ownByPrefix`); "ctx.tasks.update(task.id, { status: input.status, ...blockedNote })" never copies `ctx.tainted()` | A tainted run on task A sets task B (same owner) to done or blocked with a steered summary or blocked note. B stays untainted. The summary reaches: B's parent roll-up, untainted; B's room `done`/`blocked` entry, untainted, which D1 now injects into the head's prompt unmarked; and the heal decide run (`healWakeMessage` note, taint = `blocked.tainted`). That clean head run can then call `skill_propose`, and the AI judge applies it. The ratchet hid this; D1 exposes it. | LL-C1, backend |
| LL-F2 | Medium | schedule/index.ts `schedule_add` and reminders `add_reminder` (kind write; a tainted run gets a card through central `approvalFor`); runner.ts `fire` "this.d.submit({ ... origin: j.origin" with no `tainted`; tasks.ts `defaultTainted` "'schedule', 'reminder'" clean; `list_reminders` / `schedule_list` return stored text as trusted output | If anyone (person or AI approver) approves the card for a steered job prompt from a tainted Praw run, the prompt becomes a clean `schedule` task. That Praw run can then `create_task` clean tasks for heads, which reach `skill_propose`. Reminder text written by a tainted run comes back unmarked through `list_reminders`. | LL-C2, backend |
| LL-F3 | Low | spec S1 "t.title LIKE 'Decide on blocked task %'" | Title is model-reachable text: an hq root task with that title hides its block from incident counts. The effect is undercounting only. | Recommended: exclude by `audit_log` `task.heal.wake` claim (`outcome` holds the run id) instead of by title |
| LL-F4 | Info | spec §3 "G2-C1 ... still unrecorded", "G2-C2 ... no security re-check is recorded" vs gate2-grow.md "## Closure (2026-11-10, main thread)" (both met) | Spec text is stale | Fix the spec text, see §6 |

# 4. Conditions (testable; BE1 unless noted)

- **LL-C1 (High, test-first).** Fix `update_task` so that whenever `ctx.tainted() || ctx.task?.tainted` is true, the target task's update sets `tainted: true` in the same `ctx.tasks.update` call, before `bus.emit('task.changed')`. Grep every tool that writes model text onto a task row other than `ctx.task` (rule 8) and list them in the Gate 2 evidence with how each one carries taint. Int test: a tainted run on A sets B (same persona owner) to `done` with a summary, then to `blocked`, and checks:
  - B is tainted;
  - B's room entry is stored tainted, and the head's next prompt does not contain it;
  - the parent of B is tainted after the roll-up;
  - the heal decide task is tainted.

  Same-task variant: `kb_search` marks only the run ("() => ctx.run.markTainted()"), and the after-round copy in loop.ts covers only `openedTask` ("run.tainted() && openedTask && !openedTask.tainted"). So a run on A that gets a tainted kb hit and then marks A `done` leaves A clean, and its room line and roll-up look clean too.

  LL-C1 covers this because it also fires when the target is `ctx.task`. In addition, either the kb_search callback taints `ctx.task` the way the registry does for `untrustedOutput` tools, or the after-round copy is extended to `task`.

  Add an int test: a tainted kb hit, then update_task done on the same task. The task must end up tainted, and so must its room entry and roll-up.
- **LL-C2 (Medium, test-first).**
  - `schedule_add` and `add_reminder` refuse with a fixed text in a `precheck` when `ctx.tainted() || ctx.task?.tainted`, so no card is filed. Suggested text: "This cannot be set up after reading outside content; ask in a new message."
  - Test: a tainted chat run's call files no card and adds no row; a clean direct run still works.
  - Tester lists active `jobs` and `reminders` rows created by the tool path since 2026-11-07 and attaches the count. Rows are reviewed by hand, not deleted.
- **LL-C3.**
  - loop.ts notes filter becomes `.filter((n) => typeof n === 'string' || n.tainted !== true)`.
  - Room entries filter becomes `.filter((e) => !e.tainted)`.
  - The lessons filter ("!trigger.retro || !l.startsWith('UNVERIFIED: ')") and the backstop "context.includes('UNVERIFIED: ') || roomReport.roomTainted" are byte-identical to today.
  - `assemble.ts` marking stays unchanged.
  - Wiring test: `deptNotesFor`, `roomEntriesFor` and `assembleContext` each have exactly one non-test call site (loop.ts).
  - The spec's trigger-T int test runs in a fresh thread, and both controls are kept: a tainted task refuses, and a web read earlier in the run refuses.
- **LL-C4.** The diff loosens no existing `ctx.tainted()` / `run.tainted()` consumer listed in §2. The only new consumers are the ones LL-C1 and LL-C2 add. Gate 2 checks this with grep.
- **LL-C5.**
  - Migration 044 and sweep S1-S8 are pasted verbatim from spec §5.
  - Int test plants marker strings in a task title, a description, an event summary, `blocked_note`, `admin.reason`, and an `unknown_tool` name of 20+ characters. No `dept_incidents` column and no head prompt may contain any marker.
  - The sweep logs `errName` only.
- **LL-C6.** `incidentBlock` re-validates every row when it renders, not only through the DB CHECKs:
  - `kind` must be one of the 4 kinds;
  - `code` must be in a closed per-kind set: blocked {error, turns, owner, budget}, cancelled {cancelled}, heal {retry, cancel, refused}, tool {tool_error, error, invalid_input, refused, denied, approval_not_owner, approval_needs_task};
  - `tool` must match `SAFE_TOOL_NAME` AND be a registered tool name (`deps.tools.has` or the registry list); otherwise the item is dropped;
  - `n` must be a safe integer from 1 to 100000.

  Rows that fail are dropped. Output is at most 700 characters and never contains `UNVERIFIED`. The block is offered only when "actor.kind === 'head' && !adminRun && !trigger.postOnly && !trigger.retro". A throw yields no block. Unit tests cover each drop rule.
- **LL-C7.** `/retro run`:
  - reachable only through COMMAND_TABLE `'retro:run'` after `decide()` (guild, #⚙️-setting, live Bot Admin role); no AdminOp, model tool, panel or `config_propose` path calls `WeeklyRetro.request`, proven by a wiring test;
  - `dept` matches `^[a-z_]{1,32}$` and `org.dept`;
  - replies are the spec's fixed ephemeral texts, and the DB error text matches;
  - an audit row is written with `actor: 'user:<id>'`;
  - `'retro'` is in `deferEphemeral`.
- **LL-C8.** On-demand retros:
  - one claim per department per local day, `D<YYYY-MM-DD>` key, shared by manual and incident;
  - at most one start per tick; `checkOpenTasks` is respected; nothing starts on off days, while halted, or for praw, disabled or offline departments; requests expire after 24 h;
  - S8 counts only since the latest `claimed_at`;
  - `trigger.retro` is still set only by `retroRun` (grow/retro.wiring.test.ts), and every kind uses RETRO_TOOLS and the one-skill claim on `task_id`;
  - `closeOpenRetroTasks` leaves requested rows (`task_id IS NULL`) alone.
- **LL-C9.**
  - `grow.incidents.enabled`, `grow.retro.incidentThreshold` (int 0-50) and `skills.seed.enabled` are in schema, defaults and `HANDLER_KEYS`.
  - A test asserts they are absent from `ADMIN_CONFIG_KEYS`.
  - A read error counts as off.
- **LL-C10 (BE2).** Seeds:
  - The SkillOp `seed` field is constructed only in skills/seed.ts. A wiring test scans every non-test .ts file for `seed:` inside a SkillOp, and checks that skills/plans.ts still builds explicit literals.
  - No zod or modal schema of `/skill` accepts a `seed` key.
  - `seedSkills` passes `tools: []` from code; `SeedSkill` has no `tools` field.
  - The `bad_seed` check is as in the spec, and an unknown dept or praw is refused.
  - Seed texts follow the D4b constraints, with a unit test and a sha snapshot.
  - Gate 2 security reads every seed text in skills/seed-data.ts.
  - AP1 inputs are only `prompts/heads/<dept>.md` and the Q5 output.
- **LL-C11 (BE2).** GW-C10 change:
  - `HUMAN_SOURCES = ['admin', 'rollback']`, read at both sites (skill-judge.ts "HUMAN_SOURCES.includes(st.source)", service.ts apply "HUMAN_SOURCES.includes((await t.versionRow(...").
  - Before deploy, `SELECT count(*) FROM skill_versions WHERE source = 'seed'` must return 0.
  - Tests:
    - an AI edit of a seed applies within `skills.ai.maxPerDeptWeek`;
    - an AI edit that changes `tools` is refused ("same(cur.tools, p.payload.tools)");
    - after `/skill rollback`, and after an admin edit, the next AI edit escalates `human_version`.
- **LL-C12.**
  - The migration 044 constraint name is confirmed with `\d retro_runs` on the test DB.
  - Up/down test.
  - The down migration runs only with the app stopped.
- **LL-C13 (tester).**
  - Attach Q1-Q5 to this file's Gate 2 sibling.
  - G2-C1 regression on the LEARN-1 tree: run the 5 GROW int files listed in spec §7-T, then the full `npm run test:int` once on a quiet DB, and record the counts.

# 5. Rulings

- **RR1 accepted.** Every S3 outcome is audited after "const tool = this.tools.get(name)" succeeds, and `unknown_tool` is excluded, so tool names come from the registered set. A steered run can only shift counts among closed codes and registered names. This is the same class as GW-C5 F3. LL-C6 enforces it again at render time.
- **RR2 accepted.** Memory shrinks while clean notes accumulate. (Optional, not security: filter `NOT tainted` in SQL in `forContext` so older clean notes fill the 5 slots.)
- **RR3 accepted with LL-C10/LL-C11.** Bounds: AI edits cannot add tools; `owner_dept` is pinned; caps of 1 per department and 5 per week; digest; rollback restores human escalation. No `seed` version rows exist today, so the change only affects new rows.
- **RR4 accepted.** At most 1 on-demand retro per department per day, plus the weekly one. Proposals over the weekly AI cap escalate to cards.
- **GW-C10 change approved** under LL-C11.
- **RR5 (new) accepted.** §2: clean runs regain designed behaviour, including card-free tree tool grants under company scope (AUTO-2). Acceptable only with LL-C1 and LL-C2.

# 6. GROW Gate 2 re-check

- **G2-C2: PASS (security re-check, HEAD).**
  - grow/tool-requests.ts `apply`: there is one `setIf`. It is followed immediately by "written = true", and the catch block contains "if (written) return { ok: false, code: 'exception', text: GRANTED_UNSETTLED_TEXT }", so a granted tool is never reverted.
  - The later AUTO-1 `projectGrant` edits (+25/-2 since a1a7c18) do not touch this path.
  - db/repos/skill-ai.ts `interrupted(bootTime)` "p.created_at < $1::timestamptz"; app.ts "skillJudge.recover(bootTime)".
- **G2-C1:** recorded as met in gate2-grow.md Closure (2026-11-10). The tester re-runs it as a regression under LL-C13.

# 7. Residual risks (plain)

- Bot replies posted before the deploy stay recorded as tainted, so old threads keep tainting runs until new messages arrive.
- Any guild member who can post in a head's work room can still steer that head's clean `skill_propose`. The AI judge and caps are the control (accepted at GROW).
- Job and reminder rows created by the tool path before LL-C2 are not re-tainted. They need a manual look.
- Incident counts can be nudged by a steered model (RR1).

# MD5 of audited files (end of review)

```
b5cbccc6e15e7b3d0f8e67cff1407a58 agents/loop/loop.ts
6169f9e5c7a023142b0dc178ee8edd5e agents/context.ts
1aca29ce908af6ab2f759838dd881e06 prompts/assemble.ts
d08596262a0a4e7847803c8708343c75 agents/review/notes.ts
7fcacd99de60924fecbdd0afe9d14a6a tools/builtin/updateTask.ts
0716f8b05b3dd123f30b83251efa291f agents/team/teamtalk.ts
dfcaa94eba79b233a1b6d2ebce99131b agents/scheduler/scheduler.ts
bce2cada045b05842594da6e92828755 tools/registry.ts
67871600c7d34ee1adfede063648ec7c skills/service.ts
45f088fb080b5caa661edbc1ed55fbf8 governance/skill-judge.ts
a3e01475f7733cf3d71088fa5d00ea97 grow/tool-requests.ts
caf904b54e8fb7029bfddc6704bf16f7 db/repos/skill-ai.ts
42bc8547e8e1fd04162ba6e674ce513a app.ts
8eb1998453b85582c7e9b8b05fcd814e tools/plugins/schedule/index.ts
a8fd27c7ebafc7721467fe64c78e8b5d tools/plugins/schedule/runner.ts
a3c7976fd854a5ea446d643c026d082b db/repos/tasks.ts
01659f16142f12846c828e04b15fd02c db/repos/ledger.ts
17357cb7ecfb338c22fd8bb0ee56929f db/repos/grow.ts
b58607c10d304ecc57ba3125c8842e02 admin/keys.ts
97708162c1d1af0e43689a2b2b73ca70 discord/commands/index.ts
44aee7b0c3ce975a94464638634e8b88 docs/superpowers/specs/2026-11-12-learn-loop-design.md
```

Missing context: `<PROJECT_ROOT>/CLAUDE.md` and `<PROJECT_ROOT>/.claude/rules/` are absent; team rules were read from TEAM_DIR.

## Owner sign-off

Residual risks accepted under the owner's one-time approval of the growth roadmap (2026-11-12, in chat). Build may proceed under LL-C1 to LL-C13; release to the live bot needs the owner's release approval.
