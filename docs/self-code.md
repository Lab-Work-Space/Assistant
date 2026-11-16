# Self-code (dev jobs): owner guide

The system can change its own code. A Bot Admin asks in `#setting` (tool `code_propose`); a sandboxed coder, tests, two automated reviews and a card follow;
a person confirms once at the end; the executor builds and switches a release. Design: `docs/superpowers/specs/2026-11-02-self-code-design.md` and the
Gate 1 report `docs/security/2026-11-02-gate1-self-code.md` in the workspace repo (X1-X27, OD-1..OD-6).

## Who confirms what (OD-5)
- Only documentation under `docs/*.md|txt` and `README.md` is low risk. A Bot Admin confirms such a change.
- Every other path (all code, tests, config, plugins) is protected: the card is for the **owner** (`devjob.ownerUserId`, and `OWNER_USER_ID` in the executor env). If either is unset the change is refused.
- Refused outright, whatever any reviewer says: the dev-job machinery (`devjob/`, `docker/devjob/`, `docker-compose.devjob.yml`), the executor (`executor/`, `scripts/executor-*`), `health.ts`, prompt protection files, build/test config, GitHub write guards, `.github/`, `.claude/`, `CLAUDE.md`, `AGENTS.md`, and `db/migrations/` (OD-3).

## Moving parts
| Part | Where | Secret it can read |
|---|---|---|
| model proxy | container `devjob-modelproxy` | `DEVJOB_ANTHROPIC_API_KEY`, control token |
| registry proxy | container `devjob-registryproxy` | none |
| prep (npm ci --ignore-scripts) | per job, `devjob_prepnet` | none |
| agent / reviewer | per job, `devjob_agentnet` | a per-job proxy credential only |
| test/build | per job, network none | none |
| main application | owner uid | its own env; NOT the dev-job key (refused at boot); `DEVJOB_PROXY_TOKEN` for the control port |
| executor (LW Admin) | `_lwadmin` | bot token, executor DB role; refuses `DEVJOB_ANTHROPIC_API_KEY` and `GITHUB_APP_*` |

## Owner steps (nothing here has been done)
1. `npm run build`, then `bash docker/devjob/build.sh` (writes `docker/devjob/images.json`; commit it through the human process). Check with `bash docker/devjob/probe.sh` (needs Docker) and `bash docker/devjob/probe-cli.sh`.
2. Create an Anthropic Console workspace only for dev jobs (spend limit, web tools off). In the shell that runs compose, not in any env file the app reads:
   `export DEVJOB_ANTHROPIC_API_KEY=... DEVJOB_PROXY_TOKEN=$(openssl rand -hex 24) DEVJOB_MONTHLY_CAP_USD=20 DEVJOB_PRICES_JSON='{"claude-sonnet-5-5":{"inUsd":..,"outUsd":..}}'` then `docker compose -f docker-compose.devjob.yml up -d`. The monthly cap is the proxy's own setting (0 refuses everything); `devjob.budgetUsd` in the app is only the admission check. Prices must include `claude-sonnet-5-5`.
3. Main app env: `DEVJOB_PROXY_CONTROL_URL=http://127.0.0.1:8788`, `DEVJOB_PROXY_TOKEN`, `DEVJOB_SOURCE_REPO=<your repo dir>`, `DEVJOB_WORK_DIR=<private dir>`. Config (dashboard/DB, owner only): `devjob.enabled=true`, `devjob.budgetUsd`, `devjob.jobCapUsd`, `devjob.ownerUserId`.
4. Run migration 017 (the app does it at start), then re-run `executor-role.js` so the executor role gets the new grants.
5. Executor env (`/var/lwadmin/private/env.admin`): `LW_CODE_ROOT`, `OWNER_USER_ID`, `LW_CODE_TSC`, `LW_CODE_NPM`, `LW_APP_HEALTH_URL`. Ownership is checked by the executor at boot and before every check and apply, and it refuses otherwise (G2SC-02):
   `LW_CODE_ROOT` and everything under it (including `repo.git`) owned by `_lwadmin`, no group or other write bit (group read is fine so the app can read `current`); `LW_CODE_TSC` and `LW_CODE_NPM` root-owned, every parent directory root-owned and not group/other writable, and not under `/Users` (copy them to e.g. `/usr/local/lib/lwadmin-tools/`).
   **The owner never pushes into `repo.git`.** To bring commits in: `git bundle create /tmp/main.bundle main`, then `sudo bash scripts/executor-service.sh import --bundle /tmp/main.bundle`. The executor user verifies the bundle, lists the incoming commits, asks for a typed confirmation and moves `main` fast-forward only. Then `sudo bash scripts/executor-service.sh release` builds a release from the executor `main` (same build path as dev-job releases: git archive, `npm ci --ignore-scripts`, the pinned `tsc`), asks you to type `release main`, switches `current` under the apply lock, waits for the health window and rolls back if the new build is unhealthy. Use it for the first release (bootstrap) and after every `import`; the app runs from `$LW_CODE_ROOT/current` (launchd `WorkingDirectory`, KeepAlive on) and restarts itself when the executor switches `current`.
6. After an applied change, bring it back into your own repository: `sudo bash scripts/executor-service.sh export --out /tmp/executor-main.bundle`, then `git pull /tmp/executor-main.bundle main`. (`export` never overwrites: the file is created by your own uid with no-clobber, so an existing file or a planted symlink fails.) A job whose base is not the running release is refused, so keep your `main`, the executor `main` (via `import`) and the running release the same before each job.
7. `sudo bash scripts/executor-service.sh install` runs the closure report as you (not root), fails closed if it cannot run, prints what changed in the executor's import closure (and any commit by the dev-job identity `devjob@assistant.invalid`) and asks you to type a confirmation.
8. Branch protection on the default branch of every allowlisted repo, and no secrets-bearing workflow on `push`/`pull_request` from `bot/*` (X23).

## Rollback
Automatic when the new build is not healthy for a 2 minute window (serving sha = applied sha, db ok, every previously connected Discord client connected, provider ok, not halted). Manual: `code_rollback` (Bot Admin) within 24 hours. Rollback switches the `current` link back and restarts; side effects of the new build are not undone (RV-SC2). If `apply.lock` is left after a crash, check `state.json` and `current`, then remove the lock.

## Residuals and known gaps
See the report of the build (X-coverage). Not in this build: the PR path is guarded and tested (`devjob/pr.ts`) but not yet wired to a card; the closure check is a literal-specifier scanner (TypeScript 7 has no synchronous resolver API); `--max-turns` does not exist in the pinned CLI (the proxy's per-job cap, the CLI's `--max-budget-usd` and the 30 minute wall clock bound a run instead).
