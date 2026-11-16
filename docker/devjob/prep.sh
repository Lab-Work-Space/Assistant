#!/bin/sh
# Reads a full git bundle on stdin, checks out $REV, installs dependencies from the lockfile WITHOUT running any script.
set -eu
: "${REV:?}" "${NPM_REGISTRY:?}"
case "$REV" in *[!0-9a-f]*) echo "bad REV" >&2; exit 2;; esac
[ "${#REV}" -eq 40 ] || { echo "bad REV" >&2; exit 2; }
export HOME=/home/agent GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0
head -c 52428800 > /tmp/in.bundle
git -c protocol.allow=never -c core.hooksPath=/dev/null init -q /work/repo
cd /work/repo
git -c protocol.allow=never -c core.hooksPath=/dev/null -c transfer.fsckObjects=true fetch -q /tmp/in.bundle '+refs/*:refs/bundle/*'
git -c core.hooksPath=/dev/null checkout -q --detach "$REV"
rm -f /tmp/in.bundle
# .npmrc of the tree is base-equal (non-self-modifiable); the registry and the script ban are forced here as well.
npm ci --ignore-scripts --no-audit --no-fund --registry "$NPM_REGISTRY" --userconfig /dev/null --globalconfig /dev/null --replace-registry-host=always
echo "prepared $REV"
