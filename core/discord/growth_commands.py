"""Growth slash commands (spec §2 G): /lesson, /overlay, /hire, /fire, /move, /dept. Settings channel + fresh approver
check via _setting_gate; ephemeral replies via _say; logs carry fixed tokens / ids only (G033-11)."""
import re

import discord

from core.approvals.depts import DEPT_CODES
from core.discord.client import env_suffix
from core.discord.commands import _deny_log, _say, _setting_gate
from core.growth import GrowthError

_LSN = re.compile(r"^LSN-[A-Z]{2,4}-[0-9]{4,}$")
_DEPT = re.compile(r"^[A-Z]{2,4}$")
_PID = re.compile(r"^[a-z][a-z0-9_-]{1,31}$")
_UNAVAILABLE = "Growth is not available. / ระบบเติบโตยังไม่พร้อม"
_ERR = {
    "invalid_target": "Unknown persona or department. / ไม่พบพนักงานหรือแผนก",
    "not_found": "Not found. / ไม่พบ",
    "lesson_closed": "Lesson already closed. / บทเรียนนี้ปิดแล้ว",
    "version_not_found": "No such version. / ไม่พบเวอร์ชันนี้",
    "same_version": "Already active. / ใช้เวอร์ชันนี้อยู่แล้ว",
    "id_invalid": "Invalid id (a-z 0-9 _ -, 2-32). / รหัสไม่ถูกต้อง",
    "name_taken": "Name or alias already used. / ชื่อหรือชื่อเล่นซ้ำ",
    "role_invalid": "Invalid role text. / คำอธิบายบทบาทไม่ถูกต้อง",
    "dept_unknown": "Unknown department. / ไม่พบแผนก",
    "dept_hq_only": "HQ departments cannot be used here. / ใช้แผนก HQ ไม่ได้",
    "model_not_allowed": "Model is not in the configured list. / โมเดลไม่อยู่ในรายการ",
    "persona_unknown": "Unknown persona. / ไม่พบพนักงาน",
    "persona_protected": "This persona cannot be changed. / เปลี่ยนพนักงานคนนี้ไม่ได้",
    "already_fired": "Already disabled. / ถูกปิดใช้งานแล้ว",
    "head_invalid": "Cannot be head (needs its own bot, same dept). / เป็นหัวหน้าไม่ได้",
    "code_taken": "Department code already used. / รหัสแผนกซ้ำ",
    "dept_name_taken": "Department name already used. / ชื่อแผนกซ้ำ",
    "dept_name_invalid": "Invalid department name (1-64 printable chars). / ชื่อแผนกไม่ถูกต้อง",
    "same_dept": "Already in that department. / อยู่แผนกนี้อยู่แล้ว",
    "dept_partial": "Department added, but its approval channel or head was not set. Fix with /setting or /move. / เพิ่มแผนกแล้ว แต่ตั้งห้องหรือหัวหน้าไม่สำเร็จ",
    "channel_invalid": "Invalid approval channel. / ห้องอนุมัติไม่ถูกต้อง",
}
for _k in ("id_taken", "id_reserved", "suffix_taken"):
    _ERR[_k] = "Id already used or reserved. / รหัสนี้ถูกใช้หรือสงวนไว้"
for _k in ("name_invalid", "alias_invalid"):
    _ERR[_k] = "Invalid name or alias. / ชื่อหรือชื่อเล่นไม่ถูกต้อง"
for _k in ("code_invalid", "code_reserved"):
    _ERR[_k] = "Code must be 2-4 capital letters, not reserved. / รหัสแผนกไม่ถูกต้อง"
for _k in ("template_invalid", "growth_unavailable"):
    _ERR[_k] = _UNAVAILABLE


def _target(raw: str) -> tuple[str, str] | None:
    t = (raw or "").strip()
    if _DEPT.fullmatch(t.upper()) and t == t.upper():
        return ("dept", t) if t in DEPT_CODES.values() else None
    return ("persona", t) if _PID.fullmatch(t) else None


async def _run(app, interaction, cmd: str, svc: str, call, ok):
    """Gate, resolve the service (None -> growth_unavailable), run `call(service, actor_ref)`, map GrowthError.
    `ok(result)` builds the success line."""
    actor = await _setting_gate(app, interaction, cmd, None)
    if actor is None:
        return
    g = getattr(app.ctx, "growth", None)
    s = getattr(g, svc, None) if g is not None else None
    if s is None:
        _deny_log(app, cmd, actor, "growth_unavailable")
        return await _say(interaction, _UNAVAILABLE)
    try:
        res = await call(s, actor.ref)
    except GrowthError as e:
        _deny_log(app, cmd, actor, e.code)
        return await _say(interaction, _ERR.get(e.code, _UNAVAILABLE))
    await _say(interaction, ok(res))


async def _bad(app, interaction, cmd: str, reason: str, line: str):
    actor = await _setting_gate(app, interaction, cmd, None)
    if actor is not None:
        _deny_log(app, cmd, actor, reason)
        await _say(interaction, line)


def _lesson_row(r) -> str:
    st = r["status"] + (f" ({r['card_status']})" if r["status"] == "pending" and r.get("card_status") else "")
    return f"{r['code']} | {st} | {r['scope_kind']}:{r['scope_id']} | {r['category']} | {r['body'][:60]}"


async def lesson_list(app, interaction, target: str | None = None) -> None:
    tg = None
    if target and target.strip():
        tg = _target(target[:32])
        if tg is None:
            return await _bad(app, interaction, "lesson_list", "invalid_target", _ERR["invalid_target"])
    await _run(app, interaction, "lesson_list", "lessons", lambda s, a: s.list(tg, 20),
               lambda rows: "\n".join(_lesson_row(r) for r in rows[:20]) or "No lessons. / ไม่มีบทเรียน")


def _code(raw) -> str | None:
    c = (raw or "").strip().upper()
    return c if len(c) <= 24 and _LSN.fullmatch(c) else None


async def lesson_show(app, interaction, code: str) -> None:
    c = _code(code)
    if c is None:
        return await _bad(app, interaction, "lesson_show", "not_found", _ERR["not_found"])

    async def call(s, _a):
        r = await s.get(c)
        if r is None:
            raise GrowthError("not_found")
        return r
    await _run(app, interaction, "lesson_show", "lessons", call, lambda r: (
        f"{r['code']} | {r['status']} | {r['scope_kind']}:{r['scope_id']} | {r['category']}\n"
        f"By: {r['proposed_by']} | Task: {r.get('task_code') or '-'} | Created: {r['created_at']}\n{r['body']}"))


async def lesson_delete(app, interaction, code: str, reason: str | None = None) -> None:
    c = _code(code)
    if c is None:
        return await _bad(app, interaction, "lesson_delete", "not_found", _ERR["not_found"])
    await _run(app, interaction, "lesson_delete", "lessons", lambda s, a: s.delete(c, a, (reason or "")[:200]),
               lambda _r: f"{c} deleted. / ลบแล้ว")


async def overlay_history(app, interaction, target: str) -> None:
    tg = _target(target[:32] if target else "")
    if tg is None:
        return await _bad(app, interaction, "overlay_history", "invalid_target", _ERR["invalid_target"])

    def fmt(rows) -> str:
        return "\n".join(f"v{r['version']} | {r['created_at']} | {r['reason']} | {len(r.get('lesson_ids') or [])} | "
                         f"{r.get('chars', len(r.get('body') or ''))}{' | *active' if r.get('active') else ''}"
                         for r in rows[:15]) or "No versions. / ไม่มีเวอร์ชัน"
    await _run(app, interaction, "overlay_history", "overlays", lambda s, a: s.history(*tg, 15), fmt)


async def overlay_rollback(app, interaction, target: str, version: int) -> None:
    tg = _target(target[:32] if target else "")
    if tg is None:
        return await _bad(app, interaction, "overlay_rollback", "invalid_target", _ERR["invalid_target"])
    if not isinstance(version, int) or isinstance(version, bool) or not 0 <= version <= 1000000:
        return await _bad(app, interaction, "overlay_rollback", "version_not_found", _ERR["version_not_found"])
    await _run(app, interaction, "overlay_rollback", "overlays", lambda s, a: s.rollback(*tg, version, a),
               lambda r: f"{tg[1]}: v{r[0]} -> v{r[1]}. / ย้อนเวอร์ชันแล้ว")


async def hire(app, interaction, id: str, name: str, aliases: str, role: str, dept: str, model: str) -> None:  # noqa: A002
    pid = (id or "")[:32]
    await _run(app, interaction, "hire", "staff",
               lambda s, a: s.hire(pid=pid, name=(name or "")[:80], aliases=(aliases or "")[:400], role=(role or "")[:300],
                                   dept=(dept or "")[:32], model=(model or "")[:80], actor=a),
               lambda p: f"Hired {pid} ({p.name}) in {DEPT_CODES.get(p.dept, p.dept.upper())}. Speaks via Praw until "
                         f"DISCORD_BOT_TOKEN_{env_suffix(pid)} is set. / จ้างแล้ว")


async def fire(app, interaction, persona: str, reason: str | None = None) -> None:
    pid = (persona or "")[:32]
    await _run(app, interaction, "fire", "staff", lambda s, a: s.fire(pid, (reason or "")[:200], a),
               lambda _r: f"{pid} disabled. / ปิดใช้งานแล้ว")


async def move(app, interaction, persona: str, dept: str, head: bool = False) -> None:
    pid = (persona or "")[:32]
    await _run(app, interaction, "move", "staff", lambda s, a: s.move(pid, (dept or "")[:32], bool(head), a),
               lambda r: f"{pid}: {r[0]} -> {r[1]}. / ย้ายแล้ว")


async def dept_add(app, interaction, code: str, name: str, head: str | None = None, approval_channel: str | None = None) -> None:
    c = (code or "")[:4]
    await _run(app, interaction, "dept_add", "staff",
               lambda s, a: s.add_dept(c, (name or "")[:64], (head or "")[:32] or None, (approval_channel or "")[:20] or None, a),
               lambda _r: f"Department {c} added. / เพิ่มแผนกแล้ว")


def register_growth_commands(app) -> None:
    S = lambda d, n=32, **k: discord.Option(str, d, max_length=n, **k)  # noqa: E731
    lsn, ovl, dpt = (discord.SlashCommandGroup(n, d) for n, d in (("lesson", "Growth lessons"), ("overlay", "Prompt overlays"),
                                                                    ("dept", "Departments")))

    singles = []

    def _cmd(**kw):
        return lambda f: singles.append(discord.slash_command(**kw)(f)) or f

    @lsn.command(name="list", description="List lessons (settings channel, approver role)")
    async def _ll(ctx, target: S("persona id or department code", required=False) = None):  # noqa: F821
        await lesson_list(app, ctx.interaction, target)

    @lsn.command(name="show", description="Show a lesson")
    async def _ls(ctx, code: S("lesson code", 24)):  # noqa: F821
        await lesson_show(app, ctx.interaction, code)

    @lsn.command(name="delete", description="Delete a lesson")
    async def _ld(ctx, code: S("lesson code", 24), reason: S("reason", 200, required=False) = None):  # noqa: F821
        await lesson_delete(app, ctx.interaction, code, reason)

    @ovl.command(name="history", description="Overlay versions (15 newest)")
    async def _oh(ctx, target: S("persona id or department code")):  # noqa: F821
        await overlay_history(app, ctx.interaction, target)

    @ovl.command(name="rollback", description="Activate an older overlay version (0 = empty)")
    async def _or(ctx, target: S("persona id or department code"),  # noqa: F821
                  version: discord.Option(int, "version", min_value=0, max_value=1000000)):  # noqa: F821
        await overlay_rollback(app, ctx.interaction, target, version)

    @_cmd(name="hire", description="Hire a persona")
    async def _h(ctx, id: S("persona id"), name: S("display name", 80), aliases: S("comma-separated aliases", 400),  # noqa: F821
                 role: S("role description", 300), dept: S("department"), model: S("model", 80)):  # noqa: F821
        await hire(app, ctx.interaction, id, name, aliases, role, dept, model)

    @_cmd(name="fire", description="Disable a persona (soft)")
    async def _f(ctx, persona: S("persona id"), reason: S("reason", 200, required=False) = None):  # noqa: F821
        await fire(app, ctx.interaction, persona, reason)

    @_cmd(name="move", description="Move a persona to another department")
    async def _m(ctx, persona: S("persona id"), dept: S("department"),  # noqa: F821
                 head: discord.Option(bool, "make head", required=False, default=False) = False):  # noqa: F821
        await move(app, ctx.interaction, persona, dept, head)

    @dpt.command(name="add", description="Add a department")
    async def _da(ctx, code: S("2-4 capital letters", 4), name: S("name", 64), head: S("head persona", required=False) = None,  # noqa: F821
                  approval_channel: S("approval channel id or hq", 20, required=False) = None):  # noqa: F821
        await dept_add(app, ctx.interaction, code, name, head, approval_channel)

    for g in (lsn, ovl, dpt, *singles):
        app.intake.add_application_command(g)
