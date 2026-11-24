"""MCP-07: the committed mcp/ configs load through the real loaders and keep the Gate 1 conditions (G040-02/03/04/13/14)."""
import json
import re
import subprocess
import tomllib
from pathlib import Path

import pytest

from core.mcp.host import load_server
from core.mcp.policy import CLASSES, PolicyError, classify, effective_args, load_access, load_policy

MCP = Path(__file__).resolve().parents[1] / "mcp"
SVCS = ("github", "clickup", "google", "hostinger")
SEV = {c: i for i, c in enumerate(CLASSES)}
POL = {s: load_policy(MCP / s / "policy.toml") for s in SVCS}


def tool(svc, name):
    return POL[svc].tools[name]


def cls(svc, name, args=None):
    return classify(tool(svc, name), args or {})[0]


@pytest.mark.parametrize("svc", SVCS)
def test_policy_and_server_load(svc):
    p = POL[svc]
    assert p.service == svc and p.tools
    srv = load_server(MCP / svc / "server.toml")  # G040-04 is enforced by this loader
    assert srv.name == svc
    assert all(re.fullmatch(rf"MCP_{svc.upper()}_[A-Z0-9_]+", v) for v in srv.secrets.values())
    for t in p.tools.values():
        assert t.cls in CLASSES and t.tool_sha256 == ""  # hashes pending: fail closed
        assert all(SEV[r["cls"]] >= SEV[t.cls] for r in t.rules)  # rules only raise
        if t.dispatch:
            assert t.cls == min(t.dispatch["map"].values(), key=SEV.get)
        if SEV[t.cls] >= SEV["write"] and t.cls not in ("settings", "payment", "blocked") or t.dispatch:
            if t.scope is None:  # only these are Praw-only
                assert t.tool in {"create_gist", "update_gist", "dismiss_notification", "mark_all_notifications_read"}


def test_access_loads_with_secure_defaults():
    a = load_access(MCP / "access.toml")
    assert set(a.services) == set(SVCS) and a.github_default_owner == ""
    assert a.services["github"].depts == ("DEV", "PRD") and a.services["hostinger"].depts == ("IT",)
    assert all(not v for sc in a.scopes.values() for v in sc.values())  # no scope means no write for heads
    assert "HQ" not in a.services["clickup"].depts


def test_g040_04_bad_env_sources_refused(tmp_path):
    base = (MCP / "github" / "server.toml").read_text()
    for old, new in (('"MCP_GITHUB_TOKEN"', '"DISCORD_BOT_TOKEN"'), ('GITHUB_TOOLSETS = ', 'NODE_OPTIONS = ')):
        f = tmp_path / "server.toml"
        f.write_text(base.replace(old, new))
        with pytest.raises(Exception):
            load_server(f)


def test_pins():
    gh = tomllib.loads((MCP / "github" / "server.toml").read_text())["pin"]
    assert set(gh["sha256"]) == {"darwin_arm64", "darwin_x86_64", "linux_x86_64", "linux_arm64"}
    assert all(re.fullmatch(r"[0-9a-f]{64}", h) for h in gh["sha256"].values())
    for svc, pkg in (("clickup", "@hauptsache.net/clickup-mcp"), ("hostinger", "@hostinger/mcp")):
        pin = tomllib.loads((MCP / svc / "server.toml").read_text())["pin"]
        lock = json.loads((MCP / svc / "package-lock.json").read_text())
        assert lock["lockfileVersion"] >= 3
        assert all("integrity" in v for k, v in lock["packages"].items() if k and not v.get("link"))
        top = lock["packages"][f"node_modules/{pkg}"]
        assert (top["version"], top["integrity"]) == (pin["version"], pin["integrity"])
        assert json.loads((MCP / svc / "package.json").read_text())["dependencies"] == {pkg: pin["version"]}
    req = (MCP / "google" / "requirements.lock").read_text()
    assert "workspace-mcp==2.6.0 \\" in req and "--hash=sha256:" in req


def test_install_script_hardened():
    sh = Path(__file__).resolve().parents[1] / "scripts" / "mcp-install.sh"
    subprocess.run(["bash", "-n", str(sh)], check=True)
    t = sh.read_text()
    for needle in ("set -euo pipefail", "--proto '=https' --tlsv1.2", "--ignore-scripts", "--require-hashes",
                   "--only-binary=:all:", "gh attestation verify", "against server.toml"):
        assert needle in t


def test_g040_02_hostinger():
    ex = tool("hostinger", "execute")
    run = lambda op, **p: classify(ex, {"operation": op, "params": p})[0]
    assert run("vps_docker_create", virtualMachineId=1) == "settings"
    assert run("vps_docker_update", virtualMachineId=1) == "settings"
    assert run("vps_virtual-machines_recreate", virtualMachineId=1) == "irreversible"
    assert run("vps_virtual-machines_recreate", virtualMachineId=1, password="x") == "settings"
    assert run("vps_backups_restore", virtualMachineId=1, post_install_script_id=3) == "settings"
    assert run("vps_virtual-machines_purchase") == "payment"
    assert run("VPS_virtual-machines_start ", virtualMachineId=1) == "write"
    assert run("vps_unknown") == "blocked"
    with pytest.raises(PolicyError):  # invalid_id (G040-01)
        run("vps_virtual-machines_get", virtualMachineId="1/../../billing")
    assert run("vps_virtual-machines_get", virtualMachineId=1, note="a/b") == "blocked"
    assert cls("hostinger", "multi-execute") == "blocked"


def test_g040_03_github():
    for t in ("create_or_update_file", "delete_file"):
        assert cls("github", t, {"owner": "o", "repo": "r", "path": ".GitHub/Workflows/ci.yml"}) == "settings"
        assert cls("github", t, {"owner": "o", "repo": "r", "path": "src/a.py"}) in ("write", "delete_recoverable")
    assert cls("github", "push_files", {"owner": "o", "repo": "r", "files": [{"path": "a"}, {"path": ".github/workflows/x.yml"}]}) == "settings"
    assert cls("github", "push_files", {"owner": "o", "repo": "r", "files": [{"path": "CODEOWNERS"}]}) == "settings"
    assert cls("github", "issue_write", {"owner": "o", "repo": "r", "state": "CLOSED"}) == "delete_recoverable"
    assert tool("github", "create_repository").force == {"private": True, "organization": "$access:github_default_owner"}  # G2T040-07
    assert tool("github", "create_gist").force == {"public": False}
    assert effective_args(tool("github", "create_repository"), {"name": "n", "organization": "evil"}, "Tek",
                          {"access:github_default_owner": "acme"}) == {"name": "n", "organization": "acme", "private": True}
    assert cls("github", "delete_repository", {"owner": "o", "repo": "r"}) == "irreversible"
    assert cls("github", "get_secret_scanning_alert") == "blocked"
    assert cls("github", "actions_run_trigger", {"owner": "o", "repo": "r"}) == "payment"


def test_owner_answers_and_google_blocks():
    assert cls("google", "batch_update_doc") == "blocked" and cls("google", "get_drive_file_download_url") == "blocked"
    assert cls("google", "set_drive_file_permissions") == "settings"
    assert not any("gmail" in n for n in POL["google"].tools)
    assert cls("google", "manage_event", {"action": "create", "guests_can_modify": True}) in ("settings", "blocked")
    assert cls("google", "manage_event", {"action": "delete"}) == "delete_recoverable"
    assert cls("google", "read_sheet_values", {"file_path": "/etc/passwd"}) == "blocked"
    assert set(POL["hostinger"].tools) == {"search", "execute", "multi-execute"}
    assert cls("clickup", "createTask") == "write" and not any(t.cls in ("irreversible", "settings", "payment") for t in POL["clickup"].tools.values())
