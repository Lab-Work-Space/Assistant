# Wave 3 common brief (Slice A)

PROJECT: employee
PROJECT_ROOT: <PROJECT_ROOT>
TEAM_DIR: <TEAM_DIR>
STAGE: 5 Build (Slice A wave 3)

## Sources
- Plan: docs/plans/2026-11-23-phase1-plan.md (your task row is the contract).
- Spec: docs/specs/2026-11-23-phase1-spec.md. §10 (from "## 10. GATE 1 ADDENDUM") and §10.17 override earlier text. Sections with a "SUPERSEDED IN PART" banner must be read with the §10 part named. Use the file-ownership table in §3.0/§10.0 for paths (tools package is `core/agent_tools/`).
- Existing code to build on (do not rewrite): core/interfaces.py, core/config.py, core/extensions.py (`init(ctx)` pattern), core/agents/ (engine, prompt_builder, untrusted, persona), core/agent_tools/ (registry, respond), core/provider/, core/jobs/ (PgJobRunner, `ctx.jobs.add_sweep`), core/migration/ (schema `emp`).

## Shared rules
- Do not edit core/interfaces.py, core/config.py, core/extensions.py, or another task's module. If you need an additive interface change, stop and report it instead.
- DB access: use the pool on `ctx.db` (asyncpg pool). Only TASK-013A creates `core/db/pool.py` (minimal `create_pool(config)`); others accept `ctx.db` and use fakes or a throwaway Postgres in tests.
- DB tests: throwaway `docker run --rm` postgres:16, random port, in-shell passwords never written to files; apply roles like docker/postgres/init/10-roles.sh, `alembic -c core/migration/alembic.ini upgrade head` as emp_migrator, run tests as emp_app; remove container after. Use `pytest_asyncio.fixture`; run with `PYTHONPATH=. .venv/bin/python -m pytest`.
- No live LLM/API calls in tests. Do not import `discord` at module level (py-cord not in .venv).
- Do NOT read .env.local.
- Run the FULL suite once at the end and report the real summary line (baseline before wave 3: 84 passed, 8 skipped).
- Report: files, acceptance item → test name, real output, deviations, gaps. Follow your Context Loading section and the token policy.
