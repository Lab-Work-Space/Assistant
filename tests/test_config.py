import os
import subprocess
import sys
import types

import pytest

from core import config as C
from core.functions.logs import logsystem, masking
from tests.conftest import base_env


def load(tmp_path, **over):
    e = base_env(tmp_path)
    e.update(over)
    return C.Config.load({k: v for k, v in e.items() if v is not None})


def code(tmp_path, **over):
    with pytest.raises(C.ConfigError) as ei:
        load(tmp_path, **over)
    return ei.value.code


def test_defaults_and_secrets_not_in_repr(tmp_path):
    c = load(tmp_path, DISCORD_BOT_TOKEN="T" * 30)
    assert c.default_agent_id == "praw" and c.knowledge_meetings_retention_days == 90 and c.tasks_retention_days == 180
    assert "TTTT" not in repr(c) and "pw-pw" not in repr(c) and not hasattr(c, "emp_cli_dev")
    assert "T" * 30 not in masking.mask_secrets("x " + "T" * 30)  # exact set installed


def test_token_optional_and_empty_is_unset(tmp_path):
    assert load(tmp_path, DISCORD_BOT_TOKEN="").discord_bot_token is None
    assert code(tmp_path, DISCORD_GUILD_ID="") == "missing:DISCORD_GUILD_ID"


@pytest.mark.parametrize("name", ["DISCORD_BOT_TOKEN", "ANTHROPIC_API_KEY", "GOOGLE_API_TOKEN"])
def test_short_secret_refused(tmp_path, name):
    assert code(tmp_path, **{name: "short"}) == f"secret_too_short:{name}"
    load(tmp_path, **{name: "x" * 12})


@pytest.mark.parametrize("over,err", [
    ({"STREAM_EDIT_INTERVAL_S": "0.5"}, "bounds:STREAM_EDIT_INTERVAL_S"),
    ({"BRAINSTORM_TURN_LIMIT": "51"}, "bounds:BRAINSTORM_TURN_LIMIT"),
    ({"BRAINSTORM_TURN_LIMIT": "0"}, "bounds:BRAINSTORM_TURN_LIMIT"),
    ({"BRAINSTORM_TOKEN_BUDGET": "1599"}, "bounds:BRAINSTORM_TOKEN_BUDGET"),
    ({"JOB_DEFAULT_TIMEOUT_S": "3601"}, "bounds:JOB_DEFAULT_TIMEOUT_S"),
    ({"REPLY_TIER2_TIMEOUT_S": "10"}, "bounds:REPLY_TIER2_TIMEOUT_S"),
    ({"PROVIDER_IDLE_TIMEOUT_S": "180"}, "bounds:PROVIDER_IDLE_TIMEOUT_S"),
    ({"REPLY_ACTIVE_WINDOW_S": "29"}, "bounds:REPLY_ACTIVE_WINDOW_S"),
    ({"STREAM_MAX_MESSAGES": "1"}, "bounds:STREAM_MAX_MESSAGES"),
    ({"BUDGET_GATE_DAILY_USD": "0"}, "bounds:BUDGET"),
    ({"KNOWLEDGE_MEETINGS_RETENTION_DAYS": "0"}, "bounds:KNOWLEDGE_MEETINGS_RETENTION_DAYS"),
    ({"KNOWLEDGE_MEETINGS_RETENTION_DAYS": "3651"}, "bounds:KNOWLEDGE_MEETINGS_RETENTION_DAYS"),
    ({"TASKS_RETENTION_DAYS": "0"}, "bounds:TASKS_RETENTION_DAYS"),
    ({"TASKS_RETENTION_DAYS": "3651"}, "bounds:TASKS_RETENTION_DAYS"),
    ({"TASKS_RETENTION_DAYS": "abc"}, "invalid:TASKS_RETENTION_DAYS"),
])
def test_refusals(tmp_path, over, err):
    assert code(tmp_path, **over) == err


def test_retention_edges_ok(tmp_path):
    c = load(tmp_path, KNOWLEDGE_MEETINGS_RETENTION_DAYS="1", TASKS_RETENTION_DAYS="3650")
    assert (c.knowledge_meetings_retention_days, c.tasks_retention_days) == (1, 3650)


def test_voice_tmp_dir(tmp_path):
    assert code(tmp_path, VOICE_TMP_DIR="relative/x") == "voice_tmp_dir_invalid"
    assert code(tmp_path, VOICE_TMP_DIR="/") == "voice_tmp_dir_invalid"
    assert code(tmp_path, VOICE_TMP_DIR=str(C.PROJECT_ROOT / "v")) == "voice_tmp_dir_invalid"
    assert code(tmp_path, VOICE_TMP_DIR=str(tmp_path / "k" / "v")) == "voice_tmp_dir_invalid"
    real = tmp_path / "real"
    real.mkdir()
    (tmp_path / "ln").symlink_to(real)
    assert code(tmp_path, VOICE_TMP_DIR=str(tmp_path / "ln")) == "voice_tmp_dir_invalid"
    loose = tmp_path / "loose"
    loose.mkdir(mode=0o755)
    os.chmod(loose, 0o755)
    assert code(tmp_path, VOICE_TMP_DIR=str(loose)) == "voice_tmp_dir_invalid"
    load(tmp_path)
    assert oct(os.stat(tmp_path / "voice").st_mode & 0o777) == "0o700"
    (tmp_path / "pl").mkdir()
    (tmp_path / "pl" / "sub").symlink_to(real)  # symlinked parent is allowed
    load(tmp_path, VOICE_TMP_DIR=str(tmp_path / "pl" / "sub" / "v"))


def test_cli_dev(monkeypatch):
    cfg = type("C", (), {"discord_bot_token": None})()
    monkeypatch.delenv("EMP_CLI_DEV", raising=False)
    monkeypatch.delenv("DISCORD_BOT_TOKEN", raising=False)
    assert not C.cli_dev_env() and not C.cli_dev_allowed(cfg)
    monkeypatch.setenv("EMP_CLI_DEV", "1")
    assert C.cli_dev_env() and C.cli_dev_allowed(cfg)
    assert not C.cli_dev_allowed(type("C", (), {"discord_bot_token": "x"})())
    monkeypatch.setenv("DISCORD_BOT_TOKEN", "x")
    assert not C.cli_dev_env() and not C.cli_dev_allowed(cfg)
    monkeypatch.setenv("EMP_CLI_DEV", "true")
    monkeypatch.delenv("DISCORD_BOT_TOKEN")
    assert not C.cli_dev_env()


def test_rc3_env_file_never_touches_os_environ(tmp_path, monkeypatch):
    monkeypatch.delenv("LOG_LEVEL", raising=False)
    f = tmp_path / "e"
    f.write_text("# c\nLOG_LEVEL=DEBUG\nexport EMP_CLI_DEV=1\nTASKS_RETENTION_DAYS='5'\n")
    before = dict(os.environ)
    m = C.parse_env_file(f)
    c = C.Config.load({**base_env(tmp_path), **m})
    assert dict(os.environ) == before and c.log_level == "DEBUG" and c.tasks_retention_days == 5
    assert not logsystem.debug_bodies()  # file value does not enable body logging
    monkeypatch.setenv("LOG_LEVEL", "DEBUG")
    assert logsystem.debug_bodies()


def test_cli_dev_refused_as_service_user(monkeypatch):
    """S11-11: EMP_CLI_DEV must never enable the dev CLI when running as the `employee` service user."""
    import pwd
    monkeypatch.setenv("EMP_CLI_DEV", "1")
    monkeypatch.delenv("DISCORD_BOT_TOKEN", raising=False)
    assert C.cli_dev_env() is True or pwd.getpwuid(os.geteuid()).pw_name == "employee"
    monkeypatch.setattr(pwd, "getpwuid", lambda uid: types.SimpleNamespace(pw_name="employee"))
    assert C.cli_dev_env() is False


def test_database_path_required_and_under_knowledge_dir_refused(tmp_path):
    assert code(tmp_path, DATABASE_PATH=None) == "missing:DATABASE_PATH"
    assert code(tmp_path, DATABASE_PATH=str(tmp_path / "k" / "emp.db")) == "db_path_invalid"
    assert "emp.db" in repr(load(tmp_path))  # not a secret


def test_memory_max_check(tmp_path, monkeypatch):
    (tmp_path / "cg").write_text("0::/x\n")
    (tmp_path / "x").mkdir()
    mm = tmp_path / "x" / "memory.max"
    monkeypatch.setattr(C, "CGROUP_FILE", str(tmp_path / "cg"))
    monkeypatch.setattr(C, "CGROUP_ROOT", str(tmp_path))
    mm.write_text("1073741824\n")
    assert code(tmp_path) == "bounds:MEMORY_MAX"
    mm.write_text("max\n")
    load(tmp_path)
