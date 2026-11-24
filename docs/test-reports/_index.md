# test-reports — index

Up: [docs index](../_index.md)

- [TASK-030 System log bot test report](2026-11-24-task030-syslog.md) — §12.14 + Gate 1 S1214-01..05 verification on fakes, 617 passed, no Critical/High defects | test, discord, syslog
  - [Acceptance (backend `tests/test_discord_syslog.py` re-run plus independent probes)](2026-11-24-task030-syslog.md#acceptance-backend-teststest_discord_syslogpy-re-run-plus-independent-probes)
  - [Backend deviations](2026-11-24-task030-syslog.md#backend-deviations)
  - [Defects](2026-11-24-task030-syslog.md#defects)
  - [Not covered](2026-11-24-task030-syslog.md#not-covered)
- [Test report - TASK-031 approvals routing, codes, settings](2026-11-24-task031-approvals.md) — title: "Test report - TASK-031 approvals routing, codes, settings"
  - [Acceptance A1-A16 (existing backend tests re-run green, plus mine)](2026-11-24-task031-approvals.md#acceptance-a1-a16-existing-backend-tests-re-run-green-plus-mine)
  - [Gate 1 T031-01..09](2026-11-24-task031-approvals.md#gate-1-t031-0109)
  - [My adversarial additions (tests/test_task031_adversarial.py)](2026-11-24-task031-approvals.md#my-adversarial-additions-teststest_task031_adversarialpy)
  - [Defects](2026-11-24-task031-approvals.md#defects)
  - [Not done](2026-11-24-task031-approvals.md#not-done)
- [Phase 1 Slice A acceptance report (TASK-021A)](phase1-sliceA.md) — TASK-021A acceptance via CLI script; DEFECT-1..2 | test, phase1
  - [Results (all rc=0 unless noted)](phase1-sliceA.md#results-all-rc0-unless-noted)
  - [AC-10 secret grep](phase1-sliceA.md#ac-10-secret-grep)
  - [Defects](phase1-sliceA.md#defects)
  - [ACCEPTANCE vs original request: partially met (Slice A scope)](phase1-sliceA.md#acceptance-vs-original-request-partially-met-slice-a-scope)
  - [Deferred to Slice B (021B)](phase1-sliceA.md#deferred-to-slice-b-021b)
- [Phase 1 Slice B1 acceptance report (TASK-021B-T, text)](phase1-sliceB1.md) — TASK-021B-T text acceptance on fakes, coexistence probes, 20-client resources; DEFECT-1, SPEC-GAP-1 | test, phase1, discord
  - [1. Method](phase1-sliceB1.md#1-method)
  - [2. Results](phase1-sliceB1.md#2-results)
  - [3. Defects](phase1-sliceB1.md#3-defects)
  - [4. Resources (S1210-09: MemoryMax=1G, TasksMax=100)](phase1-sliceB1.md#4-resources-s1210-09-memorymax1g-tasksmax100)
  - [5. ACCEPTANCE vs original request: partially met (B1 text scope, against fakes)](phase1-sliceB1.md#5-acceptance-vs-original-request-partially-met-b1-text-scope-against-fakes)
- [Phase 1 Slice B2 (voice) Test Report](phase1-sliceB2.md) — TASK-021B-V voice acceptance on fakes (consent, erase, TTS, budget, DAVE guard), 5-speaker resource run; DEFECT-1 (fixed only in working tree), live-only list | test, phase1, discord, voice
  - [1. Runs](phase1-sliceB2.md#1-runs)
  - [2. Acceptance items](phase1-sliceB2.md#2-acceptance-items)
  - [3. Exploratory](phase1-sliceB2.md#3-exploratory)
  - [4. Resources (fakes)](phase1-sliceB2.md#4-resources-fakes)
  - [5. Defects](phase1-sliceB2.md#5-defects)
  - [6. Live-only (owner's DAVE probe / VPS)](phase1-sliceB2.md#6-live-only-owners-dave-probe--vps)
- [S11 assumed-behaviour probes (spec §11.14.3)](s11-probes.md) — SQLite probes P1-P7 (local 3.53.4, VPS target 3.45); spec §11.14.3 | test, sqlite, s11, pivot
  - [Environment](s11-probes.md#environment)
  - [Verdicts](s11-probes.md#verdicts)
  - [VPS commands](s11-probes.md#vps-commands)
  - [Notes](s11-probes.md#notes)
