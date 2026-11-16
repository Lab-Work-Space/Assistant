#!/usr/bin/env bash
# Run the assistant on the owner's Mac as a per-user launchd agent (starts at login, restarts if it stops).
#   bash scripts/app-service.sh install    write ~/Library/LaunchAgents/net.labworkspace.assistant.plist and print the launchctl lines to run
#   bash scripts/app-service.sh run        the agent's entry point: wait for Docker, start the local PostgreSQL, then exec scripts/dev.sh
#   bash scripts/app-service.sh status     show the plist, the launchd state and the last log lines
#   bash scripts/app-service.sh uninstall  print the launchctl line that stops the agent, then move the plist to the Trash
# The agent runs as the logged-in user (same rights as `npm run dev`); it never uses sudo and this script never calls launchctl itself.
# Logs: ~/Library/Logs/assistant/{app.log,app.err.log}. No secret is written to the plist: dev.sh reads ~/.config/assistant/env.local itself.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
LABEL=net.labworkspace.assistant
PLIST=${ASSISTANT_PLIST:-$HOME/Library/LaunchAgents/$LABEL.plist}
LOGDIR=${ASSISTANT_LOGDIR:-$HOME/Library/Logs/assistant}
DOCKER_WAIT_SEC=${ASSISTANT_DOCKER_WAIT_SEC:-300}

xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

agent_path() {  # PATH for the agent: node, docker and claude must resolve without a login shell
  local p="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" d
  for d in "$HOME/.local/bin" "$(dirname "$(command -v node 2>/dev/null || echo /usr/local/bin/node)")" \
           "$(dirname "$(command -v claude 2>/dev/null || echo /usr/local/bin/claude)")" \
           "$(dirname "$(command -v docker 2>/dev/null || echo /usr/local/bin/docker)")"; do
    case ":$p:" in *":$d:"*) ;; *) p="$d:$p" ;; esac
  done
  # A pinned CLI (a `claude` symlink to the probed version) wins over the auto-updating one, so a CLI update does not break the probe pin.
  [ -x "$HOME/.config/assistant/bin/claude" ] && p="$HOME/.config/assistant/bin:$p"
  printf '%s' "$p"
}

install() {
  mkdir -p "$(dirname "$PLIST")" "$LOGDIR"
  chmod 700 "$LOGDIR"
  local tmp
  tmp=$(mktemp "$(dirname "$PLIST")/.$LABEL.XXXXXX")
  cat >"$tmp" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$(xml_escape "$ROOT/scripts/app-service.sh")</string>
    <string>run</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml_escape "$ROOT")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(xml_escape "$(agent_path)")</string>
    <key>HOME</key><string>$(xml_escape "$HOME")</string>
    <key>LANG</key><string>${LANG:-en_US.UTF-8}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$(xml_escape "$LOGDIR/app.log")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$LOGDIR/app.err.log")</string>
</dict>
</plist>
EOF
  chmod 644 "$tmp"
  plutil -lint "$tmp" >/dev/null
  mv -f "$tmp" "$PLIST"
  echo "wrote $PLIST"
  echo "Run these yourself to start it now (and at every login):"
  echo "  launchctl bootout gui/\$(id -u)/$LABEL 2>/dev/null; launchctl bootstrap gui/\$(id -u) \"$PLIST\""
  echo "Restart later with: launchctl kickstart -k gui/\$(id -u)/$LABEL"
}

run() {
  cd "$ROOT"
  echo "$(date '+%F %T') app-service: waiting for Docker (up to ${DOCKER_WAIT_SEC}s)"
  local waited=0
  until docker info >/dev/null 2>&1; do
    [ "$waited" -lt "$DOCKER_WAIT_SEC" ] || { echo "app-service: Docker is not running; open Docker Desktop (launchd retries in 30s)" >&2; exit 1; }
    sleep 5; waited=$((waited + 5))
  done
  bash scripts/dev.sh db up
  # Best effort: the web, document and media side services. Their containers restart with Docker, but the media relay is a host process.
  local svc
  for svc in chrome render media; do bash scripts/dev.sh "$svc" up || echo "app-service: $svc did not start; its tools stay off" >&2; done
  echo "$(date '+%F %T') app-service: starting the assistant"
  exec bash scripts/dev.sh
}

status() {
  echo "plist:   $([ -f "$PLIST" ] && echo "present ($PLIST)" || echo absent)"
  echo "launchd: $(launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | sed -n 's/^[[:space:]]*state = //p' | head -n 1 || true)"
  [ -f "$LOGDIR/app.err.log" ] && { echo "--- last stderr lines"; tail -n 5 "$LOGDIR/app.err.log"; } || true
}

uninstall() {
  echo "Run this yourself first to stop it:"
  echo "  launchctl bootout gui/\$(id -u)/$LABEL"
  if [ -f "$PLIST" ]; then mv "$PLIST" "$HOME/.Trash/$LABEL.plist.$(date +%Y%m%d%H%M%S)"; echo "moved $PLIST to the Trash"; fi
}

case "${1:-}" in
  install) install ;;
  run) run ;;
  status) status ;;
  uninstall) uninstall ;;
  *) echo "usage: app-service.sh install|run|status|uninstall" >&2; exit 2 ;;
esac
