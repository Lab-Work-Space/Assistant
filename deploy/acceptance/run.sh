#!/usr/bin/env bash
# Praw media sidecar: local two-container acceptance (plan Task 8; spec 12 AC1-AC4, Gate 1 S1/S5/S8/S9/S10/S12/S13).
# Owner Mac / any Docker host. Never the VPS. bash 3.2 compatible (macOS /bin/bash).
#
#   deploy/acceptance/run.sh
#
# Environment (all optional):
#   ACC_BUILD=legacy|buildx|skip   legacy (default): DOCKER_BUILDKIT=0 docker build, what lw-git runs, native arch.
#                                  buildx: docker buildx build --platform $ACC_PLATFORM --load (e.g. amd64 under QEMU).
#                                  skip: use the existing $ACC_IMAGE.
#   ACC_PLATFORM=linux/amd64       buildx only; also exported as DOCKER_DEFAULT_PLATFORM for the run.
#   ACC_IMAGE=assistant:praw-sidecar-accept   the image tag kept after the run.
#   ACC_SCAN=1                     run scan.sh (grype + syft) on the image afterwards (0 to skip).
#   ACC_TMP=$TMPDIR                parent dir for the scratch dir (fake env files, deleted on exit) and the kept output dir.
#   ACC_PYTHON=python3             a python3 with PyYAML (lw_check.py needs it, as python3-yaml on the VPS).
#   ACC_LW_DIR=../infra/vps/files/lw   the lw, lw_check.py and lw_override.jq under test.
#   ACC_WAIT=120                   seconds to wait for media to turn healthy (raise under emulation).
#
# What it does:
#  1. builds the image and tags it lw-local/apps-assistant:<run tag> (the only name lw_check accepts) and $ACC_IMAGE;
#  2. renders deploy/docker-compose.yml exactly like `lw` compose_render_check: lw_check descriptor, raw, the user render
#     (`docker compose config --no-env-resolution`) through lw_check user, the lw.isolated labels + mem_limits, lw_override.jq,
#     the full render through lw_check compose. The env files are a scratch shared/.env and db env with a planted ZZ_MARKER and
#     fake secret-named keys (never real secrets);
#  3. brings up assistant + media under a project name unique to this run, with docker-compose.t7.yml on top (assistant
#     entrypoint -> stub listener; media untouched, asserted);
#  4. check.sh live: AC1, AC4/S1, S5, S8, S9, S12, S13 (local parts), app-level selection; then check.sh unpatched: AC2;
#  5. tears down only what this run created (its compose project's containers, networks, volumes; the run tag), never prunes.
# Exit 0 only if every check passed. The log and results stay in $ACC_TMP/t8acc-<id>-out/ (no secret values: all values are fake).
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
APP=$(cd "$HERE/../.." && pwd)
LWD=$(cd "${ACC_LW_DIR:-$APP/../infra/vps/files/lw}" && pwd)
PY=${ACC_PYTHON:-python3}
BUILD=${ACC_BUILD:-legacy}
PLATFORM=${ACC_PLATFORM:-}
IMAGE=${ACC_IMAGE:-assistant:praw-sidecar-accept}
SCAN=${ACC_SCAN:-1}
TMPROOT=${ACC_TMP:-${TMPDIR:-/tmp}}
WAIT=${ACC_WAIT:-120}

die() { echo "run.sh: $*" >&2; exit 2; }
for t in docker jq perl; do command -v "$t" >/dev/null || die "$t not found"; done
"$PY" -I -c 'import yaml' 2>/dev/null || die "$PY has no PyYAML (set ACC_PYTHON to a python3 with yaml)"
for f in lw_check.py lw_override.jq; do [ -f "$LWD/$f" ] || die "$LWD/$f missing"; done
case $BUILD in legacy|buildx|skip) ;; *) die "ACC_BUILD must be legacy, buildx or skip";; esac

RID=$(date +%s | tail -c 7)$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')
PROJECT=t8acc-$RID
case $PROJECT in t8acc-[a-z0-9]*) ;; *) die "bad project name $PROJECT";; esac
RUNTAG=lw-local/apps-assistant:acc-$RID
WORK=$(mktemp -d "$TMPROOT/t8acc-$RID.XXXXXX")
OUT=$TMPROOT/t8acc-$RID-out
mkdir -p "$OUT"
LOG=$OUT/run.log
RES=$OUT/results
: >"$RES"
exec > >(tee -a "$LOG") 2>&1

now() { perl -MTime::HiRes=time -e 'printf "%.2f\n", time'; }
section() { printf '\n===== %s =====\n' "$*"; }

REL=$WORK/rel          # the release dir lw would deploy (only the two files lw needs from the overlay)
META=$WORK/meta        # lw's per-release meta dir
SHARED=$WORK/shared    # lw's $APPDIR/shared
DBENV=$WORK/db.docker.env
mkdir -p "$REL" "$META" "$SHARED"
cp "$APP/deploy/docker-compose.yml" "$APP/deploy/deploy.yml" "$REL/"

dc_files() {  # the compose files of a variant: patched (lw render + t7) or unpatched (old override + t7 + t7-unpatched)
  case $1 in
    patched) printf '%s\n' -f "$REL/docker-compose.yml" -f "$META/override.yml" -f "$HERE/docker-compose.t7.yml" ;;
    lw) printf '%s\n' -f "$REL/docker-compose.yml" -f "$META/override.yml" ;;
    unpatched) printf '%s\n' -f "$REL/docker-compose.yml" -f "$META/override-unpatched.yml" -f "$HERE/docker-compose.t7.yml" \
      -f "$HERE/docker-compose.t7-unpatched.yml" ;;
  esac
}
dcv() {  # dcv VARIANT compose-args...
  local v=$1; shift
  # shellcheck disable=SC2046
  T7_ENV=$SHARED/.env docker compose -p "$PROJECT" --project-directory "$REL" $(dc_files "$v") --env-file "$META/compose.env" "$@"
}

cleanup() {
  local rc=$?
  set +e
  section "teardown ($PROJECT)"
  if [ -f "$META/override.yml" ]; then dcv patched down -v --remove-orphans --timeout 5; fi
  # Anything left with this run's compose label (e.g. a variant's container); nothing else is touched.
  local ids
  ids=$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT"); [ -z "$ids" ] || docker rm -f $ids
  ids=$(docker ps -aq --filter "label=t8acc=$RID"); [ -z "$ids" ] || docker rm -f $ids
  ids=$(docker network ls -q --filter "label=com.docker.compose.project=$PROJECT"); [ -z "$ids" ] || docker network rm $ids
  ids=$(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT"); [ -z "$ids" ] || docker volume rm $ids
  echo "left over: containers=$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" | wc -l | tr -d ' ')" \
    "networks=$(docker network ls -q --filter "label=com.docker.compose.project=$PROJECT" | wc -l | tr -d ' ')" \
    "volumes=$(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT" | wc -l | tr -d ' ')"
  # The run tag is a second name of $IMAGE: drop only the name, and only while $IMAGE still holds the image.
  if docker image inspect "$IMAGE" >/dev/null 2>&1 && docker image inspect "$RUNTAG" >/dev/null 2>&1; then docker image rm "$RUNTAG" >/dev/null; fi
  rm -rf "$WORK"
  echo "scratch removed: $WORK"
  echo "results: $RES  log: $LOG"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

section "run $PROJECT"
echo "image=$IMAGE runtag=$RUNTAG build=$BUILD platform=${PLATFORM:-native} lw=$LWD"
docker version --format 'docker server {{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}'
docker compose version

# media-egress has a fixed subnet: a network left by another run would make `up` fail on an overlapping pool. Refuse, delete nothing.
for n in $(docker network ls -q); do
  docker network inspect -f '{{.Name}} {{range .IPAM.Config}}{{.Subnet}} {{end}}' "$n" 2>/dev/null
done | awk '$2 ~ /^10\.213\./ {print; f=1} END {exit f}' || die "a network already uses 10.213.0.0/24 (listed above); remove it first"

# ---------- 1. build ----------
section "build ($BUILD)"
t0=$(now)
case $BUILD in
  legacy) (cd "$APP" && DOCKER_BUILDKIT=0 docker build -f deploy/Dockerfile -t "$IMAGE" -t "$RUNTAG" .) ;;
  buildx) [ -n "$PLATFORM" ] || die "ACC_BUILD=buildx needs ACC_PLATFORM"
          (cd "$APP" && docker buildx build --platform "$PLATFORM" -f deploy/Dockerfile -t "$IMAGE" -t "$RUNTAG" --load .) ;;
  skip) docker image inspect "$IMAGE" >/dev/null || die "ACC_BUILD=skip but $IMAGE does not exist"; docker tag "$IMAGE" "$RUNTAG" ;;
esac
t1=$(now)
echo "build seconds: $(perl -e "printf '%.0f', $t1 - $t0")"
docker image inspect -f 'image {{.Id}} {{.Os}}/{{.Architecture}} size={{.Size}}' "$IMAGE"
[ -z "$PLATFORM" ] || export DOCKER_DEFAULT_PLATFORM=$PLATFORM

# ---------- 2. render through the real lw pieces ----------
section "fake env (key names only; every value is a fake)"
rnd() { od -An -N8 -tx1 /dev/urandom | tr -d ' \n'; }
MARKER=zz-$(rnd)
FAKE=fakesecret-$(rnd)
{
  echo "ZZ_MARKER=$MARKER"
  echo "BOT_TOKEN_HQ=$FAKE-bot"
  echo "GEMINI_API_KEY=$FAKE-gemini"
  echo "ANTHROPIC_API_KEY=$FAKE-anthropic"
  echo "CONFIG_MASTER_KEY=$FAKE-master"
  echo "DATABASE_URL=postgres://fake:$FAKE-db@host.docker.internal:4231/fake"
} >"$SHARED/.env"
{
  echo "DB_HOST=127.0.0.1"
  echo "DB_PORT=4231"
  echo "DB_USER=fake"
  echo "DB_PASSWORD=$FAKE-dbpw"
  echo "DATABASE_URL=postgres://fake:$FAKE-dbpw@host.docker.internal:4231/fake"
} >"$DBENV"
chmod 600 "$SHARED/.env" "$DBENV"
printf '%s\n%s\n' "$MARKER" "$FAKE" >"$WORK/values"   # check.sh greps logs for these; never printed
cut -d= -f1 "$SHARED/.env" | sed 's/^/shared\/.env: /'
cut -d= -f1 "$DBENV" | sed 's/^/db env: /'

section "lw render (descriptor, raw, user, override, compose)"
PORT=$("$PY" -I -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')
"$PY" -I "$LWD/lw_check.py" descriptor "$REL/deploy.yml" | jq --argjson p "$PORT" '. + {port: $p}' >"$META/deploy.json"
printf 'PORT=%s\nIMAGE_TAG=%s\nLW_APP=%s\n' "$PORT" "${RUNTAG#*:}" apps/assistant >"$META/compose.env"
cf=$(jq -r .compose_file "$META/deploy.json")
lwck() { "$PY" -I "$LWD/lw_check.py" "$@"; }
step() { local id=$1; shift; if "$@"; then echo "PASS $id" | tee -a "$RES"; else echo "FAIL $id" | tee -a "$RES"; fi; }

step "D5 lw_check raw" lwck raw "$REL/$cf"
UOUT=$WORK/user.json
docker compose -p "$PROJECT" --project-directory "$REL" -f "$REL/$cf" --env-file "$META/compose.env" \
  config --format json --no-env-resolution >"$UOUT"
step "D5 lw_check user" lwck user "$UOUT" "$REL"
# D5 fixture: the user render holds no env values (no env resolution); keep a copy next to the log for the report.
cp "$UOUT" "$OUT/compose-user-render.json"
svcs=$(jq -r '.services // {} | keys[]' "$UOUT")
imgs=$(jq -c '.services // {} | map_values(.image // "")' "$UOUT")
labels=$(jq -c '.services // {} | map_values(.labels // {} | if type == "object" then .["lw.isolated"] // "" else "" end)' "$UOUT")
mems=$(jq -c '.services // {} | map_values(.mem_limit // null)' "$UOUT")
echo "user render: services=$(echo $svcs) labels=$labels mems=$mems"
echo "user render shapes: media.environment is $(jq -r '.services.media.environment | type' "$UOUT"), media.networks is" \
  "$(jq -c '.services.media.networks' "$UOUT"), assistant.networks is $(jq -c '.services.assistant.networks' "$UOUT")," \
  "mem_limit types $(jq -c '.services | map_values(.mem_limit | type)' "$UOUT")"
bad_local=$(jq -r --arg re '^lw-local/apps-assistant:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$' \
  'to_entries[] | select(.value | startswith("lw-local/")) | select(.value | test($re) | not) | "\(.key)=\(.value)"' <<<"$imgs")
step "D5 lw local-image name check" test -z "$bad_local"
override() {  # override LABELS_JSON SHARED_ENV  (lw compose_render_check's jq call: no File Browser, storage false)
  jq -n -f "$LWD/lw_override.jq" --arg mem "$(jq -r '.memory | ascii_downcase' "$META/deploy.json")" --arg db "$DBENV" \
    --arg senv "$2" --argjson env "$(jq -c .env "$META/deploy.json")" \
    --arg svcs "$svcs" --arg fburl "" --arg main "$(jq -r .service "$META/deploy.json")" \
    --arg stor false --arg sdir /srv/labworkspace/storage --arg gid "" --argjson imgs "$imgs" \
    --argjson labels "$1" --argjson mems "$mems"
}
override "$labels" "$SHARED/.env" >"$META/override.yml"
echo "override.yml (lw_override.jq):"; jq . "$META/override.yml"
lwcompose() {  # lwcompose VARIANT SHARED_DIR -> lw_check compose on that variant's full render (the render is deleted)
  local out=$WORK/full.json rc=0
  dcv "$1" config --format json >"$out" || return 1
  lwck compose "$out" "$REL" "$2" assistant "$PORT" "" "$DBENV" || rc=$?
  rm -f "$out"
  return $rc
}
step "D5 lw_check compose (patched render)" lwcompose lw "$SHARED"

# The t7 layer must not change media: its merged service is the same with and without it.
cmp_media() {
  local a b
  a=$(dcv lw config --format json | jq -S '.services.media')
  b=$(dcv patched config --format json | jq -S '.services.media')
  [ -n "$a" ] && [ "$a" = "$b" ]
}
step "T7 layer leaves media unchanged" cmp_media
dcv patched config --format json | jq '.services.media | {labels, environment, env_file, extra_hosts, networks, user, volumes, restart, mem_limit}'

# Runbook check (lw env keys): a shared/.env key that media also sets (NODE_ENV, MEDIA_SOCKET) makes lw refuse the deploy.
mkdir -p "$WORK/shared-clash"
{ cat "$SHARED/.env"; echo "NODE_ENV=development"; } >"$WORK/shared-clash/.env"
clash() {
  local out=$WORK/clash.json rc=0 msg
  override "$labels" "$WORK/shared-clash/.env" >"$META/override-clash.yml"
  T7_ENV=$WORK/shared-clash/.env docker compose -p "$PROJECT" --project-directory "$REL" -f "$REL/$cf" -f "$META/override-clash.yml" \
    --env-file "$META/compose.env" config --format json >"$out"
  msg=$(lwck compose "$out" "$REL" "$WORK/shared-clash" assistant "$PORT" "" "$DBENV" 2>&1) || rc=$?
  rm -f "$out" "$META/override-clash.yml"
  echo "$msg" | grep -v -e "$MARKER" -e "$FAKE" | head -5
  [ "$rc" != 0 ] && echo "$msg" | grep -q NODE_ENV
}
step "S4 shared/.env NODE_ENV clash refused by lw_check compose" clash

# ---------- 3. up ----------
section "up"
dcv patched up -d --pull never || echo "compose up returned non-zero (media not healthy?)"
t0=$(now)
MID=$(dcv patched ps -aq media)
st=""
i=0
while [ $i -lt "$WAIT" ]; do
  st=$(docker inspect -f '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$MID")
  case $st in running/healthy|exited/*|*/unhealthy|restarting/*) break;; esac
  sleep 1; i=$((i + 1))
done
echo "media: $st after ~${i}s"
docker inspect -f 'media restarts={{.RestartCount}} exit={{.State.ExitCode}}' "$MID"
dcv patched ps -a
if [ "$st" != running/healthy ]; then
  dcv patched logs --no-color media | grep -v -e "$MARKER" -e "$FAKE" | tail -40
  echo "FAIL media healthy" | tee -a "$RES"
  exit 1
fi
echo "PASS media healthy" | tee -a "$RES"
AID=$(dcv patched ps -aq assistant)
i=0
while [ $i -lt 60 ] && [ "$(docker inspect -f '{{.State.Status}}' "$AID")" != running ]; do sleep 1; i=$((i + 1)); done
step "assistant running (after media healthy)" test "$(docker inspect -f '{{.State.Status}}' "$AID")" = running
echo "assistant started $(docker inspect -f '{{.State.StartedAt}}' "$AID"); media started $(docker inspect -f '{{.State.StartedAt}}' "$MID")"

# ---------- 4. checks ----------
export ACC_PROJECT=$PROJECT ACC_REL=$REL ACC_META=$META ACC_SHARED=$SHARED ACC_DBENV=$DBENV ACC_HERE=$HERE ACC_APP=$APP
export ACC_IMAGE=$RUNTAG ACC_RES=$RES ACC_VALUES=$WORK/values ACC_RID=$RID ACC_PORT=$PORT ACC_LWD=$LWD ACC_PY=$PY ACC_WAIT=$WAIT
rc=0
bash "$HERE/check.sh" live || rc=1
# AC2 last: it breaks media. The unpatched override = lw_override.jq with no labels (an lw without isolated mode).
override '{}' "$SHARED/.env" >"$META/override-unpatched.yml"
bash "$HERE/check.sh" unpatched || rc=1

if [ "$SCAN" = 1 ]; then
  section "scan"
  ACC_TMP=$WORK bash "$HERE/scan.sh" "$IMAGE" || rc=1
fi

section "summary"
pass=$(grep -c '^PASS ' "$RES" || true); fail=$(grep -c '^FAIL ' "$RES" || true); skip=$(grep -c '^SKIP ' "$RES" || true)
grep -E '^(FAIL|SKIP) ' "$RES" || true
echo "PASS=$pass FAIL=$fail SKIP=$skip"
[ "$fail" = 0 ] || rc=1
exit $rc
