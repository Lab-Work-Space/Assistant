"""Tasks/brainstorm repo + orchestration against a temp SQLite file (spec 11.14)."""
import os
import re
import types
import uuid

import pytest
import pytest_asyncio

from core.agent_tools import brainstorm as bt
from core.agent_tools import task as tt
from core.agent_tools.registry import Registry
from core.interfaces import AgentResult, Persona, ToolCall, ToolContext, Usage
from core.tasks.brainstorm import Orchestrator
from core.tasks.service import TaskService
from tests.conftest import task_card

pytestmark = pytest.mark.asyncio(loop_scope="module")
GUILD, CH, TASKS_CH = 111111111111111111, 222222222222222222, 333333333333333333


def persona(i, tools=("*",)):
    return Persona(id=i, name=i.title(), aliases=(), role="r", dept="d", model="x/y", cheap_model="x/y",
                   effort="low", tools=tools, traits=(), color=0, avatar_url=None, fragments=(), body="", path="")


class Log:
    def __init__(self): self.recs = []
    def write_log(self, system, event, level="INFO", **f): self.recs.append((event, f))


class Sink:
    def __init__(self, port, cid, p): self.port, self.cid, self.p = port, cid, p
    async def start(self): pass
    async def write(self, d): self.port.posts.append((self.cid, self.p.id, d))
    async def finish(self): return [self.port.mid()]
    async def fail(self, t): pass
    async def send_embed(self, e, view=None): self.port.embeds.append((self.cid, self.p.id, e)); return self.port.mid()
    async def send_file(self, *a, **k): return 0


_N = [5000]


class Port:
    def __init__(self): self.posts, self.embeds, self.edits, self.fail_thread = [], [], [], False
    def mid(self): _N[0] += 1; return _N[0]
    def sink_for(self, cid, p): return Sink(self, cid, p)
    async def create_thread(self, ch, mid, name):
        if self.fail_thread: raise RuntimeError("boom")
        return self.mid() + 10**17
    async def edit_embed(self, ch, mid, e): self.edits.append((ch, mid, e))
    async def history(self, tid, limit): return [(p, t) for c, p, t in self.posts if c == tid][-limit:]


class Engine:
    def __init__(self, port, tokens=100, fail=False):
        self.port, self.tokens, self.fail, self.reqs = port, tokens, fail, []

    async def run(self, req):
        self.reqs.append(req)
        if self.fail:
            return AgentResult(False, "", [], Usage(), [], "r", "provider_unavailable")
        await req.sink.start()
        await req.sink.write(f"{req.agent_id}:{req.trigger}")
        ids = await req.sink.finish()
        return AgentResult(True, f"{req.agent_id}:{req.trigger}", ids, Usage(self.tokens, 0), [], "r")


def cfg(**kw):
    d = dict(brainstorm_turn_limit=10, brainstorm_token_budget=20000, brainstorm_turn_max_output_tokens=800,
             brainstorm_agent_daily_max=3, tasks_channel_id=TASKS_CH, discord_guild_id=GUILD,
             app_timezone="Asia/Bangkok", prompts_dir="prompts")
    return types.SimpleNamespace(**{**d, **kw})


@pytest_asyncio.fixture(loop_scope="module")
async def pool(tmp_path_factory):
    from core.db.sqlite import open_database
    from tests.conftest import make_db_path
    p = await open_database(make_db_path(tmp_path_factory.mktemp("db")))
    yield p
    await p.close()


@pytest_asyncio.fixture(loop_scope="module")
async def env(pool):
    await pool.execute("DELETE FROM brainstorm_threads")
    await pool.execute("DELETE FROM tasks")
    return make(pool)


def make(pool, tokens=100, fail=False, **c):
    port = Port()
    ps = {i: persona(i) for i in ("praw", "dev", "qa")}
    ctx = types.SimpleNamespace(config=cfg(**c), log=Log(), db=pool, surface="discord", threads=port)
    ctx.personas = types.SimpleNamespace(get=ps.get, all=lambda: list(ps.values()))
    ctx.engine = Engine(port, tokens, fail)
    emb = lambda title, desc, fields, color=0: {"title": title, "desc": desc, "fields": dict(fields)}
    svc = TaskService(ctx, embed=emb)
    ctx.task_service = svc
    ctx.tools = Registry(ctx.log)
    for s in [*tt.make_tools(svc), *bt.make_tools(ctx, svc.orch)]:
        ctx.tools.register(s)
    return types.SimpleNamespace(ctx=ctx, port=port, svc=svc, orch=svc.orch, ps=ps, engine=ctx.engine)


def tctx(e, agent="praw", trigger="human_message", human=12345, thread=None, rec=None):
    return ToolContext(agent=e.ps[agent], run_id="r", guild_id=GUILD, channel_id=CH, thread_id=thread,
                       trigger=trigger, human_user_id=human, sink=Sink(e.port, CH, e.ps[agent]), origin="discord",
                       thread_record_id=rec)


async def call(e, ctx, name, args):
    return await e.ctx.tools.invoke(ctx, ToolCall("1", name, args), e.ctx.tools.for_agent(ctx.agent))


async def test_task_delegation_runs_assignee_under_own_persona(env, pool):
    e = env
    r = await call(e, tctx(e), "task_create", {"assignee_agent_id": "dev", "title": "Fix it", **task_card()})
    assert r.ok, r.error
    await e.orch.wait_idle()
    tid = r.data["thread_id"]
    assert (CH, "praw", ) == e.port.embeds[0][:2] and re.match(r"^[A-Z]{2,4}-\d{4} ", e.port.embeds[0][2]["title"])
    run = [q for q in e.engine.reqs if q.trigger == "task_assigned"][0]
    assert run.agent_id == "dev" and run.thread_id == tid and run.human_user_id is None
    assert (tid, "dev", "dev:task_assigned") in e.port.posts  # replied under the assignee's own sink
    t = await pool.fetchrow("SELECT * FROM tasks WHERE thread_id=?1", tid)
    assert t["status"] == "in_progress" and t["embed_message_id"] and t["assignee_agent"] == "dev"
    b = await pool.fetchrow("SELECT * FROM brainstorm_threads WHERE thread_id=?1", tid)
    assert b["kind"] == "task" and b["turns_used"] == 1 and b["tokens_used"] == 100 and b["turn_limit"] == 10


async def test_task_validation_and_discord_failure(env, pool):
    e = env
    assert (await call(e, tctx(e), "task_create", {"assignee_agent_id": "praw", "title": "x"})).error == "invalid_assignee"
    assert (await call(e, tctx(e), "task_create", {"assignee_agent_id": "nobody", "title": "x"})).error == "invalid_assignee"
    assert "invalid_arguments" in (await call(e, tctx(e), "task_create", {"assignee_agent_id": "dev"})).error
    e.port.fail_thread = True
    assert (await call(e, tctx(e), "task_create", {"assignee_agent_id": "dev", "title": "bad", **task_card()})).error == "discord_error"
    e.port.fail_thread = False
    row = await pool.fetchrow("SELECT status, report FROM tasks WHERE title='bad'")
    assert (row["status"], row["report"]) == ("failed", "discord_error")


async def test_task_update_only_assignee_in_thread(env, pool):
    e = env
    r = await call(e, tctx(e), "task_create", {"assignee_agent_id": "dev", "title": "T2", **task_card()})
    await e.orch.wait_idle()
    tid = r.data["thread_id"]
    bad = await call(e, tctx(e, "qa", "task_assigned", None, tid), "task_update", {"status": "done"})
    assert bad.error == "not_task_assignee"
    assert (await call(e, tctx(e, "dev", "task_assigned", None), "task_update", {"status": "done"})).error == "not_task_assignee"
    ok = await call(e, tctx(e, "dev", "task_assigned", None, tid), "task_update", {"status": "done", "report": "ok"})
    assert ok.ok and ok.data["status"] == "done"
    again = await call(e, tctx(e, "dev", "task_assigned", None, tid), "task_update", {"status": "failed"})
    assert again.error == "task_closed"
    assert e.port.edits and e.port.edits[-1][2]["fields"]["Status"] == "done"


async def test_task_thread_stops_at_turn_limit_with_summary(pool):
    e = make(pool, brainstorm_turn_limit=2)
    r = await call(e, tctx(e), "task_create", {"assignee_agent_id": "dev", "title": "T3", **task_card()})
    await e.orch.wait_idle()
    assert await e.orch.reserve_turn(r.data["thread_id"])
    await e.orch.after_task_turn(r.data["thread_id"], 5)  # a human follow-up run = 2nd turn
    b = await pool.fetchrow("SELECT * FROM brainstorm_threads WHERE thread_id=?1", r.data["thread_id"])
    assert (b["status"], b["close_reason"], b["turns_used"]) == ("closed", "turn_limit", 2)
    assert b["summary_message_id"] and e.engine.reqs[-1].trigger == "brainstorm_summary"


async def start_bs(e, turn_limit=4, **kw):
    ctx = tctx(e, **kw)
    r = await call(e, ctx, "brainstorm_start", {"topic": "Pricing", "participants": ["praw", "dev"], "turn_limit": turn_limit})
    assert r.ok, r.error
    await e.orch.wait_idle()
    return await pool_row(e, r.data["thread_id"])


async def pool_row(e, tid):
    return await e.ctx.db.fetchrow("SELECT * FROM brainstorm_threads WHERE thread_id=?1", tid)


async def test_brainstorm_stops_at_turn_limit_with_summary(pool):
    e = make(pool)
    b = await start_bs(e, 4)
    assert (b["status"], b["close_reason"], b["turns_used"]) == ("closed", "turn_limit", 4)
    assert b["summary_message_id"] and b["owner_agent"] == "praw" and b["closed_at"]
    turns = [q for q in e.engine.reqs if q.trigger == "brainstorm_turn"]
    sp = [q.agent_id for q in turns]
    assert sp == ["praw", "dev", "praw", "dev"] and all(a != b2 for a, b2 in zip(sp, sp[1:]))  # no self-reply
    assert e.engine.reqs[-1].trigger == "brainstorm_summary" and e.engine.reqs[-1].tools_override == ()
    assert "Brainstorm summary" in e.engine.reqs[-1].system_extra and e.engine.reqs[-1].max_output_tokens == 1024
    owner_tools, other = turns[0].tools_override, turns[1].tools_override
    assert "brainstorm_end" in owner_tools and "brainstorm_end" not in other
    assert set(other) == {"knowledge_read_index", "knowledge_read", "knowledge_search"}
    assert turns[0].max_output_tokens == 800 and turns[1].context  # history carried


async def test_default_turn_limit_is_10(pool):
    e = make(pool)
    r = await call(e, tctx(e), "brainstorm_start", {"topic": "T", "participants": ["praw", "dev", "qa"]})
    await e.orch.wait_idle()
    b = await pool_row(e, r.data["thread_id"])
    assert b["turn_limit"] == 10 and b["turns_used"] == 10 and b["close_reason"] == "turn_limit"


async def test_token_budget_stops_then_summarises(pool):
    e = make(pool, tokens=900, brainstorm_token_budget=1600)
    b = await start_bs(e, 10)
    assert (b["status"], b["close_reason"], b["turns_used"]) == ("closed", "token_budget", 2)
    assert b["summary_message_id"]


async def test_owner_ends_early(pool):
    e = make(pool)
    orig = e.engine.run

    async def run(req):
        res = await orig(req)
        if req.agent_id == "praw" and req.trigger == "brainstorm_turn" and len(e.engine.reqs) == 3:
            c = ToolContext(agent=e.ps["praw"], run_id="r", guild_id=GUILD, channel_id=req.thread_id,
                            thread_id=req.thread_id, trigger="brainstorm_turn", human_user_id=None, sink=req.sink,
                            origin="discord", thread_record_id=req.thread_record_id)
            assert (await call(e, tctx(e, "dev", "brainstorm_turn", None, req.thread_id, req.thread_record_id),
                               "brainstorm_end", {})).error == "not_owner"
            assert (await call(e, c, "brainstorm_end", {"reason": "enough"})).ok
        return res
    e.engine.run = run
    b = await start_bs(e, 10)
    assert (b["status"], b["close_reason"]) == ("closed", "owner_ended") and b["turns_used"] == 3
    assert b["summary_message_id"]
    assert (await call(e, tctx(e), "brainstorm_end", {})).error == "not_in_brainstorm"


async def test_agent_daily_cap_3_humans_unlimited(pool):
    await pool.execute("DELETE FROM brainstorm_threads")
    e = make(pool)
    for _ in range(3):
        await start_bs(e, 1, trigger="task_assigned", human=None)
    r = await call(e, tctx(e, trigger="task_assigned", human=None), "brainstorm_start",
                   {"topic": "T", "participants": ["praw", "dev"]})
    assert r.error == "daily_limit_reached"
    assert (await pool.fetchval("SELECT count(*) FROM brainstorm_threads WHERE initiated_by_kind='agent'")) == 3
    await start_bs(e, 1)  # human initiated: not capped
    # tasks (kind='task') do not count toward the cap
    assert (await call(e, tctx(e, human=None, trigger="task_assigned"), "task_create",
                       {"assignee_agent_id": "dev", "title": "x", **task_card()})).ok
    await e.orch.wait_idle()


async def test_daily_cap_concurrent_race(pool):
    import asyncio
    await pool.execute("DELETE FROM brainstorm_threads")
    e = make(pool, brainstorm_agent_daily_max=3)
    rs = await asyncio.gather(*[call(e, tctx(e, trigger="task_assigned", human=None), "brainstorm_start",
                                     {"topic": "T", "participants": ["praw", "dev"], "turn_limit": 1})
                                for _ in range(8)])
    await e.orch.wait_idle()
    assert sum(r.ok for r in rs) == 3 and sum(r.error == "daily_limit_reached" for r in rs) == 5


async def test_no_agent_to_agent_outside_open_brainstorm(pool):
    e = make(pool)
    b = await start_bs(e, 2)
    n = len(e.engine.reqs)
    assert b["status"] == "closed"
    await e.orch.wait_idle()
    assert len(e.engine.reqs) == n  # nothing runs after close
    assert all(q.human_user_id is None and q.trigger in ("brainstorm_turn", "brainstorm_summary") for q in e.engine.reqs)
    for trig in ("brainstorm_turn", "brainstorm_summary"):  # agents inside a brainstorm cannot spawn more
        c = tctx(e, trigger=trig, human=None)
        assert (await call(e, c, "task_create", {"assignee_agent_id": "dev", "title": "x"})).error == "not_allowed_here"
        assert (await call(e, c, "brainstorm_start", {"topic": "t", "participants": ["praw", "dev"]})).error == "not_allowed_here"
    bad = await call(e, tctx(e), "brainstorm_start", {"topic": "t", "participants": ["praw", "praw"]})
    assert "invalid_arguments" in bad.error
    assert (await call(e, tctx(e), "brainstorm_start", {"topic": "t", "participants": ["praw", "ghost"]})).error == "invalid_participants"


async def test_two_engine_errors_abort(pool):
    e = make(pool, fail=True)
    r = await call(e, tctx(e), "brainstorm_start", {"topic": "T", "participants": ["praw", "dev"]})
    await e.orch.wait_idle()
    b = await pool_row(e, r.data["thread_id"])
    assert (b["status"], b["close_reason"], b["turns_used"]) == ("aborted", "error", 2)


async def test_thread_creation_failure_aborts(pool):
    e = make(pool)
    e.port.fail_thread = True
    r = await call(e, tctx(e), "brainstorm_start", {"topic": "FAILTOPIC", "participants": ["praw", "dev"]})
    assert r.error == "discord_error"
    b = await pool.fetchrow("SELECT * FROM brainstorm_threads WHERE topic='FAILTOPIC'")
    assert (b["status"], b["close_reason"]) == ("aborted", "error")


async def test_t_db_10_repo_cap_concurrent_and_midnight_boundary(pool):
    import asyncio
    from datetime import datetime, timedelta
    from zoneinfo import ZoneInfo

    from core.db.sqlite import utc_text
    from core.tasks.repo import Repo
    repo = Repo(pool)
    await pool.execute("DELETE FROM brainstorm_threads")
    kw = dict(guild_id=GUILD, channel_id=5, topic="t", owner="praw", participants=["praw", "dev"], turn_limit=3,
              token_budget=2000, kind="agent", by_id="praw", daily_max=3, tz="Asia/Bangkok")
    rows = await asyncio.gather(*[repo.create_brainstorm(**kw) for _ in range(10)])
    assert sum(r is not None for r in rows) == 3
    await pool.execute("DELETE FROM brainstorm_threads")
    mid = datetime.now(ZoneInfo("Asia/Bangkok")).replace(hour=0, minute=0, second=0, microsecond=0)
    ins = ("INSERT INTO brainstorm_threads (kind, guild_id, parent_channel_id, topic, owner_agent, participants, turn_limit,"
           " token_budget, initiated_by_kind, initiated_by_id, created_at) VALUES ('brainstorm',?1,5,'t','praw','[\"praw\",\"dev\"]',3,2000,'agent','praw',?2)")
    await pool.execute(ins, GUILD, utc_text(mid - timedelta(milliseconds=1)))
    assert await repo.create_brainstorm(**{**kw, "daily_max": 1}) is not None  # yesterday's row not counted
    await pool.execute("DELETE FROM brainstorm_threads")
    await pool.execute(ins, GUILD, utc_text(mid))
    assert await repo.create_brainstorm(**{**kw, "daily_max": 1}) is None  # row at local midnight counted
