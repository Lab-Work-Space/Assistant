"""MCP-03 host tests against tests/fixtures/fake_mcp_server.py (no network). Gate 1: G040-04, 08, 09, 13."""
import asyncio
import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from core.functions.logs import masking
from core.mcp import host as H

FAKE = str(Path(__file__).parent / "fixtures" / "fake_mcp_server.py")
SECRET = "s3cr3t-fake-token-value"


class Log:
    def __init__(self):
        self.rows = []

    def write_log(self, comp, event, level, **kw):
        self.rows.append((event, level, kw))

    def ev(self, event):
        return [r for r in self.rows if r[0] == event]


def sha(tool: dict) -> str:
    c = json.dumps({k: tool[k] for k in ("name", "description", "inputSchema")}, sort_keys=True,
                   ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(c.encode()).hexdigest()


def write_cfg(root: Path, name="fake", log="calls.log", variant="", extra="", enabled="true", env=True, timeout=60):
    d = root / name
    d.mkdir(parents=True, exist_ok=True)
    args = [FAKE, "--log", str(root / log)] + (["--variant", variant] if variant else [])
    envs = f'[env]\nFAKE_TOKEN = {{ from = "MCP_{name.upper()}_TOKEN", secret = true }}\n' if env else ""
    (d / "server.toml").write_text(
        f'name = "{name}"\nenabled = {enabled}\ncommand = "{sys.executable}"\nargs = {json.dumps(args)}\n'
        f"call_timeout_s = {timeout}\n{extra}\n{envs}")
    return d


def calls(root: Path, log="calls.log"):
    p = root / log
    return [json.loads(x) for x in p.read_text().splitlines()] if p.exists() else []


def host(tmp_path, pol=None, log=None, environ=None, **kw):
    kw = {"ping_s": 0.2, "ping_timeout_s": 5, "backoff_s": 0.1, **kw}
    return H.McpHost(tmp_path / "mcp_root", tmp_path / "data", log or Log(), pol or {},
                     environ=environ if environ is not None else {"MCP_FAKE_TOKEN": SECRET, "USER": "u",
                                                                 "DISCORD_BOT_TOKEN": "d" * 30},
                     hash_fn=sha, **kw)


@pytest.fixture(scope="module")
def hashes():
    """Real tool hashes of the fake server, per variant, taken from a live unpoliced host."""
    import tempfile

    async def one(variant):
        with tempfile.TemporaryDirectory() as t:
            t = Path(t)
            write_cfg(t / "mcp_root", variant=variant)
            h = H.McpHost(t / "mcp_root", t / "data", Log(), {}, environ={"MCP_FAKE_TOKEN": SECRET}, hash_fn=sha)
            await h.start()
            await h.wait_state("fake")
            out = {n: sha(d) for n, d in h.live_tools("fake").items()}
            await h.stop()
            return out
    return {v: asyncio.run(one(v)) for v in ("", "desc")}


def policy(hashes, only=None, elicits=()):
    return {"fake": {n: SimpleNamespace(tool_sha256=hv, registered=f"mcp_fake_{n}", elicits=n in elicits)
                     for n, hv in hashes[""].items() if only is None or n in only}}


async def up(tmp_path, hashes=None, only=None, elicits=(), variant="", **kw):
    write_cfg(tmp_path / "mcp_root", variant=variant, **{k: kw.pop(k) for k in ("timeout",) if k in kw})
    h = host(tmp_path, policy(hashes, only, elicits) if hashes else None, **kw)
    await h.start()
    assert await h.wait_state("fake") == "running"
    return h


# ---- G040-04 config / env allowlist (pure)
@pytest.mark.parametrize("env,code", [
    ('X = { from = "DISCORD_BOT_TOKEN", secret = true }', "env_source_refused"),
    ('X = { from = "MCP_GITHUB_TOKEN", secret = true }', "env_source_refused"),   # other service's prefix
    ('NODE_OPTIONS = "--inspect"', "env_key_refused"),
    ('PYTHONPATH = "/x"', "env_key_refused"),
    ('DYLD_INSERT_LIBRARIES = "/x"', "env_key_refused"),
    ('API_BASE_URL = "http://evil"', "env_key_refused"),
    ('NODE_OPTIONS = { from = "MCP_FAKE_X", secret = true }', "env_key_refused"),  # destination key too
    ('PATH = "/evil"', "env_key_refused"),
    ('SOMETHING = "lit"', "env_literal_not_allowed"),
])
def test_server_toml_env_refused(tmp_path, env, code):
    d = tmp_path / "fake"
    d.mkdir()
    (d / "server.toml").write_text(f'name = "fake"\ncommand = "x"\n[env]\n{env}\n')
    with pytest.raises(H.ServerConfigError, match=code):
        H.load_server(d / "server.toml")


def test_server_toml_allowed_literal_and_unknown_key(tmp_path):
    d = tmp_path / "github"
    d.mkdir()
    (d / "server.toml").write_text('name = "github"\ncommand = "x"\n[env]\nGITHUB_TOOLSETS = "repos"\n'
                                   'GITHUB_PERSONAL_ACCESS_TOKEN = { from = "MCP_GITHUB_TOKEN", secret = true }\n')
    c = H.load_server(d / "server.toml")
    assert c.literals == {"GITHUB_TOOLSETS": "repos"} and c.secrets == {"GITHUB_PERSONAL_ACCESS_TOKEN": "MCP_GITHUB_TOKEN"}
    (d / "server.toml").write_text('name = "github"\ncommand = "x"\nbogus = 1\n')
    with pytest.raises(H.ServerConfigError):
        H.load_server(d / "server.toml")


# ---- lifecycle, comparison, env, caps
async def test_startup_compare_blocks_unclassified_and_logs(tmp_path, hashes):
    log = Log()
    write_cfg(tmp_path / "mcp_root", variant="extra")
    h = host(tmp_path, policy(hashes), log=log)
    await h.start()
    await h.wait_state("fake")
    try:
        assert h.state("fake") == "running"
        assert "surprise" in h.live_tools("fake") and "surprise" not in h.active("fake")
        assert "read_echo" in h.active("fake")
        un = log.ev("mcp.tool_unclassified")
        assert un and un[0][1] == "WARNING" and un[0][2] == {"service": "fake", "tool": "surprise"}
        assert h.status()[0]["unclassified"] == ["surprise"]
    finally:
        await h.stop()


async def test_description_change_alone_blocks(tmp_path, hashes):
    log = Log()
    write_cfg(tmp_path / "mcp_root", variant="desc")
    h = host(tmp_path, policy(hashes), log=log)
    await h.start()
    await h.wait_state("fake")
    try:
        assert "read_echo" not in h.active("fake") and "write_note" in h.active("fake")
        assert log.ev("mcp.tool_changed")[0][2] == {"service": "fake", "tool": "read_echo"}
        with pytest.raises(H.HostError) as e:
            await h.call("fake", "read_echo", {})
        assert e.value.code == "service_error"
        assert calls(tmp_path / "mcp_root") == []
    finally:
        await h.stop()


async def test_env_only_own_allowed_keys_and_secret_masked(tmp_path, hashes):
    h = await up(tmp_path, hashes)
    try:
        ok, text = await h.call("fake", "leak_env", {})
        keys = set(json.loads(text))
        assert ok and "FAKE_TOKEN" in keys
        assert not [k for k in keys if k.startswith(("DISCORD", "ANTHROPIC", "MCP_"))]
        assert keys <= {"PATH", "HOME", "SHELL", "USER", "LOGNAME", "LANG", "FAKE_TOKEN", "LC_CTYPE", "__CF_USER_TEXT_ENCODING"}
        assert SECRET in masking.exact_values()
        assert (tmp_path / "data" / "mcp" / "fake").stat().st_mode & 0o777 == 0o700
    finally:
        await h.stop()


async def test_call_ok_cap_and_iserror(tmp_path, hashes):
    h = await up(tmp_path, hashes)
    try:
        assert await h.call("fake", "read_echo", {"text": "hi"}) == (True, "echo:hi")
        ok, text = await h.call("fake", "big", {"n": 40_000})
        assert ok and text.endswith("\n[truncated: 8000 chars]") and len(text) == 32_000 + len("\n[truncated: 8000 chars]")
        ok, text = await h.call("fake", "isfail", {})
        assert not ok and len(text) <= 2000
    finally:
        await h.stop()


async def test_slow_call_times_out(tmp_path, hashes):
    h = await up(tmp_path, hashes, timeout=5)
    try:
        t = time.monotonic()
        with pytest.raises(H.HostError) as e:
            await h.call("fake", "slow", {"s": 20})
        assert e.value.code == "tool_timeout" and time.monotonic() - t < 8
        assert h.state("fake") == "running"
    finally:
        await h.stop()


async def test_crash_restarts_with_backoff_and_unavailable_while_down(tmp_path, hashes):
    log = Log()
    h = await up(tmp_path, hashes, log=log, backoff_s=0.5)
    try:
        with pytest.raises(H.HostError) as e:
            await h.call("fake", "crash", {})
        assert e.value.code == "service_error"
        assert await h.wait_state("fake", ("down", "starting"), 5) in ("down", "starting")
        with pytest.raises(H.HostError) as e:
            await h.call("fake", "read_echo", {})
        assert e.value.code == "service_unavailable"
        assert await h.wait_state("fake", ("running",), 15) == "running"
        assert h.status()[0]["restarts"] >= 1
        assert await h.call("fake", "read_echo", {"text": "again"}) == (True, "echo:again")
    finally:
        await h.stop()


async def test_five_failures_log_server_down(tmp_path):
    log = Log()
    write_cfg(tmp_path / "mcp_root")
    cfg = tmp_path / "mcp_root" / "fake" / "server.toml"
    cfg.write_text(cfg.read_text().replace(sys.executable, "/usr/bin/false"))  # exits at once: init fails
    h = host(tmp_path, log=log, backoff_s=0.01)
    await h.start()
    t = time.monotonic()
    while not log.ev("mcp.server_down") and time.monotonic() - t < 10:
        await asyncio.sleep(0.05)
    await h.stop()
    assert log.ev("mcp.server_down")[0][1] == "ERROR"


async def test_tool_list_changed_recompares(tmp_path, hashes):
    h = await up(tmp_path, hashes)
    try:
        assert "late_tool" not in h.live_tools("fake")
        await h.call("fake", "add_tool", {})
        for _ in range(100):
            if "late_tool" in h.live_tools("fake"):
                break
            await asyncio.sleep(0.05)
        assert "late_tool" in h.live_tools("fake") and "late_tool" not in h.active("fake")
    finally:
        await h.stop()


async def test_not_configured_disabled_and_bad_config_isolated(tmp_path, hashes):
    log = Log()
    root = tmp_path / "mcp_root"
    write_cfg(root)                       # fake: token missing
    write_cfg(root, name="off", enabled="false")
    bad = root / "bad"
    bad.mkdir()
    (bad / "server.toml").write_text('name = "bad"\ncommand = "x"\n[env]\nNODE_OPTIONS = "x"\n')
    write_cfg(root, name="ok")
    h = host(tmp_path, log=log, environ={"MCP_OK_TOKEN": SECRET})
    await h.start()
    assert await h.wait_state("fake", ("not_configured",)) == "not_configured"
    assert await h.wait_state("ok") == "running"
    assert h.state("off") == "disabled" and h.state("bad") == "unknown"
    assert log.ev("mcp.not_configured")[0][1] == "INFO" and log.ev("mcp.config_invalid")[0][1] == "ERROR"
    await h.stop()


# ---- G040-09
async def test_google_creds_perms_and_oauth_url_dropped(tmp_path, hashes):
    root = tmp_path / "mcp_root"
    log = Log()
    write_cfg(root, name="google")
    creds = H.ensure_dirs(tmp_path / "data", "google") / "credentials"
    creds.mkdir(mode=0o700)
    f = creds / "u@x.json"
    f.write_text("{}")
    os.chmod(f, 0o644)
    h = host(tmp_path, log=log, environ={"MCP_GOOGLE_TOKEN": SECRET})
    await h.start()
    assert await h.wait_state("google", ("not_configured", "running")) == "not_configured"
    assert log.ev("mcp.creds_perms")[0][1] == "ERROR"
    await h.stop()
    os.chmod(f, 0o600)
    pol = {"google": {n: SimpleNamespace(tool_sha256=v, registered=n, elicits=False) for n, v in hashes[""].items()}}
    h = host(tmp_path, pol, log=log, environ={"MCP_GOOGLE_TOKEN": SECRET})
    await h.start()
    assert await h.wait_state("google") == "running"
    try:
        assert await h.call("google", "oauth_url", {}) == (False, "auth_required")
        assert log.ev("mcp.auth_required")[0][1] == "WARNING"
    finally:
        await h.stop()


def test_creds_dir_checks(tmp_path):
    c = tmp_path / "credentials"
    c.mkdir(mode=0o700)
    H.check_creds(c)
    os.chmod(c, 0o755)
    with pytest.raises(H.NotConfigured):
        H.check_creds(c)
    os.chmod(c, 0o700)
    link = tmp_path / "link"
    link.symlink_to(c)
    with pytest.raises(H.NotConfigured):
        H.check_creds(link)
    with pytest.raises(H.NotConfigured):
        H.check_creds(tmp_path / "missing")


# ---- G040-09 Node fs scope, G040-13 pin
def _node_cfg(tmp_path, extra=""):
    root = tmp_path / "mcp" / "clickup"
    (root / "bin").mkdir(parents=True)
    node = root / "bin" / "node"
    node.write_text("#!/bin/sh\n")
    node.chmod(0o755)
    (root / "server.toml").write_text(f'name = "clickup"\ncommand = "bin/node"\nargs = ["dist/index.js"]\n{extra}')
    return root


def test_node_permission_flags_one_per_path(tmp_path):
    root = _node_cfg(tmp_path)
    data = tmp_path / "data"
    cmd, args, env, cwd, _ = H.prepare(H.load_server(root / "server.toml"), data, {})
    svc = str(data / "mcp" / "clickup")
    assert args == ["--permission", f"--allow-fs-read={root.resolve()}", f"--allow-fs-read={svc}",
                    f"--allow-fs-write={svc}", "dist/index.js"] and env["HOME"] == svc


def test_node_permission_false_refused(tmp_path):
    root = _node_cfg(tmp_path)
    (root / "server.toml").write_text('name = "clickup"\ncommand = "bin/node"\nnode_permission = false\n')
    with pytest.raises(H.ServerConfigError, match="node_permission_required"):
        H.load_server(root / "server.toml")


@pytest.mark.skipif(not shutil.which("node"), reason="node not installed")
def test_node_permission_effect_with_real_node(tmp_path):
    root = tmp_path / "mcp" / "clickup"
    root.mkdir(parents=True)
    node = shutil.which("node")
    (root / "server.toml").write_text(f'name = "clickup"\ncommand = "{node}"\n')
    data = tmp_path / "data"
    (root / "pkg.txt").write_text("ok")
    (tmp_path / ".env.local").write_text("secret")
    (data / "mcp" / "clickup").mkdir(parents=True)
    (data / "other.db").write_text("db")
    cfg = H.load_server(root / "server.toml")
    cmd, args, env, cwd, _ = H.prepare(cfg, data, {})

    def read(path):
        js = f"require('fs').readFileSync(process.argv[1]); console.log('READ')"
        return subprocess.run([cmd, *args, "-e", js, str(path)], capture_output=True, text=True, env=env, cwd=cwd)
    assert "READ" in read(root / "pkg.txt").stdout
    assert read(tmp_path / ".env.local").returncode != 0
    r = read(data / "other.db")
    assert r.returncode != 0 and "ERR_ACCESS_DENIED" in r.stderr


def _pin_cfg(tmp_path, pin_hash):
    root = tmp_path / "mcp" / "github"
    (root / "bin").mkdir(parents=True)
    b = root / "bin" / "srv"
    b.write_bytes(b"binary")
    b.chmod(0o755)
    (root / "server.toml").write_text('name = "github"\ncommand = "bin/srv"\n[pin]\nsha256 = { %s = "%s" }\n'
                                      'binary_sha256 = { %s = "%s" }\n' % (H._platform_key(), "0" * 64, H._platform_key(), pin_hash))
    return H.load_server(root / "server.toml")


def test_binary_pin_match_and_mismatch(tmp_path):
    good = hashlib.sha256(b"binary").hexdigest()
    H.prepare(_pin_cfg(tmp_path / "ok", good), tmp_path / "data", {})
    for i, bad in enumerate(("1" * 64, "PENDING", "")):
        with pytest.raises(H.NotConfigured, match="pin_mismatch"):
            H.prepare(_pin_cfg(tmp_path / str(i), bad), tmp_path / "data", {})


# ---- G040-08 elicitation, sampling
async def test_elicitation_only_during_exclusive_replay_and_sampling_refused(tmp_path, hashes):
    h = await up(tmp_path, hashes, elicits=("elicit_confirm",))
    try:
        args = {"owner": "org", "repo": "r1"}
        assert await h.call("fake", "elicit_confirm", args) == (True, "elicit:decline:None")
        assert await h.call("fake", "elicit_confirm", args, replay=True) == (True, "elicit:accept:org/r1")
        ok, text = await h.call("fake", "sample", {})
        assert ok and text.startswith("sampling:refused")
        # an exclusive replay waits for an in-flight call
        slow = asyncio.create_task(h.call("fake", "slow", {"s": 1.5}))
        await asyncio.sleep(0.4)
        t = time.monotonic()
        await h.call("fake", "elicit_confirm", args, replay=True)
        assert time.monotonic() - t >= 0.8
        await slow
    finally:
        await h.stop()


async def test_elicit_callback_rules():
    s = SimpleNamespace(elicit_target="org/r1")
    h = H.McpHost(".", ".", Log())

    def p(msg, props):
        return SimpleNamespace(mode="form", message=msg,
                               requestedSchema={"properties": props, "required": list(props)})
    one = {"c": {"type": "string"}}
    assert (await h._elicit(s, None, p("type org/r1", one))).action == "accept"
    assert (await h._elicit(s, None, p("type org/other", one))).action == "decline"
    assert (await h._elicit(s, None, p("org/r1", {"a": {"type": "string"}, "b": {"type": "string"}}))).action == "decline"
    assert (await h._elicit(s, None, p("org/r1", {"a": {"type": "boolean"}}))).action == "decline"
    s.elicit_target = None
    assert (await h._elicit(s, None, p("org/r1", one))).action == "decline"


# ---- python -m core.mcp
def test_cli_dump_and_google_auth(tmp_path, monkeypatch, capsys):
    from core.mcp import __main__ as M
    write_cfg(tmp_path / "mcp", name="fake")
    write_cfg(tmp_path / "mcp", name="google")
    monkeypatch.setattr(M, "PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(M, "_env", lambda: {"MCP_FAKE_TOKEN": SECRET, "MCP_GOOGLE_TOKEN": SECRET, "USER": "u",
                                            "DATABASE_PATH": str(tmp_path / "data" / "x.db")})
    assert M.main(["dump", "fake"]) == 0
    rows = [r.split("\t") for r in capsys.readouterr().out.splitlines()]
    assert ["read_echo", "mcp_fake_read_echo"] == rows[[r[0] for r in rows].index("read_echo")][:2]
    assert all(len(r[2]) == 64 for r in rows) and SECRET not in capsys.readouterr().out
    assert M.main(["dump", "missing"]) == 1
    creds = tmp_path / "data" / "mcp" / "google" / "credentials"
    H.ensure_dirs(tmp_path / "data", "google")
    creds.mkdir(mode=0o700)
    (creds / "t.json").write_text("{}")
    os.chmod(creds / "t.json", 0o644)
    assert M.main(["google-auth"]) == 0          # fake server exits on stdin EOF; modes are fixed afterwards
    assert stat.S_IMODE((creds / "t.json").stat().st_mode) == 0o600 and stat.S_IMODE(creds.stat().st_mode) == 0o700
    assert M.main([]) == 2


def test_sdk_root_logger_records_dropped(caplog):  # G2T040-09
    import logging
    import mcp.shared.session as sess
    H.McpHost(".", ".", Log())
    root = logging.getLogger()
    rec = lambda path: logging.LogRecord("root", logging.WARNING, path, 1, "m", None, None)
    assert not all(f(rec(sess.__file__)) for f in root.filters if getattr(f, "_mcp_pin", False))
    assert all(f(rec(__file__)) for f in root.filters if getattr(f, "_mcp_pin", False))
