"""B2 acceptance (12.12.18 items 6, 7; S1212-03, S1212-10): TTS scope/limits, budget stop, usage rows with prefix-less price keys."""
import asyncio
from types import SimpleNamespace as NS

import pytest

from core.budget import prices
from core.voice.tts import MAX_PCM_BYTES, Speaker, TtsSource
from tests.discord_fakes import persona
from tests.voice.vfakes import G, U1, U2, VC_ID, speak, started


class FakeTts:
    def __init__(self, mime="audio/L16;codec=pcm;rate=24000", size=48000):
        self.calls, self.mime, self.size = [], mime, size

    async def synthesize_speech(self, model, text, voice, timeout_s):
        self.calls.append((model, text, voice))
        return bytes(self.size), self.mime


def speaker(w, **kw):
    w.ctx.providers = {"google": FakeTts(**kw)}
    return Speaker(w.ctx, w.mgr), w.ctx.providers["google"]


async def say(sp, text="hello there", channel=VC_ID, user=U1, guild=G):
    await sp.after_reply(guild, user, persona("praw"), text, channel)
    if sp._task:
        await sp._task


async def test_tts_only_voice_channel_text_chat_never_dm(w):
    await started(w)
    sp, tts = speaker(w)
    await say(sp, channel=None)                       # DM: no channel id
    await say(sp, channel=123)                        # another text channel
    await say(sp, guild=G + 1)                        # other guild
    w.mem[U2].voice.channel = None
    await say(sp, user=U2)                            # human not in the voice channel
    assert tts.calls == [] and w.vc.played == []
    await say(sp)                                     # the one legitimate case
    assert len(tts.calls) == 1 and isinstance(w.vc.played[0], TtsSource)


async def test_tts_masks_secrets_and_strips_markdown_before_synthesis(w):
    await started(w)
    sp, tts = speaker(w)
    await say(sp, "key AIzaSyA-1234567890abcdefghijklmnopqrstuv0 and **bold** `code`")
    spoken = tts.calls[0][1]
    assert "AIzaSy" not in spoken and "**" not in spoken and "`" not in spoken


@pytest.mark.parametrize("rate,ok", [(8000, 1), (12000, 1), (16000, 1), (24000, 1), (48000, 1), (44100, 0), (0, 0), (96000, 0), (11025, 0)])
async def test_tts_rate_allowlist(w, rate, ok):
    await started(w)
    sp, _ = speaker(w, mime=f"audio/L16;codec=pcm;rate={rate}")
    await say(sp)
    assert len(w.vc.played) == ok


async def test_tts_size_cap_and_text_cap_and_queue_cap(w):
    await started(w)
    sp, tts = speaker(w, size=MAX_PCM_BYTES + 2)
    await say(sp, "x" * 5000)
    assert w.vc.played == [] and len(tts.calls[0][1]) <= w.cfg.tts_max_chars
    sp, tts = speaker(w)
    for i in range(12):                               # burst: queue capped at 5 (+1 being synthesised)
        await sp.after_reply(G, U1, persona("praw"), f"msg {i}", VC_ID)
    await sp._task
    assert len(tts.calls) <= 6


async def test_budget_stop_refuses_stt_and_tts_real_guard(wr):
    w = wr
    s = await started(w)
    sp, tts = speaker(w)
    await w.db.execute("INSERT INTO budgets(agent_id, daily_limit_micro_usd, updated_by) VALUES('praw', 1000, 'cli:test')")
    await w.ctx.budget.record("praw", "google", "gemini-3.8-flash", NS(input_tokens=0, output_tokens=0), "stt", units=100000)
    assert await w.ctx.budget.level("praw") == "stop"
    await say(sp)
    assert tts.calls == [] and w.vc.played == []      # TTS refused
    speak(w.vc.sink, U1, 30)
    await s.tick(); await asyncio.sleep(0); await asyncio.sleep(0)
    assert w.stt.calls == []                          # STT refused
    await asyncio.sleep(0.05)
    assert await w.mgr.record_start(w.mem[U1]) == "budget_exhausted"


async def test_usage_rows_stt_and_tts_have_prefixless_price_keys_and_known_price(wr):
    w = wr
    s = await started(w)
    sp, _ = speaker(w)
    speak(w.vc.sink, U1, 30)
    await s.tick(); await s.drain()
    await say(sp, "hello")
    await w.mgr.stop("command")
    rows = {r["purpose"]: r for r in await w.db.fetch("SELECT purpose, provider, model, units, cost_micro_usd FROM usage_events")}
    assert set(rows) == {"stt", "tts"}
    assert rows["stt"]["model"] == "gemini-3.8-flash" and rows["tts"]["model"] == "gemini-3.8-flash-tts"
    assert not any("/" in r["model"] for r in rows.values())
    assert rows["stt"]["cost_micro_usd"] == rows["stt"]["units"] * prices.UNIT["stt"]["gemini-3.8-flash"] > 0
    assert rows["tts"]["cost_micro_usd"] == rows["tts"]["units"] * prices.UNIT["tts"]["gemini-3.8-flash-tts"] > 0
    assert w.log.events("budget.unknown_model") == []
