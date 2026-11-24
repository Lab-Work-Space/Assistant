"""TASK-033 T5 / AT-11: growth slash commands against fake services (spec §2 G)."""
import types

import pytest

from core.discord import commands as K, growth_commands as GC
from core.growth import GrowthError
from tests.discord_fakes import OTHER
from tests.test_discord_commands import APPROVER, HUMAN, STRANGER, Policy, inter, said, w  # noqa: F401


class Svc:
    """Records calls; `boom` makes every call raise GrowthError(boom)."""
    def __init__(self, boom=None):
        self.calls, self.boom = [], boom

    def __getattr__(self, name):
        async def f(*a, **k):
            self.calls.append((name, a, k))
            if self.boom:
                raise GrowthError(self.boom)
            return self.ret.get(name)
        return f

    ret = {"list": [{"code": "LSN-FIN-0001", "status": "pending", "card_status": "pending", "scope_kind": "dept", "scope_id": "FIN",
                     "category": "method", "body": "b" * 80}],
           "get": {"code": "LSN-FIN-0001", "status": "approved", "scope_kind": "dept", "scope_id": "FIN", "category": "method",
                   "proposed_by": "mali", "task_code": None, "created_at": "2026-01-01T00:00:00.000Z", "body": "Body text here."},
           "history": [{"version": 2, "created_at": "t", "reason": "lesson_approved", "lesson_ids": ["a"], "chars": 9, "active": True}],
           "rollback": (2, 1), "delete": {}, "hire": types.SimpleNamespace(name="Nok", dept="dev"), "fire": None,
           "move": ("dev", "hr"), "add_dept": "xx"}


def setup(w, svc=None):
    s = svc or Svc()
    w.app.ctx.growth = types.SimpleNamespace(lessons=s, overlays=s, staff=s)
    return s


def ok(w):
    return inter(w, APPROVER, ch=w.ch["other"]) if "other" in w.ch else inter(w, APPROVER, ch=w.app.intake.get_channel(OTHER))


CMDS = [("lesson_list", lambda a, i: GC.lesson_list(a, i)), ("lesson_show", lambda a, i: GC.lesson_show(a, i, "LSN-FIN-0001")),
        ("lesson_delete", lambda a, i: GC.lesson_delete(a, i, "LSN-FIN-0001")), ("overlay_history", lambda a, i: GC.overlay_history(a, i, "tek")),
        ("overlay_rollback", lambda a, i: GC.overlay_rollback(a, i, "FIN", 1)),
        ("hire", lambda a, i: GC.hire(a, i, "nok", "Nok", "nk", "r", "dev", "m")), ("fire", lambda a, i: GC.fire(a, i, "nok")),
        ("move", lambda a, i: GC.move(a, i, "nok", "hr")), ("dept_add", lambda a, i: GC.dept_add(a, i, "XX", "Xx"))]


async def test_at11_wrong_channel_and_non_approver_no_service_call(w):
    s = setup(w)
    for name, run in CMDS:
        i = inter(w, APPROVER)  # allowed channel, not the settings channel
        await run(w.app, i)
        assert said(i) == K._SETTING_ERR["wrong_channel"], name
        i = ok(w)
        i.user.id = STRANGER
        await run(w.app, i)
        assert said(i) == K._SETTING_ERR["not_approver"], name
    assert s.calls == []


async def test_success_replies_and_arguments(w):
    s = setup(w)
    exp = {"lesson_list": "LSN-FIN-0001 | pending (pending) | dept:FIN | method | " + "b" * 60, "lesson_show": "Body text here.",
           "lesson_delete": "LSN-FIN-0001 deleted. / ลบแล้ว", "overlay_history": "v2 | t | lesson_approved | 1 | 9 | *active",
           "overlay_rollback": "FIN: v2 -> v1. / ย้อนเวอร์ชันแล้ว",
           "hire": "Hired nok (Nok) in DEV. Speaks via Praw until DISCORD_BOT_TOKEN_NOK is set. / จ้างแล้ว",
           "fire": "nok disabled. / ปิดใช้งานแล้ว", "move": "nok: dev -> hr. / ย้ายแล้ว", "dept_add": "Department XX added. / เพิ่มแผนกแล้ว"}
    for name, run in CMDS:
        i = ok(w)
        await run(w.app, i)
        assert exp[name] in said(i) and i.response.said[0][1] is True, (name, said(i))
    assert s.calls[1][1] == ("LSN-FIN-0001",) and s.calls[3][1] == ("persona", "tek", 15)
    assert [c[0] for c in s.calls] == ["list", "get", "delete", "history", "rollback", "hire", "fire", "move", "add_dept"]
    assert s.calls[2][1][1] == f"discord:{APPROVER}"


@pytest.mark.parametrize("code,line", [(c, l) for c, l in GC._ERR.items()])
async def test_error_map(w, code, line):
    s = setup(w, Svc(boom=code))
    i = ok(w)
    await GC.fire(w.app, i, "nok")
    assert said(i) == line
    assert ("command.denied", {"kind": "fire", "by": f"discord:{APPROVER}", "reason": code}) in w.log.rows


async def test_error_lines_exact():
    assert GC._ERR["id_reserved"] == GC._ERR["suffix_taken"] == "Id already used or reserved. / รหัสนี้ถูกใช้หรือสงวนไว้"
    assert GC._ERR["template_invalid"] == GC._UNAVAILABLE == "Growth is not available. / ระบบเติบโตยังไม่พร้อม"


async def test_growth_or_staff_none(w):
    for g in (None, types.SimpleNamespace(lessons=Svc(), overlays=Svc(), staff=None)):
        w.app.ctx.growth = g
        i = ok(w)
        await GC.fire(w.app, i, "nok")
        assert said(i) == GC._UNAVAILABLE


async def test_target_and_code_parsing(w):
    s = setup(w)
    assert GC._target("FIN") == ("dept", "FIN") and GC._target("tek") == ("persona", "tek") and GC._target("fired_x-1") == ("persona", "fired_x-1")
    assert all(GC._target(t) is None for t in ("ZZZ", "T", "1ab", "a", "Tek", "x" * 33, "a b", ""))
    i = ok(w)
    await GC.overlay_history(w.app, i, "ZZZ")
    assert said(i) == GC._ERR["invalid_target"]
    i = ok(w)
    await GC.lesson_list(w.app, i, "Bad!")
    assert said(i) == GC._ERR["invalid_target"]
    for bad in ("nonsense", "LSN-FIN-1", "x" * 40):
        i = ok(w)
        await GC.lesson_show(w.app, i, bad)
        assert said(i) == GC._ERR["not_found"]
    i = ok(w)
    await GC.overlay_rollback(w.app, i, "tek", 1000001)
    assert said(i) == GC._ERR["version_not_found"] and s.calls == []


async def test_register_and_r24(w):
    names = {c.name for c in w.app.intake.commands}
    assert {"lesson", "overlay", "dept", "hire", "fire", "move"} <= names
    w.app.disabled, w.app.bots = {"a"}, {"a": 1, "b": 2}
    f = w.app.ctx.settings.is_disabled
    assert f("a") and f("zzz") and not f("b")
