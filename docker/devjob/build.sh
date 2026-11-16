#!/usr/bin/env bash
# Builds the five dev-job images from the repo root and writes their image ids to docker/devjob/images.json (Gate 1 self-code X4: the launcher
# starts images by id). Run `npm run build` first (the proxies copy dist/). Build args: CLI_VERSION (default pinned in agent.Dockerfile).
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -f dist/devjob/modelproxy.js ] || { echo "run npm run build first" >&2; exit 1; }
b() { docker build -q -f "docker/devjob/$1.Dockerfile" -t "assistant-devjob-$1:local" "${@:2}" . ; }
prep=$(b prep); agent=$(b agent ${CLI_VERSION:+--build-arg CLI_VERSION="$CLI_VERSION"}); test=$(b test)
mp=$(b modelproxy); rp=$(b registryproxy)
printf '{"prep":"%s","agent":"%s","test":"%s"}\n' "$prep" "$agent" "$test" > docker/devjob/images.json
echo "prep=$prep agent=$agent test=$test modelproxy=$mp registryproxy=$rp"
