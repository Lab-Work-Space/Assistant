#!/usr/bin/env bash
# Opt-in end-to-end test of the Chrome container (Gate 1 Part C): real Chrome, real guard proxy code, a hostile origin container.
#   npm run chrome:e2e      (needs Docker; stops the normal Chrome stack first because the ports and subnet are the same)
# The throwaway stack is compose project chrome-e2e; it is removed afterwards and the normal stack is started again if it was running.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
export E2E_DIR="$ROOT/tests/chrome-e2e"
CHROME_ACCESS_TOKEN=$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n'); export CHROME_ACCESS_TOKEN
CF="$ROOT/docker-compose.chrome.yml"
was_up=0
if docker compose -f "$CF" ps --status running -q 2>/dev/null | grep -q .; then was_up=1; fi
cleanup() {
  docker compose -p chrome-e2e -f "$CF" -f "$E2E_DIR/override.yml" down >/dev/null 2>&1 || true
  if [ "$was_up" = 1 ]; then docker compose -f "$CF" up -d --wait >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
(cd "$ROOT" && npm run build --silent)
docker compose -f "$CF" down >/dev/null 2>&1 || true
docker compose -p chrome-e2e -f "$CF" -f "$E2E_DIR/override.yml" up -d --build --wait
node "$E2E_DIR/run.mjs"
