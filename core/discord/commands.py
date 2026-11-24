"""Slash commands /task, /approval (spec R8) and /setting (R9). Registered on the intake client next to /budget; the
global cmd_gate check runs first. No listeners here (T031-08). Codes are bounded (24) and never autocompleted, the requester
match comes from the DB before any fresh approver lookup, and every denial is one enumeration-safe ephemeral line."""
import re

import discord

from core.discord.allowlist import refuse
from core.discord.approver import actor_from_interaction
from core.discord.notifier import _origin_ok
from core.functions.logs.masking import mask_secrets
from core.settings.service import KEYS, SettingsError
from core.tasks.brainstorm import ThreadError
from core.tasks.repo import Repo

DENIED = "Not found or not allowed. / ไม่พบหรือไม่มีสิทธิ์"
_TASK = re.compile(r"^([A-Z]{2,4}-[0-9]{4,}|TASK-[0-9]+)$")
_APR = re.compile(r"^APR-[A-Z]{2,4}-[0-9]{4,}$")
CODE_MAX, VALUE_MAX = 24, 256
FIELDS = ("title", "description", "priority", "due", "value_thb")
_SETTING_ERR = {"wrong_channel": "Use the settings channel. / ใช้ห้อง setting เท่านั้น",
                "settings_channel_unset": "Settings channel is not configured. / ยังไม่ได้ตั้งห้อง setting",
                "not_approver": "Only the approver role can change settings. / เฉพาะผู้อนุมัติเท่านั้น",
                "unknown_key": "Unknown setting key. / ไม่พบคีย์การตั้งค่า",
                "invalid_value": "Invalid value. / ค่าไม่ถูกต้อง"}


async def _say(interaction, text: str) -> None:
    await interaction.response.send_message(mask_secrets(text)[:2000], ephemeral=True)


def _by(actor) -> str:
    return actor.ref if actor is not None else "unknown"


def _deny_log(app, cmd: str, actor, reason: str) -> None:
    app.log.write_log("commands", "command.denied", "WARNING", kind=cmd, by=_by(actor), reason=reason)  # fixed tokens only


async def _start(app, interaction, cmd: str):
    """Origin + actor checks. Returns the Actor, or None after replying."""
    actor = actor_from_interaction(app, interaction) if _origin_ok(app, interaction) else None
    if actor is None:
        _deny_log(app, cmd, None, "origin")
        await refuse(interaction)
    return actor


async def _lookup(app, interaction, cmd: str, code: str, rx, table: str, creator):
    """-> (actor, row) when the caller may act on the row, else None after one ephemeral denial."""
    actor = await _start(app, interaction, cmd)
    if actor is None:
        return None
    code = (code or "").strip().upper()
    row = await app.ctx.db.fetchrow(f"SELECT * FROM {table} WHERE code=?1", code) if len(code) <= CODE_MAX and rx.fullmatch(code) else None
    if row is None:
        _deny_log(app, cmd, actor, "not_found")
    else:
        try:  # requester match first: no fetch_member
            ok, why = creator(row, actor) or await app.ctx.approver_policy.is_approver(actor), "not_allowed"
        except Exception:  # fail closed, same ephemeral reply (G2T031-04)
            ok, why = False, "approver_check_failed"
        if ok:
            return actor, row
        _deny_log(app, cmd, actor, why)
    await _say(interaction, DENIED)
    return None


def _task_creator(t, actor) -> bool:
    return t["created_by_kind"] == "human" and t["created_by_id"] == actor.user_id


def _apr_creator(a, actor) -> bool:
    return a["human_user_id"] is not None and str(a["human_user_id"]) == actor.user_id


def _v(x) -> str:
    return "-" if x is None or x == "" else str(x)


async def task_show(app, interaction, code: str) -> None:
    got = await _lookup(app, interaction, "task_show", code, _TASK, "tasks", _task_creator)
    if got:
        t = got[1]
        v = t["value_thb"]
        await _say(interaction, f"{t['code']} {t['title']}\nStatus: {t['status']} | Dept: {_v(t['dept'])} | Assignee: "
                   f"{t['assignee_agent']}\nPriority: {_v(t['priority'])} | Due: {_v(t['due'])} | Value: "
                   f"{'-' if v is None else f'{v:,} THB'}\n{t['description'][:1200]}")


async def task_edit(app, interaction, code: str, field: str, value: str) -> None:
    got = await _lookup(app, interaction, "task_edit", code, _TASK, "tasks", _task_creator)
    if not got:
        return
    actor, t = got
    if field not in FIELDS or len(value or "") > VALUE_MAX:
        return await _say(interaction, "Invalid input. / ข้อมูลไม่ถูกต้อง")
    try:
        n = await app.ctx.task_service.edit(t, field, value, actor.ref)
    except ThreadError as e:
        return await _say(interaction, f"Invalid: {e.code}")
    await _say(interaction, f"{n['code']} updated: {field}. / แก้ไขแล้ว" if n else "Task is closed. / งานปิดแล้ว")


async def task_cancel(app, interaction, code: str, reason: str | None = None) -> None:
    got = await _lookup(app, interaction, "task_cancel", code, _TASK, "tasks", _task_creator)
    if got:
        n = await app.ctx.task_service.cancel(got[1], got[0].ref, (reason or "")[:200])
        await _say(interaction, f"{n['code']} cancelled. / ยกเลิกแล้ว" if n else "Task is closed. / งานปิดแล้ว")


async def approval_show(app, interaction, code: str) -> None:
    got = await _lookup(app, interaction, "approval_show", code, _APR, "approvals", _apr_creator)
    if got:
        a = got[1]
        v = a["value_thb"]
        await _say(interaction, f"{a['code']} {a['title']}\nStatus: {a['status']} | Level: {a['level']} | Dept: {a['dept']}\n"
                   f"Requested by: {a['requested_by']} | Priority: {_v(a['priority'])} | Due: {_v(a['due'])} | Value: "
                   f"{'-' if v is None else f'{v:,} THB'}\nRouting: {a['route_reason']} | Decided by: {_v(a['decided_by'])}\n"
                   f"{a['summary'][:1000]}")


async def approval_cancel(app, interaction, code: str, reason: str | None = None) -> None:
    got = await _lookup(app, interaction, "approval_cancel", code, _APR, "approvals", _apr_creator)
    if got:
        n = await app.ctx.approvals.cancel(got[1]["code"], got[0], (reason or "")[:200])
        await _say(interaction, f"{n['code']} cancelled. / ยกเลิกแล้ว" if n else "Nothing to cancel. / ไม่มีรายการให้ยกเลิก")


# -- /setting ------------------------------------------------------------------------------------------------
async def _setting_gate(app, interaction, cmd: str, key: str | None):
    """Settings channel exactly (no threads), fresh approver, known key. Returns the Actor or None after replying."""
    actor = await _start(app, interaction, cmd)
    if actor is None:
        return None
    sid = getattr(app.cfg, "settings_channel_id", None)
    reason = ("settings_channel_unset" if sid is None else "wrong_channel" if interaction.channel_id != sid else
              "not_approver" if not await app.ctx.approver_policy.is_approver(actor) else
              "unknown_key" if key is not None and key not in KEYS else None)
    if reason:
        app.log.write_log("settings", "settings.denied", "WARNING", id=key if key in KEYS else "unknown", by=actor.ref, reason=reason)
        await _say(interaction, _SETTING_ERR[reason])
        return None
    return actor


async def setting_view(app, interaction, key: str | None = None) -> None:
    if await _setting_gate(app, interaction, "setting_view", key):
        rows = await app.ctx.settings.view(key)
        await _say(interaction, "\n".join(f"{k} = {v} ({src})" for k, v, src in rows))


async def setting_set(app, interaction, key: str, value: str) -> None:
    actor = await _setting_gate(app, interaction, "setting_set", key)
    if actor:
        try:
            old, new = await app.ctx.settings.set(key, (value or "")[:VALUE_MAX], actor.ref)
        except SettingsError as e:
            app.log.write_log("settings", "settings.denied", "WARNING", id=key, by=actor.ref, reason=e.code)
            return await _say(interaction, _SETTING_ERR[e.code])
        await _say(interaction, f"{key}: {old} -> {new}")


async def setting_reset(app, interaction, key: str) -> None:
    actor = await _setting_gate(app, interaction, "setting_reset", key)
    if actor:
        await _say(interaction, f"{key} reset to {await app.ctx.settings.reset(key, actor.ref)}")


def register_commands(app) -> None:
    """Guild-scoped on the intake client only. Also injects the channel resolver into the settings service."""
    st = getattr(app.ctx, "settings", None)
    if st is not None:
        def channel_ok(cid: int) -> bool:
            g = app.intake.get_guild(app.cfg.discord_guild_id)
            ch = g.get_channel(cid) if g is not None else None
            return ch is not None and getattr(ch, "type", None) == discord.ChannelType.text and app.gate.channel_ok(ch)
        st.channel_ok, st.is_disabled = channel_ok, lambda pid: pid in app.disabled

    Code = lambda: discord.Option(str, "work code", max_length=CODE_MAX)  # noqa: E731
    Why = lambda: discord.Option(str, "reason", required=False, max_length=200)  # noqa: E731
    t, a, s = (discord.SlashCommandGroup(n, d) for n, d in (("task", "Task codes"), ("approval", "Approval codes"),
                                                            ("setting", "Runtime settings")))

    @t.command(name="show", description="Show a task by code")
    async def _ts(ctx, code: Code()):  # noqa: F821
        await task_show(app, ctx.interaction, code)

    @t.command(name="edit", description="Edit an open task")
    async def _te(ctx, code: Code(), field: discord.Option(str, "field", choices=list(FIELDS)),  # noqa: F821
                  value: discord.Option(str, "new value", max_length=VALUE_MAX)):  # noqa: F821
        await task_edit(app, ctx.interaction, code, field, value)

    @t.command(name="cancel", description="Cancel a task (soft)")
    async def _tc(ctx, code: Code(), reason: Why() = None):  # noqa: F821
        await task_cancel(app, ctx.interaction, code, reason)

    @a.command(name="show", description="Show an approval by code")
    async def _as(ctx, code: Code()):  # noqa: F821
        await approval_show(app, ctx.interaction, code)

    @a.command(name="cancel", description="Cancel a pending approval (soft)")
    async def _ac(ctx, code: Code(), reason: Why() = None):  # noqa: F821
        await approval_cancel(app, ctx.interaction, code, reason)

    @s.command(name="view", description="View settings (settings channel, approver role)")
    async def _sv(ctx, key: discord.Option(str, "key", required=False, max_length=64) = None):  # noqa: F821
        await setting_view(app, ctx.interaction, key)

    @s.command(name="set", description="Change a setting (settings channel, approver role)")
    async def _ss(ctx, key: discord.Option(str, "key", max_length=64),  # noqa: F821
                  value: discord.Option(str, "value", max_length=VALUE_MAX)):  # noqa: F821
        await setting_set(app, ctx.interaction, key, value)

    @s.command(name="reset", description="Reset a setting to its default")
    async def _sr(ctx, key: discord.Option(str, "key", max_length=64)):  # noqa: F821
        await setting_reset(app, ctx.interaction, key)

    for g in (t, a, s):
        app.intake.add_application_command(g)
