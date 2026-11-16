#!/usr/bin/env bash
# Builds the two ws images from the repo root and writes their ids to docker/ws/images.json (SA-1 C3: the app starts the runner by image id).
# Runs `npm run build` itself when dist/ lacks the proxy files (the proxy image copies them). Does not touch docker/devjob/.
set -euo pipefail
cd "$(dirname "$0")/../.."
{ [ -f dist/devjob/registryproxy.js ] && [ -f dist/workspaces/registryproxy-main.js ]; } || npm run build --silent
b() { docker build -q -f "docker/ws/$1.Dockerfile" -t "assistant-ws-$1:local" . ; }
runner=$(b runner); proxy=$(b registryproxy)
printf '{"runner":"%s","proxy":"%s"}\n' "$runner" "$proxy" > docker/ws/images.json
echo "runner=$runner proxy=$proxy"
