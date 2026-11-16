#!/usr/bin/env bash
# Local mode launcher (owner's Mac): npm run dev.
#   bash scripts/dev.sh                 check the env file, build, run dist/main.js
#   bash scripts/dev.sh db up|down      start / stop the local PostgreSQL (docker-compose.local.yml)
#   bash scripts/dev.sh chrome up|down  start / stop the Chrome + guard proxy containers (docker-compose.chrome.yml; no env file is read)
#   bash scripts/dev.sh render up|down  start / stop the document renderer (Chrome with no route) + its DevTools forwarder (docker-compose.render.yml; no env file is read)
#   bash scripts/dev.sh media up|down   start / stop the media sidecar + token relay (docker-compose.media.yml, host relay; no env file is read)
#   bash scripts/dev.sh ws up|down      start / stop the ws registry proxy (docker-compose.ws.yml, project assistant-ws; no env file is read); `up` builds dist/ and the ws images first
#   bash scripts/dev.sh db backup       dump the local PostgreSQL to ~/.config/assistant/backups (custom format, 0600, newest 14 kept)
#   bash scripts/dev.sh --check-only F  only run the env file checks on F (used by tests)
# ALLOW_LOCAL_PROVIDERS=1 is set only in the environment of the node child started here. It is never written to the
# env file, and the guard refuses to start the local provider if the file defines it (Gate 1 L9, L10).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=lib/envfile.sh
. "$ROOT/scripts/lib/envfile.sh"

check_db_loopback() {  # check_db_loopback FILE: DATABASE_URL (and host=/hostaddr=) must be loopback (Gate 1 L10)
  local f=$1 v host
  v=$(sed -n 's/^DATABASE_URL=//p' "$f" | tail -n 1)
  host=${v#*://}; host=${host%%[/?#]*}; host=${host##*@}
  case $host in '['*) host=${host%%]*}] ;; *) host=${host%%:*} ;; esac
  host=$(printf '%s' "$host" | tr 'A-Z' 'a-z')
  case $host in 127.0.0.1|localhost|'[::1]') ;; *) echo "refusing: DATABASE_URL in $f must point at 127.0.0.1, ::1 or localhost" >&2; return 1 ;; esac
  case $v in
    *\?*)  # host= / hostaddr= query parameters override the URL host: same rule, socket paths and empty values refused
      local q=${v#*\?} kv h oldifs=$IFS
      q=${q%%#*}
      IFS='&'
      for kv in $q; do
        case $kv in
          host=*|hostaddr=*)
            if [ -z "${kv#*=}" ]; then IFS=$oldifs; echo "refusing: DATABASE_URL in $f has an empty host= parameter" >&2; return 1; fi
            for h in $(printf '%s' "${kv#*=}" | tr ',' ' '); do
              case $h in 127.0.0.1|localhost|'[::1]'|::1) ;; *) IFS=$oldifs; echo "refusing: DATABASE_URL in $f has a non-loopback host=/hostaddr= parameter" >&2; return 1 ;; esac
            done ;;
        esac
      done
      IFS=$oldifs ;;
  esac
}

check_admin() {  # check_admin FILE: the executor's own env file (Gate 1 S2, S6): only its keys, loopback database
  asst_check_admin_envfile "$1" && check_db_loopback "$1"
}

check() {  # check FILE: location, ownership, mode, no ALLOW flag, required keys
  local f=$1
  asst_check_envfile "$f" || return 1
  if grep -Eq '^[[:space:]]*(export[[:space:]]+)?BOT_TOKEN_ADMIN[[:space:]]*=' "$f"; then
    echo "refusing: $f defines BOT_TOKEN_ADMIN; the LW Admin token belongs only in env.admin (run: bash scripts/set-tokens.sh --local ADMIN) and the main application must never hold it" >&2; return 1
  fi
  if grep -Eq '^[[:space:]]*(export[[:space:]]+)?ALLOW_LOCAL_PROVIDERS[[:space:]]*=' "$f"; then
    echo "refusing: $f defines ALLOW_LOCAL_PROVIDERS; remove that line (the launcher sets it itself)" >&2; return 1
  fi
  if grep -Eq '^[[:space:]]*(export[[:space:]]+)?ASSISTANT_SKIP_PROBE_PIN[[:space:]]*=' "$f"; then
    echo "refusing: $f defines ASSISTANT_SKIP_PROBE_PIN; it may only be set on the command line" >&2; return 1
  fi
  local k v
  for k in DATABASE_URL CONFIG_MASTER_KEY; do
    if ! grep -Eq "^$k=.+" "$f"; then echo "refusing: $f has no $k; run: bash scripts/set-tokens.sh --local" >&2; return 1; fi
  done
  # Gate 1 L10: local mode talks to loopback only (the guard enforces the same on the live process env).
  check_db_loopback "$f" || return 1
  v=$(sed -n 's/^HEALTH_HOST=//p' "$f" | tail -n 1)
  case $v in ''|127.0.0.1) ;; *) echo "refusing: HEALTH_HOST in $f must be 127.0.0.1 (the only loopback value the service accepts)" >&2; return 1 ;; esac
}

if [ "${1:-}" = --check-only ]; then check "${2:?path required}"; exit $?; fi
if [ "${1:-}" = --check-admin-only ]; then check_admin "${2:?path required}"; exit $?; fi

if [ "${1:-}" = chrome ]; then
  # Gate 1 Part C: Chrome runs in a secret-free container; this branch never reads or passes the env file.
  CF="$ROOT/docker-compose.chrome.yml"
  case "${2:-}" in
    up)
      (cd "$ROOT" && npm run build --silent)  # the proxy image copies the compiled net/ modules from dist/
      # Per-boot access token for the control API and DevTools forwarder (G2C-03). It exists only in this process, the proxy container's
      # env and (through `dev.sh`) the app child's env; it is never written to a file.
      CHROME_ACCESS_TOKEN=$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n'); export CHROME_ACCESS_TOKEN
      exec docker compose -f "$CF" up -d --build --wait ;;
    down) exec docker compose -f "$CF" down ;;
    *) echo "usage: dev.sh chrome up|down" >&2; exit 2 ;;
  esac
fi

if [ "${1:-}" = ws ]; then
  # WS-1 (SA-1 C1): the registry proxy for ws_run's npm installs. Like the chrome branch it never reads or passes the env file.
  WF="$ROOT/docker-compose.ws.yml"
  case "${2:-}" in
    up)
      (cd "$ROOT" && npm run build --silent && bash docker/ws/build.sh)  # the proxy image copies dist/; build.sh writes docker/ws/images.json
      exec docker compose -f "$WF" up -d --wait --force-recreate ;;  # recreate: the running proxy must be the image just built (images.json)
    down) exec docker compose -f "$WF" down ;;
    *) echo "usage: dev.sh ws up|down" >&2; exit 2 ;;
  esac
fi

if [ "${1:-}" = render ]; then
  # Gate 1 RF15 (RFMD P3): the document renderer is a SECOND, separate Chrome (no proxy, no route); like the chrome branch it never reads or passes the env file.
  RF="$ROOT/docker-compose.render.yml"
  case "${2:-}" in
    up)
      (cd "$ROOT" && npm run build --silent)  # the forwarder image copies two compiled net/ modules from dist/
      # Per-boot token for the DevTools forwarder: this process, the forwarder container's env and (through `dev.sh`) the app child's env only; never a file.
      RENDER_ACCESS_TOKEN=$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n'); export RENDER_ACCESS_TOKEN
      exec docker compose -f "$RF" up -d --build --wait ;;
    down) RENDER_ACCESS_TOKEN=down exec docker compose -f "$RF" down ;;
    *) echo "usage: dev.sh render up|down" >&2; exit 2 ;;
  esac
fi

if [ "${1:-}" = media ]; then
  # Local media sidecar (Gate 1 LM1-LM10): music and voice. Like the chrome branch it never reads or passes the env file.
  MF="$ROOT/docker-compose.media.yml"
  MDIR="$HOME/.config/assistant/media"
  MPID="$MDIR/relay.pid"
  MIMG=assistant-media:local
  media_stop_relay() {  # kills the host relay only when the pid's command line is really relay-host.js (a stale pid is never killed)
    local pid cmd i
    if [ -f "$MPID" ] && [ ! -L "$MPID" ]; then
      pid=$(cat "$MPID" 2>/dev/null || true)
      case $pid in ''|*[!0-9]*) pid= ;; esac
      if [ -n "$pid" ]; then
        cmd=$(ps -p "$pid" -o command= 2>/dev/null || true)
        case $cmd in
          *dist/media/relay-host.js*)
            kill "$pid" 2>/dev/null || true
            for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 0.3; done
            kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true ;;
        esac
      fi
      rm -f "$MPID"
    fi
  }
  case "${2:-}" in
    up)
      (cd "$ROOT" && npm run build --silent)  # the host relay runs natively from dist/; the image builds its own dist
      # LM8: the media directory is created 0700 and checked (not a symlink, ours, mode 0700) before anything goes into it.
      if [ ! -e "$MDIR" ] && [ ! -L "$MDIR" ]; then (umask 077; mkdir -p "$(dirname "$MDIR")" && mkdir "$MDIR"); fi
      asst_check_dir "$MDIR" || exit 1
      # LM9 / G2M-03: rebuild when any build input differs from the hash recorded on the image: the Dockerfile, the lockfile and every
      # TypeScript source the image compiles (`COPY . .` takes untracked files too, so this walks the tree, not git ls-files).
      WANT=$(cd "$ROOT" && { printf '%s\n' deploy/Dockerfile package.json package-lock.json tsconfig.json tsconfig.build.json; \
        find . \( -path ./node_modules -o -path ./dist -o -path ./.git -o -path ./.claude -o -path ./.superpowers \) -prune -o -type f -name '*.ts' -print; } \
        | LC_ALL=C sort | while IFS= read -r f; do [ -f "$f" ] && { printf '%s\0' "$f"; cat "$f"; }; done | shasum -a 256 | cut -d' ' -f1)
      HAVE=$(docker image inspect "$MIMG" --format '{{index .Config.Labels "lw.media.build-sha256"}}' 2>/dev/null || true)
      if [ "$HAVE" != "$WANT" ]; then
        echo "note: building $MIMG (missing or its build hash differs); the pinned yt-dlp/ffmpeg are verified by deploy/Dockerfile" >&2
        (cd "$ROOT" && DOCKER_BUILDKIT=0 docker build -f deploy/Dockerfile -t "$MIMG" --label "lw.media.build-sha256=$WANT" .)
      fi
      # Per-boot token: minted here, in this process, the mediarelay container env and the host relay env only. Never a file, never argv of
      # a long-lived process, never the app child.
      MEDIA_RELAY_TOKEN=$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n'); export MEDIA_RELAY_TOKEN
      media_stop_relay  # LM3: a re-minted token always restarts the host relay too
      docker compose -f "$MF" up -d --wait
      rm -f "$MPID"
      (cd "$ROOT"; umask 077; nohup env -i PATH="$PATH" HOME="$HOME" MEDIA_RELAY_TOKEN="$MEDIA_RELAY_TOKEN" node dist/media/relay-host.js >>"$MDIR/relay.log" 2>&1 </dev/null & echo $! >"$MPID")
      unset MEDIA_RELAY_TOKEN
      for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do [ -S "$MDIR/media.sock" ] && break; sleep 0.3; done
      if [ ! -S "$MDIR/media.sock" ]; then echo "error: the host relay did not come up; see $MDIR/relay.log" >&2; media_stop_relay; exit 1; fi
      echo "media sidecar is up; start the app with: npm run dev" >&2 ;;
    down)
      media_stop_relay
      rm -f "$MDIR/media.sock"
      MEDIA_RELAY_TOKEN=down docker compose -f "$MF" down ;;
    *) echo "usage: dev.sh media up|down" >&2; exit 2 ;;
  esac
  exit $?
fi

ENVF=$(asst_env_file)
check "$ENVF" || exit 1

# 2026-11-07: a Docker reset wiped the local database and every /settings value with it (no backup existed).
# db_backup [force]: pg_dump of the running local DB into ~/.config/assistant/backups (dir 0700, files 0600), newest 14 kept.
# Without `force` it is skipped when a dump younger than 6 hours exists. Best effort: a missing container is a note, never a failure.
DB_CONTAINER=assistant-local-postgres-1
db_backup() {
  local dir="$HOME/.config/assistant/backups" out tmp
  if ! docker inspect -f '{{.State.Running}}' "$DB_CONTAINER" 2>/dev/null | grep -q true; then
    echo "note: $DB_CONTAINER is not running; no database backup taken" >&2; return 0
  fi
  (umask 077; mkdir -p "$dir") && chmod 700 "$dir" || return 0
  if [ "${1:-}" != force ] && [ -n "$(find "$dir" -name 'assistant-*.dump' -mmin -360 2>/dev/null | head -n 1)" ]; then return 0; fi
  out="$dir/assistant-$(date +%Y%m%d-%H%M%S).dump"; tmp="$out.part"
  if (umask 077; docker exec "$DB_CONTAINER" pg_dump -U assistant -d assistant -Fc >"$tmp" 2>/dev/null) && [ -s "$tmp" ]; then
    mv "$tmp" "$out"; echo "note: database backup $out" >&2
    ls -1t "$dir"/assistant-*.dump 2>/dev/null | tail -n +15 | while IFS= read -r f; do rm -f "$f"; done
  else
    rm -f "$tmp"; echo "warning: database backup failed (the app still starts)" >&2
  fi
  return 0
}

if [ "${1:-}" = db ]; then
  case "${2:-}" in
    up) exec docker compose --env-file "$ENVF" -f "$ROOT/docker-compose.local.yml" up -d --wait ;;
    down) exec docker compose --env-file "$ENVF" -f "$ROOT/docker-compose.local.yml" down ;;
    backup) db_backup force; exit $? ;;
    *) echo "usage: dev.sh db up|down|backup" >&2; exit 2 ;;
  esac
fi

cd "$ROOT"
db_backup
# R-L9: the guard registers the local provider only if probe-ok matches `claude --version`; tell the owner early.
# (ASSISTANT_SKIP_PROBE_PIN=1 on the command line overrides it with a logged warning; it is never read from the env file.)
PROBED=$(sed -n 's/^version=//p' "$(dirname "$ENVF")/probe-ok" 2>/dev/null || true)
NOW=$(claude --version 2>/dev/null | head -1 || true)
# LOCAL-OFF-1: marker file next to env.local; the owner turned the subscription provider off (touch / rm it, then restart). Local mode stays on.
LOCAL_OFF=0
[ ! -e "$(dirname "$ENVF")/local-provider-off" ] || LOCAL_OFF=1
if [ "$LOCAL_OFF" = 1 ]; then
  echo "note: the local provider is off by the owner (marker $(dirname "$ENVF")/local-provider-off); the Claude API is used. rm the marker and restart to turn it on" >&2
elif [ "${ASSISTANT_SKIP_PROBE_PIN:-}" = 1 ]; then
  echo "warning: ASSISTANT_SKIP_PROBE_PIN=1 is set: the probe pin is NOT enforced; run bash scripts/probe-local-cli.sh when you can" >&2
elif [ -z "$PROBED" ] || [ "$NOW" != "$PROBED" ]; then
  echo "warning: the probe has not passed for the installed claude ('$NOW'); the local provider will NOT register until you run: bash scripts/probe-local-cli.sh" >&2
fi
npm run build --silent
# The child gets a clean environment: node --env-file never overrides variables that already exist, so an exported
# DATABASE_URL / ANTHROPIC_API_KEY in this shell would silently beat the env file (and break the loopback checks).
CHILD_ENV=(PATH="$PATH" HOME="$HOME" ALLOW_LOCAL_PROVIDERS=1)
# Part C: local mode uses Chrome for the web tools; the loopback ports are published by docker-compose.chrome.yml. Not read from the env file.
CHILD_ENV[${#CHILD_ENV[@]}]="CHROME_CDP_URL=http://127.0.0.1:9222"
CHILD_ENV[${#CHILD_ENV[@]}]="CHROME_PROXY_CONTROL_URL=http://127.0.0.1:9223"
# The token is read back from the running proxy container (docker inspect); with no container there is no token and the web group stays off.
CHROME_TOKEN=$(docker inspect assistant-chrome-guardproxy-1 --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | sed -n 's/^ACCESS_TOKEN=//p' | head -n 1 || true)
[ -z "$CHROME_TOKEN" ] || CHILD_ENV[${#CHILD_ENV[@]}]="CHROME_ACCESS_TOKEN=$CHROME_TOKEN"
# RF15: the document renderer's DevTools forwarder (docker-compose.render.yml). Its token is read back from the running container; without it doc_create stays off.
CHILD_ENV[${#CHILD_ENV[@]}]="RENDER_CDP_URL=http://127.0.0.1:9224"
RENDER_TOKEN=$(docker inspect assistant-render-renderfwd-1 --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | sed -n 's/^ACCESS_TOKEN=//p' | head -n 1 || true)
[ -z "$RENDER_TOKEN" ] || CHILD_ENV[${#CHILD_ENV[@]}]="RENDER_ACCESS_TOKEN=$RENDER_TOKEN"
# Local media sidecar (LM8): MEDIA_SOCKET is set only when the host relay's directory and socket pass the checks. The app never gets the relay token.
MEDIA_DIR="$HOME/.config/assistant/media"
if [ -S "$MEDIA_DIR/media.sock" ] && [ ! -L "$MEDIA_DIR/media.sock" ] && [ "$(_asst_uid "$MEDIA_DIR/media.sock")" = "$(id -u)" ] && asst_check_dir "$MEDIA_DIR" 2>/dev/null; then
  CHILD_ENV[${#CHILD_ENV[@]}]="MEDIA_SOCKET=$MEDIA_DIR/media.sock"
fi
[ -z "${USER:-}" ] || CHILD_ENV[${#CHILD_ENV[@]}]="USER=$USER"
[ -z "${LANG:-}" ] || CHILD_ENV[${#CHILD_ENV[@]}]="LANG=$LANG"
[ -z "${TMPDIR:-}" ] || CHILD_ENV[${#CHILD_ENV[@]}]="TMPDIR=$TMPDIR"
[ "$LOCAL_OFF" != 1 ] || CHILD_ENV[${#CHILD_ENV[@]}]="ASSISTANT_LOCAL_PROVIDER_OFF=1"
[ "${ASSISTANT_SKIP_PROBE_PIN:-}" != 1 ] || CHILD_ENV[${#CHILD_ENV[@]}]="ASSISTANT_SKIP_PROBE_PIN=1"
# Phase 2 (Gate 1 S2, option A): the executor "LW Admin" is its OWN process with its OWN env file (env.admin); the main application never gets
# its token. It is started here, next to the app, with a clean environment of its own, and stopped with it. Without env.admin it is simply
# not started and the server-management operations stay off.
# OD-1: when the executor is installed as a launchd job under its own macOS user (scripts/executor-service.sh), it already runs and holds the token and
# the deploy key; this script then starts NO executor and only points the app at the shared socket. The block below is the dev fallback for
# machines without the job (and for tests).
LWADMIN_PLIST=${LWADMIN_PLIST:-/Library/LaunchDaemons/net.labworkspace.lwadmin.plist}
if [ -e "$LWADMIN_PLIST" ]; then
  echo "note: the LW Admin executor runs under launchd as its own macOS user; dev.sh does not start one (status: bash scripts/executor-service.sh status)" >&2
  CHILD_ENV[${#CHILD_ENV[@]}]="EXECUTOR_SOCKET=${LWADMIN_SOCKET:-/var/lwadmin/run/executor.sock}"
  exec env -i "${CHILD_ENV[@]}" node --env-file="$ENVF" dist/main.js
fi
ADMINF=$(asst_admin_env_file)
if [ -e "$ADMINF" ] || [ -L "$ADMINF" ]; then
  check_admin "$ADMINF" || exit 1
  SOCK=$(asst_executor_socket)
  [ "${#SOCK}" -lt 100 ] || { echo "refusing: the executor socket path $SOCK is too long (macOS limit 104 bytes)" >&2; exit 1; }
  rm -f "$SOCK"
  EXEC_ENV=(PATH="$PATH" HOME="$HOME" EXECUTOR_SOCKET="$SOCK")
  [ -z "${USER:-}" ] || EXEC_ENV[${#EXEC_ENV[@]}]="USER=$USER"
  [ -z "${LANG:-}" ] || EXEC_ENV[${#EXEC_ENV[@]}]="LANG=$LANG"
  [ -z "${TMPDIR:-}" ] || EXEC_ENV[${#EXEC_ENV[@]}]="TMPDIR=$TMPDIR"
  CHILD_ENV[${#CHILD_ENV[@]}]="EXECUTOR_SOCKET=$SOCK"
  env -i "${EXEC_ENV[@]}" node --env-file="$ADMINF" dist/executor/main.js &
  EXEC_PID=$!
  stop_executor() { kill "$EXEC_PID" 2>/dev/null || true; wait "$EXEC_PID" 2>/dev/null || true; rm -f "$SOCK"; }
  trap 'stop_executor' EXIT
  trap 'exit 143' HUP INT TERM
  env -i "${CHILD_ENV[@]}" node --env-file="$ENVF" dist/main.js
  exit $?
fi
echo "note: no $ADMINF; the LW Admin executor is not started and server management is off (bash scripts/set-tokens.sh --local ADMIN)" >&2
exec env -i "${CHILD_ENV[@]}" node --env-file="$ENVF" dist/main.js
