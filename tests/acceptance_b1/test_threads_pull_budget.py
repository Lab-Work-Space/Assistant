"""021B-T: AC-2 delegation thread, AC-3 brainstorm thread, AC-6 attachment, AC-8 pull-user (thread/DM), /budget, notifier."""
import asyncio

import discord

from core.discord import strings
from tests.acceptance_b1.harness import (ADMIN, ALLOWED, APPROVAL, APPROVER_ROLE, CAT, G, HUMAN, OUTSIDE, TASKS, launch)

SMALL = ["praw", "tek", "fahsai"]


async def settle(n=0.4):
    await asyncio.sleep(n)


async def delegate(r, to="tek"):
    await r.say(ALLOWED, f"please delegate this task to {to}", to="praw")
    await settle(0.6)
    t = await r.ctx.db.fetchrow("SELECT * FROM tasks ORDER BY created_at DESC LIMIT 1")
    return t


async def test_delegation_thread_embed_and_own_identity(tmp_path, monkeypatch):
    r = await launch(tmp_path, monkeypatch, SMALL)
    t = await delegate(r)
    assert t is not None and t["thread_id"]
    tid = t["thread_id"]
    assert r.world.threads[tid] == ALLOWED                                       # thread is under the allowlisted channel
    embeds = [m for m in r.ch(ALLOWED).sent if m.embed is not None]
    assert len(embeds) == 1 and not [m for m in r.ch(ALLOWED, "tek").sent if m.embed is not None]   # task embed by the delegator (praw)
    assert "write the report" in embeds[0].embed.title or "write the report" in str(embeds[0].embed.description)
    assert any("reply from" in x for x in r.world.clients[r.uid("tek")].thread_texts(tid))   # assignee answers via ITS client
    assert not r.world.clients[r.uid("praw")].thread_texts(tid)
    assert t["embed_message_id"] == embeds[0].id
    await r.stop()


async def test_brainstorm_turn_limit_summary_and_alternating_clients(tmp_path, monkeypatch):
    r = await launch(tmp_path, monkeypatch, SMALL)
    orch = r.ctx.task_service.orch
    res = await orch.start(guild_id=G, channel_id=ALLOWED, topic="Launch plan", participants=["praw", "tek"], turn_limit=3,
                           caller="praw", kind="human", by_id=str(HUMAN))
    await orch.wait_idle()
    th = res["thread_id"]
    b = await r.ctx.db.fetchrow("SELECT status, close_reason, turns_used FROM brainstorm_threads WHERE thread_id=?1", th)
    assert (b["status"], b["close_reason"], b["turns_used"]) == ("closed", "turn_limit", 3)
    praw_t, tek_t = (r.world.clients[r.uid(p)].thread_texts(th) for p in ("praw", "tek"))
    assert len(tek_t) == 1 and len(praw_t) >= 2                                   # praw, tek, praw, then praw's summary
    assert r.world.threads[th] == ALLOWED and any("Brainstorm closed" in str(m.embed.title) for _, c, m in r.world.all if m.embed is not None)
    await r.stop()


async def test_task_thread_human_spam_is_bounded_by_turn_limit(tmp_path, monkeypatch):
    r = await launch(tmp_path, monkeypatch, SMALL)                               # BRAINSTORM_TURN_LIMIT=3 (harness default)
    t = await delegate(r)
    tid = t["thread_id"]
    th = r.world.clients[r.uid("praw")].get_channel(tid)
    before = r.prov.stream_calls
    for i in range(12):
        await r.say(tid, f"more more {i}", ch=th)
    await settle(0.8)
    row = await r.ctx.db.fetchrow("SELECT status, close_reason, turns_used FROM brainstorm_threads WHERE thread_id=?1", tid)
    assert row["status"] == "closed" and row["close_reason"] == "turn_limit", dict(row)
    spent = r.prov.stream_calls - before
    assert spent <= 3 + 1, spent                                                 # <= turn limit follow-ups + one summary, not 12
    await r.say(tid, "even more after close", ch=th)                             # after close: nothing more
    await settle()
    assert r.prov.stream_calls - before == spent
    await r.stop()


async def test_image_attachment_sanitised_and_masked(tmp_path, monkeypatch):
    r = await launch(tmp_path, monkeypatch, SMALL)
    await r.say(ALLOWED, "IMAGEQ draw a cat", to="praw")
    await settle(0.5)
    files = [m for m in r.ch(ALLOWED).sent if getattr(m, "file", None) is not None]
    assert len(files) == 1 and files[0].file.filename.endswith(".png") and "/" not in files[0].file.filename
    assert files[0].mentions.everyone is False
    await r.stop()


# ---- AC-8 pull-user ------------------------------------------------------------------------------------------------------
async def test_pull_user_dm_to_approver_and_thread_mention_for_plain_member(tmp_path, monkeypatch):
    r = await launch(tmp_path, monkeypatch, SMALL)
    await r.say(ALLOWED, f"PULLDM:{HUMAN + 1} get them", to="praw", uid=HUMAN + 3)   # target = plain member -> DM refused -> thread mention
    await settle(0.6)
    ments = [m for _, c, m in r.world.all if m.content and f"<@{HUMAN + 1}>" in m.content]   # posted in the invite thread
    assert r.world.threads and all(p == ALLOWED for p in r.world.threads.values())
    assert len(ments) == 1 and [u.id for u in ments[0].mentions.users] == [HUMAN + 1] and not ments[0].mentions.roles
    assert not r.world.dms.get(HUMAN + 1) or not r.world.dms[HUMAN + 1].sent        # coexist: no DM to a non-approver
    await r.say(ALLOWED, f"PULLDM:{HUMAN} get them", to="praw", uid=HUMAN + 3)       # target = approver-role holder -> DM invite
    await settle(0.6)
    dm = r.world.dms.get(HUMAN)
    assert dm is not None and len(dm.sent) == 1 and dm.sent[0].embed is not None and dm.sent[0].view is not None
    await r.stop()


async def test_pull_user_refuses_bot_self_and_outside(tmp_path, monkeypatch):
    r = await launch(tmp_path, monkeypatch, SMALL)
    await r.say(ALLOWED, f"PULLDM:{HUMAN + 2} x", to="praw", uid=HUMAN + 3)          # a bot account
    await r.say(ALLOWED, f"PULLDM:{HUMAN + 3} x", to="praw", uid=HUMAN + 3)          # self-pull
    await r.say(ALLOWED, f"PULLDM:{HUMAN + 77} x", to="praw", uid=HUMAN + 3)         # not a guild member
    await settle(0.8)
    assert not [m for _, c, m in r.world.all if m.content and "asks you to join" in m.content] and not r.world.dms
    ev = r.log_events("pulluser.done")
    assert [e["error"] for e in ev] == ["user_not_found", "invalid_target", "user_not_found"], ev
    await r.stop()


# ---- /budget + notifier -------------------------------------------------------------------------------------------------
async def test_budget_view_set_and_origin_rules(tmp_path, monkeypatch):
    from core.discord.notifier import budget_set, budget_view
    r = await launch(tmp_path, monkeypatch)                                          # all 20 personas
    app = r.app
    i = r.interaction(ch=r.ch(ALLOWED), kind="command", user_id=HUMAN + 1)
    await budget_view(app, i)
    txt = i.out[0][1]
    assert i.out[0][2] == {"ephemeral": True} and txt.count("/ $") == 21 and "praw: $0.00" in txt and "_gate" in txt
    i = r.interaction(ch=r.ch(ALLOWED), kind="command", user_id=HUMAN + 1)           # non-approver cannot set
    await budget_set(app, i, "praw", "5")
    assert "approver" in i.out[0][1].lower() and i.out[0][2] == {"ephemeral": True}
    i = r.interaction(ch=r.ch(ALLOWED), kind="command", user_id=HUMAN)               # approver sets
    await budget_set(app, i, "praw", "5")
    assert "set to $5.00" in i.out[0][1]
    i = r.interaction(ch=r.ch(ALLOWED), kind="command", user_id=HUMAN)
    await budget_view(app, i, "praw")
    assert "/ $5.00" in i.out[0][1]
    for bad_amount in ("0", "-1", "nan", "1001", "abc"):
        i = r.interaction(ch=r.ch(ALLOWED), kind="command", user_id=HUMAN)
        await budget_set(app, i, "praw", bad_amount)
        assert i.out[0][1].startswith(("Invalid", "Amount")), (bad_amount, i.out)
    i = r.interaction(ch=r.ch(ALLOWED), kind="command", user_id=HUMAN)
    await budget_set(app, i, "nobody", "5")
    assert i.out[0][1].startswith("Unknown")
    # forged origins (G2-07): a component interaction, a bot user, another guild -> refused, limit unchanged
    for mut in (dict(kind="component"), dict(bot=True)):
        i = r.interaction(ch=r.ch(ALLOWED), user_id=HUMAN, **mut)
        await budget_set(app, i, "praw", "999")
        assert i.out[0][1] == strings.NOT_ALLOWED
    i = r.interaction(ch=r.ch(ALLOWED), kind="command", user_id=HUMAN)
    i.guild_id = 5
    await budget_set(app, i, "praw", "999")
    assert i.out[0][1] == strings.NOT_ALLOWED
    i = r.interaction(ch=r.ch(ALLOWED), kind="command", user_id=HUMAN)
    await budget_view(app, i, "praw")
    assert "/ $5.00" in i.out[0][1]
    await r.stop()


async def test_budget_notice_posts_to_admin_channel_pinging_only_approver_role(tmp_path, monkeypatch):
    r = await launch(tmp_path, monkeypatch, SMALL, DISCORD_BOT_TOKEN_SYSTEM="tok-system-dddddddddddddddd", DISCORD_APP_ID_SYSTEM=4242)
    await r.ctx.budget.notifier("praw", "warn80", 800000, 1000000)
    assert not r.ch(ADMIN).sent                                       # Praw never posts in #bot-log (12.14)
    m = r.system_client.get_channel(ADMIN).sent[-1]
    assert "budget: praw reached 80%" in m.content and f"<@&{APPROVER_ROLE}>" in m.content
    assert [x.id for x in m.mentions.roles] == [APPROVER_ROLE] and m.mentions.everyone is False and not m.mentions.users
    await r.stop()


async def test_task_thread_moves_to_tasks_channel_when_assignee_cannot_see_origin(tmp_path, monkeypatch):
    """Live bug 2026-11-24: a head ordered work in the HQ lounge; the team member could not see the lounge thread."""
    r = await launch(tmp_path, monkeypatch, SMALL)
    r.ch(ALLOWED, "tek").denied.add(0)            # tek's client has no view of the origin channel
    t = await delegate(r)
    assert t is not None and t["thread_id"] and t["origin_channel_id"] == TASKS
    assert r.world.threads[t["thread_id"]] == TASKS
    await r.stop()
