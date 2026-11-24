#!/usr/bin/env bash
# Run the Discord bot on a dev Mac (spec 12.4, S12-06, 12.9, 12.10). Usage: scripts/dev-discord.sh
# Single-instance rule: stop the VPS service before starting here, and the reverse. Never prints the env file or secrets.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PY=$ROOT/.venv/bin/python
ENVF=${EMP_DISCORD_ENV_FILE:-$ROOT/.env.local}
D=${EMP_DEV_DIR:-$HOME/.local/share/employee-dev}/discord
die() { echo "dev-discord: $1" >&2; exit 1; }

[ -x "$PY" ] || die "missing $PY - create the venv first (see docs/helper/local-dev.md)"
[ -z "${EMP_CLI_DEV:-}" ] || die "EMP_CLI_DEV is set: the Discord run must not carry the CLI dev flag"
# S12-06 (12.13): regular file, not a symlink, owned by me, mode 0600
[ -e "$ENVF" ] || die "missing $ENVF (see docs/helper/discord-apps.md)"
[ ! -L "$ENVF" ] && [ -f "$ENVF" ] || die "$ENVF must be a regular file, not a symlink"
if mode_owner=$(stat -f '%Lp %u' "$ENVF" 2>/dev/null); then :; else mode_owner=$(stat -c '%a %u' "$ENVF"); fi
[ "$mode_owner" = "600 $(id -u)" ] || die "$ENVF must be owned by you with mode 0600"

umask 077
mkdir -p "$D/db" "$D/knowledge" "$D/logs" "$D/voice"
chmod 700 "$D" "$D/db" "$D/knowledge" "$D/logs" "$D/voice"
[ -n "$(ls -A "$D/knowledge")" ] || cp -R "$ROOT/knowledge/." "$D/knowledge/"

run() (  # subshell: nothing it loads leaks into the caller
  cd "$ROOT"
  unset DATABASE_PATH KNOWLEDGE_DIR LOG_DIR VOICE_TMP_DIR
  set -a
  # shellcheck source=/dev/null
  . "$ENVF"
  set +a
  for v in EMP_CLI_DEV DATABASE_PATH KNOWLEDGE_DIR LOG_DIR VOICE_TMP_DIR; do
    [ -z "${!v:-}" ] || die "$ENVF must not set $v (the script owns it)"
  done
  [ -z "${DISCORD_BOT_TOKEN:-}" ] || die "DISCORD_BOT_TOKEN is not used: set DISCORD_BOT_TOKEN_<PERSONA> per persona"
  [ -n "${CHANNEL_ALLOWLIST:-}" ] || die "CHANNEL_ALLOWLIST is empty"
  export DATABASE_PATH="$D/db/emp.db" KNOWLEDGE_DIR="$D/knowledge" LOG_DIR="$D/logs" VOICE_TMP_DIR="$D/voice"
  "$PY" -m core.migration >/dev/null
  exec "$PY" -m core
)
run
