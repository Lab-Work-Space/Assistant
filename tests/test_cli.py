"""CLI harness (TASK-025). Sink tests run anywhere; end-to-end runs use a temp migrated SQLite file."""
import os
import stat
import subprocess
import sys
import types
from pathlib import Path

import pytest

from core.cli.fakes import card_fields
from core.cli.__main__ import amain
from core.cli.sink import CliReplySink, Out
from core.functions.logs import masking
from core.interfaces import StreamEvent, ToolCall, Usage
from tests.conftest import base_env, make_db_path

SMOKE = str(Path(__file__).parent / "fixtures" / "cli_smoke.txt")


class _Embed:
    def __init__(self, title="", description="", colour=0):
        self.title, self.description, self.fields = title, description, []

    def add_field(self, name, value, inline=True):
        self.fields.append(types.SimpleNamespace(name=name, value=value))


class FakeProv:
    """Deterministic provider: no network."""
    name = "fake"

    async def stream(self, *, model, system, messages, tools, **kw):
        last, first = messages[-1], messages[0].content
        if last.role != "tool" and "delegate this task to" in first:
            who = first.split("delegate this task to ")[1].split()[0]
            yield StreamEvent("tool_call", tool_call=ToolCall("c1", "task_create", {"assignee_agent_id": who, "title": "t", "description": "Do the thing described here.", "priority": "low", "due": card_fields()["due"], "value_thb": 1}))
        elif last.role != "tool" and "NEEDAPPROVAL" in first:
            yield StreamEvent("tool_call", tool_call=ToolCall("c2", "approval_request", {"title": "Use tool X", "summary": "Use tool X to finish the task.", "reason": "needed", "value_thb": 1, "priority": "low", "due": card_fields()["due"]}))
        else:
            for t in (["Thanks, approval received"] if "was approved" in first else ["reply from ", f"{model}\n"]):
                yield StreamEvent("text", text=t)
        yield StreamEvent("usage", usage=Usage(5, 5))
        yield StreamEvent("done", stop_reason="end")


def _env(tmp_path):
    (tmp_path / "k").mkdir(exist_ok=True)
    make_db_path(tmp_path)
    return {**base_env(tmp_path), "LOG_DIR": str(tmp_path / "logs"), "BRAINSTORM_TURN_LIMIT": "1"}


def test_sink_strips_control_and_masks_split_token(capsys):
    masking.set_exact(["supersecretvalue123"])
    out = Out()
    s = CliReplySink(out, "")

    async def go():
        await s.start()
        await s.write("a\x1b[31mred\x1b[0m super")
        await s.write("secretvalue123 end\n")
        await s.finish()
    import asyncio
    asyncio.run(go())
    text = capsys.readouterr().out
    assert "\x1b" not in text and "supersecretvalue123" not in text and "***" in text


def test_send_file_excl_and_mode():
    import asyncio
    out = Out()
    s = CliReplySink(out, "")
    asyncio.run(s.send_file("../evil name.txt", b"x"))
    (f,) = Path(out.tmp_dir()).iterdir()
    assert f.name.startswith("file-") and stat.S_IMODE(f.stat().st_mode) == 0o600
    asyncio.run(s.send_file("a.txt", b"1"))
    with pytest.raises(FileExistsError):
        asyncio.run(s.send_file("a.txt", b"2"))


def test_core_does_not_import_cli():
    code = "import sys, core.core, core.extensions; assert not any(m.startswith('core.cli') for m in sys.modules)"
    assert subprocess.run([sys.executable, "-c", code], cwd=Path(__file__).parent.parent).returncode == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("flag,token", [(None, None), ("1", "x" * 30)])
async def test_admin_without_dev_gate_exits_2(tmp_path, monkeypatch, flag, token):
    monkeypatch.delenv("EMP_CLI_DEV", raising=False)
    monkeypatch.delenv("DISCORD_BOT_TOKEN", raising=False)
    if flag:
        monkeypatch.setenv("EMP_CLI_DEV", flag)
        monkeypatch.setenv("DISCORD_BOT_TOKEN", token)
    env = base_env(tmp_path)
    assert await amain(["--as", "admin"], env=env) == 2


@pytest.mark.asyncio
async def test_scripted_end_to_end(tmp_path, monkeypatch, capsys):
    monkeypatch.setitem(sys.modules, "discord", types.SimpleNamespace(Embed=_Embed))
    monkeypatch.setenv("EMP_CLI_DEV", "1")
    monkeypatch.delenv("DISCORD_BOT_TOKEN", raising=False)
    monkeypatch.chdir(tmp_path)
    rc = await amain(["--as", "user", "--script", SMOKE], providers={"google": FakeProv(), "anthropic": FakeProv()},
                     env=_env(tmp_path))
    out = capsys.readouterr().out
    assert rc == 0, out
    assert "expect FAIL" not in out


@pytest.mark.asyncio
async def test_failed_expectation_exits_1(tmp_path, monkeypatch):
    monkeypatch.setitem(sys.modules, "discord", types.SimpleNamespace(Embed=_Embed))
    monkeypatch.setenv("EMP_CLI_DEV", "1")
    monkeypatch.delenv("DISCORD_BOT_TOKEN", raising=False)
    monkeypatch.chdir(tmp_path)
    f = tmp_path / "s.txt"
    f.write_text("hello\n/expect will-never-match\n")
    assert await amain(["--script", str(f)], providers={"google": FakeProv(), "anthropic": FakeProv()},
                       env=_env(tmp_path)) == 1


@pytest.mark.asyncio
async def test_approval_wake_uses_origin_channel_sink():
    from core.approvals.service import make_generic_handler
    seen = {}

    class Eng:
        async def run(self, req): seen["sink"] = req.sink

    sinks = types.SimpleNamespace(for_channel=lambda ch, p: ("sink", ch, p))
    ctx = types.SimpleNamespace(engine=Eng(), config=types.SimpleNamespace(discord_guild_id=1), sinks=sinks,
                                personas=types.SimpleNamespace(get=lambda i: "P"), bot=None)
    await make_generic_handler(ctx)({"requested_by": "praw", "status": "approved", "origin": "cli", "origin_channel_id": 1001,
                                     "origin_thread_id": None, "title": "t", "decided_by": "cli:admin"})
    assert seen["sink"] == ("sink", 1001, "P")


@pytest.mark.asyncio
async def test_fake_mode_no_keys(tmp_path, monkeypatch, capsys):
    monkeypatch.setitem(sys.modules, "discord", types.SimpleNamespace(Embed=_Embed))
    monkeypatch.setenv("EMP_CLI_DEV", "1")
    for k in ("DISCORD_BOT_TOKEN", "ANTHROPIC_API_KEY", "GOOGLE_API_TOKEN"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.chdir(tmp_path)
    e = _env(tmp_path)
    env = {k: e[k] for k in ("DATABASE_PATH", "KNOWLEDGE_DIR", "VOICE_TMP_DIR", "LOG_DIR", "BRAINSTORM_TURN_LIMIT")}
    f = tmp_path / "s.txt"
    f.write_text("/agent praw\nhello\n/expect \\[praw\\] \\[fake\\] reply from\n/delegate anan write it\n"
                 "/expect Assignee: anan\n/wait-idle 30\nNEEDAPPROVAL x\n/approve last\n"
                 "/expect approved decided_by=cli:admin\n/wait-idle 30\n/expect \\[fake\\] Thanks, approval received\n")
    rc = await amain(["--as", "admin", "--fake", "--script", str(f)], env=env)
    out = capsys.readouterr().out
    assert rc == 0 and "expect FAIL" not in out, out


@pytest.mark.parametrize("fake", [True, False])
def test_fake_refused_without_dev_flag(tmp_path, monkeypatch, fake):
    monkeypatch.delenv("EMP_CLI_DEV", raising=False)
    monkeypatch.chdir(tmp_path)
    import asyncio
    assert asyncio.run(amain(["--fake"] if fake else [], env=_env(tmp_path))) == 2


def test_dev_local_script_syntax():
    p = str(Path(__file__).parents[1] / "scripts" / "dev-local.sh")
    assert subprocess.run(["bash", "-n", p]).returncode == 0
    import shutil
    if shutil.which("shellcheck"):
        assert subprocess.run(["shellcheck", p]).returncode == 0


def test_dev_local_unsets_discord_tokens(tmp_path):
    """12.13: .env.local may hold Discord tokens; the CLI must still start without them in its env."""
    import os
    import shutil
    root = tmp_path / "r"
    (root / "scripts").mkdir(parents=True)
    (root / "knowledge").mkdir()
    (root / ".venv" / "bin").mkdir(parents=True)
    shutil.copy(Path(__file__).parents[1] / "scripts" / "dev-local.sh", root / "scripts")
    names = "DISCORD_GUILD_ID APPROVAL_CHANNEL_ID ADMIN_NOTIFY_CHANNEL_ID TASKS_CHANNEL_ID DEFAULT_CHEAP_MODEL " \
            "REPLY_TIER2_MODEL IMAGE_MODEL TTS_MODEL TTS_VOICE STT_PROVIDER STT_MODEL".split()
    (root / ".env.local").write_text(
        "".join(f"{n}=x\n" for n in names)
        + "ANTHROPIC_API_KEY=k\nDISCORD_BOT_TOKEN=t0\nDISCORD_BOT_TOKEN_PRAW=t1\nDISCORD_APP_ID_PRAW=1\n"
          "DATABASE_PATH=\nLOG_DIR=\n")
    py = root / ".venv" / "bin" / "python"
    py.write_text('#!/usr/bin/env bash\n[ "$1 $2" = "-m core.migration" ] && exit 0\n'
                  'env | grep -E "^(DISCORD_BOT_TOKEN|DISCORD_APP_ID_)" ; echo "DEV=$EMP_CLI_DEV DB=$DATABASE_PATH"\n')
    py.chmod(0o755)
    r = subprocess.run(["bash", str(root / "scripts" / "dev-local.sh")], capture_output=True, text=True, timeout=30,
                       env={"PATH": os.environ["PATH"], "HOME": str(tmp_path), "EMP_DEV_DIR": str(tmp_path / "d")})
    assert r.returncode == 0, r.stderr
    assert "DISCORD" not in r.stdout and f"DEV=1 DB={tmp_path}/d/db/emp.db" in r.stdout
