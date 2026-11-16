#!/usr/bin/env bash
# Praw media sidecar acceptance checks (plan Task 8). Called by run.sh, which renders the compose through the real lw pieces,
# brings the project up and exports the ACC_* variables below. bash 3.2 compatible.
#
#   check.sh live        AC1, AC4/S1, S5, S8, S9, S12, S13 (local parts), app-level media selection, local kill timing
#   check.sh unpatched   AC2 (an lw without isolated mode gives media the env files -> lw_check refuses; media exits 78)
#
# Every negative check has a positive control next to it (a check that cannot fail proves nothing). Results are appended to
# $ACC_RES as PASS/FAIL/SKIP lines; exit 1 if this phase had a FAIL. Values of the fake env are never printed: output that could
# hold them is filtered through $ACC_VALUES first.
set -uo pipefail
for v in ACC_PROJECT ACC_REL ACC_META ACC_SHARED ACC_DBENV ACC_HERE ACC_APP ACC_IMAGE ACC_RES ACC_VALUES ACC_RID ACC_PORT \
  ACC_LWD ACC_PY ACC_WAIT; do
  eval "[ -n \"\${$v:-}\" ]" || { echo "check.sh: $v not set (run it through run.sh)" >&2; exit 2; }
done
case $ACC_PROJECT in t8acc-[a-z0-9]*) ;; *) echo "check.sh: bad project $ACC_PROJECT" >&2; exit 2;; esac
PHASE=${1:-}

# Gate 1 / spec 4.4: media/main.ts ENV_ALLOW (deploy/acceptance/acceptance.test.ts keeps this list equal to the source).
ENV_ALLOW="PATH HOME HOSTNAME TERM LANG TMPDIR NODE_ENV NODE_VERSION YARN_VERSION MEDIA_SOCKET YTDLP_COOKIES_FILE"
SECRET_RE='ZZ_MARKER|BOT_TOKEN_|GEMINI_API_KEY|ANTHROPIC_API_KEY|DATABASE_URL|CONFIG_MASTER_KEY|^DB_'

FAILS=0
res() { echo "$1 $2" | tee -a "$ACC_RES"; [ "$1" != FAIL ] || FAILS=$((FAILS + 1)); }
expect() { local id=$1; shift; if "$@"; then res PASS "$id"; else res FAIL "$id"; fi; }
scrub() { grep -v -F -f "$ACC_VALUES" || true; }        # drop any line holding a fake value
leaks() { grep -q -F -f "$ACC_VALUES"; }                # true if the input holds a fake value
section() { printf '\n----- %s -----\n' "$*"; }
now() { perl -MTime::HiRes=time -e 'printf "%.2f\n", time'; }

dc_files() {
  case $1 in
    patched) printf '%s\n' -f "$ACC_REL/docker-compose.yml" -f "$ACC_META/override.yml" -f "$ACC_HERE/docker-compose.t7.yml" ;;
    lw) printf '%s\n' -f "$ACC_REL/docker-compose.yml" -f "$ACC_META/override.yml" ;;
    unpatched) printf '%s\n' -f "$ACC_REL/docker-compose.yml" -f "$ACC_META/override-unpatched.yml" \
      -f "$ACC_HERE/docker-compose.t7.yml" -f "$ACC_HERE/docker-compose.t7-unpatched.yml" ;;
  esac
}
dcv() {
  local v=$1; shift
  # shellcheck disable=SC2046
  T7_ENV=$ACC_SHARED/.env docker compose -p "$ACC_PROJECT" --project-directory "$ACC_REL" $(dc_files "$v") \
    --env-file "$ACC_META/compose.env" "$@"
}
ex() { local s=$1; shift; dcv patched exec -T "$s" "$@" </dev/null; }             # ex SERVICE CMD...
js() {  # js SERVICE PROBE ARGS... (only decode.cjs reads the caller's stdin)
  local s=$1 f=$2; shift 2
  if [ "$f" = decode.cjs ]; then dcv patched exec -T "$s" node -e "$(cat "$ACC_HERE/probes/$f")" "$@"
  else dcv patched exec -T "$s" node -e "$(cat "$ACC_HERE/probes/$f")" "$@" </dev/null; fi
}
drun() { docker run --rm --label "t8acc=$ACC_RID" --pull never "$@"; }               # one-off containers of this run
has() { grep -q -E "$1" <<<"$2"; }

live() {
  local MID AID out dump keys a b ip
  MID=$(dcv patched ps -q media); AID=$(dcv patched ps -q assistant)
  [ -n "$MID" ] && [ -n "$AID" ] || { res FAIL "live: media and assistant must be running"; return; }

  section "AC1 media holds no secret"
  out=$(ex assistant sh -c 'tr "\0" "\n" </proc/1/environ' | cut -d= -f1 | sort -u)
  echo "assistant /proc/1/environ keys: $(echo $out)"
  local pc=yes
  for k in ZZ_MARKER BOT_TOKEN_HQ GEMINI_API_KEY DATABASE_URL DB_PASSWORD; do has "^$k\$" "$out" || pc=no; done
  expect "AC1 positive control: assistant env has ZZ_MARKER, BOT_TOKEN_HQ, GEMINI_API_KEY, DATABASE_URL, DB_PASSWORD" test "$pc" = yes
  dump=$(ex media sh -c 'n=0; for f in /proc/[0-9]*/environ; do if tr "\0" "\n" <"$f" 2>/dev/null; then n=$((n+1)); fi; done; echo "READ_FILES=$n"')
  echo "media: environ files read: $(grep '^READ_FILES=' <<<"$dump")"
  keys=$(grep -v '^READ_FILES=' <<<"$dump" | cut -d= -f1 | sort -u)
  echo "media: env keys over every /proc/[0-9]*/environ: $(echo $keys)"
  expect "AC1 positive control: media environ readable (>=2 files, MEDIA_SOCKET seen)" \
    test "$(grep '^READ_FILES=' <<<"$dump" | cut -d= -f2)" -ge 2 -a -n "$(grep '^MEDIA_SOCKET=' <<<"$dump")"
  expect "AC1 no ZZ_MARKER/BOT_TOKEN_/GEMINI_API_KEY/DATABASE_URL/CONFIG_MASTER_KEY/DB_* in any media /proc/*/environ" \
    test -z "$(grep -E "$SECRET_RE" <<<"$keys")"
  if leaks <<<"$dump"; then res FAIL "AC1 no fake secret value in media environ"; else res PASS "AC1 no fake secret value in media environ"; fi
  # The runtime env of PID 1 and of the sidecar node (not of the exec'd probes, whose sh exports SHLVL/PWD): ENV_ALLOW keys only.
  # docker inspect cannot show keys an entrypoint adds at run time (the base docker-entrypoint.sh added SHLVL and PWD).
  keys=$(ex media sh -c 'm=$(for d in /proc/[0-9]*; do case "$(tr "\0" " " <$d/cmdline 2>/dev/null)" in "node dist/media/main.js "*) echo ${d#/proc/};; esac; done | head -1); echo "MAIN_PID=$m"; for p in 1 $m; do tr "\0" "\n" </proc/$p/environ | cut -d= -f1; done' | sort -u)
  echo "media runtime env keys (pid 1 + sidecar node): $(echo $keys)"
  local k extra=""
  for k in $keys; do case $k in MAIN_PID=*) continue;; esac; case " $ENV_ALLOW " in *" $k "*) ;; *) extra="$extra $k";; esac; done
  expect "AC1 media runtime env (pid 1 + sidecar node /proc/<pid>/environ) within ENV_ALLOW${extra:+ (extra:$extra)}" \
    test -z "$extra" -a -n "$(grep '^MAIN_PID=[0-9]' <<<"$keys")"

  out=$(ex media sh -c 'for d in /proc/[0-9]*; do p=${d#/proc/}; printf "%s %s | %s\n" "$p" "$(cat $d/comm 2>/dev/null)" "$(tr "\0" " " <$d/cmdline 2>/dev/null)"; done')
  echo "media ls /proc (pid comm | cmdline):"; echo "$out"
  expect "AC1 ls /proc in media: no app node (no stub listener, no dist/main.js, no sleep)" \
    test -z "$(grep -E 'createServer|dist/main\.js| sleep ' <<<"$out")"
  expect "AC1 ls /proc in media: media node is there (control)" has 'dist/media/main\.js' "$out"
  a=$(ex media readlink /proc/1/ns/pid); b=$(ex assistant readlink /proc/1/ns/pid)
  echo "pid namespaces: media $a assistant $b"
  expect "AC1 media and assistant have separate pid namespaces" test -n "$a" -a "$a" != "$b"

  keys=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$MID" | cut -d= -f1 | sed '/^$/d' | sort -u)
  echo "docker inspect media Config.Env keys: $(echo $keys)"
  extra=""
  for k in $keys; do case " $ENV_ALLOW " in *" $k "*) ;; *) extra="$extra $k";; esac; done
  expect "AC1 docker inspect media env allowlisted only${extra:+ (extra:$extra)}" test -z "$extra"

  section "S5/S13 media network and isolation"
  docker inspect -f 'media: user={{.Config.User}} extra_hosts={{.HostConfig.ExtraHosts}} networks={{range $k,$v := .NetworkSettings.Networks}}{{$k}}={{$v.IPAddress}} {{end}} label lw.isolated={{index .Config.Labels "lw.isolated"}} mem={{.HostConfig.Memory}} pids={{.HostConfig.PidsLimit}} ro={{.HostConfig.ReadonlyRootfs}} caps_drop={{.HostConfig.CapDrop}}' "$MID"
  docker inspect -f 'assistant: user={{.Config.User}} networks={{range $k,$v := .NetworkSettings.Networks}}{{$k}}={{$v.IPAddress}} {{end}}' "$AID"
  a=$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$MID")
  b=$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$AID")
  expect "S5 media is only on ${ACC_PROJECT}_media-egress" test "$(echo $a)" = "${ACC_PROJECT}_media-egress"
  local n common=""
  for n in $a; do case " $b " in *" $n "*) common="$common $n";; esac; done   # (no case inside $(): bash 3.2 cannot parse it)
  expect "S5 assistant shares no network with media${common:+ (shared:$common)}" test -z "$common"
  expect "S13 media IP inside 10.213.0.0/24 (outside 172.30.0.0/16)" \
    has '^10\.213\.0\.[0-9]+$' "$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$MID")"
  expect "S6 media has no extra_hosts (no host.docker.internal from lw)" \
    test "$(docker inspect -f '{{len .HostConfig.ExtraHosts}}' "$MID")" = 0

  section "AC4/S1 socket over the read-only mount, as uid 1000"
  ex assistant id
  ex assistant sh -c 'grep " /run/media-ipc " /proc/mounts; ls -ln /run/media-ipc'
  expect "AC4 assistant runs as uid 1000" has '^uid=1000' "$(ex assistant id)"
  expect "AC4 media-ipc is mounted read-only in assistant" \
    has ' ro[, ]' "$(ex assistant sh -c 'grep " /run/media-ipc " /proc/mounts')"
  if ex assistant touch /run/media-ipc/x 2>/dev/null; then res FAIL "AC4 assistant cannot write into media-ipc"; else res PASS "AC4 assistant cannot write into media-ipc"; fi
  expect "S1 socket is srw-rw-rw- owned by 10001" has '^srw-rw-rw- +1 +10001 +10001 .*media\.sock$' "$(ex assistant ls -ln /run/media-ipc)"
  out=$(js assistant health.cjs); echo "health: $out"
  expect "AC4/S1 uid-1000 connect over the ro mount: GET /v1/health = 200" has '^status=200 ' "$out"

  section "AC4/S12 /opt masks in assistant"
  out=$(ex assistant sh -c 'grep -E " /opt/(ffmpeg|yt-dlp) " /proc/mounts; for d in /opt/ffmpeg /opt/yt-dlp; do echo "ls -A $d: $(ls -A $d | wc -l) entries"; done')
  echo "$out"
  expect "S12 /opt/ffmpeg is an empty noexec tmpfs" has '^tmpfs /opt/ffmpeg tmpfs ro?.*noexec' "$out"
  expect "S12 /opt/yt-dlp is an empty noexec tmpfs" has '^tmpfs /opt/yt-dlp tmpfs ro?.*noexec' "$out"
  expect "S12 ls -A /opt/ffmpeg is empty" has '^ls -A /opt/ffmpeg: 0 entries$' "$out"
  expect "S12 ls -A /opt/yt-dlp is empty" has '^ls -A /opt/yt-dlp: 0 entries$' "$out"
  expect "AC4 assistant: test ! -x /opt/ffmpeg/ffmpeg && ! /opt/ffmpeg/ffmpeg -version" \
    ex assistant sh -c 'test ! -x /opt/ffmpeg/ffmpeg && ! /opt/ffmpeg/ffmpeg -version 2>/dev/null'
  expect "AC4 assistant: test ! -x /opt/yt-dlp/yt-dlp && ! /opt/yt-dlp/yt-dlp --version" \
    ex assistant sh -c 'test ! -x /opt/yt-dlp/yt-dlp && ! /opt/yt-dlp/yt-dlp --version 2>/dev/null'
  out=$(ex media sh -c '/opt/ffmpeg/ffmpeg -hide_banner -version | head -1; sha256sum -c /opt/ffmpeg/ffmpeg.sha256; /opt/yt-dlp/yt-dlp --version')
  echo "media control: $out"
  expect "AC4 control: media runs /opt/ffmpeg/ffmpeg 9.0.2 (manifest OK) and yt-dlp" has '^ffmpeg version 9\.0\.2 ' "$out"

  section "app-level media selection (spec 4.4)"
  out=$(js assistant select.cjs); echo "assistant (MEDIA_SOCKET set): $out"
  expect "select: assistant container with MEDIA_SOCKET -> socket backend" has '"kind":"socket"' "$out"
  out=$(drun --user 1000:1000 --read-only --entrypoint node "$ACC_IMAGE" -e "$(cat "$ACC_HERE/probes/select.cjs")" 2>&1); echo "container, no MEDIA_SOCKET: $out"
  expect "select: container without MEDIA_SOCKET -> music/voice off (media sidecar not configured)" \
    has '"result":\{"disabled":"media sidecar not configured"\}' "$out"

  section "S9 decode route with the real ffmpeg (from assistant)"
  out=$(js assistant decode.cjs <"$ACC_APP/voice/fixtures/ffmpeg-smoke/t.mp3"); echo "t.mp3: $out"
  expect "S9 mp3 decodes over /v1/decode: 200, >= 30000 PCM bytes" has 'status=200 bytes=([3-9][0-9]{4}|[0-9]{6,})$' "$out"
  out=$(js assistant decode.cjs <"$ACC_APP/voice/fixtures/ffmpeg-smoke/t.wav"); echo "t.wav: $out"
  expect "S9 WAV refused by /v1/decode (422)" has 'status=422 ' "$out"
  out=$(js assistant decode.cjs <"$ACC_APP/voice/fixtures/ffmpeg-smoke/hls-http.m3u8"); echo "hls-http.m3u8: $out"
  expect "S9 HLS playlist with http:// refused (422)" has 'status=422 ' "$out"
  out=$(js assistant track.cjs 'https://evil.com/' www.youtube.com 1000); echo "track https://evil.com/ (allowlist www.youtube.com): $out"
  expect "track: https://evil.com/ outside the allowlist -> 400" has '^status=400 ' "$out"
  out=$(js assistant track.cjs 'https://evil.com/' evil.com 3000); echo "INFO track https://evil.com/ (allowlist evil.com, i.e. the client allowed it): $out"
  # the sidecar trusts the app's allowlist; yt-dlp --use-extractors youtube is the second layer, so no byte comes back
  expect "track: an allowlisted non-YouTube URL streams nothing (yt-dlp --use-extractors youtube)" has '^status=200 bytes=0 ' "$out"

  section "S8 FAKE_* switches never honoured; no tests in the image"
  out=$(drun --name "t8acc-$ACC_RID-s8" --user 10001:10001 --read-only -e FAKE_YTDLP_HANG=1 "$ACC_IMAGE" node dist/media/main.js 2>&1); rc=$?
  echo "exit=$rc log: $out"
  expect "S8 FAKE_YTDLP_HANG=1 -> media exits 78" test "$rc" = 78
  expect "S8 the refusal names exactly FAKE_YTDLP_HANG (no other key, so the 78 is that switch)" has '"keys":\["FAKE_YTDLP_HANG"\]' "$out"
  out=$(drun --entrypoint sh "$ACC_IMAGE" -c 'test ! -e /app/tests -a ! -e /app/dist/tests && echo no-tests-dir; echo "test files: $(find /app/dist -name "*.test.js" | wc -l)"')
  echo "$out"
  expect "S8 test ! -e /app/tests -a ! -e /app/dist/tests; no *.test.js in dist" has 'no-tests-dir' "$out"
  expect "S8 no *.test.js in /app/dist" has '^test files: 0$' "$out"

  section "S12 + local kill timing: a real track (search 'x', allowlist evil.com)"
  local sm sa tp t_close t_clean elapsed clean i
  sm=$(mktemp); sa=$(mktemp); tp=$(mktemp)
  local sampler='i=0; while [ $i -lt 100 ]; do echo "--- $i"; ps -o pid,ppid,pgid,user,comm,args 2>&1; i=$((i+1)); sleep 0.25; done'
  ex media sh -c "$sampler" >"$sm" 2>&1 &
  local pm=$!
  ex assistant sh -c "$sampler" >"$sa" 2>&1 &
  local pa=$!
  js assistant track.cjs x evil.com 12000 >"$tp" 2>&1
  t_close=$(now)
  echo "track: $(cat "$tp")"
  # media children: anything but docker-init, the sidecar node, and the samplers' own sh/ps/sleep
  kids() { ex media ps -o pid,pgid,comm,args | awk 'NR>1 && $0 !~ /docker-init|dist\/media\/main\.js|ps -o|sh -c|sleep/'; }
  # a media child: comm yt-dlp/ffmpeg, or a binary under /opt (never matched on probe source text, which names them in comments)
  binmatch() { awk '$5 == "yt-dlp" || $5 == "ffmpeg" || $6 ~ /^\/opt\/(ffmpeg|yt-dlp)\//' "$1"; }
  clean=no; i=0
  while [ $i -lt 20 ]; do
    if [ -z "$(kids)" ]; then clean=yes; break; fi
    sleep 0.2; i=$((i + 1))
  done
  t_clean=$(now)
  elapsed=$(perl -e "printf '%.2f', $t_clean - $t_close")
  wait "$pm" "$pa" 2>/dev/null
  echo "media sample lines with yt-dlp/ffmpeg: $(binmatch "$sm" | wc -l | tr -d ' ') (distinct below)"; binmatch "$sm" | sort -u | head -6
  echo "assistant sample lines with yt-dlp/ffmpeg: $(binmatch "$sa" | wc -l | tr -d ' ') of $(grep -c '^--- ' "$sa") samples"
  echo "assistant sample (one):"; awk '/^--- 20$/{f=1;next} /^--- 21$/{f=0} f' "$sa"
  expect "track: search query with allowlist [evil.com] accepted (200)" has '^status=200 ' "$(cat "$tp")"
  if [ -n "$(binmatch "$sm" | awk '$5 == "yt-dlp"')" ]; then
    res PASS "S12 control: media ran yt-dlp during the track"
    expect "S12 ps in assistant during the track shows no ffmpeg/yt-dlp" test -z "$(binmatch "$sa")"
    echo "children gone ${elapsed}s after the client closed (clean=$clean)"
    if grep -q 'closed_at=' "$tp"; then
      expect "AC6-local client close mid-track kills yt-dlp + ffmpeg groups in <= 2 s (${elapsed}s)" \
        sh -c "[ $clean = yes ] && perl -e 'exit(!($elapsed <= 2.0))'"
    else
      res SKIP "AC6-local kill timing: the track ended before the client closed (nothing to kill)"
    fi
  else
    res SKIP "S12 media never showed yt-dlp (network/YouTube?); ps-during-play is a VPS live check"
  fi
  if [ -n "$(binmatch "$sm" | awk '$5 == "ffmpeg"')" ]; then res PASS "S12 control: media ran ffmpeg during the track"; else res SKIP "S12 media ffmpeg not observed during the track"; fi
  grep -q -E '^status=200 bytes=[1-9]' "$tp" && res PASS "track streamed PCM (bytes > 0)" || res SKIP "track streamed no PCM locally (YouTube reachability); AC6 live"
  rm -f "$sm" "$sa" "$tp"

  section "S13 local: media cannot reach assistant:8080"
  ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$AID")
  out=$(js assistant tcp.cjs "$ip" 8080); echo "from assistant: $out"
  expect "S13 control: assistant listens on $ip:8080" has ' open$' "$out"
  out=$(js assistant tcp.cjs "$ip" 8081); echo "from assistant: $out"
  expect "S13 control: assistant listens on $ip:8081 (not published)" has ' open$' "$out"
  out=$(js media tcp.cjs "$ip" 8080); echo "from media: $out"
  # Docker (29.x) accepts a published container port from other bridge networks; the drop for that is the lw_filter forward
  # rule of 13-firewall.sh (ruling S13-fwd), which Docker Desktop does not have. So locally this is evidence, not a verdict;
  # the VPS verdict is p4-platform-check.sh "S13 media -> assistant container IP ... fails (forward drop)".
  if has ' closed:' "$out"; then res PASS "S13 media -> assistant $ip:8080 fails"
  else res SKIP "S13 media -> assistant $ip:8080 is VPS-only (local: open; no lw_filter forward drop on this host, see 13-firewall.sh S13-fwd)"; fi
  out=$(js media tcp.cjs "$ip" 8081); echo "from media (unpublished port): $out"
  expect "S13 media -> assistant $ip:8081 (listening, not published) fails" has ' closed:' "$out"
  out=$(js media tcp.cjs assistant 8080); echo "from media: $out"
  expect "S13 media cannot resolve/reach 'assistant'" has ' closed:' "$out"
  out=$(js media https.cjs https://www.youtube.com/); echo "media outbound: $out"
  expect "S13 outbound HTTPS from media works" has '^status=[0-9]+$' "$out"
  out=$(js media tcp.cjs host.docker.internal "$ACC_PORT"); echo "INFO media -> host published port (Docker Desktop has no host firewall): $out"
  res SKIP "S13 host ports (172.30.0.1:443/:4231, 10.213.0.1:22/:4231/:2222) are VPS-only: README runbook"
}

unpatched() {
  section "AC2 an lw without isolated mode"
  local out rc=0 MID st i
  out=$(mktemp)
  dcv unpatched config --format json >"$out"
  echo "unpatched media gets: env_file=$(jq -c '[.services.media.env_file[]?.path | split("/") | last]' "$out") extra_hosts=$(jq -c '.services.media.extra_hosts' "$out") restart=$(jq -r '.services.media.restart' "$out")"
  local msg; msg=$("$ACC_PY" -I "$ACC_LWD/lw_check.py" compose "$out" "$ACC_REL" "$(dirname "$ACC_SHARED/.env")" assistant "$ACC_PORT" "" "$ACC_DBENV" 2>&1) || rc=$?
  rm -f "$out"
  echo "lw_check compose (patched checker) on the unpatched render: rc=$rc"; echo "$msg" | scrub | head -8
  expect "AC2 patched lw_check compose refuses the unpatched render (deploy stops before up)" test "$rc" != 0
  if leaks <<<"$msg"; then res FAIL "AC2 lw_check refusal prints no env value"; else res PASS "AC2 lw_check refusal prints no env value"; fi

  dcv unpatched up -d --no-deps --force-recreate --pull never media 2>&1 | scrub
  MID=$(dcv unpatched ps -aq media)
  i=0; st=""
  while [ $i -lt "$ACC_WAIT" ]; do
    st=$(docker inspect -f '{{.State.Status}}' "$MID"); [ "$st" = exited ] && break
    sleep 1; i=$((i + 1))
  done
  sleep 5
  docker inspect -f 'media (unpatched): status={{.State.Status}} exit={{.State.ExitCode}} restarts={{.RestartCount}} health={{if .State.Health}}{{.State.Health.Status}}{{end}} restart_policy={{.HostConfig.RestartPolicy.Name}}' "$MID"
  echo "media (unpatched) env keys: $(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$MID" | cut -d= -f1 | sed '/^$/d' | sort -u | tr '\n' ' ')"
  expect "AC2 unpatched media exits 78" test "$(docker inspect -f '{{.State.ExitCode}}' "$MID")" = 78
  st=$(docker inspect -f '{{.State.Status}} {{.RestartCount}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$MID")
  expect "AC2 unpatched media stays exited, never healthy, not restarted (restart: no) [$st]" has '^exited 0( (starting|unhealthy))?$' "$st"
  out=$(docker logs "$MID" 2>&1)
  echo "media (unpatched) log:"; echo "$out" | scrub | head -5
  expect "AC2 the log names ZZ_MARKER (the 78 comes from the env check)" has 'ZZ_MARKER' "$out"
  if leaks <<<"$out"; then res FAIL "AC2 the log holds no env value"; else res PASS "AC2 the log holds no env value"; fi
}

case $PHASE in
  live) live ;;
  unpatched) unpatched ;;
  *) echo "usage: check.sh live|unpatched" >&2; exit 64 ;;
esac
echo "check.sh $PHASE: $FAILS failure(s)"
[ "$FAILS" = 0 ]
