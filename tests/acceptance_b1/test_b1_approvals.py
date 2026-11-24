"""021B-T: AC-4 approval buttons (AI-Admin role only, ephemeral refusal), forged/rebound buttons (S1210-02, G2-07)."""
import asyncio

from core.discord import strings
from tests.acceptance_b1.harness import ALLOWED, APPROVAL, APPROVER_ROLE, HUMAN, OUTSIDE, launch

SMALL = ["praw", "tek", "fahsai"]


async def settle(n=0.3):
    await asyncio.sleep(n)


async def pending(tmp_path, monkeypatch):
    """Human asks praw; the fake model calls approval_request; returns (run, card message, approval id, custom ids)."""
    r = await launch(tmp_path, monkeypatch, SMALL)
    await r.say(ALLOWED, "NEEDAPPROVAL please", to="praw")
    await settle()
    cards = [m for m in r.ch(APPROVAL).sent if m.embed is not None]
    assert len(cards) == 1, "exactly one approval card in the approval channel"
    ids = {b.label: b.custom_id for b in cards[0].view.children}
    aid = ids["Approve"].split(":", 3)[3]
    return r, cards[0], aid, ids


async def status(r, aid):
    return await r.ctx.db.fetchrow("SELECT status, decided_by FROM approvals WHERE id=?1", aid)


async def test_card_has_two_buttons_and_admin_approves_agent_resumes(tmp_path, monkeypatch):
    r, card, aid, ids = await pending(tmp_path, monkeypatch)
    assert set(ids) == {"Approve", "Reject"} and (await status(r, aid))["status"] == "pending"
    assert card.embed.title.startswith("Approval needed") and card.mentions.everyone is False
    i = r.interaction(ch=r.ch(APPROVAL), user_id=HUMAN, roles=[APPROVER_ROLE], message=card, custom_id=ids["Approve"])
    out = await r.click(i)
    assert out[0][0] == "defer" and out[-1][1] == strings.APPROVED and out[-1][2] == {"ephemeral": True}
    row = await status(r, aid)
    assert row["status"] == "approved" and row["decided_by"].endswith(str(HUMAN)), dict(row)
    await settle(0.5)
    assert any("Thanks, approval received" in (t or "") for t in r.world.texts(ALLOWED))      # agent resumed, answered in channel
    assert any(f.name == "Status" and "approved" in f.value for f in card.embed.fields), "card edited to the decided status"
    assert card.view is None, "buttons removed once decided"
    # second click on the decided card: refused, status unchanged
    out = await r.click(r.interaction(ch=r.ch(APPROVAL), user_id=HUMAN, roles=[APPROVER_ROLE], message=card, custom_id=ids["Reject"]))
    assert (await status(r, aid))["status"] == "approved" and out[-1][1] != strings.REJECTED
    await r.stop()


async def test_non_admin_click_is_ephemeral_refusal_and_changes_nothing(tmp_path, monkeypatch):
    r, card, aid, ids = await pending(tmp_path, monkeypatch)
    for uid, roles in ((HUMAN + 1, []), (HUMAN + 1, [APPROVER_ROLE + 1])):   # plain member; a role that is not the approver role
        i = r.interaction(ch=r.ch(APPROVAL), user_id=uid, roles=roles, message=card, custom_id=ids["Approve"])
        out = await r.click(i)
        assert out[-1][1] == strings.NOT_APPROVER and out[-1][2] == {"ephemeral": True}
    # roles carried on the interaction are NOT trusted: policy refetches the member (G1-14.4)
    i = r.interaction(ch=r.ch(APPROVAL), user_id=HUMAN + 1, roles=[APPROVER_ROLE], message=card, custom_id=ids["Approve"])
    assert (await r.click(i))[-1][1] == strings.NOT_APPROVER
    assert (await status(r, aid))["status"] == "pending"
    await r.stop()


async def test_forged_button_on_another_message_refused(tmp_path, monkeypatch):
    r, card, aid, ids = await pending(tmp_path, monkeypatch)
    admin_line = await r.ch(ALLOWED).send(content="praw says hi")  # a real message by the intake bot, but not the stored card
    other_persona = await r.ch(ALLOWED, "tek").send(content="tek says hi")      # a message by another persona client
    forged = [
        dict(message=admin_line, pid="praw"),                 # right author, wrong message id
        dict(message=other_persona, pid="tek"),               # other client, other message
        dict(message=card, pid="tek"),                        # right message id, but the click is delivered to tek's client
        dict(message=None, pid="praw"),                       # no message at all
    ]
    for f in forged:
        i = r.interaction(ch=r.ch(APPROVAL), user_id=HUMAN, roles=[APPROVER_ROLE], message=f["message"], custom_id=ids["Approve"],
                          client_pid=f["pid"])
        out = await r.click(i, f["pid"])
        assert [o[:2] for o in out] == [("resp", strings.BUTTON_INACTIVE)], (f, out)
        assert (await status(r, aid))["status"] == "pending"
    for bad in ("emp:appr:approve:not-a-uuid", "emp:zzz:approve:" + aid, "emp:appr:approve:" + aid + "x", "x" * 300, None):
        i = r.interaction(ch=r.ch(APPROVAL), user_id=HUMAN, roles=[APPROVER_ROLE], message=card, custom_id=bad)
        assert (await r.click(i))[0][1] == strings.BUTTON_INACTIVE
    assert (await status(r, aid))["status"] == "pending"
    await r.stop()


async def test_forged_actor_origins_refused(tmp_path, monkeypatch):
    r, card, aid, ids = await pending(tmp_path, monkeypatch)
    for mut in (dict(bot=True), dict(user_id=0)):             # a bot account clicking, and a non-int-like user
        i = r.interaction(ch=r.ch(APPROVAL), user_id=mut.get("user_id", HUMAN), roles=[APPROVER_ROLE], message=card,
                          custom_id=ids["Approve"], bot=mut.get("bot", False))
        out = await r.click(i)
        assert out[-1][1] in (strings.NOT_APPROVER, strings.INTERNAL_ERROR)   # id 0 is not a snowflake: fail closed either way
    i = r.interaction(ch=r.ch(APPROVAL), message=card, custom_id=ids["Approve"], roles=[APPROVER_ROLE])
    i.guild_id = 5                                             # wrong guild
    assert (await r.click(i))[-1][1] in (strings.NOT_APPROVER, strings.NOT_ALLOWED)
    assert (await status(r, aid))["status"] == "pending"
    await r.stop()


async def test_reject_by_admin_and_card_outside_allowlist_click_refused(tmp_path, monkeypatch):
    r, card, aid, ids = await pending(tmp_path, monkeypatch)
    i = r.interaction(ch=r.ch(OUTSIDE), user_id=HUMAN, roles=[APPROVER_ROLE], message=card, custom_id=ids["Reject"])
    assert (await r.click(i)) == [("resp", strings.NOT_ALLOWED, {"ephemeral": True})] and (await status(r, aid))["status"] == "pending"
    i = r.interaction(ch=r.ch(APPROVAL), user_id=HUMAN, roles=[APPROVER_ROLE], message=card, custom_id=ids["Reject"])
    assert (await r.click(i))[-1][1] == strings.REJECTED and (await status(r, aid))["status"] == "rejected"
    await settle(0.4)
    assert any("approval rejected" in (t or "") for t in r.world.texts(ALLOWED))
    await r.stop()
