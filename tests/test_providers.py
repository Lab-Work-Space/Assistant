import pytest

from core.interfaces import ChatMessage, ProviderError, ToolCall
from core.provider import registry
from core.provider.anthropic.adapter import to_api_messages
from core.provider.google.adapter import to_contents


def test_parse_model():
    assert registry.parse_model("gemini/gemini-3.8-flash") == ("google", "gemini-3.8-flash")
    assert registry.parse_model("anthropic/claude-sonnet-5-5") == ("anthropic", "claude-sonnet-5-5")
    for bad in ("openai/x", "nomodel", "google/"):
        with pytest.raises(ProviderError):
            registry.parse_model(bad)


MSGS = [ChatMessage("user", "q"),
        ChatMessage("assistant", "", [ToolCall("a", "t1", {"x": 1}), ToolCall("b", "t2", {})]),
        ChatMessage("tool", "r1", tool_call_id="a", name="t1"), ChatMessage("tool", "r2", tool_call_id="b", name="t2")]


def test_anthropic_messages_merge_parallel_results():
    out = to_api_messages(MSGS)
    assert [m["role"] for m in out] == ["user", "assistant", "user"]
    assert [b["type"] for b in out[1]["content"]] == ["tool_use", "tool_use"]
    assert [b["tool_use_id"] for b in out[2]["content"]] == ["a", "b"]


def test_google_contents_merge_parallel_results():
    out = to_contents(MSGS)
    assert [c.role for c in out] == ["user", "model", "user"]
    assert len(out[2].parts) == 2 and out[2].parts[0].function_response.name == "t1"


async def test_verify_models_fails_on_unknown():
    class A:
        async def list_models(self): return {"gemini-3.8-flash"}
    from types import SimpleNamespace as N
    p = N(model="gemini/gemini-3.8-flash", cheap_model="gemini/nope")
    ctx = N(config=N(default_cheap_model="google/gemini-3.8-flash", reply_tier2_model="google/gemini-3.8-flash",
                     image_model="google/img", tts_model="plain-no-prefix"),
            personas=N(all=lambda: [p]), providers={"google": A()})
    with pytest.raises(ProviderError) as e:
        await registry.verify_models(ctx)
    assert e.value.code == "model_not_found" and "gemini/nope" in str(e.value) and "plain" not in str(e.value)
    p.cheap_model = "google/img"
    ctx.providers["google"].list_models = lambda: _s({"gemini-3.8-flash", "img"})
    await registry.verify_models(ctx)


async def _s(x): return x
