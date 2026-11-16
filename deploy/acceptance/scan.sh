#!/usr/bin/env bash
# Praw media sidecar acceptance: AC3 / Gate 1 S10 image scan. bash 3.2 compatible.
#
#   deploy/acceptance/scan.sh IMAGE
#   deploy/acceptance/scan.sh --check-grype GRYPE.json    only the grype verdict on a saved `grype -o json` (no docker)
#
# grype (the local binary) on IMAGE, and syft v1.55.0 (the anchore/syft image, pinned tag) on a `docker save` archive of IMAGE in
# a scratch dir mounted read-only (no docker socket is given to the scanner). Prints every grype row, then the checks:
# no ffmpeg, glib, cjson or alsa row; whether syft catalogued /opt/ffmpeg (S10: it cannot see a hand-built static binary, so the
# README P22 fix table is the evidence). Exit 1 if a forbidden row is present, if any row is High or Critical, or if a
# Medium-or-higher CVE is not one of the owner residuals in RESIDUALS (README "Owner lines").
set -uo pipefail
# Accepted residuals (Gate 1 S14 / README owner lines): ffmpeg RTSP (owner, 2026-11-01), busybox, yt-dlp-bundled python.
RESIDUALS='["CVE-2026-107696","CVE-2025-60876","CVE-2025-15367","CVE-2026-103995"]'
rc=0
res() { echo "$1 $2"; [ -z "${ACC_RES:-}" ] || echo "$1 $2" >>"$ACC_RES"; [ "$1" != FAIL ] || rc=1; }
grype_verdict() {  # grype_verdict GRYPE.json
  local bad hi un
  # spec AC3: no glib, cjson or alsa-lib row; no ffmpeg 8.x row; an ffmpeg/libav row may only be CVE-2026-107696 on 9.x
  bad=$(jq -r '.matches[] | select((.artifact.name | test("glib|cjson|alsa"; "i"))
        or ((.artifact.name | test("ffmpeg|libav"; "i")) and ((.artifact.version | startswith("8")) or .vulnerability.id != "CVE-2026-107696")))
        | "\(.artifact.name) \(.artifact.version) \(.vulnerability.id)"' "$1" | sort -u)
  if [ -z "$bad" ]; then res PASS "AC3 grype: no glib/cjson/alsa-lib or ffmpeg 8.x row; ffmpeg only CVE-2026-107696"; else res FAIL "AC3 grype forbidden rows: $(echo $bad)"; fi
  # the only High the owner accepted is CVE-2026-107696 (ffmpeg RTSP, not compiled in); any other High/Critical fails
  hi=$(jq -r '.matches[] | select(.vulnerability.severity == "High" or .vulnerability.severity == "Critical")
        | select(.vulnerability.id != "CVE-2026-107696") | "\(.artifact.name) \(.vulnerability.id) \(.vulnerability.severity)"' "$1" | sort -u)
  if [ -z "$hi" ]; then res PASS "AC3 grype: no High/Critical row (besides owner-accepted CVE-2026-107696)"; else res FAIL "AC3 grype High/Critical: $(echo $hi)"; fi
  un=$(jq -r --argjson ok "$RESIDUALS" '.matches[] | select(.vulnerability.severity | IN("Medium", "High", "Critical"))
        | select(.vulnerability.id as $i | $ok | index($i) | not) | "\(.artifact.name) \(.vulnerability.id) \(.vulnerability.severity)"' "$1" | sort -u)
  if [ -z "$un" ]; then res PASS "AC3 grype: every Medium+ CVE is an accepted residual"; else res FAIL "AC3 grype Medium+ outside the residual allowlist: $(echo $un)"; fi
}
if [ "${1:-}" = --check-grype ]; then grype_verdict "${2:?usage: scan.sh --check-grype GRYPE.json}"; exit $rc; fi
IMAGE=${1:?usage: scan.sh IMAGE}
SYFT_IMAGE=${ACC_SYFT_IMAGE:-anchore/syft:v1.55.0}
TMPROOT=${ACC_TMP:-${TMPDIR:-/tmp}}
command -v grype >/dev/null || { echo "scan.sh: grype not found" >&2; exit 2; }
W=$(mktemp -d "$TMPROOT/t8scan.XXXXXX")
trap 'rm -rf "$W"' EXIT

echo "grype: $(grype version 2>/dev/null | awk '/^Version:/ {print $2}')  image: $IMAGE $(docker image inspect -f '{{.Os}}/{{.Architecture}} {{.Id}}' "$IMAGE")"
grype -q "docker:$IMAGE" -o json >"$W/grype.json" || { res FAIL "S10 grype ran"; exit 1; }
echo "grype DB: $(jq -r '.descriptor.db.status.built // .descriptor.db.built // "?"' "$W/grype.json")"
echo "grype rows (package version type | vuln severity | fixed-in):"
jq -r '.matches[] | "\(.artifact.name) \(.artifact.version) \(.artifact.type) | \(.vulnerability.id) \(.vulnerability.severity) | \(.vulnerability.fix.versions | join(","))"' \
  "$W/grype.json" | sort -u
echo "grype severity counts: $(jq -c '[.matches[].vulnerability.severity] | group_by(.) | map({(.[0]): length}) | add // {}' "$W/grype.json")"
grype_verdict "$W/grype.json"
crit=$(jq -r '[.matches[] | select(.vulnerability.severity == "Critical" or .vulnerability.severity == "High")] | map("\(.artifact.name) \(.vulnerability.id)") | unique | join(", ")' "$W/grype.json")
echo "grype High/Critical: ${crit:-none}"

docker save -o "$W/image.tar" "$IMAGE" || { res FAIL "S10 docker save"; exit 1; }
if docker run --rm --network bridge -v "$W:/in:ro" "$SYFT_IMAGE" -q docker-archive:/in/image.tar -o syft-json >"$W/syft.json" 2>"$W/syft.err"; then
  echo "syft: $SYFT_IMAGE  packages: $(jq '.artifacts | length' "$W/syft.json")"
  echo "syft package types: $(jq -c '[.artifacts[].type] | group_by(.) | map({(.[0]): length}) | add' "$W/syft.json")"
  echo "syft non-npm packages:"; jq -r '.artifacts[] | select(.type != "npm") | "  \(.name) \(.version) \(.type)"' "$W/syft.json" | sort -u
  ff=$(jq -r '.artifacts[] | select((.name | test("ffmpeg"; "i")) or ([.locations[]?.path] | any(startswith("/opt/ffmpeg")))) | "\(.name) \(.version) \(.type)"' "$W/syft.json")
  echo "syft rows for ffmpeg or /opt/ffmpeg: ${ff:-none}"
  res PASS "S10 syft ran (catalogued /opt/ffmpeg: ${ff:-no})"
else
  sed -n 1,5p "$W/syft.err"; res FAIL "S10 syft ran"
fi
exit $rc
