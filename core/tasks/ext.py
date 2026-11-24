"""Extension entry: builds the task service. The surface sets ctx.threads (a ThreadPort): Discord here, CLI 025."""
from core.tasks.service import TaskService


def init(ctx) -> None:
    ctx.task_service = TaskService(ctx)
    if ctx.surface == "discord" and ctx.threads is None:
        from core.discord.threads import DiscordThreadPort
        ctx.threads = DiscordThreadPort(ctx)  # task-thread follow-ups are routed by ReplyGate (core/gate) via task_followup
