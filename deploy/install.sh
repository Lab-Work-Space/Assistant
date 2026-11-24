#!/bin/bash
# Employee host install/upgrade. Run as root, idempotent. Spec: docs/specs/2026-11-23-phase1-spec-s11-sqlite-vps.md
# section 11.11.5 as amended by 11.18 (S11-01, -02, -04, -05, -07).
# Usage:  git -C /opt/employee/app fetch origin && git -C /opt/employee/app checkout --detach <sha>
#         /opt/employee/app/deploy/install.sh [--shared-host|--dedicated-host] <40-hex sha>
# The checkout is done by the owner BEFORE this script (S11-05): bash must not run a file that changes under it.
# Mode (spec 11.20): --shared-host (default) never touches ufw/sshd/apt policy/needrestart; --dedicated-host restores 11.18/11.19.
# --plan prints the commands that would run (no root needed, nothing executed); tests/test_install_plan.py checks it.
SHARED=true; PLAN=false; SHA=""
for a in "$@"; do
  case "$a" in
    --shared-host) SHARED=true ;; --dedicated-host) SHARED=false ;; --plan) PLAN=true ;;
    -*) echo "unknown_option:$a" >&2; exit 1 ;;
    *) SHA="$a" ;;
  esac
done
if [ "$PLAN" = true ]; then
  F='^[[:space:]]*(#|$)'
  if [ "$SHARED" = true ]; then sed '/^#DEDICATED-BEGIN$/,/^#DEDICATED-END$/d' "$0" | grep -Ev "$F"; else grep -Ev "$F" "$0"; fi
  exit 0
fi
set -euo pipefail
SNAP=/var/lib/employee-install; VENV=/opt/employee/venv
if [ "$(id -u)" != 0 ]; then  # test hook (tests/test_install_plan.py): honoured only for non-root AND when the test var is set
  [ -n "${EMPLOYEE_INSTALL_TEST_DIR:-}" ] || { echo "must_run_as_root" >&2; exit 1; }
  SNAP="$EMPLOYEE_INSTALL_TEST_DIR/snap"; VENV="$EMPLOYEE_INSTALL_TEST_DIR/venv"
fi
cd /  # python -c below puts the cwd on sys.path; never run root Python from a caller-chosen directory

# OQ-7 (owner decided 2026-11-23): reboot automatically at 04:30 Asia/Bangkok after unattended upgrades (step 8b).
# Set AUTO_REBOOT=false to fall back to manual reboots.
AUTO_REBOOT="${AUTO_REBOOT:-true}"

ENVF=/etc/employee/employee.env

# Step 3 first: refuse a wrong or dirty tree before changing anything.
# Step 3: code integrity (S11-05). A short or wrong SHA never equals the 40-hex HEAD.
[ -n "$SHA" ] || { echo "usage: install.sh [--shared-host|--dedicated-host] <release commit sha>" >&2; exit 1; }
[ "$(git -C /opt/employee/app rev-parse HEAD)" = "$SHA" ] || { echo "deploy_sha_mismatch" >&2; exit 1; }
[ -z "$(git -C /opt/employee/app status --porcelain --untracked-files=all)" ] || { echo "deploy_tree_dirty" >&2; exit 1; }
chown -R root:root /opt/employee/app && chmod -R go-w /opt/employee/app

# Shared-host guard (11.20.5): snapshot host-owned state before step 1, compare on EXIT (SHG-06).
# Snapshots live in a root-only dir outside every systemd-managed service dir (SHG-07).
snap() {
  ufw status numbered > "$1/ufw.txt" 2>&1 || true
  sshd -T > "$1/sshd.txt" 2>&1 || true
  (cd /etc/apt/apt.conf.d && sha256sum -- *) > "$1/apt.txt" 2>&1 || true
  docker ps --format '{{.Names}} {{.Image}}' > "$1/docker.txt" 2>&1 || true
  { systemctl list-units --type=service --state=running --no-legend 2>&1 | awk '{print $1}' | sort; } > "$1/services.txt" || true
  dpkg-query -W -f '${Package} ${Version}\n' > "$1/packages.txt" 2>&1 || true
}
shared_check() {
  rc=$?; trap - EXIT; set +e
  rm -rf -- "$SNAP/post"; mkdir "$SNAP/post" && snap "$SNAP/post"
  for f in ufw sshd apt docker; do
    cmp -s "$SNAP/pre/$f.txt" "$SNAP/post/$f.txt" || { echo "host_config_changed:$f" >&2; [ "$rc" -ne 0 ] || rc=1; }
  done
  for f in services packages; do  # report only: monarx and others restart on their own
    cmp -s "$SNAP/pre/$f.txt" "$SNAP/post/$f.txt" || { echo "report:${f}_changed"; diff "$SNAP/pre/$f.txt" "$SNAP/post/$f.txt"; }
  done
  exit "$rc"
}
if [ "$SHARED" = true ]; then
  [ ! -L "$SNAP" ] || { echo "snapshot_dir_symlink" >&2; exit 1; }
  install -d -o root -g root -m 0700 "$SNAP"
  rm -rf -- "$SNAP/pre"; mkdir "$SNAP/pre"; snap "$SNAP/pre"
  trap shared_check EXIT
fi

# Step 1: host packages, Debian 13 only (spec 11.19.3). libopus0 for voice (spec 12.12.16; no ffmpeg).
grep -qx 'VERSION_CODENAME=trixie' /etc/os-release || { echo "host_not_debian13" >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive APT_LISTCHANGES_FRONTEND=none
# Lock timeout: wait for unattended-upgrades/dpkg, then refuse (set -e); never kill. --no-upgrade: leave installed host packages as they are.
APT_LOCK="-o DPkg::Lock::Timeout=600"
# shellcheck disable=SC2086
apt-get $APT_LOCK update
PKGS="python3.13 python3.13-venv sqlite3 git ca-certificates tzdata libopus0"
#DEDICATED-BEGIN
# The markers only shape --plan; at runtime this line must guard itself (shared mode installs only spec 11.20.2 packages).
[ "$SHARED" = true ] || PKGS="$PKGS libpam-systemd unattended-upgrades apt-listchanges needrestart ufw"
#DEDICATED-END
# shellcheck disable=SC2086
apt-get $APT_LOCK install -y --no-install-recommends --no-upgrade $PKGS

# Step 2: service user (no password, no sudo, no other groups).
id employee >/dev/null 2>&1 || useradd --system --user-group --home-dir /var/lib/employee --no-create-home --shell /usr/sbin/nologin employee

# Step 5: env file. Created empty; the owner fills it from the admin account (docs/helper/setup.md section 8.3).
install -d -o root -g root -m 0700 /etc/employee
[ -f "$ENVF" ] || install -o root -g root -m 0600 /dev/null "$ENVF"
# Early refusal (spec 11.11.2 rule); the unit repeats this check on every start (11.18.6).
if grep -Eq '^[[:space:]]*(export[[:space:]]+)?(EMP_CLI_DEV|DATABASE_PATH|KNOWLEDGE_DIR|LOG_DIR|VOICE_TMP_DIR)[[:space:]]*=' "$ENVF"; then
  echo "env_file_forbidden_name" >&2; exit 1
fi

# Step 4: venv from the hashed lock (Debian 13, Python 3.13; spec 11.19.2), service stopped; wheels only, pip removed afterwards.
systemctl stop employee.service 2>/dev/null || true
rm -rf "$VENV" && python3.13 -m venv "$VENV"
"$VENV/bin/pip" install --no-cache-dir --only-binary=:all: --require-hashes -r /opt/employee/app/constraints/requirements.lock
rm -rf "$VENV"/bin/pip* "$VENV"/lib/python3.13/site-packages/pip*
# Platform floor (11.19.1): the venv must be 3.13 and see SQLite >= MIN_SQLITE (imported, so it cannot drift).
runuser -u employee -- /opt/employee/venv/bin/python -c "import sys; sys.path.insert(0, '/opt/employee/app'); import sqlite3; from core.db.sqlite import MIN_SQLITE; assert sys.version_info[:2] == (3, 13) and sqlite3.sqlite_version_info >= MIN_SQLITE, (sys.version, sqlite3.sqlite_version)"
# DAVE + voice import gate: fails loudly if a 3.13-removed module (audioop) or a voice wheel is missing.
runuser -u employee -- /opt/employee/venv/bin/python -c "import discord, discord.player, discord.voice, nacl.secret, davey; assert hasattr(discord.voice.VoiceClient, 'is_dave_connection')"
runuser -u employee -- /opt/employee/venv/bin/python -c "import discord.opus as o; o.load_opus('libopus.so.0'); assert o.is_loaded()"

# Step 6: knowledge seed (S11-01). Root touches only /var/lib/employee itself; /var/lib is root-owned, so it cannot be a planted symlink.
install -d -o employee -g employee -m 0700 /var/lib/employee
runuser -u employee -- sh -c 'umask 077; mkdir -p /var/lib/employee/knowledge && cp -r --update=none /opt/employee/app/knowledge/. /var/lib/employee/knowledge/'

# Step 7: units. The service (when present) creates the prod DB via its migration ExecStartPre; the timer waits for it (S11-07).
install -o root -g root -m 0644 /opt/employee/app/deploy/employee.service /opt/employee/app/deploy/employee-backup.service /opt/employee/app/deploy/employee-backup.timer /etc/systemd/system/
install -o root -g root -m 0644 /opt/employee/app/deploy/logrotate-employee /etc/logrotate.d/employee
# Swap on the host would let the 2G MemoryMax be dodged by paging (S1119-11): pin the units to no swap.
if [ -n "$(swapon --show)" ]; then
  for u in employee.service employee-backup.service; do
    install -d -m 0755 "/etc/systemd/system/$u.d"
    printf '%s\n' '[Service]' 'MemorySwapMax=0' > "/etc/systemd/system/$u.d/10-noswap.conf"
  done
fi
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/employee.service /etc/systemd/system/employee-backup.service /etc/systemd/system/employee-backup.timer
if [ -f /opt/employee/app/core/__main__.py ]; then systemctl enable --now employee.service; fi
if [ -f /var/lib/employee/employee.db ]; then systemctl enable --now employee-backup.timer; fi

if [ "$SHARED" = true ]; then
  for st in 8 8b 9; do echo "skip:$st shared-host"; done
  echo "skip:needrestart shared-host"
  exit 0
fi
#DEDICATED-BEGIN
# Step 8: security upgrades, Debian 13 (spec 11.19.5). Debian's stock origins include point releases AND Debian-Security;
# 51employee-unattended adds the security origin explicitly (lists merge), so coverage never depends on the stock file.
printf '%s\n' 'APT::Periodic::Update-Package-Lists "1";' 'APT::Periodic::Unattended-Upgrade "1";' > /etc/apt/apt.conf.d/20auto-upgrades
ORIGIN='Unattended-Upgrade::Origins-Pattern { "origin=Debian,codename=${distro_codename}-security,label=Debian-Security"; };'
if [ "$AUTO_REBOOT" = true ]; then
  # Step 8b: reboot at 04:30 Asia/Bangkok, after the 03:30 (+10m jitter) backup. Automatic-Reboot-Time is host local time.
  case "$(timedatectl show -p Timezone --value)" in
    Asia/Bangkok) RT=04:30 ;;
    UTC|Etc/UTC)  RT=21:30 ;;
    *) echo "reboot_tz_unknown" >&2; exit 1 ;;
  esac
  printf '%s\n' "$ORIGIN" 'Unattended-Upgrade::Automatic-Reboot "true";' "Unattended-Upgrade::Automatic-Reboot-Time \"$RT\";" \
    'Unattended-Upgrade::Remove-Unused-Dependencies "true";' > /etc/apt/apt.conf.d/51employee-unattended
else
  printf '%s\n' "$ORIGIN" 'Unattended-Upgrade::Automatic-Reboot "false";' 'Unattended-Upgrade::Remove-Unused-Dependencies "true";' > /etc/apt/apt.conf.d/51employee-unattended
fi
install -d -m 0755 /etc/needrestart/conf.d
printf '%s\n' "\$nrconf{restart} = 'a';" > /etc/needrestart/conf.d/employee.conf

# Step 9: firewall and sshd (S11-02, spec 11.19.7). Refuses rather than risk locking the owner out.
grep -Eq '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d/\*\.conf' /etc/ssh/sshd_config || { echo "sshd_no_include" >&2; exit 1; }
# Match blocks can override the settings checked below for some users/addresses; refuse rather than guess (S1119-04).
! grep -Eqsi '^[[:space:]]*Match[[:space:]]' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf || { echo "sshd_match_block" >&2; exit 1; }
[ "$(sshd -T | awk '$1=="port"' | wc -l)" -le 1 ] || { echo "sshd_multiple_ports" >&2; exit 1; }
! systemctl is-active --quiet ssh.socket || { echo "sshd_socket_activation" >&2; exit 1; }
SSHP="$(sshd -T | awk '$1=="port"{print $2; exit}')"
case "$SSHP" in ''|*[!0-9]*) echo "sshd_port_unknown" >&2; exit 1 ;; esac
ufw default deny incoming && ufw allow "$SSHP/tcp" && ufw --force enable
if grep -Eqs '(^|[[:space:]])(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp[0-9]+|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) ' /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys; then
  # 00- sorts before any other drop-in (cloud-init's 50-cloud-init.conf, if the image has one); sshd keeps the first value it reads.
  printf '%s\n' 'PasswordAuthentication no' 'KbdInteractiveAuthentication no' 'PermitRootLogin prohibit-password' > /etc/ssh/sshd_config.d/00-employee.conf
  chmod 0644 /etc/ssh/sshd_config.d/00-employee.conf
  sshd -t && systemctl try-reload-or-restart ssh
  E="$(sshd -T)"
  for want in 'passwordauthentication no' 'kbdinteractiveauthentication no' 'permitrootlogin without-password'; do
    printf '%s\n' "$E" | grep -qx "$want" || { echo "sshd_setting_not_effective:$want" >&2; exit 1; }
  done
else
  echo "ssh_no_authorized_key" >&2; exit 1
fi
#DEDICATED-END
