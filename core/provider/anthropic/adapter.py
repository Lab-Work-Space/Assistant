"""Anthropic adapter (spec 3.2). Uses ANTHROPIC_API_KEY passed in by agents.ext. Thinking blocks are never surfaced."""
import anthropic

from core.interfaces import ChatMessage, Effort, ProviderError, StreamEvent, ToolCall, ToolSpec, Usage

# Effort table: adaptive thinking is always on for the 5.5 models (cannot be disabled), so effort maps 1:1 to
# output_config.effort and no thinking param is sent.
EFFORT = {"low": "low", "medium": "medium", "high": "high"}
_STOP = {"end_turn": "end", "stop_sequence": "end", "tool_use": "tool_use", "max_tokens": "max_tokens",
         "refusal": "safety", "pause_turn": "end"}


def map_error(e: Exception) -> ProviderError:
    """Error text is never copied (it may echo prompt content); only the class decides the code."""
    if isinstance(e, anthropic.APITimeoutError):
        return ProviderError("timeout", retryable=True)
    if isinstance(e, anthropic.RateLimitError):
        return ProviderError("rate_limited", retryable=True)
    if isinstance(e, (anthropic.AuthenticationError, anthropic.PermissionDeniedError)):
        return ProviderError("auth")
    if isinstance(e, anthropic.NotFoundError):
        return ProviderError("model_not_found")
    if isinstance(e, anthropic.BadRequestError):
        return ProviderError("bad_request")
    return ProviderError("unavailable", retryable=True)


def to_api_messages(messages: list[ChatMessage]) -> list[dict]:
    out: list[dict] = []
    for m in messages:
        if m.role == "tool":
            blk = {"type": "tool_result", "tool_use_id": m.tool_call_id, "content": m.content}
            if out and out[-1]["role"] == "user" and isinstance(out[-1]["content"], list) \
                    and out[-1]["content"][-1]["type"] == "tool_result":
                out[-1]["content"].append(blk)  # parallel results go in one user message
            else:
                out.append({"role": "user", "content": [blk]})
        elif m.role == "assistant":
            # API 400s on whitespace-only text blocks (model often emits "\n" before a tool call); trailing space too
            txt = (m.content or "").rstrip()
            blocks = ([{"type": "text", "text": txt}] if txt else []) + [
                {"type": "tool_use", "id": t.id, "name": t.name, "input": t.arguments} for t in m.tool_calls]
            out.append({"role": "assistant", "content": blocks or [{"type": "text", "text": "."}]})
        else:
            out.append({"role": "user", "content": m.content})
    return out


class AnthropicAdapter:
    name = "anthropic"

    def __init__(self, api_key: str | None = None, client=None):
        self._c = client or anthropic.AsyncAnthropic(api_key=api_key)

    async def stream(self, *, model: str, system: str, messages: list[ChatMessage], tools: list[ToolSpec],
                     max_output_tokens: int, effort: Effort, timeout_s: float):
        kw = dict(model=model, system=system, messages=to_api_messages(messages), max_tokens=max_output_tokens,
                  output_config={"effort": EFFORT[effort]}, timeout=timeout_s)
        if tools:
            kw["tools"] = [{"name": t.name, "description": t.description, "input_schema": t.parameters}
                           for t in tools]
        try:
            async with self._c.messages.stream(**kw) as s:
                async for ev in s:
                    if ev.type == "text":
                        yield StreamEvent("text", text=ev.text)
                final = await s.get_final_message()
            for b in final.content:
                if b.type == "tool_use":
                    yield StreamEvent("tool_call", tool_call=ToolCall(b.id, b.name, dict(b.input or {})))
            u = Usage(final.usage.input_tokens or 0, final.usage.output_tokens or 0)
            yield StreamEvent("usage", usage=u)
            yield StreamEvent("done", stop_reason=_STOP.get(final.stop_reason, "end"))
        except ProviderError:
            raise
        except anthropic.AnthropicError as e:
            raise map_error(e) from None

    async def complete(self, *, model: str, system: str = "", prompt: str, max_output_tokens: int,
                       timeout_s: float) -> tuple[str, Usage]:
        try:
            r = await self._c.messages.create(model=model, max_tokens=max_output_tokens, timeout=timeout_s,
                                              output_config={"effort": "low"},
                                              messages=[{"role": "user", "content": prompt}])
        except anthropic.AnthropicError as e:
            raise map_error(e) from None
        text = "".join(b.text for b in r.content if b.type == "text")
        return text, Usage(r.usage.input_tokens or 0, r.usage.output_tokens or 0)

    async def list_models(self) -> set[str]:
        try:
            return {m.id async for m in self._c.models.list()}
        except anthropic.AnthropicError as e:
            raise map_error(e) from None
