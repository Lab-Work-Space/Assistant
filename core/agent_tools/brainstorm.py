"""brainstorm_start / brainstorm_end tools (spec 3.4, 3.6)."""
import uuid

from core.interfaces import ToolContext, ToolResult, ToolSpec
from core.tasks.brainstorm import ThreadError

_ID = "^[a-z][a-z0-9_-]{1,31}$"
START = {"type": "object", "additionalProperties": False, "required": ["topic", "participants"],
         "properties": {"topic": {"type": "string", "minLength": 1, "maxLength": 200},
                        "participants": {"type": "array", "minItems": 2, "maxItems": 6, "uniqueItems": True,
                                         "items": {"type": "string", "pattern": _ID}},
                        "turn_limit": {"type": "integer", "minimum": 1, "maximum": 20}}}
END = {"type": "object", "additionalProperties": False, "properties": {"reason": {"type": "string", "maxLength": 200}}}
BLOCKED = ("brainstorm_turn", "brainstorm_summary")


def make_tools(ctx_app, orch) -> list[ToolSpec]:
    async def start(ctx: ToolContext, a: dict) -> ToolResult:
        if ctx.trigger in BLOCKED:
            return ToolResult(ok=False, error="not_allowed_here")
        c = ctx_app.config
        kind, by = (("human", str(ctx.human_user_id)) if ctx.human_user_id and ctx.trigger == "human_message"
                    else ("agent", ctx.agent.id))
        channel = ctx.channel_id if ctx.guild_id is not None and ctx.thread_id is None else c.tasks_channel_id
        try:
            r = await orch.start(guild_id=ctx.guild_id or c.discord_guild_id, channel_id=channel, topic=a["topic"],
                                 participants=a["participants"], turn_limit=a.get("turn_limit"), caller=ctx.agent.id,
                                 kind=kind, by_id=by)
        except ThreadError as e:
            return ToolResult(ok=False, error=e.code)
        return ToolResult(ok=True, content="brainstorm started", data=r)

    async def end(ctx: ToolContext, a: dict) -> ToolResult:
        if ctx.trigger != "brainstorm_turn" or not ctx.thread_record_id:
            return ToolResult(ok=False, error="not_in_brainstorm")
        row = await orch.repo.get(str(uuid.UUID(ctx.thread_record_id)))
        if row is None or row["kind"] != "brainstorm" or row["owner_agent"] != ctx.agent.id:
            return ToolResult(ok=False, error="not_owner")
        if not await orch.end(row["id"]):
            return ToolResult(ok=False, error="not_open")
        return ToolResult(ok=True, content="ending")

    return [ToolSpec("brainstorm_start", "Start a multi-agent brainstorm thread (max 3 agent-initiated per day).",
                     START, start, 30.0),
            ToolSpec("brainstorm_end", "Owner only, inside an open brainstorm: end it and write the summary.",
                     END, end, 10.0)]


def init(ctx) -> None:
    for s in make_tools(ctx, ctx.task_service.orch):
        ctx.tools.register(s)
