import types
from datetime import datetime
from zoneinfo import ZoneInfo
from decimal import Decimal

import discord
import pytest

from core.budget import repo
from core.budget.guard import Guard
from core.config import Config
from core.discord import notifier as N, strings
from core.interfaces import Usage
from tests.conftest import base_env
from tests.discord_fakes import ADMIN, ALLOWED, APPROVER_ROLE, Channel, FakeLog, G, HUMAN, persona

def today():
    return datetime.now(ZoneInfo("Asia/Bangkok")).date()


CMD = discord.InteractionType.application_command


class Policy:
    surface = "discord"

    async def is_approver(self, a):
        return a.kind == "discord" and a.user_id == str(HUMAN)


class Resp:
    def __init__(self):
        self.said = []

    async def send_message(self, text, ephemeral=False):
        self.said.append((text, ephemeral))

    def is_done(self):
        return bool(self.said)


def inter(uid=HUMAN, typ=CMD, guild=G):
    return types.SimpleNamespace(type=typ, user=types.SimpleNamespace(id=uid, display_name="x", bot=False),
                                 guild_id=guild, response=Resp())


def world(db, tmp_path, policy=None):
    cfg = Config.load({**base_env(tmp_path), "DISCORD_GUILD_ID": str(G), "ADMIN_NOTIFY_CHANNEL_ID": str(ADMIN)})
    admin, cmds = Channel(ADMIN), []
    intake = types.SimpleNamespace(get_channel=lambda i: None, add_application_command=cmds.append)
    log = FakeLog()
    ps = types.SimpleNamespace(get=lambda a: persona(a) if a == "praw" else None, all=lambda: [persona()])
    ctx = types.SimpleNamespace(config=cfg, log=log, db=db, personas=ps, approver_policy=policy or Policy(),
                                providers={})
    ctx.budget = Guard(ctx)
    app = types.SimpleNamespace(ctx=ctx, cfg=cfg, log=log, intake=intake, system_channel=admin,
                                gate=types.SimpleNamespace(approver_role_id=APPROVER_ROLE))
    N.register_budget(app)
    return app, admin, cmds


async def test_view_lists_spend_and_limits(db, tmp_path):
    app, _, _ = world(db, tmp_path)
    await app.ctx.budget.record("praw", "google", "m", Usage(), "image", units=1)
    i = inter(uid=HUMAN + 5)  # anyone may view
    await N.budget_view(app, i)
    text, eph = i.response.said[0]
    assert eph and "praw: $" in text and "/ $2.00" in text and "_gate" in text and "resets" in text


async def test_set_by_approver_and_non_approver(db, tmp_path):
    app, _, _ = world(db, tmp_path)
    bad = inter(uid=HUMAN + 1)
    await N.budget_set(app, bad, "praw", "5")
    assert bad.response.said[0][0] == N.NOT_APPROVER and await repo.limit(db, "praw") is None  # no row
    ok = inter()
    await N.budget_set(app, ok, "praw", "5")
    assert await repo.limit(db, "praw") == 5_000_000
    for a, v in (("nope", "5"), ("praw", "NaN"), ("praw", "abc"), ("praw", "5000")):
        i = inter()
        await N.budget_set(app, i, a, v)
        assert await repo.limit(db, "praw") == 5_000_000 and i.response.said


async def test_set_refused_on_bad_origin(db, tmp_path):
    app, _, _ = world(db, tmp_path)
    for i in (inter(typ=discord.InteractionType.component), inter(guild=7), inter(guild=None)):
        await N.budget_set(app, i, "praw", "5")
        assert i.response.said[0][0] == strings.NOT_ALLOWED
    assert await repo.limit(db, "praw") is None
    cli = world(db, tmp_path, policy=types.SimpleNamespace(surface="cli", is_approver=Policy().is_approver))[0]
    await N.budget_set(cli, inter(), "praw", "5")
    assert await repo.limit(db, "praw") is None


async def test_notifier_once_per_level_role_only(db, tmp_path):
    app, admin, cmds = world(db, tmp_path)
    assert len(cmds) == 1 and cmds[0].name == "budget" and app.ctx.budget.notifier is not None
    await app.ctx.budget.set_limit("praw", Decimal("1"), N.Actor("discord", str(HUMAN)))
    await repo.insert_usage(db, "praw", today(), "g", "m", "chat", 0, 0, 0, 850_000, None)
    for _ in range(3):
        assert await app.ctx.budget.level("praw") == "warn"
    assert len(admin.sent) == 1
    m = admin.sent[0]
    assert m.content.startswith(f"<@&{APPROVER_ROLE}>") and "80%" in m.content
    am = m.mentions
    assert [r.id for r in am.roles] == [APPROVER_ROLE] and am.users is False and am.everyone is False
    await repo.insert_usage(db, "praw", today(), "g", "m", "chat", 0, 0, 0, 400_000, None)
    assert await app.ctx.budget.level("praw") == "stop"
    assert len(admin.sent) == 2 and "120%" in admin.sent[1].content


def test_scan_alert(tmp_path):
    cfg = Config.load({**base_env(tmp_path), "DISCORD_BOT_TOKEN_PRAW": "tok-praw-aaaaaaaaaaaaaaaa",
                      "DISCORD_APP_ID_PRAW": "555555555555555501", "DISCORD_BOT_TOKEN_SYSTEM": "tok-system-dddddddddddddddd",
                      "DISCORD_APP_ID_SYSTEM": "555555555555555502",
                      "CHANNEL_ALLOWLIST": str(ALLOWED)})
    got = []
    N.post_scan_alert(cfg, "employee-audit.service", "1", post=lambda *a: got.append(a))
    assert got == [("tok-system-dddddddddddddddd", 3, "weekly scan failed: employee-audit.service (exit 1)")]
    for u, s in (("a b", "1"), ("u\nx", "1"), ("u", "1; rm"), ("u" * 80, "1")):
        with pytest.raises(ValueError):
            N.scan_text(u, s)
    with pytest.raises(RuntimeError, match="missing_system_token"):  # A7: never the intake token
        N.post_scan_alert(Config.load({**base_env(tmp_path), "DISCORD_BOT_TOKEN_PRAW": "tok-praw-aaaaaaaaaaaaaaaa",
                                       "DISCORD_APP_ID_PRAW": "555555555555555501", "CHANNEL_ALLOWLIST": str(ALLOWED)}),
                          "u", "1", post=lambda *a: None)


async def test_a7_notifier_unavailable_without_system(db, tmp_path):
    app, admin, _ = world(db, tmp_path)
    app.system_channel = None                      # D4: never a Praw fallback
    with pytest.raises(RuntimeError, match="notify_unavailable"):
        await app.ctx.budget.notifier("praw", "warn80", 1, 2)
    assert not admin.sent
