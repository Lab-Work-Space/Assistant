# Media sidecar local acceptance kit (plan Task 8)

Two-container acceptance of the Praw media sidecar on a local Docker host (the owner Mac). It never touches the VPS and never uses a real token or secret. The live server steps (deploy order, AC1 on the server, host-port S13 checks, AC6 in Discord, owner lines) are in docs/operations/media-sidecar-live-checks.md ("Media sidecar: deploy and live checks").

## Run

```sh
# a python3 with PyYAML (lw_check.py needs it; the VPS has python3-yaml)
python3 -m venv /tmp/lwpy && /tmp/lwpy/bin/pip install pyyaml
ACC_PYTHON=/tmp/lwpy/bin/python deploy/acceptance/run.sh
```

Options (environment): `ACC_BUILD=legacy|buildx|skip` (default `legacy`: `DOCKER_BUILDKIT=0 docker build`, what lw-git runs, native arch), `ACC_PLATFORM=linux/amd64` with `ACC_BUILD=buildx` (QEMU), `ACC_IMAGE` (kept tag, default `assistant:praw-sidecar-accept`), `ACC_SCAN=0` (skip grype/syft), `ACC_TMP` (scratch parent), `ACC_WAIT` (seconds for media to turn healthy), `ACC_LW_DIR` (default `../infra/vps/files/lw`, the `lw_check.py` and `lw_override.jq` under test).

Exit 0 only when every check passed. The log and the PASS/FAIL/SKIP list stay in `$ACC_TMP/t8acc-<id>-out/`; the scratch dir with the fake env files is deleted on exit.

## What it does

1. Builds the image and tags it `lw-local/apps-assistant:acc-<id>` (the only image name `lw_check` accepts) and `$ACC_IMAGE`.
2. Renders `deploy/docker-compose.yml` the way `lw` `compose_render_check` does: `lw_check.py descriptor`, `raw`, the user render (`docker compose config --format json --no-env-resolution`) through `lw_check.py user`, the `lw.isolated` labels and `mem_limit`s, `lw_override.jq`, then the full render through `lw_check.py compose`. The env files are a scratch `shared/.env` and db env with a planted `ZZ_MARKER` and fake secret-named keys (`BOT_TOKEN_HQ`, `GEMINI_API_KEY`, `DATABASE_URL`, `CONFIG_MASTER_KEY`, `DB_*`, ...).
3. Brings up `assistant` + `media` under the project `t8acc-<id>`, with `docker-compose.t7.yml` on top: the app needs Discord tokens and a database to boot, so `assistant` runs a stub HTTP listener on `0.0.0.0:8080` instead (it keeps all of lw's env, the read-only `media-ipc` mount and the `/opt` masks). The script asserts that the merged `media` service is identical with and without that layer.
4. `check.sh live`: AC1 (no marker or secret key in any `/proc/*/environ` of `media`, with the assistant as positive control; `ls /proc`; `docker inspect` env allowlisted), AC4/S1 (uid 1000 connects over the read-only mount; socket mode; `/opt/ffmpeg` and `/opt/yt-dlp` empty noexec tmpfs and unusable in `assistant`), S5 (networks), S8 (`FAKE_YTDLP_HANG=1` exits 78; no `tests/` in the image), S9 (the committed `voice/fixtures/ffmpeg-smoke/t.mp3` decodes over `/v1/decode`; WAV and HLS refused), S12 (`ps` sampled in both containers during a real track: `media` runs yt-dlp/ffmpeg, `assistant` never does), the local kill timing after the client closes, S13 local parts (`media` cannot reach `assistant:8080`, which is listening; outbound HTTPS works), and the app-level media selection (container without `MEDIA_SOCKET`: music and voice off).
5. `check.sh unpatched` (AC2): `lw_override.jq` with no labels (an `lw` without isolated mode) plus `docker-compose.t7-unpatched.yml` (`restart: "no"`, absolute `${T7_ENV}` env file). The patched `lw_check.py compose` must refuse that render, and `media` started from it must exit 78 and log the key name `ZZ_MARKER` (never a value).
6. `scan.sh` (AC3/S10): grype and syft `anchore/syft:v1.55.0` (on a `docker save` archive, no docker socket in the scanner). It fails on a glib/cjson/alsa-lib or ffmpeg 8.x row, on any High/Critical other than the owner-accepted CVE-2026-107696, and on any Medium-or-higher CVE outside the residual allowlist (CVE-2026-107696, CVE-2025-60876, CVE-2025-15367, CVE-2026-103995). `scan.sh --check-grype FILE` runs only that verdict on a saved `grype -o json` (the unit tests use `fixtures/grype-*.json`).
7. Teardown: only the containers, networks and volumes labelled with this run's compose project or run id, and the run tag. It never prunes and never removes other images or volumes.

Host-port S13 checks (`172.30.0.1:443/4231/22`) are VPS-only: Docker Desktop has no host firewall.

## Known local limits

- **amd64 under Docker Desktop (Rosetta).** `ACC_BUILD=buildx ACC_PLATFORM=linux/amd64` builds and scans fine, but under Rosetta node adds `UV_USE_IO_URING` to its own `process.env` at start, so `media` correctly refuses with 78 and the two-container part cannot run. Native amd64 (the VPS) is checked by the live runbook; locally run the reduced set by hand (`-version`, manifest, smoke, S8, `scan.sh`).
- **assistant:8080 from media (S13).** Docker Engine 29.9.2 (tested here; the VPS runs current docker-ce, so expect the same) accepts traffic to a container's *published* port from any network that can route to the container IP, including other bridge networks; only unpublished ports stay isolated. The kit shows `media` reaching `assistant`'s published `8080` and not its unpublished `8081`. The drop is the `lw_filter` forward-chain rule in `infra/vps/13-firewall.sh` (ruling S13-fwd), which Docker Desktop does not have, so the kit reports this check as SKIP (VPS-only) with the local result, and `infra/vps/tests/p4-platform-check.sh` gives the VPS verdict.
