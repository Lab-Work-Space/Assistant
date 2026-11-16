#!/bin/sh
# The bundle leaves ONLY as the stdout of this fixed command (Gate 1 self-code X7); the volume is mounted read-only and there is no network.
set -eu
: "${BASE:?}"
case "$BASE" in *[!0-9a-f]*) exit 2;; esac
export HOME=/home/agent GIT_CONFIG_NOSYSTEM=1
cd /work/repo
exec git -c core.hooksPath=/dev/null -c core.fsmonitor= -c protocol.allow=never -c safe.directory='*' bundle create - "${BASE}..job"
