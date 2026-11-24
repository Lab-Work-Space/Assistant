import asyncio
import glob
import os
import re
import types

import pytest

from core.__main__ import amain
from core.config import Config, ConfigError
from core.discord import client as C
from core.discord.buttons import Router, make_custom_id
from core.discord.sinks import DiscordSinkFactory
from core.functions.logs import masking
from core.interfaces import TargetError
from tests.conftest import base_env
from tests.discord_fakes import (ADMIN, ALLOWED, APPROVAL, APPROVER_ROLE, G, HUMAN, OTHER, TASKS, TOK_PRAW, TOK_SYSTEM, SYS_UID, TOK_TEK,
                                 Bot, Channel, FakeLog, Guild, Member, persona)

CAT = 555555555555555501


def denv(tmp_path, **kw):
    e = {**base_env(tmp_path), "DISCORD_GUILD_ID": str(G), "TASKS_CHANNEL_ID": str(TASKS), "ADMIN_NOTIFY_CHANNEL_ID": str(ADMIN),
         "APPROVAL_CHANNEL_ID": str(APPROVAL), "DISCORD_BOT_TOKEN_PRAW": TOK_PRAW, "DISCORD_APP_ID_PRAW": "11",
         "CHANNEL_ALLOWLIST": f"{ALLOWED},{CAT}"}
    e.update(kw)
    return {k: v for k, v in e.items() if v is not None}


# ---- config (12.3, 12.7 S12-05, 12.10) ---------------------------------------------------------------
@pytest.mark.parametrize("over,code", [
    ({"CHANNEL_ALLOWLIST": None}, "allowlist_empty"),
    ({"ROLLOUT_MODE": "weird"}, "invalid:ROLLOUT_MODE"),
    ({"PERSONA_NAME_SUFFIX": "  "}, "bounds:PERSONA_NAME_SUFFIX"),
    ({"DISCORD_BOT_TOKEN": "x" * 30}, "use_per_persona_tokens"),
    ({"DISCORD_APP_ID_PRAW": None}, "missing:DISCORD_APP_ID_PRAW"),
    ({"DISCORD_BOT_TOKEN_TEK": TOK_PRAW, "DISCORD_APP_ID_TEK": "12"}, "token_shared"),
    ({"DISCORD_BOT_TOKEN_TEK": TOK_TEK, "DISCORD_APP_ID_TEK": "11"}, "app_id_shared"),
    ({"DISCORD_BOT_TOKEN_TEK": TOK_TEK, "DISCORD_APP_ID_TEK": "12", "DISCORD_MAX_CLIENTS": "1"}, "too_many_clients"),
    ({"DISCORD_BOT_TOKEN": "x" * 30, "ROLLOUT_MODE": "weird"}, "use_per_persona_tokens"),
    ({"CHANNEL_ALLOWLIST": "12,abc"}, "invalid:CHANNEL_ALLOWLIST"),
    ({"CHANNEL_ALLOWLIST": "12"}, "invalid:CHANNEL_ALLOWLIST"),
])
def test_config_refusals(tmp_path, over, code):
    with pytest.raises(ConfigError) as e:
        Config.load(denv(tmp_path, **over))
    assert e.value.code == code


def test_config_defaults_and_full_mode(tmp_path):
    c = Config.load(denv(tmp_path))
    assert c.rollout_mode == "coexist" and c.persona_name_suffix == "(ใหม่)" and c.channel_allowlist == (ALLOWED, CAT)
    assert TOK_PRAW not in repr(c) and TOK_PRAW in masking.exact_values()
    f = Config.load(denv(tmp_path, ROLLOUT_MODE="full", CHANNEL_ALLOWLIST=None))
    assert f.channel_allowlist == () and f.persona_name_suffix == ""


# ---- gate (S12-03) -----------------------------------------------------------------------------------
def world(tmp_path, system=False, **kw):
    if system:
        kw.update(DISCORD_BOT_TOKEN_SYSTEM=TOK_SYSTEM, DISCORD_APP_ID_SYSTEM="77")
    cfg = Config.load(denv(tmp_path, **kw))
    allowed = Channel(ALLOWED)
    kid = Channel(OTHER, category_id=CAT)
    thread = Channel(OTHER + 10, parent=allowed)
    outside = Channel(OTHER + 20)
    tasks, admin, appr = Channel(TASKS, CAT), Channel(ADMIN, CAT), Channel(APPROVAL, CAT)
    human = Member(HUMAN, [APPROVER_ROLE])
    plain = Member(HUMAN + 1)
    g = Guild(channels=[allowed, kid, thread, outside, tasks, admin, appr, Channel(CAT)], members=[human, plain, Member(HUMAN + 2, bot=True)])
    bot = Bot(900, 11, g)
    ctx = types.SimpleNamespace(config=cfg, log=FakeLog(), db=None, personas=None, approvals=None, sinks=None, engine=None, budget=None)
    sysch = Channel(ADMIN, CAT)
    sysbot = Bot(SYS_UID, 77, Guild(channels=[sysch])) if system else None
    app = C.DiscordApp(ctx, {"praw": bot}, "praw", sysbot)
    app.gate.approver_role_id = APPROVER_ROLE
    return types.SimpleNamespace(app=app, sysbot=sysbot, sysch=sysch, cfg=cfg, g=g, bot=bot, log=ctx.log, ch=dict(allowed=allowed, kid=kid, thread=thread,
                                 outside=outside, tasks=tasks, admin=admin, appr=appr), human=human, plain=plain, ctx=ctx)


def msg(ch, uid=HUMAN, guild=True):
    return types.SimpleNamespace(channel=ch, author=types.SimpleNamespace(id=uid), guild=types.SimpleNamespace(id=G) if guild else None,
                                 guild_id=G if guild else None, content="SECRET BODY")


async def test_gate_allowlist_category_and_threads(tmp_path):
    w = world(tmp_path)
    gate = w.app.gate
    assert await gate.allowed_channel(msg(w.ch["allowed"]))
    assert await gate.allowed_channel(msg(w.ch["kid"]))      # category admits children
    assert await gate.allowed_channel(msg(w.ch["thread"]))   # and threads under an allowed parent
    assert not await gate.allowed_channel(msg(w.ch["outside"]))
    ev = w.log.events("gate.outside_allowlist")
    assert len(ev) == 1 and ev[0]["channel"] == w.ch["outside"].id and "SECRET" not in str(w.log.rows)


async def test_gate_log_rate_limited(tmp_path):
    w = world(tmp_path)
    t = [0.0]
    w.app.gate.clock = lambda: t[0]
    for _ in range(4):
        await w.app.gate.allowed_channel(msg(w.ch["outside"]))
    t[0] = 61
    await w.app.gate.allowed_channel(msg(w.ch["outside"]))
    ev = w.log.events("gate.outside_allowlist")
    assert [e["suppressed"] for e in ev] == [0, 3]


async def test_gate_dm_rules(tmp_path):
    w = world(tmp_path)
    dm = lambda uid: msg(Channel(9), uid, guild=False)
    assert await w.app.gate.allowed_channel(dm(HUMAN))            # approver
    assert not await w.app.gate.allowed_channel(dm(HUMAN + 1))    # coexist, not approver: silence
    assert not await w.app.gate.allowed_channel(dm(HUMAN + 99))   # not a guild member
    f = world(tmp_path, ROLLOUT_MODE="full", CHANNEL_ALLOWLIST=None)
    assert await f.app.gate.allowed_channel(dm(HUMAN + 1))
    assert await f.app.gate.allowed_channel(msg(f.ch["outside"]))  # full + empty: all channels


async def test_wrong_guild_denied(tmp_path):
    w = world(tmp_path)
    m = msg(w.ch["allowed"])
    m.guild_id = 5
    assert not await w.app.gate.allowed_channel(m)


async def test_every_listener_calls_gate_first(tmp_path):
    w = world(tmp_path)
    order, handled = [], []

    async def spy(ev):
        order.append("gate")
        return ev.ok
    w.ctx.discord_message_handler = lambda a, m: handled.append(m) or asyncio.sleep(0)
    app = C.setup_discord(w.ctx, {"praw": w.bot, "tek": Bot(901, 12, w.g)})
    app.gate.allowed_channel = spy
    assert {"on_message@praw", "on_interaction@praw", "on_interaction@tek"} == set(app.listeners)
    for name, fn in app.listeners.items():  # denied event: gate ran, nothing else
        order.clear()
        await fn(types.SimpleNamespace(ok=False))
        assert order == ["gate"] and not handled, name
    order.clear()
    ok = types.SimpleNamespace(ok=True, author=types.SimpleNamespace(bot=True))
    await app.listeners["on_message@praw"](ok)
    assert order == ["gate"] and handled == [ok]  # allowed: gate first, then the handler
    assert len(w.bot.checks) == 1                 # slash commands: global check on the intake client


def test_only_one_add_listener_call_site():
    hits = []
    for f in glob.glob("core/discord/*.py"):
        for ln in open(f):
            if re.search(r"add_listener\(|\.listen\(|@\w+\.event|\.event\(", ln) and "app.listen" not in ln:
                hits.append((f, ln.strip()))
    assert len(hits) == 2, hits  # client.listen() and client._ungated() only


# ---- sinks / outbound gate (S12-01, 10.11.2) ----------------------------------------------------------
async def test_for_channel_and_target_gates(tmp_path):
    w = world(tmp_path)
    app = w.app
    f = DiscordSinkFactory(app)
    p = persona()
    with pytest.raises(TargetError) as e:
        f.for_channel(w.ch["outside"], p)
    assert e.value.code == "target_not_allowed"
    f.for_channel(w.ch["allowed"], p)
    ctx = types.SimpleNamespace(human_user_id=HUMAN)

    async def code(kind, tid, c=ctx):
        with pytest.raises(TargetError) as e:
            await f.for_target(kind, tid, p, c)
        return e.value.code
    assert await code("thread", w.ch["outside"].id) == "target_not_allowed"
    assert await code("thread", w.ch["appr"].id) == "target_not_allowed"   # approval channel
    assert await code("thread", w.ch["admin"].id) == "target_not_allowed"  # admin channel
    assert await code("thread", 999) == "discord_not_found"
    assert await code("dm", HUMAN + 1) == "target_not_allowed"             # coexist: non-approver
    assert await code("dm", HUMAN + 2) == "target_not_allowed"             # bot
    assert await code("thread", w.ch["allowed"].id, types.SimpleNamespace(human_user_id=None)) == "target_not_allowed"
    w.ch["allowed"].denied.add(HUMAN)                                       # human lacks permission there
    assert await code("thread", w.ch["allowed"].id) == "target_not_allowed"
    w.ch["allowed"].denied.clear()
    assert await f.for_target("thread", w.ch["allowed"].id, p, ctx)
    assert await f.for_target("dm", HUMAN, p, ctx)                          # approver DM ok
    with pytest.raises(TargetError):
        await f.for_dm(HUMAN + 1, p).start()                                # every DM path checks (S12-01)


async def test_persona_posts_with_own_client_and_disabled_routes_via_intake(tmp_path):
    w = world(tmp_path)
    tek = Bot(901, 12, w.g)
    tek_ch = Channel(ALLOWED)                       # tek's own view of the same channel
    tek.guild = Guild(channels=[tek_ch])
    w.app.bots["tek"] = tek
    f = DiscordSinkFactory(w.app)
    s = f.for_channel(w.ch["allowed"], persona("tek", "Tek"))
    await s.start()
    await s.write("hello world ")
    await s.finish()
    assert tek_ch.sent and not w.ch["allowed"].sent                         # own client, not intake
    w.app.disabled.add("tek")                                               # S1210-07: no webhook, routed via Praw's client
    s = f.for_channel(w.ch["allowed"], persona("tek", "Tek"))
    await s.start()
    assert not w.ch["allowed"].sent                                          # typing mode: no placeholder message
    await s.write("hello again ")
    await s.finish()
    assert w.ch["allowed"].sent[0].mentions.everyone is False and not hasattr(w.app, "webhooks")
    assert len(w.ch["allowed"].sent) == 1                                   # one final message, no edits


async def test_embed_masked_and_file_name_sanitised(tmp_path):
    from core.discord.embeds import build_embed
    w = world(tmp_path)
    masking.set_exact(["supersecret-token-123"])
    f = DiscordSinkFactory(w.app)
    p = persona()
    w.app.bots["praw"] = w.bot
    s = f.for_channel(w.ch["allowed"], p)
    await s.send_embed(build_embed("t supersecret-token-123", "d"))
    await s.send_file("../../etc/pa ss.png", b"x", "c supersecret-token-123")
    sent = w.ch["allowed"].sent
    assert "supersecret" not in sent[0].embed.title and "supersecret" not in sent[1].content
    assert sent[1].file.filename == "pa_ss.png" and sent[0].mentions.everyone is False


# ---- startup checks (S12-05, S12-07, 10.13.6) --------------------------------------------------------
async def ready(w, pid="praw"):
    await w.app._on_ready(pid)()


async def test_ready_online_line_leave_guilds_and_allowlist(tmp_path, monkeypatch):
    w = world(tmp_path)
    other = Guild(gid=G + 1)
    w.bot.guilds.append(other)
    monkeypatch.setenv("EMP_VERSION", "v0.1.0-test")
    await ready(w)
    await asyncio.sleep(0.05)
    assert w.app.exit_code == 0 and other.left and w.log.events("guild.left")
    assert not w.ch["admin"].sent                                            # Praw never posts in #bot-log (12.14)
    line = w.log.events("admin.line")                                        # no System: file only (D4)
    assert len(line) == 1 and line[0]["text"].startswith("online: ") and "v0.1.0-test" in line[0]["text"]
    assert w.log.events("intake.sees_admin_channel")                         # Praw can still View in this fake: WARNING (D3)
    assert w.app.persona_by_user_id == {900: "praw"} and w.app.ready.is_set()
    assert w.app.gate.approver_role_id == APPROVER_ROLE


@pytest.mark.parametrize("mut,code", [
    (lambda w: setattr(w.bot, "application_id", 99), "app_id_mismatch:praw"),
    (lambda w: setattr(w.g, "roles", []), "approver_role_invalid"),
    (lambda w: setattr(w.app.cfg, "channel_allowlist", (*w.app.cfg.channel_allowlist, 777777777777777777)), "allowlist_unresolved"),
    (lambda w: (setattr(w.app.cfg, "channel_allowlist", (ALLOWED,)), setattr(w.app.gate, "ids", {ALLOWED})), "channel_not_allowlisted"),
])
async def test_ready_refusals(tmp_path, mut, code):
    w = world(tmp_path)
    mut(w)
    await ready(w)
    assert w.app.exit_code == 2 and w.app.refusal == code and w.bot.closed
    assert not w.ch["admin"].sent


async def test_non_intake_failure_disables_persona_and_summary_names_it(tmp_path):
    w = world(tmp_path)
    tek = Bot(901, 99, w.g)                       # wrong app id for tek: fatal for that client only
    w.cfg.persona_app_ids["TEK"] = 12
    w.app.bots["tek"] = tek
    await ready(w)
    await ready(w, "tek")
    await asyncio.sleep(0.05)
    assert "tek" in w.app.disabled and w.app.exit_code == 0 and tek.closed and not w.bot.closed
    assert not w.ch["admin"].sent
    sent = [f["text"] for f in w.log.events("admin.line")]
    assert len(sent) == 2 and sent[0].startswith("online:") and "clients=1/2" in sent[0] and sent[1] == "persona_disabled:tek"
    assert w.app.client_for("tek") is None and w.log.events("persona.disabled")


async def test_message_for_disabled_persona_goes_to_praw(tmp_path):
    w = world(tmp_path)
    runs = []

    class Eng:
        async def run(self, req):
            runs.append(req.agent_id)
    w.ctx.engine = Eng()
    w.ctx.personas = types.SimpleNamespace(get=lambda i: persona(i, i), all=lambda: [])
    w.ctx.sinks = types.SimpleNamespace(for_channel=lambda ch, p: None)
    w.app.persona_by_user_id[901] = "tek"
    w.app.disabled.add("tek")
    m = types.SimpleNamespace(channel=w.ch["allowed"], guild=types.SimpleNamespace(id=G), webhook_id=None, reference=None,
                              author=types.SimpleNamespace(id=HUMAN, bot=False, display_name="h"), content="x",
                              mentions=[types.SimpleNamespace(id=901)])
    await C.default_message_handler(w.app, m)
    assert runs == ["praw"]


# ---- buttons ------------------------------------------------------------------------------------------
async def test_button_router_binds_click_to_stored_message(db):
    import discord
    log, seen, out = FakeLog(), [], []
    me = types.SimpleNamespace(id=900)
    r = Router(log, db, lambda: 900)

    async def h(i, action, uid):
        seen.append((action, uid))
    r.register("appr", h)
    resp = types.SimpleNamespace(send_message=lambda *a, **k: out.append(a) or asyncio.sleep(0),
                                 defer=lambda **k: out.append("defer") or asyncio.sleep(0))
    row = await db.fetchrow("INSERT INTO approvals (code,level,dept,route_reason,kind,title,summary,requested_by,origin,origin_channel_id,message_id,expires_at) "
                            "VALUES ('APR-HQ-0001','hq','HQ','legacy','generic','t','s','praw','discord',5,4242,'2099-01-01T00:00:00.000Z') RETURNING id")
    uid = row["id"]

    def click(cid, mid=4242, author=900, client=me):
        return types.SimpleNamespace(type=discord.InteractionType.component, data={"custom_id": cid}, response=resp, client=types.SimpleNamespace(user=client),
                                     message=types.SimpleNamespace(id=mid, author=types.SimpleNamespace(id=author)))
    cid = make_custom_id("appr", "approve", uid)
    await r.dispatch(click(cid))
    assert seen == [("approve", uid)] and out == ["defer"]
    for bad in (click(cid, mid=1), click(cid, author=7), click(cid, client=types.SimpleNamespace(id=901)),
                click(make_custom_id("appr", "approve", "12345678-1234-1234-1234-123456789012")), click("bogus")):
        out.clear()
        await r.dispatch(bad)
        assert out and "no longer active" in out[0][0]
    assert len(seen) == 1
    with pytest.raises(ValueError):
        make_custom_id("zzz", "a", uid)


# ---- entry point (12.4) -------------------------------------------------------------------------------
def fake_env(tmp_path, **kw):
    from core.cli.fakes import FAKE_ENV
    e = denv(tmp_path, **kw)
    return {**{k: v for k, v in FAKE_ENV.items() if k not in e}, **e}


async def test_main_refusals(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("EMP_CLI_DEV", "1")
    assert await amain(fake_env(tmp_path), install_signals=False) == 2
    assert "cli_flag_in_discord_mode" in capsys.readouterr().err
    monkeypatch.delenv("EMP_CLI_DEV")
    assert await amain(fake_env(tmp_path, DISCORD_BOT_TOKEN="y" * 30), install_signals=False) == 2
    assert "use_per_persona_tokens" in capsys.readouterr().err
    e = fake_env(tmp_path, DISCORD_BOT_TOKEN_PRAW=None, DISCORD_APP_ID_PRAW=None, DISCORD_BOT_TOKEN_TEK=TOK_TEK, DISCORD_APP_ID_TEK="12")
    assert await amain(e, install_signals=False) == 2
    assert "missing:DISCORD_BOT_TOKEN_PRAW" in capsys.readouterr().err
    assert await amain(fake_env(tmp_path, DISCORD_BOT_TOKEN_NOBODY=TOK_TEK, DISCORD_APP_ID_NOBODY="3"), install_signals=False) == 2
    assert "unknown_persona_token:NOBODY" in capsys.readouterr().err
    assert await amain(fake_env(tmp_path, CHANNEL_ALLOWLIST=None), install_signals=False) == 2
    assert "allowlist_empty" in capsys.readouterr().err


async def test_main_runs_against_fakes_same_engine_path(tmp_path, monkeypatch):
    from core.cli.fakes import fake_providers
    from core.migration.runner import migrate
    from tests.conftest import make_db_path
    monkeypatch.delenv("EMP_CLI_DEV", raising=False)
    env = fake_env(tmp_path, DATABASE_PATH=make_db_path(tmp_path), LOG_DIR=str(tmp_path / "logs"))
    holder = {}
    allowed = Channel(ALLOWED)
    tasks, admin, appr = Channel(TASKS, CAT), Channel(ADMIN, CAT), Channel(APPROVAL, CAT)
    g = Guild(channels=[allowed, Channel(CAT + 1, category_id=CAT), tasks, admin, appr, Channel(CAT)], members=[Member(HUMAN, [APPROVER_ROLE])])

    class FBot(Bot):
        async def start(self, token):
            holder["token"] = token
            app = holder["app"]
            await app._on_ready("praw")()
            m = types.SimpleNamespace(channel=allowed, guild=types.SimpleNamespace(id=G), guild_id=G, webhook_id=None,
                                      author=types.SimpleNamespace(id=HUMAN, bot=False, display_name="h"), content="hi there",
                                      mentions=[types.SimpleNamespace(id=900)], reference=None)
            await app.listeners["on_message@praw"](m)
            out = types.SimpleNamespace(channel=Channel(OTHER + 50), guild=m.guild, guild_id=G, author=m.author, webhook_id=None,
                                        content="no", mentions=m.mentions, reference=None)
            await app.listeners["on_message@praw"](out)
            holder["outside"] = out.channel
            await asyncio.sleep(0.05)  # let the summary line task run

    import core.__main__ as M
    real = M.setup_discord

    def spy(ctx, bots, system=None):
        holder["app"] = real(ctx, bots, system)
        return holder["app"]
    monkeypatch.setattr(M, "setup_discord", spy)
    g.roles = [types.SimpleNamespace(id=APPROVER_ROLE, managed=False, name="AI-Admin")]
    rc = await amain({**env, "APPROVER_ROLE_ID": str(APPROVER_ROLE)}, bot_factory=lambda c, intake: FBot(900, 11, g),
                     install_signals=False, providers=fake_providers())
    assert rc == 0 and holder["token"] == TOK_PRAW
    assert not admin.sent                                    # no System configured: nothing from Praw in #bot-log
    text = "".join(m.content or "" for m in allowed.sent)
    assert "[fake] reply from" in text                       # AgentEngine.run reached the (fake) provider
    assert not holder["outside"].sent
