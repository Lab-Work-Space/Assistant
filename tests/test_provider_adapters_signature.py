"""Live-found 2026-11-24: Gemini 3 400s unless each function_call part echoes its thought_signature;
Anthropic rejects whitespace-only assistant text blocks."""
from core.interfaces import ChatMessage, ToolCall
from core.provider.anthropic.adapter import to_api_messages
from core.provider.google.adapter import to_contents


def test_google_echoes_thought_signature_on_function_call():
    msgs = [ChatMessage("user", "hi"), ChatMessage("assistant", "", [ToolCall("c1", "read_index", {}, b"sig-bytes")]),
            ChatMessage("tool", "r", tool_call_id="c1", name="read_index")]
    model_turn = to_contents(msgs)[1]
    assert model_turn.parts[0].function_call.name == "read_index"
    assert model_turn.parts[0].thought_signature == b"sig-bytes"


def test_google_without_signature_still_builds():
    turn = to_contents([ChatMessage("assistant", "", [ToolCall("c1", "x", {})])])[0]
    assert turn.parts[0].thought_signature is None


def test_anthropic_drops_whitespace_only_text_and_trailing_space():
    m = to_api_messages([ChatMessage("assistant", "\n\n", [ToolCall("t1", "x", {})]),
                         ChatMessage("assistant", "ok  \n", [])])
    assert m[0]["content"] == [{"type": "tool_use", "id": "t1", "name": "x", "input": {}}]
    assert m[1]["content"] == [{"type": "text", "text": "ok"}]


async def test_google_complete_keeps_http_deadline_legal_and_times_out_locally():
    """Live-found 2026-11-24: Gemini 400s on HTTP deadlines under 10 s (tier2/classifier use 3 s)."""
    import asyncio
    import pytest
    from core.interfaces import ProviderError
    from core.provider.google.adapter import GoogleAdapter
    seen = {}

    class Models:
        async def generate_content(self, model, contents, config):
            seen["timeout"] = config.http_options.timeout
            await asyncio.sleep(1)

    class Client:
        class aio:
            models = Models()

    a = GoogleAdapter(client=Client())
    with pytest.raises(ProviderError) as e:
        await a.complete(model="m", prompt="p", max_output_tokens=8, timeout_s=0.05)
    assert seen["timeout"] >= 10000 and e.value.code == "timeout"
