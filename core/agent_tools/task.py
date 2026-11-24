"""task_create / task_update tools (spec 3.4, 3.6). Not callable from brainstorm runs (loop guard)."""
from core.interfaces import ToolContext, ToolResult, ToolSpec
from core.tasks.brainstorm import ThreadError

_ID = "^[a-z][a-z0-9_-]{1,31}$"
CREATE = {"type": "object", "additionalProperties": False, "required": ["assignee_agent_id", "title"],
          "properties": {"assignee_agent_id": {"type": "string", "pattern": _ID},
                         "title": {"type": "string", "minLength": 1, "maxLength": 200},
                         "description": {"type": "string", "maxLength": 4000},
                         "priority": {"enum": ["low", "normal", "high", "urgent"]},
                         "due": {"type": "string", "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}$"},
                         "value_thb": {"type": "integer", "minimum": 0, "maximum": 1000000000}}}
UPDATE = {"type": "object", "additionalProperties": False, "required": ["status"],
          "properties": {"status": {"enum": ["in_progress", "done", "failed"]},
                         "report": {"type": "string", "maxLength": 4000}}}
BLOCKED = ("brainstorm_turn", "brainstorm_summary")


def make_tools(svc) -> list[ToolSpec]:
    async def create(ctx: ToolContext, a: dict) -> ToolResult:
        if ctx.trigger in BLOCKED:
            return ToolResult(ok=False, error="not_allowed_here")
        try:
            r = await svc.create(ctx, a)
        except ThreadError as e:
            return ToolResult(ok=False, error=e.code)
        return ToolResult(ok=True, content=f"{r['task']} created", data=r)

    async def update(ctx: ToolContext, a: dict) -> ToolResult:
        try:
            r = await svc.update(ctx, a)
        except ThreadError as e:
            return ToolResult(ok=False, error=e.code)
        return ToolResult(ok=True, content=f"{r['task']} {r['status']}", data=r)

    return [ToolSpec("task_create", "Delegate a task to another agent; opens a task thread and runs the assignee.",
                     CREATE, create, 30.0),
            ToolSpec("task_update", "As the task assignee inside its thread: set status in_progress|done|failed "
                     "with an optional report.", UPDATE, update, 30.0)]


def init(ctx) -> None:
    for s in make_tools(ctx.task_service):
        ctx.tools.register(s)
