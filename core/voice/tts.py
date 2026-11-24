"""TTS (spec 12.12.12, S1212-03, S1212-10): Gemini PCM -> MonoPcmSource frames -> Praw's voice connection. No ffmpeg."""
import asyncio
import re
import uuid
from collections import deque

import discord

from core.functions.logs.masking import mask_secrets
from core.interfaces import Usage
from core.voice.pcm import MonoPcmSource

RATES = (8000, 12000, 16000, 24000, 48000)  # S1212-10 allowlist (all divide 48000)
MAX_PCM_CEILING = 6_000_000                # hard ceiling per reply, S1212-10 (about 125 s at 24 kHz mono)
SEC_PER_CHAR = 0.12                         # generous speech pace (~8 chars/s)
MAX_PCM_BYTES = MAX_PCM_CEILING             # default cap, kept for importers


def max_pcm_bytes(max_chars: int, rate: int = 24000) -> int:
    """G2B2-09: reply cap derived from TTS_MAX_CHARS (16-bit mono), never above the hard ceiling."""
    return min(MAX_PCM_CEILING, int(max_chars * SEC_PER_CHAR * rate * 2))
QUEUE_MAX = 5
_MIME = re.compile(r"^audio/l16\s*(?:;\s*[a-z]+=[^;]*)*$", re.IGNORECASE)
_RATE = re.compile(r";\s*rate=(\d{1,6})\b", re.IGNORECASE)
_FENCE, _INLINE, _LINK, _MD = re.compile(r"```.*?```", re.S), re.compile(r"`([^`]*)`"), re.compile(r"\[([^\]]*)\]\([^)]*\)"), re.compile(r"[*_#>~|]+")


class TtsSource(MonoPcmSource, discord.AudioSource):
    pass


def parse_mime(mime: str) -> int:
    m = _RATE.search(mime or "")
    if not _MIME.match(mime or "") or not m or int(m[1]) not in RATES:
        raise ValueError("tts_format_unsupported")
    return int(m[1])


def speakable(text: str, limit: int) -> str:
    t = mask_secrets(text)  # S1212-03: before TTS
    t = _LINK.sub(r"\1", _INLINE.sub(r"\1", _FENCE.sub(" ", t)))
    return re.sub(r"\s+", " ", _MD.sub("", t)).strip()[:limit]


class Speaker:
    """VoiceHooks implementation. Speaks only replies posted in the voice channel's own text chat."""

    def __init__(self, ctx, mgr, timeout_s: float = 60):
        self.ctx, self.mgr, self.timeout_s = ctx, mgr, timeout_s
        self.queue: deque = deque()
        self._task: asyncio.Task | None = None

    def _log(self, event: str, level: str = "INFO", **f) -> None:
        self.ctx.log.write_log("voice", event, level, **f)

    async def after_reply(self, guild_id, user_id, persona, text, channel_id=None) -> None:
        try:
            s = self.mgr.session
            if s is None or guild_id != s.guild.id or channel_id != s.voice_channel.id or not s.connected():
                return  # S1212-03: never DMs or other channels
            member = s.guild.get_member(user_id)
            vs = getattr(member, "voice", None)
            if getattr(getattr(vs, "channel", None), "id", None) != s.voice_channel.id:
                return
            t = speakable(text, self.ctx.config.tts_max_chars)
            if not t:
                return
            if len(self.queue) >= QUEUE_MAX:
                self._log("tts.queue_full", "WARNING")
                return
            self.queue.append((persona.id, t))
            if self._task is None or self._task.done():
                self._task = asyncio.ensure_future(self._run())
        except Exception as e:  # voice failures never reach the reply path
            self._log("tts.failed", "ERROR", error=type(e).__name__)

    async def _run(self) -> None:
        while self.queue:
            pid, t = self.queue.popleft()
            try:
                await self._speak(pid, t)
            except Exception as e:
                self._log("tts.failed", "ERROR", error=type(e).__name__, code=getattr(e, "code", None))

    async def _speak(self, pid: str, text: str) -> None:
        c, s = self.ctx.config, self.mgr.session
        if s is None or not s.connected():
            return
        if await self.ctx.budget.level(pid) == "stop":
            self._log("tts.skipped", reason="budget")
            return
        prov, _, model = c.tts_model.rpartition("/")
        adapter = self.ctx.providers.get(prov or "google")
        if adapter is None:
            self._log("tts.skipped", reason="no_provider")
            return
        out = await adapter.synthesize_speech(model=model, text=text, voice=c.tts_voice, timeout_s=self.timeout_s)
        await self.ctx.budget.record(pid, prov or "google", model, Usage(), "tts", units=len(text), ref=f"tts:{uuid.uuid4()}")
        if out is None:
            return
        pcm, mime = out
        try:
            rate = parse_mime(mime)
        except ValueError:
            self._log("tts.format_unsupported", "WARNING", code="tts_format_unsupported")
            return
        if len(pcm) > max_pcm_bytes(c.tts_max_chars, rate):
            self._log("tts.too_large", "WARNING", size=len(pcm))
            return
        await s.play(TtsSource(pcm, rate))
