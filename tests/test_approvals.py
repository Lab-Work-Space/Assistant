"""Approvals service against a temp SQLite file (spec 11.14)."""
import asyncio
import os
import types

import pytest
import pytest_asyncio

from core.agent_tools.approval import make_approval_request
from core.cli.fakes import card_fields
from core.approvals.service import CliDevApproverPolicy, PgApprovalService, make_generic_handler
from core.db.sqlite import open_database
from core.interfaces import Actor, ToolContext, ToolResult

pytestmark = pytest.mark.asyncio(loop_scope="module")
ADMIN, OTHER = Actor("cli", "admin"), Actor("cli", "bob")


class Log:
    def __init__(self): self.events = []

    def write_log(self, system, message, level="INFO", **f): self.events.append((message, f))


class Policy:
    surface = "cli"

    async def is_approver(self, a):
        return a.user_id == "admin"


class Engine:
    def __init__(self): self.reqs = []

    async def run(self, req): self.reqs.append(req)


class Presenter:
    def __init__(self): self.shown = []

    async def show_request(self, row): return None, None

    async def show_decision(self, row, actor): self.shown.append((row["status"], actor))


def cfg(**kw):
    return types.SimpleNamespace(approval_ttl_h=24, discord_guild_id=1, **kw)


@pytest_asyncio.fixture(loop_scope="module")
async def pool(tmp_path_factory):
    from tests.conftest import make_db_path
    p = await open_database(make_db_path(tmp_path_factory.mktemp("db")))
    await p.execute("DELETE FROM approvals")
    yield p
    await p.close()


@pytest_asyncio.fixture(loop_scope="module")
async def svc(pool):
    await pool.execute("DELETE FROM approvals")
    eng = Engine()
    s = PgApprovalService(pool, cfg(), Log(), Policy(), Presenter())
    s.register_handler("generic", make_generic_handler(types.SimpleNamespace(engine=eng, config=cfg())))
    s.eng = eng
    return s


async def req(s, origin="cli", agent="praw"):
    return await s.request(kind="generic", title="Use tool", summary="s", access=["a"], requested_by=agent,
                           origin=origin, human_user_id=None, origin_channel_id=5, origin_thread_id=None, payload={})


async def status(pool, i):
    return await pool.fetchval("SELECT status FROM approvals WHERE id=?1", i)


async def test_non_approver_refused_and_not_stored(svc, pool):
    i = await req(svc)
    d = await svc.decide(i, "approve", OTHER)
    assert d.outcome == "not_approver" and await status(pool, i) == "pending"
    assert ("approval.denied", {"id": i, "by": "cli:bob", "reason": "role"}) in svc.log.events
    assert (await svc.decide(i, "approve", Actor("discord", "1" * 18))).outcome == "not_approver"  # surface mismatch


async def test_approve_stores_actor_ref_and_wakes_agent(svc, pool):
    i = await req(svc)
    d = await svc.decide(i, "approve", ADMIN)
    await asyncio.gather(*svc._tasks)
    assert d.outcome == "approved" and d.approval["decided_by"] == "cli:admin"
    assert await pool.fetchval("SELECT decided_by FROM approvals WHERE id=?1", i) == "cli:admin"
    (r,) = svc.eng.reqs
    assert r.agent_id == "praw" and r.trigger == "approval_decided" and r.human_user_id is None
    assert r.text == "Use tool was approved by cli:admin"
    assert svc.presenter.shown[-1][0] == "approved"


async def test_reject_wakes_agent(svc):
    i = await req(svc)
    assert (await svc.decide(i, "reject", ADMIN)).outcome == "rejected"
    await asyncio.gather(*svc._tasks)
    assert "rejected by cli:admin" in svc.eng.reqs[0].text


async def test_duplicate_and_expired_and_not_found(svc, pool):
    i = await req(svc)
    await svc.decide(i, "approve", ADMIN)
    assert (await svc.decide(i, "reject", ADMIN)).outcome == "already_decided"
    assert await status(pool, i) == "approved"
    j = await req(svc)
    await pool.execute("UPDATE approvals SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 seconds') WHERE id=?1", j)
    assert (await svc.decide(j, "approve", ADMIN)).outcome == "expired" and await status(pool, j) == "pending"
    assert (await svc.decide("nope", "approve", ADMIN)).outcome == "not_found"
    assert (await svc.decide("00000000-0000-0000-0000-000000000000", "approve", ADMIN)).outcome == "not_found"
    assert await svc.sweep_expired() == 1 and await status(pool, j) == "expired"
    assert svc.presenter.shown[-1] == ("expired", None)


async def test_origin_mismatch_is_not_approver_and_unchanged(svc, pool):
    i = await req(svc)
    await pool.execute("UPDATE approvals SET origin='discord' WHERE id=?1", i)
    assert (await svc.decide(i, "approve", ADMIN)).outcome == "not_approver"
    assert await status(pool, i) == "pending"


async def test_request_origin_must_match_surface_g2_07(svc, pool):
    with pytest.raises(ValueError, match="origin_mismatch"):
        await req(svc, origin="discord")
    assert await pool.fetchval("SELECT count(*) FROM approvals") == 0


async def test_double_decide_race_one_decision(svc, pool):
    i = await req(svc)
    ds = await asyncio.gather(*[svc.decide(i, "approve" if n % 2 else "reject", ADMIN) for n in range(8)])
    await asyncio.gather(*svc._tasks)
    outs = sorted(d.outcome for d in ds)
    assert sum(o in ("approved", "rejected") for o in outs) == 1 and outs.count("already_decided") == 7
    assert len(svc.eng.reqs) == 1


async def test_unsupported_kind_and_rate_limit(svc):
    with pytest.raises(ValueError, match="unsupported_kind"):
        await svc.request(kind="config_change", title="t", summary="", access=[], requested_by="praw", origin="cli",
                          human_user_id=None, origin_channel_id=5, origin_thread_id=None, payload={})
    for _ in range(9):
        await req(svc, agent="rl")
    await req(svc, agent="rl")
    with pytest.raises(ValueError, match="rate_limited"):
        await req(svc, agent="rl")


async def test_tool_passes_context_and_maps_errors():
    seen = {}

    class A:
        async def request(self, **kw):
            seen.update(kw)
            if kw["title"] == "limit":
                raise ValueError("rate_limited")
            return "id1"

    spec = make_approval_request(types.SimpleNamespace(approvals=A()))
    ctx = ToolContext(agent=types.SimpleNamespace(id="praw"), run_id="r", guild_id=None, channel_id=7, thread_id=8,
                      trigger="chat", human_user_id=2, sink=None, origin="cli")
    card = {"summary": "a summary that is long enough", "reason": "because", "value_thb": 5, "priority": "low", "due": card_fields()["due"]}
    r = await spec.handler(ctx, {"title": "x", **card})
    assert r.ok and r.data == {"approval_id": "id1", "code": None}
    assert seen["origin"] == "cli" and seen["human_user_id"] == 2 and seen["origin_thread_id"] == 8 and seen["requested_by"] == "praw"
    assert (await spec.handler(ctx, {"title": "limit", **card})).error == "rate_limited"


async def test_cli_policy_gated_by_cli_dev_allowed(monkeypatch):
    c = types.SimpleNamespace()
    monkeypatch.delenv("EMP_CLI_DEV", raising=False)
    with pytest.raises(RuntimeError, match="cli_dev_disabled"):
        CliDevApproverPolicy(c)
    monkeypatch.setenv("EMP_CLI_DEV", "1")
    monkeypatch.delenv("DISCORD_BOT_TOKEN", raising=False)
    p = CliDevApproverPolicy(c)
    assert await p.is_approver(ADMIN) and not await p.is_approver(OTHER)
    monkeypatch.setenv("DISCORD_BOT_TOKEN", "x")
    assert not await p.is_approver(ADMIN)
