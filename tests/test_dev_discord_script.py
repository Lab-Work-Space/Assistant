import os
import subprocess

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, "scripts", "dev-discord.sh")
SECRET = "SECRETVALUE-do-not-print-0123456789"


def run(tmp_path, body, mode=0o600, env=None, link=False):
    f = tmp_path / "e.local"
    f.write_text(body)
    f.chmod(mode)
    p = f
    if link:
        p = tmp_path / "ln"
        p.symlink_to(f)
    e = {"PATH": os.environ["PATH"], "HOME": str(tmp_path), "EMP_DISCORD_ENV_FILE": str(p), **(env or {})}
    r = subprocess.run(["bash", SCRIPT], capture_output=True, text=True, env=e, timeout=30)
    return r.returncode, r.stdout + r.stderr


@pytest.mark.parametrize("body,kw,msg", [
    (f"CHANNEL_ALLOWLIST=\nX={SECRET}\n", {}, "CHANNEL_ALLOWLIST is empty"),
    (f"CHANNEL_ALLOWLIST=1\nX={SECRET}\n", {"mode": 0o644}, "mode 0600"),
    (f"CHANNEL_ALLOWLIST=1\nX={SECRET}\n", {"link": True}, "not a symlink"),
    (f"CHANNEL_ALLOWLIST=1\nEMP_CLI_DEV=1\nX={SECRET}\n", {}, "must not set EMP_CLI_DEV"),
    (f"CHANNEL_ALLOWLIST=1\nDATABASE_PATH=/x\nX={SECRET}\n", {}, "must not set DATABASE_PATH"),
    (f"CHANNEL_ALLOWLIST=1\nLOG_DIR=/x\n", {}, "must not set LOG_DIR"),
    (f"CHANNEL_ALLOWLIST=1\nDISCORD_BOT_TOKEN={SECRET}\n", {}, "DISCORD_BOT_TOKEN is not used"),
    ("", {"env": {"EMP_CLI_DEV": "1"}}, "EMP_CLI_DEV is set"),
    ("CHANNEL_ALLOWLIST=1\nKNOWLEDGE_DIR=/x\n", {}, "must not set KNOWLEDGE_DIR"),
    ("CHANNEL_ALLOWLIST=1\nVOICE_TMP_DIR=/x\n", {}, "must not set VOICE_TMP_DIR"),
])
def test_refusals_never_echo_env_file(tmp_path, body, kw, msg):
    rc, out = run(tmp_path, body, **kw)
    assert rc != 0 and msg in out and SECRET not in out


def test_missing_file(tmp_path):
    e = {"PATH": os.environ["PATH"], "HOME": str(tmp_path), "EMP_DISCORD_ENV_FILE": str(tmp_path / "nope")}
    r = subprocess.run(["bash", SCRIPT], capture_output=True, text=True, env=e, timeout=30)
    assert r.returncode != 0 and "missing" in r.stderr


def test_empty_template_lines_are_accepted(tmp_path):
    body = "EMP_CLI_DEV=\nDATABASE_PATH=\nKNOWLEDGE_DIR=\nLOG_DIR=\nVOICE_TMP_DIR=\nDISCORD_BOT_TOKEN=\nCHANNEL_ALLOWLIST=\n"
    rc, out = run(tmp_path, body)  # gets past every empty-var check to the allowlist check
    assert rc != 0 and "CHANNEL_ALLOWLIST is empty" in out and "must not set" not in out


def test_env_local_name_is_allowed(tmp_path):  # 12.13 supersedes the S12-06 name refusal
    d = tmp_path / "w"
    d.mkdir()
    f = d / ".env.local"
    f.write_text("CHANNEL_ALLOWLIST=\n")
    f.chmod(0o600)
    e = {"PATH": os.environ["PATH"], "HOME": str(tmp_path), "EMP_DISCORD_ENV_FILE": str(f)}
    r = subprocess.run(["bash", SCRIPT], capture_output=True, text=True, env=e, timeout=30)
    assert "never source" not in r.stderr and "CHANNEL_ALLOWLIST is empty" in r.stderr
