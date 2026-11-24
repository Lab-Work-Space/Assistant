import types

import discord
import pytest

from core.agent_tools.pull_user import make_pull_user
from core.discord.sinks import DiscordSinkFactory
from core.interfaces import ToolCall, ToolContext
from core.pulluser.service import PullUserService
from tests.discord_fakes import APPROVER_ROLE, HUMAN, Member, persona
from tests.test_discord_layer import world


def setup(tmp_path):
    w = world(tmp_path)
    w.ctx.sinks = DiscordSinkFactory(w.app)
    w.apprv = Member(HUMAN + 3, [APPROVER_ROLE])
    w.g._m[w.apprv.id] = w.apprv
    parent = w.ch["allowed"]
    parent.threads = []

    async def create_thread(name, type=None):
        t = type_ch(parent)
        parent.threads.append(t)
        return t
    parent.create_thread = create_thread
    from tests.discord_fakes import Channel
    type_ch = lambda p: Channel(p.id + 500, parent=p)
    w.tool = make_pull_user(PullUserService(w.ctx))
    return w


def tc(w, human=HUMAN, ch=None):
    ch = ch or w.ch["allowed"]
    return ToolContext(persona(), "r1", types.SimpleNamespace(id=1).id, ch.id, None, "human_message", human, None, "discord")


async def run(w, args, **kw):
    return await w.tool.handler(tc(w, **kw), args)


async def test_thread_single_allowed_mention(tmp_path):
    w = setup(tmp_path)
    r = await run(w, {"user_id": str(HUMAN + 1), "reason": "join us"})
    assert (r.ok, r.data) == (True, {"method": "thread_mention"})
    t = w.ch["allowed"].threads[0]
    m = t.sent[0]
    assert m.mentions.users[0].id == HUMAN + 1 and len(m.mentions.users) == 1 and not m.mentions.everyone and not m.mentions.roles


async def test_dm_to_approver_in_coexist(tmp_path):
    w = setup(tmp_path)
    r = await run(w, {"user_id": str(w.apprv.id), "reason": "x", "destination": "dm"})
    assert r.data == {"method": "dm_invite"} and not w.ch["allowed"].threads


async def test_dm_non_approver_falls_back_to_thread(tmp_path):
    w = setup(tmp_path)
    r = await run(w, {"user_id": str(HUMAN + 1), "reason": "x", "destination": "dm"})
    assert r.data == {"method": "thread_mention"} and len(w.ch["allowed"].threads) == 1


async def test_no_human_trigger_needs_human(tmp_path):
    w = setup(tmp_path)
    assert w.tool.needs_human_trigger
    from core.agent_tools.registry import Registry
    reg = Registry(w.log)
    reg.register(w.tool)
    res = await reg.invoke(tc(w, human=None), ToolCall("1", "pull_user", {"user_id": str(HUMAN + 1), "reason": "x"}),
                           reg.for_agent(persona(), ("*",)))
    assert res.error == "needs_human" and not w.ch["allowed"].threads


async def test_voice_not_available(tmp_path):
    w = setup(tmp_path)
    assert (await run(w, {"user_id": str(HUMAN + 1), "reason": "x", "destination": "voice"})).error == "voice_not_available"


async def test_refusals(tmp_path):
    w = setup(tmp_path)
    a = {"user_id": str(HUMAN + 1), "reason": "x"}
    assert (await run(w, {**a, "user_id": str(HUMAN + 2)})).error == "user_not_found"      # bot
    assert (await run(w, {**a, "user_id": str(HUMAN + 99)})).error == "user_not_found"     # not a member
    assert (await run(w, {**a, "user_id": str(HUMAN)})).error == "invalid_target"          # self
    assert (await run(w, a, ch=w.ch["outside"])).error == "target_not_allowed"              # outside allowlist
    assert (await run(w, a, ch=w.ch["appr"])).error == "target_not_allowed"
    w.ch["allowed"].denied.add(HUMAN + 1)                                                   # target cannot view, DM not allowed
    assert (await run(w, a)).error == "target_not_allowed"


async def test_rate_limit(tmp_path):
    w = setup(tmp_path)
    a = {"user_id": str(HUMAN + 1), "reason": "x"}
    for _ in range(w.cfg.pull_max_per_target):
        assert (await run(w, a)).ok
    assert (await run(w, a)).error == "rate_limited"


# ---- 017-V: destination=voice is an invite link to the requester's allowlisted voice channel, never a move ----
def voice_world(tmp_path, in_voice="kid"):
    w = setup(tmp_path)
    w.cfg.voice_enabled = True
    w.human.voice = types.SimpleNamespace(channel=w.ch[in_voice] if in_voice else None)
    return w


async def test_voice_invite_thread_links_voice_channel(tmp_path):
    w = voice_world(tmp_path)
    r = await run(w, {"user_id": str(HUMAN + 1), "reason": "join us", "destination": "voice"})
    assert (r.ok, r.data) == (True, {"method": "voice_invite_thread"})
    m = w.ch["allowed"].threads[0].sent[0]
    assert f"/{w.ch['kid'].id}" in m.content and len(m.mentions.users) == 1 and m.mentions.users[0].id == HUMAN + 1
    assert not m.mentions.everyone and not m.mentions.roles


async def test_voice_invite_dm_for_approver(tmp_path):
    w = voice_world(tmp_path)
    r = await run(w, {"user_id": str(w.apprv.id), "reason": "x", "destination": "voice"})
    assert r.data == {"method": "voice_dm_invite"} and not w.ch["allowed"].threads


async def test_voice_not_available_cases(tmp_path):
    a = {"user_id": str(HUMAN + 1), "reason": "x", "destination": "voice"}
    w = voice_world(tmp_path, in_voice=None)                      # requester not in voice
    assert (await run(w, a)).error == "voice_not_available"
    w = voice_world(tmp_path, in_voice="outside")                 # voice channel not allowlisted
    assert (await run(w, a)).error == "voice_not_available"
    w = voice_world(tmp_path)
    w.cfg.voice_enabled = False                                   # voice disabled
    assert (await run(w, a)).error == "voice_not_available"
    w = voice_world(tmp_path)
    w.ch["kid"].denied.add(HUMAN + 1)                             # target cannot see the voice channel
    assert (await run(w, a)).error == "voice_not_available"
    w = voice_world(tmp_path)
    w.ch["kid"].guild.id = 5                                      # other guild
    assert (await run(w, a)).error == "voice_not_available"
