"""TASK-040 MCP-06 / AT-13: /mcp status gating and output against a fake host."""
import types

from core.discord import commands as K, mcp_commands as MC
from tests.test_discord_commands import APPROVER, STRANGER, inter, said, w  # noqa: F401
from tests.test_growth_commands import ok

ROWS = [{"service": "github", "state": "running", "active": 47, "blocked": 2, "restarts": 0, "unclassified": ["a", "b"]},
        {"service": "clickup", "state": "failed", "active": 0, "blocked": 0, "restarts": 3, "unclassified": []}]


class Host:
    def __init__(self):
        self.calls = 0

    def status(self):
        self.calls += 1
        return ROWS


async def test_gate_refuses_without_host_access(w):
    h = w.app.ctx.mcp = Host()
    i = inter(w, APPROVER)
    await MC.mcp_status(w.app, i)
    assert said(i) == K._SETTING_ERR["wrong_channel"]
    i = ok(w)
    i.user.id = STRANGER
    await MC.mcp_status(w.app, i)
    assert said(i) == K._SETTING_ERR["not_approver"]
    assert h.calls == 0


async def test_status_lines_via_gateway_attr_and_ephemeral(w):
    await w.app.ctx.db.execute("INSERT INTO audit_log (scope, ref, action, actor) VALUES ('mcp','github:x','call','agent:t')")
    w.app.ctx.mcp = types.SimpleNamespace(host=Host())
    i = ok(w)
    await MC.mcp_status(w.app, i)
    out = said(i)
    assert out.splitlines()[0] == "github: running | tools 47 active, 2 blocked | restarts 0 | calls 24h 1 | unclassified: a, b"
    assert out.splitlines()[1] == "clickup: failed | tools 0 active, 0 blocked | restarts 3 | calls 24h 0"
    assert i.response.said[0][1] is True


async def test_unavailable(w):
    for m in (None, types.SimpleNamespace(status=lambda: [])):
        w.app.ctx.mcp = m
        i = ok(w)
        await MC.mcp_status(w.app, i)
        assert said(i) == MC._UNAVAILABLE
