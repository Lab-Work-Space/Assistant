"""Reply gate (spec 3.1 + 12.10): decides which persona, if any, answers. Silent messages make zero LLM calls.
Order: DM, Tier 0 (mention / reply to a persona bot, by user id), open task thread, active conversation, Tier 1, Tier 2."""
import asyncio
import re
import time
import unicodedata
from collections import deque
from pathlib import Path

from core.agents.persona import normalise
from core.agents.untrusted import wrap_untrusted
from core.config import PROJECT_ROOT
from core.gate.context_buffer import ContextBuffer
from core.interfaces import Actor, AgentRequest
from core.provider.registry import parse_model
from core.tasks.repo import Repo

VOCATIVES = {"hey", "hi", "hello", "ok", "yo", "เฮ้", "นี่", "น้อง", "คุณ", "ว่าไง"}
PARTICLES = {"ครับ", "ค่ะ", "คะ", "จ้า", "จ๊ะ", "นะ", "หน่อย", "ว่าไง", "ช่วยหน่อย"}
# Spec 12.11 (owner rule 2026-11-23): a Thai persona name is a noun and counts as a call only when it stands as its own
# word. After the alias there must be end/whitespace/punctuation, or a chain of WHOLE words from THAI_NEXT (each ending at
# end/space/punct or followed by another whole word). Anything else glued on is silence (no Tier 2 call):
#   "พราวมาก", "พราวมากมาย", "เทคโนโลยีใหม่", "ฝนตกหนัก" -> silent;  "พราว มาก", "พราวว่าไง", "พราวมาไหม",
#   "พราวช่วยดูหน่อย" (ช่วย+ดู+หน่อย) -> call;  text BEFORE the name is irrelevant ("หวัดดีพราว", "ถามพราวหน่อย").
THAI_NEXT = tuple(sorted({"ว่า", "ว่าไง", "ไง", "ช่วย", "หน่อย", "ครับ", "คับ", "ค่ะ", "คะ", "ค่า", "จ้า", "จ๋า", "จ้ะ", "นะ", "น้า",
                          "ล่ะ", "เอ๊ย", "เอ้ย", "ๆ", "สิ", "ซิ", "อ่ะ", "อะ", "ไหม", "มั้ย", "มั๊ย", "ได้ไหม", "ทำ", "ตอบ", "ดู",
                          "บอก", "คิด", "ว่าง", "อยู่ไหม", "มา", "ไป", "ที"}, key=len, reverse=True))
GATE_AGENT, MAX_WAITING, TIER2_CAP = "_gate", 3, 500
_OUT = re.compile(r"(yes:[a-z][a-z0-9_-]{1,31}|no)")


def _strip(s: str) -> str:
    return "".join(c for c in s if not (c.isspace() or unicodedata.category(c)[0] in "PZ"))


def _standalone(rest: str) -> bool:
    """True if rest starts at a word boundary or is a chain of whole THAI_NEXT words (backtracking, longest first)."""
    if not rest or rest[0].isspace() or unicodedata.category(rest[0])[0] == "P":
        return True
    return any(rest.startswith(w) and _standalone(rest[len(w):]) for w in THAI_NEXT)


def _pos(text: str, alias: str):
    """Start offsets of alias in text: Thai substring, ASCII needs non-alphanumeric boundaries."""
    ascii_ = alias.isascii()
    i = text.find(alias)
    while i != -1:
        j = i + len(alias)
        if not ascii_ or ((i == 0 or not text[i - 1].isalnum()) and (j == len(text) or not text[j].isalnum())):
            yield i, j
        i = text.find(alias, i + 1)


class ReplyGate:
    def __init__(self, ctx, clock=time.monotonic):
        self.ctx, self.cfg, self.log, self.clock = ctx, ctx.config, ctx.log, clock
        self.buffer = ContextBuffer(self.cfg.context_buffer_size, self.cfg.context_buffer_ttl_s)
        self.locks: dict[tuple, asyncio.Lock] = {}
        self.waiting: dict[tuple, int] = {}
        self.user_runs: dict[int, deque] = {}
        self.tier2_calls: dict[int, deque] = {}
        self._system: str | None = None

    def _note(self, event: str, level: str = "INFO", **f) -> None:
        self.log.write_log("gate", event, level, **f)  # ids and rule names only, never message text

    # -- decision ----------------------------------------------------------------------------------------
    async def decide(self, app, m) -> tuple[str | None, str]:
        c, ch = self.cfg, m.channel
        if m.guild is None:  # S1210-06: only the intake client reads DMs
            a = await self.ctx.conversation.active_agent(ch.id, m.author.id, c.reply_active_window_s)
            return (a or c.default_agent_id), "dm"
        pmap = app.persona_by_user_id
        for u in m.mentions:  # Tier 0 by user id, never by name (S1210-05)
            if u.id in pmap:
                return pmap[u.id], "mention"
        ref = getattr(getattr(m, "reference", None), "resolved", None)
        if ref is not None and getattr(getattr(ref, "author", None), "id", None) in pmap:
            return pmap[ref.author.id], "reply_to_agent"
        other_user = any(not getattr(u, "bot", False) for u in m.mentions)
        if getattr(ch, "parent_id", None) is not None and not other_user and self.ctx.db is not None:
            row = await Repo(self.ctx.db).by_thread(ch.id)
            if row and row["kind"] == "task" and row["status"] == "open":
                return row["owner_agent"], "active_conversation"
        if not other_user:
            a = await self.ctx.conversation.active_agent(ch.id, m.author.id, c.reply_active_window_s)
            if a and self.ctx.personas.get(a):
                return a, "active_conversation"
        hits = self.tier1(m.content)
        if not hits:
            return None, "silent"
        if len(hits) == 1 and hits[0][1]:
            return hits[0][0], "name_tier1"
        pid = await self.tier2(ch.id, m, [h[0] for h in hits])
        return (pid, "name_tier2") if pid else (None, "silent")

    def tier1(self, content: str) -> list[tuple[str, bool]]:
        """[(persona id, any occurrence is a vocative/particle call)] for every persona that hits."""
        suf = normalise(self.cfg.persona_name_suffix or "")
        text = normalise(content)
        if suf:
            text = text.replace(suf, "")
        out = []
        for p in self.ctx.personas.all():
            names = {normalise(n).replace(suf, "").strip() if suf else normalise(n) for n in (p.name, *p.aliases)}
            clear, hit = False, False
            for n in filter(None, names):
                for i, j in _pos(text, n):
                    if not n.isascii() and not _standalone(text[j:]):
                        continue  # glued into a longer word: silence for this occurrence (no Tier 2)
                    hit = True
                    before, after = _strip(text[:i]), _strip(text[j:])
                    clear = clear or before in VOCATIVES or not before or after in PARTICLES or not after
            if hit:
                out.append((p.id, clear))
        return out

    # -- Tier 2 ------------------------------------------------------------------------------------------
    def _system_prompt(self) -> str:
        if self._system is None:
            d = Path(self.cfg.prompts_dir)
            d = d if d.is_absolute() else PROJECT_ROOT / d
            self._system = (d / "_system" / "tier2-classifier.md").read_text(encoding="utf-8")
        return self._system

    async def tier2(self, channel_id: int, m, ids: list[str]) -> str | None:
        c, ctx = self.cfg, self.ctx
        try:
            if await ctx.budget.level(GATE_AGENT) in ("fallback", "stop"):
                self._note("gate.tier2_skipped", reason="budget")
                return None
            q, now = self.tier2_calls.setdefault(channel_id, deque()), self.clock()
            while q and now - q[0] > 60:
                q.popleft()
            if len(q) >= c.reply_tier2_max_per_min_channel:
                self._note("gate.tier2_skipped", reason="rate", channel=channel_id)
                return None
            prov, model = parse_model(c.reply_tier2_model)
            adapter = ctx.providers.get(prov)
            if adapter is None:
                return None
            q.append(now)
            hist = "\n".join(wrap_untrusted(t[:300], "history", "", n) for n, t in self.buffer.read(channel_id)[-5:])
            cands = "\n".join(f"id={p.id} name={p.name} aliases={list(p.aliases)}"
                              for p in map(ctx.personas.get, ids))
            prompt = (f"Recent messages:\n{hist or '(none)'}\n\nCurrent message:\n"
                      f"{wrap_untrusted(m.content[:TIER2_CAP], 'current', str(m.author.id), m.author.display_name)}"
                      f"\n\nCandidates:\n{cands}")
            out, usage = await asyncio.wait_for(
                adapter.complete(model=model, system=self._system_prompt(), prompt=prompt, max_output_tokens=8,
                                 timeout_s=c.reply_tier2_timeout_s), c.reply_tier2_timeout_s + 1)
            await ctx.budget.record(GATE_AGENT, prov, model, usage, "tier2")
            if _OUT.fullmatch(out.strip()) and out.strip() != "no" and out.strip()[4:] in ids:
                return out.strip()[4:]
        except Exception as e:
            self._note("gate.tier2_failed", "WARNING", error=type(e).__name__)
        return None

    # -- entry -------------------------------------------------------------------------------------------
    async def handle(self, app, m) -> None:
        t = getattr(m, "type", None)
        if (m.author.bot or m.webhook_id is not None or m.author.id in app.persona_by_user_id
                or (t is not None and getattr(t, "name", "default") not in ("default", "reply"))
                or not (m.content or "").strip()):
            self._note("gate.decision", rule="ignored")
            return
        ch = m.channel
        # single routing path for open task threads: task_followup runs the assignee and counts the turn
        if m.guild is not None and getattr(ch, "parent_id", None) is not None and self.ctx.db is not None \
                and getattr(self.ctx, "task_service", None) is not None:
            from core.discord.threads import task_followup
            if await task_followup(app, m):
                return
        pid, rule = await self.decide(app, m)
        context = self.buffer.read(ch.id)
        self.buffer.push(ch.id, m.author.id, m.author.display_name, m.content)
        if pid is None:
            self._note("gate.decision", rule=rule, channel=ch.id)
            return
        if app.client_for(pid) is None:  # S1210-07: disabled persona's work goes to Praw
            pid = app.intake_persona
        persona = self.ctx.personas.get(pid)
        if persona is None:
            return
        self._note("gate.decision", rule=rule, agent=pid, channel=ch.id)
        key = (ch.id, pid)
        lock = self.locks.setdefault(key, asyncio.Lock())
        if lock.locked() and self.waiting.get(key, 0) >= MAX_WAITING:
            self._note("gate.dropped", reason="busy", agent=pid, channel=ch.id)
            return
        runs, now = self.user_runs.setdefault(m.author.id, deque()), self.clock()
        while runs and now - runs[0] > 3600:
            runs.popleft()
        if len(runs) >= self.cfg.user_max_runs_per_hour:
            self._note("gate.dropped", reason="user_rate", agent=pid, channel=ch.id)
            return
        runs.append(now)
        queued = lock.locked()
        if queued:
            self.waiting[key] = self.waiting.get(key, 0) + 1
        try:
            async with lock:
                if queued:
                    self.waiting[key] -= 1
                    queued = False
                sink = (self.ctx.sinks.for_dm(m.author, persona) if m.guild is None
                        else self.ctx.sinks.for_channel(ch, persona))
                res = await self.ctx.engine.run(AgentRequest(
                    agent_id=pid, trigger="human_message", guild_id=m.guild.id if m.guild else None, channel_id=ch.id,
                    thread_id=ch.id if getattr(ch, "parent_id", None) is not None else None, human_user_id=m.author.id,
                    text=m.content, origin="discord", human_actor=Actor("discord", str(m.author.id), m.author.display_name),
                    author_name=m.author.display_name, context=context, sink=sink))
        finally:
            if queued:  # cancelled while waiting for the lock
                self.waiting[key] -= 1
        if res.ok:
            await self.ctx.conversation.touch(ch.id, m.author.id, pid)
            self.buffer.push(ch.id, 0, persona.name, res.text)
            if self.ctx.voice is not None:
                await self.ctx.voice.after_reply(m.guild.id if m.guild else None, m.author.id, persona, res.text, ch.id)
            self._note("reply.sent", agent=pid, rule=rule, channel=ch.id)
