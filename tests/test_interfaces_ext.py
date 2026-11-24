import asyncio
import sys
import types
from decimal import Decimal

import pytest

import core.extensions as ext
from core import interfaces as I


def test_actor_and_ids():
    assert I.Actor("cli", "admin").ref == "cli:admin"
    assert I.Actor("discord", "1" * 18).ref == "discord:" + "1" * 18
    for kind, uid in (("cli", "Admin"), ("discord", "12"), ("web", "admin")):
        with pytest.raises(ValueError):
            I.Actor(kind, uid)
    assert I.CLI_HUMAN_IDS == {"admin": 1, "user": 2}


def test_noop_budget_denies_limit():
    assert asyncio.run(I.NoopBudgetGuard().set_limit("a", Decimal("1"), I.Actor("cli", "admin"))) == "not_approver"


def test_request_has_origin():
    r = I.AgentRequest("a", "human_message", None, 1, None, None, "t", origin="cli")
    assert r.human_actor is None


def _mods(monkeypatch, names, budget_sets=True):
    log = []
    for n in names:
        m = types.ModuleType(n)

        def init(ctx, n=n):
            log.append(n)
            if n == "core.budget.ext" and budget_sets:
                ctx.budget = types.SimpleNamespace()  # a "real" guard
            if n == "core.agents.ext":
                ctx.providers["p"] = object()
        m.init = init
        monkeypatch.setitem(sys.modules, n, m)
    return log


def _ctx(surface="cli"):
    return I.AppContext(config=None, log=None, db=None, personas=None, surface=surface, approver_policy=None)


def test_init_core_cli_without_discord(monkeypatch):
    monkeypatch.setattr(ext, "EXTENSIONS", ["core.budget.ext", "core.agents.ext", "core.gate.ext", "core.nonexistent_zz.ext"])
    log = _mods(monkeypatch, ["core.budget.ext", "core.agents.ext", "core.gate.ext"])
    ctx = _ctx()
    assert ext.init_core(ctx) == ["core.budget.ext", "core.agents.ext"]  # gate skipped on cli, missing optional skipped
    assert ctx.bot is None and "core.gate.ext" not in log


def test_noop_budget_refused(monkeypatch):  # Gate 2 probe
    monkeypatch.setattr(ext, "EXTENSIONS", ["core.budget.ext", "core.agents.ext"])
    _mods(monkeypatch, ["core.budget.ext", "core.agents.ext"], budget_sets=False)
    with pytest.raises(RuntimeError, match="budget_guard_missing"):
        ext.init_core(_ctx())


def test_required_missing_raises(monkeypatch):
    monkeypatch.setattr(ext, "EXTENSIONS", ["core.budget_missing_zz.ext"])
    monkeypatch.setattr(ext, "REQUIRED", {"core.budget_missing_zz.ext"})
    with pytest.raises(ModuleNotFoundError):
        ext.init_core(_ctx())


def test_inner_import_error_aborts(monkeypatch):
    m = types.ModuleType("core.jobs.ext")
    monkeypatch.setattr(ext, "EXTENSIONS", ["core.jobs.ext"])
    monkeypatch.setitem(sys.modules, "core.jobs.ext", m)
    import importlib
    real = importlib.import_module
    def boom(name):
        raise ModuleNotFoundError("x", name="some_third_party")
    monkeypatch.setattr(importlib, "import_module", boom)
    with pytest.raises(ModuleNotFoundError):
        ext.init_core(_ctx())


def test_rc1_no_core_cli_import_outside_cli():
    import pathlib, re
    for p in pathlib.Path("core").rglob("*.py"):
        if p.parts[1] == "cli":
            continue
        assert not re.search(r"from core\.cli|import core\.cli", p.read_text()), p
