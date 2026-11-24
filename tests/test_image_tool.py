import pytest
from types import SimpleNamespace

from core.agent_tools.image import make_image_generate
from core.agent_tools.registry import Registry
from core.interfaces import AppContext, ProviderError, ToolCall, ToolContext
from tests.test_agent_engine import Budget, Log, Sink, persona


class Img:
    def __init__(self, result): self.result, self.calls = result, []

    async def generate_image(self, **kw):
        self.calls.append(kw)
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


class FSink(Sink):
    async def send_file(self, filename, data, content=""): self.file = (filename, data); return 5


def run(result, level="ok"):
    log, b, ad = Log(), Budget(level), Img(result)
    ctx = AppContext(config=SimpleNamespace(image_model="gemini-3.1-flash-image"), log=log, db=None, personas=None,
                     surface="cli", approver_policy=None, budget=b, providers={"google": ad})
    ctx.tools = Registry(log)
    ctx.tools.register(make_image_generate(ctx))
    s = FSink()
    tc = ToolContext(agent=persona(), run_id="r1", guild_id=1, channel_id=10, thread_id=None, trigger="human_message",
                     human_user_id=1, sink=s, origin="cli")

    async def go(args=None):
        return await ctx.tools.invoke(tc, ToolCall("c", "image_generate", args or {"prompt": "cat", "aspect": "16:9"}),
                                      ctx.tools.for_agent(persona()))
    return go, b, ad, s


async def test_attachment_and_spend_recorded():
    go, b, ad, s = run(b"PNG")
    r = await go()
    assert r.ok and s.file == ("image.png", b"PNG") and ad.calls[0]["aspect"] == "16:9"
    assert b.rec == [("gemini-3.1-flash-image", pytest.approx(b.rec[0][1]), "image", "r1")]


async def test_api_failure_honest_error_no_spend():
    go, b, _, s = run(ProviderError("unavailable"))
    r = await go()
    assert (r.ok, r.error) == (False, "image_failed") and not b.rec and not hasattr(s, "file")


async def test_safety_block_recorded():
    go, b, _, _ = run(None)
    r = await go()
    assert r.error == "image_blocked" and len(b.rec) == 1


@pytest.mark.parametrize("lvl", ["stop", "fallback"])
async def test_refused_when_budget_closed(lvl):
    go, b, ad, _ = run(b"PNG", lvl)
    r = await go()
    assert r.error == "budget_exhausted" and not ad.calls and not b.rec


async def test_invalid_aspect():
    go, *_ = run(b"PNG")
    assert not (await go({"prompt": "x", "aspect": "4:3"})).ok
