"""respond tool (spec 3.4, target rule 10.11.1). Posts chat or a component-free status embed."""
import time
from collections import defaultdict, deque

from core.interfaces import TargetError, ToolContext, ToolResult, ToolSpec

_ID = "^[0-9]{17,20}$"
SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["type", "content"],
    "properties": {
        "type": {"enum": ["chat", "embed"]},
        "content": {"type": "string", "minLength": 1, "maxLength": 4000},
        "title": {"type": "string", "maxLength": 256},
        "fields": {"type": "array", "maxItems": 10, "items": {
            "type": "object", "additionalProperties": False, "required": ["name", "value"],
            "properties": {"name": {"type": "string", "maxLength": 256}, "value": {"type": "string", "maxLength": 1024},
                           "inline": {"type": "boolean"}}}},
        "color": {"type": "string", "pattern": "^#[0-9A-Fa-f]{6}$"},
        "target": {"type": "object", "additionalProperties": False, "required": ["kind", "id"],
                   "properties": {"kind": {"enum": ["here", "thread", "dm"]}, "id": {"type": "string", "pattern": _ID}}},
    },
    # a title with type=chat is invalid_arguments
    "if": {"properties": {"type": {"const": "chat"}}}, "then": {"not": {"required": ["title"]}},
}


def _make_embed(a: dict):
    import discord  # lazy: keeps the core importable without py-cord (CLI/tests)
    e = discord.Embed(title=a.get("title"), description=a["content"],
                      colour=int(a.get("color", "#808080")[1:], 16))
    for f in a.get("fields", []):
        e.add_field(name=f["name"], value=f["value"], inline=f.get("inline", False))
    return e


def make_respond(app) -> ToolSpec:
    dm_log: dict[str, deque] = defaultdict(deque)

    def log(ctx, a, n, **kw):
        app.log.write_log("agents", "tool.respond", agent=ctx.agent.id, run=ctx.run_id, type=a["type"],
                          implicit=False, msgs=n, **kw)

    async def handler(ctx: ToolContext, a: dict) -> ToolResult:
        t = a.get("target") or {"kind": "here", "id": ""}
        kind = t["kind"]
        sink, here = ctx.sink, True
        if kind != "here":
            if ctx.human_user_id is None:  # agent-only run: only its own thread (10.11.1)
                if not (kind == "thread" and t["id"] == str(ctx.thread_id or ctx.channel_id)):
                    return ToolResult(ok=False, error="target_not_allowed")
            else:
                if app.sinks is None:
                    return ToolResult(ok=False, error="target_not_allowed")
                if kind == "dm":
                    q, now = dm_log[ctx.agent.id], time.monotonic()
                    while q and now - q[0] > 3600:
                        q.popleft()
                    if len(q) >= app.config.dm_max_per_hour_per_agent:
                        return ToolResult(ok=False, error="rate_limited")
                try:
                    sink = await app.sinks.for_target(kind, int(t["id"]), ctx.agent, ctx)
                except TargetError as e:
                    return ToolResult(ok=False, error=e.code)
                here = False
        if a["type"] == "embed":
            mid = await sink.send_embed(_make_embed(a))
            ids = [mid]
        elif here:
            await sink.write(a["content"])  # joins the streamed reply; ids arrive at engine finish()
            ids = []
        else:
            await sink.start()
            await sink.write(a["content"])
            ids = await sink.finish()
        if kind == "dm":
            dm_log[ctx.agent.id].append(time.monotonic())
            if app.conversation is not None:
                await app.conversation.touch(getattr(sink, "channel_id", int(t["id"])), int(t["id"]), ctx.agent.id)
        log(ctx, a, len(ids))
        return ToolResult(ok=True, data={"message_ids": ids, "streamed": here and a["type"] == "chat"})

    return ToolSpec(name="respond", description=(
        "Send a message. type=chat posts text (no title); type=embed posts a status embed with optional title, "
        "fields and color. No buttons, no mentions. Omit target to reply here."),
        parameters=SCHEMA, handler=handler, timeout_s=30.0)
