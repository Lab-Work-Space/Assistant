"""TASK-033 T2: overlay in build_system + Engine (AT-8, G033-04)."""
import hashlib
from types import SimpleNamespace

from core.agents.untrusted import wrap_untrusted
from core.config import PROJECT_ROOT
from core.growth import OVERLAY_HARD_MAX_CHARS
from tests.test_agent_engine import Sink, StreamEvent, U, make, req

OK = [[StreamEvent("text", text="ok"), U(), StreamEvent("done", stop_reason="end")]]
WRAPPER = "Learned guidance: the end of this prompt may contain an <untrusted source=\"overlay\">"


def growth(block=None, exc=None):
    async def prompt_block(persona):
        if exc:
            raise exc
        return block
    return SimpleNamespace(overlays=SimpleNamespace(prompt_block=prompt_block))


async def system_of(g, **kw):
    eng, ctx, ad, log = make([list(OK[0])])
    ctx.growth = g
    await eng.run(req(Sink(), **kw))
    return ad.calls[0]["system"], log


async def test_overlay_last_and_wrapped():
    block = wrap_untrusted("lesson one", "overlay")
    s, _ = await system_of(growth(block))
    assert s.endswith("\n\n" + block)


async def test_absent_on_approval_review():
    s, _ = await system_of(growth(wrap_untrusted("LESSON-X1", "overlay")), trigger="approval_review")
    assert "LESSON-X1" not in s


async def test_secret_overlay_dropped():
    s, _ = await system_of(growth(wrap_untrusted("key sk-ant-SUPERSECRETVALUE123456", "overlay")))
    assert "SUPERSECRET" not in s and "Agents (id | name" in s


async def test_oversize_overlay_dropped_not_sliced():
    s, _ = await system_of(growth("x" * (OVERLAY_HARD_MAX_CHARS + 1)))
    assert "xxxx" not in s
    s, _ = await system_of(growth(wrap_untrusted("y" * 13000, "overlay")[:OVERLAY_HARD_MAX_CHARS]))
    assert "yyyy" in s


async def test_growth_none_works():
    s, _ = await system_of(None)
    assert "Agents (id | name" in s


async def test_prompt_block_exception_logged():
    s, log = await system_of(growth(exc=RuntimeError("secret text")))
    ev = log.ev("growth.overlay_failed")
    assert ev and ev[0]["error"] == "RuntimeError" and "secret text" not in str(ev[0])  and s.endswith("Channel: channel")


def test_wrapper_pointer_once():
    w = (PROJECT_ROOT / "prompts" / "_system" / "wrapper.md").read_text(encoding="utf-8")
    assert w.count(WRAPPER) == 1


def test_prompts_hash_stable():
    h = lambda: {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted((PROJECT_ROOT / "prompts").rglob("*")) if p.is_file()}
    a = h()
    assert a and a == h()
