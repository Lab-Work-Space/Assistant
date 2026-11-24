"""pull_user tool (spec 3.8, 10.11.4). Human trigger required. destination=voice sends an invite link to the requester's voice channel (never moves anyone)."""
from core.interfaces import ToolContext, ToolResult, ToolSpec
from core.pulluser.service import PullUserService

SCHEMA = {"type": "object", "additionalProperties": False, "required": ["user_id", "reason"],
          "properties": {"user_id": {"type": "string", "pattern": "^[0-9]{17,20}$"},
                         "reason": {"type": "string", "minLength": 1, "maxLength": 300},
                         "destination": {"enum": ["auto", "thread", "dm", "voice"]}}}


def make_pull_user(svc: PullUserService) -> ToolSpec:
    async def handler(ctx: ToolContext, a: dict) -> ToolResult:
        method, err = await svc.pull(ctx, a)
        svc.ctx.log.write_log("pulluser", "pulluser.done", agent=ctx.agent.id, run=ctx.run_id, method=method or None, error=err)
        return ToolResult(ok=False, error=err) if err else ToolResult(ok=True, content=method, data={"method": method})

    return ToolSpec("pull_user", "Invite a guild member to this conversation: a thread mention, or with destination=dm a "
                    "DM invite (approver-role members only while rollout is coexist). Needs a human trigger.",
                    SCHEMA, handler, 30.0, needs_human_trigger=True)


def init(ctx) -> None:
    if ctx.tools is not None:
        ctx.tools.register(make_pull_user(PullUserService(ctx)))
