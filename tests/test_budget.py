import types
from datetime import date
from decimal import Decimal

import pytest

from core.budget import guard as G, repo
from core.budget.ext import init
from core.interfaces import Actor, NoopBudgetGuard, Usage, require_real_budget

ADMIN, USER = Actor("cli", "admin"), Actor("cli", "user")


class Log:
    def __init__(self):
        self.rows = []

    def write_log(self, system, event, level="INFO", **f):
        self.rows.append((event, level, f))


class Policy:
    surface = "cli"

    async def is_approver(self, a):
        return a.user_id == "admin"


def mkctx(db=None):
    cfg = types.SimpleNamespace(app_timezone="Asia/Bangkok", budget_default_daily_usd=Decimal("2.00"),
                                budget_gate_daily_usd=Decimal("0.50"))
    personas = types.SimpleNamespace(get=lambda a: object() if a == "praw" else None)
    return types.SimpleNamespace(config=cfg, log=Log(), db=db, personas=personas, approver_policy=Policy(),
                                 providers={"google": object()}, budget=NoopBudgetGuard())


@pytest.fixture
def mem(monkeypatch):
    """In-memory repo so thresholds are tested without a DB."""
    s = {"spent": 0, "limit": None, "notices": set(), "rows": [], "fail": False}

    async def spent(pool, a, d):
        if s["fail"]:
            raise RuntimeError("db down")
        return s["spent"]

    async def limit(pool, a):
        return s["limit"]

    async def insert(pool, *a):
        if s["fail"]:
            raise RuntimeError("db down")
        s["rows"].append(a)
        s["spent"] += a[8]

    async def notice(pool, a, d, lv):
        new = (a, lv) not in s["notices"]
        s["notices"].add((a, lv))
        return new

    async def upsert(pool, a, m, by):
        s["limit"], s["by"] = m, by

    for n, f in dict(spent=spent, limit=limit, insert_usage=insert, first_notice=notice, upsert_limit=upsert).items():
        monkeypatch.setattr(repo, n, f)
    return s


async def test_thresholds_and_notice_once(mem):
    ctx = mkctx()
    g = G.Guard(ctx)
    sent = []

    async def n(*a):
        sent.append(a[1])
    g.notifier = n
    mem["limit"] = 1_000_000
    seen = []
    for spent in (0, 799_999, 800_000, 999_999, 1_000_000, 1_199_999, 1_200_000):
        mem["spent"] = spent
        seen.append(await g.level("praw"))
        await g.level("praw")  # second call must not re-notify
    assert seen == ["ok", "ok", "warn", "warn", "fallback", "fallback", "stop"]
    assert sent == ["warn80", "fallback100", "stop120"]


async def test_default_and_gate_limits(mem):
    g = G.Guard(mkctx())
    mem["spent"] = 1_600_000
    assert await g.level("praw") == "warn"      # 80% of 2.00
    assert await g.level("_gate") == "stop"     # 320% of 0.50


async def test_set_limit(mem):
    g = G.Guard(mkctx())
    assert await g.set_limit("praw", Decimal(5), USER) == "not_approver" and mem["limit"] is None
    class AnyDiscord(Policy):  # G2-07: kind must equal policy.surface even if is_approver would say yes
        async def is_approver(self, a): return True
    g.ctx.approver_policy = AnyDiscord()
    assert await g.set_limit("praw", Decimal(5), Actor("discord", "444444444444444401")) == "not_approver" and mem["limit"] is None
    g.ctx.approver_policy = Policy()
    assert await g.set_limit("nobody", Decimal(5), ADMIN) == "invalid_agent"
    assert await g.set_limit("praw", Decimal("0.001"), ADMIN) == "out_of_range"
    assert await g.set_limit("praw", Decimal("1001"), ADMIN) == "out_of_range"
    assert await g.set_limit("praw", Decimal(5), ADMIN) == "ok"
    assert (mem["limit"], mem["by"]) == (5_000_000, "cli:admin")
    assert await g.set_limit("_gate", Decimal(1), ADMIN) == "ok"


async def test_policy_error_is_not_approver(mem):
    ctx = mkctx()

    async def boom(a):
        raise RuntimeError

    ctx.approver_policy.is_approver = boom
    assert await G.Guard(ctx).set_limit("praw", Decimal(5), ADMIN) == "not_approver"


async def test_level_fails_closed(mem):
    ctx = mkctx()
    mem["fail"] = True
    assert await G.Guard(ctx).level("praw") == "stop"
    assert ctx.log.rows[0][:2] == ("budget.level_error", "ERROR")
    assert ctx.log.rows[0][2] == {"agent": "praw", "error": "RuntimeError"}


async def test_record_failure_accounted(mem):
    ctx = mkctx()
    g = G.Guard(ctx)
    mem["limit"] = 1_000_000
    mem["fail"] = True
    await g.record("praw", "google", "gemini-3.8-flash", Usage(1000, 1000), "chat")  # no raise
    ev, lvl, f = ctx.log.rows[0]
    assert (ev, lvl) == ("budget.record_failed", "ERROR") and f["cost_micro_usd"] == 9000  # 1000*1.5 + 1000*7.5
    mem["fail"] = False
    mem["spent"] = 0
    assert await g.level("praw") == "ok"
    mem["fail"] = True
    await g.record("praw", "x", "claude-opus-5-5", Usage(0, 40_000), "chat")  # 800_000 never reaches the DB
    mem["fail"] = False
    mem["spent"] = 0
    assert await g.level("praw") == "warn"  # unrecorded 809_000 counted


async def test_image_tts_stt_cost_and_gating(mem):
    g = G.Guard(mkctx())
    mem["limit"] = 120_000
    await g.record("praw", "google", "img", Usage(), "image", units=1, ref="r")
    assert mem["rows"][0][8] == 67_000 and mem["rows"][0][7] == 1
    await g.record("praw", "google", "tts", Usage(), "tts", units=1000)
    assert mem["rows"][1][8] == 30_000
    assert await g.level("praw") == "warn"      # 97_000 of 120_000
    await g.record("praw", "google", "stt", Usage(), "stt", units=500)
    assert await g.level("praw") == "stop"      # 147_000 = 122.5%
    # image/TTS callers refuse at fallback|stop; the guard must report them
    mem["spent"] = 120_000
    assert await g.level("praw") == "fallback"


async def test_unknown_model_charged_max_and_warned_once(mem):
    ctx = mkctx()
    g = G.Guard(ctx)
    await g.record("praw", "x", "mystery", Usage(1_000_000, 0), "chat")
    await g.record("praw", "x", "mystery", Usage(0, 0), "chat")
    assert mem["rows"][0][8] == max(p[0] for p in __import__("core.budget.prices", fromlist=["TOKEN"]).TOKEN.values())
    assert [r[0] for r in ctx.log.rows].count("budget.unknown_model") == 1


async def test_aborted_stream_estimate_row(mem):
    g = G.Guard(mkctx())
    await g.record("praw", "google", "gemini-3.8-flash", Usage(50, 3), "chat", ref="run:est")
    assert mem["rows"][0][-1] == "run:est" and mem["rows"][0][8] > 0


def test_ext_replaces_noop_and_passes_require_real():
    ctx = mkctx()
    with pytest.raises(RuntimeError, match="budget_guard_missing"):
        require_real_budget(ctx)
    init(ctx)
    assert isinstance(ctx.budget, G.Guard)
    require_real_budget(ctx)


# ---- real SQLite (temp file at head) ----
async def test_db_roundtrip(db):
    pool = db
    if True:
        ctx = mkctx(pool)
        g = G.Guard(ctx)
        sent = []

        async def n(*a):
            sent.append(a[1])
        g.notifier = n
        assert await g.set_limit("praw", Decimal("1.00"), ADMIN) == "ok"
        assert await g.level("praw") == "ok"
        await g.record("praw", "google", "gemini-3.8-flash", Usage(0, 108_000), "chat", ref="a")  # 810_000
        assert await g.level("praw") == "warn"
        await g.record("praw", "google", "gemini-3.8-flash", Usage(0, 26_000), "chat", ref="b:est")  # 1_005_000
        assert await g.level("praw") == "fallback"
        await g.record("praw", "google", "img", Usage(), "image", units=5, ref="c")  # +335_000 -> 134%
        assert await g.level("praw") == "stop"
        assert await g.level("praw") == "stop"
        assert sent == ["warn80", "fallback100", "stop120"]
        assert await pool.fetchval("SELECT count(*) FROM budget_notices") == 3
        assert await g.set_limit("praw", Decimal(5), USER) == "not_approver"
        assert await pool.fetchval("SELECT updated_by FROM budgets WHERE agent_id='praw'") == "cli:admin"
        assert await repo.spent(pool, "praw", date.today()) >= 0


async def test_unit_price_key_strips_provider_prefix(db):
    from core.budget.guard import Guard
    from core.interfaces import Usage
    from types import SimpleNamespace as NS
    from core.budget import prices
    g = Guard(NS(config=NS(app_timezone="UTC", budget_default_daily_usd=2, budget_gate_daily_usd=1), log=NS(write_log=lambda *a, **k: None), db=db))
    assert g._cost("google/gemini-3.8-flash-tts", Usage(), "tts", 10) == 10 * prices.UNIT["tts"]["gemini-3.8-flash-tts"]
    assert g._cost("google/gemini-3.8-flash", Usage(), "stt", 3) == 3 * prices.UNIT["stt"]["gemini-3.8-flash"]
    assert g._cost("gemini-3.8-flash-tts", Usage(), "tts", 1) == 30 and not g._warned
