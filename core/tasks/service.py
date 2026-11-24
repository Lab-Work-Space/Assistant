"""Task creation/update (spec 3.6). Records a task, posts its embed, opens a thread, runs the assignee."""
from core.approvals.cards import TASK_REQUIRED, check_card, check_due
from core.approvals.depts import code_of
from core.interfaces import AgentRequest
from core.tasks.brainstorm import Orchestrator, ThreadError
from core.tasks.ports import default_embed
from core.tasks.repo import Repo

_COLOR = {"open": 0x808080, "in_progress": 0x3498DB, "done": 0x2ECC71, "failed": 0xE74C3C}


class TaskService:
    def __init__(self, ctx, orch: Orchestrator | None = None, repo: Repo | None = None, embed=default_embed):
        self.ctx, self.repo, self.embed = ctx, repo or Repo(ctx.db), embed
        self.orch = orch or Orchestrator(ctx, self.repo, embed)

    def _embed(self, t):
        code = t["code"] or f"TASK-{t['short_id']}"
        by = f"<@{t['created_by_id']}>" if t["created_by_kind"] == "human" else t["created_by_id"]
        v = t["value_thb"]
        f = [("Code", code), ("Department", t["dept"] or "-"), ("Requester", by), ("Assignee", t["assignee_agent"]),
             ("Priority", t["priority"] or "-"), ("Due", t["due"] or "-"), ("Value (THB)", f"{v:,} THB" if v is not None else "-"),
             ("Status", t["status"])]
        if t["report"]:
            f.append(("Report", t["report"]))
        return self.embed(f"{code} {t['title']}", t["description"], f, _COLOR.get(t["status"], 0x808080))

    async def create(self, ctx, a: dict) -> dict:
        """ctx: ToolContext of the delegating agent. Raises ThreadError(code)."""
        c, assignee = self.ctx.config, a["assignee_agent_id"]
        persona = self.ctx.personas.get(assignee)
        if persona is None or assignee == ctx.agent.id:
            raise ThreadError("invalid_assignee")
        err = check_card(a, TASK_REQUIRED, getattr(c, "app_timezone", "Asia/Bangkok"))
        if err:
            kind = err.split("missing=")[1] if "missing=" in err else "invalid"  # field names only
            self.ctx.log.write_log("tasks", "task.incomplete", "WARNING", agent=ctx.agent.id, kind=kind)
            raise ThreadError(err)
        port = self.orch._port()
        channel = ctx.channel_id if ctx.guild_id is not None and ctx.thread_id is None else c.tasks_channel_id
        kind, by = ("human", str(ctx.human_user_id)) if ctx.human_user_id else ("agent", ctx.agent.id)
        t = await self.repo.insert_task(guild_id=ctx.guild_id or c.discord_guild_id, channel_id=channel,
                                        title=a["title"], description=a.get("description", ""), kind=kind,
                                        by_id=by, assignee=assignee, dept=code_of(persona.dept),
                                        priority=a.get("priority"), due=a.get("due"), value_thb=a.get("value_thb"))
        code = t["code"]
        try:
            mid = await port.sink_for(channel, ctx.agent).send_embed(self._embed(t))
            thread_id = await port.create_thread(channel, mid, f"{code} {t['title']}"[:100])
            row = await self.repo.link_task_thread(
                t, thread_id=thread_id, embed_message_id=mid, kind=kind, by_id=by,
                turn_limit=c.brainstorm_turn_limit, token_budget=c.brainstorm_token_budget)
        except Exception as e:
            await self.repo.set_task(t["id"], "failed", "discord_error")
            self.ctx.log.write_log("tasks", "task.failed", "ERROR", task=code, exc_type=type(e).__name__)
            raise ThreadError("discord_error") from None
        self.ctx.log.write_log("tasks", "task.created", "INFO", task=code)
        self.orch.spawn(f"task-{t['short_id']}", self._run(t, row, thread_id, persona))
        return {"task": code, "thread_id": thread_id}

    async def _run(self, t, row, thread_id, persona) -> None:
        port = self.orch._port()
        try:
            t = await self.repo.set_task(t["id"], "in_progress", only_from=("open",)) or t
            await port.edit_embed(t["origin_channel_id"], t["embed_message_id"] or 0, self._embed(t))
        except Exception:
            pass
        used = 0
        await self.orch.reserve_turn(thread_id)  # the assignment run is turn 1
        try:
            res = await self.ctx.engine.run(AgentRequest(
                agent_id=persona.id, trigger="task_assigned", guild_id=t["guild_id"], channel_id=thread_id,
                thread_id=thread_id, human_user_id=None, origin=self.ctx.surface,
                text=f"{t['title']}\n{t['description']}", sink=port.sink_for(thread_id, persona),
                thread_record_id=str(row["id"])))
            used = res.usage.input_tokens + res.usage.output_tokens
        except Exception as e:
            self.ctx.log.write_log("tasks", "task.run_failed", "ERROR", task=t["code"], exc_type=type(e).__name__)
        await self.orch.after_task_turn(thread_id, used)

    async def update(self, ctx, a: dict) -> dict:
        t = await self.repo.task_by_thread(ctx.thread_id) if ctx.thread_id else None
        if t is None or t["assignee_agent"] != ctx.agent.id:
            raise ThreadError("not_task_assignee")
        t = await self.repo.set_task(t["id"], a["status"], a.get("report"))
        if t is None:
            raise ThreadError("task_closed")
        port = self.orch._port()
        try:
            await port.edit_embed(t["origin_channel_id"], t["embed_message_id"] or 0, self._embed(t))
            await ctx.sink.send_embed(self.embed(f"{t['code']} {t['status']}", t["report"] or "", []))
        except Exception as e:
            self.ctx.log.write_log("tasks", "task.update_embed_failed", "WARNING", exc_type=type(e).__name__)
        return {"task": t["code"], "status": t["status"]}

    async def cancel(self, t, actor_ref: str, reason: str = ""):
        """Soft cancel shared by /task cancel and the Cancel button. None when the task is no longer open."""
        old = t["status"]
        t = await self.repo.set_task(t["id"], "cancelled")
        if t is None:
            return None
        self.orch.cancel_task_jobs(t["short_id"])
        row = await self.repo.by_thread(t["thread_id"]) if t["thread_id"] else None
        if row:
            await self.repo.abort(row["id"], "cancelled")
        await self.ctx.db.execute("INSERT INTO audit_log (scope, ref, action, old_value, new_value, actor) "
                                  "VALUES ('task', ?1, 'cancel', ?2, ?4, ?3)", t["code"], old, actor_ref,
                                  f"cancelled: {reason}" if reason else "cancelled")
        self.ctx.log.write_log("tasks", "task.cancelled", "INFO", task=t["code"], by=actor_ref)
        await self._refresh(t)
        return t

    async def _refresh(self, t) -> None:
        try:
            await self.orch._port().edit_embed(t["origin_channel_id"], t["embed_message_id"] or 0, self._embed(t))
        except Exception as e:
            self.ctx.log.write_log("tasks", "task.update_embed_failed", "WARNING", exc_type=type(e).__name__)

    async def edit(self, t, field: str, raw: str, actor_ref: str):
        """Edit one field of an open/in_progress task. Raises ThreadError(code); None when no longer editable."""
        raw, tz = (raw or "").strip(), getattr(self.ctx.config, "app_timezone", "Asia/Bangkok")

        def bad(reason):
            return ThreadError(f"invalid_field field={field} reason={reason}")
        if field == "title":
            if not 1 <= len(raw) <= 200:
                raise bad("length")
            val = raw
        elif field == "description":
            if not 20 <= len(raw) <= 4000:
                raise bad("too_short" if len(raw) < 20 else "length")
            val = raw
        elif field == "priority":
            if raw not in ("low", "normal", "high", "urgent"):
                raise bad("unknown")
            val = raw
        elif field == "due":
            if (r := check_due(raw, tz)):
                raise bad(r)
            val = raw
        elif field == "value_thb":
            s = raw.replace(",", "")
            if not s.isdigit() or not s.isascii() or int(s) > 1_000_000_000:
                raise bad("range")
            val = int(s)
        else:
            raise ThreadError("invalid_field")
        async with self.ctx.db.transaction() as tx:
            old = await tx.fetchval(f"SELECT {field} FROM tasks WHERE code=?1", t["code"])
            n = await tx.fetchrow(f"UPDATE tasks SET {field}=?2, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') "
                                  "WHERE code=?1 AND status IN ('open','in_progress') RETURNING *", t["code"], val)
            if n is not None:
                await tx.execute("INSERT INTO audit_log (scope, ref, action, field, old_value, new_value, actor) "
                                 "VALUES ('task', ?1, 'edit', ?2, ?3, ?4, ?5)", t["code"], field,
                                 None if old is None else str(old)[:4000], str(val)[:4000], actor_ref)
        if n is None:
            return None
        self.ctx.log.write_log("tasks", "task.edited", "INFO", task=n["code"], by=actor_ref, kind=field)
        await self._refresh(n)
        return n
