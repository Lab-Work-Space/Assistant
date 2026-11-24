"""Brainstorm orchestrator and thread turn accounting (spec 3.6). Surface-neutral: all I/O goes through ThreadPort.
Loop guard: agents run only from here while the row is open; round robin with n>=2 never repeats a speaker."""
import asyncio
from pathlib import Path

from core.agent_tools.registry import _allows
from core.config import PROJECT_ROOT
from core.interfaces import AgentRequest
from core.tasks.ports import default_embed
from core.tasks.repo import Repo

KNOWLEDGE_TOOLS = ("knowledge_read_index", "knowledge_read", "knowledge_search")
SUMMARY_TOKENS, HISTORY, SUMMARY_HISTORY = 1024, 20, 50


class ThreadError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def limit_reason(row) -> str | None:
    if row["turns_used"] >= row["turn_limit"]:
        return "turn_limit"
    return "token_budget" if row["tokens_used"] >= row["token_budget"] else None


class Orchestrator:
    def __init__(self, ctx, repo: Repo | None = None, embed=default_embed):
        self.ctx, self.repo, self.embed = ctx, repo or Repo(ctx.db), embed
        self._jobs: dict[str, asyncio.Task] = {}

    def _port(self):
        p = getattr(self.ctx, "threads", None)
        if p is None:
            raise ThreadError("no_thread_port")
        return p

    def _log(self, event, level="INFO", **f):
        self.ctx.log.write_log("tasks", event, level, **f)

    def spawn(self, key: str, coro) -> None:
        t = asyncio.get_running_loop().create_task(coro)
        self._jobs[key] = t
        t.add_done_callback(lambda _: self._jobs.pop(key, None))

    async def wait_idle(self) -> None:
        while self._jobs:
            await asyncio.gather(*list(self._jobs.values()), return_exceptions=True)

    async def start(self, *, guild_id, channel_id, topic, participants, turn_limit, caller, kind, by_id,
                    task_id=None) -> dict:
        c = self.ctx.config
        ids = list(participants)
        if not 2 <= len(ids) <= 6 or len(set(ids)) != len(ids) or any(self.ctx.personas.get(i) is None for i in ids):
            raise ThreadError("invalid_participants")
        port = self._port()
        owner = caller if caller in ids else ids[0]
        row = await self.repo.create_brainstorm(
            guild_id=guild_id, channel_id=channel_id, topic=topic, owner=owner, participants=ids,
            turn_limit=turn_limit or c.brainstorm_turn_limit, token_budget=c.brainstorm_token_budget, kind=kind,
            by_id=by_id, daily_max=c.brainstorm_agent_daily_max, tz=c.app_timezone, task_id=task_id)
        if row is None:
            raise ThreadError("daily_limit_reached")
        rid = str(row["id"])
        try:
            persona = self.ctx.personas.get(owner)
            mid = await port.sink_for(channel_id, persona).send_embed(self.embed(
                "Brainstorm", topic, [("Participants", ", ".join(ids)), ("Turns", str(row["turn_limit"]))], 0x5865F2))
            thread_id = await port.create_thread(channel_id, mid, f"Brainstorm {topic}"[:100])
            await self.repo.set_thread(row["id"], thread_id)
        except Exception as e:
            await self.repo.abort(row["id"], "error")
            self._log("brainstorm.aborted", "ERROR", id=rid, exc_type=type(e).__name__)
            raise ThreadError("discord_error") from None
        self._log("brainstorm.started", id=rid, owner=owner, kind=kind, turn_limit=row["turn_limit"])
        self.spawn(rid, self._loop(row["id"], thread_id))
        return {"brainstorm": rid, "thread_id": thread_id}

    def _tools_for(self, persona, owner: bool) -> tuple[str, ...]:
        t = tuple(k for k in KNOWLEDGE_TOOLS if any(_allows(e, k) for e in persona.tools))
        return t + ("brainstorm_end",) if owner else t

    async def _loop(self, row_id, thread_id) -> None:
        c, port, errors = self.ctx.config, self._port(), 0
        row = await self.repo.get(row_id)
        try:
            for i in range(row["turn_limit"]):
                row = await self.repo.get(row_id)
                if row["status"] != "open":
                    break
                if row["tokens_used"] >= row["token_budget"]:
                    break
                speaker = row["participants"][i % len(row["participants"])]
                persona = self.ctx.personas.get(speaker)
                req = AgentRequest(
                    agent_id=speaker, trigger="brainstorm_turn", guild_id=row["guild_id"], channel_id=thread_id,
                    thread_id=thread_id, human_user_id=None, origin=self.ctx.surface,
                    text=f"Topic: {row['topic']}\nYou are {persona.name}. Contribute your next message.",
                    context=await port.history(thread_id, HISTORY), sink=port.sink_for(thread_id, persona),
                    thread_record_id=str(row_id), max_output_tokens=c.brainstorm_turn_max_output_tokens,
                    tools_override=self._tools_for(persona, speaker == row["owner_agent"]))
                try:
                    res = await self.ctx.engine.run(req)
                    used, ok = res.usage.input_tokens + res.usage.output_tokens, res.ok
                except Exception:
                    used, ok = 0, False
                errors = 0 if ok else errors + 1
                row = await self.repo.add_turn(row_id, used) or await self.repo.get(row_id)
                if row["status"] == "summarising":  # owner called brainstorm_end
                    break
                if errors >= 2:
                    await self.repo.abort(row_id, "error")
                    self._log("brainstorm.aborted", "ERROR", id=str(row_id), reason="error")
                    return
            row = await self.repo.get(row_id)
            if row["status"] == "open":
                row = await self.repo.begin_summary(row_id, limit_reason(row) or "turn_limit") or row
            if row["status"] == "summarising":
                await self.summarise(row)
        except asyncio.CancelledError:
            await self.repo.abort(row_id, "cancelled")
            raise
        except Exception as e:
            await self.repo.abort(row_id, "error")
            self._log("brainstorm.aborted", "ERROR", id=str(row_id), exc_type=type(e).__name__)

    async def after_task_turn(self, thread_id, tokens) -> None:
        """After every agent run in a task thread (turn already taken via reserve_turn): adds tokens,
        closes with a summary at the caps."""
        row = await self.repo.by_thread(thread_id)
        if row is None or row["kind"] != "task":
            return
        row = await self.repo.add_tokens(row["id"], tokens)
        if row and (r := limit_reason(row)) and (row := await self.repo.begin_summary(row["id"], r)):
            await self.summarise(row)

    async def reserve_turn(self, thread_id) -> bool:
        """Take one task-thread turn before a run; False when closed or at the turn cap."""
        row = await self.repo.by_thread(thread_id)
        return row is not None and row["kind"] == "task" and await self.repo.reserve_turn(row["id"]) is not None

    async def summarise(self, row) -> None:
        """Owner summary; allowed over budget; status is already 'summarising'."""
        port, tid, owner = self._port(), row["thread_id"], self.ctx.personas.get(row["owner_agent"])
        root = Path(self.ctx.config.prompts_dir)
        root = root if root.is_absolute() else PROJECT_ROOT / root
        prompt = (root / "_system" / "brainstorm-summary.md").read_text(encoding="utf-8")
        sink = port.sink_for(tid, owner)
        mid = None
        try:
            res = await self.ctx.engine.run(AgentRequest(
                agent_id=owner.id, trigger="brainstorm_summary", guild_id=row["guild_id"], channel_id=tid,
                thread_id=tid, human_user_id=None, origin=self.ctx.surface, text=f"Topic: {row['topic']}",
                context=await port.history(tid, SUMMARY_HISTORY), sink=sink, thread_record_id=str(row["id"]),
                max_output_tokens=SUMMARY_TOKENS, tools_override=(), system_extra=prompt))
            mid = res.message_ids[0] if res.message_ids else None
            if mid and row["task_id"] and row["kind"] != "task":
                t = await self.repo.task_by_id(row["task_id"])
                if t and t["thread_id"]:
                    s = port.sink_for(t["thread_id"], owner)
                    await s.start()
                    await s.write(res.text)
                    await s.finish()
        except Exception as e:
            self._log("brainstorm.summary_failed", "ERROR", id=str(row["id"]), exc_type=type(e).__name__)
        try:
            await sink.send_embed(self.embed("Brainstorm closed", row["topic"],
                                             [("Reason", row["close_reason"] or ""), ("Turns", str(row["turns_used"]))]))
        except Exception:
            pass
        await self.repo.close(row["id"], mid)
        self._log("brainstorm.closed", id=str(row["id"]), reason=row["close_reason"], turns=row["turns_used"])

    async def end(self, row_id) -> bool:
        """brainstorm_end: the loop notices the status change and runs the summary."""
        return await self.repo.begin_summary(row_id, "owner_ended") is not None

    def cancel_task_jobs(self, task_id) -> bool:
        """Cancel the running job of a task (by its short id); True if one was running."""
        job = self._jobs.get(f"task-{task_id}")
        if job:
            job.cancel()
        return job is not None

    async def cancel(self, row_id) -> None:
        t = self._jobs.get(str(row_id))
        if t:
            t.cancel()
        else:
            await self.repo.abort(row_id, "cancelled")
