"""Embed builders (spec 5.5, 10.13.7) and the Discord ApprovalPresenter. Every string is masked and clamped."""
import json
import time

import discord

from core.discord.buttons import build_view, make_custom_id
from core.functions.logs.masking import mask_secrets

PENDING, APPROVED, REJECTED, EXPIRED = 0xFFB300, 0x43A047, 0xE53935, 0x9E9E9E


def _m(s, n: int) -> str:
    return mask_secrets(str(s))[:n]


def build_embed(title: str, description: str = "", fields: list[tuple[str, str]] = (), color: int = 0x808080):
    e = discord.Embed(title=_m(title, 256), description=_m(description, 4000), colour=color)
    for n, v in fields:
        e.add_field(name=_m(n, 256), value=_m(v, 1024) or "-", inline=True)
    return e


def mask_embed(e: discord.Embed) -> discord.Embed:
    """Defence in depth for embeds built elsewhere: mask text fields in place."""
    e.title, e.description = _m(e.title, 256) if e.title else e.title, _m(e.description, 4000) if e.description else e.description
    fields = [(f.name, f.value, f.inline) for f in e.fields]
    e.clear_fields()
    for n, v, i in fields:
        e.add_field(name=_m(n, 256), value=_m(v, 1024) or "-", inline=i)
    return e


def status_embed(persona, title: str, fields: list[tuple[str, str]] = ()):
    return build_embed(f"{persona.name}: {title}", "", fields, persona.color)


def pull_invite_embed(persona, reason: str, guild_id: int, channel_id: int):
    e = build_embed(f"{persona.name} invites you", "", [("Reason", reason)], persona.color)
    return e, build_view([("Join", None, f"https://discord.com/channels/{guild_id}/{channel_id}")])


_ROUTE = {"kind_dangerous": "Dangerous or irreversible kind", "access_requested": "Access requested",
          "value_over_threshold": "Value at or over the HQ threshold", "cross_dept": "Involves other departments",
          "no_dept": "No department head applies", "no_head": "Department has no AI head",
          "requester_is_head": "Requester is the department head", "ai_disabled": "AI review is off",
          "classifier_major": "Rated major by the classifier", "classifier_unavailable": "Classifier unavailable",
          "dept_routine": "Routine department work", "head_escalated": "Escalated by the department head",
          "head_no_decision": "Head made no decision", "head_guard_failed": "Head decision failed a server check",
          "legacy": "Existing request"}
_COLORS = {"pending": PENDING, "approved": APPROVED, "rejected": REJECTED, "expired": EXPIRED, "cancelled": EXPIRED,
           "escalated": EXPIRED}


def approval_embed(a: dict, status: str = "pending", by: str = ""):
    access = a.get("access") or []
    if isinstance(access, str):
        access = json.loads(access)
    origin = a.get("origin_thread_id") or a.get("origin_channel_id")
    v = a.get("value_thb")
    lvl = a.get("level") or "hq"
    dept = a.get("dept") or "HQ"
    f = [("Code", a.get("code") or "-"), ("Level", f"Department ({dept})" if lvl == "dept" else "HQ"), ("Department", dept),
         ("Requested by", a["requested_by"]),
         ("Triggered by", f"<@{a['human_user_id']}>" if a.get("human_user_id") else "agent-initiated"),
         ("Assignee", a.get("assignee") or "-"), ("Priority", a.get("priority") or "-"), ("Due", a.get("due") or "-"),
         ("Value (THB)", f"{v:,} THB" if v is not None else "-"), ("Kind", a["kind"]),
         ("Access", "\n".join(f"- {x}" for x in access) or "-"), ("Reason", a.get("reason") or "-"),
         ("Routing", _ROUTE.get(a.get("route_reason"), "-")),
         ("Origin", f"<#{origin}>" if origin else "-"),
         ("Status", status if not by else f"{status} by {by}")]
    dby, note = a.get("decided_by") or "", a.get("decision_reason")
    if dby.startswith("agent:") and note:
        f.append(("Decision note", f"AI decision by {dby[6:]}: {note} \u2014 approvers may override"))
    elif note:
        f.append(("Decision note", f"Head note: {note}"))
    if a["kind"] == "generic":
        f.append(("Note", "generic approval: informational, grants no permission"))
    return build_embed(f"Approval needed: {a.get('code') or ''} {a['title']}".replace(":  ", ": "), a.get("summary", ""), f,
                       _COLORS.get(status.split(" ")[0], PENDING))


class DiscordApprovalPresenter:
    """Posts the approval embed with buttons: HQ items to APPROVAL_CHANNEL_ID, department items to the department's
    channel setting (fallback HQ). 013B registers the 'appr' click handler."""

    def __init__(self, app):
        self.app = app

    async def _channel(self, a):
        app = self.app
        hq = app.intake.get_channel(app.cfg.approval_channel_id)
        settings = getattr(app.ctx, "settings", None)
        if a.get("level") != "dept" or settings is None:
            return hq
        v = await settings.approval_channel(a.get("dept") or "")
        if v == "hq":
            return hq
        ch = app.intake.get_channel(int(v)) if v.isdigit() else None
        if ch is None or not app.gate.channel_ok(ch):
            app.log.write_log("approvals", "approval.channel_fallback", "WARNING", code=a.get("code"),
                              reason="unresolved" if ch is None else "not_allowed")
            return hq
        return ch

    async def show_request(self, a):
        ch = await self._channel(a)
        if ch is None or not self.app.gate.channel_ok(ch):
            return None, None
        aid = str(a["id"])
        view = build_view([("Approve", make_custom_id("appr", "approve", aid), None, discord.ButtonStyle.success),
                           ("Reject", make_custom_id("appr", "reject", aid), None, discord.ButtonStyle.danger)])
        m = await ch.send(embed=approval_embed(a), view=view, allowed_mentions=discord.AllowedMentions.none())
        return ch.id, m.id

    async def show_moved(self, old_channel_id, old_message_id, a):
        """The old department card after an escalation: no buttons (and `_bound` rejects its old clicks)."""
        ch = self.app.intake.get_channel(old_channel_id)
        if ch is None:
            return
        try:
            await ch.get_partial_message(old_message_id).edit(embed=approval_embed(a, "escalated to HQ"), view=None)
        except discord.HTTPException:
            pass

    async def show_decision(self, a, actor):
        if not a.get("channel_id") or not a.get("message_id"):
            return
        ch = self.app.intake.get_channel(a["channel_id"])
        if ch is None:
            return
        status = a["status"]
        by = f"<@{actor.user_id}> <t:{int(time.time())}:f>" if actor and actor.kind == "discord" else (
            actor.ref if actor else a.get("decided_by") or "")
        view = None
        if (a.get("decided_by") or "").startswith("agent:") and status in ("approved", "rejected"):
            aid = str(a["id"])  # OQ-6: approvers may override an AI decision until expiry, so the buttons stay
            view = build_view([("Approve", make_custom_id("appr", "approve", aid), None, discord.ButtonStyle.success),
                               ("Reject", make_custom_id("appr", "reject", aid), None, discord.ButtonStyle.danger)])
        try:
            m = ch.get_partial_message(a["message_id"])
            await m.edit(embed=approval_embed(a, status, by), view=view)
        except discord.HTTPException:
            pass
