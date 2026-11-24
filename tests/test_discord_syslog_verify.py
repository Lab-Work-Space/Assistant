"""TASK-030 independent verification (tester). Adversarial probes on the System log path. Fakes only."""
import asyncio
import json
import threading
import time

import pytest

from core.discord import syslog as S
from core.functions.logs import masking
from core.functions.logs.logsystem import Log
from tests.test_discord_layer import world
from tests.test_discord_syslog import DISCORD_TOKEN, TOK_SYSTEM, posted, rec, sys_ready

CFG_SECRET = "cfg-secret-value-0123456789-abcdefghij"
LONG_SECRET = "Z9" * 60  # 120 chars, longer than VALUE_MAX


@pytest.fixture(autouse=True)
def _reset_masking():
    masking.set_exact([CFG_SECRET, LONG_SECRET, TOK_SYSTEM])
    yield
    masking.set_exact([])


async def test_v1_real_log_pipeline_never_leaks(tmp_path):
    w = world(tmp_path, system=True)
    masking.set_exact([CFG_SECRET, LONG_SECRET, TOK_SYSTEM])  # Config.load in world() resets the exact list
    await sys_ready(w)
    log = Log(str(tmp_path / "a.jsonl"), stdout=False)
    w.app.forwarder.log = log
    log.tap = w.app.forwarder.offer
    nasty = ("x\r\ny ```@everyone``` <@&123456789012345678> <@987654321098765432> " + CFG_SECRET + " " + DISCORD_TOKEN
             + " Bearer abc.def.ghi " + LONG_SECRET)
    for i, key in enumerate(["error", "reason", "code", "by", "kind", "task", "model", "persona"]):
        log.write_log("core", f"ev{i}", "WARNING", **{key: nasty})
    log.write_log("core", "ev.secret_in_event_" + CFG_SECRET, "ERROR", error="x")   # secret in event name
    log.write_log("sys_" + DISCORD_TOKEN, "evx", "CRITICAL", error="x")             # token-shaped system name
    await asyncio.sleep(0.2)
    assert posted(w)
    for m in w.sysch.sent:
        c = m.content
        for bad in (CFG_SECRET, DISCORD_TOKEN, LONG_SECRET, LONG_SECRET[:40], TOK_SYSTEM, "abc.def.ghi"):
            assert bad not in c, bad
        assert len(c) <= 2000 and c.startswith("```text\n") and c.endswith("\n```") and "`" not in c[7:-4]
        assert "\r" not in c
        assert all(l.startswith("02:") or l.startswith("0") or l.startswith("1") or l.startswith("2") for l in c[8:-4].split("\n"))  # no injected line
        assert m.mentions.everyone is False and m.mentions.roles is False and m.mentions.users is False
    await w.app.shutdown()


def test_v2_burst_memory_bounded():
    f = S.Forwarder(types_log := type("L", (), {"write_log": lambda *a, **k: None})())
    t = [0.0]
    f.clock = lambda: t[0]
    for i in range(60000):  # unique keys: queue and maps must stay bounded
        f.offer(*rec(event=f"e{i}"))
    assert len(f._q) <= S.QUEUE_MAX and len(f._last) <= S.MAP_MAX + 1 and len(f._supp) <= S.MAP_MAX + 1
    for _ in range(60000):  # same key: only the counter grows
        f.offer(*rec(event="same"))
    assert len(f._q) <= S.QUEUE_MAX and len(f._supp) <= S.MAP_MAX + 1


def test_v3_take_respects_caps_and_drains_every_line_intact():
    f = S.Forwarder(type("L", (), {"write_log": lambda *a, **k: None})())
    for i in range(200):
        f.offer(*rec(event=f"e{i}", error="E" * 200, user="u" * 200, reason="r" * 200))
    lens, lines = 0, 0
    while (b := f.take()) is not None:
        assert len(b) <= 1900, len(b)
        lens += 1
        lines += b.count("\n") - 1
    assert lines == 200 and lens > 1


def test_v4_offer_never_raises_on_hostile_lines():
    f = S.Forwarder(type("L", (), {"write_log": lambda *a, **k: None})())
    for bad in ["", "not json", "[]", "null", "5", '{"event": ["x"]}', '{"system": {"a":1}}', '{"fields": [1]}',
                '{"ts": 5, "fields": {"error": 1e999}}', '{"fields": {"error": {"a": 1}}}', '{"ts":"x","fields":{"count":NaN}}']:
        f.offer("WARNING", bad)
    f.offer("WARNING", '{"ts":"2026-11-24T10:11:12+00:00","system":"s","event":"e","fields":{"error":true,"count":null}}')
    assert len(f._q) >= 1


def test_v5_dedup_boundary_and_suffix():
    f = S.Forwarder(type("L", (), {"write_log": lambda *a, **k: None})())
    t = [0.0]
    f.clock = lambda: t[0]
    for _ in range(10):
        f.offer(*rec())
    t[0] = 59.9
    f.offer(*rec())
    assert len(f._q) == 1
    t[0] = 60.0
    f.offer(*rec())
    assert len(f._q) == 2 and f._q[1].endswith("(+10)")


async def test_v6_system_absent_zero_praw_posts(tmp_path):
    w = world(tmp_path, system=False)
    assert w.app.system is None and w.app.system_channel is None
    await w.app._admin_line("online: x")
    await w.app._admin_line("persona_disabled:tek")
    assert not w.ch["admin"].sent and not w.ch["appr"].sent and not w.ch["tasks"].sent
    assert [e["text"] for e in w.log.events("admin.line")] == ["online: x", "persona_disabled:tek"]
    from core.discord.notifier import make_notifier
    with pytest.raises(RuntimeError, match="notify_unavailable"):
        await make_notifier(w.app)("tek", "warn", 1, 2)
    assert not w.ch["admin"].sent
