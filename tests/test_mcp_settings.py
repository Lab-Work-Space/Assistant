"""TASK-040 MCP-05: mcp.* settings keys (spec 3.12)."""
import pytest

from core.settings.service import KEYS, SettingsError
from tests.test_settings import svc


@pytest.mark.parametrize("key,raw,out", [
    ("mcp.calls_per_min", "1", "1"), ("mcp.calls_per_min", "120", "120"), ("mcp.writes_per_min", "60", "60"),
    ("mcp.calls_per_day", "10", "10"), ("mcp.calls_per_day", "5,000", "5000"), ("mcp.enabled", "OFF", "off"),
])
def test_valid(db, key, raw, out):
    assert svc(db).validate(key, raw) == out


@pytest.mark.parametrize("key,raw", [
    ("mcp.calls_per_min", "0"), ("mcp.calls_per_min", "121"), ("mcp.writes_per_min", "61"),
    ("mcp.calls_per_day", "9"), ("mcp.calls_per_day", "5001"), ("mcp.enabled", "maybe"), ("mcp.enabled", ""),
])
def test_invalid(db, key, raw):
    with pytest.raises(SettingsError):
        svc(db).validate(key, raw)


async def test_seeds_and_kill_switch(db):
    s = svc(db)
    assert [await s.get(k) for k in ("mcp.calls_per_min", "mcp.writes_per_min", "mcp.calls_per_day", "mcp.enabled")] == ["20", "6", "500", "on"]
    assert await s.mcp_enabled()
    await s.set("mcp.enabled", "off", "cli:test")
    assert not await s.mcp_enabled()
    assert all(k in KEYS for k in ("mcp.enabled", "mcp.calls_per_day"))
