"""TASK-013B: Discord approver policy, appr button handler, G2-07 actor helper."""
import types

import discord
import pytest
import pytest_asyncio

from core.approvals.service import PgApprovalService
from core.discord import client as C, strings
from core.discord.approver import DiscordRoleApproverPolicy, actor_from_interaction
from core.discord.buttons import make_custom_id
from core.discord.embeds import DiscordApprovalPresenter
from core.interfaces import Actor
from tests.discord_fakes import APPROVER_ROLE, G, HUMAN, Member, FakeLog
from tests.test_discord_layer import world


@pytest_asyncio.fixture
async def w(tmp_path, db):
    w = world(tmp_path)
    w.g.fetch_member = lambda i: _fetch(w.g, i)
    w.ctx.db = w.app.router.db = db
    w.ctx.approver_policy = DiscordRoleApproverPolicy(lambda: w.g, lambda: w.app.gate.approver_role_id, w.ctx.log)
    w.ctx.approvals = svc = PgApprovalService(db, w.cfg, w.ctx.log, w.ctx.approver_policy, DiscordApprovalPresenter(w.app))
    w.woke = []

    async def wake(row): w.woke.append(row["status"])
    svc.register_handler("generic", wake)
    w.app.listen("on_interaction", w.app.router.dispatch)
    w.app.router.register("appr", C.make_approval_button_handler(w.app))
    w.aid = await svc.request(kind="generic", title="t", summary="s", access=[], requested_by="praw", origin="discord",
                              human_user_id=HUMAN, origin_channel_id=5, origin_thread_id=None, payload={})
    w.card = w.ch["appr"].sent[0]
    return w


async def _fetch(g, i):
    if i in g._m:
        return g._m[i]
    raise discord.NotFound(types.SimpleNamespace(status=404, reason=""), "x")


def click(w, uid=HUMAN, action="approve", mid=None, guild=G, ch=None):
    out = []
    ch = ch or w.ch["appr"]
    i = types.SimpleNamespace(
        type=discord.InteractionType.component, data={"custom_id": make_custom_id("appr", action, w.aid)}, out=out,
        user=types.SimpleNamespace(id=uid, bot=False, display_name="h"), guild_id=guild, channel=ch, channel_id=ch.id,
        guild=types.SimpleNamespace(id=guild) if guild else None,
        client=types.SimpleNamespace(user=w.bot.user), message=types.SimpleNamespace(id=mid or w.card.id, author=w.bot.user),
        response=types.SimpleNamespace(send_message=_rec(out, "resp"), defer=_rec(out, "defer"), is_done=lambda: False),
        followup=types.SimpleNamespace(send=_rec(out, "follow")))
    return i


def _rec(out, tag):
    async def f(*a, **k): out.append((tag, a, k))
    return f


async def press(w, i):
    await w.app.listeners["on_interaction@praw"](i)
    return [o for o in i.out if o[0] == "follow"]


async def status(w):
    return await w.ctx.db.fetchval("SELECT status FROM approvals WHERE id=?1", w.aid)


async def test_approver_click_approves_once(w):
    f = await press(w, click(w))
    assert f[0][1] == (strings.APPROVED,) and f[0][2]["ephemeral"] is True
    assert await status(w) == "approved"
    assert await w.ctx.db.fetchval("SELECT decided_by FROM approvals WHERE id=?1", w.aid) == f"discord:{HUMAN}"
    f = await press(w, click(w, action="reject"))
    assert f[0][1] == (strings.ALREADY_DECIDED,) and await status(w) == "approved"
    import asyncio
    await asyncio.gather(*w.ctx.approvals._tasks)
    assert w.woke == ["approved"]


async def test_non_approver_ephemeral_row_unchanged(w):
    f = await press(w, click(w, uid=HUMAN + 1))
    assert f[0][1] == (strings.NOT_APPROVER,) and f[0][2]["ephemeral"] is True and await status(w) == "pending"


async def test_forged_or_other_message_refused(w):
    i = click(w, mid=1)
    await press(w, i)
    assert i.out[-1][0] == "resp" and strings.BUTTON_INACTIVE in i.out[-1][1][0] and await status(w) == "pending"


async def test_expired(w):
    await w.ctx.db.execute("UPDATE approvals SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?1", w.aid)
    f = await press(w, click(w))
    assert f[0][1] == (strings.EXPIRED,) and await status(w) == "pending"


async def test_outside_allowlist_click_refused_by_gate(w):
    i = click(w, ch=w.ch["outside"])
    assert await press(w, i) == [] and await status(w) == "pending"


async def test_dm_and_non_interaction_actor_refused(w):
    assert actor_from_interaction(w.app, click(w, guild=None)) is None
    assert actor_from_interaction(w.app, types.SimpleNamespace(user=types.SimpleNamespace(id=HUMAN))) is None
    assert actor_from_interaction(w.app, click(w, ch=w.ch["outside"])) is None
    assert actor_from_interaction(w.app, click(w)).ref == f"discord:{HUMAN}"


async def test_policy_fail_closed(w):
    p = DiscordRoleApproverPolicy(lambda: w.g, lambda: APPROVER_ROLE, w.ctx.log)
    w.g._m[HUMAN + 5] = Member(HUMAN + 5, [APPROVER_ROLE])
    w.g.fetch_member = lambda i: type(w.g).fetch_member(w.g, i)  # default fake raises NotFound
    assert await p.is_approver(Actor("discord", str(HUMAN + 5))) is False
    assert w.ctx.log.events("approval.policy_error")[0]["error"] == "NotFound"
    w.g.fetch_member = lambda i: _fetch(w.g, i)
    assert await p.is_approver(Actor("discord", str(HUMAN))) is True
    assert await p.is_approver(Actor("discord", str(HUMAN + 1))) is False  # no role
    assert await p.is_approver(Actor("cli", "admin")) is False
    assert not await DiscordRoleApproverPolicy(lambda: w.g, lambda: None, w.ctx.log).is_approver(Actor("discord", str(HUMAN)))
    assert not await DiscordRoleApproverPolicy(lambda: None, lambda: APPROVER_ROLE, w.ctx.log).is_approver(Actor("discord", str(HUMAN)))


async def test_embed_shows_origin_and_setup_replaces_deny_all(w):
    names = [f.name for f in w.card.embed.fields]
    assert "Origin" in names and "Triggered by" in names
    w.ctx.approver_policy = C.DenyAllApproverPolicy()
    w.ctx.discord_message_handler = None
    w.ctx.bot = None
    app = C.setup_discord(w.ctx, {"praw": w.bot})
    assert isinstance(w.ctx.approver_policy, DiscordRoleApproverPolicy) and w.ctx.approvals.policy is w.ctx.approver_policy
    assert "appr" in app.router._h
