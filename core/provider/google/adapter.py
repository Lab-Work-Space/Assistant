"""Google adapter (spec 3.2). The token is GOOGLE_API_TOKEN, passed explicitly (not the SDK's default env name)."""
import asyncio

from google import genai
from google.genai import errors, types

from core.interfaces import ChatMessage, Effort, ProviderError, StreamEvent, ToolCall, ToolSpec, Usage

# Thinking budget table (tokens). low = thinking off. Thought parts are never surfaced (include_thoughts=False).
THINKING_BUDGET = {"low": 0, "medium": 1024, "high": 4096}
_FINISH_SAFETY = {"SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "RECITATION", "IMAGE_SAFETY"}


def map_error(e: Exception) -> ProviderError:
    code = getattr(e, "code", None)
    if isinstance(e, errors.APIError) and isinstance(code, int):
        if code == 429:
            return ProviderError("rate_limited", retryable=True)
        if code in (401, 403):
            return ProviderError("auth")
        if code == 404:
            return ProviderError("model_not_found")
        if code < 500:
            return ProviderError("bad_request")
    return ProviderError("unavailable", retryable=True)


def to_contents(messages: list[ChatMessage]) -> list[types.Content]:
    out: list[types.Content] = []
    for m in messages:
        if m.role == "tool":
            part = types.Part.from_function_response(name=m.name or "tool", response={"result": m.content})
            if out and out[-1].role == "user" and out[-1].parts and out[-1].parts[-1].function_response:
                out[-1].parts.append(part)
            else:
                out.append(types.Content(role="user", parts=[part]))
        elif m.role == "assistant":
            parts = ([types.Part(text=m.content)] if m.content else []) + [
                types.Part(function_call=types.FunctionCall(id=t.id, name=t.name, args=t.arguments),
                           thought_signature=t.signature)
                for t in m.tool_calls]
            out.append(types.Content(role="model", parts=parts or [types.Part(text=".")]))
        else:
            out.append(types.Content(role="user", parts=[types.Part(text=m.content)]))
    return out


def _usage(md) -> Usage:
    if md is None:
        return Usage()
    out = (getattr(md, "candidates_token_count", None) or getattr(md, "response_token_count", None) or 0)
    return Usage(md.prompt_token_count or 0, out + (md.thoughts_token_count or 0))


class GoogleAdapter:
    name = "google"

    def __init__(self, api_token: str | None = None, client=None):
        self._c = client or genai.Client(api_key=api_token)

    async def stream(self, *, model: str, system: str, messages: list[ChatMessage], tools: list[ToolSpec],
                     max_output_tokens: int, effort: Effort, timeout_s: float):
        # timeout_s is enforced by the engine as a per-event idle timeout.
        cfg = types.GenerateContentConfig(
            system_instruction=system, max_output_tokens=max_output_tokens,
            thinking_config=types.ThinkingConfig(thinking_budget=THINKING_BUDGET[effort], include_thoughts=False),
            tools=[types.Tool(function_declarations=[
                types.FunctionDeclaration(name=t.name, description=t.description, parameters_json_schema=t.parameters)
                for t in tools])] if tools else None)
        saw_call, finish, usage, n = False, None, Usage(), 0
        try:
            async for chunk in await self._c.aio.models.generate_content_stream(
                    model=model, contents=to_contents(messages), config=cfg):
                if chunk.usage_metadata is not None:
                    usage = _usage(chunk.usage_metadata)
                for cand in chunk.candidates or []:
                    finish = cand.finish_reason or finish
                    for p in (cand.content.parts if cand.content and cand.content.parts else []):
                        if p.function_call:
                            n += 1
                            saw_call = True
                            fc = p.function_call
                            yield StreamEvent("tool_call", tool_call=ToolCall(
                                fc.id or f"call_{n}", fc.name, dict(fc.args or {}),
                                getattr(p, "thought_signature", None)))
                        elif p.text and not p.thought:
                            yield StreamEvent("text", text=p.text)
        except ProviderError:
            raise
        except Exception as e:
            raise map_error(e) from None
        fin = getattr(finish, "name", str(finish or ""))
        stop = "tool_use" if saw_call else "safety" if fin in _FINISH_SAFETY else \
            "max_tokens" if fin == "MAX_TOKENS" else "end"
        yield StreamEvent("usage", usage=usage)
        yield StreamEvent("done", stop_reason=stop)

    async def complete(self, *, model: str, system: str = "", prompt: str, max_output_tokens: int,
                       timeout_s: float) -> tuple[str, Usage]:
        cfg = types.GenerateContentConfig(
            max_output_tokens=max_output_tokens, system_instruction=system or None,
            thinking_config=types.ThinkingConfig(thinking_budget=0),
            # API refuses deadlines under 10 s (400); keep the HTTP deadline legal and enforce ours locally
            http_options=types.HttpOptions(timeout=int(max(timeout_s, 10) * 1000)))
        try:
            r = await asyncio.wait_for(self._c.aio.models.generate_content(model=model, contents=prompt, config=cfg),
                                       timeout_s)
        except asyncio.TimeoutError:
            raise ProviderError("timeout", retryable=True) from None
        except Exception as e:
            raise map_error(e) from None
        return r.text or "", _usage(r.usage_metadata)

    async def generate_image(self, *, model: str, prompt: str, aspect: str, timeout_s: float) -> bytes | None:
        """Additive (TASK-015). Returns PNG/JPEG bytes, or None when the model refused (safety block)."""
        cfg = types.GenerateContentConfig(
            response_modalities=["IMAGE"], image_config=types.ImageConfig(aspect_ratio=aspect),
            http_options=types.HttpOptions(timeout=int(max(timeout_s, 10) * 1000)))
        try:
            r = await self._c.aio.models.generate_content(model=model, contents=prompt, config=cfg)
        except Exception as e:
            raise map_error(e) from None
        for cand in r.candidates or []:
            for p in (cand.content.parts if cand.content and cand.content.parts else []):
                if p.inline_data and p.inline_data.data:
                    return p.inline_data.data
        fin = [getattr(c.finish_reason, "name", str(c.finish_reason or "")) for c in r.candidates or []]
        if r.prompt_feedback and r.prompt_feedback.block_reason or any(f in _FINISH_SAFETY for f in fin):
            return None
        raise ProviderError("unavailable", "no image", retryable=True)

    async def transcribe_audio(self, *, model: str, audio: bytes, mime: str, prompt: str, timeout_s: float) -> tuple[str, Usage]:
        """Additive (TASK-016): inline audio bytes (no Files API, nothing stored by us). Returns (text, usage)."""
        cfg = types.GenerateContentConfig(thinking_config=types.ThinkingConfig(thinking_budget=0),
                                          http_options=types.HttpOptions(timeout=int(max(timeout_s, 10) * 1000)))
        try:
            r = await self._c.aio.models.generate_content(
                model=model, contents=[prompt, types.Part.from_bytes(data=audio, mime_type=mime)], config=cfg)
        except Exception as e:
            raise map_error(e) from None
        return r.text or "", _usage(r.usage_metadata)

    async def synthesize_speech(self, *, model: str, text: str, voice: str, timeout_s: float) -> tuple[bytes, str] | None:
        """Additive (TASK-016). Returns (pcm bytes, inline_data.mime_type), or None when nothing was returned."""
        cfg = types.GenerateContentConfig(
            response_modalities=["AUDIO"],
            speech_config=types.SpeechConfig(voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=voice))),
            http_options=types.HttpOptions(timeout=int(max(timeout_s, 10) * 1000)))
        try:
            r = await self._c.aio.models.generate_content(model=model, contents=text, config=cfg)
        except Exception as e:
            raise map_error(e) from None
        for cand in r.candidates or []:
            for p in (cand.content.parts if cand.content and cand.content.parts else []):
                if p.inline_data and p.inline_data.data:
                    return p.inline_data.data, p.inline_data.mime_type or ""
        return None

    async def list_models(self) -> set[str]:
        try:
            return {m.name.removeprefix("models/") async for m in await self._c.aio.models.list()}
        except Exception as e:
            raise map_error(e) from None
