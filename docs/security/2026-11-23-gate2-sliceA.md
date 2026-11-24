---
title: "Security Gate 2 — Phase 1 Slice A (TASK-022A)"
gate: 2
task: TASK-022A
plan: docs/plans/2026-11-23-phase1-plan.md
status: rejected (supply chain only; code approved)
date: 2026-11-23
---

# Security Gate 2 — Slice A

## Contents

> Line numbers refreshed 2026-11-23; regenerate after edits.

- Verdict — L29
- Gate 2 probes (real output) — L49
- G1 re-check (code anchors) — L56
- Findings — L94
- Book and doc notes (not findings) — L112
- Supply chain — L118
- Secrets — L125
- Audited files (md5 at review end) — L128
- Fixes 2026-11-23 (devops) — L169
  - grype before / after — L180
  - Residual risk on the bot image (draft acceptance text, for the owner; not accepted by devops) — L186
  - Notes — L192

## Verdict
**REJECTED, on supply chain only (G2-03).** The pinned `postgres:16-alpine` digest has HIGH CVEs, and a fixed package build exists for each one. §4.1 says an unpatched HIGH = reject.

The Slice A code itself passes:
- There is no open High or Critical code finding.
- G1-01, G1-05, G1-06, G1-09 and G1-10 are confirmed in code.
- All three Gate 2 probes pass.

In this report, *unpatched* means a fixed package build exists and the image does not use it.

To re-submit, both of these are needed:
1. G2-03: re-pin the postgres digest and attach a new grype scan.
2. G2-04: a recorded owner acceptance of the risk, or a switch to another base image followed by a new scan.

The code does not need a second audit unless the md5 list below changes.

TASK-021A (acceptance) ran in parallel while G2-01 and G2-02 changed `core/agents/untrusted.py` and `core/cli/__main__.py`. Re-run acceptance, or confirm it ran, against the md5 list below.

A read-only grep of `tests/acceptance/` found no expectation that depends on the old escape output or the old `Type:msg` refusal text.

## Gate 2 probes (real output)
| Probe | Method | Result |
|:--|:--|:--|
| (a) §10.2.1 budget | The real `core.agents.ext` registered a real `AnthropicAdapter` (fake key). `core.budget.ext` was replaced by a module that leaves the Noop guard, then `init_core` ran. | `a: refused: budget_guard_missing \| providers registered: ['anthropic'] \| budget: NoopBudgetGuard` |
| (b) CLI with token | The real `python -m core.cli --as admin` ran from a scratch copy of the tree (no `.env.local`), under `env -i`, with valid secret lengths. | b1 `EMP_CLI_DEV=1` + `DISCORD_BOT_TOKEN`: `cli_dev_disabled`, exit 2.<br>b2 flag unset: `cli_dev_disabled`, exit 2.<br>b4 token is whitespace only: `cli_dev_disabled`, exit 2.<br>b5 flag line in `.env.local`: `cli_flag_in_env_file`, exit 2.<br>b3 control (flag set, no token): passes the gate and stops later at `ConnectionRefusedError` (DB on port 1).<br>b6 mid-session: `is_approver(admin)` is True, then False once the token is set. |
| (c) `members:` note | The real `KnowledgeStore`, `Registry`, knowledge tools and `CliDevApproverPolicy`, on a note with `members:111…,222…`. | Non-participant `cli:user`: `(False,'not_found')`, the same result as for a file that does not exist.<br>Agent-only run (`human_user_id=None`): `not_found`.<br>`cli:admin` (approver): ok. This is by design, §10.10.1.<br>`cli:admin` after the token is set: `not_found`.<br>Search for the hook marker: 0 hits, and the hook is absent from the index.<br>An entry with no `visibility` key: `not_found`. |

## G1 re-check (code anchors)
- **G1-01:** `require_real_budget` is called last in `init_core`. Budget checks:
  - `Guard.level` returns `"stop"` on any exception (`budget.level_error`).
  - `record` adds failed inserts to `_unrecorded` and never raises.
  - An unknown model is charged the table maximum.
  - The engine `finally` records `{run_id}:est` when no usage event arrives.
  - `image_generate` checks `level` before the call and records after it.
  - Every paid call site (`adapter.stream`, `generate_image`) is gated.
- **G1-05:** worker isolation in `PgJobRunner`:
  - `_env` is built from scratch: no `DATABASE_URL`, no token.
  - `cwd=tempfile.mkdtemp(prefix="emp-job-")`.
  - `worker_entry` requires `kind in allowed_kinds`.
  - Self-test kinds are registered only when `jobs_enable_selftest` is on.
  - stderr is logged as a length and sha256 only. `ERROR_RE` and `PROGRESS_RE` limit what is stored.
  - The RC-4 limit text is in the runner docstring.
  - DB tests `test_kind_allowlist` and `test_cwd_not_project_root_and_env_scrubbed` pass.
- **G1-06:** approval path:
  - `PgApprovalService.decide` checks `actor.kind != self.policy.surface`, then `is_approver` (an exception means deny). The UPDATE carries `origin=$4`.
  - `CliDevApproverPolicy.is_approver` re-checks `cli_dev_allowed` on every call. `cli_dev_env` reads `os.environ` only.
  - `dotenv_guard` is in place.
  - `set_limit` goes through the policy.
  - DB tests pass: origin mismatch, double-decide race, non-approver.
- **G1-09:** `CliReplySink`:
  - strips control characters, then masks, then buffers by line;
  - `send_file` uses `O_EXCL|O_NOFOLLOW` with mode 0600 in a `mkdtemp` directory;
  - the import-isolation grep (§10.17 RC-1) finds nothing.
- **G1-10 (A):** `can_see`:
  - a `members:` entry is denied when `human_user_id is None`;
  - a denied read returns `not_found`;
  - the index line for a `members:` entry is written as `(restricted)`;
  - `norm_visibility` fails closed.
- **Also checked:**
  - G1-02/03: `MIN_SECRET_LEN`, `_forms`, the `_KEY` regex, the whole-line check, and the idempotence test.
  - RC-3: test present.
  - G1-07: `WRITABLE_AREAS`, `needs_human_trigger=True`.
  - G1-08: real `10-roles.sh` in a throwaway Postgres. As `emp_app`, `CREATE TABLE`, `CREATE TEMP TABLE` and `CREATE TABLE public.z` are all denied. `rolsuper=f`, the role owns 0 objects, and there are no PL/pgSQL functions, so rule 13 does not apply.
  - The real alembic migration passed, and the full suite passed with the DB: **152 passed**.

## Findings
| ID | Sev | Where (anchor) | Issue | Remediation | Owner | State |
|:--|:--|:--|:--|:--|:--|:--|
| G2-01 | Low | `core/agents/untrusted.py` `_TAG` | `<／untrusted>`, `<​/…`, `<⁠/…`, `</​…` and `﹤/…` were not escaped (Gate 1 carry-over probes). | Class widened to `[<＜﹤]`, zero-width chars, `[/／]`. Still linear: a 200 KB input takes 0.01 s. Five test vectors were added to `test_wrap_escapes_closing_tags`. | security | **Fixed** |
| G2-02 | Low | `core/cli/__main__.py` `amain`, `init_core` except | Printed `str(e)[:80]` to stderr unmasked (rule 16). | Now prints the code or the exception type only. | security | **Fixed** |
| G2-03 | High (CVSS); contextual Low | `docker/compose.yml` `postgres:16-alpine@sha256:f2f98726…`. This is the only place the digest is pinned. `tests/acceptance/run.sh` uses the unpinned tag `postgres:16` (test only). | grype (DB built 2026-11-22) finds HIGH CVEs with fixes: CVE-2026-107496, -88823, -95691, -95692 (libssl3/libcrypto3 3.5.9-r0 → r1) and CVE-2026-86144 (libxml2 → 2.13.9-r3). Contextual risk is low: the port is not published, and the app does not use XML or server TLS. | Re-pin to a rebuilt digest, re-run `grype`, attach the output. Also pin the acceptance image. grype scanned only the local platform variant of the image. | devops (TASK-005) | Open |
| G2-04 | Critical/High (CVSS), no upstream fix | `Dockerfile` base `python:3.12-slim-bookworm@sha256:935c…` (both `FROM` lines) | 3 Critical and 40 High CVEs, all `wont-fix` or `not-fixed` in Debian 12, so no patch exists. The final image (with ffmpeg) was not built or scanned, because the build needs network. | Record an owner acceptance of the risk, or switch the base (evaluate `slim-trixie`). Build the final image and scan it with grype before release. | devops / owner | Open |
| G2-05 | Low | tests (none) | The G1-08.6 tests are missing: no `git check-ignore` pytest and no image `.env.local` check. A manual probe passed: `.env.local`, `.env.prod.local`, `knowledge/meetings/x.md` and `logs/` are ignored; `core/*` and `.gitkeep` are tracked. A `docker build --network=none` context check printed `CONTEXT_OK`. | Add both tests per §10.9.6. | devops/tester (TASK-005) | Open |
| G2-06 | Low | `core/cli/__main__.py` interactive loop `await s.handle(line)` | An unhandled exception prints a full traceback with its message and ends the session. Verified with `/expect (MARK`, which gives `re.PatternError …` and exit 1. Rule 16. | Wrap `handle` and print `type(e).__name__` only. Do the same in `run_script`. | backend (TASK-025) | Open |
| G2-07 | Low | `PgApprovalService.request`; `Guard.set_limit` | `request` does not assert `origin == ctx.surface` (Gate 1 non-blocking item). `set_limit` lacks the explicit `actor.kind != policy.surface` check in §10.7.7. Today only `CliDevApproverPolicy` checks the kind. | Add both checks before the Discord policy lands. | backend (TASK-013B/018B) | Open |
| G2-08 | Low | `pyproject.toml`, `Dockerfile` | Runtime image problems: it ships `pytest`, `pytest-asyncio` and `pip` (GHSA-qwm4-qh6w-59xr, Medium); dependencies are unpinned, with no lock or hash file. | Move test dependencies to an extra. Remove pip from `/opt/venv` in the final stage. Add a hashed lock. | devops (TASK-005) | Open |
| G2-09 | Info | `docker/compose.yml` bot | No `mem_limit` or `pids_limit`. | Add both. | devops | Open |
| G2-10 | Info | `core/jobs/runner.py` `_run` `shutil.rmtree(cwd…)` | No realpath prefix check (Gate 1 non-blocking item). The path comes from `mkdtemp`, so it is never empty. | Optional. | backend | Open |

Domains that do not apply:
- Native memory: there is no native code.
- Safety override: there is no override path in Slice A.

## Book and doc notes (not findings)
- The Dockerfile `CMD ["python","-m","core"]` points at `core/__main__.py`, which does not exist yet.
- `CliDevApproverPolicy` lives in `core/approvals/service.py`, not in `core/cli/identity.py` as §10.7.5 says. It fails closed and is built only in `core/cli/__main__.py`.
- A missing `visibility` key is treated as `members:` in every area, not only `meetings`. Human-written `rules` entries need `visibility: "public"` or agents cannot read them (probe c8). The knowledge-format doc and the rules template should say so.
- `core/cli/sink.py` defines `CliReplySink` twice. The first definition is a dead stub that the second shadows.

## Supply chain
- **`.venv`:** grype `dir:.venv` found 1 Medium (pip). `grype purl:` for `pkg:pypi/py-cord@2.8.1` found no vulnerabilities. That hit is the positive control showing Python package matching works.
- **Gaps:**
  - `pip-audit`, `osv-scanner` and `trivy` are not installed.
  - The venv is Python 3.14 and does not contain py-cord, while the image runs 3.12, so this scan does not fully represent the image.
  - The `cryptography` wheel bundles OpenSSL 4.0.3, which grype does not see (rule 18).

## Secrets
A grep of the repo (excluding `.env.local`, `.env.*.local` and `.venv`) found only fakes, test fixtures and planted markers in `tests/acceptance/evidence/ac10.out`. In `.env.example`, every secret value is empty.

## Audited files (md5 at review end)
```
26cbc155a1acb6357aaa188aae131e39 core/agents/untrusted.py
96eb69ccfbdbe7c0fa39f39dc8218882 core/cli/__main__.py
09c7d860519897d0f648cee3daafe9a0 core/cli/identity.py
d2d5735a4dfb4b843efc0cf6ad578eb6 core/cli/sink.py
172133cbe0df9452023514b31324b42e core/cli/script.py
6fdf5aefc4987d2e290d1e433cf0cfc6 core/config.py
f742c982fc1ce67ff5a7e1478c50ef3c core/approvals/service.py
d0b2493de9c72b913eb3946bf63f5ea5 core/extensions.py
6a8df189ba5e5e4ad3efa9399925070d core/interfaces.py
a69619675482208366d57b681bea8c89 core/budget/guard.py
5f56a7bf41e2106bfcf43700607a8740 core/agents/engine.py
334ea6ae89157a6ff67b20329d337f8d core/agent_tools/knowledge.py
9fdf827f09e1cd7d6a6a0bf07df6b0b3 core/agent_tools/registry.py
d3d027c323dbdd3f1ff473c928e1b3ae core/agent_tools/image.py
d7c61913318abc53e8a12445ceeeff02 core/knowledge/store.py
5e5f75f897c9225c88e16cfc4de7a88f core/jobs/runner.py
d30823d377ddf7bb3abbf906d5f6c894 core/jobs/worker_entry.py
80d9aa3b1187c4f636ffcdd0825fc6bd core/functions/logs/masking.py
ddab8e8ece466830055c89028adec1f1 core/functions/logs/logsystem.py
1748c6cee71b95f1dd5953b096325363 tests/test_agent_engine.py
3b8696f9653b369bda693593ff6c6b6f core/agent_tools/approval.py
67be385f4097994fdb6efd6a5ffb1a3f core/approvals/ext.py
f9bfff908c0fd700449589dcb1738cc8 core/budget/ext.py
21b10e128f717906d4e7b05f1327d5bd core/agents/ext.py
f820c5b602eaa9c3825136ae6a7ae353 core/agents/prompt_builder.py
854e1641bd61bfdc8a6ee1bdbcc70db7 core/budget/prices.py
40a7914906379b4b36fbaac1720b58af core/budget/repo.py
eb88083dd75d415281e2981ed8066649 core/jobs/ext.py
7a97443216ef88c06c6ede96ee1e0c91 core/jobs/repo.py
378e4b401b14ec6f73c46f2099abd6f0 core/tasks/brainstorm.py
87d939c5ed740c3156c3ac4d0adda8aa core/migration/versions/0001_phase1.py
32224e08935743179e62a958044ec086 Dockerfile
11d17bc3eccfbebdf36582ea24f644a2 docker/compose.yml
269cef5096f62a9d0cb5ef407197aafb docker/postgres/init/10-roles.sh
1d57cb2ab6b3d77d9ceac4580a02153b .dockerignore
8a5f84d41978671eeb72dbc6e47e2c09 .gitignore
40cda0ddcf726112b0c6019cd37b4970 pyproject.toml
```

## Fixes 2026-11-23 (devops)
Task TASK-005-G2. grype 0.120.0, DB 2026-11-22, arm64 image variant only. "Fixable" means grype reports a fixed version.

| ID | State | What changed |
|:--|:--|:--|
| G2-03 | **Fixed for all fixable CVEs** | Upstream `postgres:16-alpine` has no rebuilt digest yet (newest, 2026-11-22, is the pinned one; `16.16-alpine3.23` and `17-alpine` still carry openssl 3.5.9-r0). Added `docker/postgres/Dockerfile`: the same pinned digest plus `apk upgrade --no-cache`, which brings libssl3/libcrypto3 3.5.9-r1 and libxml2 2.13.9-r3. `docker/compose.yml` now builds it as `employee-postgres:local`. |
| G2-04 | **Partly mitigated, owner decision needed** | Base moved from `python:3.12-slim-bookworm` to `python:3.12-slim-trixie@sha256:5e2bdb1b…`, plus `apt-get upgrade` in the runtime stage. DAVE assert, ffmpeg, libopus, uid 10001 and read-only run all verified. No clean base exists (see below). |
| G2-05 | Fixed | `tests/test_container.py`: `git check-ignore` on `.env.local`, `.env.prod.local`, `logs/`, `knowledge/meetings/` in a temp repo; image has no `.env*` and no pytest/pip (skips if `employee-bot:local` is not built; negative control with a planted `/app/.env.local` is found by the same `find`). |
| G2-08 | Fixed | `pytest`/`pytest-asyncio` moved to the `test` extra in `pyproject.toml`. Added `constraints/requirements.lock` (pip-compile, `--generate-hashes`, 2430 lines); Dockerfile installs with `--require-hashes`. pip removed from the venv and from the system Python in the final stage. Dev install: `pip install -e '.[test]'`. Regenerate the lock after any dependency change. |
| G2-09 | Fixed | `mem_limit`/`pids_limit`: bot 1g/200, migrate 512m/100, postgres 512m/200. |

### grype before / after
| Image | Before | After |
|:--|:--|:--|
| postgres | 9 High rows (5 unique CVEs, all fixable): CVE-2026-107496, -88823, -95691, -95692 (openssl), CVE-2026-86144 (libxml2) | 0 fixable High/Critical. 5 High remain with no fix: openssl CVE-2026-107493, -107494, -121482, -124709, -84786 |
| bot (`employee-bot:local`, bookworm) | 11 unique Critical, 146 unique Critical+High, 0 fixable | 3 unique Critical, 110 unique Critical+High, 0 fixable (rows counted per package: 11 Critical wont-fix, 624 High) |

### Residual risk on the bot image (draft acceptance text, for the owner; not accepted by devops)
- Critical: CVE-2026-52490 (libtiff6), CVE-2026-6653 (libxml2), CVE-2026-75143 (ffmpeg and its libav* libs). Debian marks them `wont-fix` or `not-fixed`; there is no patch to apply.
- High: 107 unique CVEs. About half are ffmpeg/libav* (the same source package counted once per binary), the rest are openssl, krb5, libxml2, util-linux, expat, cjson. None has a fix available.
- Alternatives checked: `python:3.13-slim-trixie` has the identical Debian package set (84 vs 84 High rows in the base). `python:3.12-alpine` + apk ffmpeg has 1 Critical (unknown fix state) and about 41 unique High, but it moves the app to musl; it was not tested with py-cord/pynacl, so it is not a drop-in.
- Draft acceptance: "The owner accepts the unfixed Critical/High CVEs in the Debian 13 ffmpeg, libxml2, libtiff and openssl packages for the Phase 1 bot image. Reasons: no upstream fix exists; the container runs as uid 10001, read-only, all caps dropped, no-new-privileges, mem/pids limits, no published ports. Residual exposure: ffmpeg decodes audio that comes from Discord voice (untrusted input). Conditions: rebuild and re-scan weekly and before each release; any CVE that gets a fix is applied at once; revisit when Debian ships a fix or when the alpine option is tested. Review date: [owner to set]." Owner: [name/date].

### Notes
- `tests/acceptance/run.sh` still uses unpinned `postgres:16` (test only, outside this task's scope).
- The `.venv` is Python 3.14, so the locked deps were not installed there; the lock was resolved and installed for 3.12 inside the image build.
- The apk and apt upgrade steps are not reproducible to the day; the digests pin the base only.
