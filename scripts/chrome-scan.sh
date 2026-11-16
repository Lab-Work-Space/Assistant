#!/usr/bin/env bash
# Supply-chain scan of both Chrome images (global rule 21, C32): fails on any HIGH or worse that already has a fix.
#   npm run chrome:scan      (needs grype: brew install grype)
# The proxy image must come out clean. The Chrome image (Debian) carries HIGHs that Debian has not fixed; --only-fixed hides those and
# they are an owner-accepted residual, re-scanned on every pin bump (docker/chrome/README.md). Run `grype <image>` without the flags to see them.
set -uo pipefail
command -v grype >/dev/null || { echo "grype not found (brew install grype)" >&2; exit 2; }
ROOT=$(cd "$(dirname "$0")/.." && pwd)
CHROME_IMG=$(sed -n 's/^ *image: \(chromedp\/headless-shell@sha256:[0-9a-f]*\).*/\1/p' "$ROOT/docker-compose.chrome.yml" | head -n 1)
rc=0
for img in assistant-chrome-guardproxy:local "$CHROME_IMG"; do
  echo "== $img"
  grype "docker:$img" --fail-on high --only-fixed || rc=1
done
exit $rc
