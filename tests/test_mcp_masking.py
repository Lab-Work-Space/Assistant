"""TASK-040 MCP-05: token shapes, card fidelity (G040-07), mcp logger (G040-10), syslog keys (spec 3.8)."""
import json
import logging

import pytest

from core.discord import syslog as S
from core.functions.logs import logsystem, masking
from core.functions.logs.masking import mask_secrets as M

TOKENS = [
    "ghp_" + "A1b2" * 9, "gho_" + "Z" * 36, "github_pat_" + "a1_" * 10, "pk_12345678_" + "A1B2C3D4E5" * 2,
    "GOCSPX-" + "ab_-" * 6, "1//" + "0gAbC_-" * 5,
    "-----BEGIN PRIVATE KEY-----\nMIIabc\ndef\n-----END PRIVATE KEY-----",
    "-----BEGIN RSA PRIVATE KEY-----\nxx\n-----END RSA PRIVATE KEY-----",
]


@pytest.mark.parametrize("t", TOKENS)
def test_token_shapes_masked(t):
    out = M(f"x {t} y")
    assert out == "x *** y" and M(out) == out


def test_card_fidelity_plain_args_unchanged():  # G040-07: args_unreviewable compares mask(x) != x
    canon = json.dumps({"owner": "acme", "repo": "site", "title": "Fix pk_1 and ghp_short", "path": "a/b.py"}, sort_keys=True)
    assert M(canon) == canon


def test_card_fidelity_token_arg_changes():
    canon = json.dumps({"body": "ghp_" + "x" * 36})
    assert M(canon) != canon


def test_mcp_logger_pinned_and_debug_args_absent(tmp_path, capsys):  # AT-12
    assert "mcp" in logsystem.LIBRARY_LOGGERS
    lg = logsystem.Log(str(tmp_path / "app.jsonl"))
    h = logsystem.install_logging(lg, "DEBUG")
    try:
        logging.getLogger("mcp.client").debug("rpc %s", "SENTINEL_ARG_123")
        logging.getLogger("mcp.client").warning("w")
        capsys.readouterr()
        txt = (tmp_path / "app.jsonl").read_text()
        assert "SENTINEL_ARG_123" not in txt
    finally:
        logging.getLogger().removeHandler(h)


def test_syslog_forwards_service_and_tool():
    assert {"service", "tool"} <= S.FORWARD_KEYS
    line = json.dumps({"ts": "2026-11-24T10:11:12+00:00", "level": "WARNING", "system": "mcp", "event": "mcp.call",
                       "fields": {"service": "github", "tool": "mcp_github_x", "args": "SECRET_ARGS"}})
    _, text = S.format_line("WARNING", line)
    assert "service=github" in text and "tool=mcp_github_x" in text and "SECRET_ARGS" not in text
