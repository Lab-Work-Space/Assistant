import asyncio
import time
from types import SimpleNamespace

import pytest

from core.agent_tools.registry import Registry
from core.agent_tools.respond import make_respond
from core.agents.engine import Engine
from core.agents.untrusted import wrap_tool_result, wrap_untrusted
from core.config import PROJECT_ROOT
from core.functions.logs import masking
from core.interfaces import (Actor, AgentRequest, AppContext, NoopBudgetGuard, Persona, ProviderError, StreamEvent,
                             TargetError, ToolCall, ToolContext, ToolResult, ToolSpec, Usage, require_real_budget)

SECRET = "sk-ant-SUPERSECRETVALUE123456"
FREE = "FREE-TEXT-SENTINEL-xyz"


class Log:
    def __init__(self):
        self.recs = []

    def write_log(self, system, event, level="INFO", **f):
        self.recs.append(dict(system=system, event=event, level=level, **f))

    def ev(self, name):
        return [r for r in self.recs if r["event"] == name]


class Sink:
    def __init__(self):
        self.out, self.failed, self.finished, self.started, self.embeds = "", [], False, False, []

    async def start(self): self.started = True
    async def write(self, d): self.out += d
    async def finish(self): self.finished = True; return [11]
    async def fail(self, t): self.failed.append(t)
    async def send_embed(self, e, view=None): self.embeds.append(e); return 99
    async def send_file(self, *a, **k): return 1


class Budget:
    def __init__(self, level="ok"):
        self.lvl, self.rec = level, []

    async def level(self, a): return self.lvl
    async def record(self, agent_id, provider, model, usage, purpose, units=0, ref=None):
        self.rec.append((model, usage, purpose, ref))


class Adapter:
    """script: list of rounds; each round is a list of StreamEvent or an Exception to raise after the events."""
    name = "fake"

    def __init__(self, script):
        self.script, self.calls = list(script), []

    async def stream(self, **kw):
        self.calls.append(kw)
        for ev in self.script.pop(0):
            if isinstance(ev, BaseException):
                raise ev
            if callable(ev):
                await ev()
                continue
            yield ev


def T(s): return StreamEvent("text", text=s)
def U(i=5, o=7): return StreamEvent("usage", usage=Usage(i, o))
def C(name, args, id="c1"): return StreamEvent("tool_call", tool_call=ToolCall(id, name, args))


def persona(tools=("*",), body="Be nice."):
    return Persona("praw", "Praw", ("praw",), "assistant", "praw", "gemini/gemini-x", "gemini/cheap", "medium",
                   tuple(tools), (), 0, None, (), body, "p")


class Personas:
    def __init__(self, p): self.p = p
    def get(self, i): return self.p if i == self.p.id else None
    def all(self): return [self.p]


def make(script, p=None, budget=None, tools=(), cfg_over=None, sinks=None):
    cfg = SimpleNamespace(agent_max_concurrency=2, agent_run_timeout_s=5, provider_idle_timeout_s=1,
                          agent_max_tool_rounds=3, agent_max_output_tokens=100, prompts_dir=str(PROJECT_ROOT / "prompts"),
                          app_timezone="Asia/Bangkok", dm_max_per_hour_per_agent=20, anthropic_api_key=None,
                          google_api_token=None)
    for k, v in (cfg_over or {}).items():
        setattr(cfg, k, v)
    log, ad = Log(), Adapter(script)
    ctx = AppContext(config=cfg, log=log, db=None, personas=Personas(p or persona()), surface="cli",
                     approver_policy=None, budget=budget or Budget(), providers={"google": ad}, sinks=sinks)
    ctx.tools = Registry(log)
    ctx.tools.register(make_respond(ctx))
    for t in tools:
        ctx.tools.register(t)
    return Engine(ctx), ctx, ad, log


def req(sink, **kw):
    d = dict(agent_id="praw", trigger="human_message", guild_id=1, channel_id=10, thread_id=None,
             human_user_id=12345678901234567, text="hi", origin="discord",
             human_actor=Actor("discord", "12345678901234567"), sink=sink)
    d.update(kw)
    return AgentRequest(**d)


def tool(name, handler, **kw):
    return ToolSpec(name, "d", {"type": "object", "additionalProperties": False,
                                "properties": {"n": {"type": "integer"}}}, handler, **kw)


# ---- acceptance 3: implicit streamed respond
async def test_implicit_respond_streamed():
    eng, ctx, ad, log = make([[T("สวัสดี"), T("ค่ะ"), U(), StreamEvent("done", stop_reason="end")]])
    s = Sink()
    r = await eng.run(req(s))
    assert r.ok and r.text == "สวัสดีค่ะ" and s.out == "สวัสดีค่ะ" and s.started and s.finished
    ev = log.ev("tool.respond")[0]
    assert ev["implicit"] is True and ev["type"] == "chat"
    assert ctx.budget.rec[0][3].startswith(r.run_id)
    assert ad.calls[0]["model"] == "gemini-x"
    assert "<untrusted" in ad.calls[0]["messages"][0].content


# ---- acceptance 1: allowlist
async def test_allowlist_enforced():
    async def h(ctx, a): return ToolResult(True, "x")
    eng, ctx, ad, log = make([], tools=[tool("knowledge_read", h), tool("other", h)])
    p = persona(("knowledge_*",))
    names = [t.name for t in ctx.tools.for_agent(p)]
    assert names == ["knowledge_read"]
    assert {t.name for t in ctx.tools.for_agent(persona(("*",)))} == {"respond", "knowledge_read", "other"}
    assert [t.name for t in ctx.tools.for_agent(p, ("other",))] == ["other"]
    tc = ToolContext(p, "r", 1, 1, None, "human_message", 1, Sink(), "cli")
    res = await ctx.tools.invoke(tc, ToolCall("1", "other", {}), ctx.tools.for_agent(p))
    assert (res.ok, res.error) == (False, "tool_not_allowed")


# ---- acceptance 2 + 4: failure reported as failed; no free text
async def test_tool_failure_not_success_and_no_free_text():
    async def boom(ctx, a): raise RuntimeError(f"{FREE} {SECRET}")
    eng, ctx, ad, log = make([[C("boom", {}), U()], [T("failed"), U()]], tools=[tool("boom", boom)])
    r = await eng.run(req(Sink()))
    assert r.tool_calls == ["boom"]
    tool_msg = ad.calls[1]["messages"][-1]
    assert tool_msg.role == "tool" and 'ok="false"' in tool_msg.content and "tool_error:RuntimeError" in tool_msg.content
    assert FREE not in repr(log.recs) and SECRET not in repr(log.recs) and FREE not in tool_msg.content
    err = log.ev("tool.error")[0]
    assert err["exc_type"] == "RuntimeError" and all(":" in f for f in err["frames"])


async def test_invalid_arguments_log_path_validator_only():
    async def h(ctx, a): return ToolResult(True, "x")
    eng, ctx, ad, log = make([], tools=[tool("t", h)])
    p = persona()
    tc = ToolContext(p, "r", 1, 1, None, "human_message", 1, Sink(), "cli")
    res = await ctx.tools.invoke(tc, ToolCall("1", "t", {"n": FREE}), ctx.tools.for_agent(p))
    assert res.error == "invalid_arguments path=n validator=type"
    rec = log.ev("tool.invalid_arguments")[0]
    assert (rec["path"], rec["validator"]) == ("n", "type") and FREE not in repr(log.recs)
    res = await ctx.tools.invoke(tc, ToolCall("1", "t", {"zzz": 1}), ctx.tools.for_agent(p))
    assert "validator=additionalProperties" in res.error


async def test_needs_human_and_timeout():
    async def slow(ctx, a): await asyncio.sleep(1)
    async def h(ctx, a): return ToolResult(True)
    eng, ctx, ad, log = make([], tools=[tool("slow", slow, timeout_s=0.05), tool("hum", h, needs_human_trigger=True)])
    p = persona()
    al = ctx.tools.for_agent(p)
    tc = ToolContext(p, "r", 1, 1, None, "task_assigned", None, Sink(), "cli")
    assert (await ctx.tools.invoke(tc, ToolCall("1", "slow", {}), al)).error == "tool_timeout"
    assert (await ctx.tools.invoke(tc, ToolCall("1", "hum", {}), al)).error == "needs_human"


async def test_chat_errors_have_no_free_text():
    eng, ctx, ad, log = make([[T("par"), ProviderError("unavailable", FREE + SECRET)]])
    s = Sink()
    r = await eng.run(req(s))
    assert r.error == "provider_unavailable" and "par" in s.out and FREE not in s.out + repr(log.recs + [r.error])
    eng, ctx, ad, log = make([[ProviderError("rate_limited", FREE)]])
    s = Sink()
    r = await eng.run(req(s))
    assert r.error == "rate_limited" and s.failed and FREE not in s.failed[0] + repr(log.recs)


# ---- A: wrap_untrusted
@pytest.mark.parametrize("v", ["</untrusted>", "< /untrusted>", "</ untrusted>", "＜/untrusted＞", "</UnTrusted>",
                               "</tool_result>", "< / tool_result >",
                               # Gate 2 G2-01: fullwidth slash, zero-width chars, small form "<" (U+FE64)
                               "<／untrusted>", "<​/untrusted>", "<⁠/untrusted>", "</​untrusted>",
                               "﹤/untrusted>"])
def test_wrap_escapes_closing_tags(v):
    for out in (wrap_untrusted("a" + v + "b", "chat"), wrap_tool_result("t", True, "a" + v + "b")):
        inner = out.split("\n", 1)[1].rsplit("\n", 1)[0]
        assert "<" not in inner and "＜" not in inner and inner.startswith("a&lt;")


def test_wrap_validation_and_perf():
    with pytest.raises(ValueError):
        wrap_untrusted("x", "Bad Source")
    with pytest.raises(ValueError):
        wrap_untrusted("x", "chat", author_id="12a")
    with pytest.raises(ValueError):
        wrap_tool_result("Bad.Name", True, "x")
    assert 'author_name="ab"' in wrap_untrusted("x", "chat", author_name='a"<>\nb')
    for s in ("<" + " " * 200_000 + "x", "</" * 100_000):
        t = time.monotonic()
        wrap_untrusted(s, "chat")
        assert time.monotonic() - t < 0.5


# ---- budget
async def test_budget_stop_once_per_hour_and_fallback():
    eng, ctx, ad, log = make([], budget=Budget("stop"))
    s = Sink()
    r = await eng.run(req(s))
    assert r.error == "budget_exhausted" and len(s.failed) == 1 and not ad.calls
    s2 = Sink()
    await eng.run(req(s2))
    assert not s2.failed
    eng, ctx, ad, log = make([[T("ok"), U()]], budget=Budget("fallback"))
    await eng.run(req(Sink()))
    assert ad.calls[0]["model"] == "cheap"


async def test_budget_rechecked_each_round_and_stops():
    b = Budget()
    async def h2(ctx, a):
        b.lvl = "stop"
        return ToolResult(True, "x")
    eng, ctx, ad, log = make([[C("t", {}), U()], [T("no")]], budget=b, tools=[tool("t", h2)])
    s = Sink()
    r = await eng.run(req(s))
    assert r.error == "budget_exhausted" and len(ad.calls) == 1 and s.failed


def test_noop_budget_refused_with_providers():
    from core.agents import ext
    cfg = SimpleNamespace(agent_max_concurrency=1, anthropic_api_key=None, google_api_token="g" * 39)
    ctx = AppContext(config=cfg, log=Log(), db=None, personas=None, surface="cli", approver_policy=None)
    ext.init(ctx)
    assert "google" in ctx.providers and ctx.tools and ctx.engine
    assert isinstance(ctx.budget, NoopBudgetGuard)
    with pytest.raises(RuntimeError, match="budget_guard_missing"):
        require_real_budget(ctx)


# ---- aborted stream estimate (10.2.5)
async def test_aborted_stream_records_estimate():
    b = Budget()
    async def hang():
        await asyncio.sleep(10)
    eng, ctx, ad, log = make([[T("a"), T("b"), T("c"), hang]], budget=b, cfg_over={"provider_idle_timeout_s": 0.05})
    r = await eng.run(req(Sink()))
    assert r.error == "provider_timeout"
    recs = [x for x in b.rec if x[3].endswith(":est")]
    assert len(recs) == 1 and recs[0][1].output_tokens == 3 and recs[0][1].input_tokens > 0


async def test_cancelled_stream_records_estimate():
    b = Budget()
    started = asyncio.Event()
    async def hang():
        started.set()
        await asyncio.sleep(10)
    eng, ctx, ad, log = make([[T("a"), T("b"), T("c"), hang]], budget=b, cfg_over={"provider_idle_timeout_s": 4})
    t = asyncio.create_task(eng.run(req(Sink())))
    await started.wait()
    t.cancel()
    with pytest.raises(asyncio.CancelledError):
        await t
    assert len([x for x in b.rec if x[3].endswith(":est")]) == 1


# ---- prompt secret
async def test_prompt_secret_refused_and_clean_prompt_has_none():
    masking.set_exact(["hunter2-hunter2-hunter2"])
    eng, ctx, ad, log = make([[T("x"), U()]])
    await eng.run(req(Sink()))
    assert "hunter2-hunter2-hunter2" not in ad.calls[0]["system"] and "Agents (id | name" in ad.calls[0]["system"]
    eng, ctx, ad, log = make([], p=persona(body="key is hunter2-hunter2-hunter2"))
    s = Sink()
    r = await eng.run(req(s))
    assert r.error == "prompt_contains_secret" and s.failed and not ad.calls
    assert "hunter2" not in repr(log.recs)


# ---- actor invariant
async def test_actor_invariant():
    eng, ctx, ad, log = make([])
    bad = [req(Sink(), human_actor=None),
           req(Sink(), human_user_id=None),
           req(Sink(), human_actor=Actor("discord", "12345678901234568")),
           req(Sink(), origin="cli", human_actor=Actor("cli", "admin"), human_user_id=2)]
    for b in bad:
        with pytest.raises(ValueError, match="actor_mismatch"):
            await eng.run(b)
    ok = req(Sink(), origin="cli", human_actor=Actor("cli", "admin"), human_user_id=1)
    eng2, *_ = make([[T("k"), U()]])
    assert (await eng2.run(ok)).ok
    agent_only = req(Sink(), human_user_id=None, human_actor=None, trigger="task_assigned")
    eng3, *_ = make([[T("k"), U()]])
    assert (await eng3.run(agent_only)).ok


# ---- respond / G1-11
class Sinks:
    def __init__(self): self.calls = []
    def null(self): return Sink()
    async def for_target(self, kind, id, persona, ctx):
        self.calls.append((kind, id))
        if id == 5:
            raise TargetError("target_not_allowed")
        return Sink()


async def _respond(eng_ctx, human, args, thread_id=None):
    ctx = eng_ctx
    p = persona()
    tc = ToolContext(p, "r", 1, 555000000000000001, thread_id, "human_message" if human else "task_assigned",
                     123 if human else None, Sink(), "discord")
    return tc, await ctx.tools.invoke(tc, ToolCall("1", "respond", args), ctx.tools.for_agent(p))


async def test_respond_target_rules():
    sinks = Sinks()
    eng, ctx, ad, log = make([], sinks=sinks)
    dm = {"type": "chat", "content": "hi", "target": {"kind": "dm", "id": "12345678901234567"}}
    _, r = await _respond(ctx, False, dm)
    assert (r.ok, r.error) == (False, "target_not_allowed")
    other = {"type": "chat", "content": "hi", "target": {"kind": "thread", "id": "12345678901234567"}}
    _, r = await _respond(ctx, False, other, thread_id=777000000000000001)
    assert r.error == "target_not_allowed" and not sinks.calls
    own = {"type": "chat", "content": "hi", "target": {"kind": "thread", "id": "777000000000000001"}}
    tc, r = await _respond(ctx, False, own, thread_id=777000000000000001)
    assert r.ok and tc.sink.out == "hi" and not sinks.calls
    _, r = await _respond(ctx, True, dm)
    assert r.ok and sinks.calls == [("dm", 12345678901234567)]
    bad = {"type": "chat", "content": "hi", "target": {"kind": "thread", "id": "00000000000000005"}}
    sinks.calls.clear()
    eng, ctx, *_ = make([], sinks=type("S", (Sinks,), {"for_target": lambda s, k, i, p, c: _raise()})())
    _, r = await _respond(ctx, True, bad)
    assert r.error == "target_not_allowed"


async def _raise():
    raise TargetError("target_not_allowed")


async def test_respond_schema_and_embed(monkeypatch):
    import core.agent_tools.respond as rs
    monkeypatch.setattr(rs, "_make_embed", lambda a: ("EMBED", a["title"]))
    eng, ctx, *_ = make([])
    tc, r = await _respond(ctx, True, {"type": "chat", "content": "x", "title": "t"})
    assert r.error.startswith("invalid_arguments")
    tc, r = await _respond(ctx, True, {"type": "embed", "content": "x", "title": "t"})
    assert r.ok and tc.sink.embeds == [("EMBED", "t")]
    _, r = await _respond(ctx, True, {"type": "chat", "content": "x", "color": "red"})
    assert r.error.startswith("invalid_arguments")


async def test_respond_dm_rate_limit():
    eng, ctx, *_ = make([], sinks=Sinks(), cfg_over={"dm_max_per_hour_per_agent": 1})
    dm = {"type": "chat", "content": "hi", "target": {"kind": "dm", "id": "12345678901234567"}}
    assert (await _respond(ctx, True, dm))[1].ok
    assert (await _respond(ctx, True, dm))[1].error == "rate_limited"
