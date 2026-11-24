"""Spec 11.20: shared-host install plan must not contain host-owned config commands."""
import re
import subprocess
from pathlib import Path

DEPLOY = Path(__file__).resolve().parents[1] / "deploy"
FORBIDDEN = re.compile(r"ufw (default|allow|--force|enable)|sshd_config|20auto-upgrades|51employee|"
                       r"unattended|needrestart|try-reload-or-restart ssh|timedatectl|hostnamectl")


def _plan(*flags):
    return subprocess.run(["bash", str(DEPLOY / "install.sh"), "--plan", *flags],
                          check=True, capture_output=True, text=True).stdout.splitlines()


def test_shared_host_plan_has_no_host_config_commands():
    plan = [ln for ln in _plan() if not ln.strip().startswith('echo "skip:')]
    assert plan and not [ln for ln in plan if FORBIDDEN.search(ln)]
    assert 'echo "skip:needrestart shared-host"' in "\n".join(_plan())


def test_dedicated_host_plan_keeps_hardening_steps():
    text = "\n".join(_plan("--dedicated-host"))
    assert "ufw --force enable" in text and "needrestart" in text and "51employee-unattended" in text


def test_resource_caps():
    svc = (DEPLOY / "employee.service").read_text()
    for line in ("MemoryMax=1G", "CPUQuota=60%", "TasksMax=100", "Nice=5"):
        assert line in svc.splitlines()
    bk = (DEPLOY / "employee-backup.service").read_text().splitlines()
    assert {"MemoryMax=256M", "Nice=10", "IOSchedulingClass=idle"} <= set(bk)


# --- Real branch logic: run install.sh as non-root with logging stubs on PATH (test hook EMPLOYEE_INSTALL_TEST_DIR). ---
SHA = "a" * 40
LOGGER = '#!/bin/sh\necho "$(basename "$0") $*" >> "$STUB_LOG"\n'
STUBS = {  # name -> extra shell after the log line
    "git": 'case "$*" in *rev-parse*) echo $SHA;; esac',
    "id": '[ "$1" = -u ] && echo 1000; exit 0',
    "grep": 'case "$*" in *os-release*) exit 0;; esac; exit 1',
    "dpkg-query": '[ -f "$STUB_DIR/drift" ] && echo "newpkg 1"; exit 0',
    "ufw": '[ -f "$STUB_DIR/drift" ] && echo extra-rule; exit 0',
}
NOOPS = ("apt-get chown chmod install rm useradd systemctl python3.13 runuser swapon systemd-analyze sshd docker "
         "sha256sum timedatectl needrestart apt-listchanges").split()


def _run(tmp_path, *flags, fail=False, drift=False):
    stubs = tmp_path / "bin"
    (tmp_path / "snap").mkdir(exist_ok=True)
    (tmp_path / "venv/bin").mkdir(parents=True, exist_ok=True)
    stubs.mkdir(exist_ok=True)
    for n in {*STUBS, *NOOPS}:
        (stubs / n).write_text(LOGGER + STUBS.get(n, "") + "\n")
        (stubs / n).chmod(0o755)
    (tmp_path / "venv/bin/pip").write_text(
        LOGGER.replace('$(basename "$0")', "pip") + ('touch "$STUB_DIR/drift"\n' if drift else "") + ("exit 1\n" if fail else ""))
    (tmp_path / "venv/bin/pip").chmod(0o755)
    env = {"PATH": f"{stubs}:/usr/bin:/bin", "STUB_LOG": str(tmp_path / "log"), "STUB_DIR": str(tmp_path),
           "SHA": SHA, "EMPLOYEE_INSTALL_TEST_DIR": str(tmp_path), "TMPDIR": str(tmp_path)}
    (tmp_path / "log").touch()
    r = subprocess.run(["bash", str(DEPLOY / "install.sh"), *flags, SHA], env=env, capture_output=True, text=True)
    return r, (tmp_path / "log").read_text()


def test_shared_run_never_invokes_host_config_commands(tmp_path):
    r, log = _run(tmp_path)
    assert r.returncode == 0, r.stderr
    assert not re.search(r"^(needrestart|apt-listchanges|timedatectl) |ufw (default|allow|--force|enable)|sshd_config|51employee|libpam-systemd|unattended", log, re.M)
    assert "--no-upgrade" in log and "DPkg::Lock::Timeout=600" in log
    assert "skip:needrestart shared-host" in r.stdout
    assert "libopus0" in log and "ffmpeg" not in log


def test_dedicated_run_does_invoke_them(tmp_path):
    _, log = _run(tmp_path, "--dedicated-host")
    assert "libpam-systemd" in log and "ufw" in log


def test_exit_trap_reports_drift_and_keeps_exit_code(tmp_path):
    # pip fails mid-run after "host drift" (ufw and dpkg output change): exit code stays 1, drift still reported
    r, _ = _run(tmp_path, fail=True, drift=True)
    assert r.returncode == 1 and "host_config_changed:ufw" in r.stderr
    assert "report:packages_changed" in r.stdout and "newpkg 1" in r.stdout and "report:services_changed" not in r.stdout


def test_exit_trap_failing_drift_on_success_exits_1(tmp_path):
    r, _ = _run(tmp_path, drift=True)
    assert r.returncode == 1 and "host_config_changed:ufw" in r.stderr


def test_snapshot_dir_symlink_refused(tmp_path):
    (tmp_path / "elsewhere").mkdir()
    (tmp_path / "snap").symlink_to(tmp_path / "elsewhere")
    r, _ = _run(tmp_path)
    assert r.returncode == 1 and "snapshot_dir_symlink" in r.stderr
