#!/usr/bin/env bash
# Opt-in probes for Gate 2 (Gate 1 self-code X2, X1, X3, X4, X27). NOT run by `npm test`. Needs Docker, the images (docker/devjob/build.sh) and `npm run build`.
# Uses a FAKE upstream (no real model call, no money), a fake key and the fixed-argv launcher's own baseline. Prints PASS/FAIL per probe; exit 1 if any FAIL.
set -uo pipefail
cd "$(dirname "$0")/../.."
JOB=J-0000000000000000
export DEVJOB_ANTHROPIC_API_KEY=sk-ant-REALKEY-0000000000000000 DEVJOB_PROXY_TOKEN=$(printf 't%.0s' {1..40}) DEVJOB_PRICES_JSON='{"claude-test":{"inUsd":3,"outUsd":15}}'
export DEVJOB_MONTHLY_CAP_USD=20 DEVJOB_UPSTREAM_URL=http://fakeup:9000 DEVJOB_UPSTREAM_ALLOW_HTTP=1
IMG=$(node -e 'console.log(JSON.stringify(require("./docker/devjob/images.json")))')
agent=$(node -pe 'JSON.parse(process.argv[1]).agent' "$IMG"); prep=$(node -pe 'JSON.parse(process.argv[1]).prep' "$IMG"); testimg=$(node -pe 'JSON.parse(process.argv[1]).test' "$IMG")
fail=0
cleanup() { docker rm -f fakeup "devjob-$JOB-agent" "devjob-$JOB-prep" "devjob-$JOB-test" >/dev/null 2>&1; docker compose -p devjob -f docker-compose.devjob.yml down -v >/dev/null 2>&1; }
trap cleanup EXIT
docker compose -p devjob -f docker-compose.devjob.yml up -d >/dev/null || { echo "FAIL compose up"; exit 1; }
# fake upstream: answers any POST with a usage block; also serves a package document for the registry proxy probe
docker run -d --rm --name fakeup --network devjob_egress_model --network-alias fakeup "$agent" node -e '
require("http").createServer((q,r)=>{let b="";q.on("data",c=>b+=c);q.on("end",()=>{if(q.method==="GET"){r.setHeader("content-type","application/json");return r.end("{\"name\":\"left-pad\"}")}r.setHeader("content-type","application/json");r.end(JSON.stringify({id:"m",type:"message",usage:{input_tokens:10,output_tokens:5},key_seen:q.headers["x-api-key"]===process.env.NOPE}))})}).listen(9000)' >/dev/null
docker network connect --alias fakeup devjob_egress_registry fakeup >/dev/null 2>&1
sleep 3
CRED=$(curl -s -X POST -H "authorization: Bearer $DEVJOB_PROXY_TOKEN" -d "{\"jobId\":\"$JOB\",\"capUsd\":1,\"ttlSec\":600}" http://127.0.0.1:8788/jobs | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).credential')
[ -n "$CRED" ] || { echo "FAIL could not register a job credential"; exit 1; }
base() { node -e 'const m=require("./dist/devjob/launcher.js");console.log(JSON.stringify(m.baseline(process.argv[1],process.argv[2],process.argv[3],{interactive:false})))' "$JOB" "$1" "$2"; }
run() { local role=$1 net=$2; shift 2; local argv; argv=$(base "$role" "$net"); local A=(); while IFS= read -r line; do A+=("$line"); done < <(node -pe 'JSON.parse(process.argv[1]).join("\n")' "$argv"); docker "${A[@]}" "$@"; }
probe() { local out; out=$(run "$@" 2>&1); echo "$out" | sed 's/^/  /'; echo "$out" | grep -q '^FAIL' && fail=1; }
JS=$(cat docker/devjob/probe.js)
echo "== agent container on devjob_agentnet =="
probe agent devjob_agentnet -e MODE=agent -e ANTHROPIC_BASE_URL=http://10.88.78.2:8080 -e ANTHROPIC_API_KEY="$CRED" "$agent" node -e "$JS"
echo "== test container on network none =="
probe test none -e MODE=test --entrypoint node "$testimg" -e "$JS"
echo "== prep container on devjob_prepnet =="
probe prep devjob_prepnet -e MODE=prep -e NPM_REGISTRY=http://10.88.79.2:4873 --entrypoint node "$prep" -e "$JS"
echo "== spend metered by the proxy =="
S=$(curl -s -H "authorization: Bearer $DEVJOB_PROXY_TOKEN" "http://127.0.0.1:8788/jobs/$JOB")
echo "  $S"; echo "$S" | grep -q '"requests":1' && echo "  PASS proxy counted the allowed request only" || { echo "  FAIL proxy request count"; fail=1; }
exit $fail
