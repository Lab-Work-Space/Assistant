"""TASK-031 R7/R8/R9: /task /approval /setting commands, approval cards and routing to department channels (fakes only)."""
import json
import types

import discord
import pytest
import pytest_asyncio

from core.approvals.service import PgApprovalService
from core.config import Config, ConfigError
from core.discord import commands as K, strings
from core.discord.client import Refusal
from core.discord.embeds import DiscordApprovalPresenter, approval_embed
from core.discord.syslog import FORWARD_KEYS
from core.settings.service import KEYS, SettingsService
from tests.conftest import base_env
from tests.discord_fakes import ADMIN, ALLOWED, G, HUMAN, OTHER, Channel, Msg
from tests.test_approvals_routing import REG, Log, routine
from tests.test_discord_layer import denv, ready, world
from tests.test_tasks import make

from datetime import date, timedelta  # noqa: E402

LATER = (date.today() + timedelta(days=10)).isoformat()
CMD = discord.InteractionType.application_command
APPROVER = HUMAN + 9
STRANGER = HUMAN + 1


class Policy:
    surface = "discord"

    def __init__(self):
        self.calls = 0

    async def is_approver(self, a):
        self.calls += 1
        return a.user_id == str(APPROVER)


class Resp:
    def __init__(self):
        self.said = []

    async def send_message(self, text, ephemeral=False):
        self.said.append((text, ephemeral))

    def is_done(self):
        return bool(self.said)


def inter(w, uid=HUMAN, ch=None, typ=CMD, guild=G):
    ch = ch or w.ch["allowed"]
    return types.SimpleNamespace(type=typ, user=types.SimpleNamespace(id=uid, bot=False, display_name="x"), guild_id=guild, channel=ch,
                                 channel_id=ch.id, response=Resp())


def said(i):
    return i.response.said[-1][0] if i.response.said else None


@pytest_asyncio.fixture
async def w(tmp_path, db):
    w = world(tmp_path, SETTINGS_CHANNEL_ID=str(OTHER))
    e = make(db)
    w.e, w.pol, ctx = e, Policy(), e.ctx
    ctx.approver_policy = w.pol
    w.app.ctx = ctx
    ctx.settings = SettingsService(db, w.cfg, w.app.log, REG)
    ctx.approvals = PgApprovalService(db, w.cfg, w.log, w.pol, DiscordApprovalPresenter(w.app), personas=REG,
                                      settings=ctx.settings, classify=routine())

    async def noop(row): return None
    ctx.approvals.register_handler("generic", noop)
    w.app.bots.update({p.id: w.bot for p in REG.all()})  # R24: a head needs its own client
    K.register_commands(w.app)
    w.db = db
    w.log = w.app.log
    return w


async def mk_task(w, by="1" + str(HUMAN), kind="human", dept="FIN"):
    return await w.e.svc.repo.insert_task(guild_id=G, channel_id=ALLOWED, title="Plan the quarter", description="Plan the quarterly numbers.",
                                          kind=kind, by_id=by, assignee="dev", dept=dept, priority="low", due="2030-01-01", value_thb=1200)


# ---- /task ---------------------------------------------------------------------------------------------------------
async def test_task_show_requester_approver_other_and_enumeration_safe(w):
    t = await mk_task(w, by=str(HUMAN))
    i = inter(w)
    await K.task_show(w.app, i, " " + t["code"].lower() + " ")
    assert t["code"] in said(i) and "1,200 THB" in said(i) and i.response.said[0][1] is True and w.pol.calls == 0  # requester: no member fetch
    i = inter(w, APPROVER)
    await K.task_show(w.app, i, t["code"])
    assert t["code"] in said(i) and w.pol.calls == 1
    outs = []
    for code in (t["code"], "FIN-9999", "nonsense", "x" * 500, "", "TASK-1; DROP TABLE tasks"):
        i = inter(w, STRANGER)
        await K.task_show(w.app, i, code)
        outs.append(said(i))
    assert set(outs) == {K.DENIED} and w.pol.calls == 2  # one fetch for the real code only; malformed / unknown codes never reach the policy
    assert {(m, f["kind"]) for m, f in [(m, f) for m, f in w.log.rows if m == "command.denied"]} == {("command.denied", "task_show")}


async def test_task_legacy_code_lookup(w):
    t = await mk_task(w, by=str(HUMAN))
    await w.db.execute("UPDATE tasks SET code='TASK-7' WHERE id=?1", t["id"])
    i = inter(w)
    await K.task_show(w.app, i, "task-7")
    assert "TASK-7" in said(i)


async def test_task_edit_validates_audits_and_refreshes_embed(w):
    t = await mk_task(w, by=str(HUMAN))
    for field, val, ok in (("title", "New title", True), ("description", "short", False), ("description", "A fresh description long enough.", True),
                           ("priority", "urgent", True), ("priority", "meh", False), ("due", LATER, True), ("due", "2020-01-01", False),
                           ("value_thb", "2,500", True), ("value_thb", "abc", False), ("value_thb", "-3", False), ("bogus", "x", False)):
        i = inter(w)
        await K.task_edit(w.app, i, t["code"], field, val)
        assert ("updated" in said(i)) is ok, (field, val, said(i))
    n = await w.db.fetchrow("SELECT * FROM tasks WHERE code=?1", t["code"])
    assert (n["title"], n["priority"], n["due"], n["value_thb"]) == ("New title", "urgent", LATER, 2500)
    audit = await w.db.fetch("SELECT field, old_value, new_value, actor FROM audit_log WHERE scope='task' AND action='edit' ORDER BY id")
    assert audit[0] == {"field": "title", "old_value": "Plan the quarter", "new_value": "New title", "actor": f"discord:{HUMAN}"} and len(audit) == 5
    assert w.e.port.edits and [f for n_, f in w.e.ctx.log.recs if n_ == "task.edited"][0]["kind"] == "title"
    i = inter(w)
    await K.task_edit(w.app, i, t["code"], "title", "x" * 257)
    assert said(i) == "Invalid input. / ข้อมูลไม่ถูกต้อง"
    await w.db.execute("UPDATE tasks SET status='done' WHERE code=?1", t["code"])
    i = inter(w)
    await K.task_edit(w.app, i, t["code"], "title", "Too late")
    assert "closed" in said(i)
    i = inter(w, STRANGER)
    await K.task_edit(w.app, i, t["code"], "title", "Hack")
    assert said(i) == K.DENIED and (await w.db.fetchval("SELECT title FROM tasks WHERE code=?1", t["code"])) == "New title"


async def test_task_cancel_soft_and_shared_with_button_path(w):
    t = await mk_task(w, by=str(HUMAN))
    i = inter(w, STRANGER)
    await K.task_cancel(w.app, i, t["code"])
    assert said(i) == K.DENIED and (await w.db.fetchval("SELECT status FROM tasks WHERE code=?1", t["code"])) == "open"
    i = inter(w)
    await K.task_cancel(w.app, i, t["code"], "no longer needed")
    assert "cancelled" in said(i)
    r = await w.db.fetchrow("SELECT * FROM tasks WHERE code=?1", t["code"])
    assert r["status"] == "cancelled"  # soft: row kept
    a = await w.db.fetchrow("SELECT * FROM audit_log WHERE scope='task' AND action='cancel'")
    assert (a["ref"], a["actor"], a["new_value"]) == (t["code"], f"discord:{HUMAN}", "cancelled: no longer needed")
    i = inter(w)
    await K.task_cancel(w.app, i, t["code"])
    assert "closed" in said(i)
    assert [f for n, f in w.e.ctx.log.recs if n == "task.cancelled"][0]["task"] == t["code"]


# ---- /approval -----------------------------------------------------------------------------------------------------
async def mk_apr(w, **kw):
    a = dict(kind="generic", title="Buy pens", summary="Buy ten pens for the team", access=[], requested_by="sub", origin="discord",
             human_user_id=HUMAN, origin_channel_id=ALLOWED, origin_thread_id=None, payload={}, reason="r", value_thb=100,
             priority="low", due="2030-01-01")
    a.update(kw)
    return await w.e.ctx.approvals.request(**a)


async def test_approval_show_and_cancel_authz(w):
    aid = await mk_apr(w)
    code = await w.db.fetchval("SELECT code FROM approvals WHERE id=?1", aid)
    assert code == "APR-FIN-0001"
    i = inter(w)
    await K.approval_show(w.app, i, code.lower())
    assert code in said(i) and "dept_routine" in said(i) and w.pol.calls == 0
    for fn in (K.approval_show, K.approval_cancel):
        for c in (code, "APR-FIN-0099", "FIN-0001", "bad"):
            i = inter(w, STRANGER)
            await fn(w.app, i, c)
            assert said(i) == K.DENIED
    assert (await w.db.fetchval("SELECT status FROM approvals WHERE id=?1", aid)) == "pending"
    i = inter(w)
    await K.approval_cancel(w.app, i, code, "oops")
    assert "cancelled" in said(i) and (await w.db.fetchval("SELECT status FROM approvals WHERE id=?1", aid)) == "cancelled"
    i = inter(w, APPROVER)
    await K.approval_cancel(w.app, i, code)
    assert "Nothing to cancel" in said(i)
    assert await w.db.fetchval("SELECT count(*) FROM approvals") == 1


async def test_commands_are_gate_first_bounded_and_no_autocomplete(w):
    out = inter(w, ch=w.ch["outside"])
    t = await mk_task(w, by=str(HUMAN))
    for fn, args in ((K.task_show, (t["code"],)), (K.task_cancel, (t["code"],)), (K.approval_show, ("APR-FIN-0001",)), (K.setting_view, ())):
        out.response.said.clear()
        await fn(w.app, out, *args)
        assert out.response.said == [(strings.NOT_ALLOWED, True)]  # refused before any lookup
    assert w.pol.calls == 0 and (await w.db.fetchval("SELECT status FROM tasks")) == "open"
    for bad in (inter(w, typ=discord.InteractionType.component), inter(w, guild=7), inter(w, guild=None)):
        await K.task_show(w.app, bad, t["code"])
        assert bad.response.said and t["code"] not in said(bad)
    allc = w.app.intake.commands
    groups = allc[:3]
    assert [g.name for g in allc][:3] == ["task", "approval", "setting"]  # growth commands follow (T5)
    subs = {(g.name, c.name) for g in groups for c in g.subcommands}
    assert subs == {("task", "show"), ("task", "edit"), ("task", "cancel"), ("approval", "show"), ("approval", "cancel"),
                    ("setting", "view"), ("setting", "set"), ("setting", "reset")}
    for g in groups:
        for c in g.subcommands:
            for o in c.options:
                assert getattr(o, "autocomplete", None) is None  # codes are never listed
                if o.name == "code":
                    assert o.max_length == 24
                if o.name in ("value", "reason", "key"):
                    assert o.max_length in (200, 256, 64)


# ---- /setting ------------------------------------------------------------------------------------------------------
async def test_setting_refusals_and_changes(w):
    sch = w.ch["kid"]  # SETTINGS_CHANNEL_ID == OTHER
    i = inter(w, APPROVER, ch=w.ch["allowed"])
    await K.setting_set(w.app, i, "approval.hq_threshold_thb", "5000")
    assert said(i) == K._SETTING_ERR["wrong_channel"]
    i = inter(w, APPROVER, ch=w.ch["thread"])
    await K.setting_set(w.app, i, "approval.hq_threshold_thb", "5000")
    assert said(i) == K._SETTING_ERR["wrong_channel"]  # threads of the channel do not count
    i = inter(w, STRANGER, ch=sch)
    await K.setting_set(w.app, i, "approval.hq_threshold_thb", "5000")
    assert said(i) == K._SETTING_ERR["not_approver"]
    for key, val, err in (("approval.nope", "1", "unknown_key"), ("approval.hq_threshold_thb", "-1", "invalid_value"),
                          ("approval.channel.fin", str(w.ch["outside"].id), "invalid_value"), ("approval.channel.fin", str(ADMIN), "invalid_value"),
                          ("approval.channel.fin", str(OTHER), "invalid_value")):
        i = inter(w, APPROVER, ch=sch)
        await K.setting_set(w.app, i, key, val)
        assert said(i) == K._SETTING_ERR[err], (key, val)
    assert await w.db.fetchval("SELECT count(*) FROM settings") == 0 and await w.db.fetchval("SELECT count(*) FROM audit_log") == 0
    i = inter(w, APPROVER, ch=sch)
    await K.setting_set(w.app, i, "approval.hq_threshold_thb", "5,000")
    assert said(i) == "approval.hq_threshold_thb: 10000 -> 5000" and await w.e.ctx.settings.threshold() == 5000
    i = inter(w, APPROVER, ch=sch)
    await K.setting_set(w.app, i, "approval.channel.fin", str(ALLOWED))
    assert "->" in said(i) and await w.e.ctx.settings.approval_channel("fin") == str(ALLOWED)
    i = inter(w, APPROVER, ch=sch)
    await K.setting_view(w.app, i, "approval.hq_threshold_thb")
    assert said(i) == "approval.hq_threshold_thb = 5000 (db)"
    i = inter(w, APPROVER, ch=sch)
    await K.setting_view(w.app, i)
    assert all(k in said(i) for k in ("approval.ttl_h", "approval.head.fin")) and i.response.said[0][1] is True
    i = inter(w, APPROVER, ch=sch)
    await K.setting_reset(w.app, i, "approval.hq_threshold_thb")
    assert "reset to 10000" in said(i) and await w.e.ctx.settings.threshold() == 10000
    acts = [r["action"] for r in await w.db.fetch("SELECT action FROM audit_log WHERE scope='setting' ORDER BY id")]
    assert acts == ["set", "set", "reset"]
    ch = [f for m, f in w.log.rows if m == "settings.changed"]
    assert [f["status"] for f in ch] == ["set", "set", "reset"] and all(set(f) == {"id", "by", "status"} for f in ch)


async def test_setting_channel_unset_refused(tmp_path, db):
    w = world(tmp_path)  # SETTINGS_CHANNEL_ID not configured
    w.ctx.db, w.ctx.approver_policy, w.ctx.settings = db, Policy(), SettingsService(db, w.cfg, w.log, REG)
    w.ctx.approver_policy.is_approver = Policy().is_approver
    i = inter(w, APPROVER)
    await K.setting_set(w.app, i, "approval.ttl_h", "5")
    assert said(i) == K._SETTING_ERR["settings_channel_unset"]


async def test_is_approver_exception_fails_closed_with_denied_reply_G2T031_04(w):
    async def boom(actor):
        raise RuntimeError("fetch_member exploded secret")
    w.pol.is_approver = boom
    t = await mk_task(w, by=str(HUMAN))
    i = inter(w, STRANGER)
    await K.task_show(w.app, i, t["code"])
    assert i.response.said == [(K.DENIED, True)]
    (f,) = [f for m, f in w.log.rows if m == "command.denied"]
    assert f["reason"] == "approver_check_failed" and "secret" not in json.dumps(f)


async def test_denial_logs_carry_only_fixed_tokens_T031_04(w):
    evil = "evil key with spaces <@123> secret"
    await K.setting_set(w.app, inter(w, APPROVER, ch=w.ch["kid"]), evil, "1")
    await K.setting_view(w.app, inter(w, STRANGER, ch=w.ch["kid"]), evil)
    await K.task_show(w.app, inter(w, STRANGER), evil)
    await K.approval_cancel(w.app, inter(w, STRANGER), evil)
    t = await mk_task(w, by=str(HUMAN))
    await K.task_show(w.app, inter(w, STRANGER), t["code"])
    rows = [(m, f) for m, f in w.log.rows if m in ("settings.denied", "command.denied")]
    assert len(rows) == 5
    for m, f in rows:
        assert "evil" not in json.dumps(f) and t["code"] not in json.dumps(f)
        assert f["id" if m == "settings.denied" else "kind"] in (*KEYS, "unknown", "task_show", "approval_cancel")
        assert set(f) <= {"id", "by", "reason", "kind"} and f["reason"] in ("unknown_key", "not_approver", "not_found", "not_allowed")
        assert all(" " not in str(v) for k, v in f.items() if k in FORWARD_KEYS)


# ---- presenter: department channels, fallback, card (R7, A13, A14) ----------------------------------------------------
async def test_dept_card_goes_to_dept_channel_hq_card_to_hq_and_fallback_warns(w):
    pres = w.e.ctx.approvals.presenter
    await w.e.ctx.settings.set("approval.channel.fin", str(ALLOWED), "cli:admin")
    aid = await mk_apr(w)
    a = await w.db.fetchrow("SELECT * FROM approvals WHERE id=?1", aid)
    assert (a["level"], a["channel_id"]) == ("dept", ALLOWED) and w.ch["allowed"].sent[-1].embed.title.startswith("Approval needed: APR-FIN-0001")
    b = await w.db.fetchrow("SELECT * FROM approvals WHERE id=?1", await mk_apr(w, value_thb=50000))
    assert (b["level"], b["channel_id"], b["code"]) == ("hq", w.ch["appr"].id, "APR-HQ-0001")
    for bad, why in ((str(w.ch["outside"].id), "not_allowed"), ("999999999999999999", "unresolved")):
        await w.db.execute("INSERT INTO settings (key,value,updated_by) VALUES ('approval.channel.fin',?1,'cli:admin') "
                           "ON CONFLICT(key) DO UPDATE SET value=excluded.value", bad)
        c = await w.db.fetchrow("SELECT * FROM approvals WHERE id=?1", await mk_apr(w))
        assert c["channel_id"] == w.ch["appr"].id
        assert w.log.events("approval.channel_fallback")[-1] == {"code": c["code"], "reason": why}
    assert pres is not None


async def test_card_fields_order_ai_note_and_escalated_card(w):
    aid = await mk_apr(w, other_depts=[], assignee="mali")
    a = await w.db.fetchrow("SELECT * FROM approvals WHERE id=?1", aid)
    names = [f.name for f in approval_embed(a).fields]
    assert names == ["Code", "Level", "Department", "Requested by", "Triggered by", "Assignee", "Priority", "Due", "Value (THB)", "Kind",
                     "Access", "Reason", "Routing", "Origin", "Status", "Note"]
    vals = {f.name: f.value for f in approval_embed(a).fields}
    assert vals["Level"] == "Department (FIN)" and vals["Value (THB)"] == "100 THB" and vals["Assignee"] == "mali" and vals["Code"] == "APR-FIN-0001"
    assert approval_embed({**a, "level": "hq"}).fields[1].value == "HQ"
    ai = {**a, "status": "approved", "decided_by": "agent:mali", "decision_reason": "routine and cheap"}
    note = {f.name: f.value for f in approval_embed(ai, "approved", "agent:mali").fields}["Decision note"]
    assert note == "AI decision by mali: routine and cheap — approvers may override"
    assert approval_embed(a, "cancelled").title == "Approval needed: APR-FIN-0001 Buy pens"
    # escalation edits the old card (no buttons) and posts a new one in the HQ channel
    pres = w.e.ctx.approvals.presenter
    edits = []

    class Part:
        async def edit(self, embed=None, view="x"): edits.append((embed.fields[14].value, view))
    w.ch["appr"].get_partial_message = lambda mid: Part()
    await pres.show_moved(w.ch["appr"].id, 5, {**a, "level": "hq"})
    assert edits == [("escalated to HQ", None)]


# ---- config / startup (R9) ----------------------------------------------------------------------------------------------
def test_settings_channel_env_optional_and_never_the_admin_channel(tmp_path):
    base = {**base_env(tmp_path), "ADMIN_NOTIFY_CHANNEL_ID": "3"}
    assert Config.load(base).settings_channel_id is None
    assert Config.load({**base, "SETTINGS_CHANNEL_ID": "1565667791938387969"}).settings_channel_id == 1565667791938387969
    with pytest.raises(ConfigError) as e:
        Config.load({**base, "SETTINGS_CHANNEL_ID": "3"})
    assert e.value.code == "admin_channel_shared"


async def test_intake_refuses_unresolved_or_unallowlisted_settings_channel(tmp_path):
    for sid in (str(OTHER + 20), "777777777777777777"):  # not allowlisted / not in the guild
        w = world(tmp_path, SETTINGS_CHANNEL_ID=sid)
        await ready(w)
        assert w.app.exit_code == 2 and w.app.refusal == "settings_channel_invalid"
    w = world(tmp_path, SETTINGS_CHANNEL_ID=str(OTHER))
    await ready(w)
    assert w.app.exit_code == 0


async def test_ai_decision_keeps_buttons_so_a_human_can_override_once_A10(w):
    from core.discord.approver import make_approval_button_handler
    from tests.test_approvals_routing import PS
    await w.e.ctx.settings.set("approval.channel.fin", str(ALLOWED), "cli:admin")
    aid = await mk_apr(w)
    edits = []

    class Part:
        async def edit(self, embed=None, view="unset"):
            edits.append((embed, view))
    w.ch["allowed"].get_partial_message = lambda mid: Part()
    w.e.ctx.approvals.presenter.app.intake.get_channel = lambda i: w.ch["allowed"] if i == ALLOWED else None
    assert await w.e.ctx.approvals.decide_as_head(aid, "approve", PS["mali"], "routine and low value") == "approved"
    embed, view = edits[-1]
    assert [c.label for c in view.children] == ["Approve", "Reject"]  # same custom ids: the click stays bound to this message
    assert {f.name: f.value for f in embed.fields}["Decision note"].startswith("AI decision by mali: routine and low value")
    out = []

    def click():
        return types.SimpleNamespace(type=discord.InteractionType.component, guild_id=G, channel=w.ch["allowed"], channel_id=ALLOWED,
                                     user=types.SimpleNamespace(id=APPROVER, bot=False, display_name="x"),
                                     followup=types.SimpleNamespace(send=lambda text, ephemeral=False: out.append(text) or _done()))
    h = make_approval_button_handler(w.app)
    await h(click(), "reject", aid)
    assert out == [strings.REJECTED] and edits[-1][1] is None  # human override: buttons gone
    assert (await w.db.fetchrow("SELECT status, overridden_from, decided_by FROM approvals WHERE id=?1", aid)) == {
        "status": "rejected", "overridden_from": "agent:mali", "decided_by": f"discord:{APPROVER}"}
    await h(click(), "approve", aid)
    assert out[-1] == strings.ALREADY_DECIDED  # human decisions are final


async def _done():
    return None
