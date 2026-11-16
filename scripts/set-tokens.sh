#!/usr/bin/env bash
# Put the Discord bot tokens into the Assistant secrets. Run it in YOUR OWN terminal (not through an AI chat): each
# value is read hidden (read -rs) and cleared from memory. Press Enter on an empty prompt to skip that key.
#
# VPS mode (default): values go over ssh on stdin to `lw env set apps/assistant` (never in argv, history or screen),
# together with ANTHROPIC_API_KEY and GEMINI_API_KEY (the latter also when PRAW is named explicitly).
#   bash scripts/set-tokens.sh            # all keys
#   bash scripts/set-tokens.sh SALES OPS  # only these departments
#   bash scripts/set-tokens.sh CLICKUP    # only CLICKUP_API_TOKEN + CLICKUP_LIST_ID or CLICKUP_TEAM_ID (also asked in the full run)
#   bash scripts/set-tokens.sh SHEETS     # GOOGLE_SHEETS_WEBAPP_URL + GOOGLE_SHEETS_WEBAPP_SECRET (optional receipt export; not part of the full run)
#   bash scripts/set-tokens.sh GITHUB     # GITHUB_APP_ID, GITHUB_INSTALLATION_ID and the App's PEM FILE PATH (the key itself is never typed or shown)
#   bash scripts/set-tokens.sh --local ADMIN   # the token of the separate executor "LW Admin" (Gate 1 S2, S6): written to env.admin ONLY, never
#                                         # env.local, and never part of the full run. env.admin also gets DATABASE_URL (copied from env.local,
#                                         # loopback only) and BOT_ADMIN_ROLE_ID. Local mode only: the VPS executor service is not deployed yet.
#
# Local mode (owner's Mac, no ssh): values go to ~/.config/assistant/env.local (dir 0700, file 0600, atomic replace).
# Also generates CONFIG_MASTER_KEY, LOCAL_DB_PASSWORD and DATABASE_URL when missing (never printed). Asks no
# Anthropic key (local mode uses the logged-in claude CLI) and never writes ALLOW_LOCAL_PROVIDERS. It does ask
# GEMINI_API_KEY (Praw's provider has no local CLI), in full mode or when PRAW is named.
#   bash scripts/set-tokens.sh --local [DEPT ...]
#   bash scripts/set-tokens.sh --local --dry-run /tmp/x/env.local   # test: target path given, prompts read from stdin
set -euo pipefail
HOST=${LW_HOST:-root@72.60.196.53}
APP=apps/assistant
BOT_ADMIN_ROLE_ID=1566025466274512988   # role "Bot Admin" in LabWorkSpace (not a secret)
ALL_DEPTS="HQ RND SOFTWARE IT MARKETING SALES HR FINANCE OPS PRAW"
GEMINI_RE='^(AIza[0-9A-Za-z_-]{35}|AQ\.[0-9A-Za-z_-]{20,})$'  # classic AIza... and the newer AQ.... formats
LOCAL_DB_PORT=54330
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=lib/envfile.sh
. "$ROOT/scripts/lib/envfile.sh"

die() { echo "$*" >&2; exit 1; }

LOCAL=0; DRY=""; DEPT_ARGS=""
while [ $# -gt 0 ]; do
  case $1 in
    --local) LOCAL=1 ;;
    --dry-run) shift; [ $# -gt 0 ] || die "--dry-run needs a path"; DRY=$1 ;;
    -*) die "unknown option $1" ;;
    *) DEPT_ARGS="$DEPT_ARGS $1" ;;
  esac
  shift
done
[ -z "$DRY" ] || [ "$LOCAL" = 1 ] || die "--dry-run only works with --local"
# CLICKUP is a key group, not a department: bash scripts/set-tokens.sh CLICKUP asks only the ClickUp keys.
CLICKUP_ASK=0; GITHUB_ASK=0; SHEETS_ASK=0; ADMIN_ASK=0; KEEP=""
for a in $DEPT_ARGS; do case $a in ADMIN) ADMIN_ASK=1 ;; CLICKUP) CLICKUP_ASK=1 ;; GITHUB) GITHUB_ASK=1 ;; SHEETS) SHEETS_ASK=1 ;; *) KEEP="$KEEP $a" ;; esac; done
[ "$ADMIN_ASK" = 0 ] || [ "$LOCAL" = 1 ] || die "ADMIN (LW Admin) is local mode only for now: its executor service is not deployed on the VPS, and its token must never be put into the apps/assistant environment. Use: bash scripts/set-tokens.sh --local ADMIN"
ADMIN_ONLY=0
if [ "$ADMIN_ASK" = 1 ] && [ -z "${KEEP// /}" ] && [ "$CLICKUP_ASK$GITHUB_ASK$SHEETS_ASK" = 000 ]; then ADMIN_ONLY=1; fi
# OD-1: with the executor under launchd as its own macOS user, its token lives in /var/lwadmin/private/env.admin and is replaced through sudo only
[ "$ADMIN_ASK" = 0 ] || [ ! -e "${LWADMIN_PLIST:-/Library/LaunchDaemons/net.labworkspace.lwadmin.plist}" ] || die "the executor runs under launchd as _lwadmin; replace its token with: sudo bash scripts/executor-service.sh set-token"
if [ -n "$DEPT_ARGS" ]; then DEPTS=($KEEP); FULL=0; else DEPTS=($ALL_DEPTS); FULL=1; CLICKUP_ASK=1; GITHUB_ASK=1; fi

label() {  # bash 3.2 (macOS) has no associative arrays
  case $1 in HQ) echo "LW CEO";; RND) echo "LW R&D";; SOFTWARE) echo "LW CTO";; IT) echo "LW IT";;
    MARKETING) echo "LW Marketing";; SALES) echo "LW Sales";; HR) echo "LW HR";; FINANCE) echo "LW CFO";;
    OPS) echo "LW Ops";; PRAW) echo "พราว (Praw)";; ADMIN) echo "LW Admin (executor)";; *) return 1;; esac
}

# Prompts: fd 5 is where prompts are shown, fd 4 where values are read (the terminal; in --dry-run stderr and stdin).
if [ -n "$DRY" ]; then exec 5>&2 4<&0; else exec 5>/dev/tty 4</dev/tty; fi

send() {  # VPS: send KEY  (value on stdin)
  ssh -o BatchMode=yes "$HOST" "lw env set $APP $1" >/dev/null
}

UPD_KEYS=(); UPD_VALS=()
stage() {  # local: stage KEY VALUE  (written together at the end)
  UPD_KEYS[${#UPD_KEYS[@]}]=$1; UPD_VALS[${#UPD_VALS[@]}]=$2
}
staged() {  # local: staged KEY -> true when KEY was staged in this run
  local i=0
  while [ $i -lt ${#UPD_KEYS[@]} ]; do [ "${UPD_KEYS[$i]}" = "$1" ] && return 0; i=$((i+1)); done
  return 1
}

SET_KEYS=()
was_set() {  # VPS: was_set KEY -> true when KEY was sent in this run (ask returns 0 on a skip too, so its status says nothing)
  local i=0
  while [ $i -lt ${#SET_KEYS[@]} ]; do [ "${SET_KEYS[$i]}" = "$1" ] && return 0; i=$((i+1)); done
  return 1
}

ask() {  # ask KEY PROMPT REGEX
  local key=$1 prompt=$2 re=$3 v
  while true; do
    printf '%s: ' "$prompt" >&5
    IFS= read -rs v <&4 || v=""; printf '\n' >&5
    if [ -z "$v" ]; then echo "  - skipped $key"; return 0; fi
    if [[ $v =~ $re ]]; then
      if [ "$LOCAL" = 1 ]; then stage "$key" "$v" && echo "  ✓ $key staged (value not shown)"
      else printf '%s\n' "$v" | send "$key" && echo "  ✓ $key set (value not shown)" && SET_KEYS[${#SET_KEYS[@]}]=$key; fi
      v=; unset v; return 0
    fi
    v=; echo "  ✗ does not look like a valid value for $key, try again (or Enter to skip)"
    [ -n "$DRY" ] && return 1   # no retry loop on scripted input
  done
}

CLICKUP_TOKEN_RE='^pk_[0-9]+_[A-Z0-9]{32}$'
CLICKUP_LIST_RE='^[a-z0-9]{1,32}$'
CLICKUP_TEAM_RE='^([0-9]{1,20}|all)$'  # digits, or exactly the lower-case word all (the bash match is case-sensitive; keep it that way)
GITHUB_APP_RE='^[A-Za-z0-9]{1,40}$'
SHEETS_URL_RE='^https://script\.google\.com/macros/s/[A-Za-z0-9_-]+/exec$'
SHEETS_SECRET_RE='^[A-Za-z0-9._~+=-]{16,200}$'
GITHUB_INST_RE='^[0-9]{1,20}$'
TOKEN_RE='^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}$'

ask_pem() {  # ask_pem  - the GitHub App key is a FILE: its path is asked (not the key), the file is checked, only the path is stored (local) or the key goes over ssh stdin (VPS)
  local p mode
  printf '%s: ' "Path of the GitHub App private key .pem file, mode 0600 (GITHUB_APP_PRIVATE_KEY_PATH)" >&5
  IFS= read -r p <&4 || p=""; printf '\n' >&5
  if [ -z "$p" ]; then echo "  - skipped GITHUB_APP_PRIVATE_KEY"; return 0; fi
  case $p in /*) ;; *) echo "  ✗ give an absolute path" >&2; return 1 ;; esac
  if [ -L "$p" ]; then echo "  ✗ the key file must not be a symlink" >&2; return 1; fi
  if [ ! -f "$p" ] || [ ! -O "$p" ]; then echo "  ✗ the key file must be a regular file owned by you" >&2; return 1; fi
  mode=$(stat -f %Lp "$p" 2>/dev/null || stat -c %a "$p" 2>/dev/null || echo "?")
  if [ "$mode" != 600 ] && [ "$mode" != 400 ]; then echo "  ✗ the key file must have mode 0600 or 0400 (no group or other access)" >&2; return 1; fi
  if ! grep -q -- '-----BEGIN [A-Z ]*PRIVATE KEY-----' "$p"; then echo "  ✗ that file is not a PEM private key" >&2; return 1; fi
  if [ "$LOCAL" = 1 ]; then stage GITHUB_APP_PRIVATE_KEY_PATH "$p" && echo "  ✓ GITHUB_APP_PRIVATE_KEY_PATH staged (the key stays in its file)"
  else awk 'BEGIN{ORS="\\n"}1' "$p" | send GITHUB_APP_PRIVATE_KEY && echo "  ✓ GITHUB_APP_PRIVATE_KEY set (value not shown)"; echo "  ! a GITHUB_APP_PRIVATE_KEY_PATH left in the env takes priority over this value: remove it with lw env unset" >&2; fi
}

wants_gemini() {  # full run, or PRAW named explicitly
  [ "$FULL" = 1 ] && return 0
  local x; for x in ${DEPTS[@]+"${DEPTS[@]}"}; do [ "$x" = PRAW ] && return 0; done
  return 1
}

# ---------------------------------------------------------------- local mode
admin_main() {  # the executor token goes to env.admin and nowhere else; env.local is read for DATABASE_URL and never written
  local local_f admin_f dir tmp db roleid
  local_f=${DRY:-$(asst_env_file)}
  dir=$(dirname "$local_f")
  admin_f=$dir/env.admin
  asst_prepare_dir "$dir" || exit 1
  if [ -e "$admin_f" ] || [ -L "$admin_f" ]; then asst_check_file "$admin_f" || exit 1; fi
  [ -f "$local_f" ] || die "no $local_f; run: bash scripts/set-tokens.sh --local first (the executor shares its loopback database)"
  asst_check_file "$local_f" || exit 1
  db=$(sed -n 's/^DATABASE_URL=//p' "$local_f" | tail -n 1)
  [ -n "$db" ] || die "no DATABASE_URL in $local_f; run: bash scripts/set-tokens.sh --local first"
  case $db in postgres://*@127.0.0.1:*|postgres://*@localhost:*|postgres://*@\[::1\]:*) ;; *) die "DATABASE_URL in $local_f must point at loopback" ;; esac
  roleid=$(sed -n 's/^BOT_ADMIN_ROLE_ID=//p' "$local_f" | tail -n 1)
  roleid=${roleid:-$BOT_ADMIN_ROLE_ID}
  echo "Paste the LW Admin bot token (input is hidden). Target: $admin_f"
  ask BOT_TOKEN_ADMIN "Bot token for $(label ADMIN) (BOT_TOKEN_ADMIN)" "$TOKEN_RE" || die "invalid value for BOT_TOKEN_ADMIN; nothing was written"
  [ ${#UPD_KEYS[@]} -gt 0 ] || { echo "nothing staged; $admin_f unchanged"; return 0; }
  tmp=$( umask 077; mktemp "$dir/.env.admin.XXXXXX" )
  trap 'rm -f "$tmp"' EXIT HUP INT TERM
  # env.admin holds exactly: the executor's token, the loopback database url (the executor needs the same database) and the Bot Admin role id (not a secret)
  printf 'BOT_TOKEN_ADMIN=%s\n' "${UPD_VALS[0]}" >"$tmp"
  printf 'DATABASE_URL=%s\n' "$db" >>"$tmp"
  printf 'BOT_ADMIN_ROLE_ID=%s\n' "$roleid" >>"$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$admin_f"
  trap - EXIT HUP INT TERM
  db=""; UPD_VALS[0]=""
  echo; echo "Keys now in $admin_f (names only):"
  sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/  \1/p' "$admin_f"
  echo "Next: npm run dev   (starts the app and the LW Admin executor, each with its own environment)"
}

local_main() {
  local target dir tmp k i existing
  if [ "$ADMIN_ONLY" = 1 ]; then admin_main; return; fi
  [ "$ADMIN_ASK" = 0 ] || die "name ADMIN on its own (bash scripts/set-tokens.sh --local ADMIN): its token is written to env.admin, never together with env.local keys"
  target=${DRY:-$(asst_env_file)}
  dir=$(dirname "$target")
  asst_prepare_dir "$dir" || exit 1
  if [ -e "$target" ] || [ -L "$target" ]; then asst_check_file "$target" || exit 1; fi

  echo "Paste each value and press Enter (input is hidden). Target: $target"
  for d in ${DEPTS[@]+"${DEPTS[@]}"}; do
    name=$(label "$d") || die "unknown department $d (use: $ALL_DEPTS)"
    ask "BOT_TOKEN_$d" "Bot token for $name (BOT_TOKEN_$d)" "$TOKEN_RE" || die "invalid value for BOT_TOKEN_$d; nothing was written"
  done
  if wants_gemini; then
    ask GEMINI_API_KEY "Gemini API key (GEMINI_API_KEY)" "$GEMINI_RE" || die "invalid value for GEMINI_API_KEY; nothing was written"
  fi

  if [ "$CLICKUP_ASK" = 1 ]; then
    ask CLICKUP_API_TOKEN "ClickUp personal API token (CLICKUP_API_TOKEN)" "$CLICKUP_TOKEN_RE" || die "invalid value for CLICKUP_API_TOKEN; nothing was written"
    ask CLICKUP_LIST_ID "ClickUp list id for ONE list only; press Enter to skip for the whole workspace (CLICKUP_LIST_ID)" "$CLICKUP_LIST_RE" || die "invalid value for CLICKUP_LIST_ID; nothing was written"
    if staged CLICKUP_LIST_ID; then
      # CM-C5 a: a list id clears any old team id or `all`, so clearing the list later can never open a workspace
      stage CLICKUP_TEAM_ID "" && echo "  ✓ CLICKUP_TEAM_ID cleared (one-list mode)"
    else
      # CLICKUP-ALL-1 workspace mode: a team id (or all) with NO list id. Giving one clears any old list id (list mode would win otherwise).
      ask CLICKUP_TEAM_ID "ClickUp workspace id (digits, the first number after app.clickup.com/), or all for every workspace the token can see (CLICKUP_TEAM_ID)" "$CLICKUP_TEAM_RE" || die "invalid value for CLICKUP_TEAM_ID; nothing was written"
      if staged CLICKUP_TEAM_ID; then stage CLICKUP_LIST_ID "" && echo "  ✓ CLICKUP_LIST_ID cleared (whole-workspace mode)"; fi
    fi
  fi


  if [ "$SHEETS_ASK" = 1 ]; then
    ask GOOGLE_SHEETS_WEBAPP_URL "Apps Script web app URL, https://script.google.com/macros/s/<id>/exec (GOOGLE_SHEETS_WEBAPP_URL)" "$SHEETS_URL_RE" || die "invalid value for GOOGLE_SHEETS_WEBAPP_URL; nothing was written"
    ask GOOGLE_SHEETS_WEBAPP_SECRET "Shared secret of that web app (GOOGLE_SHEETS_WEBAPP_SECRET)" "$SHEETS_SECRET_RE" || die "invalid value for GOOGLE_SHEETS_WEBAPP_SECRET; nothing was written"
  fi

  if [ "$GITHUB_ASK" = 1 ]; then
    ask GITHUB_APP_ID "GitHub App ID (GITHUB_APP_ID)" "$GITHUB_APP_RE" || die "invalid value for GITHUB_APP_ID; nothing was written"
    ask GITHUB_INSTALLATION_ID "GitHub App installation id (GITHUB_INSTALLATION_ID)" "$GITHUB_INST_RE" || die "invalid value for GITHUB_INSTALLATION_ID; nothing was written"
    ask_pem || die "invalid GitHub App key file; nothing was written"
  fi

  has() { [ -f "$target" ] && grep -Eq "^$1=.+" "$target"; }
  getv() { sed -n "s/^$1=//p" "$target" | tail -n 1; }
  local pw=""
  if has LOCAL_DB_PASSWORD; then pw=$(getv LOCAL_DB_PASSWORD)
  elif has DATABASE_URL; then
    # the URL already fixes the password the database was created with: reuse it, never generate one that would not match
    pw=$(getv DATABASE_URL); pw=${pw#*://}
    case $pw in *@*) pw=${pw%%@*}; case $pw in *:*) pw=${pw#*:} ;; *) pw="" ;; esac ;; *) pw="" ;; esac
    [ -n "$pw" ] || die "DATABASE_URL in $target has no password and LOCAL_DB_PASSWORD is missing; add LOCAL_DB_PASSWORD=<the database password> (or remove DATABASE_URL to regenerate both); nothing was written"
    stage LOCAL_DB_PASSWORD "$pw"
  else pw=$(openssl rand -hex 24); stage LOCAL_DB_PASSWORD "$pw"; fi
  has DATABASE_URL || stage DATABASE_URL "postgres://assistant:${pw}@127.0.0.1:${LOCAL_DB_PORT}/assistant"
  has BOT_ADMIN_ROLE_ID || stage BOT_ADMIN_ROLE_ID "$BOT_ADMIN_ROLE_ID"
  has CONFIG_MASTER_KEY || stage CONFIG_MASTER_KEY "$(openssl rand -base64 32)"
  pw=""

  tmp=$( umask 077; mktemp "$dir/.env.local.XXXXXX" )
  trap 'rm -f "$tmp"' EXIT HUP INT TERM
  if [ -f "$target" ]; then
    local line drop
    while IFS= read -r line || [ -n "$line" ]; do
      drop=0
      case $line in ALLOW_LOCAL_PROVIDERS=*|"export ALLOW_LOCAL_PROVIDERS"*) drop=1; echo "  ! removed ALLOW_LOCAL_PROVIDERS from the file (the launcher sets it)" >&2 ;; esac
      i=0
      while [ $i -lt ${#UPD_KEYS[@]} ]; do
        case $line in "${UPD_KEYS[$i]}="*) drop=1 ;; esac
        i=$((i+1))
      done
      [ $drop = 1 ] || printf '%s\n' "$line" >>"$tmp"
    done <"$target"
  fi
  i=0
  while [ $i -lt ${#UPD_KEYS[@]} ]; do
    printf '%s=%s\n' "${UPD_KEYS[$i]}" "${UPD_VALS[$i]}" >>"$tmp"
    i=$((i+1))
  done
  chmod 600 "$tmp"
  mv -f "$tmp" "$target"
  trap - EXIT HUP INT TERM
  echo; echo "Keys now in $target (names only):"
  sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/  \1/p' "$target"
  echo "Next: npm run local:db   then   npm run dev"
}

if [ "$LOCAL" = 1 ]; then local_main; exit 0; fi

# ---------------------------------------------------------------- VPS mode
ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" true || { echo "cannot ssh to $HOST" >&2; exit 1; }
echo "Paste each value and press Enter (input is hidden)."
for d in ${DEPTS[@]+"${DEPTS[@]}"}; do
  name=$(label "$d") || { echo "unknown department $d (use: $ALL_DEPTS)" >&2; exit 1; }
  ask "BOT_TOKEN_$d" "Bot token for $name (BOT_TOKEN_$d)" "$TOKEN_RE"
done
if wants_gemini; then
  ask GEMINI_API_KEY "Gemini API key (GEMINI_API_KEY)" "$GEMINI_RE"
fi
if [ "$CLICKUP_ASK" = 1 ]; then
  ask CLICKUP_API_TOKEN "ClickUp personal API token (CLICKUP_API_TOKEN)" "$CLICKUP_TOKEN_RE"
  ask CLICKUP_LIST_ID "ClickUp list id for ONE list only; press Enter to skip for the whole workspace (CLICKUP_LIST_ID)" "$CLICKUP_LIST_RE"
  if was_set CLICKUP_LIST_ID; then
    # CM-C5 a: a list id clears any old team id or `all`
    ssh -o BatchMode=yes "$HOST" "lw env unset $APP CLICKUP_TEAM_ID" >/dev/null && echo "  ✓ CLICKUP_TEAM_ID cleared (one-list mode)" || echo "  ! could not clear CLICKUP_TEAM_ID: clear it with lw env unset $APP CLICKUP_TEAM_ID" >&2
  else
    ask CLICKUP_TEAM_ID "ClickUp workspace id (digits), or all for every workspace the token can see (CLICKUP_TEAM_ID)" "$CLICKUP_TEAM_RE"
    if was_set CLICKUP_TEAM_ID; then ssh -o BatchMode=yes "$HOST" "lw env unset $APP CLICKUP_LIST_ID" >/dev/null && echo "  ✓ CLICKUP_LIST_ID cleared" || echo "  ! could not clear CLICKUP_LIST_ID: clear it with lw env unset $APP CLICKUP_LIST_ID" >&2; fi
  fi
fi
if [ "$SHEETS_ASK" = 1 ]; then
  ask GOOGLE_SHEETS_WEBAPP_URL "Apps Script web app URL, https://script.google.com/macros/s/<id>/exec (GOOGLE_SHEETS_WEBAPP_URL)" "$SHEETS_URL_RE"
  ask GOOGLE_SHEETS_WEBAPP_SECRET "Shared secret of that web app (GOOGLE_SHEETS_WEBAPP_SECRET)" "$SHEETS_SECRET_RE"
fi
if [ "$GITHUB_ASK" = 1 ]; then
  ask GITHUB_APP_ID "GitHub App ID (GITHUB_APP_ID)" "$GITHUB_APP_RE"
  ask GITHUB_INSTALLATION_ID "GitHub App installation id (GITHUB_INSTALLATION_ID)" "$GITHUB_INST_RE"
  ask_pem || exit 1
fi
if [ "$FULL" = 1 ]; then
  ask ANTHROPIC_API_KEY "Anthropic API key (ANTHROPIC_API_KEY)" '^sk-ant-[A-Za-z0-9_-]{20,}$'
  printf '%s\n' "$BOT_ADMIN_ROLE_ID" | send BOT_ADMIN_ROLE_ID && echo "  ✓ BOT_ADMIN_ROLE_ID set"
fi
echo; echo "Keys now set for $APP (names only):"
ssh -o BatchMode=yes "$HOST" "lw env keys $APP"
