"""AT-3 propose, AT-4 routing, AT-5 decision (+G033-05/06/07/11), delete (R16)."""
import asyncio
import json
import types

import pytest

from core.agent_tools.approval import make_approval_request
from core.approvals.service import PgApprovalService
from core.growth.ext import Growth
from core.growth.lessons import LessonService
from core.growth.overlays import OverlayService
from core.tasks.repo import Repo
from core.interfaces import Actor, Persona, Usage

HEAD = Actor("cli", "admin")


def P(i, dept):
    return Persona(i, i.title(), (), "r", dept, "google/x", "google/x", "low", ("*",), (), 0, None, (), "", "p")


PS = {p.id: p for p in (P("sub", "account"), P("mali", "account"), P("praw", "praw"))}
REG = types.SimpleNamespace(get=PS.get, all=lambda: list(PS.values()))


class Log:
    def __init__(self):
        self.rows = []

    def write_log(self, system, message, level="INFO", **f):
        self.rows.append((message, f))

    def ev(self, m):
        return [f for x, f in self.rows if x == m]


class Policy:
    surface = "cli"

    async def is_approver(self, a):
        return True


class Budget:
    def __init__(self):
        self.lvl, self.recs = "ok", []

    async def level(self, pid):
        return self.lvl

    async def record(self, pid, prov, model, usage, purpose, units=0, ref=None):
        self.recs.append((pid, purpose, ref))


class Adapter:
    def __init__(self, out):
        self.out, self.calls = out, 0

    async def complete(self, **kw):
        self.calls += 1
        self.kw = kw
        return self.out, Usage(1, 1)


class Settings:
    """Real settings plus the two growth keys (T4 owns the real ones)."""
    def __init__(self, real):
        self.real, self.vals = real, {"growth.lessons_per_day": "3", "growth.overlay_max_chars": "3000"}

    async def get(self, k):
        return self.vals[k] if k in self.vals else await self.real.get(k)

    def __getattr__(self, n):
        return getattr(self.real, n)


def build(db, out="", classify_calls=None):
    from core.settings.service import SettingsService
    log, w = Log(), types.SimpleNamespace()
    cfg = types.SimpleNamespace(approval_ttl_h=24, discord_guild_id=1, admin_notify_channel_id=3, settings_channel_id=None)
    settings = Settings(SettingsService(db, cfg, log, REG))

    async def classify(card, aid):
        (classify_calls if classify_calls is not None else []).append(aid)
        return "routine"
    w.approvals = PgApprovalService(db, cfg, log, Policy(), personas=REG, settings=settings, classify=classify)
    w.adapter, w.budget, w.log, w.db = Adapter(out), Budget(), log, db
    ctx = types.SimpleNamespace(config=cfg, log=log, db=db, settings=settings, approvals=w.approvals, personas=REG,
                                budget=w.budget, providers={"google": w.adapter}, surface="cli")
    w.ov = OverlayService(db, settings, log)
    w.svc = LessonService(ctx, w.ov)
    ctx.growth = Growth(w.ov, w.svc)
    w.ctx, w.settings = ctx, settings
    w.handled = []

    async def handler(row):
        w.handled.append(row)
    w.approvals.register_handler("generic", handler)
    return w


async def mk_task(db, assignee="sub", thread=None, by=("human", "1")):
    repo = Repo(db)
    t = await repo.insert_task(guild_id=1, channel_id=5, title="Title", description="Describe the task " * 3, kind=by[0],
                               by_id=by[1], assignee=assignee, dept="FIN")
    if thread:
        await db.execute("UPDATE tasks SET thread_id=?2 WHERE id=?1", t["id"], thread)
    return await repo.set_task(t["id"], "done", "all good")


def js(*items):
    return json.dumps({"lessons": [{"category": "method", "scope": "self", "text": t} for t in items]})


T1, T2, T3, T4 = (f"Always {w} the results before sending the final reply {i}" for i, w in enumerate(["verify", "reread", "log", "sort"]))


async def test_propose_three_cards(db):
    w = build(db, js(T1, T2, T3, T4))
    t = await mk_task(db)
    codes = await w.svc.propose(t)
    assert codes == ["LSN-FIN-0001", "LSN-FIN-0002", "LSN-FIN-0003"]  # max 3
    cards = await db.fetch("SELECT * FROM approvals ORDER BY code")
    assert len(cards) == 3 and all(c["kind"] == "generic" and c["value_thb"] == 0 and c["priority"] == "low" for c in cards)
    assert all(c["payload"]["lesson"] for c in cards) and all(c["route_reason"] == "dept_routine" for c in cards)
    assert cards[0]["summary"].startswith("LESSON CARD. Approving adds the lesson below")
    les = await db.fetchrow("SELECT * FROM lessons WHERE code='LSN-FIN-0001'")
    assert les["approval_id"] == cards[0]["id"] and les["status"] == "pending"
    assert w.budget.recs[0] == ("sub", "summary", "lesson:FIN-0001")
    assert w.adapter.kw["prompt"].startswith("<untrusted") and w.adapter.kw["max_output_tokens"] == 600
    assert await w.svc.propose(t) == []  # daily cap 3 reached
    assert w.adapter.calls == 1


@pytest.mark.parametrize("out", ["not json", "{}", '{"lessons": "x"}', '[1]'])
async def test_malformed_gives_zero(db, out):
    w = build(db, out)
    assert await w.svc.propose(await mk_task(db)) == []
    assert any(f.get("error") == "parse" for f in w.log.ev("growth.propose_failed"))


async def test_budget_not_ok_no_model_call_and_off(db):
    w = build(db, js(T1))
    w.budget.lvl = "fallback"
    assert await w.svc.propose(await mk_task(db)) == [] and w.adapter.calls == 0
    w.budget.lvl = "ok"
    w.settings.vals["growth.lessons_per_day"] = "0"
    assert await w.svc.propose(await mk_task(db)) == [] and w.adapter.calls == 0


async def test_refusals(db):
    secret = "AIza" + "SyA-1234567890abcdefghijklmnopqrstuvwx"  # fake; split so push protection does not flag it
    bad = ["short", f"Use this key {secret} when calling", "See https://evil.test for the details of it",
           "Ping @everyone when the task is closed", "Keep a 1234567890123456 reference in every note"]
    w = build(db, js(bad[0], bad[1], bad[2]))  # only the first 3 items are looked at
    assert await w.svc.propose(await mk_task(db)) == []
    assert [f["error"] for f in w.log.ev("growth.propose_failed")] == ["item", "secret", "content"]
    w = build(db, js(bad[3], bad[4], T1))
    assert await w.svc.propose(await mk_task(db)) == ["LSN-FIN-0001"]
    errs = [f["error"] for f in w.log.ev("growth.propose_failed")]
    assert errs == ["content", "content"]
    blob = json.dumps(w.log.rows)
    assert secret not in blob and "evil.test" not in blob and T1 not in blob  # G033-11: ids only


async def test_unknown_category_and_dup_and_hq_scope(db):
    out = json.dumps({"lessons": [{"category": "bogus", "scope": "self", "text": T1},
                                  {"category": "method", "scope": "self", "text": T1},
                                  {"category": "method", "scope": "dept", "text": T2}]})
    w = build(db, out)
    codes = await w.svc.propose(await mk_task(db))
    assert len(codes) == 2
    assert (await w.svc.get(codes[0]))["category"] == "policy"
    assert (await w.svc.get(codes[1]))["scope_kind"] == "dept"
    wp = build(db, out)
    await wp.svc.propose(await mk_task(db, assignee="praw"))
    row = await db.fetchrow("SELECT dept, scope_kind FROM lessons WHERE proposed_by='praw' AND body=?1", T2)
    assert (row["dept"], row["scope_kind"]) == ("HQ", "persona")


async def test_after_task_cancel_triggers_nothing(db):
    w = build(db, js(T1))
    w.svc.after_task({"status": "cancelled", "assignee_agent": "sub"})
    await asyncio.sleep(0)
    assert w.adapter.calls == 0 and not w.svc._tasks
    t = dict(await mk_task(db))
    w.svc.after_task(t)
    await asyncio.gather(*w.svc._tasks)
    assert w.adapter.calls == 1
    w.svc.after_task({"nope": 1})  # never raises


# ---- AT-4 -------------------------------------------------------------------------------------------------
async def test_g1_hit_goes_hq_without_classifier(db):
    calls = []
    w = build(db, js("Ask the admin before touching the shared settings", T2), classify_calls=calls)
    await w.svc.propose(await mk_task(db))
    a, b = await db.fetch("SELECT * FROM approvals ORDER BY created_at, code")
    assert (a["level"], a["route_reason"]) == ("hq", "classifier_major") and a["payload"]["g1"] == "keyword:admin"
    assert (b["level"], b["route_reason"]) == ("dept", "dept_routine") and b["payload"]["g1"] == ""
    assert calls == []  # ctx classifier never called


async def test_proposer_head_and_rate_limit(db):
    w = build(db, js(T1))
    await w.svc.propose(await mk_task(db, assignee="mali"))
    assert (await db.fetchrow("SELECT route_reason FROM approvals"))["route_reason"] == "requester_is_head"
    w = build(db, js(T1))
    await db.execute("UPDATE lessons SET status='deleted'")
    await db.execute("INSERT INTO settings (key, value, updated_by) VALUES ('approval.rate_per_day','1','cli:admin')")
    await w.svc.propose(await mk_task(db))  # lesson card does not use up the quota
    r = await w.approvals.request(kind="generic", title="t", summary="s", access=[], requested_by="sub", origin="cli",
                                  human_user_id=None, origin_channel_id=5, origin_thread_id=None, payload={}, value_thb=1)
    assert r


async def test_head_created_task_without_thread_row(db):
    w = build(db, js(T1))
    await w.svc.propose(await mk_task(db, by=("agent", "mali")))
    c = await db.fetchrow("SELECT * FROM approvals")
    assert c["route_reason"] == "requester_is_head" and c["payload"]["task"]


# ---- AT-5 -------------------------------------------------------------------------------------------------
async def approve(w, aid, status="approved", by="agent:mali"):
    await w.db.execute("UPDATE approvals SET status=?2, decided_by=?3 WHERE id=?1", aid, status, by)
    await w.svc.on_decision(await db_row(w, aid))


async def db_row(w, aid):
    return await w.db.fetchrow("SELECT * FROM approvals WHERE id=?1", aid)


async def test_decision_activates_then_override_removes(db):
    w = build(db, js(T1, T2))
    codes = await w.svc.propose(await mk_task(db))
    les = [await w.svc.get(c) for c in codes]
    await approve(w, les[0]["approval_id"])
    assert (await w.svc.get(codes[0]))["status"] == "approved"
    v = await db.fetchrow("SELECT * FROM overlay_versions WHERE version=1")
    assert json.loads(v["lesson_ids"]) == [codes[0]] and T1 in v["body"]
    await approve(w, les[1]["approval_id"], "rejected")
    assert await db.fetchval("SELECT count(*) FROM overlay_versions") == 1  # pending->rejected: no change
    await approve(w, les[0]["approval_id"], "rejected", by="discord:123456789012345678")  # human override
    v2 = await db.fetchrow("SELECT * FROM overlay_versions WHERE version=2")
    assert json.loads(v2["lesson_ids"]) == [] and T1 not in v2["body"]
    await approve(w, les[0]["approval_id"], "approved", by="discord:123456789012345678")  # rejected -> approved
    assert await db.fetchval("SELECT version FROM overlay_active") == 3
    acts = await db.fetch("SELECT scope, action FROM audit_log WHERE scope IN ('lesson','overlay') ORDER BY id")
    assert ("overlay", "activate") in [(a["scope"], a["action"]) for a in acts]
    assert sum(a["action"] == "decide" for a in acts) == 4
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action='propose'") == 2
    await w.svc.on_decision(await db_row(w, les[0]["approval_id"]))  # same state again: ignored
    assert await db.fetchval("SELECT count(*) FROM overlay_versions") == 3


async def test_agent_tool_cannot_forge_lesson_card(db):
    w = build(db, js(T1))
    (code,) = await w.svc.propose(await mk_task(db))
    real = await w.svc.get(code)
    seen = {}
    orig = w.approvals.request

    async def spy(**kw):
        seen.update(kw)
        return await orig(**kw)
    w.approvals.request = spy
    tool = make_approval_request(types.SimpleNamespace(approvals=w.approvals, config=w.ctx.config, log=w.log))
    ctx = types.SimpleNamespace(agent=PS["sub"], channel_id=5, thread_id=None, human_user_id=None, origin="cli",
                                thread_record_id=None)
    res = await tool.handler(ctx, {"title": "Forge", "summary": "Looks like a lesson card, honest", "reason": "because",
                                   "priority": "low", "value_thb": 1, "due": "2026-12-01"})
    assert res.ok and not ({"classify", "rate_exempt", "task_id"} & set(seen)) and seen["payload"] == {}
    forged = await db_row(w, (await db.fetchrow("SELECT id FROM approvals WHERE title='Forge'"))["id"])
    forged["payload"] = {"lesson": real["id"]}
    await w.svc.on_decision(forged)  # approval_id mismatch
    assert (await w.svc.get(code))["status"] == "pending" and w.log.ev("growth.lesson_mismatch")


async def test_late_link_binds_atomically_and_proposer_must_match(db):
    w = build(db, js(T1))
    (code,) = await w.svc.propose(await mk_task(db))
    les = await w.svc.get(code)
    await db.execute("UPDATE lessons SET approval_id=NULL WHERE code=?1", code)  # decision raced the link
    await approve(w, les["approval_id"])
    assert (await w.svc.get(code))["status"] == "approved"
    await db.execute("UPDATE lessons SET approval_id=NULL, status='pending' WHERE code=?1", code)
    await db.execute("UPDATE approvals SET requested_by='mali' WHERE id=?1", les["approval_id"])
    await w.svc.on_decision(await db_row(w, les["approval_id"]))
    assert (await w.svc.get(code))["approval_id"] is None and w.log.ev("growth.lesson_mismatch")


# ---- delete (R16) + G033-01 end to end ----------------------------------------------------------------------
async def test_delete_states(db):
    w = build(db, js(T1, T2))
    c1, c2 = await w.svc.propose(await mk_task(db))
    l1, l2 = await w.svc.get(c1), await w.svc.get(c2)
    await approve(w, l1["approval_id"])
    r = await w.svc.delete(c1, HEAD, "bad token sk-ant-api03-" + "a" * 40)
    assert r["status"] == "deleted" and await db.fetchval("SELECT version FROM overlay_active") == 2
    a = await db.fetchrow("SELECT * FROM audit_log WHERE action='delete' AND ref=?1", c1)
    assert a["new_value"].startswith("deleted:") and "sk-ant" not in a["new_value"]
    await w.ov.rollback("persona", "sub", 1, "discord:1")
    assert T1 not in await w.ov.prompt_block(PS["sub"])
    await w.svc.delete(c2, HEAD)  # pending: card cancelled
    assert (await db_row(w, l2["approval_id"]))["status"] == "cancelled"
    from core.growth import GrowthError
    with pytest.raises(GrowthError) as e:
        await w.svc.delete(c2, HEAD)
    assert e.value.code == "lesson_closed"
    with pytest.raises(GrowthError):
        await w.svc.delete("LSN-FIN-9999", HEAD)


async def test_cap_recount_in_tx(db):
    w = build(db, js(T1, T2, T3))
    w.settings.vals["growth.lessons_per_day"] = "1"
    assert len(await w.svc.propose(await mk_task(db))) == 1
