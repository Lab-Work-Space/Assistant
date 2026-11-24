"""TASK-031 R7: shared card validator, approval_request / task_create required fields (A3)."""
import types
from datetime import date, timedelta

import pytest

from core.agent_tools.approval import make_approval_request
from core.approvals.cards import CARD_REQUIRED, TASK_REQUIRED, check_card
from core.interfaces import ToolContext
from tests.conftest import task_card
from tests.test_approvals_routing import PS, REG, Log, build
from tests.test_tasks import call, make, tctx

TZ = "Asia/Bangkok"
TOMORROW = (date.today() + timedelta(days=1)).isoformat()
OK = {"reason": "needed", "value_thb": 0, "priority": "low", "due": TOMORROW, "summary": "x" * 20}


def test_missing_list_in_required_order_blank_counts():
    assert check_card({"summary": "x" * 20, "priority": " "}, CARD_REQUIRED, TZ) == "incomplete_card missing=reason,value_thb,priority,due"
    assert check_card({**OK, "reason": None}, CARD_REQUIRED, TZ) == "incomplete_card missing=reason"
    assert check_card(OK, CARD_REQUIRED, TZ) is None  # value_thb 0 is a real value
    assert check_card({}, TASK_REQUIRED, TZ) == "incomplete_card missing=description,priority,due,value_thb"


@pytest.mark.parametrize("a,err", [
    ({"summary": "short"}, "invalid_field field=summary reason=too_short"),
    ({"due": "2020-01-01"}, "invalid_field field=due reason=past"),
    ({"due": (date.today() + timedelta(days=731)).isoformat()}, "invalid_field field=due reason=too_far"),
    ({"due": "2026-13-40"}, "invalid_field field=due reason=format"), ({"due": "26-1-1"}, "invalid_field field=due reason=format"),
    ({"other_depts": ["nowhere"]}, "invalid_field field=other_depts reason=unknown"),
    ({"assignee": "ghost2"}, "invalid_field field=assignee reason=unknown"),
])
def test_invalid_fields(a, err):
    assert check_card({**OK, **a}, CARD_REQUIRED, TZ, REG) == err
    assert check_card({**OK, "due": (date.today() + timedelta(days=730)).isoformat()}, CARD_REQUIRED, TZ, REG) is None


def test_task_description_is_the_text_field():
    assert check_card({**task_card(), "description": "tiny"}, TASK_REQUIRED, TZ) == "invalid_field field=description reason=too_short"


def ctx(agent="sub", human=None, **kw):
    return ToolContext(agent=PS[agent], run_id="r", guild_id=None, channel_id=1, thread_id=None, trigger="human_message",
                       human_user_id=human, sink=None, origin="cli", **kw)


async def test_incomplete_approval_card_refused_no_row_and_logged(db):
    w = build(db)
    app = types.SimpleNamespace(approvals=w.svc, log=w.log, personas=REG, config=types.SimpleNamespace(app_timezone=TZ, intake_persona="praw"), db=db)
    t = make_approval_request(app)
    r = await t.handler(ctx(), {"title": "x", "summary": "a summary that is long enough"})
    assert (r.ok, r.error) == (False, "incomplete_card missing=reason,value_thb,priority,due")
    assert await db.fetchval("SELECT count(*) FROM approvals") == 0
    assert w.log.ev("approval.incomplete") == [{"agent": "sub", "kind": "reason,value_thb,priority,due"}]
    r = await t.handler(ctx(), {"title": "x", "summary": "a summary that is long enough", "reason": "r", "value_thb": 5, "priority": "low", "due": TOMORROW})
    assert r.ok and r.data["code"] == "APR-FIN-0001"
    assert (await t.handler(ctx(), {"title": "x", "summary": "short", "reason": "r", "value_thb": 5, "priority": "low", "due": TOMORROW})).error \
        == "invalid_field field=summary reason=too_short"


async def test_for_dept_only_praw_human_triggered_known_dept(db):
    w = build(db)
    app = types.SimpleNamespace(approvals=w.svc, log=w.log, personas=REG, config=types.SimpleNamespace(app_timezone=TZ, intake_persona="praw"), db=db)
    t = make_approval_request(app)
    card = {"title": "x", "summary": "a summary that is long enough", "reason": "r", "value_thb": 5, "priority": "low", "due": TOMORROW}
    for c, fd in ((ctx("praw", human=None), "hr"), (ctx("sub", human=5), "hr"), (ctx("praw", human=5), "exec"), (ctx("praw", human=5), "praw"),
                  (ctx("praw", human=5), "nowhere")):
        assert (await t.handler(c, {**card, "for_dept": fd})).error == "for_dept_not_allowed"
    ok = await t.handler(ctx("praw", human=5), {**card, "for_dept": "hr"})
    assert ok.ok and ok.data["code"] == "APR-HR-0001"  # OQ-1: Praw files for a department


async def test_task_create_card_checks_after_assignee(db):
    e = make(db)
    c = tctx(e)
    base = {"assignee_agent_id": "dev", "title": "x"}
    assert (await call(e, c, "task_create", {**base, "assignee_agent_id": "praw"})).error == "invalid_assignee"  # before the card check
    assert (await call(e, c, "task_create", base)).error == "incomplete_card missing=description,priority,due,value_thb"
    assert (await call(e, c, "task_create", {**base, **task_card(description="short")})).error == "invalid_field field=description reason=too_short"
    assert (await call(e, c, "task_create", {**base, **task_card(due="2020-01-01")})).error == "invalid_field field=due reason=past"
    inc = [f for n, f in e.ctx.log.recs if n == "task.incomplete"]
    assert inc[0] == {"agent": "praw", "kind": "description,priority,due,value_thb"}
    assert await db.fetchval("SELECT count(*) FROM tasks") == 0
    r = await call(e, c, "task_create", {**base, **task_card()})
    assert r.ok and r.content == "HQ-0001 created"  # test personas have dept "d": unknown dept -> HQ code
    await e.orch.wait_idle()
    t = await db.fetchrow("SELECT * FROM tasks")
    assert (t["priority"], t["value_thb"], t["dept"], t["code"]) == ("normal", 500, "HQ", "HQ-0001") and t["due"] == task_card()["due"]
