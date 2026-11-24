# Phase 1 Slice A acceptance report (TASK-021A)

> 2026-11-23 — evidence below ran on the pre-pivot PostgreSQL stack. After the SQLite port (SQLITE-PORT) the same acceptance harness `tests/acceptance/run.sh` was re-run on SQLite: all cases rc=0, full suite 230 passed at re-run time (237 passed after later Gate 2 S11 fixes). A tester re-run on the VPS is pending.

Date 2026-11-23. Harness: `tests/acceptance/run.sh <out_dir>` (throwaway postgres:16 on a random localhost port, roles from
`docker/postgres/init/10-roles.sh`, `alembic upgrade head` as emp_migrator, CLI as emp_app, container removed on exit, passwords only in shell vars).
Each case = `python -m core.cli --as user --script <file>` run in-process by `tests/acceptance/run_case.py` with fake providers
(`tests/acceptance/fakes.py`, no network, no keys). Scripts: `tests/acceptance/scripts/`. Raw transcripts and the app log: `tests/acceptance/evidence/`.
Tables usage_events, budget_notices, budgets (and approvals, tasks, brainstorm_threads, jobs) were cleared before every case.
Caveat: the harness patches `Session.handle` in the test process only, to add a `/sleep N` script command (AC-9 wait); no product code changed.

## Results (all rc=0 unless noted)

| AC | Case | Result | Evidence (evidence/) |
| :-- | :-- | :-- | :-- |
| 1 partial | ac1: `hello there` -> `[praw] reply from gemini-3.8-flash`; log `tool.respond ... implicit:true` | PASS | ac1.out, ac1_implicit_log.txt |
| 2 partial | ac2: `/delegate fahsai ...` -> embed `TASK-1 write the report`, `Assignee: fahsai`, task thread `[thread 2001 fahsai] reply from claude-haiku-5-5` (fahsai's own persona/model), close embed | PASS | ac2.out |
| 3 logic | ac3: `/brainstorm launch-plan praw fahsai 4` -> praw, fahsai, praw, fahsai (no repeat), `Brainstorm closed`, `Reason: turn_limit`, `Turns: 4` | PASS | ac3.out |
| 4 partial | ac4: user `/approve` and `/reject` -> `not_approver`; admin `/approve` -> `approved decided_by=cli:admin`; agent resumes `Thanks, approval received`; re-approve -> `not_found`; 2nd request rejected -> `rejected decided_by=cli:admin` | PASS | ac4.out |
| 5 full | ac5: `knowledge_read_index notes` then `knowledge_read alpha-plan.md` only; beta-plan.md never opened; reply contains `ALPHA-BODY-MARKER` | PASS | ac5.out, ac5_knowledge_log.txt (2 `knowledge.open`: `_index.md`, `alpha-plan.md`) |
| 6 full | ac6: `image_generate` -> `[praw] [file] <tmp>/image.png` via sink | PASS | ac6.out |
| 9 full | ac9: queued `selftest_crash` job (JOBS_ENABLE_SELFTEST=true) -> DB `selftest_crash\|failed\|signal:6\|-6`; `/jobs` shows failed; CLI then answers a chat (`[praw] reply from`) and exits 0 | PASS | ac9.out, db_jobs.txt |
| 10 | ac10 + grep (below) | PASS for logs/output, with DEFECT-1 on script echo | ac10.out, final output |
| explore | ac11: unknown agent, unknown command, zero-uuid approve, `/budget set` as user (`not_approver`), bad amount, bad thread, empty lists: no crash | PASS | ac11.out |

Full suite, same throwaway DB (TEST_APP_URL set): `149 passed, 3 skipped in 5.60s` (evidence/pytest.txt; skip reasons not itemised in that run).
Without a DB the suite skips every DB test, so this is the meaningful run.

## AC-10 secret grep
Planted in env: ANTHROPIC_API_KEY (`sk-ant-PLANTED-...`), GOOGLE_API_TOKEN (`AIzaPLANTED...`); plus the random DB passwords of the three roles.
User typed both planted keys into chat; the fake provider echoed them split across two stream chunks.
`grep -rlF <value> evidence/` over all CLI output (*.out, *.err), the JSON app log and the pytest log:
- DB passwords (3): 0 files. App log `app.jsonl`: 0 hits for all five values.
- Planted keys: found only in `ac10.out` on the script-echo line `> ECHOQ key=<raw value> ...` (DEFECT-1); the streamed reply line is masked: `[praw] echo: ECHOQ key=*** and *** end`.

## Defects
- DEFECT-1 (Medium, owner TASK-025): `core/cli/script.py` `run_script` prints `> <script line>` with a bare `print`, bypassing `clean()`/masking. A secret in a script (or piped transcript) is written to CLI output unmasked. Repro: script line `ECHOQ key=<fake key>`, run `--script`, see `ac10.out` line 4. AC-10 "CLI output" is therefore not fully met; fix = route the echo through `Out.line`.
- DEFECT-2 (Low, owner TASK-011): when a script ends within ms of startup, the runner background loop logs ERROR `job.claim_error`/`job.sweep_error exc_type=InterfaceError` (pool closed under it); see `app.jsonl` lines 61-65 (ac11). Cosmetic, shutdown race.
- Observation (Low, TASK-018A): price table lacks `claude-haiku-5-5` (fahsai's model): log `budget.unknown_model`; fail-safe, charged at the highest price. Needs price entry before go-live. Missing `knowledge/meetings` area makes the meetings sweep log `job.sweep_error exc_type=KnowledgeError` (seen in a first run, fixed in the fixture by seeding the area).

## ACCEPTANCE vs original request: partially met (Slice A scope)
Met in the CLI: streamed reply, delegation + task record + own persona, brainstorm with turn limit and summary, approval by identity with agent resume, index-first knowledge, image delivery, crash-isolated jobs.

## Deferred to Slice B (021B)
AC-1 addressing rules, Tier 1/2 gate, silence, Discord edit-streaming; AC-2 thread/webhook name+avatar/embed in channel; AC-3 thread presentation; AC-4 real buttons, `AI-Admin` role, ephemeral rejection; AC-6 attachment smoke; AC-7 voice (all); AC-8 pull-user (all); AC-9 bot-level regression; AC-10 Discord chat side. Not covered by Slice A at all: real providers/MCP/plugins/skills, speech, subprocess agents (phase 2).
