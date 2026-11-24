"""Command dispatcher shared by the interactive loop and --script mode (spec 10.15)."""
import asyncio
import re
import shlex
from decimal import Decimal, InvalidOperation

from core.cli.identity import actor_for
from core.cli.sink import Out
from core.cli.threads import MAIN_CHANNEL
from core.interfaces import CLI_HUMAN_IDS, AgentRequest

GUILD = 0


class Session:
    def __init__(self, ctx, out: Out, threads, as_name: str, agent_id: str):
        self.ctx, self.out, self.threads = ctx, out, threads
        self.as_name, self.agent, self.thread = as_name, agent_id, None
        self.failed, self._allow_fail, self.quit = False, False, False

    def _resolve(self, key: str):
        p = self.ctx.personas.get(key) or self.ctx.personas.by_name(key)
        if p is None:
            self.out.line(f"unknown agent: {key}")
        return p

    async def chat(self, text: str) -> None:
        persona = self.ctx.personas.get(self.agent)
        cid = self.thread or MAIN_CHANNEL
        orch, rec = self.ctx.task_service.orch, None
        if self.thread:
            row = await orch.repo.by_thread(self.thread)
            rec = str(row["id"]) if row else None
            if not await orch.reserve_turn(self.thread):
                self.out.line("[thread closed or turn limit reached]")
                return
        res = await self.ctx.engine.run(AgentRequest(
            agent_id=self.agent, trigger="human_message", guild_id=GUILD, channel_id=cid, thread_id=self.thread,
            human_user_id=CLI_HUMAN_IDS[self.as_name], text=text, origin="cli", human_actor=actor_for(self.as_name),
            author_name=self.as_name, sink=self.threads.sink_for(cid, persona), thread_record_id=rec))
        if not res.ok:
            self.out.line(f"[run failed: {res.error}]")
            self.failed = self.failed or not self._allow_fail
        self._allow_fail = False
        if self.thread:
            await orch.after_task_turn(self.thread, res.usage.input_tokens + res.usage.output_tokens)

    async def _pending(self):
        return await self.ctx.db.fetch("SELECT id, title, requested_by FROM approvals "
                                       "WHERE origin='cli' AND status='pending' ORDER BY created_at, rowid")

    async def _decide(self, action: str, arg: str) -> None:
        if arg in ("", "last"):
            rows = await self._pending()
            arg = rows[-1]["id"] if rows else ""
        d = await self.ctx.approvals.decide(arg, action, actor_for(self.as_name))
        extra = f" decided_by={d.approval['decided_by']}" if d.approval else ""
        self.out.line(f"{d.outcome}{extra}")

    async def _brainstorm(self, rest: str) -> None:
        t = shlex.split(rest)
        turns = int(t.pop()) if t and t[-1].isdigit() else None
        if len(t) < 3:
            return self.out.line("usage: /brainstorm <topic> <id> <id> [turns]")
        r = await self.ctx.task_service.orch.start(
            guild_id=GUILD, channel_id=MAIN_CHANNEL, topic=t[0], participants=t[1:], turn_limit=turns,
            caller=self.agent, kind="human", by_id=str(CLI_HUMAN_IDS[self.as_name]))
        self.out.line(f"brainstorm started thread={r['thread_id']}")

    async def _wait_idle(self, rest: str) -> None:
        async def idle():
            while True:
                await self.ctx.task_service.orch.wait_idle()
                pend = list(getattr(self.ctx.approvals, "_tasks", ()))
                if not pend:
                    return
                await asyncio.gather(*pend, return_exceptions=True)
        try:
            await asyncio.wait_for(idle(), float(rest or 120))
        except asyncio.TimeoutError:
            self.out.line("wait-idle: timeout")
            self.failed = True

    async def handle(self, line: str) -> None:
        line = line.strip()
        if not line or line.startswith("#"):
            return
        if not line.startswith("/"):
            return await self.chat(line)
        cmd, _, rest = line.partition(" ")
        rest, o = rest.strip(), self.out
        if cmd == "/quit":
            self.quit = True
        elif cmd == "/agent":
            if (p := self._resolve(rest)):
                self.agent = p.id
                o.line(f"agent: {p.id}")
        elif cmd == "/as":
            if rest not in CLI_HUMAN_IDS:
                return o.line("usage: /as admin|user")
            self.as_name = rest
            o.line(f"as: {rest}")
        elif cmd == "/thread":
            self.thread = int(rest) if rest.isdigit() else None
            o.line(f"thread: {self.thread or 'main'}")
        elif cmd == "/main":
            self.thread = None
        elif cmd == "/approvals":
            rows = await self._pending()
            for r in rows:
                o.line(f"{r['id']} {r['title']} ({r['requested_by']})")
            if not rows:
                o.line("no pending approvals")
        elif cmd in ("/approve", "/reject"):
            await self._decide(cmd[1:], rest)
        elif cmd == "/budget":
            a = rest.split()
            try:
                if len(a) != 3 or a[0] != "set":
                    raise ValueError
                o.line(await self.ctx.budget.set_limit(a[1], Decimal(a[2]), actor_for(self.as_name)))
            except (ValueError, InvalidOperation):
                o.line("usage: /budget set <agent> <usd>")
        elif cmd == "/jobs":
            rows = await self.ctx.db.fetch("SELECT id, kind, status FROM jobs ORDER BY created_at DESC, rowid DESC LIMIT 20")
            for r in rows:
                o.line(f"{r['id']} {r['kind']} {r['status']}")
            if not rows:
                o.line("no jobs")
        elif cmd == "/cancel":
            o.line("cancel requested" if await self.ctx.jobs.cancel(rest) else "job not found")
        elif cmd == "/delegate":  # goes through the agent (task_create tool): no CLI-only shortcut
            who, _, title = rest.partition(" ")
            await self.chat(f"Please delegate this task to {who} using the task tool: {title}")
        elif cmd == "/brainstorm":
            await self._brainstorm(rest)
        elif cmd == "/wait-idle":
            await self._wait_idle(rest)
        elif cmd == "/allow-fail":
            self._allow_fail = True
        elif cmd == "/expect":
            text = o.take()
            ok = re.search(rest, text, re.M) is not None
            o.line(f"expect {'ok' if ok else 'FAIL'}: {rest}")
            self.failed = self.failed or not ok
        else:
            o.line(f"unknown command: {cmd}")


async def run_script(session: Session, path: str) -> int:
    with open(path, encoding="utf-8") as f:
        for line in f:
            session.out.line(f"> {line.rstrip()}", capture=False)
            await session.handle(line)
            if session.quit:
                break
    await session._wait_idle("30")
    return 1 if session.failed else 0
