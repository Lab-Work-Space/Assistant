"""Discord ThreadPort (TASK-012B, spec 3.6, 12.10): task/brainstorm threads under allowlisted channels.
Every persona speaks through its OWN client via the sink factory (disabled -> Praw with a name prefix, S1210-07);
no webhooks. Threads are created by the intake client, only below an allowlisted parent."""
import asyncio

import discord

from core.discord import strings
from core.discord.approver import actor_from_interaction
from core.discord.buttons import build_view, make_custom_id
from core.discord.embeds import mask_embed
from core.functions.logs.masking import mask_secrets
from core.interfaces import Actor, AgentRequest, TargetError
from core.tasks.repo import Repo

HISTORY_CAP = 200


class DiscordThreadPort:
    def __init__(self, ctx):
        self.ctx, self._attached, self._threads = ctx, None, {}

    def _app(self):
        """ctx.sinks.app exists once setup_discord ran; the 'task' click handler is registered on first use."""
        app = getattr(self.ctx.sinks, "app", None)
        if app is None:
            raise TargetError("discord_not_ready")
        if self._attached is not app:
            self._attached = app
            app.router.register("task", lambda i, a, u: on_task_click(app, i, a, u))
        return app

    attach = _app  # setup_discord may call ctx.threads.attach() so the button works before the first task

    async def _channel(self, app, cid):
        ch = self._threads.get(cid) or app.intake.get_channel(cid)
        if ch is None:
            try:
                ch = await app.intake.fetch_channel(cid)
            except Exception:
                raise TargetError("discord_not_found") from None
        if app.gate.excluded(ch):  # S1214-01: history and edits never touch #bot-log
            raise TargetError("target_not_allowed")
        return ch

    def sink_for(self, channel_or_thread_id: int, persona):
        app = self._app()
        return app.ctx.sinks.for_channel(self._threads.get(channel_or_thread_id, channel_or_thread_id), persona)

    async def create_thread(self, channel_id: int, message_id: int, name: str) -> int:
        app = self._app()
        ch = await self._channel(app, channel_id)
        if getattr(getattr(ch, "guild", None), "id", None) != app.cfg.discord_guild_id or not app.gate.channel_ok(ch):
            raise TargetError("target_not_allowed")
        th = await ch.get_partial_message(message_id).create_thread(name=mask_secrets(name)[:100])
        if len(self._threads) >= HISTORY_CAP:
            self._threads.pop(next(iter(self._threads)))
        self._threads[th.id] = th  # the intake cache may not have the new thread yet
        return th.id

    async def edit_embed(self, channel_id: int, message_id: int, embed) -> None:
        """Only the author client can edit; find it from the message. Keeps the cancel button while the task is live."""
        app = self._app()
        ch = await self._channel(app, channel_id)
        author = (await ch.fetch_message(message_id)).author.id
        pid = app.persona_by_user_id.get(author)
        client = app.bots.get(pid) if pid else None
        if client is None:
            raise TargetError("discord_not_found")
        target = client.get_channel(channel_id) or await client.fetch_channel(channel_id)
        view = None
        t = await Repo(app.ctx.db).db.fetchrow("SELECT id, status, thread_id FROM tasks WHERE embed_message_id=?1", message_id)
        if t is not None and t["status"] in ("open", "in_progress"):
            btns = [("Cancel", make_custom_id("task", "cancel", t["id"]), None, discord.ButtonStyle.danger)]
            if t["thread_id"]:
                btns.append(("Open thread", None, f"https://discord.com/channels/{app.cfg.discord_guild_id}/{t['thread_id']}"))
            view = build_view(btns)
        await target.get_partial_message(message_id).edit(embed=mask_embed(embed), view=view)

    async def history(self, thread_id: int, limit: int) -> list[tuple[str, str]]:
        app = self._app()
        th = await self._channel(app, thread_id)
        out = []
        async for m in th.history(limit=limit, oldest_first=False):
            pid = app.persona_by_user_id.get(m.author.id)
            p = app.ctx.personas.get(pid) if pid else None
            if m.content and m.content != strings.PLACEHOLDER:  # fixed marker: a human's display name can never pass as a persona
                out.append((p.name if p else f"human:{m.author.display_name}", m.content))
        return out[::-1]


async def on_task_click(app, interaction, action: str, uid: str) -> None:
    """emp:task:cancel:<uuid>: the task's human creator or a fresh-checked approver; closes the task and its thread record."""
    if action != "cancel":
        return
    t = await Repo(app.ctx.db).task_by_id(uid)
    actor = actor_from_interaction(app, interaction)
    is_creator = t is not None and actor is not None and t["created_by_kind"] == "human" and t["created_by_id"] == actor.user_id
    if t is None or actor is None or not (is_creator or await app.ctx.approver_policy.is_approver(actor)):  # fresh fetch, not cached roles
        await interaction.followup.send(strings.NOT_APPROVER, ephemeral=True)
        return
    if await app.ctx.task_service.cancel(t, actor.ref) is None:
        await interaction.followup.send(strings.BUTTON_INACTIVE, ephemeral=True)

_LOCKS: dict[int, asyncio.Lock] = {}


async def task_followup(app, message) -> bool:
    """A human message in an open task thread (no other user mentioned) goes to the assignee and counts one turn.
    Returns True when handled. Runs inside the gated on_message listener."""
    ch = message.channel
    if message.author.bot or getattr(message, "webhook_id", None) or getattr(ch, "parent_id", None) is None:
        return False
    repo = Repo(app.ctx.db)
    row = await repo.by_thread(ch.id)
    if row is None or row["kind"] != "task" or row["status"] != "open":
        return False
    persona = app.ctx.personas.get(row["owner_agent"])
    own = (app.client_for(persona.id) or app.intake).user.id if persona else None
    if persona is None or any(u.id != own for u in getattr(message, "mentions", ())):
        return False
    async with _LOCKS.setdefault(ch.id, asyncio.Lock()):  # shortcut: one lock per thread kept for process life; evict on close if threads get numerous
        if await repo.reserve_turn(row["id"]) is None:  # G2B1-01: atomic cap check BEFORE the run
            app.log.write_log("tasks", "task.followup_limit", "INFO", thread=ch.id)
            return True
        used = 0
        try:
            res = await app.ctx.engine.run(AgentRequest(
                agent_id=persona.id, trigger="human_message", guild_id=message.guild.id if message.guild else None,
                channel_id=ch.id, thread_id=ch.id, human_user_id=message.author.id, text=message.content, origin="discord",
                human_actor=Actor("discord", str(message.author.id), message.author.display_name),
                author_name=message.author.display_name, sink=app.ctx.sinks.for_channel(ch, persona),
                thread_record_id=str(row["id"])))
            used = res.usage.input_tokens + res.usage.output_tokens
        except Exception as e:
            app.log.write_log("tasks", "task.followup_failed", "ERROR", exc_type=type(e).__name__)
        await app.ctx.task_service.orch.after_task_turn(ch.id, used)
    return True
