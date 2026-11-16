#!/bin/bash
# LW Admin executor as a launchd service under its OWN macOS user (OD-1, Gate 1 vps-deploy; closes G2SM-01 on the Mac).
# Owner-run with sudo. bash 3.2 compatible (macOS /bin/bash).
#
#   sudo bash scripts/executor-service.sh install [--host-key-file FILE] [--db-url-file FILE] [--node PATH]
#   sudo bash scripts/executor-service.sh set-token          replace BOT_TOKEN_ADMIN (hidden prompt) and restart the job
#   sudo bash scripts/executor-service.sh rotate-key         new deploy key pair (prints the VPS key line)
#   sudo bash scripts/executor-service.sh uninstall [--purge]
#   bash scripts/executor-service.sh status                  no sudo needed
#
# What it builds (all absolute paths below are prefixed with $LWADMIN_ROOT, empty on a real install):
#   user _lwadmin (hidden, no shell, no password)        group _lwadmin_ipc: _lwadmin + the owner (the owner's uid can use the socket)
#   /usr/local/lib/lwadmin/{dist,node_modules,package.json}   root:wheel 755 (the service cannot change its own code)
#   /var/lwadmin            _lwadmin 0711 (traverse only)
#   /var/lwadmin/private    _lwadmin 0700: env.admin (0600: bot token, executor DB url, role id), deploy/ (key 0600, pinned known_hosts 0600)
#   /var/lwadmin/run        _lwadmin:_lwadmin_ipc 0750: executor.sock (0660)       /var/lwadmin/log (0750, group readable)
#   /Library/LaunchDaemons/net.labworkspace.lwadmin.plist
# The owner's uid can connect to the socket (group) but can read neither the token nor the deploy key. Node has no getpeereid, so there is no
# per-connection uid check: any process of the owner can talk to the socket (it can only name card ids; the executor re-checks everything).
# Testing: LWADMIN_DRY=1 LWADMIN_ROOT=<tmp> skips root, dscl, launchctl, chown and sudo -u and writes the files under the prefix.
set -euo pipefail
umask 077

SVC_USER=_lwadmin
IPC_GROUP=_lwadmin_ipc
LABEL=net.labworkspace.lwadmin
R=${LWADMIN_ROOT:-}
DRY=${LWADMIN_DRY:-0}
LIB=$R/usr/local/lib/lwadmin
HOME_DIR=$R/var/lwadmin
PRIV=$HOME_DIR/private
RUN=$HOME_DIR/run
LOGD=$HOME_DIR/log
PLIST=$R/Library/LaunchDaemons/$LABEL.plist
SOCK_PATH=/var/lwadmin/run/executor.sock          # as seen by the service and the app (never prefixed)
KEYDIR=$PRIV/deploy
VPS_HOST=72.60.196.53
VPS_PORT=2223
SRC=${LWADMIN_SRC:-$(cd "$(dirname "$0")/.." && pwd)}

die() { echo "executor-service: $*" >&2; exit 1; }
say() { echo "executor-service: $*"; }
priv() { if [ "$DRY" = 1 ]; then echo "  (dry) $*"; else "$@"; fi; }   # commands that need root and a real machine
as_owner() { if [ "$DRY" = 1 ] || [ -z "${owner:-}" ]; then "$@"; else sudo -u "$owner" "$@"; fi; }
as_svc() { if [ "$DRY" = 1 ]; then "$@"; else sudo -u "$SVC_USER" "$@"; fi; }

need_root() { [ "$DRY" = 1 ] || [ "$(id -u)" -eq 0 ] || die "run with sudo: sudo bash scripts/executor-service.sh $CMD"; }
owner_name() {
  local o=${LWADMIN_OWNER:-${SUDO_USER:-}}
  [ -n "$o" ] && [ "$o" != root ] || die "cannot tell who the owner is: run it with sudo from the owner's own account"
  case $o in *[!a-zA-Z0-9._-]*) die "unusual owner name";; esac
  printf '%s' "$o"
}
owner_home() {
  if [ -n "${LWADMIN_OWNER_HOME:-}" ]; then printf '%s' "$LWADMIN_OWNER_HOME"; return; fi
  dscl . -read "/Users/$1" NFSHomeDirectory 2>/dev/null | sed 's/^NFSHomeDirectory: //'
}

# ---- identity (dscl) ----
free_id() {  # lowest unused id in 400-499 across users and groups
  local i used
  used=$( { dscl . -list /Users UniqueID; dscl . -list /Groups PrimaryGroupID; } | awk '{print $2}')
  for i in $(seq 480 499 | sort -rn); do printf '%s\n' "$used" | grep -qx "$i" || { echo "$i"; return; }; done
  die "no free id in 400-499"
}
ensure_identity() {
  local owner=$1 gid uid
  if [ "$DRY" = 1 ]; then echo "  (dry) create group $IPC_GROUP, user $SVC_USER, add $owner to $IPC_GROUP"; return; fi
  if ! dscl . -read "/Groups/$IPC_GROUP" >/dev/null 2>&1; then
    gid=$(free_id)
    dscl . -create "/Groups/$IPC_GROUP"; dscl . -create "/Groups/$IPC_GROUP" PrimaryGroupID "$gid"
    dscl . -create "/Groups/$IPC_GROUP" RealName "LW Admin socket clients"
    say "created group $IPC_GROUP ($gid)"
  fi
  gid=$(dscl . -read "/Groups/$IPC_GROUP" PrimaryGroupID | awk '{print $2}')
  if ! dscl . -read "/Users/$SVC_USER" >/dev/null 2>&1; then
    uid=$(free_id)
    dscl . -create "/Users/$SVC_USER"
    dscl . -create "/Users/$SVC_USER" UniqueID "$uid"
    dscl . -create "/Users/$SVC_USER" PrimaryGroupID "$gid"
    dscl . -create "/Users/$SVC_USER" UserShell /usr/bin/false
    dscl . -create "/Users/$SVC_USER" NFSHomeDirectory /var/lwadmin
    dscl . -create "/Users/$SVC_USER" RealName "LW Admin executor"
    dscl . -create "/Users/$SVC_USER" IsHidden 1
    dscl . -create "/Users/$SVC_USER" Password '*'
    say "created user $SVC_USER ($uid)"
  fi
  dseditgroup -o edit -a "$SVC_USER" -t user "$IPC_GROUP" >/dev/null 2>&1 || true
  dseditgroup -o edit -a "$owner" -t user "$IPC_GROUP" >/dev/null 2>&1 || die "could not add $owner to $IPC_GROUP"
}
chown_svc() { priv chown "$@"; }

pick_node() {
  local n=${1:-}
  if [ -z "$n" ]; then for n in /usr/local/bin/node /opt/homebrew/bin/node; do [ -x "$n" ] && break || n=""; done; fi
  [ -n "$n" ] && [ -x "$n" ] || die "no node binary found at /usr/local/bin/node or /opt/homebrew/bin/node (pass --node PATH)"
  case $n in /Users/*|/var/root/*) die "node at $n is inside a home directory the service user cannot read; install it system-wide";; esac
  if [ "$DRY" != 1 ] && ! sudo -u "$SVC_USER" test -x "$n" 2>/dev/null; then die "$SVC_USER cannot execute $n"; fi
  printf '%s' "$n"
}

env_value() { sed -n "s/^$2=//p" "$1" | tail -n 1; }

write_plist() {  # write_plist NODE
  local node=$1 tmp
  mkdir -p "$(dirname "$PLIST")"
  tmp=$(mktemp "$PLIST.XXXXXX")
  cat >"$tmp" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>UserName</key><string>$SVC_USER</string>
  <key>GroupName</key><string>$IPC_GROUP</string>
  <key>ProgramArguments</key>
  <array>
    <string>$node</string>
    <string>--env-file=/var/lwadmin/private/env.admin</string>
    <string>/usr/local/lib/lwadmin/dist/executor/main.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/bin:/bin</string>
    <key>HOME</key><string>/var/lwadmin</string>
    <key>EXECUTOR_SOCKET</key><string>$SOCK_PATH</string>
    <key>EXECUTOR_SOCKET_SHARED</key><string>1</string>
    <key>LW_DEPLOY_SSH_KEY_PATH</key><string>/var/lwadmin/private/deploy/id_ed25519</string>
  </dict>
  <key>WorkingDirectory</key><string>/usr/local/lib/lwadmin</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>Umask</key><integer>63</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>/var/lwadmin/log/executor.log</string>
  <key>StandardErrorPath</key><string>/var/lwadmin/log/executor.log</string>
</dict>
</plist>
PL
  chmod 644 "$tmp"; mv -f "$tmp" "$PLIST"
  chown_svc root:wheel "$PLIST"
}

new_key() {  # new_key: ed25519, no passphrase, owned by the service user only
  local f=$KEYDIR/id_ed25519
  if [ -e "$f" ]; then return 0; fi
  as_svc ssh-keygen -q -t ed25519 -N '' -C "lwadmin-deploy-$(date +%Y%m%d)" -f "$f"
  chmod 600 "$f"; chmod 644 "$f.pub"
  say "created the deploy key $f (readable only by $SVC_USER)"
}
key_line() {
  local exp pub
  exp=$(date -v+90d +%Y%m%d 2>/dev/null || date -d '+90 days' +%Y%m%d)
  pub=$(cut -d' ' -f1,2 "$KEYDIR/id_ed25519.pub")
  printf 'restrict,expiry-time="%s",command="/usr/local/bin/lw-assistant-relay" %s assistant-deploy-%s\n' "$exp" "$pub" "$exp"
}
pin_host_key() {  # pin_host_key FILE: "ssh-ed25519 AAAA..." produced on the VPS by `cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub` (V4)
  local f=$1 k
  [ -f "$f" ] || die "no host key file $f"
  k=$(head -n 1 "$f" | tr -d '\r')
  printf '%s' "$k" | grep -Eq '^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43}$' || die "$f is not one 'ssh-ed25519 AAAA...' host key line"
  printf '[%s]:%s %s\n' "$VPS_HOST" "$VPS_PORT" "$k" >"$KEYDIR/known_hosts.new"
  chmod 600 "$KEYDIR/known_hosts.new"; mv -f "$KEYDIR/known_hosts.new" "$KEYDIR/known_hosts"
  chown_svc "$SVC_USER" "$KEYDIR/known_hosts"
  say "pinned the VPS host key for [$VPS_HOST]:$VPS_PORT"
}

load_job() {
  [ "$DRY" = 1 ] && { echo "  (dry) launchctl bootstrap system $PLIST"; return; }
  launchctl bootout "system/$LABEL" >/dev/null 2>&1 || true
  launchctl bootstrap system "$PLIST"
  launchctl kickstart -k "system/$LABEL" >/dev/null 2>&1 || true
}

# ------------------------------------------------------------------------------------------------------------------ install
# G2SC-02: the owner never pushes into the executor's repository. This copies a bundle of main into the executor's directory and lets the EXECUTOR user
# verify it, list the incoming commits and move main after a typed confirmation.
#   git bundle create /tmp/main.bundle main     then:    sudo bash scripts/executor-service.sh import --bundle /tmp/main.bundle
cmd_import() {
  local bundle="" root
  while [ $# -gt 0 ]; do case $1 in --bundle) bundle=${2:-}; shift 2;; *) die "unknown option $1";; esac; done
  need_root
  [ -f "$bundle" ] || die "give --bundle FILE (git bundle create FILE main)"
  root=""; [ ! -f "$PRIV/env.admin" ] || root=$(env_value "$PRIV/env.admin" LW_CODE_ROOT)
  [ -n "$root" ] || die "LW_CODE_ROOT is not set in $PRIV/env.admin"
  [ -f "$LIB/dist/executor/code-import-main.js" ] || die "no $LIB/dist/executor/code-import-main.js: run install first"
  node=$(pick_node "")
  mkdir -p "$root"
  chown_svc "$SVC_USER" "$root"; chmod 755 "$root"
  as_svc "$node" "$LIB/dist/executor/code-import-main.js" --root "$root" --bundle "$bundle"
}

# The other direction: applied commits reach the owner's repository as a bundle the owner can read (the executor's directory is not readable by the owner).
#   sudo bash scripts/executor-service.sh export --out /tmp/executor-main.bundle      then   git pull /tmp/executor-main.bundle main
cmd_export() {
  local out="" root
  while [ $# -gt 0 ]; do case $1 in --out) out=${2:-}; shift 2;; *) die "unknown option $1";; esac; done
  need_root
  case $out in /*) ;; *) die "give --out ABSOLUTE_FILE";; esac
  root=""; [ ! -f "$PRIV/env.admin" ] || root=$(env_value "$PRIV/env.admin" LW_CODE_ROOT)
  [ -n "$root" ] || die "LW_CODE_ROOT is not set in $PRIV/env.admin"
  [ ! -e "$out" ] && [ ! -L "$out" ] || die "$out already exists (it is never overwritten)"
  # G2SC-12: root never opens the owner-chosen path. The executor user writes the bundle to stdout; the OWNER's own uid creates the file (noclobber = O_EXCL,
  # so an existing file or a planted symlink fails), and no chmod is done as root.
  as_svc git -c core.hooksPath=/dev/null -c protocol.allow=never --git-dir="$root/repo.git" bundle create - main \
    | as_owner bash -c 'set -o noclobber; umask 022; cat > "$1"' _ "$out" || die "could not write the bundle (nothing is overwritten)"
  say "wrote $out"
}

# Human step after `import` (and for the first release): build a release from the executor main and switch current. Typed confirmation, lock, health, rollback.
cmd_release() {
  local root tsc npm url node
  need_root
  root=""; [ ! -f "$PRIV/env.admin" ] || root=$(env_value "$PRIV/env.admin" LW_CODE_ROOT)
  tsc=""; npm=""; url=""
  if [ -f "$PRIV/env.admin" ]; then tsc=$(env_value "$PRIV/env.admin" LW_CODE_TSC); npm=$(env_value "$PRIV/env.admin" LW_CODE_NPM); url=$(env_value "$PRIV/env.admin" LW_APP_HEALTH_URL); fi
  [ -n "$root" ] && [ -n "$tsc" ] && [ -n "$npm" ] && [ -n "$url" ] || die "LW_CODE_ROOT, LW_CODE_TSC, LW_CODE_NPM and LW_APP_HEALTH_URL must be set in $PRIV/env.admin"
  [ -f "$LIB/dist/executor/code-release-main.js" ] || die "no $LIB/dist/executor/code-release-main.js: run install first"
  node=$(pick_node "")
  as_svc env LW_CODE_ROOT="$root" LW_CODE_TSC="$tsc" LW_CODE_NPM="$npm" LW_APP_HEALTH_URL="$url" "$node" "$LIB/dist/executor/code-release-main.js"
}

cmd_install() {
  local hostkey="" dburl="" node="" owner ohome oasst
  while [ $# -gt 0 ]; do
    case $1 in --host-key-file) hostkey=${2:-}; shift 2;; --db-url-file) dburl=${2:-}; shift 2;; --node) node=${2:-}; shift 2;; *) die "unknown option $1";; esac
  done
  need_root
  owner=$(owner_name); ohome=$(owner_home "$owner"); oasst=$ohome/.config/assistant
  [ -d "$SRC/dist/executor" ] || die "no $SRC/dist/executor: run npm run build first"
  [ -d "$SRC/node_modules" ] || die "no node_modules in $SRC"
  ensure_identity "$owner"            # BEFORE pick_node: the node check runs `sudo -u _lwadmin`, which needs the user to exist
  node=$(pick_node "$node")

  # Gate 1 self-code X9 / Gate 2 G2SC-07: what changed in the executor's import closure since the last install, and whether a dev job made any of it.
  # Fail closed: when a previous install exists and the commit moved, the report MUST run (as the owner, never as root) and succeed (0 = unchanged,
  # 3 = changed). Anything else, a missing report script or a missing git directory is "not confirmed". A typed confirmation is required on 3.
  local prev="" now=""
  [ ! -f "$LIB/installed-commit" ] || prev=$(cat "$LIB/installed-commit")
  now=$(as_owner git -C "$SRC" rev-parse HEAD 2>/dev/null || true)
  if [ -n "$prev" ] && [ "$prev" != "$now" ]; then
    [ -n "$now" ] || die "cannot read the commit of $SRC; the closure report cannot run, so nothing was installed"
    [ -f "$SRC/dist/scripts/executor-closure.js" ] || die "no $SRC/dist/scripts/executor-closure.js: run npm run build first (the closure report is required)"
    local rep rc=0
    rep=$(as_owner "$node" "$SRC/dist/scripts/executor-closure.js" --repo "$SRC" --from "$prev" 2>&1) || rc=$?
    echo "$rep"
    case $rc in
      0) ;;
      3) if [ "${LWADMIN_CLOSURE_OK:-}" != "yes" ]; then
           printf 'The executor will run this changed code with the bot token. Type "install executor code" to continue: '
           read -r answer || answer=""
           [ "$answer" = "install executor code" ] || die "not confirmed; nothing was installed"
         fi ;;
      *) die "the closure report failed (exit $rc); not confirmed, nothing was installed" ;;
    esac
  fi

  # code: a root-owned copy; the service cannot modify it, and it does not depend on the owner's home (unreadable to $SVC_USER)
  mkdir -p "$LIB"
  rsync -a --delete "$SRC/dist/" "$LIB/dist/"
  rsync -a --delete "$SRC/node_modules/" "$LIB/node_modules/"
  cp "$SRC/package.json" "$LIB/package.json"
  [ -z "$now" ] || printf '%s\n' "$now" >"$LIB/installed-commit"
  chown_svc -R root:wheel "$LIB"; chmod -R go-w "$LIB"; chmod 755 "$LIB"

  mkdir -p "$HOME_DIR" "$PRIV" "$KEYDIR" "$RUN" "$LOGD"
  chmod 711 "$HOME_DIR"; chmod 700 "$PRIV" "$KEYDIR"; chmod 750 "$RUN" "$LOGD"
  chown_svc "$SVC_USER:$IPC_GROUP" "$HOME_DIR" "$RUN" "$LOGD"
  chown_svc "$SVC_USER:$IPC_GROUP" "$PRIV" "$KEYDIR"

  # env.admin: the token and role id come from the owner's old file (then it is removed); the database URL is the LEAST-PRIVILEGE role's
  local old=$oasst/env.admin url=$dburl tmp
  [ -n "$url" ] || url=$oasst/.lwadmin-db-url
  if [ ! -f "$PRIV/env.admin" ]; then
    [ -f "$old" ] || die "no $old to take the bot token from (run: bash scripts/set-tokens.sh --local ADMIN first)"
    [ -f "$url" ] || die "no $url: run first   node --env-file=\$HOME/.config/assistant/env.local dist/scripts/executor-role.js --out $oasst/.lwadmin-db-url"
    grep -Eq '^DATABASE_URL=postgres(ql)?://lw_executor:' "$url" || die "$url must hold the lw_executor DATABASE_URL (not the owner's role)"
    grep -Eq '^BOT_TOKEN_ADMIN=.+' "$old" || die "$old has no BOT_TOKEN_ADMIN"
    tmp=$(mktemp "$PRIV/.env.admin.XXXXXX")
    { for k in BOT_TOKEN_ADMIN BOT_ADMIN_ROLE_ID GUILD_ID LOG_LEVEL; do v=$(env_value "$old" "$k"); [ -z "$v" ] || printf '%s=%s\n' "$k" "$v"; done
      grep -E '^DATABASE_URL=' "$url" | tail -n 1; } >"$tmp"
    chmod 600 "$tmp"; mv -f "$tmp" "$PRIV/env.admin"
    chown_svc "$SVC_USER:$IPC_GROUP" "$PRIV/env.admin"
    # E5 (dashboard): the env page must still refuse the executor's token for another department; it compares against a digest it CAN read
    printf '%s\n' "$(env_value "$PRIV/env.admin" BOT_TOKEN_ADMIN | tr -d '\n' | shasum -a 256 | cut -d' ' -f1)" >"$oasst/admin-token.sha256"
    chmod 600 "$oasst/admin-token.sha256"; chown_svc "$owner" "$oasst/admin-token.sha256"
    rm -f "$old" "$url" "$oasst/executor.sock"
    say "moved the executor's env into $PRIV/env.admin (the old $old is removed)"
    say "RECOMMENDED: rotate BOT_TOKEN_ADMIN in the Discord developer portal once (the old file was readable by your uid), then: sudo bash scripts/executor-service.sh set-token"
  fi

  new_key
  [ -z "$hostkey" ] || pin_host_key "$hostkey"
  write_plist "$node"
  touch "$LOGD/executor.log"; chmod 640 "$LOGD/executor.log"; chown_svc "$SVC_USER:$IPC_GROUP" "$LOGD/executor.log"
  load_job
  say "installed. Log: /var/lwadmin/log/executor.log   Socket: $SOCK_PATH"
  echo
  echo "Owner steps that remain:"
  echo "  1. Log out and back in (or reboot) once: your shell must pick up the new group $IPC_GROUP to reach the socket (check: id -Gn | grep $IPC_GROUP)."
  [ -n "$hostkey" ] || echo "  2. On the VPS as root:  cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub > /root/host.pub   then copy that line to this Mac and run:"
  [ -n "$hostkey" ] || echo "       sudo bash scripts/executor-service.sh install --host-key-file <file>      (pins the host key; never ssh-keyscan)"
  echo "  3. Install exactly this line (one line, expiry <= 90 days) in /var/lib/assistantdeploy/.ssh/authorized_keys on the VPS, then run 81-assistant-deploy.sh:"
  echo
  key_line
  echo
}

cmd_set_token() {
  need_root
  [ -f "$PRIV/env.admin" ] || die "not installed"
  local t tmp
  printf 'Paste the LW Admin bot token (input is hidden): ' >&2
  stty -echo 2>/dev/null || true; IFS= read -r t || true; stty echo 2>/dev/null || true; echo >&2
  printf '%s' "$t" | grep -Eq '^[A-Za-z0-9_.-]{50,100}$' || die "that does not look like a Discord bot token; nothing was changed"
  tmp=$(mktemp "$PRIV/.env.admin.XXXXXX")
  { printf 'BOT_TOKEN_ADMIN=%s\n' "$t"; grep -v '^BOT_TOKEN_ADMIN=' "$PRIV/env.admin"; } >"$tmp"
  chmod 600 "$tmp"; mv -f "$tmp" "$PRIV/env.admin"; chown_svc "$SVC_USER:$IPC_GROUP" "$PRIV/env.admin"
  local o oh; o=$(owner_name); oh=$(owner_home "$o")
  printf '%s\n' "$(printf '%s' "$t" | shasum -a 256 | cut -d' ' -f1)" >"$oh/.config/assistant/admin-token.sha256"; chmod 600 "$oh/.config/assistant/admin-token.sha256"; chown_svc "$o" "$oh/.config/assistant/admin-token.sha256"
  t=""
  [ "$DRY" = 1 ] || launchctl kickstart -k "system/$LABEL" >/dev/null 2>&1 || true
  say "token replaced; the job was restarted"
}

cmd_rotate_key() {
  need_root
  [ -d "$KEYDIR" ] || die "not installed"
  mv -f "$KEYDIR/id_ed25519" "$KEYDIR/id_ed25519.old" 2>/dev/null || true
  rm -f "$KEYDIR/id_ed25519.pub"
  new_key
  [ "$DRY" = 1 ] || launchctl kickstart -k "system/$LABEL" >/dev/null 2>&1 || true
  say "new key. Add this line to the VPS authorized_keys (a second line during rotation, then remove the old one):"
  key_line
}

cmd_uninstall() {
  local purge=0
  [ "${1:-}" != --purge ] || purge=1
  need_root
  [ "$DRY" = 1 ] || launchctl bootout "system/$LABEL" >/dev/null 2>&1 || true
  rm -f "$PLIST"
  rm -rf "$LIB"
  rm -f "$RUN/executor.sock"
  if [ "$purge" = 1 ]; then
    rm -rf "$HOME_DIR"
    if [ "$DRY" != 1 ]; then
      dscl . -delete "/Users/$SVC_USER" >/dev/null 2>&1 || true
      dscl . -delete "/Groups/$IPC_GROUP" >/dev/null 2>&1 || true
    fi
    say "removed the job, the code, the user, the group and $HOME_DIR (token and deploy key included). The VPS key line must be removed by hand."
  else
    say "removed the job and the code. Kept $HOME_DIR (token, deploy key) and the user; add --purge to remove them. dev.sh starts the dev executor again only if you restore ~/.config/assistant/env.admin."
  fi
}

cmd_status() {
  local m
  echo "plist:     $([ -f "$PLIST" ] && echo present || echo absent)"
  if [ "$DRY" != 1 ] && command -v launchctl >/dev/null 2>&1; then echo "launchd:   $(launchctl print "system/$LABEL" 2>/dev/null | sed -n 's/^[[:space:]]*state = //p' | head -n 1 || true)"; fi
  echo "socket:    $([ -S "$RUN/executor.sock" ] && echo present || echo absent)"
  for p in "$PRIV/env.admin" "$KEYDIR/id_ed25519" "$KEYDIR/known_hosts"; do
    if [ -e "$p" ]; then m=$(stat -f '%Lp' "$p" 2>/dev/null || stat -c '%a' "$p"); echo "$(basename "$p"): mode $m"; else echo "$(basename "$p"): missing"; fi
  done
  if [ "$DRY" != 1 ]; then
    id -Gn | tr ' ' '\n' | grep -qx "$IPC_GROUP" && echo "this shell is in $IPC_GROUP: yes" || echo "this shell is in $IPC_GROUP: NO (log out and in once)"
    [ -r "$PRIV/env.admin" ] && echo "WARNING: your uid can read env.admin" || echo "your uid cannot read env.admin: ok"
  fi
}

CMD=${1:-}
[ $# -gt 0 ] && shift
case $CMD in
  install)   cmd_install "$@" ;;
  import)    cmd_import "$@" ;;
  export)    cmd_export "$@" ;;
  release)   cmd_release "$@" ;;
  set-token) cmd_set_token ;;
  rotate-key) cmd_rotate_key ;;
  uninstall) cmd_uninstall "$@" ;;
  status)    cmd_status ;;
  *) sed -n '2,12p' "$0"; exit 64 ;;
esac
