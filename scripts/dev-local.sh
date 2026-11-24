#!/usr/bin/env bash
# Run the CLI on a dev machine. Usage: scripts/dev-local.sh [--fake] [extra core.cli args, e.g. --script FILE]
# Data lives outside the repo: ${EMP_DEV_DIR:-$HOME/.local/share/employee-dev}. Never prints secret values.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PY=$ROOT/.venv/bin/python
D=${EMP_DEV_DIR:-$HOME/.local/share/employee-dev}
FAKE=0
if [ "${1:-}" = "--fake" ]; then FAKE=1; shift; fi
[ -x "$PY" ] || { echo "missing $PY - create the venv first (see docs/helper/local-dev.md)" >&2; exit 1; }

umask 077
mkdir -p "$D/db" "$D/knowledge" "$D/logs" "$D/voice"
chmod 700 "$D" "$D/db" "$D/knowledge" "$D/logs" "$D/voice"
[ -n "$(ls -A "$D/knowledge")" ] || cp -R "$ROOT/knowledge/." "$D/knowledge/"

run() (  # subshell: nothing it loads leaks into the caller
  cd "$ROOT"
  if [ "$FAKE" = 0 ]; then
    [ -f .env.local ] || { echo "real mode needs $ROOT/.env.local (or use --fake)" >&2; exit 1; }
    set -a
    # shellcheck source=/dev/null
    . ./.env.local
    set +a
    if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -n "${ANTHROPIC_API_TOKEN:-}" ]; then
      echo "ANTHROPIC_API_TOKEN is set but ANTHROPIC_API_KEY is not: rename it to ANTHROPIC_API_KEY in .env.local" >&2; exit 1
    fi
    # 12.13 / G1-06: the CLI dev identity never runs with Discord tokens in its environment
    for v in $(compgen -v | grep -E '^(DISCORD_BOT_TOKEN|DISCORD_APP_ID_)' || true); do unset "$v"; done
    missing=""
    for v in DISCORD_GUILD_ID APPROVAL_CHANNEL_ID ADMIN_NOTIFY_CHANNEL_ID TASKS_CHANNEL_ID DEFAULT_CHEAP_MODEL \
             REPLY_TIER2_MODEL IMAGE_MODEL TTS_MODEL TTS_VOICE STT_PROVIDER STT_MODEL; do
      [ -n "${!v:-}" ] || missing="$missing $v"
    done
    [ -z "$missing" ] || { echo "missing in .env.local (names in .env.example):$missing" >&2; exit 1; }
  fi
  export DATABASE_PATH="$D/db/emp.db" KNOWLEDGE_DIR="$D/knowledge" LOG_DIR="$D/logs" VOICE_TMP_DIR="$D/voice" EMP_CLI_DEV=1
  "$PY" -m core.migration >/dev/null
  if [ "$FAKE" = 1 ]; then exec "$PY" -m core.cli --as admin --fake "$@"; fi
  exec "$PY" -m core.cli --as admin "$@"
)
run "$@"
