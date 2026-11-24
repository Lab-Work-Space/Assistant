#!/bin/sh
# Slice A acceptance (TASK-021A). Temp SQLite file under <out_dir>/work/data (spec 11.14); no docker. <out_dir> must be outside the repo.
# Usage (from repo root): sh tests/acceptance/run.sh <out_dir>
set -u
OUT=$1; mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd); ROOT=$PWD; PY=$ROOT/.venv/bin/python
export DATABASE_PATH="$OUT/work/data/emp.db"
mkdir -p "$OUT/work/data" && chmod 700 "$OUT/work/data"
export EMP_CLI_DEV=1 ACC_WORK="$OUT/work" PLANT_ANTHROPIC="sk-ant-PLANTED-$($PY -c 'import secrets;print(secrets.token_hex(10))')" PLANT_GOOGLE="AIzaPLANTED$($PY -c 'import secrets;print(secrets.token_hex(10))')"
unset DISCORD_BOT_TOKEN
PYTHONPATH=$ROOT "$PY" -m core.migration > "$OUT/migrate.txt" 2>&1; echo "migrate rc=$?"
W=$ACC_WORK; mkdir -p $W/knowledge/notes $W/knowledge/meetings $W/knowledge/memory $W/knowledge/rules; for a in meetings memory rules; do : > $W/knowledge/$a/_index.md; done
printf -- '- [Alpha plan](alpha-plan.md) — the alpha launch plan | alpha\n- [Beta plan](beta-plan.md) — the beta rollout | beta\n' > $W/knowledge/notes/_index.md
printf -- '---\ntitle: Alpha plan\nvisibility: public\n---\nALPHA-BODY-MARKER\n' > $W/knowledge/notes/alpha-plan.md
printf -- '---\ntitle: Beta plan\nvisibility: public\n---\nBETA-BODY-MARKER\n' > $W/knowledge/notes/beta-plan.md
sed "s/@GOOGLE@/$PLANT_GOOGLE/;s/@ANTHROPIC@/$PLANT_ANTHROPIC/" tests/acceptance/scripts/ac10_secret.tmpl > $W/ac10_secret.txt
run() { n=$1; shift; s=$1; shift; $PY tests/acceptance/run_case.py "$s" "$@" > "$OUT/$n.out" 2> "$OUT/$n.err"; echo "$n rc=$?"; }
S=$ROOT/tests/acceptance/scripts
run ac1 $S/ac1_stream.txt
run ac2 $S/ac2_delegate.txt
run ac3 $S/ac3_brainstorm.txt
run ac4 $S/ac4_approval.txt
run ac5 $S/ac5_knowledge.txt
run ac6 $S/ac6_image.txt
run ac9 $S/ac9_crash.txt SEEDJOB=selftest_crash JOBS_ENABLE_SELFTEST=true JOB_POLL_INTERVAL_S=0.2
"$PY" -c "import sqlite3,os;print(*sqlite3.connect('file:'+os.environ['DATABASE_PATH']+'?mode=ro',uri=True).execute('select kind, status, error, exit_code from jobs').fetchall(),sep='\n')" | tee "$OUT/db_jobs.txt"
run ac10 $W/ac10_secret.txt
run ac11 $S/ac11_exploratory.txt
echo "--- full pytest "; (unset EMP_CLI_DEV; "$PY" -m pytest -q -p no:cacheprovider > "$OUT/pytest.txt" 2>&1; tail -3 "$OUT/pytest.txt")
echo "--- DB evidence"
echo "--- AC-5 knowledge.open log lines"; grep -h '"event": "knowledge.open"' $W/logs/*.jsonl | tee "$OUT/ac5_knowledge_log.txt"
echo "--- AC-1 implicit respond log"; grep -h 'implicit' $W/logs/*.jsonl | head -3 | tee "$OUT/ac1_implicit_log.txt"
echo "--- AC-10 grep (must be 0 hits each)"
for v in "$PLANT_ANTHROPIC" "$PLANT_GOOGLE"; do
  echo "secret(len ${#v}) files_with_value: $(grep -rlF -- "$v" "$OUT" 2>/dev/null | sed "s|$OUT/||" | tr '\n' ' ')"; done
echo "(ac10_secret.txt is the script INPUT holding the planted values; app.jsonl/ac*.err/all other outputs must be absent above)"
grep -c '\*\*\*' $OUT/ac10.out | sed 's/^/ac10 masked-marker lines: /'
