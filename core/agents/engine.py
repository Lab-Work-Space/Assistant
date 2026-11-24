"""Agent engine (spec 3.2 as amended by 10.1, 10.2.5, 10.4, 10.5, 10.11). Writes only to a ReplySink.
Logs ids, lengths and codes only; never message text, tool arguments or exception text."""
import asyncio
import json
import math
import time
import uuid

from core.agents import messages as strings
from core.agents.prompt_builder import PromptError, build_system
from core.agents.untrusted import _TOOL, wrap_tool_result, wrap_untrusted
from core.functions.logs.masking import mask_secrets
from core.interfaces import (CLI_HUMAN_IDS, AgentRequest, AgentResult, AppContext, ChatMessage, ProviderError,
                             ToolContext, Usage)
from core.provider.registry import parse_model

_SOURCE = {"task_assigned": "task", "brainstorm_turn": "brainstorm", "brainstorm_summary": "brainstorm",
           "approval_decided": "approval", "voice_note": "voice", "approval_review": "approval"}
_CUT = {"run_timeout", "provider_timeout", "provider_unavailable", "rate_limited", "auth", "model_not_found",
        "safety", "bad_request"}
_ERR = {"timeout": "provider_timeout", "unavailable": "provider_unavailable"}


class _CountingSink:
    """Delegates to the real sink and counts streamed characters (model text and respond-here chat)."""

    def __init__(self, sink):
        self._s, self.chars = sink, 0

    async def write(self, delta: str) -> None:
        self.chars += len(delta)
        await self._s.write(delta)

    def __getattr__(self, n):
        return getattr(self._s, n)


def check_actor(req: AgentRequest) -> None:
    a = req.human_actor
    ok = (req.human_user_id is None) == (a is None)
    if ok and a is not None:
        ok = a.kind == req.origin and (str(req.human_user_id) == a.user_id if a.kind == "discord"
                                       else req.human_user_id == CLI_HUMAN_IDS.get(a.user_id))
    if not ok:
        raise ValueError("actor_mismatch")


class Engine:
    """Implements interfaces.AgentEngine."""

    def __init__(self, ctx: AppContext):
        self.ctx = ctx
        self._sem = asyncio.Semaphore(ctx.config.agent_max_concurrency)
        self._stop_notice: dict[int, float] = {}

    def _log(self, event: str, level: str = "INFO", **f) -> None:
        self.ctx.log.write_log("agents", event, level, **f)

    async def run(self, req: AgentRequest) -> AgentResult:
        check_actor(req)
        run_id = uuid.uuid4().hex
        persona = self.ctx.personas.get(req.agent_id)
        sink = req.sink or (self.ctx.sinks.null() if self.ctx.sinks else None)
        if persona is None or sink is None:
            return AgentResult(False, "", [], Usage(), [], run_id, "unknown_agent" if persona is None else "no_sink")
        async with self._sem:
            return await self._run(req, persona, _CountingSink(sink), run_id)

    async def _run(self, req, persona, sink, run_id) -> AgentResult:
        c, budget = self.ctx.config, self.ctx.budget
        res = AgentResult(True, "", [], Usage(), [], run_id)
        level = await budget.level(persona.id)
        if level == "stop":
            now = time.monotonic()
            if now - self._stop_notice.get(req.channel_id, -3601) > 3600:
                self._stop_notice[req.channel_id] = now
                await sink.fail(strings.BUDGET_STOP)
            res.ok, res.error = False, "budget_exhausted"
            return res
        model = persona.cheap_model if level == "fallback" else persona.model
        await sink.start()
        overlay = ""
        if self.ctx.growth is not None and req.trigger != "approval_review":
            try:
                overlay = await self.ctx.growth.overlays.prompt_block(persona) or ""
            except Exception as e:
                overlay = ""
                self._log("growth.overlay_failed", "ERROR", agent=persona.id, run=run_id, error=type(e).__name__)
        try:
            system = build_system(persona, self.ctx.personas.all(), c, req, overlay=overlay)
        except PromptError as e:
            self._log("agent.run_failed", "ERROR", agent=persona.id, run=run_id, error=e.code)
            await sink.fail(strings.INTERNAL_ERROR)
            res.ok, res.error = False, e.code
            return res
        tctx = ToolContext(agent=persona, run_id=run_id, guild_id=req.guild_id, channel_id=req.channel_id,
                           thread_id=req.thread_id, trigger=req.trigger, human_user_id=req.human_user_id,
                           sink=sink, origin=req.origin, human_actor=req.human_actor,
                           thread_record_id=req.thread_record_id, approval_id=req.approval_id)
        src = _SOURCE.get(req.trigger, "chat")
        body = [wrap_untrusted(t, "chat", author_name=n) for n, t in req.context]
        body.append(wrap_untrusted(req.text, src, str(req.human_user_id or ""), req.author_name))
        msgs = [ChatMessage("user", "\n".join(body))]
        allowed = self.ctx.tools.for_agent(persona, req.tools_override) if self.ctx.tools else []
        model_chars = 0
        try:
            async with asyncio.timeout(c.agent_run_timeout_s):
                for rnd in range(c.agent_max_tool_rounds):
                    if rnd:
                        level = await budget.level(persona.id)
                        if level == "stop":
                            raise _Stop()
                        if level == "fallback":
                            model = persona.cheap_model
                    calls, text = await self._provider_round(req, persona, model, system, msgs, allowed, sink,
                                                             res, run_id, rnd)
                    model_chars += len(text)
                    res.text += text
                    if not calls:
                        break
                    msgs.append(ChatMessage("assistant", text, calls))
                    for call in calls:
                        r = await self.ctx.tools.invoke(tctx, call, allowed)
                        res.tool_calls.append(call.name)
                        raw = r.content if r.ok else "\n".join(x for x in (r.error, r.content) if x)
                        name = call.name if _TOOL.fullmatch(call.name) else "invalid"
                        msgs.append(ChatMessage("tool", wrap_tool_result(name, r.ok, mask_secrets(raw or "")),
                                                tool_call_id=call.id, name=name))
                else:
                    res.ok, res.error = False, "max_tool_rounds"
        except _Stop:
            await sink.fail(strings.BUDGET_STOP)
            res.ok, res.error = False, "budget_exhausted"
            return res
        except TimeoutError:
            res.ok, res.error = False, "run_timeout"
        except ProviderError as e:
            res.ok, res.error = False, _ERR.get(e.code, e.code)
        if res.error in _CUT:
            if sink.chars:
                await sink.write(strings.CUT_OFF)
            else:
                await sink.fail(strings.PROVIDER_FAILED)
                self._log("agent.run_failed", "ERROR", agent=persona.id, run=run_id, error=res.error)
                return res
        res.message_ids = await sink.finish()  # empty text: the sink deletes the placeholder (TASK-008 contract)
        if model_chars:
            self._log("tool.respond", agent=persona.id, run=run_id, type="chat", implicit=True,
                      msgs=len(res.message_ids))
        self._log("agent.run_done", agent=persona.id, run=run_id, ok=res.ok, error=res.error,
                  input_tokens=res.usage.input_tokens, output_tokens=res.usage.output_tokens)
        return res

    async def _provider_round(self, req, persona, model, system, msgs, allowed, sink, res, run_id, rnd):
        prov, mid = parse_model(model)
        adapter = self.ctx.providers.get(prov)
        if adapter is None:
            raise ProviderError("unavailable")
        c = self.ctx.config
        text, calls, got_usage, out_chars = "", [], False, 0
        stream = adapter.stream(model=mid, system=system, messages=msgs, tools=allowed,
                                max_output_tokens=req.max_output_tokens or c.agent_max_output_tokens,
                                effort=persona.effort, timeout_s=c.provider_idle_timeout_s)
        try:
            it = stream.__aiter__()
            while True:
                try:
                    ev = await asyncio.wait_for(it.__anext__(), c.provider_idle_timeout_s)
                except StopAsyncIteration:
                    break
                except asyncio.TimeoutError:
                    raise ProviderError("timeout", retryable=True) from None
                if ev.kind == "text":
                    text += ev.text
                    out_chars += len(ev.text)
                    await sink.write(ev.text)
                elif ev.kind == "tool_call" and ev.tool_call:
                    calls.append(ev.tool_call)
                    out_chars += len(json.dumps(ev.tool_call.arguments))
                elif ev.kind == "usage" and ev.usage:
                    got_usage = True
                    res.usage.input_tokens += ev.usage.input_tokens
                    res.usage.output_tokens += ev.usage.output_tokens
                    await self.ctx.budget.record(persona.id, prov, mid, ev.usage, "chat", ref=f"{run_id}:{rnd}")
        finally:
            if not got_usage:  # 10.2.5: aborted stream is billed by estimate, stricter than char/4 (Thai)
                in_chars = len(system) + sum(len(m.content) for m in msgs)
                est = Usage(math.ceil(in_chars / 2), out_chars)
                res.usage.input_tokens += est.input_tokens
                res.usage.output_tokens += est.output_tokens
                await self.ctx.budget.record(persona.id, prov, mid, est, "chat", ref=f"{run_id}:est")
            aclose = getattr(stream, "aclose", None)
            if aclose:
                await aclose()
        return calls, text


class _Stop(Exception):
    pass
