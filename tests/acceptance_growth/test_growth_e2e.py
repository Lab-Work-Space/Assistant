"""TASK-033 Stage 6 e2e: real db/registry/settings/approvals/lessons/overlays/staff/engine; only the LLM provider and Discord are fake."""
import asyncio
import hashlib
import types

import pytest

from core.agents.engine import Engine
from core.approvals.ext import _lesson_aware
from core.approvals.service import PgApprovalService
from core.config import PROJECT_ROOT
from core.growth.ext import Growth
from core.growth.lessons import LessonService
from core.growth.overlays import OverlayService
from core.growth.personas import RuntimePersonaRegistry, StaffService
from core.interfaces import Actor
from core.settings.service import SettingsService
from core.tasks.repo import Repo
from tests.test_agent_engine import Adapter, Budget, Log, Sink, StreamEvent, U, make, req
from tests.test_growth_lessons import Adapter as LAdapter, Policy, js
from tests.test_growth_registry import PROMPTS, files  # noqa: F401

LESSON = "Always verify the totals against the source sheet before sending the final reply"
ADMIN, HUMAN = Actor("cli", "admin"), Actor("cli", "boss")


def prompt_hashes():
    return {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted((PROJECT_ROOT / "prompts").rglob("*")) if p.is_file()}


async def world(db, lesson_json):
    log = Log()
    reg = await RuntimePersonaRegistry.load(db, files(), PROMPTS, "google/cheap", log)
    cfg = types.SimpleNamespace(intake_persona="praw", default_agent_id="praw", approval_ttl_h=24, admin_notify_channel_id=3,
                                settings_channel_id=None, discord_guild_id=1, prompts_dir=str(PROMPTS), app_timezone="Asia/Bangkok",
                                agent_max_concurrency=2, agent_run_timeout_s=5, provider_idle_timeout_s=1, agent_max_tool_rounds=3,
                                agent_max_output_tokens=100, dm_max_per_hour_per_agent=20, anthropic_api_key=None, google_api_token=None)
    st = SettingsService(db, cfg, log, reg)
    classified = []

    async def classify(card, aid):
        classified.append(aid)
        return "routine"
    ap = PgApprovalService(db, cfg, log, Policy(), personas=reg, settings=st, classify=classify)
    llm = LAdapter(lesson_json)
    bud = types.SimpleNamespace(level=lambda p: _ok(), record=lambda *a, **k: _ok())
    ctx = types.SimpleNamespace(config=cfg, log=log, db=db, settings=st, approvals=ap, personas=reg, budget=bud,
                                providers={"anthropic": llm, "google": llm}, surface="cli")
    ov = OverlayService(db, st, log)
    lessons = LessonService(ctx, ov)
    ctx.growth = Growth(ov, lessons, StaffService(ctx))
    ap.register_handler("generic", _lesson_aware(ctx, None))
    eng, ectx, ad, elog = make([[StreamEvent("text", text="ok"), U(), StreamEvent("done", stop_reason="end")] for _ in range(40)])
    ectx.personas, ectx.growth = reg, ctx.growth
    ectx.providers.update({"anthropic": ad, "google": ad})
    w = types.SimpleNamespace(ctx=ctx, ap=ap, reg=reg, ov=ov, ls=lessons, st=st, eng=eng, ad=ad, classified=classified, llm=llm)
    LIVE.append(w)
    return w


async def _ok():
    return "ok"


LIVE = []


@pytest.fixture(autouse=True)
async def _no_leaked_tasks(db):
    """Runs before db teardown: bounded drain, then cancel leftovers, so a stuck bg handler cannot hang close()."""
    LIVE.clear()
    yield
    for w in LIVE:
        pend = [*w.ap._tasks, *w.ls._tasks]
        for t in pend:
            t.cancel()
        await asyncio.gather(*pend, return_exceptions=True)


async def drain(w, timeout=5):
    """Wait (bounded) for approval handlers and lesson proposals started so far."""
    for _ in range(3):
        pend = [*w.ap._tasks, *w.ls._tasks]
        if not pend:
            await asyncio.sleep(0)
            continue
        await asyncio.wait_for(asyncio.gather(*pend, return_exceptions=True), timeout)


async def system_for(w, pid, **kw):
    n = len(w.ad.calls)
    await w.eng.run(req(Sink(), agent_id=pid, **kw))
    return w.ad.calls[n]["system"]


async def done_task(db, assignee):
    repo = Repo(db)
    t = await repo.insert_task(guild_id=1, channel_id=5, title="Reconcile", description="Reconcile the ledger " * 3, kind="human",
                               by_id="1", assignee=assignee, dept="DEV")
    return await repo.set_task(t["id"], "done", "finished")


async def test_e2e_lesson_to_overlay_rollback_delete_and_main_prompt_untouched(db):
    before = prompt_hashes()
    w = await world(db, js(LESSON))
    bank_main = w.reg.get("bank").body
    assert "LSN-" not in await system_for(w, "bank")
    # task done -> lesson proposed through the real hook
    w.ls.after_task(await done_task(db, "bank"))
    await drain(w)
    (card,) = await db.fetch("SELECT * FROM approvals")
    assert card["level"] == "dept" and card["dept"] == "DEV" and card["route_reason"] == "dept_routine"
    les = (await w.ls.list(("persona", "bank")))[0]
    assert les["status"] == "pending" and "Learned guidance (persona bank" not in await system_for(w, "bank")
    # head (tek) approves through the real approvals service + real handler
    res = await w.ap.decide_as_head(card["id"], "approve", w.reg.get("tek"), "ok")
    assert res == "approved"
    await drain(w)
    assert (await w.ls.get(les["code"]))["status"] == "approved"
    s = await system_for(w, "bank")
    assert LESSON in s and s.index(LESSON) > s.index("## Runtime") and "Learned guidance (persona bank, v1)" in s
    assert LESSON not in await system_for(w, "tek")                      # other persona unaffected
    assert LESSON not in await system_for(w, "bank", trigger="approval_review")
    # rollback to 0 removes, rollback to 1 restores
    await w.ov.rollback("persona", "bank", 0, "cli:boss")
    assert LESSON not in await system_for(w, "bank")
    await w.ov.rollback("persona", "bank", 1, "cli:boss")
    assert LESSON in await system_for(w, "bank")
    # delete removes from prompt, and rollback cannot resurrect it (G033-01)
    await w.ls.delete(les["code"], HUMAN, "bad")
    assert LESSON not in await system_for(w, "bank")
    await w.ov.rollback("persona", "bank", 1, "cli:boss")
    assert LESSON not in await system_for(w, "bank")
    # main prompt untouched
    assert w.reg.get("bank").body == bank_main and prompt_hashes() == before


async def test_e2e_g1_hits_go_hq_and_classifier_never_called(db):
    w = await world(db, js("Always ask for admin permission before changing the shared budget sheet totals"))
    codes = await w.ls.propose(await done_task(db, "bank"))
    card = await db.fetchrow("SELECT * FROM approvals")
    assert codes and card["level"] == "hq" and card["route_reason"] == "classifier_major" and w.classified == []


async def test_e2e_head_proposer_goes_hq(db):
    w = await world(db, js(LESSON))
    await w.ls.propose(await done_task(db, "tek"))
    assert (await db.fetchrow("SELECT * FROM approvals"))["route_reason"] == "requester_is_head"


async def test_e2e_human_override_rejects_then_prompt_clean(db):
    w = await world(db, js(LESSON))
    await w.ls.propose(await done_task(db, "bank"))
    card = await db.fetchrow("SELECT * FROM approvals")
    assert await w.ap.decide_as_head(card["id"], "approve", w.reg.get("tek"), "ok") == "approved"
    await drain(w)
    assert LESSON in await system_for(w, "bank")
    d = await asyncio.wait_for(w.ap.decide(card["id"], "reject", HUMAN), 5)
    assert d.outcome == "rejected"
    await drain(w)
    assert LESSON not in await system_for(w, "bank")


async def test_e2e_hire_then_fire(db):
    w = await world(db, "")
    p = await w.ctx.growth.staff.hire(pid="ben", name="Ben Tan", aliases="benny", role="Helps onboarding", dept="dev",
                                      model="google/cheap", actor=ADMIN)
    s = await system_for(w, "ben")                                       # usable without restart
    assert "ben | Ben Tan | dev" in s and p.body in s
    await w.ctx.growth.staff.fire("ben", "left", ADMIN)
    r = await w.eng.run(req(Sink(), agent_id="ben"))
    assert not r.ok and r.error == "unknown_agent"


async def test_defect001_approval_with_real_settings_does_not_deadlock(db):
    """No workaround: a head approval must activate the overlay within 5 s (fails today: tx self-deadlock)."""
    w = await world(db, js(LESSON))
    await w.ls.propose(await done_task(db, "bank"))
    row = await db.fetchrow("SELECT * FROM approvals")
    await db.execute("UPDATE approvals SET status='approved', decided_by='agent:tek' WHERE id=?1", row["id"])
    row = await db.fetchrow("SELECT * FROM approvals")
    await asyncio.wait_for(w.ls.on_decision(row), 5)
    assert LESSON in await system_for(w, "bank")
