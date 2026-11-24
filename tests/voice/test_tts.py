import asyncio
import io
import json
import types
import wave
from types import SimpleNamespace as NS

import pytest

from core.config import Config, ConfigError
from core.provider.google.adapter import GoogleAdapter
from core.voice.pcm import FRAME_BYTES
from core.voice.stt import CloudStt, GeminiStt, make_stt, to_wav
from core.voice.tts import MAX_PCM_BYTES, max_pcm_bytes, QUEUE_MAX, Speaker, TtsSource, parse_mime, speakable
from tests.discord_fakes import persona
from tests.test_discord_layer import denv
from tests.voice.vfakes import U1, U2, VC_ID, Mem, started


def test_parse_mime_allowlist():
    assert parse_mime("audio/L16;codec=pcm;rate=24000") == 24000
    assert parse_mime("audio/l16; rate=16000") == 16000
    for bad in ("audio/mp3", "audio/L16", "audio/L16;rate=44100", "audio/L16;rate=0", "", None, "audio/L16;rate=96000"):
        with pytest.raises(ValueError, match="tts_format_unsupported"):
            parse_mime(bad)


def test_source_frames():
    for rate in (8000, 12000, 16000, 24000, 48000):
        src = TtsSource(bytes(rate * 2), rate)
        frames = []
        while (f := src.read()):
            frames.append(f)
        assert all(len(f) == FRAME_BYTES for f in frames) and len(frames) == 50 and src.is_opus() is False


def test_speakable_masks_and_strips(monkeypatch):
    from core.functions.logs import masking
    masking.set_exact(["supersecret-token-123"])
    t = speakable("**hi** [link](http://x) `code` ```\nbig block\n``` supersecret-token-123 " + "z" * 50, 40)
    assert "supersecret" not in t and "big block" not in t and "http" not in t and len(t) <= 40 and t.startswith("hi link code")


class Adapter:
    def __init__(self, out=("pcm", "audio/L16;codec=pcm;rate=24000")):
        self.out, self.calls = out, []

    async def synthesize_speech(self, *, model, text, voice, timeout_s):
        self.calls.append((model, text, voice))
        pcm, mime = self.out
        return bytes(48000) if pcm == "pcm" else pcm, mime


async def speaker(w, adapter=None):
    w.ctx.providers["google"] = adapter or Adapter()
    sp = Speaker(w.ctx, w.mgr)
    return sp


async def say(sp, w, text="hello", channel=VC_ID, user=U1, pid="praw"):
    await sp.after_reply(111111111111111111, user, persona(pid), text, channel)
    if sp._task:
        await sp._task


async def test_speaks_in_voice_text_chat_only(w):
    await started(w)
    sp = await speaker(w)
    await say(sp, w)
    assert len(w.vc.played) == 1 and isinstance(w.vc.played[0], TtsSource)
    r = w.budget.records[-1]
    assert (r["purpose"], r["model"], r["units"]) == ("tts", "t", 5)  # price key without provider/ prefix
    await say(sp, w, channel=999)                         # S1212-03: other channel (or a DM: None)
    await say(sp, w, channel=None)
    await say(sp, w, user=U2 + 99)                        # not in the voice channel
    w.mem[U2].voice.channel = None
    await say(sp, w, user=U2)
    assert len(w.vc.played) == 1
    await w.mgr.stop("command", leave=True)
    await say(sp, w)
    assert len(w.vc.played) == 1


async def test_no_session_or_budget_stop_skips(w):
    sp = await speaker(w)
    await say(sp, w)
    assert w.vc.played == []
    await started(w)
    w.budget.levels["praw"] = "stop"
    await say(sp, w)
    assert w.vc.played == [] and w.log.events("tts.skipped") == [{"reason": "budget"}]
    assert not [r for r in w.budget.records if r["purpose"] == "tts"]


async def test_bad_mime_and_size_cap_nothing_played(w):
    await started(w)
    sp = await speaker(w, Adapter(("pcm", "audio/mp3")))
    await say(sp, w)
    assert w.vc.played == [] and w.log.events("tts.format_unsupported")
    cap = max_pcm_bytes(w.cfg.tts_max_chars, 24000)
    sp.ctx.providers["google"] = Adapter((bytes(cap + 1), "audio/L16;rate=24000"))
    await say(sp, w)
    assert w.vc.played == [] and w.log.events("tts.too_large")


async def test_queue_cap(w):
    await started(w)
    gate = asyncio.Event()

    class Slow(Adapter):
        async def synthesize_speech(self, **kw):
            await gate.wait()
            return await super().synthesize_speech(**kw)
    sp = await speaker(w, Slow())
    for _ in range(QUEUE_MAX + 3):
        await sp.after_reply(111111111111111111, U1, persona(), "x", VC_ID)
        await asyncio.sleep(0)
    assert len(sp.queue) <= QUEUE_MAX and w.log.events("tts.queue_full")
    gate.set()
    await sp._task


async def test_tts_failure_is_isolated(w):
    await started(w)

    class Boom(Adapter):
        async def synthesize_speech(self, **kw):
            raise RuntimeError("x")
    sp = await speaker(w, Boom())
    await say(sp, w)
    assert w.log.events("tts.failed") and w.vc.played == []


# ---- STT adapters ---------------------------------------------------------------------------------------
async def test_gemini_stt_sends_wav_bytes():
    seen = {}

    class A:
        async def transcribe_audio(self, **kw):
            seen.update(kw)
            return " hi ", None
    text, secs = await GeminiStt(A(), "m").transcribe(bytes(64000))
    assert (text, secs) == ("hi", 2) and seen["mime"] == "audio/wav" and seen["model"] == "m"
    with wave.open(io.BytesIO(seen["audio"])) as f:
        assert (f.getnchannels(), f.getframerate(), f.getnframes()) == (1, 16000, 32000)


async def test_cloud_stt_header_only_key_and_errors():
    got = {}

    class R:
        def __init__(self, d): self.d = d
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self): return json.dumps(self.d).encode()

    def ok(req, timeout):
        got["h"], got["t"], got["b"] = dict(req.header_items()), timeout, json.loads(req.data)
        return R({"results": [{"alternatives": [{"transcript": "สวัสดี"}]}]})
    text, secs = await CloudStt("KEY-xxxxxxxxxxxxxxxx", ok).transcribe(bytes(32000))
    assert text == "สวัสดี" and secs == 1 and got["h"]["X-goog-api-key"] == "KEY-xxxxxxxxxxxxxxxx" and got["t"] == 60
    assert "KEY-" not in json.dumps(got["b"]) and got["b"]["config"]["languageCode"] == "th-TH"

    def bad(req, timeout):
        raise OSError("secret URL KEY-xxxxxxxxxxxxxxxx")
    with pytest.raises(Exception) as e:
        await CloudStt("KEY-xxxxxxxxxxxxxxxx", bad).transcribe(bytes(32000))
    assert "KEY-" not in str(e.value) and e.value.code == "unavailable"


# ---- config (12.12.3, S1212-11) -------------------------------------------------------------------------
def test_voice_config_defaults_and_validation(tmp_path):
    c = Config.load(denv(tmp_path))
    assert (c.voice_enabled, c.voice_live_capture, c.voice_chunk_s, c.voice_silence_flush_ms, c.voice_min_segment_ms,
            c.voice_max_pending_chunks, c.voice_max_session_min, c.voice_notice_delay_s) == (False, False, 30, 1500, 500, 6, 120, 10)
    assert not hasattr(c, "voice_upload_max_mb")
    for over, code in [({"VOICE_LIVE_CAPTURE": "true"}, "bounds:VOICE_LIVE_CAPTURE"),
                       ({"VOICE_ENABLED": "true", "STT_PROVIDER": "google"}, "stt_provider_invalid"),
                       ({"VOICE_ENABLED": "true", "STT_PROVIDER": "google-stt"}, "missing:GOOGLE_STT_API_KEY"),
                       ({"VOICE_CHUNK_S": "4"}, "bounds:VOICE_CHUNK_S"), ({"VOICE_CHUNK_S": "56"}, "bounds:VOICE_CHUNK_S"),
                       ({"VOICE_SILENCE_FLUSH_MS": "499"}, "bounds:VOICE_SILENCE_FLUSH_MS"),
                       ({"VOICE_MAX_PENDING_CHUNKS": "21"}, "bounds:VOICE_MAX_PENDING_CHUNKS"),
                       ({"VOICE_MAX_SESSION_MIN": "4"}, "bounds:VOICE_MAX_SESSION_MIN"),
                       ({"VOICE_NOTICE_DELAY_S": "61"}, "bounds:VOICE_NOTICE_DELAY_S"),
                       ({"GOOGLE_STT_API_KEY": "short"}, "secret_too_short:GOOGLE_STT_API_KEY")]:
        with pytest.raises(ConfigError) as e:
            Config.load(denv(tmp_path, **over))
        assert e.value.code == code, over
    ok = Config.load(denv(tmp_path, VOICE_ENABLED="true", STT_PROVIDER="google-stt", GOOGLE_STT_API_KEY="stt-key-aaaaaaaaaaaaaaaa"))
    from core.functions.logs import masking
    assert "stt-key-aaaaaaaaaaaaaaaa" in masking.exact_values() and "stt-key" not in repr(ok)
    assert isinstance(make_stt(NS(config=ok, providers={})), CloudStt)


def test_make_stt_gemini_strips_prefix(tmp_path):
    c = Config.load(denv(tmp_path, VOICE_ENABLED="true", STT_PROVIDER="gemini", STT_MODEL="google/gemini-3.8-flash"))
    s = make_stt(NS(config=c, providers={"google": object()}))
    assert isinstance(s, GeminiStt) and s.model == "gemini-3.8-flash"


# ---- additive adapter methods (fake genai client) --------------------------------------------------------
async def test_google_adapter_stt_tts_additive():
    calls = []

    class Models:
        async def generate_content(self, model, contents, config):
            calls.append((model, contents, config))
            part = NS(inline_data=NS(data=b"\x01\x02", mime_type="audio/L16;codec=pcm;rate=24000"), text=None)
            return NS(text="สวัสดี", usage_metadata=NS(prompt_token_count=5, candidates_token_count=2, thoughts_token_count=0,
                                                        response_token_count=None),
                      candidates=[NS(content=NS(parts=[part]), finish_reason=None)])
    a = GoogleAdapter(client=NS(aio=NS(models=Models())))
    text, usage = await a.transcribe_audio(model="m", audio=b"abc", mime="audio/wav", prompt="p", timeout_s=5)
    assert text == "สวัสดี" and usage.input_tokens == 5 and calls[0][1][0] == "p"
    assert calls[0][1][1].inline_data.mime_type == "audio/wav"
    out = await a.synthesize_speech(model="t", text="hi", voice="Kore", timeout_s=5)
    assert out == (b"\x01\x02", "audio/L16;codec=pcm;rate=24000")
    assert calls[1][2].response_modalities == ["AUDIO"]
    assert calls[1][2].speech_config.voice_config.prebuilt_voice_config.voice_name == "Kore"


def test_pcm_cap_derived_from_chars_with_ceiling():
    assert max_pcm_bytes(100, 24000) == int(100 * 0.12 * 24000 * 2) < max_pcm_bytes(1000, 24000) <= MAX_PCM_BYTES
    assert max_pcm_bytes(10**9, 48000) == MAX_PCM_BYTES
