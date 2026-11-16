# Shared checks for the local-mode env file (Gate 1 L10). Sourced by dev.sh and set-tokens.sh. bash 3.2 compatible.
# The file lives at ~/.config/assistant/env.local: regular file (not a symlink), owned by the current user, mode 0600,
# in a directory (not a symlink) owned by the current user with mode 0700. Anything else is refused.

asst_env_file() { printf '%s\n' "$HOME/.config/assistant/env.local"; }
# Phase 2 (Gate 1 S2, S6): the separate executor "LW Admin" has its OWN env file next to env.local. BOT_TOKEN_ADMIN lives here and never in env.local.
asst_admin_env_file() { printf '%s\n' "$HOME/.config/assistant/env.admin"; }
# The Unix socket both processes use (short on purpose: macOS limits a socket path to 104 bytes).
asst_executor_socket() { printf '%s\n' "$HOME/.config/assistant/executor.sock"; }

_asst_mode() { if [ "$(uname -s)" = Darwin ]; then stat -f '%Lp' "$1"; else stat -c '%a' "$1"; fi; }
_asst_uid() { if [ "$(uname -s)" = Darwin ]; then stat -f '%u' "$1"; else stat -c '%u' "$1"; fi; }

# asst_check_dir DIR  -> 0 when safe, else 1 with a reason on stderr
asst_check_dir() {
  local d=$1
  if [ -L "$d" ]; then echo "refusing: $d is a symlink" >&2; return 1; fi
  if [ ! -d "$d" ]; then echo "refusing: $d is not a directory" >&2; return 1; fi
  if [ "$(_asst_uid "$d")" != "$(id -u)" ]; then echo "refusing: $d is not owned by the current user" >&2; return 1; fi
  if [ "$(_asst_mode "$d")" != 700 ]; then echo "refusing: $d must have mode 0700 (chmod 700 '$d')" >&2; return 1; fi
}

# asst_check_file FILE  -> 0 when safe, else 1
asst_check_file() {
  local f=$1
  if [ -L "$f" ]; then echo "refusing: $f is a symlink" >&2; return 1; fi
  if [ ! -f "$f" ]; then echo "refusing: $f is not a regular file" >&2; return 1; fi
  if [ "$(_asst_uid "$f")" != "$(id -u)" ]; then echo "refusing: $f is not owned by the current user" >&2; return 1; fi
  if [ "$(_asst_mode "$f")" != 600 ]; then echo "refusing: $f must have mode 0600 (chmod 600 '$f')" >&2; return 1; fi
}

# asst_check_envfile FILE -> directory, then file
asst_check_envfile() {
  asst_check_dir "$(dirname "$1")" && asst_check_file "$1"
}

# asst_prepare_dir DIR -> create with 0700 when missing (parents with the default umask), then check it
asst_prepare_dir() {
  local d=$1
  if [ ! -e "$d" ] && [ ! -L "$d" ]; then
    mkdir -p "$(dirname "$d")"
    ( umask 077; mkdir "$d" )
  fi
  asst_check_dir "$d"
}

# asst_check_admin_envfile FILE -> the executor's env file: the same location/ownership/mode rules, and only the keys the executor needs
# (its own token, the database url, the Bot Admin role id, guild id, log level). Any other BOT_TOKEN_*, API key or master key is refused: the file
# must not become a second copy of env.local.
asst_check_admin_envfile() {
  local f=$1 line key
  asst_check_envfile "$f" || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    case $line in ''|'#'*) continue ;; esac
    key=${line%%=*}
    case $key in
      BOT_TOKEN_ADMIN|DATABASE_URL|BOT_ADMIN_ROLE_ID|GUILD_ID|LOG_LEVEL) ;;
      *) echo "refusing: $f may only define BOT_TOKEN_ADMIN, DATABASE_URL, BOT_ADMIN_ROLE_ID, GUILD_ID and LOG_LEVEL (found $key)" >&2; return 1 ;;
    esac
  done <"$f"
  if ! grep -Eq '^BOT_TOKEN_ADMIN=.+' "$f"; then echo "refusing: $f has no BOT_TOKEN_ADMIN; run: bash scripts/set-tokens.sh --local ADMIN" >&2; return 1; fi
  if ! grep -Eq '^DATABASE_URL=.+' "$f"; then echo "refusing: $f has no DATABASE_URL; run: bash scripts/set-tokens.sh --local ADMIN" >&2; return 1; fi
  if ! grep -Eq '^BOT_ADMIN_ROLE_ID=[0-9]+$' "$f"; then echo "refusing: $f has no BOT_ADMIN_ROLE_ID; run: bash scripts/set-tokens.sh --local ADMIN" >&2; return 1; fi
}
