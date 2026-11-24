"""approval_request tool (spec 3.4, R7). Kind generic: informational, grants no permission.
approval_decide / approval_escalate (R5, T031-01): override-only, usable only inside an approval_review run."""
from core.approvals.cards import CARD_REQUIRED, check_card
from core.approvals.depts import DEPT_CODES, HQ_ONLY
from core.interfaces import ToolContext, ToolResult, ToolSpec

_ID = "^[a-z][a-z0-9_-]{1,31}$"
SCHEMA = {"type": "object", "additionalProperties": False, "required": ["title", "summary"], "properties": {
    "title": {"type": "string", "minLength": 1, "maxLength": 256}, "summary": {"type": "string", "maxLength": 4000},
    "reason": {"type": "string", "maxLength": 1000}, "value_thb": {"type": "integer", "minimum": 0, "maximum": 1000000000},
    "priority": {"enum": ["low", "normal", "high", "urgent"]}, "due": {"type": "string", "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}$"},
    "assignee": {"type": "string", "pattern": _ID},
    "other_depts": {"type": "array", "maxItems": 15, "uniqueItems": True, "items": {"type": "string", "pattern": _ID}},
    "for_dept": {"type": "string", "pattern": _ID},
    "access": {"type": "array", "maxItems": 10, "items": {"type": "string", "maxLength": 200}}}}
DECIDE = {"type": "object", "additionalProperties": False, "required": ["action", "reason"],
          "properties": {"action": {"enum": ["approve", "reject"]}, "reason": {"type": "string", "minLength": 10, "maxLength": 500}}}
ESCALATE = {"type": "object", "additionalProperties": False, "required": ["reason"],
            "properties": {"reason": {"type": "string", "minLength": 10, "maxLength": 500}}}


def make_approval_request(app) -> ToolSpec:
    async def handler(ctx: ToolContext, a: dict) -> ToolResult:
        log = getattr(app, "log", None)
        fd = a.get("for_dept")
        cfg = getattr(app, "config", None)
        if fd is not None and not (ctx.agent.id == getattr(cfg, "intake_persona", None) and ctx.human_user_id
                                   and fd in DEPT_CODES and fd not in HQ_ONLY):
            return ToolResult(ok=False, error="for_dept_not_allowed")
        tz = getattr(cfg, "app_timezone", "Asia/Bangkok")
        err = check_card(a, CARD_REQUIRED, tz, getattr(app, "personas", None))
        if err:
            if log is not None:
                kind = err.split("missing=")[1] if "missing=" in err else "invalid"  # field names only, never values
                log.write_log("approvals", "approval.incomplete", "WARNING", agent=ctx.agent.id, kind=kind)
            return ToolResult(ok=False, error=err)
        try:
            aid = await app.approvals.request(
                kind="generic", title=a["title"], summary=a["summary"], access=a.get("access", []),
                requested_by=ctx.agent.id, origin=ctx.origin, human_user_id=ctx.human_user_id,
                origin_channel_id=ctx.channel_id, origin_thread_id=ctx.thread_id, payload={},
                reason=a.get("reason"), value_thb=a.get("value_thb"), priority=a.get("priority"), due=a.get("due"),
                assignee=a.get("assignee"), other_depts=a.get("other_depts", []), for_dept=fd,
                thread_record_id=ctx.thread_record_id)
        except ValueError as e:
            return ToolResult(ok=False, error=str(e))
        code = await app.db.fetchval("SELECT code FROM approvals WHERE id=?1", aid) if getattr(app, "db", None) else None
        return ToolResult(ok=True, content=f"approval_id={aid} code={code}", data={"approval_id": aid, "code": code})

    return ToolSpec("approval_request", "Ask for approval (your department head or HQ, routed automatically); you are woken when it is decided. Needs reason, "
                    "value_thb (honest estimate), priority and due.", SCHEMA, handler)


def make_head_tools(app) -> list[ToolSpec]:
    def guard(ctx):
        return ctx.trigger != "approval_review" or not ctx.approval_id

    async def decide(ctx: ToolContext, a: dict) -> ToolResult:
        if guard(ctx):
            return ToolResult(ok=False, error="not_allowed_here")
        out = await app.approvals.decide_as_head(ctx.approval_id, a["action"], ctx.agent, a["reason"])
        return ToolResult(ok=out in ("approved", "rejected"), content=out, error=None if out in ("approved", "rejected") else out)

    async def escalate(ctx: ToolContext, a: dict) -> ToolResult:
        if guard(ctx):
            return ToolResult(ok=False, error="not_allowed_here")
        out = await app.approvals.escalate_as_head(ctx.approval_id, ctx.agent, a["reason"])
        return ToolResult(ok=out == "escalated", content=out, error=None if out == "escalated" else out)

    return [ToolSpec("approval_decide", "Department head only: approve or reject the card under review.", DECIDE, decide,
                     override_only=True),
            ToolSpec("approval_escalate", "Department head only: send the card under review to HQ.", ESCALATE, escalate,
                     override_only=True)]


def init(ctx) -> None:
    if ctx.approvals is not None and ctx.tools is not None:
        ctx.tools.register(make_approval_request(ctx))
        for s in make_head_tools(ctx):
            ctx.tools.register(s)
