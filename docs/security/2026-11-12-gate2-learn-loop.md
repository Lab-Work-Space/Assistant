---
title: "Security Gate 2: LEARN-1 learn loop + R1 OPS-HOLD release check"
gate: 2
status: APPROVED WITH NOTES
status_code: APPROVED
date: 2026-11-12
task: LEARN-1 (GROWTH-1 R2 + R3); R1 OPS-HOLD release check
project: labworkspace (BOT/Assistant)
tree: main @ 4ad8541 (LEARN-1 diff 2158719..4ad8541; R1 commit 394cd71)
extends: docs/security/2026-11-12-gate1-learn-loop.md (LL-C1..LL-C13)
---

# Verdict

**APPROVED, with notes.** LL-C1 to LL-C12 are met in code and tests. The two High/Medium Gate 1 gaps (LL-F1, LL-F2) are closed test-first. The seed texts weaken no control. R1 has two Low findings, R1-01 and R1-02. Neither blocks release. Three release preconditions are left for the main thread (section 5).

Anchors are function names or quoted fragments. Line numbers are hints only.

# 1. LL-C status

| cond | status | evidence |
| :--- | :--- | :--- |
| LL-C1 | MET | updateTask.ts `run`: "runOrTaskTainted(ctx) && !task.tainted ? { tainted: true }" is in the same `ctx.tasks.update`. loop.ts after-round: "if (run.tainted() && task && !task.tainted) task = (await deps.tasks.update(task.id, { tainted: true }))" covers the kb same-task variant. Int tests: learn-loop.int "a tainted run on A: B (done, blocked) is tainted ... heal decide task is tainted", "same-task variant". Rule 8 sweep of model-text task writers: create_task (`tainted: ctx.tainted()`, Gate 1), project_task (refuses tainted, projects.ts "return no('tainted')", so `tainted: false` is correct), update_task (fixed). Every other `tasks.update`/`create` site writes status or code text only (halt, heal-actions, retry, reroute, governance/projects budget block, registry taint copies). |
| LL-C2 | MET (code) | schedule/index.ts and reminders/index.ts `precheck` "runOrTaskTainted(ctx) ? { refuse: TAINTED_SETUP_REFUSAL }". registry.ts runs precheck before `approvalFor`, so no card is filed. learn-setup.int.test.ts has both the tainted case and the clean control. The tester's live row list is still open (section 5). |
| LL-C3 | MET | loop.ts filters are "typeof n === 'string' \|\| n.tainted !== true" and "filter((e) => !e.tainted)". The lessons filter and the UNVERIFIED backstop are unchanged. learn.wiring.test.ts checks one call site each. |
| LL-C4 | MET | Grep of removed non-test lines containing "tainted": only the two retro-only filter conditions (the intended D1 change) and doc comments. No §2 consumer is loosened. The only new consumers are LL-C1 and LL-C2. tree-grant-acceptance now expects no schedule_add card from a tainted run, which is stricter. |
| LL-C5 | MET | Migration 044 CHECKs. S1–S6 in dept-incidents.ts. The sweep logs `errName` only. The marker tests are dept-incidents.int "no free text ever reaches a column" and learn-loop.int D2/LL-C5 (prompt). |
| LL-C6 | MET | incidents.ts `incidentBlock` re-checks kind, the closed code set per kind, `SAFE_TOOL_NAME` + `isKnownTool`, and n from 1 to 100000. Output is capped at 700 characters and never contains UNVERIFIED. A throw gives ''. Offer gate in loop.ts: "actor.kind === 'head' && !adminRun && !trigger.postOnly && !trigger.retro", inside try/catch. |
| LL-C7 | MET | COMMAND_TABLE 'retro:run' sits after `decide()`. `retro` is in `deferEphemeral`. Reply texts are fixed and nothing the caller typed is echoed. Dept is checked with DEPT_ID + `org.dept`. Audit row `user:<id>`. Wiring test LL-C7. |
| LL-C8 | MET | Day key `D<date>` is shared, with one row per (dept, week). At most one start per tick. The tick gate checks off day, `canRun` and `checkOpenTasks`, and skips praw, disabled and offline depts. Requests expire after 24 h. S8 counts since `max(claimed_at)`. `closeOpenRetroTasks` now has "AND task_id IS NOT NULL". |
| LL-C9 | MET | schema/defaults/HANDLER_KEYS; keys.grow.test "absent from ADMIN_CONFIG_KEYS". A read error counts as off, in the sweep, the seeder and the threshold. |
| LL-C10 | MET | The `seed:` SkillOp is built only in skills/seed.ts (seed.wiring.test). plans.ts "build({ op: 'create', id, draft, ...(attach ...) })" is an explicit literal. `tools: []` comes from code. `bad_seed` and praw `unknown_target` are checked. A sha snapshot is in place. All 14 seed texts were read (section 3). |
| LL-C11 | MET | `HUMAN_SOURCES = ['admin', 'rollback']` is read at both sites. The seed-edit-applies, tools-change-refused and rollback-escalates steps are tested (skill-judge.int "LL-C11"). Live precondition: the seed count is 0 (main thread). |
| LL-C12 | MET, one doc gap | migrate.int passed: up/down/up for 044, and 039→044 from an older tree. 044 up uses `DROP CONSTRAINT retro_runs_week_check` without IF EXISTS, so a wrong name would fail that test. 039 declares the CHECK inline, so Postgres gives it the default name, and the live DB has the same name. Gap: the down file has no "app stopped" note. Record it in the runbook. |
| LL-C13 | OPEN (tester) | Q1–Q5 and the full int count are not attached here. Backend reports unit 5366 and int 1581 green. My runs are in section 6. |

# 2. Deviation rulings

- **`AgentDeps.deptIncidents`**: accepted. It avoids a clash with the BOTLOG `incidents` reporter, and the wiring test pins it.
- **`incidentBlock(rows, isKnownTool)`**: accepted. It is wired to `deps.tools.has`, the registry's own lookup, which is stricter than a name list.
- **S1 `COALESCE(t.blocked_reason,'owner') IN ('halt','approval')`**: accepted. NULL becomes the closed code `owner`. The ikey uses the same COALESCE. halt/approval stay excluded. This counts more, never less.
- **LL-F3 not applied** (decide tasks excluded by title): accepted as a Low residual. A model-titled hq root can only hide its own block from the counts.
- **WeeklyRetro optional `isHalted`**: accepted. app.ts wires `halt.isHalted()`. When it is absent, `!canRun()` stands in, which errs toward refusing.
- **F9 line always emitted**: accepted. It holds counts and closed codes only, through `code()`/`n()`.
- **Updated existing tests**: accepted. loop.behaviour adds an explicit untainted note. tree-grant-acceptance now refuses the tainted schedule_add, which is stricter. Neither change hides a regression.
- **Seed ops audited as `skill.seed`; praw seed → `unknown_target`**: accepted.
- **skills-acceptance presets `skills.seed.enabled=false`**: accepted. It keeps the library count of that test fixed. seed.int covers the seed path.
- **LL-C11 "after an admin edit" covered by the GW-C10 test only**: accepted. The `admin` source path is unchanged, and skill-judge.int "GW-C10: a person's edit makes the next AI edit escalate" covers it.

# 3. Seed texts (skills/seed-data.ts, 14 skills)

PASS. All are process guidance: complete create_task fields, quote exit codes, mark unverified figures, keep personal details out of rooms, one question at a time. None of them tells a bot to skip approvals, cards, taint, budgets or halts. None asks for tools (`tools: []`). None tells a bot to treat outside content as instructions. "Open the result page" (rnd) leads to fetch_page, which taints the run as designed.

# 4. R1 OPS-HOLD release check

- **Classification**: PASS with R1-01. The parser sets `sawRejected` only from a `rate_limit_event` JSON line, and only together with a failed call (protocol.ts `finish`, index.ts "if (parser.rejected()) throw quotaRejection()"). The CLI's error text is never read. Model text cannot forge a top-level stream event.
- **Hold**: PASS. `quotaHoldUntil` is derived from the persisted snapshot, `load()` re-arms it after a restart, and a stale rejection gives no hold. The per-actor gate is `mayRunAs` → `isHeld`, which resolves the actor's own provider, and a fault reads as not held. The hold end calls `resumeHeld`, which re-offers `todo`.
- **Requeue**: a quota-cut run goes from doing to todo (loop.ts `requeue`), not to blocked. The healer skips held owners and deciders without writing a claim.
- **R1-01 (Low)**:
  - Problem: `eventRejected` is true when any parsed window is rejected, including `seven_day_opus` and `seven_day_sonnet`. `quotaHoldUntil` holds only on `five_hour`/`seven_day` or a top-level rejection. The same applies when the event fails to parse.
  - Effect: a per-model rejection plus a failed call requeues the task to `todo` with no hold, so `resumeHeld` never fires. The healer, which scans only blocked tasks, never sees it. The alert still says "resumes by itself". The task sits in todo until a restart or a new trigger.
  - Fix (backend, test-first, one file): classify as a quota rejection only when the hold rule would hold, meaning a shared window or a top-level rejection. Otherwise keep `block(..., 'error')`.
- **Stale review auto-close**: PASS with R1-02. It is code-only. One conditional UPDATE runs under the task lock and re-reads approvals. It excludes conversation tasks, tasks with open children or pending approvals, and active-project trees. The event summary is fixed text, and an audit row `task.review.autoclose` is written. At most 10 per sweep. Never while halted.
- **R1-02 (Low)**:
  - Problem: it closes review tasks without the `/task done` human accept. It does not check the calendar, so it also runs on off days. It does not exclude a task with an open ASKBACK question (`task_questions` status pending/asked). The owner sees only an audit row and the task event, with no count in the heal summary.
  - Live effect: about 11 tasks are in review now (roadmap), so the first sweeps after deploy close nearly all of them within about 2 hours, and each starts a parent roll-up run.
  - Fix (backend): add an "Auto-closed reviews: N" line to the heal summary, exclude tasks with an open question, and skip off days. Owner option: set `review.autoCloseHours` to 0 by psql before deploy if they want to check those tasks first.

# 5. Release ruling

**R1 + LEARN-1 (migration 044, seed skills at boot, D1 taint filters) may be deployed to the live bot now**, subject to these preconditions for the main thread (read-only, live):

1. `SELECT count(*) FROM skill_versions WHERE source='seed'` = 0. This is confirmed.
2. LL-C2: list the active `jobs` and `reminders` rows created by the tool path since 2026-11-07, review them by hand, and do not delete any.
3. The owner decides on `review.autoCloseHours` (R1-02) before the restart.

R1-01 and R1-02 go to backend as follow-ups and do not block.

**For the owner:** After the restart, old tasks waiting in review close themselves within about two hours. Set `review.autoCloseHours` to 0 first if you want to check them yourself. Bots can no longer set up schedules or reminders after reading outside content. Each department gets one or two starter skills, which the AI changes only if you switch `skills.ai.enabled` on.

# 6. Runs (security, test Postgres via docker-compose.test.yml, brought down after)

- int: 11 files (learn-loop, dept-incidents, learn-setup, seed, skill-judge, retro, grow, migrate, tasks, tree-grant-acceptance, skills-acceptance): **149 passed**.
- unit: 54 files (grow, seed, loop.incidents, quota, autoclose, hold, healer, claude-code-local, admin, retro cmd, updateTask, schedule, reminders): **513 passed**.

# MD5 of audited files (end of review, HEAD 4ad8541)

```
1c241b94ac1e46660ec3f9ee4a65f478 agents/loop/loop.ts
b471fe57efec83db6039c44893c1b4c7 prompts/assemble.ts
23709abc8a837860becd4111cd1b9717 tools/builtin/updateTask.ts
7dd718efb18b446a104f6e766672e72d tools/types.ts
961c9d0718452c8febd7769ec81db120 tools/plugins/schedule/index.ts
5e65be5d1ab1b4caae437e7438ccc600 tools/plugins/reminders/index.ts
bce2cada045b05842594da6e92828755 tools/registry.ts
76b1953acccef679761e77f16bf3b54a grow/incidents.ts
43b4c3d965e78d78b6172667e9ade525 grow/incident-sweep.ts
ba6e946c37759e9a239a976d521853f4 grow/retro.ts
27ff75d640d8375eae5c71cc9cd0c3d7 grow/retro-facts.ts
570c54b5db0a520c83a7e6cb14fa9a34 db/repos/dept-incidents.ts
1eac30abd5401bb05951f3f1bceeeba5 db/repos/grow.ts
36964196a15a852eeb64b4afbab319d4 db/migrations/044_learn_loop.up.sql
fa250c5d2bfa15e177b67e4deadba2bb db/migrations/044_learn_loop.down.sql
a9f491efd39be2686f4143fa1189d6c8 discord/commands/retro.ts
416466efc9fc2925d6aff1f5e5154248 discord/commands/index.ts
37dd2b36ac6fea8c41cddf488b6e14a5 skills/seed.ts
59f4c68688ef49d6c463433bbc023ebb skills/seed-data.ts
7187adae037e4fce8787f0317ad6b07c skills/service.ts
45f088fb080b5caa661edbc1ed55fbf8 governance/skill-judge.ts
0162f5c55952cfb4f6d384f2b91d0090 app.ts
94d203aaf03af511b47e4d16151d2f60 app-start.ts
bda0dc3c2ef96a215c8054849d9bcc3f admin/keys.ts
f3394257bc8a8a7b1df2965f57157fbb config/defaults.ts
12a23c242838971c7eccf206989649ad config/schema.ts
6671f3edfad539ef40df5fbc38735b32 agents/scheduler/scheduler.ts
ab4130e94e7b71222683d3fbd6a6b04d agents/scheduler/notices.ts
cd10ba2078fb2e67f7679d2f37219c36 agents/tasks/healer.ts
a3c7976fd854a5ea446d643c026d082b db/repos/tasks.ts
b24996ca6f7d2ba0d73b5b70e1434e26 governance/quota/quota.ts
01e407f80bc06cc09213c5436ed2e374 providers/claude-code-local/quota.ts
4ed011a80c84ca7284174628e70da84f providers/claude-code-local/protocol.ts
ef3ccbd4f1e4b8cf478754b0e50962b7 providers/claude-code-local/index.ts
4c24fedfa3c7bbf6f6f04b9e05cca5b5 providers/types.ts
```

Missing context: `<PROJECT_ROOT>/CLAUDE.md` and `<PROJECT_ROOT>/.claude/rules/` are absent. Team rules were read from TEAM_DIR.

## Release record

2026-11-12 ~16:50 Asia/Bangkok: the owner approved the release in chat (all of R1 + LEARN-1, including review auto-close at the default 24 h). R1-01 and R1-02 were fixed first (commit 7c32a03; no security re-check of that diff recorded). Deployed HEAD with migration 044; all 10 departments online; 14 seed skills installed (`skill.seed ok v1` ×14). Preconditions: seed versions 0 before deploy; no tool-made jobs or reminders since 2026-11-07.
