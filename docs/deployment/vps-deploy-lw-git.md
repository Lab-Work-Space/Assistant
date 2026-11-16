# VPS deploy with lw-git

How the Assistant image is built and deployed on the VPS by lw-git, and the parent infra overlay it needs.

## Deploy with lw-git

Files in `deploy/`: `Dockerfile` (multi-stage, base `node:22-alpine` pinned by digest, `npm ci --omit=dev --ignore-scripts`, non-root `node` user, `CMD node dist/main.js`), `docker-compose.yml` (overlay: `init: true` (a tiny init as PID 1 reaps the zombie node children left when a yt-dlp process group is killed), `read_only`, tmpfs `/tmp`, named volume `praw-workspace` at `/app/data/workspace/praw` for Praw's workspace (the image creates that directory owned by `node`, mode 0700, so the fresh volume inherits it), `pids_limit`, `mem_limit 512m`, `cap_drop ALL`, `no-new-privileges`, restart `unless-stopped`, node-based healthcheck, health port published on host loopback only as `127.0.0.1:${PORT}:8080`; the final image has no npm/npx/corepack/yarn), `app.conf` and `deploy.yml` (patterned on `infra/vps/files/lw-git/apps/apps-admin/`).

**Parent infra overlay.** The production compose in the parent repo (`infra/vps/files/lw-git/apps/apps-assistant/docker-compose.yml`) is a separate file and needs the same two things this overlay has: `init: true` (otherwise zombie node children of killed yt-dlp groups pile up under PID 1, and `pids_limit: 128` eventually bites) and the `praw-workspace` named volume mounted at `/app/data/workspace/praw` (from M2; without it `write_file` fails on the read-only root).

Registration is a devops step in the parent repo: copy `deploy/app.conf` to `infra/vps/files/lw-git/apps/Assistant/app.conf` (set the real `REPO` URL and deploy key), and the compose and `deploy.yml` next to it, then `lw-git` builds `lw-local/apps-assistant:<sha>` on the server and deploys on each new commit. Check with `lw-git status`.

Open points for devops to confirm on the server with `lw check-compose` / `lw validate`: the health port mapping `127.0.0.1:${PORT}:8080` satisfies the lw loopback-publish policy and `deploy.yml` `health: /healthz` probes it. Also confirm that `shared/.env` `DATABASE_URL` overrides the platform's default `DATABASE_URL`.

Migrations run automatically on every boot (the app applies `db/migrations` before it connects to Discord), so a deploy needs no separate migration step. After a deploy: `docker ps` shows the container `healthy`, and every enabled head shows online in Discord.

The media sidecar needs its own overlay steps before the first deploy: see [Media sidecar live checks](../operations/media-sidecar-live-checks.md). The cutover steps for each feature are in [Cutover to Praw (M2)](cutover/m2.md), [M3](cutover/m3.md) and [M4](cutover/m4.md).

Back to the [documentation index](../_index.md).
