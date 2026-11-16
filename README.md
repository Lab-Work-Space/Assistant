# Assistant: Discord AI Company Core

A Node 22 / TypeScript service that runs an AI "company" inside one Discord server: 9 department head bots (one Discord application each, hq/CEO, rnd, software, it, marketing, sales, hr, finance, ops) plus webhook personas (members) that speak under their own name and avatar. Heads delegate tasks to each other and to personas, every task gets a thread, budgets and limits are enforced before each LLM call, and an admin can change configuration live with slash commands. State lives in PostgreSQL. The service only makes outbound connections (Discord, Anthropic, PostgreSQL) and publishes no port.

Design and decisions: `docs/superpowers/specs/2026-10-31-discord-ai-company-core-design.md` (parent repo). Security review: `docs/security/2026-10-31-gate1-discord-ai-company-core.md` (rows D1 to D24).

## Local development

```bash
npm ci                   # .npmrc sets ignore-scripts=true: msedge-tts has a `preinstall: npx only-allow pnpm` that would fetch an unpinned package; no dependency needs install scripts (davey and opusscript ship prebuilt binaries / WebAssembly)
npm test                 # unit suite (fake provider, no network)
npm run test:int         # integration suite, needs PostgreSQL: docker compose -f docker-compose.test.yml up -d
npm run build            # tsconfig.build.json (no tests in dist) + copies db/migrations and prompts into dist/
```

## Local mode (owner's Mac)

Local mode runs the whole service on the owner's Mac. The `claude-code-local` provider spawns the owner's logged-in `claude` CLI (subscription, no API key) with tools, MCP, slash commands and setting sources disabled. It exists only on macOS: the guard refuses to register it in a container, on Linux, or when `ALLOW_LOCAL_PROVIDERS=1` is missing from the real process environment. Design: `docs/superpowers/specs/` (parent repo, §4-5) and `docs/security/2026-10-31-gate1-assistant-local-mode.md` (rows L1 to L14).

### Env file location

All local secrets live in **`~/.config/assistant/env.local`** (directory mode 0700, file mode 0600, owned by you, not a symlink). The launcher refuses to start if any of these is wrong. Do not keep it under `~/Desktop`, `~/Documents` or any iCloud Drive folder: with "Desktop & Documents Folders" turned on, macOS syncs those to iCloud, which would copy your bot tokens and master key to Apple's servers and to your other devices. It is also never inside the repo, so it cannot be committed (`.env*` and `.env.local` are git-ignored as a second line of defence).

`ALLOW_LOCAL_PROVIDERS` is **never** written to that file. `npm run dev` sets it for the node child process only, and the guard refuses to enable the provider if any env file defines it.

**Turning the local provider off (use the Claude API instead).** `touch ~/.config/assistant/local-provider-off`, then restart (`npm run dev` / the launchd job). `scripts/dev.sh` then sets `ASSISTANT_LOCAL_PROVIDER_OFF=1` for the node child only: `claude-code-local` does not register (no `claude` spawn, no refusal incident, no subscription use), while local mode itself (Chrome web tools, dashboard) stays on. Set `provider.default` to a `claude` model first (it is not changed for you; with the marker on and no stored default the code default `claude/claude-sonnet-5-5` applies). To turn it back on: `rm ~/.config/assistant/local-provider-off` and restart. Any profile or override still pinned to `claude-code-local` shows "Unavailable" until repointed.

### Setup (once)

```bash
npm ci
bash scripts/set-tokens.sh --local        # or: npm run tokens:local
```

The script asks for each bot token (hidden input; Enter skips a key and keeps the one already stored), then creates the dir/file with `umask 077` and replaces the file atomically. If missing it also generates `CONFIG_MASTER_KEY`, a database password and the local `DATABASE_URL` (`127.0.0.1:54330`), and never prints them. It does not ask for `ANTHROPIC_API_KEY`: local mode does not use one. It does ask for `GEMINI_API_KEY` (Praw's provider; full run or when `PRAW` is named). Run `bash scripts/set-tokens.sh --local HQ` to change a single department.

Then the **probe step** (Gate 1 L3), once per Mac and again after every `claude` upgrade:

```bash
claude                                    # make sure you are logged in
bash scripts/probe-local-cli.sh           # or: npm run probe:local
```

Read the warning first: the probe **spends one subscription call**, and you should **close all other Claude Code sessions** while it runs (about a minute). It plants canary strings in your real `~/.claude` (CLAUDE.md, a memory file, a user hook in `settings.json`, and a skill, command and agent standing in for a plugin; real plugins load through settings, which the hook canary covers), runs the exact argv the provider uses, and passes only if no canary shows up in the output, the hook did not run, no tool ran, the CLI made no web request (a local loopback server is offered as a WebFetch target), no new session transcript (`*.jsonl`) appeared under `~/.claude/projects`, and the provider's own parser accepts the real `stream-json` output (the init event must show only the structured-output tool, no MCP server and no probe-planted name). It prints the CLI version, the event types and the result field names, never the CLI's own output or stderr. It removes only what it added, on every exit path; edits you make to `CLAUDE.md` or `settings.json` meanwhile are kept, a lock stops two runs at once, and after a hard kill the next run recovers first. The argv it runs includes `--safe-mode` (added 2026-11-07, because CLI 2.1.319 injected auto-memory without it), and `buildArgs` is the same function the provider uses, so the probe tests that flag. `--also-restricted` adds one more call with `--restricted`, to see whether it would fix a failure (the default run is a single call). `--also-safe-mode` is no longer needed: `--safe-mode` is already in the argv.

**Version pin (R-L9).** On PASS the probe writes `~/.config/assistant/probe-ok` (mode 0600) recording `version=<claude --version>`, `realpath=` (the resolved `claude` binary) and `sha256=` (of that file) and `argv_sha256=` (STREAM-1: a digest of the provider's fixed CLI arguments, so any change to them needs a new probe). The service registers the local provider only while that file is owner-only and all four match the `claude` found on PATH now, so a different binary printing the same version is refused; an old pin without `argv_sha256` is refused too (run `npm run build`, then `bash scripts/probe-local-cli.sh --yes`, then restart). After a CLI upgrade or reinstall the provider is absent until you re-run the probe. The owner can override with `ASSISTANT_SKIP_PROBE_PIN=1 npm run dev` typed on the command line (a warning is logged); it is refused if it appears in the env file. If the probe fails, do not use local mode; send the output (it names the canaries, not your data) so `--restricted` can be evaluated.

**Loopback only (L10).** In local mode `DATABASE_URL` must point at `127.0.0.1`, `::1` or `localhost`, (including any `host=`/`hostaddr=` query parameter; socket paths are refused), and `HEALTH_HOST` (if set) at exactly `127.0.0.1`; the launcher and the service both refuse otherwise.

### Run

```bash
npm run local:db     # PostgreSQL 17 on 127.0.0.1:54330, compose project assistant-local, volume assistant_local_pgdata (docker-compose.local.yml)
npm run local:chrome # Chrome + guard proxy containers (docker-compose.chrome.yml, compose project assistant-chrome); see "Chrome for the web tools"
npm run local:media  # media sidecar container and host relay (docker-compose.media.yml); see "Media and renderer containers"
npm run local:render # document renderer and its DevTools forwarder (docker-compose.render.yml); see "Media and renderer containers"
npm run dev          # checks the env file, builds, starts node --env-file=~/.config/assistant/env.local dist/main.js
```

Start in this order: `local:db`, `local:chrome`, `local:media`, `local:render`, then `dev`. Without the Chrome container the web tools are off, and without the renderer the document tools are off; `#🧾-bot-log` says why.

On the first boot where the local provider is available and no default was ever set, the default becomes `claude-code-local` with `local/claude-sonnet-5-5`. Migrations run on boot. The service logs nothing special when the local provider registers; if it does not, the log has `claude-code-local not registered` with a reason (flag, platform, probe pin, loopback check), and with no `ANTHROPIC_API_KEY` the service stays up but idle (a governance alert in `#🧾-bot-log`, `/healthz` reports `provider: "unavailable"`, no agent runs) until a provider registers or `provider.default` is changed. Confirm with `/provider` in `#⚙️-setting` and check that the heads come online in Discord.

### Chrome for the web tools

In local mode `web_search`, `fetch_page` and url/topic watches read the web through **headless Chrome only** (no HTTP fallback). Chrome never runs as your user and never sees your env file: it runs in a container (Gate 1 Part C, `docs/security/2026-11-01-gate1-praw-admin-console.md`; details in `docker/chrome/README.md`).

**`web_search` open-source fallback (SEARCH-1).** When DuckDuckGo refuses the bot (bot check) or returns nothing, `web_search` falls back to Wikipedia (en, and th for Thai queries), Hacker News, Stack Overflow, npm and GitHub, with no API key, over the same web path (Chrome in local mode). `web.search.openSources` is **on by default** (owner decision, Gate 1 SR-C9/SR-C10): one approved query can therefore be sent to up to **6 third parties** (DuckDuckGo plus 5 operators; the approval reason says so). Set `/settings web.search.openSources false` to get the old DuckDuckGo-only behaviour; the key is read on every call. The optional `source` input searches one open source only (and is refused while the switch is off).

```bash
npm run local:chrome        # builds the proxy image from dist/, starts both containers, waits until healthy (no env file is read or passed)
npm run chrome:smoke        # optional probe: one search, one page, and the refusals (loopback, 169.254.169.254, a name that resolves to loopback)
npm run local:chrome:down
```

Start it **before** `npm run dev`. `npm run dev` sets `CHROME_CDP_URL=http://127.0.0.1:9222` and `CHROME_PROXY_CONTROL_URL=http://127.0.0.1:9223` for the node child only. If Chrome or the proxy does not answer at boot (or Chrome is older than `CHROME_MIN_VERSION`, default: the pinned build 157.0.8103.27; the env can raise it, never lower it), the `web` tool group is off and the startup alert in `#🧾-bot-log` says why; start the containers and restart the app. The VPS is unchanged: without `CHROME_CDP_URL` the web group keeps the guarded HTTP fetch.

Chrome's image is pinned by digest in `docker-compose.chrome.yml` (`chromedp/headless-shell`, Chromium 157 at pin time). Bump the digest with each Chrome security release, then `npm run local:chrome`.

### Media and renderer containers

- **Renderer (`npm run local:render`):** draws `doc_create` PDFs and `diagram_create` pictures. It is Chrome with no route to any network, behind a forwarder on `127.0.0.1:9224` that needs a per-boot token. The token is never written to a file. The Mermaid bundle is `vendor/mermaid/mermaid.min.js`, checked against `vendor/mermaid/SHA256SUMS` before each draw. Diagrams live in memory per task (at most 20 per task) and are lost on restart. Diagrams need no approval; documents follow their kind's rules (money, tax and offer documents are watermarked DRAFT and always need approval).
- **Media (`npm run local:media`):** a secret-free container for yt-dlp and ffmpeg (music and voice), reached from the app through `~/.config/assistant/media/media.sock`. The production sidecar on the VPS is a separate path.
- **Images (`image_generate`):** on `gemini-nano-banana-2.1`, for the departments that hold the `marketing`, `innovation` or `assistance` duty (Praw holds `assistance`). Every image needs an approval card that shows the whole prompt and the cost. A fixed "no real person" instruction is appended in code, but the provider has no person control, so generic people may still appear (accepted by the owner, OD-5i). Caps: 20 images a day for the company and 5 per person (`media.imagesPerDay`, `media.imagesPerPersonPerDay`). A call reserves at most $0.064512 (`maxOutputTokens` 2048 at the default prices) and is settled from usage. Stored `tools.byDept` lists must include the media grants (migration `024_media`). **Video is off** (OD-5): `video_generate` is not registered. Before release the images must pass the live checks L1 to L6 in `docs/security/2026-11-07-gate2-rfmd-p5.md`.

### After a Docker reset: restore list

On 2026-11-07 a reboot reset the Docker data. The local database volume `assistant_local_pgdata` was recreated empty, so every `/settings` value was lost, and there is no backup. Re-set these after a reset (the code default is in brackets): `approvals.channelByCategory` (`{}`), `rhythm.dailyGoalChannelId` (`null`), `dashboard.channelId` (`null`), `schedule.offDays` (`[0, 6]`), `company.profile` (`null`), `roles.managerId`, `roles.moderatorId` and `roles.modRoomId` (`null`). Channel maps live in the `channel_map` table, not in config: re-add the Praw appointments room with `/channel map channel:#📅-appointments dept:praw work:true`. With no stored `tools.byDept` override the code defaults apply, which already include the media grants.

Backups: `npm run dev` dumps the local database to `~/.config/assistant/backups/assistant-<date>.dump` before it starts (skipped when a dump younger than 6 hours exists; newest 14 kept; files 0600). Take one by hand with `bash scripts/dev.sh db backup`. To restore after a reset, stop the app, start the database with `npm run local:db`, then run `docker exec -i assistant-local-postgres-1 pg_restore -U assistant -d assistant --clean --if-exists < ~/.config/assistant/backups/<file>.dump` and start the app again.

### Stop

`Ctrl-C` in the `npm run dev` terminal: the service stops gracefully on SIGINT (tasks that were `doing` are recovered on the next start). Optional: `/halt` in `#⚙️-setting` first. `npm run local:chrome:down` stops Chrome. `npm run local:media:down` and `npm run local:render:down` stop the media and renderer containers. `npm run local:db:down` stops the database (compose project `assistant-local`, separate from `docker-compose.test.yml`); the volume `assistant_local_pgdata` keeps the data (`docker volume rm assistant_local_pgdata` deletes it).

### Why the ws_* write tools need no approval (Gate 1 WS-C18)

The project workspace tools that write (`ws_write`, `ws_run` and the other ws_* write tools) are in `NO_APPROVAL_TOOLS` on purpose. Their writes stay inside the sandbox: files under the per-project workspace root (no-follow I/O, quotas), and commands that run in a hardened per-run container with no secrets, `--network none` (or only the registry proxy for `npm ci` and `npm install`). Nothing outward-facing happens inside a ws_* write. Anything that leaves the sandbox still goes through an existing gate: the zip export posts into the company's own Discord, and a GitHub push uses the existing approved tools. Untrusted-content taint still applies to ws_* outputs, so a tainted file or command output cannot be used to unlock an approval-gated action.

### Adding a tool/plugin (R4 PLUGIN-MANIFEST)

Every tool declares its class (kind, sensitivity, approval, department limit, tree grant, autopilot, AI review) in a checked-in manifest. The lists that used to be literals (`TREE_GRANT_TOOLS`, `NO_APPROVAL_TOOLS`, `BOT_TALK_TOOLS`, `AUTOPILOT_OWN_WAIVE`, `AUTOPILOT_ALWAYS_CARD`, `MONEY_DOC_TOOLS`, `COST_OR_LASTING_TOOLS`, `DEPT_ONLY`) are frozen views of the manifests. A name nobody declared is fail-closed: sensitive, always a card, hard-denied by the AI reviewer. Steps for a new plugin `x`:

1. Make the folder `tools/plugins/x/` with `index.ts` (the factory, group id `x`) and `manifest.ts` (`defineManifest('x', { x_read: { ...READ, sensitive: false }, x_write: { ...WRITE, sensitive: false } })`). A manifest imports only `tools/manifest/types.js`. `sensitive` is required in every entry; `sensitive: false` is a reviewed grant, so use `true` unless the tool must be batchable, skill-grantable and AI-judgeable.
2. Add one line in `pluginGroups` (`tools/plugins/index.ts`) and one line in `tools/manifest/catalog.ts` (import the manifest, add it to the `buildCatalog([...])` list). A completeness test names whichever line is missing; boot refuses a tool whose manifest entry is missing, or whose group or kind differs from what it registers.
3. Only when an entry is not a plain preset (a `treeGrant`, `no_approval` or `bot_talk` approval, `own_waive` or `always_card` autopilot, `money_doc` or `cost_or_lasting` AI review, or a `deptOnly`), also edit `tools/manifest/privileged.json` in the same diff. A test compares every derived list with that file, and `sensitive: false` entries are listed in its `sensitiveFalse`. The manifests, the goldens and `privileged.json` are protected from bot self-modification (`devjob/paths.ts`), so a human reviews that diff.
4. Optional: a new dependency is one `PluginDeps` field (`tools/plugins/deps.ts`) plus its wiring next to `registerGroups` in `app.ts`.
5. Optional and deliberate: grant the tool to a department in `tools.byDept` (`config/defaults.ts`, or the settings panel). A new tool is never granted automatically.

If a decision golden changes on purpose, regenerate it with `GOLDEN_UPDATE=1 npx vitest run <file>` (refused when `CI`, `DEVJOB` or `DEVJOB_SANDBOX` is set; the run fails after writing so you read the diff). The files are `tools/__golden__/autopilot-classes.json` and `tools/__golden__/decision-matrix.json`. The catalog digest (`CATALOG_DIGEST`) changes with any declared class.

### Adding an MCP server (R6 MCP-1, `docs/superpowers/specs/2026-11-12-mcp-client-design.md`, Gate 1 `docs/security/2026-11-12-gate1-mcp.md`)

A Bot Admin can allow a Docker-packaged MCP server. The bot starts one fresh container per call (and per check) with no network, no mounts, no secrets, a read-only root, all capabilities dropped, 512 MB and 64 processes, and removes it after the call. This limits damage; it is not a boundary, because the app user can reach the Docker socket (WS-1 OD-1). Owner steps, in this order:

1. Get the image onto this host yourself (`docker pull` or `docker build`). The bot never pulls: a missing image fails with a fixed error.
2. Read its id: `docker image inspect --format '{{.Id}}' <image>`. It prints `sha256:` and 64 hex characters. `/mcp add` takes that id, never a tag. The image must not declare a `VOLUME` (refused with E_IMAGE).
3. Switch the feature on: `/settings` key `mcp.enabled` (default off; the daily and per-task call caps `mcp.maxCallsPerDay` and `mcp.maxCallsPerTree` are changed in psql). While it is off, no external tool exists and the bot itself makes no Docker call; only the Bot Admin's `/mcp add`, `/mcp approve` and `/mcp test` start a probe container (they work while it is off so you can prepare; each probe first runs the same seccomp check as the boot and refuses with `E_SECCOMP`, starting nothing, when `docker info` shows no seccomp or an unconfined one). A server whose image was missing at boot stays out until you run `/mcp test` on it (success loads it again), re-approve it, or restart. Turning it on at run time starts the boot checks (Docker version, sandbox settings, sweep of stray `label=mcp=1` containers) without a restart.
4. In `#⚙️-setting` as a Bot Admin: `/mcp add slug:<a-z0-9, 2-16> image:<id> departments:<csv> title:<text> class:<read|write>` (optional `command`, `env`, `timeout`, `daily`, `ref`). The bot runs the server once in the sandbox and replies with the show view: the tool names, the descriptions the server wrote (shown escaped, untrusted), the class, the departments and two short hashes. Read it in full. A tool description goes into the prompt of every department that is granted the server.
5. `/mcp approve slug:<slug> hash:<the hash from the show view>`. The bot re-checks the live tool list against what you read and activates the server only if it is identical. `/mcp show` repeats the view at any time.
6. `/mcp depts slug:<slug> departments:<csv>` changes which departments may use it. `/mcp test slug:<slug>` re-checks the live list against the approved one. `/mcp disable slug:<slug>` switches the server off at once (allowed even while halted) and expires its open approval cards. `/mcp list` shows all servers.

Before every call the bot lists the server's tools again. If the list changed in any way, it sends no call, quarantines the server, expires its open approvals and posts one notice to #🧾-bot-log; a Bot Admin has to run `/mcp add` and `/mcp approve` again.

The same applies to the stored configuration: approve pins a hash of the image id, command, env, class, departments and tool-list hash (`mcp_servers.approved_config_sha256`). At load and before every call the bot recomputes it; a row edited directly in the database (image, command, env, class or a department grant) is not loaded, nothing is started, and the server is quarantined (`config_changed`) with one notice. `/mcp depts` is the supported way to change grants and rewrites the pin; it refuses a row that was edited behind the approval. Re-add and re-approve to recover.

v1 limits: stdio servers only (no HTTP or SSE); no network for the container (`--network none`); no secrets, no mounts and no volumes (an `env` entry cannot be a token, key or password name, nor hold a secret-like value); at most 8 servers and 32 tools each; no bot can add, approve or change a server (only the Bot Admin commands can). Class `read` tools run without a card; class `write` tools always need a human approval card, even in a direct chat and inside autopilot. Every result is untrusted text: it taints the run, and it never writes memory, knowledge, lessons or skills by itself. Tools are named `mcp_r_<slug>_<tool>` (read) and `mcp_w_<slug>_<tool>` (write). The protocol version the client sends (`2025-11-25`) has not been probed against a public server image yet.

Tests: `mcp/docker.int.test.ts` builds the repo's own fixture server (`docker/mcp/fixture.Dockerfile`, `docker build --pull=false` on the local `node:22-alpine`) and runs the add, approve and call path, the no-network proof, the quarantine path, timeout and OOM against the real Docker daemon. It is skipped, with a stated reason, when Docker or that base image is missing, and it pulls nothing.

### Plugin forge (R7 PLUGIN-FORGE, `docs/superpowers/specs/2026-11-13-plugin-forge-design.md`, Gate 1 `docs/security/2026-11-13-gate1-forge.md`)

Bots can build their own tools. A tool idea (`tool_idea`) becomes a project, the software head writes a small Node plugin in a workspace, and the code (never a model) builds a Docker image from those exact bytes and stages it as an MCP server. A plugin is plain JavaScript on Node built-ins (no runtime dependencies), runs through the R6 sandbox (no network, no secrets, read-only disk, user 65534) and is class `write`: every call asks a Bot Admin. The feature ships **off**. Three human steps stay with you, and no bot path reaches any of them:

1. **Project card, Approve**: "do the work" (the existing project card).
2. **Release card, Approve**: "build and stage". Code then builds the image (up to 180 s) and stages a `pending` server; nothing is installed yet.
3. **`/mcp show slug:<slug>`, then `/mcp approve slug:<slug> hash:<hash>`**: "install". You see the tool list the built server really reports, and the same live re-probe and config pin as any R6 server.

Owner steps, in this order:

1. **Build the base image once**: `bash docker/forge/build.sh` from the repo root. It needs the network (it pulls the pinned `node:24-alpine` digest and runs `apk upgrade`, so do it yourself; the app never pulls or builds). It builds `docker/forge/base.Dockerfile` (Node only: npm, npx, corepack and yarn are removed; no `VOLUME`, `USER` or `ENTRYPOINT`), tags it `assistant-forge-base:local` and writes the image id to **`docker/forge/images.json`** as `{"base":"sha256:<64 hex>"}`. That file is the pin: only `build.sh` writes it, the app reads it once at boot and checks the id against the daemon, and a plugin cannot choose another base. Commit it. After a rebuild, restart the service (a changed file takes effect only then). Do not untag or remove `assistant-forge-base:local`. The forge removes plugin images with `docker image rm --no-prune <id>` (never `-f`): `--no-prune` stops Docker from also deleting an untagged parent, so a lost tag can no longer take the base with it (G2-FG-01), but the base must still stay tagged so that builds can find it. The removal is proved by a listing of the forge-labelled images that must exit 0 (a daemon outage never counts as removed), and the forge runs only while the staging user is not uid or gid 65534 (the plugin runtime user).
2. **Scan the base image (PF-C23, not done by the code)**: scan `assistant-forge-base:local` with a binary-aware scanner (trivy or grype), first proving it with a positive control (an image that is known to carry a HIGH or CRITICAL finding must be reported). Any unpatched HIGH or CRITICAL: do not switch the forge on. Also check that `docker run --rm --entrypoint /bin/sh assistant-forge-base:local -c 'command -v npm npx corepack yarn'` prints nothing. The repo does not install or download a scanner, and the BE3 acceptance run did not scan (no scanner is installed on the dev host; running a public scanner image would pull code).
3. **Switch on, in this order** (each is a `/settings` key; read errors count as off everywhere): `autopilot.enabled` (default on; projects), `ws.enabled` (default off; the workspace the plugin is written in), `release.enabled` (default on; the release card), `mcp.enabled` (default off; **calls** of an installed plugin need it, while building, staging and `/mcp approve` work with it off), then `forge.enabled` (default off; false to true is flagged as a risky change). A forge request needs `forge.enabled`, `release.enabled` and `ws.enabled`; a build needs `forge.enabled`. Switching `forge.enabled` off stops new requests and builds at the next step boundary.
4. Run the flow above. Caps: 3 forges in progress, 3 builds per forge, 3 builds per local day, one build at a time, 8 kept plugin images (each at most 8 MiB over the base), a queued build lives 7 days. A halt or the switch going off requeues a running build **and gives the attempt back**; a crash or restart does not (after 3 attempts the build is `failed:interrupted`).

**Cancel**: `/forge list`, `/forge show id:<n>` and `/forge cancel id:<n>` (Bot Admin, `#⚙️-setting`). Cancel ends the forge and its queued builds; it is refused while a build is running (try again in a minute). **Switch off with a stale build (G2-FG-11):** the boot recover that requeues the `building` rows a crash left runs only while `forge.enabled` is on, so such a row would answer `busy` for as long as the switch stays off. With the switch off (or unreadable) and no build running, `/forge cancel` therefore requeues a stale `building` row that holds no image, as a crash would (no refund, no Docker call), and then cancels. A stale row that already holds an image still answers `busy`: removing that image needs Docker, so switch `forge.enabled` on once and let the recover run (it removes the image and requeues the row), then cancel. A release card whose forge was cancelled meanwhile is refused at Approve with `not_forge` (the card stays pending: reject it). A server that is already staged or active is not touched: use `/mcp disable slug:<slug>`. There is no command to build, retry or delete an image.

**Remove a plugin**: `/mcp disable slug:<slug>` switches it off at once and expires its open approval cards. The image is then removed by the forge GC (every 10 minutes, `docker image rm` without `-f`) 7 days after the server was disabled, never while a pending, active or quarantined server uses it; the image of a failed build is removed at once, and a staged build whose server never appeared after 1 hour. The slug can be used again only by a retry of the same forge. Updating an installed plugin is not supported in v1.

What the build does (fixed in `forge/builder.ts`, argv golden-tested): `docker create --pull=never --network none` on the base id, `docker cp` of the shipped files into `/srv/plugin`, `docker commit` with `USER 65534:65534`, `ENTRYPOINT ["node","/srv/plugin/server.mjs"]` and three `assistant.forge*` labels, then a check that the image is the base plus exactly one layer with only those config fields changed. It never runs, starts, builds or pulls anything.

Probed on the real daemon (BE3, Docker Desktop 29, containerd image store; `forge/docker.int.test.ts`): `docker cp` into a never-started container works; `commit --change` writes exactly User, WorkingDir, Entrypoint, Env and the labels, drops `Cmd` and `ArgsEscaped`, and copies Docker Desktop's `desktop.docker.io/ports.scheme=v2` label into the image (tolerated by exact key and value); it does not write `Hostname` or `Image`. The new layer holds only `srv/plugin/**` (plus the `srv` parent when the base has no `/srv/plugin`), regular files and directories, modes 0644 and 0755, no special bits. **Ownership differs from the Gate 1 expectation**: Docker Desktop keeps the owner of the host files (the service user's uid and gid) instead of `0:0`. That is harmless here (the runtime user only reads, the root is read-only) and the test accepts exactly `0` or the staging uid/gid. `docker cp` also stamps the mode of the copied directory on `/srv/plugin`, so the builder copies a 0755 child of its private 0700 stage directory.

Tests: `forge/docker.int.test.ts` builds the `hello` fixture (`tests/fixtures/forge/hello/`, which has a `netprobe` tool) through the real builder and the real `McpAdmin.stageRelease` probe, checks layers, config and the saved layer (`docker save`), proves `--network none` (the connect to 1.1.1.1:53 is blocked), checks the hash chain, GC and cleanup on the real daemon. It uses the ws runner image from `docker/ws/images.json` as a stand-in base (a metadata-only child with `CMD ["node"]`, built with `--pull=false` from an empty context, because the runner has no CMD and `docker create` refuses it). It pulls nothing, removes only objects it created (by exact id or name), and is skipped, with a stated reason, when Docker or that image is missing.

### Quotas

Local calls cost USD 0 and are counted instead. With `limits.localUnlimited` on (the default, `config/defaults.ts:58`), the caps that the code lists in `LIFTED_CAPS` (`governance/budget.ts`) are counted but not refused for a local call: `limits.localCallsPerDay` (200), `limits.localCallsPerTask` (40, the per-task-tree cap), `limits.turnsPerTask` and the warroom and meeting counts. Turning `localUnlimited` off makes them strict again (the daily cap is then `limits.localCallsPerDay`, and over the per-task cap an approval is requested; it can overshoot by at most the in-flight calls, up to `limits.localConcurrency`). Always enforced: `limits.localConcurrency` 2 parallel CLI processes, a wait queue of 20 (`MAX_QUEUE`, `providers/claude-code-local/index.ts`), `provider.localTimeoutMs` 120000. A subscription has its own rate limits on top; when they hit, calls fail with a provider error and the affected task is blocked (see the Operations section). `limits.localConcurrency` and `provider.localTimeoutMs` are read once at boot (restart the service after changing them); the other limits change live with `/limits` and `/budget`. A local call that belongs to no task (taskless) is covered only by the daily cap, not by a per-task-tree cap; with `localUnlimited` on, that daily cap is counted, not enforced.

**Spend trends and department budgets (SPEND-1).** Every metered call is also rolled up per local day (`schedule.timezone`), department, provider, model, tool and task tree in `spend_days` (written in the same transaction as the budget settle: if the rollup fails the settle fails and the meter stops, fail closed). A department can have a monthly cap (`/budget dept dept:<d> usd:<n>` or `clear:true`, or `/settings set spend.deptMonthlyUsd <dept> <usd|none>`): a metered call that would pass it is refused and a card in #⚙️-setting offers a Bot Admin one raise for that month (step `spend.overrideStepPct`, pending until `approval.expiryHours` or month end, never decreases, lapses at month end); a human cap change ends that month's raises. Local (claude-code-local) calls are not limited by a department budget. `/usage range:trend by:dept|provider|tool` shows 7d/30d/MTD with the previous period, a 14-day sparkline and the projected month end; the dashboard `/spend` page shows the same read only. A 60 s model-free watch posts to #🧾-bot-log: warn at `spend.warnPct`, an unusual-day alert, a projection that passes the cap, and a weekly summary (`spend.weeklySummary`, `spend.weeklySummaryTime`, workdays). No model can reach any `spend.*` key or decide an override; `/usage today|week` stay UTC days, trends and budgets use the schedule time zone. Devjob spend is outside this meter.

## Before moving to the VPS

1. **Stop local first** (`Ctrl-C`, `npm run local:db:down`). Never run local and the VPS at the same time with the same bot tokens: a second gateway session on the same token means both copies see and answer every message. Never keep the same tokens in two places: after the move, delete `~/.config/assistant/env.local` (or at least its `BOT_TOKEN_*` lines), or rotate the tokens.
2. **The VPS needs `ANTHROPIC_API_KEY`.** The local provider does not exist there (no `claude` login, no `ALLOW_LOCAL_PROVIDERS`), so without an API key the service has no provider: it boots idle (alert, health `unavailable`) and the bots do nothing. Activation still requires `ANTHROPIC_API_KEY`. Set the key first (`bash scripts/set-tokens.sh` without `--local`), verify `lw env keys apps/assistant` lists it, and only then activate.
3. Data in the local database does not move by itself. Dump and restore it (`pg_dump`/`psql`) if you want to keep it, or start the VPS fresh.

## Data note

Every message the bots see from guild members is sent to Anthropic through **your consumer account**. Its data and training settings apply (check Settings > Privacy in Claude and turn model-improvement off if you do not want chats used for training). Also confirm that the subscription terms allow an automated multi-user bot like this one; if they do not, use the API key (VPS mode) instead. Re-run the probe after every CLI upgrade (Gate 1 L11).

## Running next to Discord_bot (Gemini assistant)

The Gemini `Discord_bot` has GitHub write tools and reads channel history through MCP, so it must not share the server with Assistant until the owner has done these steps (Gate 1 L12 to L14). They are server and GitHub settings, not code, and they are not enforced by this repo.

- **L12, role allowlist.** Give Discord_bot a dedicated role with View Channel only on its own channels. Deny View Channel on `#🔑-system-credentials`, `#moderator-only` and every company/department channel (its chat history is reachable through MCP). No Administrator, no Manage *, no Mention Everyone, no Server Members intent unless its welcome cog needs it. Set the application to Private; use Integrations to restrict its slash commands and AI to a role. Check: the channel list visible to its account contains none of the denied ids.
- **L13, GitHub App.** Before inviting it, install its GitHub App on **selected repositories only**, excluding `Lab-Work-Space/Assistant`, the infra repo and every lw-git deploy source (lw-git deploys `Assistant` `main` to the VPS, so a write there is code on the VPS). Branch protection is **not available** on the free private org (the API returns HTTP 403), so the repo selection is the only control: if you cannot guarantee the exclusion, set `PLUGINS_DISABLED=github` for Discord_bot instead.
- **L14, Team MCP and stored state.** Keep Team MCP disabled: its port is not published and `lsof -iTCP -sTCP:LISTEN` shows no MCP port. If it is ever enabled, bind it to 127.0.0.1 with auth. Restrict its "lessons" store (self-written guardrails) and its watches (URLs chosen by users, an injection and SSRF risk) to admins.

## If the Mac is lost or compromised (D22)

Treat everything in `~/.config/assistant/env.local` as leaked. In order: reset **all 9 bot tokens** in the Developer Portal (Bot > Reset Token); revoke the Claude login (claude.ai > Settings, log out all sessions) and rotate the Claude account password; remove the Mac from your Apple/GitHub/Discord sessions; then set the new tokens wherever the service runs next (`set-tokens.sh`). The database and `CONFIG_MASTER_KEY` on the Mac held only local data; stored provider keys (`/provider add`) must be re-issued at the provider.

## Owner setup checklist (manual, once)

These steps are done by the owner in the Discord Developer Portal, the Discord server and on the VPS. They are not automated.

### 1. Discord applications (9, one per department)

1. Create 9 applications in the Developer Portal and a bot user for each.
2. Intents: enable only **Guilds** (non-privileged, always on), **Guild Messages** (non-privileged) and **Message Content** (privileged toggle). Do NOT enable Server Members or Presence, and no voice intents in Core (Gate 1 D19; this overrides the older note in spec §16).
3. Set every application to **Private** (turn Public Bot off) and do not require a code grant.
4. Invite each bot with the `bot` and `applications.commands` scopes (Praw needs `applications.commands` in particular: her `/ask` and later user commands are registered on her own application) and **no** guild-wide permissions beyond the basics. Never grant Administrator. Do not grant Attach Files guild-wide (Praw gets it per channel from M4, see Discord permissions). Do not grant Manage Webhooks guild-wide: the service checks this at boot and disables a department client that has it (fail closed).
5. Per-channel permission overwrites for each bot, only on its own department channels (these are the `REQUIRED_CHANNEL_PERMISSIONS` the service verifies in `discord/perm/permissions.ts`):

| Permission | Why |
| :--- | :--- |
| View Channel | read the department channels |
| Send Messages | post replies |
| Send Messages in Threads | post in task threads |
| Create Public Threads | open a thread per task |
| Read Message History | short-term context |
| Embed Links | embed replies |
| Manage Webhooks | persona webhook; **channel overwrite only**, never guild-wide, and only where that department's personas speak |

   Also needed: Use Application Commands (the CEO/hq bot registers the slash commands).
   Two more channels need the same overwrites (View, Send, Send in Threads, Create Public Threads, Read History, Embed Links):
   - **`#💬-ai-warroom`** (`1566366032094961705`) for **every department head bot**, including Praw. It is the bot-to-bot room: heads also post there with `warroom_say` and @mention each other by handle. Delegation threads open in the asking channel's category when the bots can post there, and fall back to this room otherwise; the run is told to answer tersely in English. Audience (owner ruling 2026-11-03): only the Founder and Bot Admin roles, the bot roles (Assistant, LW Bots, AI Employee) and the bot members may view it; any other View overwrite makes `warroom_say` fail closed. Messages people post there are ignored; it cannot be mapped with `/channel map`. Tasks a person gives a head directly stay in the channel where they were given.
   - **`#🧾-bot-log`** (`1566454343820124352`, Logs category) for the **hq** bot. `#🧾-bot-log` is the incident log: one compact plain message per real runtime fault (incident id, bot, task, where, error, cause, fix hint; grep `incident=<id>` in live.log), deduped per 10 minutes and capped at 20 per 10 minutes. Security boot incidents (bot disabled for unsafe permissions, provider unavailable, GitHub denylist unavailable, interrupted approved calls, server management off) are posted as governance alerts with the `@Bot Admin` ping; every other incident is plain and never pings. Tool groups that are merely not configured are reported only when the disabled set changes between boots. Budget, auto-OCR and approval-integrity alerts are unchanged, also here, no longer in `#⚙️-setting`. Approval cards and slash command replies stay in `#⚙️-setting`. Messages in it are never routed and it cannot be mapped.

   **Personas** (the AI employees) speak only in their own direct room under the 🤖 BOT category, never in a work channel or the war room. Naming a persona anywhere else is answered by the department head instead; a persona without a direct room cannot be given tasks (assign the head).
6. Explicitly **deny** every bot View Channel on the two denied channels: `#🔑-system-credentials` (`1565715069969502310`) and `#moderator-only` (`1565649677280485457`). The ids are also hard-coded in `company/denylist.ts`; a bot that can see either channel is disabled at boot and an alert is posted.

### 2. Admin role

Create the role `Bot Admin`, assign it to the owners, and put its **role id** (not its name) in `BOT_ADMIN_ROLE_ID`. Admin is always identified by id. Slash commands work only in `#⚙️-setting` from holders of that role.

### 3. Database (devops, on the shared PostgreSQL)

The `assistant` role and database are isolated from the other apps (Gate 1 D17). This is an infra/devops step; it is documented here and not scripted in this repo.

```sql
CREATE ROLE assistant LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 8 PASSWORD '<generated>';
CREATE DATABASE assistant OWNER assistant;
REVOKE CONNECT ON DATABASE "Labworkspace" FROM PUBLIC;
REVOKE CONNECT ON DATABASE assistant FROM PUBLIC;
GRANT CONNECT ON DATABASE assistant TO assistant;
REVOKE TEMPORARY ON DATABASE assistant FROM assistant;
```

`pg_hba.conf`: add exactly this line, with no `hostssl` public line and nothing broader:

```
host    assistant    assistant    172.30.0.0/16    scram-sha-256
```

Checks: `psql -U assistant -d Labworkspace` is rejected; a connection from a public IP is rejected. The app pool is at most 6 connections plus 1 dedicated LISTEN connection, below the role's limit of 8.

### 4. Secrets on the VPS

Secrets live only in the platform's `shared/.env` for the app: mode 0600, owner root, outside every File Browser root, never in the repo and never in the image (`.dockerignore` excludes `.env*` except `.env.example`). Set them one at a time so values stay out of shell history and argv:

```bash
ssh root@72.60.196.53 "lw env set apps/assistant BOT_TOKEN_HQ"     # value read from stdin
ssh root@72.60.196.53 "lw env keys apps/assistant"                  # key names only
```

Verify mode and ownership: `stat -c '%a %U' /srv/labworkspace/apps/assistant/shared/.env` must print `600 root`.

## Praw (น้องพราว)

Praw is the tenth Discord application (department `praw`). She chats on Google Gemini (default model `gemini-3.8-flash`), can hand work to the other heads and be handed work by them, and has her own `/ask` command. The old bot (the Python "Discord_bot" assistant) keeps running next to her: its messages are mapped to `foreign_bot`, so they never trigger Praw and never count as a human requester (P16e). Switch off the old bot's matching features only when a later milestone says so.

### Owner steps (once, in this order)

1. **Create the Discord application** in the Developer Portal and keep it **Private**. Steps that worked for the other 9 heads: Installation > Install Link = **None** first; then Bot > **Public Bot off**, **Message Content Intent on**, Save. No Server Members and no Presence intent are needed, and no voice intents until M5.
2. **Invite** her with the `bot` and `applications.commands` scopes and the Core permissions (see the table in "Owner setup checklist", section 1: View Channel, Send Messages, Send Messages in Threads, Create Public Threads, Read Message History, Embed Links, and Manage Webhooks only as a channel overwrite). Never Administrator.
3. **Pin Messages** (for `pin_message`, M2) only as a **per-channel** overwrite on Praw's mapped channels, never guild-wide. Discord has a dedicated Pin Messages permission (bit `1 << 51`, required by the pin/unpin endpoints; verified 2026-11-01), so Praw never needs **Manage Messages**: do not grant it. The startup check flags a guild-wide Manage Messages on the `praw` client and disables it (P17). `pin_message` pins only in the channel or thread the request came from. Attach Files (needed from M4: `extract_receipt` posts its CSV as a file; without it the table and CSV are not posted, the tool says so and returns the table in its result), Connect and Speak are likewise per-channel or per-category grants and are not needed before M2/M4/M5 (`PRAW_EXTRA_PERMISSIONS` in `discord/perm/permissions.ts`).
4. **Set the secrets** on the service: `BOT_TOKEN_PRAW` and `GEMINI_API_KEY` (`lw env set apps/assistant BOT_TOKEN_PRAW`, `lw env set apps/assistant GEMINI_API_KEY`, value from stdin; locally `bash scripts/set-tokens.sh --local PRAW`). Without a key she stays unavailable and says so; the other bots are unaffected.
5. **Deploy**, then map her channel: `/channel map <#channel> praw work:true`. Without a work channel other heads cannot assign her tasks (`praw has no work channel`).
6. **Pricing row.** A deployment that already has a stored `pricing` config row must add `gemini-3.8-flash` to it; otherwise Praw refuses to run with the "no price" alert (D4), because a model without a price is never called. Gemini prices were verified on 2026-10-31 (Standard paid tier): 0.75 in / 3.75 out / 0.075 cached per MTok through 2026-12-31, and 1.50 / 7.50 / 0.15 from 2027-01-01. The shipped defaults use the 2027 rates so the budget guard never under-counts; output includes thinking tokens.

### Gemini data terms (P12)

`GEMINI_API_KEY` **must** come from a billing-enabled (paid) Google Cloud project. The unpaid tier's terms allow Google to use prompts and responses for product improvement; the paid terms do not. **The owner confirms** this once for the key in use. Everything Praw is shown goes to Google: chat text and the context around it, images, receipts and, from M5, voice audio. Retention follows the terms of the Cloud project's tier (paid-tier abuse-monitoring retention applies; check the current Gemini API terms before relying on a specific period). Do not map Praw to channels whose content must not leave the company.

### Rotation of Praw's keys

`BOT_TOKEN_PRAW` and `GEMINI_API_KEY` are listed in "Rotation" below. Each later milestone that adds a key adds it there (P24).

## Admin console and Discord permission ops (Praw in `#⚙️-setting`)

A Bot Admin can now change settings by talking to Praw in `#⚙️-setting` (top-level messages only, not threads). Praw reads and **proposes**; hq posts a confirmation card (Confirm / Cancel); only the admin who asked can press it, once, within 15 minutes. The change is applied by code from the stored proposal, never by the model. Everything is audited as `user:<id> via praw` (`config.set`, `admin.<op>`, `perm.<op>`, `admin.card`).

What Praw can do there: read and change the config keys the console allows (`halted` is never one; `/halt` and `/resume` stay slash-only), the admin operations behind the slash commands (holidays, channel map, bots, personas, budget, limits, approval threshold, ClickUp and auto-OCR channels, music hosts, GitHub write allowlist, default provider), and Discord permissions (below). It cannot read or set secrets. If you paste a token or key there, Praw replies with a fixed warning and does not read it: delete the message and rotate the secret.

### Server management: the separate executor "LW Admin" (phase 2, Gate 1 S1-S37)

Praw now manages the whole server (channels, members, moderation, AutoMod, server settings, events, roles and overwrites) by proposing; **Praw's own client holds no management permission**. Every Discord write runs in a **separate process**, the executor "LW Admin" (`executor/main.ts`), which holds the only copy of `BOT_TOKEN_ADMIN`, in its own env file. The main application refuses to start if that token is in its environment.

- **Automatic, no card:** the welcome message plus default roles for a new member, and Discord's own AutoMod enforcement. Everything else, including creating or changing an AutoMod rule, needs a Confirm.
- **How a change happens:** Praw proposes (`perm_propose` for roles and overwrites, `server_propose` for the rest) -> the executor validates it against its own live reads -> hq posts the card -> the proposing admin presses Confirm -> the main application sends **only the card id** over a local Unix socket (`~/.config/assistant/executor.sock`, mode 0600 in a 0700 directory) -> the executor claims the confirmed row (once), **re-runs every hard limit itself** and applies it. A card row forged in the database can only get operations that pass the hard limits, at most 20 ops per admin per 10 minutes, 40 in total, and 10 destructive ones (ban, kick, bulk delete, channel delete, AutoMod disable or delete) per hour.
- **Not built yet:** images (server icon, banner, emoji, stickers; Gate 1 S24, S27) and Onboarding.

#### Owner steps (once, in this order)

Server operations stay **off** (and hq says why in `#🧾-bot-log`) until every step is done.

1. **Create the app.** Developer Portal: a new application "LW Admin". Turn **Public Bot off** and leave Requires OAuth2 Code Grant off. Turn on **2FA** on the account that owns it (with a server MFA requirement, moderation calls fail without it).
2. **Intents.** On the Bot page turn on **Server Members Intent only**. Presence and Message Content stay off.
3. **Invite with exactly this permission integer, `1125684159671`,** and the `bot` scope only (no `applications.commands`). It is these bits: Manage Channels, Manage Roles, Manage Server, Kick Members, Ban Members, Moderate Members, Manage Nicknames, Manage Messages, Manage Threads, Manage Events, View Audit Log, Create Invite, View Channels, Read Message History. **Never** Administrator, Manage Webhooks guild-wide or Mention Everyone. (Send Messages is not needed: it never posts; it may arrive through `@everyone`, which the boot check allows.)
4. **Place the role.** Drag the LW Admin role **below Founder, Bot Admin and every `PRIVILEGED_ROLE_IDS` role**, and **above** the roles you will use as welcome default roles.
5. **Hide the DENIED channels.** LW Admin must not be able to view `#🔑-system-credentials` and `#moderator-only`; the boot check disables the executor if it can.
6. **Create the category `📦 Archive`** (exactly one, exact name) if you want channel archiving. Fill in the owner constants in `company/denylist.ts` if you have not (`FOUNDER_ROLE_ID`, `PRIVILEGED_ROLE_IDS`, `DENIED_CATEGORY_IDS`); the rules channel and the Logs category are read live from the server.
7. **Revoke Praw's phase-1 grant, before deploying this release:** remove **Manage Roles and Manage Channels from the Praw integration role** in Discord. From that moment role/overwrite changes through Praw stop, and they come back through LW Admin after step 8. (Gate 1 suggested keeping Praw's old allowlist for one release; this release moves the phase-1 executor to LW Admin at once, so there is nothing to keep. If you deploy first, the boot check disables Praw until you remove the grant: it fails closed, but it is an outage.) The boot check flags Praw if she ever holds either bit again.
8. **Set the token, locally:** `bash scripts/set-tokens.sh --local ADMIN` (pasted hidden; it writes `~/.config/assistant/env.admin`, mode 0600, with the token, the loopback `DATABASE_URL` copied from `env.local`, and the Bot Admin role id; it never touches `env.local`). `npm run dev` then starts the app **and** the executor, each with its own clean environment. The assistant never handles the token. **On the VPS** the executor service is not deployed yet: do **not** put `BOT_TOKEN_ADMIN` into `apps/assistant` (the app refuses it); the VPS deployment needs its own service, its own env and a socket mounted read-write only in the executor (devops, not part of this release).
9. **Check:** `node dist/scripts/dump-bot-permissions.js` (the ten bots print `OK`), then start the app and check `#🧾-bot-log` for "Server management is off". Then run `node --env-file=$HOME/.config/assistant/env.admin dist/scripts/dump-bot-permissions.js --admin` and confirm `admin: ... OK` (11 clients in total: the ten and LW Admin).
10. **Record** the Gate 1 S2 decision (option A, taken 2026-11-02) and that the phase-1 acceptance of the Praw-token blast radius (the README line that used to stand here) no longer applies: a stolen Praw token can no longer change anything on the server.

#### Welcome and default roles

Configure through Praw (`admin_op_propose` `welcome_set`) or later the panel: `welcome.enabled`, `welcome.roleIds` (up to 5 roles that are safe-bit-only, unmanaged, not privileged, not held by a bot and below LW Admin), `welcome.message` (up to 500 characters; `{user}` is the only placeholder; no links, invites or other mentions), `welcome.channelId` (not a DENIED or system channel; Praw must be able to send there), `welcome.raidPerMinute` (3-30, default 10). Each default role is re-checked against live data on **every** join; a role edited to carry power is not assigned and the flow pauses with an alert. More joins than the limit in a sliding minute (bots count) pause both roles and posts until a Bot Admin confirms `welcome.resume`; the pause survives a restart. A bot that joins gets nothing, and a user id is welcomed once per 24 hours.

Hard limits (propose **and** apply, in the executor): the phase-1 list for roles, overwrites and channel creation, plus: no DENIED or system channel, the Logs category or the rules channel is ever edited, moved, archived or deleted; mapped work channels are never archived or deleted; a channel is deleted only if empty, or archived by LW Admin at least 7 days ago and still in `📦 Archive`; ban and kick targets must be named by the admin by mention or id, at most 5 per card; never the server owner, a bot, LW Admin or Praw, Founder, Bot Admin or other privileged holders, or anyone whose top role is at or above LW Admin's; ban delete-window at most 1 day (loud warning); timeout at most 28 days; bulk delete picks its messages by code at propose time (max 100, newer than 14 days, no pinned, no protected authors) and deletes exactly that list; guild edits only name, description, system and rules channels; event locations must be `https`; invites last 1 hour to 7 days with 1 to 25 uses and the link is shown only to the confirming admin; AutoMod alerts always go to `#🧾-bot-log`, timeouts are at most 1 day, and weakening a rule is flagged on the card.

### Delegated tiers: Moderator, Manager and more Bot Admins (Gate 1 delta T1-T24)

More people than the owner can look after the server. Authority comes **only through Praw and the confirmation card**; the tier roles carry no Discord management bits. The panel, the dashboard and `#⚙️-setting` stay **Bot Admin only**; Moderators and Managers use the **mod room**.

| Tier | Holders | May propose and confirm (limits in code) |
|---|---|---|
| Bot Admin | `BOT_ADMIN_ROLE_ID` (unchanged) | everything |
| Manager | `roles.managerId` | everything a Moderator can, plus: kick (named, max 5), timeout up to 28 days, nickname set/clear, invites create/revoke, channel create/rename/topic/slowmode/move/archive (not system, mapped, DENIED, mod-room or overwrite-sensitive channels), thread unlock, scheduled events |
| Moderator | `roles.moderatorId` | delete one message (by id), bulk delete (code picks the messages, max 50), pin/unpin, timeout up to 1 day (named), end a timeout, thread archive/lock |

Bot Admin only: ban/unban, roles and overwrites, server settings, AutoMod, welcome, bot config and admin ops, channel delete, thread delete. The single op-to-tier table is `MIN_TIER` in `discord/tiers.ts` (an unknown op is Bot Admin only; a test keeps it exhaustive).

How it is enforced: a tier proposal goes to the executor, which fetches the proposer **and** the decider live and derives their tiers from its **own** config read (`roles.*`, `BOT_ADMIN_ROLE_ID`) at propose and again at apply, before any write. A tier is never read from a card. The tier roles are re-validated at every apply (exists, not managed, not `@everyone`, not Founder/Bot Admin/privileged, below LW Admin, not held by a bot, safe bits only, two different roles, not a welcome default role); if one fails, all Manager and Moderator cards are refused and an alert goes to `#🧾-bot-log`, while Bot Admin cards keep working. An actor never targets their own tier or higher, themself, a bot or the owner (live roles); a Moderator's bulk delete leaves out messages by members at their tier or above. Moderators have a 10 / 5 destructive per hour budget, Managers 20 / 10, in their own buckets (so a Moderator raid cannot use up the Bot Admin budget); the global 40 per 10 minutes stays. Cards in the mod room are confirmable **only by their proposer**, only in the mod room (and a Bot Admin may cancel). Every audit row carries `tier:<bot_admin|manager|moderator>` at the end of the actor.

#### Owner steps (once)

1. **Create two roles** in Discord, for example `Moderator` and `Manager`, with **no management permissions at all** (safe bits only: view, send, read history, connect, speak and the like; never Manage Messages, Kick, Timeout, Manage Channels/Roles/Server, Mention Everyone, Administrator, Manage Webhooks/Threads/Events, View Audit Log). Place them **below LW Admin's role**, not under Founder/Bot Admin, and do not use them as welcome default roles. Praw cannot grant these roles (nor Bot Admin); **you assign them in Discord**.
2. **Create `🛡️-mod-room`**, in its own category (a category that holds the mod room is out of reach for a Manager's channel moves), visible to Moderator, Manager, Bot Admin, Praw (the bot), hq and LW Admin, and to nobody else. Praw and hq need View, Send and Read History there, and **LW Admin needs View Channel** there too (it judges every Manager/Moderator card against the room, its name and its category; with no view of it, `roles.modRoomId` is refused and all tier cards are refused).
3. **Set the three keys with a Bot Admin card** in `#⚙️-setting` (ask Praw: "set roles.moderatorId to <role id>, roles.managerId to <role id>, roles.modRoomId to <channel id>"). They are high risk and checked live by the executor; they cannot be set from the mod room. Until `roles.modRoomId` and a tier role are set, the mod room does nothing.
4. **More Bot Admins:** give the Bot Admin role in Discord to trusted people. No code change; Praw and LW Admin can never grant it. Each extra Bot Admin widens the trust base of every security condition, so **record every holder here** (who, date) and remove the row when the role is taken away:

| Bot Admin holder | Added on | Added by |
|---|---|---|
| (owner) | | |

Notes: use the mod room by writing normally; Praw answers there for a Moderator or Manager only (bots, webhooks, people without a tier role, threads and edits are ignored). Name every member you act on by mention or id in your own message, and give the message id (or reply to the message) for a single delete or pin. Praw there reads only your own earlier words and her own recorded replies, so other people's messages never steer a card.

## VPS deploy from Discord and the executor as its own macOS user (programme part 3, Gate 1 `docs/security/2026-11-02-gate1-vps-deploy.md`)

A Bot Admin can ask Praw in `#setting` to put a website on the company VPS: `deploy_propose` (a `Lab-Work-Space` GitHub repo as `<name>.labworkspace.net` or `api.labworkspace.net/<name>/`, a redeploy, a removal, or a `<name>--<branch>` preview that removes itself after 72 h by default and 7 days at most) and `site_publish_static` (a folder Praw built in her workspace; **apps only**, `<name>.labworkspace.net`: no assistant-made JS on the shared `api.labworkspace.net` origin; a repo `add` may still use category `api`, and previews are always `apps`). `deploy_read` shows status and logs of the apps she deployed. Every change is a card (**Bot Admin only**, no Manager or Moderator) that shows the exact operation, the **commit sha** and the URL; only that sha is built (`AUTO=0`, no auto-redeploy on push). The owner's own sites (main, aurora, vernisos, ...) can never be touched through this path. The result of a build is posted back in `#setting` when it finishes.

How it is built: the executor "LW Admin" holds the deploy key and sends `ssh -p 2223 assistantdeploy@72.60.196.53 request` (host, port and a pinned host key are constants/files, not env). The VPS side is `infra/vps/81-assistant-deploy.sh` (own sshd, relay, sandboxed receiver, root worker; see `infra/OPERATIONS.md` section 19). `deploy_*` cards never reach the main application's process: it only forwards card ids.

### Second confirmation by LW Admin itself (Gate 2 OD-G2-1, G2VD-03)

For **deploy operations** (add, preview, publish_static, redeploy, remove) and **destructive server operations** (ban, kick, bulk delete, channel delete, AutoMod disable or delete), the normal card is not enough. After the Bot Admin (or, for a destructive server card in the mod room, the Manager/Moderator) presses Confirm, the executor checks the card and then **LW Admin sends the same person a second button through its own identity**: a DM with the exact operation, the card id, valid 5 minutes, one click. Only a click that arrives on **LW Admin's own interaction stream** from that same Discord user id, after a live role recheck, lets the executor apply; every check runs again at that moment. The main application has no LW Admin token and no LW Admin gateway, so it cannot produce this click: a forged database row (G2VD-03) leaves the card waiting and nothing is applied. The prompts live only in the executor's memory (not in the database): a restart or the 5 minutes drop them, the card is then spent and must be proposed again. Both confirmations are audited (`admin.card` ... `awaiting_second`, `admin.confirm2` requested / confirmed / refused / applied).

- **DMs closed:** LW Admin posts the button in the card's channel instead (`#setting` for a Bot Admin, the mod room for a tier), mentioning only that user; only that user's click counts. Owner setup for this: give the LW Admin bot **Send Messages as a channel permission overwrite in `#setting` and in the mod room** (not guild-wide; the invite integer `1125684159671` is unchanged and the boot check, which looks at guild-level bits, still passes). Without it, a Bot Admin whose DMs are closed gets a refusal and must open DMs (Discord: Privacy settings -> Allow direct messages from server members).
- **Gate impact:** LW Admin now has ONE interaction listener (buttons whose id starts `lwadmin2:` + 32 hex), still no MessageCreate listener, no slash commands, intents unchanged (Guilds + GuildMembers; DMs and buttons need none); no `applications.commands` scope. Everything else about S3/S8 stands.
- Other server operations (kick/ban excluded as listed above, nicknames, channel edits, AutoMod create, ...) and permission cards keep the single confirmation.

### The executor under its own macOS user (OD-1; closes G2SM-01 on the Mac)

The executor runs under launchd as the hidden user `_lwadmin`. Its env file (bot token, database URL of the least-privilege role `lw_executor`) and the deploy key are `0600` under `/var/lwadmin/private`, **unreadable by your own uid**; the code it runs is a root-owned copy in `/usr/local/lib/lwadmin`. The main app reaches it through `/var/lwadmin/run/executor.sock` (group `_lwadmin_ipc`, mode 0660; you are added to that group). Node has no `getpeereid`, so the kernel's group check is the only peer check: any process of your account can talk to the socket, but it can only name card ids, and the executor re-checks every card, tier and limit itself. What this does NOT close: code running as your uid can still write to the database as the main app and forge a confirmed deploy card. It would still be limited by the executor's re-validation, the card and rate rules, and (on the VPS) the V9 caps; it cannot read the key or the token.

Owner steps on the Mac, in order:

1. `npm run build`, then `npm run migrate` (or start the app once: migration 016 must exist before the grants can name its tables; re-run `executor-role` after any later migration that adds an executor table). Create the database role: `node --env-file="$HOME/.config/assistant/env.local" dist/scripts/executor-role.js --out "$HOME/.config/assistant/.lwadmin-db-url"` (own DATABASE_URL, loopback; prints nothing secret).
2. `sudo bash scripts/executor-service.sh install` (Node must be system-wide, e.g. `/usr/local/bin/node`). It moves `env.admin` out of your home, makes the user, the key and the job, and prints the **VPS key line** (copy it). Then **log out and in once** so your shell is in the group `_lwadmin_ipc` (`bash scripts/executor-service.sh status` tells).
3. Rotate `BOT_TOKEN_ADMIN` in the Discord developer portal (the old file was readable by your uid) and run `sudo bash scripts/executor-service.sh set-token`.
4. On the VPS (next section) read the host key and bring it back: `sudo bash scripts/executor-service.sh install --host-key-file host.pub` pins it. Until then deploy stays off and says so.
5. The job runs a **copy** of the code in `/usr/local/lib/lwadmin`: after every `npm run build` or update run `sudo bash scripts/executor-service.sh install` again (idempotent: it refreshes the copy and keeps the key and `env.admin`), or the app and the executor drift apart.
6. `npm run dev` now starts **no** executor (it only points the app at the socket). `bash scripts/executor-service.sh status`, `sudo ... rotate-key` (new key, add the new line on the VPS), `sudo ... uninstall [--purge]`.

Owner steps on the VPS (as root, after `80-team.sh`): see `infra/OPERATIONS.md` section 19 (summary: confirm that the admin session cookies are host-only, run `13-firewall.sh` then `--confirm`, put the key line into `/var/lib/assistantdeploy/.ssh/authorized_keys`, `LW_ASSISTANT_V20_VERIFIED=yes bash infra/vps/81-assistant-deploy.sh`, `bash infra/vps/tests/p10-assistant-deploy-check.sh`, write the host key with `cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub`).

## Settings panels: Discord panel and local web dashboard

Two ways to change settings without talking to Praw. Both build the **same** structured ops and the **same** confirmation card as the natural-language and slash flows (`admin/settings.ts` -> `AdminConsole`); neither has a write path of its own. Server-management sections (welcome and default roles, AutoMod, server settings and events, moderation shortcuts) answer "available after server management is enabled" until that feature is merged and registers its family.

### Discord panel (`#⚙️-setting`)

hq posts and pins one panel message at boot (the id is stored in the `panel_state` table; a deleted message is re-posted once, at most once per 10 minutes, and the old message's buttons are refused). Pick an action from the select menus, fill the form, confirm the card. Only Bot Admins (role id from the interaction payload) can use it. Live values refresh after every apply. Owner step: give hq **Pin Messages** in `#⚙️-setting` if you want it pinned (a missing permission is logged, the panel works unpinned).

### Local web dashboard (local mode only)

- Start: runs inside the local app when `ALLOW_LOCAL_PROVIDERS=1` is in the real process env and the process is not in a container. It binds the literal `127.0.0.1` on `DASHBOARD_PORT` (default 8787, process env only). It never starts in the VPS image, and `deploy/` publishes no dashboard port (a test checks both).
- Sign in: a Bot Admin runs `/dashboard` in `#⚙️-setting`; hq replies privately with a link that works **once** within **5 minutes**. Opening it shows a "Continue" button; the click signs you in (a GET alone consumes nothing). Session cookie `lw_dash_sid`: HttpOnly, SameSite=Strict, host-only, idle 8 h, absolute 24 h; Logout and "Revoke all sessions" delete it server-side. The cookie is not marked `Secure` (Safari refuses Secure cookies on `http://127.0.0.1`).
- Pages: status, config (read only, `ADMIN_READ_KEYS`), pending cards with the stored diff and Apply/Cancel (only for cards you proposed in the dashboard; Discord cards are read only), change forms, audit (filter and sort), members (needs server management), channels (protected channels shown only as a count).
- Guards: exact `Host` (`127.0.0.1:<port>` or `localhost:<port>`, one header), exact `Origin` on every POST, a per-session CSRF token in the form (cookies and SameSite ignore ports, so another local service cannot forge a write), live Bot Admin re-check on every write (removed role = all sessions deleted), CSP `frame-ancestors 'none'`, no CORS.
- **Containers can reach the port** (Docker Desktop routes `host.docker.internal` to host loopback), and so can any local process. The `Host` check only stops a browser-style request with a foreign name; a client that forges `Host: 127.0.0.1:<port>` gets through. The protection is therefore not network isolation but the one-time login token, the per-session CSRF token and the exact Origin check. The web tools and the Chrome proxy cannot be pointed at it (the net guard refuses loopback and private addresses; `dashboard/boot.test.ts`). Gate 2 live probes: from a container, `curl -i -H 'Host: evil.example' http://host.docker.internal:8787/` expects 421; an unauthenticated request with a correct `Host` expects 401.
- Not remote: exposing it beyond the Mac needs its own spec (Caddy plus auth).

### Self-updating knowledge (self-development part 2, Gate 1 K1-K18)

- What it is: department notes, lessons, a keyword-searchable knowledge base (`kb_docs`, versioned) and prompt/persona text improve themselves, and a Bot Admin confirms once at the end. Spec `docs/superpowers/specs/2026-11-02-self-knowledge-design.md`; migration `015_knowledge` runs at boot (up/down are tested; old notes count as tainted, an old deleted prompt override becomes a tombstone).
- Automatic: when a head finishes its own task, one cheap-model "reflect" call (no tools, input = task title, status, result and final answer only, at most 1,500 input and 300 output tokens, charged to the task's budget) may add up to 3 notes of 400 characters. Notes from a tainted run are stored **unverified**, shown to the model as such, and a run that reads one becomes tainted. At most 200 notes per department (oldest unpinned roll off), 30 reflect notes per department per day.
- Proposals: heads and Praw call `knowledge_propose` (documents, note to lesson, pin, lesson edit/retire) or `prompt_propose` (their OWN head text or their own members only; never `system/*` or `fragments/*`; refused for a tainted run; the lint, a cheapest-model classifier and the size caps run first). A proposal only waits. Every Monday 09:00 (`schedule.timezone`, first workday of the week) each department head's notes are consolidated into at most 3 proposed documents; this job is always tainted, creates no task and posts nothing.
- Confirm: dashboard, **Knowledge** page. Read the full diff or text and every source; a tainted proposal first needs "I have read the sources", then "Make card" (your own single-use card), then Apply on the card. The same page shows documents with versions, notes, lessons and prompt versions, and starts a rollback (to an exact earlier version or the file default) or a purge (document and all versions). Stale cards are refused by compare-and-swap.
- Safety text (`system/safety`, `system/tool-use`, `fragments/approval-request`) can no longer be overridden: it is appended after the role text, followed by a fixed precedence line, and pinned by SHA-256 in `prompts/protected.ts`. Editing those files means updating the hash constant in the same commit (a test recomputes it); a mismatch stops the process at boot and refuses every run.
- Owner steps: none are required. Restart the app once to run the migration. Optional: watch the cost of the cheapest model (`pricing` keys decide which one is used) and the weekly review (cap 0.10 USD per ISO week).

## Cutover M2

M2 moves reminders, scheduled tasks, web watches, lessons, web search, the workspace and pins from the old Python bot (`Discord_bot`) to Praw. Both bots run side by side until each old feature is proven off (L12-L14, P23). Do the steps **in this order**; everything here is an owner or devops step.

**0. Before anything (devops, parent repo).** The production compose lives in the parent repo at `infra/vps/files/lw-git/apps/apps-assistant/docker-compose.yml`; this repo does not edit it. It must gain the three things that `deploy/docker-compose.yml` already has (Task 20), otherwise `write_file` fails because the container root is read-only:

```yaml
services:
  assistant:
    environment:
      PRAW_WORKSPACE_DIR: /app/data/workspace/praw
    volumes:
      - praw-workspace:/app/data/workspace/praw
volumes:
  praw-workspace: {}
```

The top-level `volumes:` block is required next to `services:`. The image creates `/app/data/workspace/praw` owned by `node` with mode 0700, so the fresh volume inherits it. Check with `lw check-compose`.

1. **Deploy the old-bot change first.** The `COGS_DISABLED` support for the old bot is on the `Discord_bot` branch `chore/cogs-disabled` (not pushed yet at the time of writing). Push it, merge it and deploy that build to the old bot **before** step 3; an old build ignores the flag and keeps firing reminders.
2. **Deploy Assistant M2** (`lw-git` builds on the new commit; migration `008_praw_m2` runs on boot). Check `docker ps` shows `healthy` and the `reminders`, `schedule`, `watch`, `lessons`, `workspace`, `pin` and `web` tool groups are enabled (no "tool groups disabled" alert in `#🧾-bot-log`).
3. **Switch the old features off.** On the Python bot set `PLUGINS_DISABLED=reminders,lessons,web_search,workspace,pin` and `COGS_DISABLED=reminders,scheduled_tasks,watch,lessons` (`pin` is added by spec section 14.10), then restart it.
   - **3b. Live check, per feature.** The env flag alone is not proof (P23). Send each old command to the old bot (a test `/remind`, a scheduled task, a watch, a lesson command, "pin this") and see that it refuses or stays silent. Only then continue. The new bot uses new ClickUp, GitHub and Sheets credentials (those arrive in M3/M4; do not reuse the old bot's secrets).
4. **Import the old data, right after step 3** so nothing fires twice. The import reads the old SQLite files (`reminders.sqlite3`, `scheduled_tasks.sqlite3`, `watches.sqlite3`, `lessons.sqlite3`) and writes through the repos; it is idempotent (`legacy_id`), so re-running adds 0. Dry-run first (prints counts only), then apply, from the server with the old data directory mounted read-only:
   ```bash
   # DATABASE_URL: export it first from a hidden prompt (read -rs); only this one variable (plus the guild id) goes into the container
   docker run --rm -e DATABASE_URL -e GUILD_ID=<company guild id> --add-host host.docker.internal:host-gateway \
     --user 1000:1000 --read-only -v <OLD_DATA_DIR>:/import:ro lw-local/apps-assistant:<IMAGE_TAG> \
     node --disable-warning=ExperimentalWarning dist/scripts/import-discord-bot.js --from /import            # dry-run
   # same command with --apply appended once the counts look right
   ```
   Source reminders with `fired != 0` and scheduled tasks and watches with `active != 1` are skipped. Watches whose URL fails the SSRF check are imported disabled. **Every imported lesson is inactive** (stored prompt injection, P13): a Bot Admin reviews each and switches it on with `/lesson enable <id>`.
   - **Warning: past-due rows fire immediately.** An imported reminder, scheduled job or watch whose time is already in the past is picked up by the next 15 s tick and **fires immediately** after the import. Review the dry-run counts first; if the old bot was down or you waited, stop the new bot before `--apply` (`docker stop <container>`), apply, inspect with the SQL below, and start it again (`lw restart apps/assistant`):
     ```sql
     SELECT 'reminders' AS t, count(*) FROM reminders WHERE legacy_id IS NOT NULL AND NOT cancelled AND fired_at IS NULL AND remind_at < now()
     UNION ALL SELECT 'scheduled_jobs', count(*) FROM scheduled_jobs WHERE legacy_id IS NOT NULL AND active AND next_run_at < now()
     UNION ALL SELECT 'watches', count(*) FROM watches WHERE legacy_id IS NOT NULL AND enabled AND next_check_at < now();
     ```
     Cancel the ones you do not want with the rollback statements below, narrowed by `AND legacy_id IS NOT NULL AND remind_at < now()` (or `next_run_at`, `next_check_at`).
5. **Smoke test.** In `#🧪-labs-sandbox` ask Praw "ช่วยเตือน อีก 2 นาที"; the reminder must arrive once, in the channel, with a mention. Then `/remind list` and a cancel.

### Rollback

**Order matters: stop Praw first, then turn the old bot back on.** The other way round leaves a window where both bots fire the same reminder.

1. **Stop the Assistant first** (`docker stop <container>`), so nothing fires while you work. Reads and writes below go straight to PostgreSQL and do not need it running.
2. **Record what Praw already handled** (psql as `assistant`), before the next step changes the flags. `legacy_id` is the old row id; a claimed reminder counts as handled:

   ```sql
   SELECT string_agg(legacy_id::text, ',') FROM reminders      WHERE legacy_id IS NOT NULL AND (fired_at IS NOT NULL OR claimed_at IS NOT NULL OR cancelled);
   SELECT string_agg(legacy_id::text, ',') FROM scheduled_jobs WHERE legacy_id IS NOT NULL AND NOT active;
   SELECT string_agg(legacy_id::text, ',') FROM watches        WHERE legacy_id IS NOT NULL AND NOT enabled;
   ```
3. **Switch Praw's copies off**, so a later restart of the Assistant fires nothing (the columns differ per table: reminders use `cancelled`, jobs `active`, watches `enabled`):

   ```sql
   UPDATE reminders SET cancelled = true WHERE NOT cancelled;
   UPDATE scheduled_jobs SET active = false WHERE active;
   UPDATE watches SET enabled = false WHERE enabled;
   ```

   (Lessons: `UPDATE lessons SET active = false;`.) The rows are kept.
4. **Mark those rows in the old SQLite files.** The import only read them, so every old row is still due and the old bot would fire it again the moment it is back. Either roll back before anything has fired (skip this step), or, with the old bot still stopped and a copy of the files taken, use the ids from step 2:

   ```bash
   sqlite3 reminders.sqlite3       "UPDATE reminders SET fired = 1 WHERE id IN (<ids>);"
   sqlite3 scheduled_tasks.sqlite3 "UPDATE scheduled_tasks SET active = 0 WHERE id IN (<ids>);"
   sqlite3 watches.sqlite3         "UPDATE watches SET active = 0 WHERE id IN (<ids>);"
   ```
5. **Only now** remove `PLUGINS_DISABLED` and `COGS_DISABLED` on the Python bot (the build from cutover step 1) and restart it.

### Environment and keys in M2

M2 adds **no new secret or key**: the only new variable is `PRAW_WORKSPACE_DIR` (a path, not a secret; see "Environment variables"), so "Rotation" needs no new entry. Reminders and watches use no external credentials; `web_search` and `fetch_page` need no key.

## Cutover M3

M3 moves ClickUp and GitHub from the old bot to Praw (read tools for the heads named in `tools.byDept`; write tools for Praw, with approval). The old Team MCP stays unported. Everything here is an owner or devops step; do the steps **in this order**.

1. **Set the M3 keys** with `lw env set apps/assistant <KEY>` (value from stdin) or `bash scripts/set-tokens.sh CLICKUP|GITHUB`: `CLICKUP_API_TOKEN`, `CLICKUP_LIST_ID`, `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY` (VPS) or `GITHUB_APP_PRIVATE_KEY_PATH`. The new bot uses **new** ClickUp, GitHub App and Sheets credentials, never the old bot's (P23). They are all listed under "Rotation" (P24).
   - **GitHub PEM upload.** On the VPS `set-tokens.sh GITHUB` sends the PEM through `lw env set` as one line with `\n` for newlines. After the first deploy confirm the github group is enabled (no "Tool groups disabled" alert) and that `github_get_me` works; if it does not, the encoding did not survive `lw env set`. A leftover `GITHUB_APP_PRIVATE_KEY_PATH` in the env **overrides** `GITHUB_APP_PRIVATE_KEY`: remove the one you do not use (`lw env unset`).
2. **GitHub App permissions and installation.** Repository permissions: Metadata (read), Issues (read), Pull requests (read), Contents (read). Add Contents (write) and Pull requests (write) **only** if allowlisted writes are wanted. Never grant `workflows`, `administration`, secrets or any organization permission. Install on **selected repositories** only (never "all repositories"), and check the list on the installation page against the intended set (P6e, L13).
3. **Branch protection (decision pending).** Branch protection on `main` of the allowlisted repos is **not available on the free organization plan**. Until the owner decides (open for Security Gate 2), treat it as an open risk: the write tools never push to the default branch and open PRs only from `praw/*` branches, but nothing server-side stops another actor. Recommended meanwhile: restrict repository secrets to environments, and require approval for workflow runs on `praw/*` branches (Settings, Actions, "Require approval for all outside collaborators" / environment protection rules), so a pushed branch cannot run a workflow that reads secrets.
4. **Deploy**, then check `docker ps` is `healthy` and the `clickup` and `github` tool groups are enabled. If the GitHub denylist could not be resolved at start, a "GitHub denylist unavailable" alert appears in `#🧾-bot-log` and every GitHub write is refused until it is fixed.
5. **Switch the old features off.** On the Python bot add `clickup,github` to `PLUGINS_DISABLED` and `clickup` to `COGS_DISABLED`, then restart it. **Live check, per feature** (the env flag is not proof, P23): ask the old bot for a ClickUp list and a GitHub read and see that each refuses or stays silent.
6. **ClickUp notifications use polling.** The old webhook is switched off; Praw polls the configured list every `clickup.pollIntervalSec` (default 120, minimum 30). Set where the notices go with `/clickup channel <#channel>` (Bot Admin, in `#⚙️-setting`; no channel argument clears it), or leave it unset and map Praw's work channel (`/channel map <#ch> praw work:true`). With neither, nothing is posted. The change applies live.
7. **Denylist after every `lw add`.** Run `node scripts/gen-deploy-denylist.ts` (reads `LW_INFRA_DIR`, default `../infra`) after every `lw add` or app.conf change, and commit `tools/plugins/github/deploy-repos.json` with `tests/fixtures/lw-git-repos.txt`. **At each deploy, clear pending github approvals** (cards created before the deploy may lack the pinned repo id): a Bot Admin presses ❌ on each pending github card in `#⚙️-setting` (this resumes the waiting task with a rejection notice), or leaves them and the normal expiry (`approval.expiryHours`, default 24) rejects them and notifies the task. Do not edit the `approvals` table by hand: a bare UPDATE leaves the task stuck in `awaiting_approval`.
8. **Acceptance with a throwaway repo (AC9, AC10).** Create a throwaway repo, `/github allow action:add repo:<owner/repo>`, then in `#🧪-labs-sandbox`: (AC9) "create 2 ClickUp tasks" from a direct chat runs without approval, the same instruction from a scheduled run or a delegated task asks approval for each write; (AC10) ask Praw to change a file: an approval card appears, and after approval a `praw/<name>` branch and a pull request exist. Remove the repo from the allowlist afterwards.

### Rollback (M3)

**Order matters: stop the new bot's ClickUp/GitHub first, then re-enable the old bot's.** The other way round leaves a window where both bots act, and ClickUp notices are sent twice (poller plus the old webhook).

1. `lw env unset apps/assistant <KEY>` for each of `CLICKUP_API_TOKEN`, `GITHUB_APP_PRIVATE_KEY` (and `GITHUB_APP_PRIVATE_KEY_PATH` if set), then `lw restart apps/assistant`. The ClickUp poller only runs when `CLICKUP_API_TOKEN` is set, so it stops with the restart; confirm with the "Tool groups disabled" alert naming the two groups.
2. **Only then** remove `clickup,github` from `PLUGINS_DISABLED` and `clickup` from `COGS_DISABLED` on the old bot and restart it.
3. **Re-register the old ClickUp webhook.** The old bot's notifications came from a ClickUp webhook that was switched off at cutover; re-create it the way it was first made (the old bot's own setup docs / Team MCP; this repo cannot see them, so confirm the exact steps there). Without it the old bot posts no ClickUp notices.

Migration `009_clickup_seen` is additive and stays.

## Cutover M4

M4 moves OCR and receipts from the old bot to Praw: `/ocr`, `/receipt`, the tools `ocr_image` and `extract_receipt` (and `sheets_append_receipt` when Sheets is configured), and an optional auto-OCR channel. No migration; nothing is imported. Do the steps **in this order**.

1. **Deploy** this version. Check `docker ps` is `healthy` and the `ocr` tool group is enabled (it needs the Gemini key; without it the group is off and an alert says so).
2. **Attach Files.** Praw posts the receipt CSV as a file, so it needs **Attach Files** in each channel or category where it should do that, granted per channel or category and never guild-wide (P17). Without it the table is still returned in the answer and the tool says the file could not be posted.
3. **Sheets (optional).** To append receipts to a sheet set `GOOGLE_SHEETS_WEBAPP_URL` and `GOOGLE_SHEETS_WEBAPP_SECRET` (`bash scripts/set-tokens.sh SHEETS`, or `lw env set apps/assistant <KEY>`) and restart. Use a **new** Apps Script web app and a **new** secret, never the old bot's (P23). See "Receipts and Google Sheets" under Operations for the request shape and why the sheet must be checked by hand after setup. Finance can read receipts (`extract_receipt`) but only Praw gets `sheets_append_receipt`, with approval; add it to a department yourself with `/bot tools` if you want that.
4. **Auto-OCR channel (optional).** Map the channel to Praw (`/channel map <#ch> praw work:true`), then in `#⚙️-setting` run `/autoocr channel <#ch>` (Bot Admin; no channel argument switches it off; it applies live). Every image or PDF a human posts there is read by Praw with no mention needed. It counts against the same per-user limits as a chat message. If the channel is set but not mapped to Praw nothing is read and one alert appears in `#🧾-bot-log`. Threads inside the channel are not read automatically. The command is named `/autoocr` so it never clashes with Praw's own `/ocr`.
5. **Limits.** `limits.visionPerUserDay` (default 30) is the number of image or receipt readings per person per UTC day, shared by chat, `/ocr`, `/receipt` and the auto-OCR channel (P15). The count is kept in memory: a restart gives everyone a fresh day, so the worst case is one extra allowance per person per restart (the company budget still applies). Change it with `/limits set limit:vision_day value:<n>` (Bot Admin, in `#⚙️-setting`). Files over 10 MB and anything that is not PNG, JPEG, WebP or PDF are refused (the download checks the real bytes, not the name).
6. **Switch the old OCR off.** On the Python bot add `ocr` to `COGS_DISABLED` and restart it. **Live check** (the env flag is not proof, P23): post a receipt photo to the old bot and see that it stays silent or refuses.
7. **Acceptance (AC11).** In a channel where Praw has Attach Files, run `/receipt` with a real Thai receipt photo: the answer shows the table, a `receipt-<date>.csv` file is posted, and with Sheets configured, asking Praw to add it to the sheet produces an approval card with the whole row; after approval, check the sheet.

### Rollback (M4)

Remove `ocr` from the old bot's `COGS_DISABLED` and restart it **after** switching the new side off: `/autoocr channel` with no channel, then `lw env unset apps/assistant GOOGLE_SHEETS_WEBAPP_SECRET` (and the URL) and restart. The `/ocr` and `/receipt` commands stay registered but answer only while Praw runs.

## Voice and music

Everything here is M5. Reference detail: "Media binaries (P22)", "Operations > Music" and "Operations > Voice chat". This section is the short version plus the live checks only the owner can do.

- **Music.** `/play`, `/skip`, `/queue`, `/stop`, `/volume` and the `music_*` tools, over the pinned yt-dlp and ffmpeg. The requester must be in a voice channel. The queue survives a restart (paused).
- **Voice chat.** `/voice join` (Praw joins your own voice channel), `/voice leave`. Speech goes to Google (Gemini) for transcription, reply text goes to Microsoft (Edge TTS) for speech. Only the invoker and people who press the opt-in button are heard; the presser must be in Praw's voice channel at that moment. If Edge TTS fails or the service changes, Praw posts the reply as text in the channel instead; nothing else breaks.
- **Idle and length.** `voice.idleMin` (10) counts silence only while no music is playing: while music is playing the idle timer is paused (it restarts when the music stops). `voice.maxSessionMin` (60) always applies. A spoken reply never queues more than 2 clips over the music, and a clip that does not finish in time is dropped.
- **Rollout note (stored allowlist).** The default `media.ytHostAllowlist` now includes `m.youtube.com`. A deployment that already **stored** a `media.ytHostAllowlist` value keeps its stored list: add `m.youtube.com` to it with `/media allowlist action:add host:m.youtube.com` (Bot Admin, in `#⚙️-setting`; the list is validated, versioned, audited and live at once; `action:remove` takes a host off), or mobile links are refused. `/media allowlist` is the only supported way to edit that list.

**Live check (owner, in the real server, with Praw alone in a voice channel).**

1. **AC12 (music).** Join a voice channel, `/play lofi`, then `/play` a second song, `/skip`, `/queue`, `/volume 60`, `/stop`. Then, with the music playing, ask Praw by voice something that needs her to answer: the music ducks to 20% and comes back, and the track is not skipped.
2. **AC13 (voice).** `/voice join`, speak a question that needs `web_search`, hear the spoken answer, then `/halt` (or `/voice leave`): Praw leaves within 2 s and nothing was written to disk.
3. **DAVE readiness when Praw is alone in a channel.** With only you and Praw in the voice channel (no other member), `/voice join` and speak. The DAVE handshake must complete before any audio is sent (the log shows DAVE negotiated; no "not E2EE" refusal, no silence). Repeat after everyone else has left and one person returns. If DAVE is not live, Praw leaves; that is the intended behaviour, so report it with the log line.
4. **YouTube and cookies.** `/play` a normal video. If YouTube answers "sign in to confirm you are not a bot" from the server IP, set `YTDLP_COOKIES_FILE` (see "Operations > Music": throwaway account, mode 0600, read-only mount, never in the image) and retry. Record in the release notes whether cookies were needed.

## Retiring Discord_bot

Retire the old Python bot only after the M5 live checks above pass. Everything here is an owner or devops step, in this order.

1. **Deploy** the M5 image (`lw-git status`, container `healthy`, "Tool groups disabled" alert empty or understood). If a `media.ytHostAllowlist` is stored, run `/media allowlist action:add host:m.youtube.com` first.
2. **Verify AC12 and AC13 live** in the server (the "Voice and music" live check), including DAVE readiness with Praw alone in a channel and the YouTube/cookies check.
3. **Stop the Python bot** (its container or process). Check that nothing in the server still answers as the old bot, and that Praw handles music, voice, reminders, watches and OCR (the old features proven off in the earlier cutovers).
4. **Remove the old Discord application from the server** (owner: kick the bot, then delete the application in the Developer Portal when nothing needs it).
5. **Archive `Discord_bot`** (read-only archive of the repo; keep the SQLite file only until the M2 import is confirmed).
6. **Reset the old bot's Discord token** (Developer Portal > Bot > Reset Token) even though the application is gone or the process stopped, so a leaked copy is dead (P23).
7. **Revoke the old bot's credentials (P23).** Remove its **GitHub App installation** (the app's own settings and the installation under the organisation). Revoke its **Gemini**, **ClickUp** and **Sheets** keys (the Apps Script secret and deployment) and **rotate** any key it shared with Praw or the Assistant, then update the new keys with `lw env set apps/assistant KEY` and redeploy. Remove the old bot's role and any channel overwrites it needed. Update `infra/OPERATIONS.md` if it still references the old bot.
8. **Gate 2 supply-chain scan (P22)** on the final image: a binary-aware SBOM scan that covers `/opt/yt-dlp/_internal`, ffmpeg's `libav*` libraries and `node_modules`, run first against a **positive control** (an image or file with a known HIGH vulnerability, to prove the scanner sees the bundled yt-dlp libraries), then `npm audit --omit=dev` over `@google/genai`, the voice libraries (`@discordjs/voice`, `@snazzah/davey`, `opusscript`) and the Edge TTS package (`msedge-tts`). It passes only with no unpatched HIGH or CRITICAL finding. Any finding is fixed by the pinned bump procedure ("Media binaries (P22)"), never by an auto-update.

Rollback: until step 6, re-enable the old bot; after step 6 the old bot cannot come back without a new token, which is the point.

## Environment variables

Values are never committed. See `.env.example`.

| Variable | Required | Meaning |
| :--- | :--- | :--- |
| `DATABASE_URL` | yes | PostgreSQL URL for role `assistant` on database `assistant` (from the container: `host.docker.internal:4231`). Must use the `assistant` role, not the platform default one. node-postgres reads TLS only from the URL, so put `sslmode=...` in it if the server requires TLS. If the platform also injects a `DATABASE_URL` (port 4231), the value set with `lw env set apps/assistant DATABASE_URL` in `shared/.env` is what must win; confirm with `lw check-compose` and see the open point below |
| `CONFIG_MASTER_KEY` | yes | base64 of exactly 32 random bytes (`openssl rand -base64 32`); encrypts provider keys added with `/provider add` |
| `LOCAL_DB_PASSWORD` | local mode only | password of the local PostgreSQL (`docker-compose.local.yml`); generated by `set-tokens.sh --local` |
| `BOT_ADMIN_ROLE_ID` | yes | Discord role id of `Bot Admin` |
| `GUILD_ID` | no | server id, default is the company server; all events from other guilds are dropped |
| `ANTHROPIC_API_KEY` | no | key for the Claude provider |
| `ANTHROPIC_WORKSPACE_ID` | no | `wrkspc_...` workspace id sent as `anthropic-workspace-id`; needed for organization-scoped API keys (an invalid value refuses boot) |
| `GEMINI_API_KEY` | no | key for the Gemini provider (department Praw) |
| `CLICKUP_API_TOKEN` | no | ClickUp personal token (`pk_...`, sent raw in `Authorization`, no `Bearer`). With `CLICKUP_LIST_ID` it turns on the ClickUp read tools; without both the group stays off and one startup alert says so (R13). Set with `bash scripts/set-tokens.sh CLICKUP` or `lw env set apps/assistant CLICKUP_API_TOKEN` |
| `CLICKUP_LIST_ID` | no | the one ClickUp list the tools may read (tasks, comments and members outside it are refused, P9) |
| `CLICKUP_TEAM_ID` | no | workspace mode, with `CLICKUP_API_TOKEN` and no `CLICKUP_LIST_ID`: digits = every project of that one workspace; exactly `all` (lower case) = every workspace the token can see, at most 10 (more at boot leaves ClickUp off; after a good boot the last good set stays). A list id wins over both, and `set-tokens.sh` clears the other key when you set one. Every write needs approval and shows its workspace; a workspace the token's account joins later is included within 10 minutes (a count notice goes to #bot-log), and a write into a workspace whose name matches another's is refused. Use a dedicated ClickUp member token. In either workspace mode Praw can also create a space (`clickup_create_space`), a folder (`clickup_create_folder`) and a list (`clickup_create_list`): every create needs approval, at most 5 writes and 2 new spaces per run, and they share the daily write limit. A new space, and what is in it, is visible to every member of that workspace (the bots cannot make it private), it gets one fixed set of ClickUp features, and the account behind the token shows as its creator. The bots cannot delete, rename or move anything, so remove an unwanted space, folder or list in ClickUp by hand. A name is 1-100 characters on one line, without `/ \ [ ]`, and a name that already exists in the same place is refused |
| `GITHUB_APP_ID` `GITHUB_INSTALLATION_ID` | no | the GitHub App (App ID or client ID) and its one installation id (R18). With a key (next row) they turn on the 11 GitHub read tools; a missing or invalid one, or a key file that is too open, keeps only the github group off with one startup alert (R13). Set with `bash scripts/set-tokens.sh GITHUB` |
| `GITHUB_APP_PRIVATE_KEY_PATH` | no | absolute path of the App's `.pem` file. The file must be a regular file, not a symlink, mode `0600` (or `0400`) and owned by the user running the assistant, or startup refuses it (P24). The key is never passed to a child process |
| `GITHUB_APP_PRIVATE_KEY` | no | the PEM text itself (newlines as `\n`) when a file is not practical; `GITHUB_APP_PRIVATE_KEY_PATH` wins if both are set (a leftover `_PATH` silently overrides a newly set `GITHUB_APP_PRIVATE_KEY`: unset the one you do not use). `bash scripts/set-tokens.sh GITHUB` stores the path locally (`env.local`) but sets `GITHUB_APP_PRIVATE_KEY` (the key content, one line) on the VPS |
| `GOOGLE_SHEETS_WEBAPP_URL` `GOOGLE_SHEETS_WEBAPP_SECRET` | no | optional receipt export (M4): an Apps Script web app `https://script.google.com/macros/s/<id>/exec` and its shared secret (sent in the POST body only). Both needed; otherwise the `sheets_append_receipt` tool is not registered. See "Receipts and Google Sheets". Set with `bash scripts/set-tokens.sh SHEETS` |
| `BOT_TOKEN_HQ` `_RND` `_SOFTWARE` `_IT` `_MARKETING` `_SALES` `_HR` `_FINANCE` `_OPS` `_PRAW` | per dept | bot token of each department; a missing token disables that department only |
| `EXECUTOR_SOCKET` | no | absolute path (under 100 characters) of the Unix socket of the separate executor "LW Admin". Unset: server management is off. `npm run dev` sets it when `env.admin` exists, or `/var/lwadmin/run/executor.sock` when the launchd job (`scripts/executor-service.sh`) is installed |
| `EXECUTOR_SOCKET_SHARED`, `LW_DEPLOY_SSH_KEY_PATH` | executor only | set by the launchd plist, never in `env.local` or `env.admin`: `1` = group-gated socket directory (0750) and socket 0660; the absolute path of the ed25519 deploy key (0600, owned by `_lwadmin`; its pinned `known_hosts` sits beside it). Unset key path = VPS deploy is off |
| `BOT_TOKEN_ADMIN` | **never in the app** | the executor's token, in the executor's own environment only (`env.admin` locally). The main application refuses to start if it is set |
| `HEALTH_PORT` | no | health server port, default 8080 |
| `DASHBOARD_PORT` | no | local web dashboard port (127.0.0.1 only, local mode only), default 8787; read from the process env, never from `env.local` |
| `HEALTH_HOST` | no | IPv4 address the health server binds, default `127.0.0.1`. `deploy/docker-compose.yml` sets `0.0.0.0` inside the container and publishes it only as `127.0.0.1:${PORT}:8080` on the host |
| `LOG_LEVEL` | no | `fatal` `error` `warn` `info` `debug` `trace` `silent`, default `info` |
| `PRAW_WORKSPACE_DIR` | no | Praw's sandboxed file workspace (P18), default `data/workspace/praw` relative to the working directory; created with mode 0700. `deploy/docker-compose.yml` sets `/app/data/workspace/praw`, the `praw-workspace` volume. Limits: 1 MB per file, 50 MB and 500 files in total |
| `MEDIA_SOCKET` | no | absolute path of the media sidecar's unix socket (production: `/run/media-ipc/media.sock`). Set: every yt-dlp/ffmpeg child runs in the secret-free `media` sidecar, and if its `GET /v1/health` does not answer after 10 tries 1.5 s apart, music and voice are turned off with "media sidecar unreachable" (one startup alert). Unset: the local binaries are used, on the owner Mac only; in a container they are refused and music and voice are off with "media sidecar not configured". A relative path stops the boot |

## Deploy with lw-git

Files in `deploy/`: `Dockerfile` (multi-stage, base `node:22-alpine` pinned by digest, `npm ci --omit=dev --ignore-scripts`, non-root `node` user, `CMD node dist/main.js`), `docker-compose.yml` (overlay: `init: true` (a tiny init as PID 1 reaps the zombie node children left when a yt-dlp process group is killed), `read_only`, tmpfs `/tmp`, named volume `praw-workspace` at `/app/data/workspace/praw` for Praw's workspace (the image creates that directory owned by `node`, mode 0700, so the fresh volume inherits it), `pids_limit`, `mem_limit 512m`, `cap_drop ALL`, `no-new-privileges`, restart `unless-stopped`, node-based healthcheck, health port published on host loopback only as `127.0.0.1:${PORT}:8080`; the final image has no npm/npx/corepack/yarn), `app.conf` and `deploy.yml` (patterned on `infra/vps/files/lw-git/apps/apps-admin/`).

**Parent infra overlay.** The production compose in the parent repo (`infra/vps/files/lw-git/apps/apps-assistant/docker-compose.yml`) is a separate file and needs the same two things this overlay has: `init: true` (otherwise zombie node children of killed yt-dlp groups pile up under PID 1, and `pids_limit: 128` eventually bites) and the `praw-workspace` named volume mounted at `/app/data/workspace/praw` (from M2; without it `write_file` fails on the read-only root).

Registration is a devops step in the parent repo: copy `deploy/app.conf` to `infra/vps/files/lw-git/apps/Assistant/app.conf` (set the real `REPO` URL and deploy key), and the compose and `deploy.yml` next to it, then `lw-git` builds `lw-local/apps-assistant:<sha>` on the server and deploys on each new commit. Check with `lw-git status`.

Open points for devops to confirm on the server with `lw check-compose` / `lw validate`: the health port mapping `127.0.0.1:${PORT}:8080` satisfies the lw loopback-publish policy and `deploy.yml` `health: /healthz` probes it. Also confirm that `shared/.env` `DATABASE_URL` overrides the platform's default `DATABASE_URL`.

Migrations run automatically on every boot (the app applies `db/migrations` before it connects to Discord), so a deploy needs no separate migration step. After a deploy: `docker ps` shows the container `healthy`, and every enabled head shows online in Discord.

## Media binaries (P22)

Voice and music (M5) use two binaries baked into the image, each pinned by version (amd64, arm64 builds). yt-dlp is pinned by sha256 per architecture, with the same pins in `deploy/Dockerfile` (build ARGs) and in `PINNED_BINARIES` in `voice/binaries.ts` (a unit test keeps them equal); ffmpeg is pinned by its signed source (below) and checked against the hash manifest its build writes. Nothing updates them at runtime: yt-dlp is never run with `-U`.

- **yt-dlp** `2026.10.26`, official onedir build `yt-dlp_musllinux[_aarch64].zip`, installed at `/opt/yt-dlp` (executable `/opt/yt-dlp/yt-dlp`). The one-file build is not used: it unpacks about 96 MB of shared objects into TMPDIR, and the container's 16 MB noexec `/tmp` refuses that. At build time the release's `SHA2-256SUMS` must carry a valid signature from the yt-dlp signing key, fingerprint `AC0CBBE6848D6A873464AF4E57CF65933B5A7581` (the key is committed as `voice/yt-dlp-signing-key.asc`). The zip must appear in that file with the pinned sha256, and the unpacked tree must match the pinned tree hash.
- **ffmpeg** `9.0.2`, built in the image from the release tarball `https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz` (Gate 2 G2-01). Why a source build: Alpine's 8.1.3 carries unpatched HIGH CVEs, and the BtbN "static" builds are glibc-dynamic (they need `ld-linux-*.so` and do not run on musl). The `ffmpeg` stage of `deploy/Dockerfile` imports the FFmpeg release signing key from `voice/ffmpeg-release-key.asc`, asserts its fingerprint `FCF986EA15E6E293A5644F10B4322F04D67658D8` (`FFMPEG_SIGNER_FPR`), verifies the detached `.asc` signature of the tarball (VALIDSIG with that fingerprint), and checks the tarball against the pinned `FFMPEG_TAR_SHA256`. Any mismatch fails the build. The key fingerprint was cross-checked on 2026-11-01 against `https://ffmpeg.org/download.html` and the public keyservers keys.openpgp.org and keyserver.ubuntu.com. It is configured with `--disable-everything --disable-autodetect --disable-network --enable-static --disable-shared`, `-static` LDFLAGS, and only: protocol `pipe`; demuxers `matroska` (covers webm), `mov` (mp4, m4a, 3gp, 3g2, mj2) and `mp3`; decoders `aac`, `mp3`, `mp3float`, `opus`, `vorbis` with their parsers; the `aresample`, `aformat`, `anull` and buffer filters; the `pcm_s16le` muxer (`-f s16le`) and encoder. ogg is not built: yt-dlp's `-f bestaudio/best` for YouTube gives webm, m4a or mp4, and Edge TTS gives mp3. The result is a single static (static-pie) binary `/opt/ffmpeg/ffmpeg` (0755 root). The build fails (an `if ... exit 1`, not a `!` pipeline) if the binary has a dynamic interpreter or any NEEDED entry, if `-version` does not start with `ffmpeg version 9.0.2 `, or if the `-demuxers/-decoders/-muxers/-encoders/-protocols` lists are not exactly the set above. It then runs the S9 smoke with the production argv (`buildFfmpegArgs`) on `voice/fixtures/ffmpeg-smoke`: the mp3 must decode to PCM, and a WAV and two HLS playlists (one with an `http://`, one with an `rtsp://` segment) and direct `http://` and `rtsp://` inputs must be refused.
  - **Trust model.** Source integrity is the GPG signature plus the pinned tarball sha256. The compiler is Alpine's signed apk toolchain (`build-base`, `nasm`, `gnupg`, ... installed unpinned into the build stage from the Alpine 3.24 repository; for the current build gcc 15.2.0 and the musl of that repository), so the binary is not bit-for-bit reproducible across Alpine toolchain updates and no fixed binary hash is compiled in. Instead the build writes `/opt/ffmpeg/ffmpeg.sha256` (root-owned, mode 0444) and the boot check (`voice/binaries.ts`) takes the expected hash from that file, which must exist, be a regular file (no symlink), be root-owned, not be group- or world-writable, and match the binary, or ffmpeg is reported mismatched and music and voice go off. That guards against tampering with the binary after the build, not against a compromised build toolchain. yt-dlp keeps its compiled-in pins.
  - **Last reproducible hashes (informational, not enforced):** arm64 `1a1654dd3108a1b508f680e97daf5bf74f82409148a2a69d0cdd970b2b56281b`, amd64 `537d561be94dbf072323143b72bfad38ac012a1eaf63f7c0b40109b725be1932` (two `--no-cache` builds per architecture matched on 2026-11-01; the Dockerfile prints `ffmpeg binary <arch>: <sha256>` on every build, so a change after an Alpine update is visible in the log).
  - **Residual risk:** CVE-2026-107696 (ffmpeg through 9.0.2, RTSP) is accepted by the owner (2026-11-01): RTSP is not compiled in and every invocation passes `-protocol_whitelist pipe` with `-i pipe:0`. The acceptance is void if `-protocol_whitelist` changes, another input route is added, or ffmpeg is upgraded past the affected range without a re-check.
- **Legacy builder.** lw-git builds with `DOCKER_BUILDKIT=0`, which sets no `TARGETARCH`: every stage derives the architecture from `${TARGETARCH:-}` with a `uname -m` fallback (x86_64 is amd64, aarch64 is arm64, anything else is refused), and the Dockerfile uses no heredocs or BuildKit-only flags (a unit test keeps it that way).
- **Scan note (S10).** syft v1.55.0 does not catalogue `/opt/ffmpeg/ffmpeg` (a hand-built static binary), and grype 0.120.0 on the final image shows no ffmpeg, glib, cjson or alsa-lib rows (only python 3.14.10 and busybox Medium/Low). That is absence of evidence, so the Gate 2 ffmpeg CVEs are checked by hand against the 9.0.2 source and the minimal configuration:

  | CVE | Sev. | Component | Fixed in | In our 9.0.2 build |
  |---|---|---|---|---|
  | CVE-2026-96611 | High | `libavformat/mov.c` `mov_read_ispe` (HEIF) | 9.0 | mov demuxer is compiled in; patched in 9.0.2 |
  | CVE-2026-52297 | High | `mov.c` `mov_read_iacb` extradata padding | 9.0 | mov demuxer is compiled in; patched in 9.0.2 |
  | CVE-2026-70632 | High | CFHD decoder (AVI probing) | 9.0 | decoder not compiled; AVI demuxer not compiled |
  | CVE-2026-70628 | High | `dvbsub_parser.c` (mpegts / WTV DVB subtitles) | 9.0 | parser not compiled; WTV demuxer not compiled |
  | CVE-2026-52296 | High | `wmaenc.c` extradata | 9.0 | encoder not compiled |
  | CVE-2026-107696 | High | RTSP redirect loop, `rtsp.c` | none (through 9.0.2) | RTSP not compiled (`--disable-network`); owner-accepted, see above |

  Bundled libraries: none. `--disable-autodetect` links no external library (no zlib, no libc++, no codec libs); the `-buildconf` libraries are FFmpeg's own `libavutil 61.1.102`, `libavcodec 63.1.102`, `libavformat 63.1.102`, `libavfilter 12.1.102`, `libswscale 10.1.102`, `libswresample 7.1.102`, plus musl libc linked statically (Alpine 3.24 toolchain, gcc 15.2.0). The build fails on an interpreter or a NEEDED entry. Image size 657 MB to 507 MB (arm64).
- **Boot check.** Each binary must exist, match its pin and answer its version command (run with `childEnv()`, never the parent env). A binary with the wrong hash is never executed. A missing or mismatched yt-dlp turns off the `music` group. A missing or mismatched ffmpeg turns off `music` and `voice`. Either way they are listed in the one "Tool groups disabled" alert, and the rest of the boot continues.
- **Voice library.** `@discordjs/voice` `0.19.2` with DAVE (Discord's end-to-end voice encryption, required since 2026-03-02) through `@snazzah/davey` `0.1.12` (prebuilt N-API, musl x64/arm64). Transport encryption uses `aes-256-gcm` from `node:crypto`, so no sodium package is installed. Opus uses `opusscript` `0.0.8` (WebAssembly, no native build and no install-time download) through `prism-media` `1.3.5`. Praw never stays in a voice channel without DAVE. Only Praw's client has the `GuildVoiceStates` intent. Grant Connect and Speak on the voice channel or category only, never guild-wide.

**Bump procedure** (owner or devops, never automatic):

1. yt-dlp: choose a release tag `T`. Download `SHA2-256SUMS`, `SHA2-256SUMS.sig`, `yt-dlp_musllinux.zip` and `yt-dlp_musllinux_aarch64.zip` from `https://github.com/yt-dlp/yt-dlp/releases/download/T/`. Run `gpg --verify SHA2-256SUMS.sig SHA2-256SUMS` with `voice/yt-dlp-signing-key.asc` imported, and check that the fingerprint is still the one above. If the key changed, stop and confirm the new key from the yt-dlp README before trusting it. Unzip each zip and rename `yt-dlp_musllinux*` to `yt-dlp`. In that directory, the tree hash is `find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum`.
2. ffmpeg: choose a release `V` from `https://ffmpeg.org/releases/`. Download `ffmpeg-V.tar.xz` and `ffmpeg-V.tar.xz.asc`, run `gpg --verify` with `voice/ffmpeg-release-key.asc` imported, and check that the signing fingerprint is still the one above and matches `https://ffmpeg.org/download.html`. If the key changed, stop and confirm the new key from two independent sources before committing it. Record `shasum -a 256 ffmpeg-V.tar.xz` as `FFMPEG_TAR_SHA256` and set `FFMPEG_VERSION=V` in both places (stage and final stage) and `PINNED_BINARIES.ffmpeg.version`. If the new release changes the `-version` banner or the compiled-in lists, update the checks in the stage and the `music.test.ts` lists together. There is no binary hash to pin: note the `ffmpeg binary <arch>: <sha256>` build-log lines in the commit message.
3. Update the version, zip sha256 and tree sha256 ARGs for yt-dlp in `deploy/Dockerfile` and `PINNED_BINARIES` in `voice/binaries.ts` together. Then run `npx vitest run voice/binaries.test.ts` and both `DOCKER_BUILDKIT=0 docker build -f deploy/Dockerfile .` (what lw-git runs) and `docker build --platform linux/amd64 -f deploy/Dockerfile .`. In the built image, `node -e "import('/app/dist/voice/index.js').then(async v => console.log(await v.bootBinaries()))"` must print `{ check: { ok: true }, ... }`.
4. The node base image digest bump (D24) moves the Alpine release; rebuild and read the new `ffmpeg binary` hashes from the log (informational) and run step 3.

## Media sidecar — deploy and live checks

The `media` service (Praw media sidecar: yt-dlp + ffmpeg, `node dist/media/main.js`) holds no secret, so it needs the `lw` isolated mode on the server before its first deploy. Local proof first: `deploy/acceptance/run.sh` (see `deploy/acceptance/README.md`) builds the image with the legacy builder, renders this compose through the real `lw_check.py` + `lw_override.jq`, and checks AC1, AC2, AC4 and Gate 1 S1/S5/S8/S9/S12/S13 (local parts) in two containers. What only the VPS can show is below. Run it in this order; stop at the first failure.

**1. Platform first (devops, root on the VPS).** Install `lw`, `lw_check.py`, `lw_override.jq`, `lw_s13.py` and `media-egress.env` together with `infra/vps/40-platform.sh` (never `lw` alone: the new `lw` builds every compose override from `/usr/local/lib/labworkspace/lw_override.jq`). Then load the S13 rules (in the input chain, `ip saddr 10.213.0.0/24 ct state new drop` before every accept; in the forward chain, a DNS accept, then a drop of NEW connections to every private range), following the firewall procedure in `infra/OPERATIONS.md`: first sync the updated `infra/vps` tree (with the new `13-firewall.sh`) to the server's repo checkout; then, as root, `bash infra/vps/13-firewall.sh` (it applies the new ruleset with a 120 s auto-rollback); open a FRESH ssh login from outside; and within the 120 s run `bash infra/vps/13-firewall.sh --confirm` (`--confirm` alone only keeps what is loaded, it never loads new rules). Check them with `nft list table inet lw_filter | grep S13` (three lines). DNS exception: `resolvectl status` (or `/run/systemd/resolve/resolv.conf`) lists the upstream resolvers that Docker's embedded DNS forwards to; if every upstream is a public address, the forward-chain `S13: media-egress DNS` accept is not needed and may be removed (re-gate the change); if one is private, keep it. Then run `infra/vps/tests/p4-platform-check.sh`: every line PASS, including the `C11 isolated ...` lines.

**2. Env-key clash check.** `lw env keys apps/assistant` must list neither `NODE_ENV` nor `MEDIA_SOCKET` (nor any other key that `media` sets in `environment`). `lw_check` refuses an isolated service whose env key is also in `shared/.env` or the db env (Gate 1 S4), so a clash stops the deploy before `up`; remove the key with `lw env unset apps/assistant KEY` first. The local kit proves that refusal (`S4 shared/.env NODE_ENV clash refused`).

**3. Render check, then the app.** `lw-deploy --check` on the overlay compose (`infra/vps/files/lw-git/apps/apps-assistant/docker-compose.yml`) must pass. lw-git builds only `main` (`app.conf` `BRANCH=main`), so nothing on `feat/praw` reaches the server by itself: the real trigger is the merge of `feat/praw` into Assistant `main`, after which `lw-git-sync.timer` (every 2 min) builds and deploys the new commit (`lw-git status` shows the build; the build log prints `ffmpeg binary <arch>: <sha256>`). Once the overlay is installed, every later commit on `main` deploys the same way. `docker ps` must show `lw-apps-assistant-media-1` healthy before `lw-apps-assistant-assistant-1` starts (`depends_on: service_healthy`), and the boot log must not carry `media sidecar not configured` or `media sidecar unreachable`. If `media` exits 78, its log names the env keys it refused (names only); lw's health check fails and the deploy rolls back to the previous release. A refused key that nobody set (for example `SHLVL`/`PWD`, which a shell entrypoint adds, or `UV_USE_IO_URING`, which node adds to itself under emulation) means the runtime changed the environment: stop and re-gate, never widen `ENV_ALLOW` to make it start.

S13 deploy interlock: `lw deploy` refuses (before `activate`, nothing started) any compose release with an `lw.isolated: "true"` service on a network whose subnet is the media-egress net (`10.213.0.0/24`, defined once in `infra/vps/files/lw/media-egress.env`, read by both `13-firewall.sh` and `lw`) unless `nft list table inet lw_filter` holds both S13 drops (input and forward, matched by their comments) and `lw-fw-rollback.timer` is inactive (a pending rollback means the rules are not confirmed yet). It fails closed when `nft` is missing. The refusal starts with `S13 interlock:`, says which part is missing (table, input drop, forward drop, timer state, `nft`) and names step 1 of this section: do step 1, then retry with `lw-git sync apps-assistant --force` (lw-git records the refused sha as `last_failed` and the timer never retries it; only a new commit or `--force` does). A refusal happens before `activate`, so the live release keeps running untouched. This holds on every redeploy, so a merge to `main` before step 1 is refused instead of bringing `media` up with the firewall open.

Full order on the VPS (Gate 2 handoff; stop at the first failure):
1. commit the parent infra changes (`lw`, `lw_check.py`, `lw_override.jq`, `lw_s13.py`, `media-egress.env`, `13-firewall.sh`, overlay, tests) and sync `infra/vps` to the server's checkout;
2. `bash infra/vps/40-platform.sh` (installs `lw`, `lw_check.py`, `lw_override.jq`, `lw_s13.py` and `media-egress.env` together);
3. `bash infra/vps/13-firewall.sh`, a FRESH ssh login from outside, then `bash infra/vps/13-firewall.sh --confirm` within 120 s;
4. `nft list table inet lw_filter | grep S13` shows 3 lines, and `systemctl is-active lw-fw-rollback.timer` prints `inactive` (the interlock accepts nothing else: `active` and `failed` refuse);
5. `infra/vps/tests/p4-platform-check.sh`: every line PASS;
6. `lw env keys apps/assistant` has no `NODE_ENV` and no `MEDIA_SOCKET` (step 2 above);
7. check the live release (below), then merge `feat/praw` into Assistant `main`;
8. `bash infra/vps/41-git.sh` (installs the apps-assistant overlay + `app.conf`); `lw-git-sync.timer` then deploys.

Live release and rollback target (before the merge): `lw deploy` rolls back by itself when the new release fails health (it re-activates the release that was current, with nobody involved, and lw-git triggers the deploy from its timer). So whatever is live now is the automatic rollback target. If that release is a pre-sidecar build (local ffmpeg 8.1.3 inside the secret-holding `assistant` container), a failed first sidecar deploy silently brings G2-01/G2-02 back. Before merging, check it (read-only): `readlink /srv/labworkspace/apps/assistant/current`, `ls /srv/labworkspace/apps/assistant/releases`, `docker image ls lw-local/apps-assistant`, and for the live image `docker run --rm --entrypoint sh IMAGE -c 'ls -l /opt/ffmpeg /opt/yt-dlp; /opt/ffmpeg/ffmpeg -version | head -1'`. If it is a pre-sidecar build, watch the first deploy after the merge (`lw-git status`, `lw-git log apps-assistant`). If lw rolled back (`rolled back apps/assistant to ...`), run `systemctl stop lw-apps-assistant` at once and keep it stopped (music, voice and the bot stay off) until a fixed sidecar release deploys healthy. Never `lw rollback apps/assistant` to a pre-sidecar release. An S13 interlock refusal is not a rollback: it happens before `activate` and leaves the live release as it was.

**4. AC1 on the server.** `lw env set apps/assistant ZZ_MARKER` (any throwaway value on stdin), redeploy, then:
- `docker exec lw-apps-assistant-assistant-1 sh -c 'tr "\0" "\n" </proc/1/environ | cut -d= -f1' | grep -c ZZ_MARKER` is 1 (positive control);
- `docker exec lw-apps-assistant-media-1 sh -c 'cat /proc/[0-9]*/environ 2>/dev/null | tr "\0" "\n"' | grep -E 'ZZ_MARKER|BOT_TOKEN_|GEMINI_API_KEY|DATABASE_URL|CONFIG_MASTER_KEY|^DB_'` prints nothing;
- `docker exec lw-apps-assistant-media-1 ls /proc` lists only the media pids (docker-init, node, the exec itself);
- `docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' lw-apps-assistant-media-1 | cut -d= -f1` lists only `ENV_ALLOW` keys (`PATH HOME HOSTNAME TERM LANG TMPDIR NODE_ENV NODE_VERSION YARN_VERSION MEDIA_SOCKET YTDLP_COOKIES_FILE`).
Then `lw env unset apps/assistant ZZ_MARKER` and redeploy.

**5. S13 host ports (VPS only; Docker Desktop on a Mac has no host firewall, so the local kit cannot show these).** From `media`, each of these must fail (`nc` is busybox; exit 1 = closed): `docker exec lw-apps-assistant-media-1 nc -zw2 172.30.0.1 443`, the same for `172.30.0.1 4231` (Postgres), `172.30.0.1 22`, `172.30.0.1 2222`, the File Browser bridge port (`lw ports`), and the same ports on the media-egress gateway `10.213.0.1` and on the host's public IP. The assistant health port must fail too: `docker exec lw-apps-assistant-media-1 nc -zw2 <assistant container IP> 8080`; Docker Engine 29 (tested locally) accepts a published port from other bridge networks and the input-chain S13 drop does not see forwarded traffic, so `13-firewall.sh` also drops NEW connections from `10.213.0.0/24` to every private range in the `lw_filter` forward chain (after a DNS accept, before every other rule). If it connects, the firewall is not applied: stop (IP from `docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' lw-apps-assistant-assistant-1`). `infra/vps/tests/p4-platform-check.sh` runs all of these as its `S13 ...` lines once apps/assistant is deployed. Outbound HTTPS must work: `docker exec lw-apps-assistant-media-1 node -e "fetch('https://www.youtube.com/',{method:'HEAD'}).then(r=>console.log(r.status))"`. Positive control for the drops: the `S13` counters in `nft list table inet lw_filter` (input for host ports, forward for container IPs) go up after the `nc` runs.

**6. AC6 live (owner, in Discord, Praw in a voice channel).** Keep `watch -n0.5 docker exec lw-apps-assistant-media-1 ps -o pid,pgid,comm,args` open next to Discord.
- Play a track: `ps -o pid,pgid,comm` in `media` shows `yt-dlp` and `ffmpeg` (one process group each, plus yt-dlp's `node` challenge child); `docker exec lw-apps-assistant-assistant-1 ps -o pid,args` shows no ffmpeg and no yt-dlp (S12).
- Skip, then `/halt`, then make Praw leave: after each, within 2 s, `media` shows no `yt-dlp`, `ffmpeg` or child `node` (only docker-init and `node dist/media/main.js`).
- TTS: Praw speaks a voice-chat reply (the decode route; `ps` in assistant still shows no ffmpeg).
- DAVE stays enforced: no `dave-missing` / `dave-downgraded` drop in the log, and Praw stays connected.
- Volume and queue behave as before (`/volume`, `/queue`, a second `/play` queues, `/skip`, `/stop`; a restart brings the queue back paused).

**7. AC3 on the VPS architecture.** syft (`anchore/syft:v1.55.0`) and grype on `lw-local/apps-assistant:<sha>`: no ffmpeg, glib, cjson or alsa-lib row; the remaining rows are only the accepted residuals listed in the Task 8 acceptance report (python inside the yt-dlp onedir bundle and busybox Medium/Low). `deploy/acceptance/scan.sh IMAGE` does both.

**Owner lines (Gate 1 S14), to be recorded in the Gate 2 re-review:**
- CVE-2026-107696 (ffmpeg through 9.0.2, RTSP redirect loop) is accepted by the owner (2026-11-01): RTSP is not compiled in and every invocation passes `-protocol_whitelist pipe` with `-i pipe:0` (see Media binaries (P22)).
- Q4 cookies carve-out: `YTDLP_COOKIES_FILE` stays unset. With YouTube cookies the sidecar holds a credential, so enabling it needs a security re-gate or an explicit owner accepted-risk line first.
- Open item from Task 6: a read-only bind of a `shared/` file that another service writes is not covered (owner or re-gate before using one).
- Scan residuals (grype, both arches, 2026-11-01), each needing an owner accepted-risk line: busybox 1.37.0-r31 CVE-2025-60876 (Medium, no fix; busybox, busybox-binsh, ssl_client) and the python 3.14.10 bundled in the pinned yt-dlp onedir, CVE-2025-15367 (Medium) and CVE-2026-103995 (Low). `deploy/acceptance/scan.sh` fails on any other Medium-or-higher CVE and on any High/Critical.
- M-3 (final review): the `media-ipc` volume is a disk-backed named volume, read-write for uid 10001 in `media`; a compromised ffmpeg/yt-dlp could fill the host disk that Postgres and every app share (not a secret path; lw refuses tmpfs volume driver options today). Owner accepted-risk line, or a later lw change that allows an exact tmpfs-driver form.
- M-8 (final review): `13-firewall.sh` applies the whole `inet lw_filter` table from the parent working tree, so the S13 apply also ships the other uncommitted firewall work in it (RDP on-demand sets, team ssh on :2222, Caddy 443 from 172.30.0.0/16, the lw-remote restore). Review the full diff (`nft list table inet lw_filter` before, against the rendered `/etc/labworkspace/nftables/lw_filter.nft` after) before `--confirm`.
- Any other residual that the Gate 2 scan lists needs its own owner line.

## Operations

### Health and logs

- Health: `docker exec <container> node -e "fetch('http://127.0.0.1:8080/healthz').then(async r=>console.log(r.status, await r.text()))"` returns 200 with `{db, clients, halted, provider, offDay}`, or 503 when the database is unreachable.
- Logs: `docker logs -f --tail 200 <container>`. Structured JSON; tokens, keys, webhook URLs and database passwords are masked.

### Out-of-band halt (when Discord or the bot is unreachable)

Two independent ways; use both if in doubt.

1. Stop the process: `docker stop <container>` (graceful; `doing` tasks are recovered on the next boot, and a halted flag stops that recovery).
2. Set the halted flag in the database so a restart stays halted and every running loop stops:

```sql
-- psql -U assistant -d assistant
UPDATE config SET value = 'true'::jsonb, version = version + 1, updated_by = 'ops-psql', updated_at = now() WHERE key = 'halted';
SELECT pg_notify('config_changed', 'public:halted');
```

If the `halted` row does not exist yet, insert it instead: `INSERT INTO config (key, value, updated_by) VALUES ('halted', 'true'::jsonb, 'ops-psql');` followed by the same `pg_notify`. The notification is only a hint; the service re-reads the row. A database read error or a dead LISTEN connection also counts as halted. A halt set this way takes effect live. Do **not** resume by writing `'false'::jsonb` with psql while the process runs: the watcher ignores `false` by design, so the resume steps never run (work blocked by the halt and approvals granted meanwhile stay parked), and a process halted with `/halt` keeps a local latch (fail-safe) and stays halted. Resume with `/resume` in `#⚙️-setting`; if Discord is unavailable, write `'false'::jsonb` with the same statement and restart the container (`lw restart apps/assistant`), whose boot recovery picks the work up again. On resume, work that was running when the halt hit is picked up again; tasks blocked for another reason (budget, approval, turn limit, provider error) stay blocked. If the headquarters bot is offline for more than 60 s all agent loops pause on their own, including a run in progress before its next model call, and continue when it is back.

### Web reading grant (WEBGRANT-1, `docs/security/2026-11-08-gate1-web-grant.md`)

- After a run has read outside content, `fetch_page` asks per URL it has not seen. A per-URL card (or a batch card whose members are all `fetch_page`) now has a button "Allow web reading for this task tree" (batch: "Approve all + allow web reading"). One Bot Admin click approves that card and lets every department in the task tree read pages with no further cards, for `web.taskGrant.hours` (4 h), up to `web.taskGrant.maxFetches` (20) pages on `web.taskGrant.maxHosts` (5) hosts and `web.taskGrant.maxUrlChars` (4000) characters of path + query summed over the pages. Only `fetch_page`; writing, sending, deploying and `web_search` still ask every time.
- The button appears only when the card shows the whole URL and the URL looks like a plain page address (https, no port, no userinfo, short words, no tokens, IDs, hex or credential shapes). Any other URL still gets its card with `web grant not applied: <rule>` in the reason.
- A tricked bot can send up to about `maxUrlChars` characters of what it read in the task tree to sites it picks, without asking. The card says so. Revoke with the "Revoke web reading" button on the card. `/halt`, a psql halt, a read fault and a boot after a halt all revoke every grant; resume does not restore them. `web.taskGrant.enabled = false` stops live grants at once. These keys are owner-only (not writable by the admin console); the boot refuses `maxHosts > maxFetches`.
- Kill switch from psql (the row may not exist yet, so upsert it; the `pg_notify` makes it live without a restart; the value must be the JSON boolean `false`, an invalid value is ignored and the switch stays on):

```sql
INSERT INTO config (key, value, updated_by) VALUES ('web.taskGrant.enabled', 'false'::jsonb, 'ops-psql')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, version = config.version + 1, updated_by = EXCLUDED.updated_by, updated_at = now();
SELECT pg_notify('config_changed', 'public:web.taskGrant.enabled');
```

  From Discord, `/halt` (revokes every grant) and the per-card "Revoke web reading" button are the stops.

### Company autopilot (AUTO-2, `docs/security/2026-11-12-gate1-autopilot-company.md`)

- With `autopilot.enabled = true` and `autopilot.scope = 'company'`, calls that need approval run at once with no card in every open task tree that has no project (any status) and no outside origin (`watch`, `import`, `poll`). That includes plain chat with Praw or a head (the conversation task carries the call) and `ws_run`/`ws_export` from chat. Dangerous work still gets a card: hard-deny classes, the always-card list, own approval reasons not on the waive list, tainted `write_file`, and any tree in a paused, exhausted, past-deadline or closed project. Spend limits still apply.
- Caps (owner-only, psql): `autopilot.company.maxApprovalsPerTree` (80), `autopilot.company.maxApprovalsPerDay` (600), `autopilot.company.maxApprovalsPerPersonDay` (200). At a cap the call goes to the card path and bot-log gets one notice per day.
- Switch from Discord: `/settings set autopilot.scope company|project` (Bot Admin). Halt, `autopilot.enabled = false` and `project` stop company decisions at once. `/project list` shows the scope.
- One-off deploy flip (run once after the 043 migration is deployed and the service restarted; revert with `"project"` or the `/settings` command):

```sql
BEGIN;
INSERT INTO config (key, value, updated_by) VALUES ('autopilot.scope', '"company"'::jsonb, 'owner-decision:AUTO-2')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, version = config.version + 1, updated_by = EXCLUDED.updated_by, updated_at = now();
INSERT INTO audit_log (actor, action, tool, outcome) VALUES ('system:deploy', 'config.set', 'autopilot.scope', 'ok company (owner decision 2026-11-12, AUTO-2)');
COMMIT;
SELECT pg_notify('config_changed', 'public:autopilot.scope');
```

### Off days and holidays

- Off days are Saturday and Sunday by default (`schedule.offDays`) plus the dates in `schedule.holidays`, judged in `schedule.timezone` (default Asia/Bangkok, so the day turns at 00:00 Bangkok time). Changes apply without a restart.
- On an off day automated work stops; people can still talk to every bot. Runs started by a human (chat, slash commands, `/ask`, voice, a goal for the CEO) run as usual. Tasks of any other origin (delegated, schedule, import, ...) stay `todo` and start on the next workday; a head that delegates during a chat is told so and can say it. Roll-ups and bot-to-bot messages wait in memory and start when the day turns, or after `/resume` if the system is halted then. After a restart on an off day, a Praw conversation keeps waiting in `review` and its last finished subtask is rolled up on the next workday; other held bot messages are dropped, and their task is picked up again by recovery. Bot-to-bot messages inside a thread a human started still run. ClickUp change notices (no model) are not paused.
- A scheduled job occurrence that falls on an off day is skipped (one `schedule.skip` audit row, outcome `off day`), not caught up later; a one-off job on an off day is gone. Watches are not checked on off days and resume on the next workday. Reminders fire on time. `/halt` is separate and unchanged.
- Commands (Bot Admin, `#⚙️-setting`, audited): `/holiday add date:2026-12-31 name:New Year Eve`, `/holiday remove date:2026-12-31`, `/holiday list` (weekly off days and the next 20 holidays), `/holiday weekdays days:sat,sun` (`fri,sat`, or `none` for no weekly off day; the option is required).
- `/healthz` reports `offDay` (and `offDayReason`: `weekday` or `holiday`). The log has one info line at boot and one each time an off day starts or ends.

### Budget and approval semantics

- Every model call reserves its worst-case cost first and settles the actual usage afterwards. If the provider fails in the middle of a stream before it reports usage, the reservation is released at $0 (R21): tokens the provider may still bill for that partial call are not metered, so `/usage` can read slightly low after provider errors.
- A task tree may spend `budget.taskUsd` (default $0.50) on its own. An approved estimate approval (a `create_task` above `approval.thresholdUsd`) adds its estimate to the tree's cap, so the approved task can spend it without a second approval; when the tree still runs out, a tree-cap approval for a higher cap is requested. The cap is the larger of the highest approved tree cap and `budget.taskUsd` plus all approved estimates in the tree (R33). Pending, rejected and expired approvals add nothing.

### GitHub write tools (AC10)

- `github_create_branch`, `github_create_or_update_file` and `github_create_pull_request` always need a Bot Admin's approval. They write only to `praw/<name>` branches the bot creates from the default branch, never to the default branch, never under `.github/`, and open pull requests into the default branch (people merge).
- A repository is writable only after `/github allow action:add repo:<owner/repo>` in #⚙️-setting (Bot Admin). The bot resolves it through the App and stores its id; `action:remove` takes it off. Each call (before the approval card and again when the approved call runs) re-resolves the id and canonical name, requires the installation account as owner, and refuses the hard denylist: every lw-git `REPO=` source, `Lab-Work-Space/labworkspace-infra`, `Assistant`, `Discord_bot`, and any name matching `infra|deploy|secrets`.
- The denylist is `tools/plugins/github/deploy-repos.json`. After `lw add` or any `infra/vps/files/lw-git/apps/*/app.conf` change, run `node scripts/gen-deploy-denylist.ts` (reads `LW_INFRA_DIR`, default `../infra`) and commit it together with `tests/fixtures/lw-git-repos.txt`. This is a second layer: L13 (selected-repository installation) still applies.

### Music (M5, Task 36)

`/play <song or YouTube link>`, `/skip`, `/queue`, `/stop`, `/volume <0-150>` and the tools `music_play`, `music_queue`, `music_skip`, `music_stop`, `music_volume` run on Praw's music player. The requester must be in a voice channel; Praw joins it when she is in none (Connect and Speak on that channel). The commands act directly (no model call) after the usual Praw guard: denied channels refused, one rate-limit slot per interaction. The write tools follow the central approval rule: a person talking straight to Praw plays at once, voice and delegated runs ask first.

- **Input (P7).** A link must be https (http is upgraded) with an exact host from `media.ytHostAllowlist` (default `youtube.com`, `www.youtube.com`, `m.youtube.com`, `music.youtube.com`, `youtu.be`), no user name, password or port. Anything else that is not a link is a YouTube search (`ytsearch1:`). The value is always the last argument, after `--`, and nothing is ever run through a shell.
- **yt-dlp flags.** Fixed: `--ignore-config --no-plugin-dirs --no-exec --no-playlist --no-cache-dir --no-write-info-json --no-write-thumbnail --no-write-subs --no-write-comments`, `--max-filesize 52428800`, `--match-filters duration<=1200` (20 minutes; a live stream has no duration and is refused), `--use-extractors youtube,youtube:search` (search needs the `youtube:search` extractor; the generic extractor is never loaded), `--no-js-runtimes --js-runtimes node:<the app's node> --no-remote-components` (YouTube's challenge runs in the bundled yt-dlp-ejs under the image's own node with `--experimental-permission`; no deno, nothing downloaded), `--downloader native --fixup never` (yt-dlp never starts an ffmpeg of its own), `-f bestaudio/best -q -o -`. Never `-U`.
- **Pipeline.** yt-dlp writes the media to stdout, our ffmpeg reads it with `-protocol_whitelist pipe -i pipe:0` and writes raw PCM to the voice session. Both run with `childEnv()` (private HOME per call, no parent env), shell off, in their own process group with a wall-clock timeout and stdout caps. The group (yt-dlp's node child included) is killed on `/skip`, `/stop`, timeout, leaving voice and `/halt`.
- **Queue.** At most 50 tracks, stored in `music_state` (migration 010) with the volume and a paused flag. A restart restores the queue paused: Praw does not rejoin by herself, and the next `/play` resumes it. Leaving voice (also `/halt`, a kick or a DAVE drop) clears the queue; a restart does not.
- **Cookies (optional).** YouTube may ask server IPs to sign in. Set `YTDLP_COOKIES_FILE` to the absolute path of a Netscape cookies file from a **throwaway account that is not the owner's**, mounted read-only, mode `0600`, owned by the app user, never in the image (`.dockerignore` excludes `*cookies*`). yt-dlp only ever gets a per-call copy inside its private HOME on the tmpfs, deleted when it exits.

### Voice chat (M5, Task 37)

`/voice join` makes Praw join **the voice channel you are in** (never another one, never a denied channel, one channel at a time; Connect and Speak on that channel). `/voice leave` works from any channel, for anyone. Both pass the usual Praw guard and take one rate-limit slot.

- **Where the data goes.** The speech of the people Praw listens to goes to **Google** (Gemini, `voice.stt` = `gemini`) for transcription, through the same metered path as OCR: it is reserved and settled against the budgets, audited as `llm.call` and shown in `/usage`. Praw's reply text goes to **Microsoft** for speech: Edge TTS (the unofficial Read Aloud service of Microsoft Edge, through the pinned `msedge-tts` `2.1.1` package, one WebSocket per reply to the fixed endpoint `speech.platform.bing.com`; nothing user-controlled chooses the host). The service is undocumented and can change or stop without notice; when TTS fails, the reply is posted as text in the channel instead. On join, Praw posts a notice in the text channel saying this.
- **Who is heard (opt in).** Only the member who ran `/voice join` and members who press the opt-in button on the join notice. The button is tied to that session. Everyone else's audio and every bot's audio is discarded without being decoded.
- **Privacy.** DAVE (Discord's end-to-end voice encryption) is required: if it cannot be negotiated, or is lost, Praw leaves. Audio, transcripts and the spoken replies live in memory only and nothing is written to disk (the TTS mp3 is decoded by the pinned ffmpeg over pipes; ffmpeg gets an empty private HOME like every child). Transcripts are wrapped as untrusted input and never stored in audit rows; a voice request is never a "direct" request, so every write tool asks for approval first.
- **Limits.** `limits.voiceMinPerUserDay` (30) minutes of speech per person per day are transcribed; past that Praw says so once and stops listening to that person until the next day (UTC). One utterance ends after `voice.silenceMs` (900) ms of silence; speech shorter than 300 ms is ignored and one utterance is at most 60 s. Praw leaves when the invoker leaves the channel, after `voice.idleMin` (10) minutes without speech, after `voice.maxSessionMin` (60) minutes, on `/voice leave` and on `/halt` (within 2 s). Replies are spoken with `voice.ttsVoice` (`th-TH-NiwatNeural`; Edge voice names only).
- **With music.** A spoken reply is mixed over the music, which is ducked to 20% while Praw speaks and comes back afterwards; the track keeps playing and is never skipped.

### Receipts and Google Sheets (M4, Task 33)

`extract_receipt` (a read) reads a receipt attached to the message that asked, posts a markdown table with a CSV file (UTF-8 BOM, RFC 4180; string cells that start with `= + - @`, their full-width forms, white space before them, or a tab, CR or LF get a leading `'`) and returns the row it found. It never exports. When both `GOOGLE_SHEETS_WEBAPP_URL` and `GOOGLE_SHEETS_WEBAPP_SECRET` are set (`bash scripts/set-tokens.sh SHEETS`) a second tool, `sheets_append_receipt` (a write), appends the row `[date, merchant, currency, subtotal, tax, total]`; without them that tool does not exist. The URL must be `https://script.google.com/macros/s/<id>/exec` and still passes the SSRF guard. The request is `POST {secret, worksheet:"Sheet1", rows}` (JSON, secret in the body only). The secret must match `[A-Za-z0-9._~+=-]{16,200}` (the `set-tokens.sh` check); pick an Apps Script property value in that alphabet. Google answers a web-app POST with a redirect to `script.googleusercontent.com` after `doPost` ran (Content service docs, "Redirects"); Praw treats a 302 to exactly that host as accepted and never follows it, so a script-level rejection (for example a wrong secret) is not visible to Praw: check the sheet after setup. The write asks approval for a delegated, voice, scheduled or tainted run (a run that has just read a receipt is tainted, so an export after a receipt read always asks); the approval card and stored call hold the whole row (merchant included), so approving needs no attachment and no second model call. Receipt contents are never logged or audited. Rotation: change the secret in the Apps Script properties and `lw env set apps/assistant GOOGLE_SHEETS_WEBAPP_SECRET`, then restart; use a new web app, never the old bot's (P23).

### Rotation (any leak in a channel or a log means rotate immediately)

Bot token: Developer Portal, application, Bot, Reset Token; then `lw env set apps/assistant BOT_TOKEN_<DEPT>` and `lw restart apps/assistant`. Rotate all 10 if you cannot tell which leaked. `BOT_TOKEN_ADMIN` (LW Admin): Developer Portal, application "LW Admin", Bot, Reset Token; then `bash scripts/set-tokens.sh --local ADMIN` and restart `npm run dev`. It lives only in `env.admin`; rotate it first if the app or its logs may have leaked.

`GEMINI_API_KEY` (Praw): create a new key in a billing-enabled Google Cloud project, `lw env set apps/assistant GEMINI_API_KEY`, `lw restart apps/assistant`, then delete the old key in the Cloud console. A key added with `/provider add gemini` is re-added the same way as the other provider keys. `BOT_TOKEN_PRAW` rotates like any bot token (above).

`CLICKUP_API_TOKEN` (M3): create a new personal token in ClickUp (Settings, Apps), `lw env set apps/assistant CLICKUP_API_TOKEN`, `lw restart apps/assistant`, then regenerate/remove the old token in ClickUp. Do not reuse the old bot's token. The token is masked in logs (`pk_<digits>_<32 chars>`) and never appears in tool results.

`GOOGLE_SHEETS_WEBAPP_SECRET` (M4): redeploy a new Apps Script web app version with a new secret, `lw env set apps/assistant GOOGLE_SHEETS_WEBAPP_SECRET` (and `..._URL` if the deployment id changed), `lw restart apps/assistant`. The secret is masked in logs and never appears in tool results, audit rows or embeds.

`GITHUB_APP_PRIVATE_KEY` / `GITHUB_APP_PRIVATE_KEY_PATH` (M3): in the GitHub App settings generate a new private key, save it as a file with `chmod 600`, point `GITHUB_APP_PRIVATE_KEY_PATH` at it (`lw env set apps/assistant ...` or `bash scripts/set-tokens.sh GITHUB`), `lw restart apps/assistant`, then delete the old key in the App settings. Do not reuse the old bot's App or key. Install the App on selected repositories only, with no `workflows` and no `administration` permission. Read tokens are minted per call, read-only and scoped to one repository (repo-less reads: metadata only); the key, the App JWT and `ghs_`/`ghp_` tokens are masked in logs and never appear in tool results.

Milestone 2 adds no new secret. `PRAW_WORKSPACE_DIR` is a path, not a secret, so there is nothing to rotate for it.

`ANTHROPIC_API_KEY`: create a new key in the Anthropic console, `lw env set apps/assistant ANTHROPIC_API_KEY`, `lw restart apps/assistant`, then revoke the old key. Provider keys added through `/provider add` are stored encrypted in the database: re-add them with `/provider add` (new key) and revoke the old ones at the provider.

`CONFIG_MASTER_KEY` (re-encrypts the `provider_keys` table, AES-256-GCM with the provider id as AAD):

1. Stop the service: `docker stop <container>` so nothing writes `provider_keys` meanwhile.
2. Run this as root on the VPS in **bash** (the block starts its own `bash`, so it works from any login shell; `</dev/tty` makes the prompts read the terminal, not the heredoc). The values are typed at hidden prompts (`read -rs`), never on a command line or in shell history; the temporary env file is mode 0600 and is shredded on every outcome (success, failure or Ctrl-C) by the `trap`. The re-encrypt script runs in one transaction (if any row fails to decrypt, nothing is changed) and prints `re-encrypted N provider key(s)`, never key material. The new key is stored only after the script succeeded.
   ```bash
   bash <<'ROTATE'
     set -euo pipefail
     umask 077
     trap 'shred -u /root/rotate.env 2>/dev/null || true' EXIT HUP INT TERM
     read -rs -p 'DATABASE_URL: ' DATABASE_URL </dev/tty; echo
     read -rs -p 'Current CONFIG_MASTER_KEY: ' OLD </dev/tty; echo
     NEW="$(openssl rand -base64 32)"
     printf 'DATABASE_URL=%s\nOLD_CONFIG_MASTER_KEY=%s\nNEW_CONFIG_MASTER_KEY=%s\n' "$DATABASE_URL" "$OLD" "$NEW" > /root/rotate.env
     docker run --rm --env-file /root/rotate.env --add-host host.docker.internal:host-gateway --user 1000:1000 --read-only \
       lw-local/apps-assistant:<IMAGE_TAG> node dist/scripts/rotate-master-key.js
     printf '%s\n' "$NEW" | lw env set apps/assistant CONFIG_MASTER_KEY   # value from stdin
   ROTATE
   ```
   If `lw env set` fails after the script succeeded, the new key is lost with the shredded file: re-add the provider keys with `/provider add` after the restart.
3. `lw restart apps/assistant` and confirm health.

Database password: in `psql` as a superuser run `\password assistant` (prompts without echo; never put the password in a statement), then `lw env set apps/assistant DATABASE_URL` (value from stdin) and `lw restart apps/assistant`.

## Live E2E checklist (owner, in `#🧪-labs-sandbox`, after `/budget set daily 1`)

Spec §18 acceptance criteria 1 to 9 (10 is the automated suite):

1. All enabled heads come online with their own name and avatar; disable one (remove its token) and the others still start.
2. Post a goal to `@CEO`: a task, a thread, delegation to at least one head and persona, and a `report` rolled back to the CEO.
3. Persona messages arrive through the webhook with their own name, avatar and footer. Also verify that a persona webhook message has `message.applicationId` equal to the head bot's application id (this is what the service uses to attribute personas; Gate 1 D6). If it is null or different, personas will be treated as foreign bots.
4. Bots do not reply to bots unless mentioned or owner; the turn limit stops a loop.
5. `/limits set turns 3`, `/budget`, `/persona edit`, `/bot disable` take effect within 1 s without restart.
6. Exceed the daily budget: all bots pause and an `alert` is posted.
7. A task over the approval threshold waits for the approve button from `Bot Admin`; a click by anyone else is rejected.
8. `/halt` aborts in-flight streams within 2 s; `/resume` continues.
9. No bot can read or post in `#🔑-system-credentials` or `#moderator-only`, and the boot log shows no permission warnings.

Additionally, make one real call with a Sonnet model and confirm the provider request is accepted with the configured `fallbacks` and `output_config` parameters (no 400 from the API), and that the cost shown by `/usage` is non-zero and plausible.

Container hardening check (D20): `docker run --rm --entrypoint sh <image> -c 'ls -a /app'` shows no `.env`.

**Live reply streaming (STREAM-1).** With `stream.enabled` (config, default true) a person's typed message to a head gets a preview message that is edited while the model writes its `respond` body (plus the typing indicator; Praw/Gemini shows typing only). The preview is built from the respond body only, goes through the same redaction and handle defanging as every post, never pings, and is replaced by the final answer (or points to a fresh post when the answer must route a mention or is a card). claude-code-local reads the CLI's `stream-json` output; the probe checks it.
