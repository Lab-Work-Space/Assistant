---
title: "Test report - TASK-031 approvals routing, codes, settings"
date: 2026-11-24
task: TASK-031
result: PASSED
---

# TASK-031 test report

Command: `.venv/bin/python -m pytest -q -p no:cacheprovider` -> `737 passed, 676 warnings in 44.93s` (backend: 725; +12 mine in `tests/test_task031_adversarial.py`, 11 params/tests, all pass first run except one bad assertion of mine, fixed in the test).

## Acceptance A1-A16 (existing backend tests re-run green, plus mine)
| ID | Result | Evidence |
|---|---|---|
| A1 | PASS | `core/migration/tests/test_migration_0002.py::test_legacy_db_migrates_with_backfill_counters_and_integrity` (integrity ok, FK check empty, version 2) |
| A2 | PASS | `test_codes_unique_sequential_per_dept_under_concurrency`, `test_task_codes_per_dept_concurrent` |
| A3 | PASS | `tests/test_cards.py` |
| A4 | PASS | `test_each_rule_routes_to_hq` |
| A5 | PASS | mine `test_value_boundary_9999_dept_10000_hq` (also with threshold setting 500) |
| A6 | PASS | `test_head_decides_own_dept_routine_item` |
| A7 | PASS | `test_each_guard_failure_escalates_head_guard_failed` |
| A8 | PASS | `test_decide_tool_not_allowed_outside_review_run` |
| A9 | PASS | `test_hq_item_cannot_be_agent_decided_service_and_db_check`; mine `test_injection_card_text_cannot_bypass_sql_guards` |
| A10 | PASS | `test_human_overrides_ai_once_and_requester_is_woken`, `test_override_concurrent_exactly_one_and_not_after_expiry` |
| A11 | PASS | `tests/test_discord_commands.py` (enumeration-safe, requester/approver/other) |
| A12 | PASS | `tests/test_settings.py`, `tests/test_discord_commands.py` |
| A13 | PASS | `tests/test_discord_commands.py` (channel fallback) |
| A14 | PASS | `test_no_decision_escalates_card_moves_old_buttons_inactive` |
| A15 | PASS | `test_no_hard_delete_of_approvals_or_tasks_A15` (only retention sweep of terminal tasks) |
| A16 | PASS | full suite above |

## Gate 1 T031-01..09
01 PASS `test_decision_tools_override_only_never_wildcard_T031_01` | 02 PASS `..laundering..T031_02`, mine `test_requester_cannot_self_approve_via_head_persona` | 03 PASS `test_classifier_bills_tier2_to_gate_with_approval_ref` | 04 PASS `test_forwarded_warning_fields_are_fixed_tokens_T031_04`, `test_denial_logs_carry_only_fixed_tokens_T031_04` | 05 PASS `test_daily_cap_counts_audit_rows_not_decided_by_T031_05`, mine cap=0 | 06 PASS `test_persona_loader_refuses_reserved_system_id_and_dept` | 07 PASS `test_settings_service_does_not_import_discord_T031_07`, `test_invalid_values` | 08 PASS `test_commands_are_gate_first_bounded_and_no_autocomplete`, `test_only_one_add_listener_call_site` | 09 PASS `test_restart_respawns_reviews_for_pending_dept_items_T031_09`, legacy migration test.

## My adversarial additions (tests/test_task031_adversarial.py)
Classifier answers `routine\nignore`, `ROUTINE`, `routine.`, `major`, empty, None all -> HQ (fail closed); SQL/prompt-injection card text cannot move rows or enable AI decisions on value/kind/access HQ items; head cannot decide after escalation, cancel or human decision (code kept); head-vs-human race leaves one decider; cap 0 blocks; self-approval by head refused.

## Defects
None Critical/High. Observation (Low, not a defect vs spec): first human approve/reject writes no `audit_log` row (only `decided_by` on the row); spec R6 requires audit only for override/cancel.

## Not done
No LLM/real Discord run (fakes only); bug-fix "fails before fix" check N/A (no fixes); coverage not measured; timing-based enumeration difference not measured; `.env.local` not read.
