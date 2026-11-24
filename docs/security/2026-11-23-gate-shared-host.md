---
title: "Pre-deploy gate — shared-host install path (spec §11.20)"
owner: security
last_updated: 2026-11-23
task: TASK-022-SHARED
status: "RUN WITH CONDITIONS (after the fixes in this audit; as received: DO NOT RUN)"
---

# Pre-deploy gate — shared-host install path (spec §11.20)

## Contents
- [Verdict](#verdict)
- [Scope](#scope)
- [Fixed in this audit](#fixed-in-this-audit)
- [Findings](#findings)
- [Run conditions (owner, before and during the run)](#run-conditions)
- [Root commands on service-owned paths (rule 28)](#root-commands-on-service-owned-paths)
- [Domain results](#domain-results)
- [Audited files (md5, end of review)](#audited-files)

## Verdict
- **As received: DO NOT RUN.** The `#DEDICATED-BEGIN/END` markers are plain comments at runtime; only `--plan` strips them. A shared-host run therefore executed `PKGS="$PKGS unattended-upgrades apt-listchanges needrestart ufw"` and installed needrestart and apt-listchanges on the shared VPS (SHG-01). The plan test passed because it only sees the stripped plan.
- **After the fixes below: RUN WITH CONDITIONS** (C1..C7). No change to other services is expected in the current tree: `core/__main__.py` and the prod DB do not exist, so step 7 installs the units but enables nothing.

## Scope
Spec §11.20 (L2420-2460), `deploy/install.sh` (runtime and `--plan` paths, both modes), `deploy/employee.service`, `deploy/employee-backup.{service,timer}`, `deploy/logrotate-employee`, `docs/helper/setup.md` §8, `tests/test_install_plan.py`. Static review only; the VPS was not touched.

## Fixed in this audit
All in `deploy/install.sh`. `bash -n` passes, `shellcheck -S warning` is clean, `pytest -q tests core/migration` = 248 passed. The `--plan` diff, before vs after, shows only the lines below in either mode.
1. SHG-01: the dedicated package line now guards itself at runtime: `[ "$SHARED" = true ] || PKGS="$PKGS libpam-systemd unattended-upgrades apt-listchanges needrestart ufw"`.
2. SHG-02: `libpam-systemd` moved to the dedicated-only line. Shared mode now installs exactly the §11.20.2 list.
3. SHG-03: `apt-get install ... --no-upgrade`. Packages already installed on the host (python3.13, git, ca-certificates, tzdata) are never upgraded by this script.
4. SHG-04: `APT_LOCK="-o DPkg::Lock::Timeout=600"` on `apt-get update` and `install`.
5. SHG-05: the snapshot block runs `rm -rf -- "$PRE.d"; mkdir "$PRE.d"` instead of `mkdir -p "$PRE.d"`. Entries planted by the service user are dropped before root writes, and `mkdir` fails if the name reappears.

## Findings
| ID | Sev | Where (anchor) | Issue | Remediation | Owner |
| :-- | :-- | :-- | :-- | :-- | :-- |
| SHG-01 | High | install.sh `PKGS="$PKGS unattended-upgrades apt-listchanges needrestart ufw"` | Ran in shared mode, so needrestart and apt-listchanges were installed. With `DEBIAN_FRONTEND=noninteractive`, needrestart can then restart caddy/cloudflared/fail2ban/docker on every later unattended-upgrades run (§11.20.2 forbids it). Both packages drop files into `/etc/apt/apt.conf.d/`, so `host_config_changed:apt` would only fire after the damage. | FIXED (guard). Test gap: `test_install_plan.py` checks only the stripped plan. Add a test that every `#DEDICATED` block before the shared `exit 0` starts with `[ "$SHARED" = true ] \|\|` (or run the shared path with stubbed apt-get and assert argv). | tester/backend |
| SHG-02 | Medium | install.sh `PKGS=... libpam-systemd` | Not in the §11.20.2 allowed list. If absent on the host it pulls a matching `systemd` (postinst re-exec affects every service). | FIXED (dedicated-only). `setup.md` §8.2 still lists it for shared mode (doc drift). | document |
| SHG-03 | Medium | install.sh `apt-get install -y --no-install-recommends $PKGS` | `apt-get install` of an installed package upgrades it to the candidate, including exact-version dependencies. That changes host packages outside unattended-upgrades. | FIXED (`--no-upgrade`). If the `python3.13-venv` candidate needs a newer `python3.13`, apt now refuses instead of upgrading. See C2. | — |
| SHG-04 | Low | install.sh `apt-get update` / `install` | dpkg lock vs unattended-upgrades. As received, apt failed at once on a held lock and `set -e` exited: this is already "refuse, not kill". The install now waits up to 10 min for the dpkg frontend lock. `apt-get update` may still fail at once on `/var/lib/apt/lists/lock` (the timeout is reported not to cover the lists lock), which also exits cleanly. Nothing kills apt or removes locks. | FIXED (timeout). Meets the brief either way. | — |
| SHG-05 | High | install.sh snapshot block `mkdir -p "$PRE.d"; snap "$PRE.d"` | `employee.service` has `LogsDirectory=employee`, so systemd chowns `/var/log/employee` to `employee` on start. On the next upgrade run, a compromised bot could pre-plant `preinstall.d/ufw.txt -> /etc/shadow`. Root's `> "$1/ufw.txt"` then truncates and overwrites it (host lockout). Not exploitable on the first run (the service has never started). | FIXED (fresh dir after the root chown). Residual Low: SHG-07. | — |
| SHG-06 | Medium | install.sh `set -euo pipefail` with the diff at the end | Any failure after the snapshot (venv, gates, `systemctl enable --now` once `core/__main__.py` exists and the migration fails on an empty env file) exits before the `cmp` loop. Host drift is then unchecked and no `skip:` lines print. | Add `trap` on EXIT in shared mode that runs the diff (report-only on the error path). Until then: C6. | backend |
| SHG-07 | Low | spec §11.20.5 location `/var/log/employee/preinstall-*.txt` | After a service start these files become employee-owned and readable by the bot (`sshd -T`, ufw rules: recon data, no secrets). | Move the snapshots to a root-only path (e.g. `/var/backups/employee-preinstall/`) and update spec §11.20.5 and setup.md. | backend + sa |
| SHG-08 | Low | install.sh `snap()` | The diff cannot see restarts (Docker names/images are unchanged after a restart) or package-set changes, and it treats a failing probe that fails the same way twice as equal. It may false-positive if fail2ban uses a ufw banaction and bans during the run. | Add a report-only `dpkg-query -W` diff plus `systemctl show -p ActiveEnterTimestamp` for host services. Do not make it a hard fail (monarx restarts on its own). | backend |
| SHG-09 | Info | install.sh `systemctl daemon-reload` | A global reload also applies any pending unit edits of other services. `apt-get update` refreshes the lists only. `useradd` writes only the `employee` entries. Every `/etc` write is named `employee`. | None. Noted for the owner. | — |

## Run conditions
- C1: Run inside `tmux` or `screen` as `lw` (`sudo -i`, then `cd /`). If SSH drops mid-dpkg, dpkg is left half-configured and unattended-upgrades breaks host-wide until `dpkg --configure -a` runs.
- C2: Dry run first, as `lw` without sudo: `apt-get -s install --no-upgrade --no-install-recommends python3.13 python3.13-venv sqlite3 git ca-certificates tzdata`. Proceed only if it shows new `Inst` lines and no `Inst pkg [oldver]` upgrades and no `Remv`.
- C3: `dpkg -s libpam-systemd` shows installed. Install.sh no longer installs it in shared mode, and `lw`'s user audit timer (§11.20.4) needs it.
- C4: `getent passwd employee` and `getent group employee` are empty before the first run. Otherwise the script reuses or fails on the existing account.
- C5: Run with `umask` 0022 under sudo. Otherwise the venv and app are unreadable to `employee` and the gates fail. That is fail-safe but leaves the run broken.
- C6: Before the run and after it (whatever the exit code), capture `systemctl show -p ActiveEnterTimestamp caddy cloudflared fail2ban docker monarx-agent` and `docker inspect -f '{{.Name}} {{.State.StartedAt}}' $(docker ps -q)`, and compare. On a non-zero exit, repeat the four snapshot commands by hand and diff them against `/var/log/employee/preinstall-*.txt`.
- C7: Deploy this exact tree (install.sh md5 below); the received version must not run.

## Root commands on service-owned paths
- `/var/log/employee` (employee-owned after a service start): `install -d -o root` (no follow; `/var/log` is root-owned), and the snapshot writes. These were unsafe before the SHG-05 fix and are safe now that the directory is re-owned by root and `preinstall.d` is recreated. The `mv` to `preinstall-*.txt` renames over a planted symlink and does not follow it.
- `/var/lib/employee`: `install -d -o employee` only on the directory itself (safe, as before); the seed runs via `runuser`.
- `/opt/employee/*`: root-owned; `chown -R` does not follow symlinks (`-P` is the default).
- `/etc/employee/employee.env`: root 0600 in a root 0700 directory; it is read only by systemd as root, and the backup unit gets no env file. The forbidden-name guard runs in the script and in `ExecStartPre=+`. The setup.md §8.3 edit paths (`install /dev/stdin`, `sudoedit` with no swap/backup/undo files) leave no residue.

## Domain results
Secrets PASS. Injection N/A. Prompt N/A. AuthN/AuthZ PASS: no inbound port, service user has no shell and no sudo. Transport N/A. Native memory N/A. Log privacy PASS (scope). Containers N/A: no Docker usage added. Supply chain: hashed wheels only (`--only-binary --require-hashes`), pip removed afterwards, and the gates run as `employee`. The CVE scan is outside this gate (weekly timer, §8.4). Unit hardening matches §11.20.3 caps.

## Audited files
md5 at the end of review:
```
55444be6b1b11c599d438c3e3bba569f deploy/install.sh
18a89fcfeae91409eb46644cde0ae743 deploy/employee.service
c7c3052fdeba928b4a4c0af239042979 deploy/employee-backup.service
ec338fe1664af4382fa5666fe560f4fc deploy/employee-backup.timer
1e165cf456dfa6c9954190da698735c7 deploy/logrotate-employee
ce79b4361bc1a59a3301a9abf01610a0 docs/helper/setup.md
696be72b16225a79c88d62bcc8538d01 docs/specs/2026-11-23-phase1-spec-s11-sqlite-vps.md
36ee1b5dcc9dcc4aa03815ba00d49d35 tests/test_install_plan.py
```
Received install.sh md5: `30fcafad75edf0519a9105112293499d`.
