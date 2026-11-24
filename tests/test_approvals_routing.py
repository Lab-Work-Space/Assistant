"""TASK-031: approval routing, codes, AI-head decisions, override, cancel, restart (fakes only, temp SQLite)."""
import asyncio
import json
import types
from pathlib import Path

import pytest

from core.agent_tools.approval import make_head_tools
from core.agent_tools.registry import Registry
from core.approvals.depts import code_of
from core.approvals.router import make_classifier
from core.approvals.service import PgApprovalService
from core.discord.buttons import Router, make_custom_id
from core.discord.syslog import FORWARD_KEYS, format_line
from core.interfaces import Actor, AgentResult, Persona, ToolCall, ToolContext, Usage
from core.tasks.repo import Repo

ADMIN, OTHER_ADMIN = Actor("cli", "admin"), Actor("cli", "boss")
MARK = "FREE TEXT MARKER do not forward"


def P(i, dept, tools=("*",)):
    return Persona(i, i.title(), (), "r", dept, "x/y", "x/y", "low", tools, (), 0, None, (), "", "p")


PS = {p.id: p for p in (P("praw", "praw"), P("mira", "exec"), P("mali", "account"), P("sub", "account"), P("tek", "dev"),
                        P("qin", "dev"), P("fahsai", "hr"), P("hrsub", "hr"), P("ghost", "nowhere"))}
REG = types.SimpleNamespace(get=PS.get, all=lambda: list(PS.values()))


class Log:
    def __init__(self):
        self.rows = []

    def write_log(self, system, message, level="INFO", **f):
        self.rows.append((message, level, f))

    def ev(self, name):
        return [f for m, _, f in self.rows if m == name]


class Policy:
    surface = "cli"

    async def is_approver(self, a):
        return a.user_id in ("admin", "boss")


class Presenter:
    def __init__(self):
        self.requests, self.decisions, self.moved, self.n = [], [], [], 100

    async def show_request(self, row):
        self.n += 1
        self.requests.append((row["code"], row["level"], self.n))
        return 7, self.n

    async def show_decision(self, row, actor):
        self.decisions.append((row["code"], row["status"]))

    async def show_moved(self, old_ch, old_msg, row):
        self.moved.append((old_ch, old_msg, row["code"]))


def routine(answer="routine"):
    async def c(card, aid):
        if isinstance(answer, Exception):
            raise answer
        return answer
    return c


class W:
    pass


def build(db, classify=None, engine=None):
    w = W()
    w.db, w.log, w.pres, w.woken = db, Log(), Presenter(), []
    cfg = types.SimpleNamespace(approval_ttl_h=24, discord_guild_id=1, admin_notify_channel_id=3, settings_channel_id=None)
    w.svc = PgApprovalService(db, cfg, w.log, Policy(), w.pres, personas=REG, classify=classify or routine(), engine=engine)

    async def wake(row):
        w.woken.append((row["code"], row["status"], row["decided_by"]))
    for k in ("generic", "config_change"):
        w.svc.register_handler(k, wake)
    return w


async def req(w, by="sub", **kw):
    a = dict(kind="generic", title="Buy pens", summary="Buy ten pens for the team", access=[], requested_by=by, origin="cli",
             human_user_id=None, origin_channel_id=5, origin_thread_id=None, payload={}, reason="r", value_thb=100,
             priority="low", due="2030-01-01")
    a.update(kw)
    return await w.svc.request(**a)


async def row(w, aid):
    return await w.db.fetchrow("SELECT * FROM approvals WHERE id=?1", aid)


async def setting(db, key, value):
    await db.execute("INSERT INTO settings (key, value, updated_by) VALUES (?1,?2,'cli:admin') "
                     "ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, value)


# ---- routing (R4, A4, A5) ----------------------------------------------------------------------------------
@pytest.mark.parametrize("kw,by,reason", [
    ({"kind": "config_change"}, "sub", "kind_dangerous"),
    ({"access": ["db"]}, "sub", "access_requested"),
    ({"value_thb": 10000}, "sub", "value_over_threshold"),
    ({"other_depts": ["hr"]}, "sub", "cross_dept"),
    ({}, "praw", "no_dept"), ({}, "mira", "no_dept"), ({}, "ghost", "no_dept"),
    ({}, "mali", "requester_is_head"),
    ({"for_dept": "nowhere"}, "praw", "no_dept"),
])
async def test_each_rule_routes_to_hq(db, kw, by, reason):
    w = build(db)
    r = await row(w, await req(w, by=by, **kw))
    assert (r["level"], r["route_reason"]) == ("hq", reason) and r["code"].startswith("APR-HQ-")
    assert w.pres.requests[-1][1] == "hq"


async def test_threshold_boundary_and_routine_goes_to_dept(db):
    w = build(db)
    r = await row(w, await req(w, value_thb=9999))
    assert (r["level"], r["route_reason"], r["dept"]) == ("dept", "dept_routine", "FIN") and r["code"] == "APR-FIN-0001"
    assert (await row(w, await req(w, value_thb=10000)))["route_reason"] == "value_over_threshold"
    await setting(db, "approval.hq_threshold_thb", "500")  # tunable, read from the DB every call
    assert (await row(w, await req(w, value_thb=500)))["route_reason"] == "value_over_threshold"
    assert (await row(w, await req(w, value_thb=499)))["level"] == "dept"


async def test_head_and_ai_switches_and_classifier_outcomes(db):
    w = build(db)
    await setting(db, "approval.head.fin", "none")
    assert (await row(w, await req(w)))["route_reason"] == "no_head"
    await setting(db, "approval.head.fin", "nobody")
    assert (await row(w, await req(w)))["route_reason"] == "no_head"
    await setting(db, "approval.head.fin", "mali")
    w.svc.settings.is_disabled = lambda pid: pid == "mali"
    assert (await row(w, await req(w)))["route_reason"] == "no_head"
    w.svc.settings.is_disabled = lambda pid: False
    await setting(db, "approval.ai_enabled", "off")
    assert (await row(w, await req(w)))["route_reason"] == "ai_disabled"
    await setting(db, "approval.ai_enabled", "on")
    for ans, why in (("major", "classifier_major"), ("anything else", "classifier_major"), (None, "classifier_unavailable"),
                     (RuntimeError(MARK), "classifier_unavailable")):
        w.svc.router.classify = routine(ans)
        assert (await row(w, await req(w)))["route_reason"] == why
    (f,) = w.log.ev("approval.classify_failed")
    assert f == {"error": "RuntimeError"}  # type only, T031-04c


async def test_classifier_runs_only_after_rules_1_to_8(db):
    seen = []

    async def spy(card, aid):
        assert not db._lock.locked()  # T031-08: no LLM call while BEGIN IMMEDIATE / the DB lock is held
        seen.append(aid)
        return "routine"
    w = build(db, classify=spy)
    for kw, by in (({"kind": "config_change"}, "sub"), ({"access": ["x"]}, "sub"), ({"value_thb": 10**6}, "sub"), ({}, "praw"), ({}, "mali")):
        await req(w, by=by, **kw)
    assert seen == []
    aid = await req(w)
    assert seen == [aid]  # one call, the id is the future row id (T031-03 ref)


async def test_for_dept_sets_department_and_rate_limit_precheck(db):
    w = build(db)
    r = await row(w, await req(w, by="praw", for_dept="hr"))
    assert (r["level"], r["dept"], r["code"]) == ("dept", "HR", "APR-HR-0001")
    await setting(db, "approval.rate_per_day", "2")
    calls = []
    w.svc.router.classify = lambda c, a: calls.append(1) or routine()(c, a)
    await req(w, by="sub")
    await req(w, by="sub")
    n = len(calls)
    with pytest.raises(ValueError, match="rate_limited"):
        await req(w, by="sub")
    assert len(calls) == n  # no classifier spend once the limit is hit


# ---- classifier billing (T031-03) ----------------------------------------------------------------------------
async def test_classifier_bills_tier2_to_gate_with_approval_ref():
    rec = []

    class Budget:
        async def level(self, a): return "ok"
        async def record(self, agent, prov, model, usage, purpose, units=0, ref=None): rec.append((agent, purpose, ref))

    class Adapter:
        async def complete(self, **kw):
            assert "<untrusted" in kw["prompt"] and kw["max_output_tokens"] == 8
            return "routine", Usage(1, 1)
    ctx = types.SimpleNamespace(config=types.SimpleNamespace(reply_tier2_model="google/x", prompts_dir="prompts", reply_tier2_timeout_s=3),
                                budget=Budget(), providers={"google": Adapter()})
    assert await make_classifier(ctx)({"title": "t", "summary": "s"}, "abc") == "routine"
    assert rec == [("_gate", "tier2", "approval:abc")]  # purpose allowed by the usage_events CHECK
    ctx.budget.level = lambda a: asyncio.sleep(0, "stop")
    assert await make_classifier(ctx)({}, "x") is None  # budget stop -> classifier_unavailable


async def test_classifier_sees_whole_summary_or_head_and_tail_G2T031_03():
    seen = []

    class Budget:
        async def level(self, a): return "ok"
        async def record(self, *a, **k): pass

    class Adapter:
        async def complete(self, **kw):
            seen.append(kw["prompt"])
            return "routine", Usage(1, 1)
    ctx = types.SimpleNamespace(config=types.SimpleNamespace(reply_tier2_model="google/x", prompts_dir="prompts", reply_tier2_timeout_s=3),
                                budget=Budget(), providers={"google": Adapter()})
    c = make_classifier(ctx)
    await c({"summary": "a" * 3000 + "MAJOR-TAIL"}, "1")  # past the old 1000-char cut, within the 4000 budget
    assert "MAJOR-TAIL" in seen[-1]
    await c({"summary": "H" * 10 + "x" * 9000 + "END-MARK"}, "2")  # over budget: head and tail both kept
    assert "END-MARK" in seen[-1] and seen[-1].count("x") < 9000 and "HHHHHHHHHH" in seen[-1]


# ---- codes (R2, A2) ------------------------------------------------------------------------------------------
async def test_codes_unique_sequential_per_dept_under_concurrency(db):
    w = build(db)
    await setting(db, "approval.rate_per_day", "100")
    ids = await asyncio.gather(*[req(w, by="sub", title=f"t{i}") for i in range(20)], *[req(w, by="hrsub") for _ in range(3)],
                               *[req(w, by="praw") for _ in range(2)])
    codes = [(await row(w, i))["code"] for i in ids]
    assert sorted(c for c in codes if "FIN" in c) == [f"APR-FIN-{n:04d}" for n in range(1, 21)]
    assert sorted(c for c in codes if "HR" in c) == [f"APR-HR-000{n}" for n in (1, 2, 3)]
    assert sorted(c for c in codes if "HQ" in c) == ["APR-HQ-0001", "APR-HQ-0002"]


async def test_task_codes_per_dept_concurrent(db):
    repo = Repo(db)

    async def mk(dept):
        return (await repo.insert_task(guild_id=1, channel_id=2, title="t", description="d", kind="human", by_id="1",
                                       assignee="a", dept=dept))["code"]
    got = await asyncio.gather(*[mk("HR") for _ in range(20)], *[mk("FIN") for _ in range(5)])
    assert sorted(got[:20]) == [f"HR-{n:04d}" for n in range(1, 21)] and sorted(got[20:]) == [f"FIN-{n:04d}" for n in range(1, 6)]


# ---- decide_as_head guards (R5, A6, A7, A9) --------------------------------------------------------------------
async def dept_item(w, **kw):
    r = await row(w, await req(w, **kw))
    assert r["level"] == "dept"
    return r


async def test_head_decides_own_dept_routine_item(db):
    w = build(db)
    r = await dept_item(w)
    assert await w.svc.decide_as_head(r["id"], "approve", PS["mali"], "routine purchase, fine") == "approved"
    n = await row(w, r["id"])
    assert (n["status"], n["decided_by"], n["decision_reason"]) == ("approved", "agent:mali", "routine purchase, fine")
    a = await db.fetchrow("SELECT * FROM audit_log WHERE scope='approval' AND action='ai_decide'")
    assert (a["ref"], a["actor"], a["new_value"]) == (r["code"], "agent:mali", "approved")
    await asyncio.gather(*w.svc._tasks)
    assert w.woken == [(r["code"], "approved", "agent:mali")]
    assert w.log.ev("approval.ai_decided") == [{"code": r["code"], "agent": "mali", "status": "approved"}]
    assert await w.svc.decide_as_head(r["id"], "reject", PS["mali"], "second try works not") == "already_decided"


@pytest.mark.parametrize("mutate,persona,token", [
    ("", "tek", "dept"),                                                     # head of another department
    ("UPDATE approvals SET value_thb=10000 WHERE id=?1", "mali", "value"),   # exactly at the threshold
    ("UPDATE approvals SET value_thb=NULL WHERE id=?1", "mali", "value"),
    ("UPDATE approvals SET requested_by='mali' WHERE id=?1", "mali", "requester"),
    ("UPDATE approvals SET access='[\"x\"]' WHERE id=?1", "mali", "access"),
    ("UPDATE approvals SET kind='config_change' WHERE id=?1", "mali", "kind"),
    ("", "sub", "not_head"), ("", "praw", "hq_only"),
])
async def test_each_guard_failure_escalates_head_guard_failed(db, mutate, persona, token):
    w = build(db)
    r = await dept_item(w)
    if mutate:
        await db.execute(mutate, r["id"])
    assert await w.svc.decide_as_head(r["id"], "approve", PS[persona], MARK) == "escalated"
    n = await row(w, r["id"])
    assert (n["status"], n["level"], n["route_reason"], n["code"]) == ("pending", "hq", "head_guard_failed", r["code"])
    assert w.log.ev("approval.ai_denied") == [{"code": r["code"], "agent": persona, "reason": token}]
    assert w.pres.moved and w.pres.moved[-1][2] == r["code"]


async def test_ai_disabled_and_expired_deny(db):
    w = build(db)
    r = await dept_item(w)
    await setting(db, "approval.ai_enabled", "off")
    assert await w.svc.decide_as_head(r["id"], "approve", PS["mali"], "a perfectly fine reason") == "escalated"
    assert w.log.ev("approval.ai_denied")[-1]["reason"] == "ai_disabled"
    await setting(db, "approval.ai_enabled", "on")
    r2 = await dept_item(w)
    await db.execute("UPDATE approvals SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?1", r2["id"])
    await w.svc.decide_as_head(r2["id"], "approve", PS["mali"], "a perfectly fine reason")
    assert w.log.ev("approval.ai_denied")[-1]["reason"] == "expired" and (await row(w, r2["id"]))["status"] == "pending"


async def test_hq_item_cannot_be_agent_decided_service_and_db_check(db):
    w = build(db)
    r = await row(w, await req(w, value_thb=50000))
    assert await w.svc.decide_as_head(r["id"], "approve", PS["mali"], "a perfectly fine reason") == "denied"
    n = await row(w, r["id"])
    assert (n["status"], n["level"]) == ("pending", "hq") and w.log.ev("approval.ai_denied")[-1]["reason"] == "level"
    with pytest.raises(Exception) as e:  # DB defence in depth: CHECK forbids agent deciders on HQ rows
        await db.execute("UPDATE approvals SET status='approved', decided_by='agent:mali', "
                         "decided_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1", r["id"])
    assert "constraint" in str(e.value).lower()
    assert (await row(w, r["id"]))["status"] == "pending"


async def test_daily_cap_counts_audit_rows_not_decided_by_T031_05(db):
    w = build(db)
    await setting(db, "approval.ai_daily_max", "1")
    a, b, c = [await dept_item(w) for _ in range(3)]
    assert await w.svc.decide_as_head(a["id"], "approve", PS["mali"], "a perfectly fine reason") == "approved"
    assert (await w.svc.decide(a["id"], "reject", ADMIN)).outcome == "rejected"  # override rewrites decided_by
    assert await w.svc.decide_as_head(b["id"], "approve", PS["mali"], "a perfectly fine reason") == "escalated"
    assert w.log.ev("approval.ai_denied")[-1]["reason"] == "cap"
    assert (await row(w, c["id"]))["status"] == "pending"


async def _linked_task(db, creator_kind, creator):
    repo = Repo(db)
    t = await repo.insert_task(guild_id=1, channel_id=2, title="t", description="d", kind=creator_kind, by_id=creator,
                               assignee="sub", dept="FIN")
    b = await repo.link_task_thread(t, thread_id=9000 + t['short_id'], embed_message_id=1, kind=creator_kind, by_id=creator, turn_limit=5,
                                    token_budget=100)
    return t, b


async def test_head_created_task_laundering_routes_hq_and_is_rechecked_T031_02(db):
    w = build(db)
    t, b = await _linked_task(db, "agent", "mali")
    r = await row(w, await req(w, by="sub", thread_record_id=b["id"]))
    assert (r["level"], r["route_reason"], r["payload"]["task"]) == ("hq", "requester_is_head", t["id"])
    t2, b2 = await _linked_task(db, "human", "1234")  # human-created task: normal routing
    assert (await row(w, await req(w, by="sub", thread_record_id=b2["id"])))["level"] == "dept"
    # re-check inside decide_as_head: a dept item whose linked task was created by the head
    d = await dept_item(w)
    await db.execute("UPDATE approvals SET payload=?2 WHERE id=?1", d["id"], json.dumps({"task": t["id"]}))
    assert await w.svc.decide_as_head(d["id"], "approve", PS["mali"], "a perfectly fine reason") == "escalated"
    assert w.log.ev("approval.ai_denied")[-1]["reason"] == "task_creator"


async def _mk(db, creator, parent=None):
    t, b = await _linked_task(db, "agent", creator)
    if parent:
        await db.execute("UPDATE tasks SET parent_task_id=?2 WHERE id=?1", t["id"], parent["id"])
    return t, b


async def test_head_laundering_chain_beyond_one_hop_G2T031_02(db):
    w = build(db)
    a, _ = await _mk(db, "mali")        # head -> task A
    b, _ = await _mk(db, "hrsub", a)    # X -> task B (child of A)
    c, bc = await _mk(db, "qin", b)     # Y -> task C (child of B)
    r = await row(w, await req(w, by="sub", thread_record_id=bc["id"]))
    assert (r["level"], r["route_reason"]) == ("hq", "requester_is_head")
    d = await dept_item(w)  # re-check from the stored task only (no thread): chain walk in _head_checks
    await db.execute("UPDATE approvals SET payload=?2 WHERE id=?1", d["id"], json.dumps({"task": c["id"]}))
    assert await w.svc.decide_as_head(d["id"], "approve", PS["mali"], "a perfectly fine reason") == "escalated"
    assert w.log.ev("approval.ai_denied")[-1]["reason"] == "task_creator"


async def test_head_laundering_depth_bound_and_cycle_safe_G2T031_02(db):
    w = build(db)
    chain = [(await _mk(db, "hrsub"))[0]]
    for _ in range(12):
        chain.append((await _mk(db, "hrsub", chain[-1]))[0])
    await db.execute("UPDATE tasks SET created_by_id='mali' WHERE id=?1", chain[0]["id"])  # head at depth 12: beyond the bound
    assert "mali" not in await w.svc._chain_creators(chain[-1]["id"])
    assert "mali" in await w.svc._chain_creators(chain[3]["id"])
    await db.execute("UPDATE tasks SET parent_task_id=?2 WHERE id=?1", chain[0]["id"], chain[-1]["id"])  # cycle terminates
    assert "hrsub" in await w.svc._chain_creators(chain[-1]["id"])


async def test_head_brainstorm_owner_or_participant_routes_hq_and_is_rechecked_G2T031_02(db):
    w = build(db)
    for owner, parts in (("mali", ["mali", "sub"]), ("tek", ["tek", "sub", "mali"])):
        b = await Repo(db).create_brainstorm(guild_id=1, channel_id=2, topic="x", owner=owner, participants=parts, turn_limit=5,
                                             token_budget=100, kind="agent", by_id=owner, daily_max=99, tz="UTC")
        r = await row(w, await req(w, by="sub", thread_record_id=b["id"]))
        assert (r["level"], r["route_reason"]) == ("hq", "requester_is_head"), owner
        d = await dept_item(w)
        await db.execute("UPDATE approvals SET payload=?2 WHERE id=?1", d["id"], json.dumps({"thread": b["id"]}))
        assert await w.svc.decide_as_head(d["id"], "approve", PS["mali"], "a perfectly fine reason") == "escalated"
        assert w.log.ev("approval.ai_denied")[-1]["reason"] == "task_creator"
    b = await Repo(db).create_brainstorm(guild_id=1, channel_id=2, topic="x", owner="tek", participants=["tek", "sub", "qin"], turn_limit=5,
                                         token_budget=100, kind="agent", by_id="tek", daily_max=99, tz="UTC")
    assert (await row(w, await req(w, by="sub", thread_record_id=b["id"])))["level"] == "dept"  # head not involved


async def test_recover_twice_and_overlapping_spawn_one_review_per_pending_card_G2_deploy(db):
    w = build(db)
    a, b = await dept_item(w), await dept_item(w, title="Buy ink")
    eng = Eng(act=("approval_decide", {"action": "reject", "reason": "not needed right now"}))
    w2 = build(db, engine=eng)
    eng.w = w2
    await asyncio.gather(w2.svc.recover(), w2.svc.recover())
    await w2.svc.recover()
    await asyncio.gather(*w2.svc._tasks)
    assert sorted(q.approval_id for q in eng.reqs) == sorted([a["id"], b["id"]])


# ---- tools: reachability (A8, T031-01) --------------------------------------------------------------------------
def make_tools(w):
    reg = Registry(w.log)
    for s in make_head_tools(types.SimpleNamespace(approvals=w.svc)):
        reg.register(s)
    return reg


def tctx(agent, trigger, approval_id=None):
    return ToolContext(agent=agent, run_id="r", guild_id=None, channel_id=1, thread_id=None, trigger=trigger,
                       human_user_id=None, sink=None, origin="cli", approval_id=approval_id)


async def test_decision_tools_override_only_never_wildcard_T031_01(db):
    w = build(db)
    reg = make_tools(w)
    for p in PS.values():  # praw has tools ["*"]; no persona gets them without an exact override
        assert not {s.name for s in reg.for_agent(p)} & {"approval_decide", "approval_escalate"}
    assert not reg.for_agent(PS["praw"], ("approval_*",)) and not reg.for_agent(PS["praw"], ("*",))
    assert {s.name for s in reg.for_agent(PS["mali"], ("approval_decide", "approval_escalate"))} == {"approval_decide", "approval_escalate"}


async def test_decide_tool_not_allowed_outside_review_run(db):
    w = build(db)
    reg = make_tools(w)
    r = await dept_item(w)
    allowed = reg.for_agent(PS["mali"], ("approval_decide",))
    args = {"action": "approve", "reason": "a perfectly fine reason"}
    for ctx in (tctx(PS["mali"], "human_message", r["id"]), tctx(PS["mali"], "approval_review", None),
                tctx(PS["mali"], "task_assigned")):
        res = await reg.invoke(ctx, ToolCall("1", "approval_decide", args), allowed)
        assert (res.ok, res.error) == (False, "not_allowed_here")
    # praw cannot call it either: it is not in its allowed list at all
    res = await reg.invoke(tctx(PS["praw"], "human_message", r["id"]), ToolCall("1", "approval_decide", args), reg.for_agent(PS["praw"]))
    assert res.error == "tool_not_allowed" and (await row(w, r["id"]))["status"] == "pending"
    bad = await reg.invoke(tctx(PS["mali"], "approval_review", r["id"]), ToolCall("1", "approval_decide", {**args, "id": "x"}), allowed)
    assert "invalid_arguments" in bad.error  # no id argument exists


# ---- review run, no decision, escalation (R5, A14) -----------------------------------------------------------------
class Eng:
    def __init__(self, act=None, raises=False):
        self.reqs, self.act, self.raises, self.w = [], act, raises, None

    async def run(self, req):
        self.reqs.append(req)
        if self.raises:
            raise RuntimeError(MARK)
        if self.act:
            reg = make_tools(self.w)
            ctx = tctx(PS[req.agent_id], req.trigger, req.approval_id)
            await reg.invoke(ctx, ToolCall("1", self.act[0], self.act[1]), reg.for_agent(PS[req.agent_id], req.tools_override))
        return AgentResult(True, "", [], Usage(), [], "r")


def with_engine(db, **kw):
    eng = Eng(**kw)
    w = build(db, engine=eng)
    eng.w = w
    return w, eng


async def test_review_run_request_shape_and_head_decision(db):
    w, eng = with_engine(db, act=("approval_decide", {"action": "approve", "reason": "routine and low value"}))
    aid = await req(w)
    await asyncio.gather(*w.svc._tasks)
    (q,) = eng.reqs
    assert (q.agent_id, q.trigger, q.human_user_id, q.approval_id, q.tools_override) == (
        "mali", "approval_review", None, aid, ("approval_decide", "approval_escalate"))
    assert "Buy ten pens" in q.text and q.max_output_tokens == 400 and "approval_escalate" in q.system_extra
    assert (await row(w, aid))["decided_by"] == "agent:mali" and w.woken == [("APR-FIN-0001", "approved", "agent:mali")]
    assert w.log.ev("approval.review_started") == [{"code": "APR-FIN-0001", "agent": "mali"}]


async def test_no_decision_escalates_card_moves_old_buttons_inactive(db):
    w, eng = with_engine(db)
    aid = await req(w)
    await asyncio.gather(*w.svc._tasks)
    r = await row(w, aid)
    assert (r["level"], r["route_reason"], r["code"], r["status"]) == ("hq", "head_no_decision", "APR-FIN-0001", "pending")
    assert [(c, lv) for c, lv, _ in w.pres.requests] == [("APR-FIN-0001", "dept"), ("APR-FIN-0001", "hq")]
    old_msg, new_msg = w.pres.requests[0][2], w.pres.requests[1][2]
    assert r["message_id"] == new_msg != old_msg and w.pres.moved == [(7, old_msg, "APR-FIN-0001")]
    a = await db.fetchrow("SELECT * FROM audit_log WHERE action='escalate'")
    assert (a["actor"], a["new_value"]) == ("agent:system", "head_no_decision")
    assert w.log.ev("approval.escalated") == [{"code": "APR-FIN-0001", "by": "agent:system", "reason": "head_no_decision"}]
    import discord
    rt = Router(w.log, db, lambda: 900)
    sent = []

    async def send_message(*a, **k): sent.append(a)

    async def defer(**k): sent.append("defer")
    ev = lambda mid: types.SimpleNamespace(  # noqa: E731
        type=discord.InteractionType.component, data={"custom_id": make_custom_id("appr", "approve", aid)},
        response=types.SimpleNamespace(send_message=send_message, defer=defer), client=types.SimpleNamespace(user=types.SimpleNamespace(id=900)),
        message=types.SimpleNamespace(id=mid, author=types.SimpleNamespace(id=900)))
    seen = []
    rt.register("appr", lambda i, a, u: asyncio.sleep(0, seen.append(u)))
    await rt.dispatch(ev(old_msg))
    assert seen == [] and "no longer active" in sent[0][0]
    await rt.dispatch(ev(new_msg))
    assert seen == [aid]


@pytest.mark.parametrize("kw", [{"raises": True}, {}])
async def test_engine_error_or_no_call_escalates(db, kw):
    w, _ = with_engine(db, **kw)
    aid = await req(w)
    await asyncio.gather(*w.svc._tasks)
    assert (await row(w, aid))["route_reason"] == "head_no_decision"


async def test_head_escalate_tool_keeps_code_and_note(db):
    w, _ = with_engine(db, act=("approval_escalate", {"reason": "not sure about the amount"}))
    aid = await req(w)
    await asyncio.gather(*w.svc._tasks)
    r = await row(w, aid)
    assert (r["level"], r["route_reason"], r["code"], r["decision_reason"]) == ("hq", "head_escalated", "APR-FIN-0001", "not sure about the amount")
    assert w.log.ev("approval.escalated")[0]["reason"] == "head_escalated"  # fixed token, never the AI text


async def test_restart_respawns_reviews_for_pending_dept_items_T031_09(db):
    w = build(db)  # no engine: item stays pending at dept level
    a = await dept_item(w)
    await req(w, value_thb=99999)  # hq item: not reviewed
    eng = Eng(act=("approval_decide", {"action": "reject", "reason": "not needed right now"}))
    w2 = build(db, engine=eng)
    eng.w = w2
    w2.svc.start()
    assert not w2.svc._tasks and not eng.reqs  # start() alone never reviews: the surface calls recover() when it can post
    await w2.svc.recover()
    await asyncio.gather(*w2.svc._tasks)
    await w2.svc.stop()
    assert [q.approval_id for q in eng.reqs] == [a["id"]] and (await row(w, a["id"]))["status"] == "rejected"


# ---- human override and cancel (R6, A10, A15) -----------------------------------------------------------------------
async def test_first_human_decision_is_audited_and_refusals_are_not(db):
    w = build(db)
    r1, r2 = await dept_item(w), await dept_item(w)
    assert (await w.svc.decide(r1["id"], "approve", ADMIN)).outcome == "approved"
    assert (await w.svc.decide(r2["id"], "reject", ADMIN)).outcome == "rejected"
    assert (await w.svc.decide(r1["id"], "reject", OTHER_ADMIN)).outcome == "already_decided"  # human decisions are final
    assert (await w.svc.decide(r1["id"], "approve", Actor("cli", "bob"))).outcome == "not_approver"
    rows = await db.fetch("SELECT ref, field, old_value, new_value, actor FROM audit_log WHERE action='decide' ORDER BY id")
    assert [tuple(x[k] for k in ("ref", "field", "old_value", "new_value", "actor")) for x in rows] == [(r1["code"], "status", "pending", "approved", "cli:admin"), (r2["code"], "status", "pending", "rejected", "cli:admin")]
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action='override'") == 0


async def test_human_overrides_ai_once_and_requester_is_woken(db):
    w = build(db)
    r = await dept_item(w)
    await w.svc.decide_as_head(r["id"], "approve", PS["mali"], "a perfectly fine reason")
    assert (await w.svc.decide(r["id"], "approve", ADMIN)).outcome == "already_decided"  # same outcome is no override
    d = await w.svc.decide(r["id"], "reject", ADMIN)
    assert d.outcome == "rejected" and d.approval["overridden_from"] == "agent:mali" and d.approval["decided_by"] == "cli:admin"
    await asyncio.gather(*w.svc._tasks)
    assert [x[1] for x in w.woken] == ["approved", "rejected"]
    a = await db.fetchrow("SELECT * FROM audit_log WHERE action='override'")
    assert (a["ref"], a["old_value"], a["new_value"], a["actor"]) == (r["code"], "agent:mali", "cli:admin", "cli:admin")
    assert w.log.ev("approval.overridden") == [{"code": r["code"], "by": "cli:admin", "status": "rejected"}]
    assert (await w.svc.decide(r["id"], "approve", OTHER_ADMIN)).outcome == "already_decided"  # human decisions are final
    assert (await w.svc.decide(r["id"], "approve", Actor("cli", "bob"))).outcome == "not_approver"


async def test_override_concurrent_exactly_one_and_not_after_expiry(db):
    w = build(db)
    r = await dept_item(w)
    await w.svc.decide_as_head(r["id"], "approve", PS["mali"], "a perfectly fine reason")
    ds = await asyncio.gather(*[w.svc.decide(r["id"], "reject", ADMIN if n % 2 else OTHER_ADMIN) for n in range(6)])
    assert sorted(d.outcome for d in ds).count("rejected") == 1
    r2 = await dept_item(w)
    await w.svc.decide_as_head(r2["id"], "approve", PS["mali"], "a perfectly fine reason")
    await db.execute("UPDATE approvals SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?1", r2["id"])
    assert (await w.svc.decide(r2["id"], "reject", ADMIN)).outcome == "already_decided"
    assert (await row(w, r2["id"]))["status"] == "approved"


async def test_cancel_is_soft_pending_only_and_audited(db):
    w = build(db)
    r = await dept_item(w)
    n = await w.svc.cancel(r["code"], ADMIN, "mistake")
    assert n["status"] == "cancelled" and n["decided_by"] is None
    a = await db.fetchrow("SELECT * FROM audit_log WHERE action='cancel'")
    assert (a["ref"], a["actor"], a["new_value"]) == (r["code"], "cli:admin", "cancelled: mistake")
    assert w.pres.decisions[-1] == (r["code"], "cancelled") and w.log.ev("approval.cancelled") == [{"code": r["code"], "by": "cli:admin"}]
    assert await w.svc.cancel(r["code"], ADMIN) is None
    assert (await w.svc.decide(r["id"], "approve", ADMIN)).outcome == "already_decided"
    assert await db.fetchval("SELECT count(*) FROM approvals") == 1 and w.woken == []  # row kept, handler not run
    done = await dept_item(w)
    await w.svc.decide(done["id"], "approve", ADMIN)
    assert await w.svc.cancel(done["code"], ADMIN) is None  # decided items cannot be cancelled


def test_no_hard_delete_of_approvals_or_tasks_A15():
    import re
    hits = [str(f) for f in Path("core").rglob("*.py") if re.search(r"DELETE\s+FROM\s+(approvals|tasks)\b", f.read_text(), re.I)]
    assert hits == ["core/migration/retention.py"]  # the 180-day sweep of terminal tasks only (OQ-7)


def test_settings_service_does_not_import_discord_T031_07():
    import re
    for f in Path("core/settings").glob("*.py"):
        assert not re.search(r"^\s*(import|from)\s+(discord|core\.discord)", f.read_text(), re.M), f


# ---- WARNING events carry fixed tokens only (T031-04) ---------------------------------------------------------------
async def test_forwarded_warning_fields_are_fixed_tokens_T031_04(db):
    w, _ = with_engine(db, act=("approval_decide", {"action": "approve", "reason": MARK + " long enough"}))
    w.svc.router.classify = routine(RuntimeError(MARK))
    await req(w)
    w.svc.router.classify = routine()
    d = await row(w, await req(w))
    await asyncio.gather(*w.svc._tasks)
    e = await row(w, await req(w, value_thb=50000))
    await w.svc.decide_as_head(e["id"], "approve", PS["mali"], MARK)
    await w.svc.decide(d["id"], "reject", ADMIN)
    await w.svc.escalate_as_head((await row(w, await req(w)))["id"], PS["mali"], MARK + " escalate")
    warns = [(m, f) for m, lv, f in w.log.rows if lv == "WARNING"]
    assert {m for m, _ in warns} >= {"approval.classify_failed", "approval.ai_decided", "approval.ai_denied", "approval.overridden",
                                     "approval.escalated"}
    for event, f in warns:
        line = json.dumps({"ts": "2026-11-24T10:00:00Z", "system": "approvals", "event": event, "fields": f})
        text = format_line("WARNING", line)[1]
        assert "MARKER" not in text and "FREE TEXT" not in text, text
        for k, v in f.items():
            if k in FORWARD_KEYS and isinstance(v, str):
                assert len(v) <= 40 and " " not in v, (event, k, v)
