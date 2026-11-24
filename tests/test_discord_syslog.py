"""TASK-030 / spec 12.14 System log bot: acceptance A1-A8 and Gate 1 conditions S1214-01..05. Fakes only."""
import asyncio
import json
import threading
import time
import types

import discord
import pytest

from core.__main__ import amain
from core.config import Config, ConfigError
from core.discord import client as C
from core.discord import syslog as S
from core.discord.allowlist import refuse
from core.discord.sinks import DiscordSinkFactory
from core.discord.threads import DiscordThreadPort
from core.functions.logs import masking
from core.functions.logs.logsystem import Log
from core.interfaces import TargetError
from tests.discord_fakes import (ADMIN, ALLOWED, G, HUMAN, OTHER, SYS_UID, TOK_PRAW, TOK_SYSTEM, TOK_TEK, Bot, Channel, Guild,
                                 persona)
from tests.test_discord_layer import CAT, denv, fake_env, world

DISCORD_TOKEN = "MTIzNDU2Nzg5MDEyMzQ1Njc4" + ".GabcDE." + "abcdefghijklmnopqrstuvwxyz1"  # regex-shaped, not configured anywhere


def rec(level="WARNING", system="s", event="e", ts="2026-11-24T10:11:12.5+00:00", **fields):
    return level, json.dumps({"ts": ts, "level": level, "system": system, "event": event, "fields": fields})


async def sys_ready(w, flush=0.01):
    w.app.forwarder.flush_s = flush
    await w.app._on_system_ready()()


def posted(w):
    return [m.content for m in w.sysch.sent]


def real_log(w, tmp_path):
    log = Log(str(tmp_path / "app.jsonl"), stdout=False)
    w.app.log = w.app.forwarder.log = log
    log.tap = w.app.forwarder.offer
    return log


# ---- A1 ------------------------------------------------------------------------------------------------
async def test_a1_warning_forwarded_info_and_lib_and_logforward_not(tmp_path):
    w = world(tmp_path, system=True)
    log = real_log(w, tmp_path)
    await sys_ready(w)
    log.write_log("core", "boom.happened", "WARNING", code="x1")
    log.write_log("core", "just.info", "INFO", code="x2")
    log.write_log("discord", "lib.log", "WARNING", msg="library text")
    log.write_log("logforward", "logforward.send_failed", "ERROR", status=500)
    await asyncio.sleep(0.1)
    text = "\n".join(posted(w))
    assert "WARNING core boom.happened code=x1" in text
    assert "just.info" not in text and "library text" not in text and "lib.log" not in text and "logforward" not in text
    assert not w.ch["admin"].sent                                      # never Praw
    await w.app.shutdown()


async def test_tap_runs_after_lock_and_never_breaks_write_log(tmp_path):
    log = Log(str(tmp_path / "a.jsonl"), stdout=False)
    seen = []
    log.tap = lambda lv, line: seen.append((lv, log._lock.locked(), line))
    log.write_log("a", "i", "INFO")
    log.write_log("a", "w", "warning", k=1)
    assert [(s[0], s[1]) for s in seen] == [("WARNING", False)]       # S1214-03: lock released before the tap
    log.tap = lambda lv, line: 1 / 0
    log.write_log("a", "w2", "ERROR")                                  # tap failure never raises
    assert "w2" in (tmp_path / "a.jsonl").read_text()


# ---- A2 + S1214-02 + S1214-05 ----------------------------------------------------------------------------
async def test_a2_posted_text_is_masked_allowlisted_and_inert(tmp_path):
    w = world(tmp_path, system=True)
    await sys_ready(w)
    f = w.app.forwarder
    line = rec(code=TOK_SYSTEM, reason=DISCORD_TOKEN, error="a`b\nc @everyone", note="free text", prompt="x", message="SECRET BODY",
               frames="tb", user=HUMAN, nested={"a": 1})[1]          # raw line: bypasses _render, so only the 2nd mask can stop it
    f.offer("WARNING", line)
    await asyncio.sleep(0.1)
    body = posted(w)[0]
    assert TOK_SYSTEM not in body and DISCORD_TOKEN not in body        # configured secret under a non-secret key + regex-shaped token
    assert "note" not in body and "free text" not in body and "prompt" not in body and "SECRET BODY" not in body
    assert "frames" not in body and "nested" not in body and "message" not in body
    assert f"user={HUMAN}" in body and "a'b c @everyone" in body        # backtick replaced, newline folded
    assert body.startswith("```text\n") and body.endswith("\n```") and "`" not in body[7:-4] and len(body) <= 1900
    assert w.sysch.sent[0].mentions.everyone is False and w.sysch.sent[0].mentions.roles is False
    await w.app.shutdown()


def test_s1214_02_forward_keys_only():
    _, text = S.format_line(*rec(note="free text", prompt="x", reason="ok"))
    assert "note" not in text and "free text" not in text and "prompt" not in text and "reason=ok" in text


def test_masking_failure_line_forwards_minimal():
    _, text = S.format_line("ERROR", json.dumps({"event": "log.masking_failure", "system": "core"}))
    assert text.endswith("Z ERROR core log.masking_failure")


def test_s1214_05_content_cut_to_2000_after_masking():
    f = S.Forwarder(types.SimpleNamespace(write_log=lambda *a, **k: None))
    for i in range(30):
        f.offer(*rec(event=f"e{i}", reason="Bearer x " * 40))          # masking lengthens: "Bearer x" -> "Bearer ***"
    for _ in range(3):
        body = f.take()
        if body:
            assert len(body) <= 2000


def test_s1214_05_dedup_maps_are_capped():
    f = S.Forwarder(types.SimpleNamespace(write_log=lambda *a, **k: None))
    for i in range(S.MAP_MAX * 2 + 5):
        f.offer(*rec(event=f"e{i}"))
    assert len(f._last) <= S.MAP_MAX + 1 and len(f._supp) <= S.MAP_MAX + 1


# ---- A3 ------------------------------------------------------------------------------------------------
async def test_a3_queue_bound_dropped_and_dedup(tmp_path):
    w = world(tmp_path, system=True)
    f = w.app.forwarder
    for i in range(250):                                               # before System is ready: buffered, bounded
        f.offer(*rec(event=f"ev{i}"))
    await sys_ready(w)
    await asyncio.sleep(0.3)
    lines = [ln for b in posted(w) for ln in b.split("\n") if " WARNING " in ln]
    assert len(lines) == 200 and posted(w)[0].split("\n")[1] == "dropped=50" and all(len(b) <= 1900 for b in posted(w))
    t = [100.0]
    f2 = S.Forwarder(types.SimpleNamespace(write_log=lambda *a, **k: None), clock=lambda: t[0])
    for _ in range(10):
        f2.offer(*rec(event="same"))
    assert f2.take().count("same") == 1
    t[0] += 61
    f2.offer(*rec(event="same"))
    assert "same (+9)" in f2.take()
    await w.app.shutdown()


# ---- A4 ------------------------------------------------------------------------------------------------
def _bad_app_id(w): w.sysbot.application_id = 1
def _foreign_guild(w): w.sysbot.guild = None
def _no_channel(w): w.sysbot.guild._ch.clear()
def _category(w): w.sysch.type = discord.ChannelType.category
def _no_access(w): w.sysch.denied.add(SYS_UID)
def _admin(w): w.sysch.permissions_for = lambda m: types.SimpleNamespace(view_channel=True, send_messages=True, administrator=True,
                                                                          mention_everyone=False)
def _everyone(w): w.sysch.permissions_for = lambda m: types.SimpleNamespace(view_channel=True, send_messages=True,
                                                                             administrator=False, mention_everyone=True)


@pytest.mark.parametrize("mut,reason", [(_bad_app_id, "app_id_mismatch"), (_foreign_guild, "guild_not_found"),
                                        (_no_channel, "channel_not_found"), (_category, "channel_not_found"),
                                        (_no_access, "system_no_access"), (_admin, "system_over_privileged"),
                                        (_everyone, "system_over_privileged")])
async def test_a4_system_refusal_degrades_to_file_only(tmp_path, mut, reason):
    w = world(tmp_path, system=True)
    w.app.log.tap = w.app.forwarder.offer
    mut(w)
    await sys_ready(w)
    assert w.log.events("system.disabled") == [{"reason": reason}] and w.sysbot.closed
    assert w.app.system_channel is None and w.app.log.tap is None and w.app._fwd_task is None
    await w.app._admin_line("online: x")
    assert not w.sysch.sent and not w.ch["admin"].sent and w.log.events("admin.line")[0]["text"] == "online: x"
    assert w.app.exit_code == 0


async def test_a4_login_failure_disables_system_only(tmp_path):
    w = world(tmp_path, system=True)

    class Boom(Bot):
        async def start(self, token): raise discord.LoginFailure("nope " + token)
    w.sysbot.__class__ = type("B", (Boom,), {})
    w.bot.start = lambda t: asyncio.sleep(0)
    assert await w.app.run({"praw": TOK_PRAW}, TOK_SYSTEM) == 0
    assert w.log.events("system.disabled") == [{"reason": "login_failed"}] and "@system" in w.app.settled
    assert not any(TOK_SYSTEM in json.dumps(f) for _, f in w.log.rows)


async def test_system_ready_idempotent_and_shutdown_cancels(tmp_path):
    w = world(tmp_path, system=True)
    await sys_ready(w)
    task = w.app._fwd_task
    await w.app._on_system_ready()()
    assert w.app._fwd_task is task and w.app.system_channel is w.sysch and "@system" in w.app.settled
    await w.app.shutdown()
    await asyncio.sleep(0)
    assert task.cancelled() and w.app.log.tap is None and w.sysbot.closed


async def test_ready_with_system_posts_online_via_system_only(tmp_path, monkeypatch):
    w = world(tmp_path, system=True)
    monkeypatch.setenv("EMP_VERSION", "v1")
    await sys_ready(w)
    await w.app._on_ready("praw")()
    await asyncio.sleep(0.05)
    assert [m.content for m in w.sysch.sent if m.content.startswith("online:")] and not w.ch["admin"].sent
    assert w.app._all_settled.is_set()
    await w.app.shutdown()


# ---- A5 + S1214-01 ---------------------------------------------------------------------------------------
@pytest.mark.parametrize("kw", [{}, {"ROLLOUT_MODE": "full", "CHANNEL_ALLOWLIST": None}])
async def test_a5_s1214_01_bot_log_and_threads_refused_everywhere(tmp_path, kw):
    w = world(tmp_path, **kw)
    admin = w.ch["admin"]
    thread = Channel(OTHER + 30, parent=admin)
    ev = types.SimpleNamespace(channel=thread, author=types.SimpleNamespace(id=HUMAN), guild=types.SimpleNamespace(id=G), guild_id=G)
    assert not await w.app.gate.allowed_channel(ev)
    assert not await w.app.gate.allowed_channel(types.SimpleNamespace(**{**ev.__dict__, "channel": admin}))
    assert w.log.events("gate.outside_allowlist")
    out = []
    resp = types.SimpleNamespace(is_done=lambda: False, send_message=lambda *a, **k: out.append((a, k)) or asyncio.sleep(0))
    await refuse(types.SimpleNamespace(response=resp))
    assert out and out[0][1]["ephemeral"] is True
    f = DiscordSinkFactory(w.app)
    for target in (admin, thread, ADMIN):                              # for_channel by object and by id
        with pytest.raises(TargetError) as e:
            f.for_channel(target, persona())
        assert e.value.code == "target_not_allowed"
    w.ctx.sinks = types.SimpleNamespace(app=w.app)
    w.bot.get_channel = lambda i: {ADMIN: admin, thread.id: thread}.get(i)
    port = DiscordThreadPort(w.ctx)
    for cid in (ADMIN, thread.id):
        with pytest.raises(TargetError) as e:
            await port.create_thread(cid, 1, "n")
        assert e.value.code == "target_not_allowed"
        with pytest.raises(TargetError) as e:
            await port.history(cid, 5)
        assert e.value.code == "target_not_allowed"


# ---- A6 + S1214-04 ---------------------------------------------------------------------------------------
@pytest.mark.parametrize("over,code", [
    ({"DISCORD_BOT_TOKEN_SYSTEM": TOK_SYSTEM}, "missing:DISCORD_APP_ID_SYSTEM"),
    ({"DISCORD_BOT_TOKEN_SYSTEM": "short", "DISCORD_APP_ID_SYSTEM": "5"}, "secret_too_short:DISCORD_BOT_TOKEN_SYSTEM"),
    ({"DISCORD_BOT_TOKEN_SYSTEM": TOK_PRAW, "DISCORD_APP_ID_SYSTEM": "5"}, "token_shared"),
    ({"DISCORD_BOT_TOKEN_SYSTEM": TOK_SYSTEM, "DISCORD_APP_ID_SYSTEM": "11"}, "app_id_shared"),
    ({"DISCORD_BOT_TOKEN_SYSTEM": TOK_SYSTEM, "DISCORD_APP_ID_SYSTEM": "5", "DISCORD_MAX_CLIENTS": "1"}, "too_many_clients"),
    ({"ADMIN_NOTIFY_CHANNEL_ID": "222222222222222205"}, "admin_channel_shared"),   # == APPROVAL_CHANNEL_ID
    ({"ADMIN_NOTIFY_CHANNEL_ID": "222222222222222203"}, "admin_channel_shared"),   # == TASKS_CHANNEL_ID
])
def test_a6_s1214_04_config_refusals(tmp_path, over, code):
    with pytest.raises(ConfigError) as e:
        Config.load(denv(tmp_path, **over))
    assert e.value.code == code


def test_a6_25_personas_plus_system_over_default_cap(tmp_path):
    over = {f"DISCORD_BOT_TOKEN_P{i}": f"tok-p{i}-{'x' * 16}" for i in range(24)}
    over.update({f"DISCORD_APP_ID_P{i}": str(100 + i) for i in range(24)})
    Config.load(denv(tmp_path, **over))                               # 25 clients incl. praw: at the cap
    over.update(DISCORD_BOT_TOKEN_SYSTEM=TOK_SYSTEM, DISCORD_APP_ID_SYSTEM="5")
    with pytest.raises(ConfigError) as e:
        Config.load(denv(tmp_path, **over))
    assert e.value.code == "too_many_clients"


def test_a6_system_token_kept_out_of_repr_persona_tokens_and_masked(tmp_path):
    c = Config.load(denv(tmp_path, DISCORD_BOT_TOKEN_SYSTEM=TOK_SYSTEM, DISCORD_APP_ID_SYSTEM="5"))
    assert c.system_token == TOK_SYSTEM and c.system_app_id == 5 and "SYSTEM" not in c.persona_tokens
    assert TOK_SYSTEM not in repr(c) and TOK_SYSTEM in masking.exact_values()
    c = Config.load(denv(tmp_path))
    assert c.system_token is None and c.system_app_id is None


async def test_persona_id_reserved_system(tmp_path, monkeypatch, capsys):
    from core.agents import persona as P
    monkeypatch.delenv("EMP_CLI_DEV", raising=False)
    monkeypatch.setattr(P.FilePersonaRegistry, "load", classmethod(
        lambda cls, *a: types.SimpleNamespace(all=lambda: [persona("praw"), persona("system", "System")])))
    assert await amain(fake_env(tmp_path), install_signals=False) == 2
    assert "persona_id_reserved:system" in capsys.readouterr().err


# ---- A8 ------------------------------------------------------------------------------------------------
async def test_a8_gate_first_iterates_system_too(tmp_path):
    w = world(tmp_path, system=True)
    w.ctx.discord_message_handler = lambda a, m: asyncio.sleep(0)
    app = C.setup_discord(w.ctx, {"praw": w.bot, "tek": Bot(901, 12, w.g)}, w.sysbot)
    assert "tek" not in app.persona_by_user_id and app.system is w.sysbot and "system" not in app.bots
    assert w.ctx.log.tap == app.forwarder.offer
    assert [n for n, _ in w.sysbot.listeners] == ["on_ready"] and not w.sysbot.checks and not w.sysbot.commands
    for name, fn in w.sysbot.listeners:
        assert name in C.UNGATED
    assert all(not k.endswith("@system") for k in app.listeners)      # no gated listener on System
    for b in (w.bot, app.bots["tek"]):                                # every other listener stays behind the gate
        for name, fn in b.listeners:
            assert name in C.UNGATED or fn in app.listeners.values(), name


# ---- S1214-03 ------------------------------------------------------------------------------------------
async def test_s1214_03_forbidden_sends_stop_without_deadlock_while_offering(tmp_path):
    w = world(tmp_path, system=True)
    log = real_log(w, tmp_path)

    async def deny(**kw):
        raise discord.Forbidden(types.SimpleNamespace(status=403, reason=""), "x")
    w.sysch.send = deny
    stop = threading.Event()

    def worker():
        i = 0
        while not stop.is_set():
            log.write_log("core", f"w{i % 50}", "WARNING", count=i)
            i += 1
            time.sleep(0.0005)
    t = threading.Thread(target=worker, daemon=True)
    t.start()
    await sys_ready(w, flush=0.01)
    for _ in range(200):
        if '"logforward.stopped"' in (tmp_path / "app.jsonl").read_text():
            break
        await asyncio.sleep(0.02)
    stop.set()
    t.join(2)
    text = (tmp_path / "app.jsonl").read_text()
    assert '"logforward.stopped"' in text and text.count('"logforward.send_failed"') == 3
    assert log.tap is None and not t.is_alive()
    await w.app.shutdown()
