import asyncio
import types
from types import SimpleNamespace as NS

import discord

from core.discord import client as C
from core.discord.buttons import Router
from core.voice import ext
from core.voice.session import VoiceManager
from tests.discord_fakes import Bot, Channel, FakeLog, Guild, G
from tests.voice.vfakes import BOT, CAT, U1, U2, VC_ID, VChan, Mem, make_world, started


def test_init_disabled_sets_no_voice(tmp_path):
    from core.config import Config
    from tests.test_discord_layer import denv
    ctx = NS(config=Config.load(denv(tmp_path)), voice="x")
    ext.init(ctx)
    assert ctx.voice is None and not hasattr(ctx, "voice_manager")


async def test_init_enabled(w):
    ctx = NS(config=w.cfg, log=w.log, voice=None)
    ext.init(ctx)
    assert isinstance(ctx.voice_manager, VoiceManager) and ctx.voice is not None


def test_load_opus_paths(monkeypatch):
    monkeypatch.setattr(discord.opus, "is_loaded", lambda: True)
    assert ext.load_opus() is True
    state = {"loaded": False}
    monkeypatch.setattr(discord.opus, "is_loaded", lambda: state["loaded"])

    def boom(name):
        raise OSError("no libopus")
    monkeypatch.setattr(discord.opus, "load_opus", boom)
    assert ext.load_opus() is False  # clear disable path: no exception

    def ok(name):
        state["loaded"] = True
    monkeypatch.setattr(discord.opus, "load_opus", ok)
    assert ext.load_opus() is True


async def test_setup_discord_wires_listener_gate_first_and_router(w, monkeypatch):
    monkeypatch.setattr(ext, "load_opus", lambda: False)
    bot = Bot(BOT, 11, Guild(channels=[w.vch, Channel(VC_ID + 50)]))
    w.ctx.personas = None
    app = C.DiscordApp(w.ctx, {"praw": bot}, "praw")
    app.gate.approver_role_id = 1
    w.ctx.log = w.log
    seen, order = [], []
    w.mgr.on_voice_state = lambda m, b, a: seen.append(m) or asyncio.sleep(0)
    ext.setup_discord(app)
    assert w.mgr.opus_ok is False and w.mgr.app is app
    assert "rec" in app.router._h and "on_voice_state_update@praw" in app.listeners
    assert [c.name for c in bot.commands] == ["voice"]
    names = {c.name for c in bot.commands[0].walk_commands()}
    assert {"join", "leave", "optout", "optin", "start", "stop"} <= names
    real = app.gate.allowed_channel

    async def spy(ev):
        order.append("gate")
        return await real(ev)
    app.gate.allowed_channel = spy
    fn = app.listeners["on_voice_state_update@praw"]
    member = Mem(U1, "a", None)
    out = Channel(VC_ID + 50)  # not allowlisted
    await fn(member, NS(channel=None), NS(channel=out))
    assert order == ["gate"] and seen == []          # denied: handler never runs
    await fn(member, NS(channel=None), NS(channel=w.vch))
    assert order == ["gate", "gate"] and seen == [member]
    await fn(member, NS(channel=w.vch), NS(channel=None))   # leave event gated through the session channel too
    assert len(seen) == 2
    for t in list(w.mgr.bg):
        t.cancel()
    await asyncio.sleep(0)


def interaction(user, guild_id=G):
    sent = []

    async def send_message(text, ephemeral=False):
        sent.append((text, ephemeral))
    return NS(user=user, guild_id=guild_id, response=NS(send_message=send_message), sent=sent)


async def test_commands_reply_ephemeral_codes(w):
    cmds = ext.Commands(w.app, w.mgr)
    i = interaction(w.mem[U1])
    await cmds.join(i)
    assert i.sent[0][1] is True and i.sent[0][0].startswith("ok_join")
    i = interaction(w.mem[U2])
    await cmds.join(i)
    assert i.sent[0][0].startswith("voice_busy")
    i = interaction(Mem(U2 + 5, "x", None))
    await cmds.leave(i)
    assert i.sent[0][0].startswith("not_allowed")
    w.ctx.approver_policy.ids = {U2 + 5}
    await cmds.leave(i := interaction(Mem(U2 + 5, "x", None)))
    assert i.sent[0][0].startswith("ok_leave")
    await asyncio.gather(*w.mgr.bg)
    assert w.mgr.session is None
    i = interaction(w.mem[U1])
    await cmds.record_stop(i)
    assert i.sent[0][0].startswith("no_session")
    w.mgr.live_capture = False
    await cmds.record_start(i := interaction(w.mem[U1]))
    assert i.sent[0][0].startswith("live_capture_disabled")
    await cmds.optout(i := interaction(w.mem[U1]))
    assert i.sent[0][0].startswith("ok_optout")
    await cmds.optin(i := interaction(w.mem[U1]))
    assert i.sent[0][0].startswith("ok_optin")


async def test_record_start_stop_commands_member_and_approver(w):
    cmds = ext.Commands(w.app, w.mgr)
    i = interaction(w.mem[U1])
    await cmds.record_start(i)
    assert i.sent[0][0].startswith("ok_record_start")
    await asyncio.gather(*w.mgr.session.tasks)
    outsider = interaction(Mem(U2 + 7, "o", None))
    await cmds.record_stop(outsider)
    assert outsider.sent[0][0].startswith("not_allowed") and w.vc.recording
    await cmds.record_stop(i2 := interaction(w.mem[U2]))
    assert i2.sent[0][0].startswith("ok_record_stop")
    await asyncio.gather(*w.mgr.bg)
    assert not w.vc.recording


async def test_command_exception_isolated(w):
    cmds = ext.Commands(w.app, w.mgr)

    async def boom(m):
        raise RuntimeError("x")
    w.mgr.join = boom
    i = interaction(w.mem[U1])
    await cmds.join(i)  # does not raise
    assert i.sent[0][0].startswith("internal_error") and w.log.events("voice.command_failed")
