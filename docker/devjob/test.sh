#!/bin/sh
# FIXED commands (Gate 1 self-code X5): never `npm test` or any package.json script. The config files they read are non-self-modifiable, so they equal base.
# G2SC-04: the harness sends a nonce on stdin. It is read into a shell variable, stdin is closed for everything that runs afterwards, type check and
# build run BEFORE the tests, and the result line (with the nonce) is the last thing printed. Test output goes to a file, never to this stdout.
set -u
IFS= read -r NONCE
exec </dev/null
case "$NONCE" in *[!0-9a-f]*|"") echo "bad nonce" >&2; exit 2;; esac
export HOME=/home/agent GIT_CONFIG_NOSYSTEM=1 CI=1
cd /work/repo || exit 2
git config --global --add safe.directory '*' 2>/dev/null || true
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit >/tmp/tsc.log 2>&1 && TC=true || TC=false
node node_modules/typescript/bin/tsc -p tsconfig.build.json --outDir /tmp/dist >/tmp/build.log 2>&1 && BD=true || BD=false
node node_modules/vitest/vitest.mjs run --project unit --reporter=json --outputFile=/tmp/vitest.json >/tmp/vitest.log 2>&1
COUNTS=$(node -e '
const fs=require("fs");let r={};try{r=JSON.parse(fs.readFileSync("/tmp/vitest.json","utf8"))}catch{}
process.stdout.write(JSON.stringify({run:r.numTotalTests||0,failed:r.numFailedTests||0}))')
tail -c 3000 /tmp/tsc.log >&2; tail -c 3000 /tmp/build.log >&2; tail -c 3000 /tmp/vitest.log >&2
node -e '
const c=JSON.parse(process.argv[1]);
console.log("DEVJOB_RESULT "+process.argv[4]+" "+JSON.stringify({testsRun:c.run,testsFailed:c.failed,typecheck:process.argv[2]==="true",build:process.argv[3]==="true"}))' "$COUNTS" "$TC" "$BD" "$NONCE"
