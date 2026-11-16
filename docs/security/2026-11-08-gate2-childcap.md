# Gate 2 — CHILDCAP-1 (childrenPerTask counts open children only)

Date: 2026-11-08. Status: **APPROVED**.

## Change
`governance/limits.ts` `checkChildren` now uses `TaskRepo.countOpenChildren` (direct children with status not in done/cancelled) instead of lifetime `countChildren`. Tests: `governance/limits.test.ts`, `db/repos/tasks.int.test.ts`.

## Callers (all still pass through checkChildren plus other caps)
| Caller | Path | Other caps still applied |
| --- | --- | --- |
| create_task / forward_to (and delegation, meeting, askback, OT that go through `delegate`) | `tools/builtin/createTask.ts:149-166` | checkDepth, checkOpenTasks, botRoots gate (no parent), takeForward per root (forward), approval for estCost, tree cost cap at run time |
| REROUTE-1 | `agents/reroute.ts:481-513` | checkDepth, checkOpenTasks, takeForward(FORWARDS_PER_ROOT) per child, botRoots, per-message/per-person reroute caps, dup window |

## Analysis
- **Re-spawn loop (child finishes, slot frees):** each create needs a model turn; `turnsUsed` is persisted per task and cumulative (`agents/loop.ts:332`), so one parent can create at most about `turnsPerTask x childrenPerTask` children over its life. Tree spend is bounded by the tree cost cap (`governance/approvals.ts:112`) and budget; total company load by `limits.openTasks`; forwards/reroutes by `takeForward` per root. A tainted model cannot get unbounded fan-out.
- **Race (count-then-insert):** unchanged by this change; the check was always non-atomic. Runs on one task are serialized and tool calls run sequentially (`agents/loop.test.ts` 6th-create test). Overshoot is at most the number of concurrent writers on one parent, as before.
- **Lifetime-semantics assertions:** `agents/loop.test.ts:127` asserts `countChildren == 5` with all 5 open, still valid. Gate 1 docs reference `checkChildren` only as "bounded", still true. No doc asserts lifetime semantics.

## Findings
- [INFO] `governance/limits.ts:5` — `Counts` Pick still lists `countChildren`, now unused by `Limits`. Cosmetic; can be dropped later.

No fixes made in this audit.
