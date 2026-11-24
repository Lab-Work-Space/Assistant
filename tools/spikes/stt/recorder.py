"""THROWAWAY spike (TASK-002), py-cord 2.8.1. Run from the repo root: python -m tools.spikes.stt.recorder
/stt-record start|stop : DAVE receive probe via core.voice.sink.ConsentSink (probe mode: everyone present at start,
                         after the notice, is "allowed"); writes 16 kHz mono WAV per speaker.
/stt-play              : TTS playback probe (Gemini TTS -> MonoPcmSource), logs the response mime_type.
Env: DISCORD_BOT_TOKEN, GOOGLE_API_TOKEN (playback only). Delete after the spike."""
import asyncio
import ctypes.util
import logging
import os
import threading
import time
import wave

import discord

from core.voice.pcm import MonoPcmSource
from core.voice.sink import ConsentSink

log = logging.getLogger("stt-spike")
logging.basicConfig(level=logging.INFO)
bot = discord.Bot(intents=discord.Intents(guilds=True, voice_states=True))
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "clips")
sessions = {}  # guild id -> ProbeSession


class ProbeSession:
    """Duck-typed session for ConsentSink (+ frame counters for the DAVE probe)."""
    def __init__(self, guild, allowed):
        self.lock, self.guild, self.allowed = threading.Lock(), guild, set(allowed)
        self.buffers, self.first_ts, self.last_ts, self.clock = {}, {}, {}, time.monotonic
        self.name = time.strftime("%Y%m%d-%H%M%S")


class CountingSink(ConsentSink):
    def __init__(self, session):
        super().__init__(session)
        self.frames = {}  # probe (a): PCM frames per speaker index; no user ids on disk or in logs

    def write(self, data, user):
        uid = getattr(user, "id", None)
        if uid is not None and data.pcm:
            self.frames[uid] = self.frames.get(uid, 0) + 1
        super().write(data, user)


def _opus():
    if not discord.opus.is_loaded():
        discord.opus.load_opus(ctypes.util.find_library("opus") or "libopus.dylib")


class TtsSource(MonoPcmSource, discord.AudioSource):  # MonoPcmSource first: its read() wins the MRO
    pass


@bot.slash_command(name="stt-record", description="Spike: record voice channel for STT test")
async def stt_record(ctx, action: discord.Option(str, choices=["start", "stop"])):
    if action == "start":
        if not (ctx.author.voice and ctx.author.voice.channel):
            return await ctx.respond("Join a voice channel first.", ephemeral=True)
        if ctx.guild.voice_client:
            return await ctx.respond("Already recording.", ephemeral=True)
        _opus()
        # notice is posted BEFORE any audio is captured
        await ctx.respond("NOTICE: this voice channel is being RECORDED for a speech-to-text accuracy test. "
                          "Audio is deleted after scoring. Leave now if you do not consent.")
        await asyncio.sleep(10)
        ch = ctx.author.voice.channel
        humans = [m.id for m in ch.members if not m.bot]
        s = sessions[ctx.guild.id] = ProbeSession(ctx.guild, humans)
        vc = await ch.connect()
        sink = CountingSink(s)
        loop = asyncio.get_running_loop()

        def after(error):  # py-cord 2.8.1: exactly one positional arg
            log.info("after(error)=%r", error)
            try:
                os.makedirs(OUT, exist_ok=True)
                with s.lock:
                    bufs = list(s.buffers.values())
                for i, b in enumerate(bufs, 1):  # speaker index only, no user ids
                    with wave.open(os.path.join(OUT, f"{s.name}_u{i}.wav"), "wb") as w:
                        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
                        w.writeframes(bytes(b))
                log.info("PROBE dave=%s speakers=%d frames=%s error=%r", vc.is_dave_connection(), len(sink.frames),
                         sorted(sink.frames.values()), error)
                msg = (f"Saved {len(bufs)} clip(s). DAVE={vc.is_dave_connection()} "
                       f"frames/speaker={sorted(sink.frames.values())} after_error={error!r}")
            except Exception as e:  # never let the callback die silently
                log.exception("after failed")
                msg = f"after() failed: {type(e).__name__}"
            asyncio.run_coroutine_threadsafe(ctx.channel.send(msg), loop)

        vc.start_recording(sink, after)
        log.info("recording started dave=%s humans=%d", vc.is_dave_connection(), len(humans))
        await ctx.followup.send("Recording.")
    else:
        vc = ctx.guild.voice_client
        if not vc:
            return await ctx.respond("Not recording.", ephemeral=True)
        vc.stop_recording()  # triggers after(error)
        await vc.disconnect()
        await ctx.respond("Stopping.")


@bot.slash_command(name="stt-play", description="Spike: play ~5 s of Gemini TTS into your voice channel")
async def stt_play(ctx, text: str = "สวัสดีครับ นี่คือการทดสอบเสียงพูด ได้ยินชัดเจนไหมครับ"):
    if not (ctx.author.voice and ctx.author.voice.channel):
        return await ctx.respond("Join a voice channel first.", ephemeral=True)
    await ctx.defer()
    _opus()
    from google import genai
    from google.genai import types
    r = await genai.Client(api_key=os.environ["GOOGLE_API_TOKEN"]).aio.models.generate_content(
        model=os.environ.get("TTS_MODEL", "gemini-2.5-flash-preview-tts"), contents=text,
        config=types.GenerateContentConfig(response_modalities=["AUDIO"], speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Kore")))))
    part = r.candidates[0].content.parts[0].inline_data
    log.info("TTS mime_type=%s bytes=%d", part.mime_type, len(part.data))
    try:
        rate = int(part.mime_type.split("rate=")[1].split(";")[0])
        src = TtsSource(part.data, rate)
    except (IndexError, ValueError):
        return await ctx.followup.send(f"tts_format_unsupported: {part.mime_type}")

    vc = ctx.guild.voice_client or await ctx.author.voice.channel.connect()
    done = asyncio.Event()
    loop = asyncio.get_running_loop()
    vc.play(src, after=lambda e: (log.info("play after(error)=%r", e), loop.call_soon_threadsafe(done.set)))
    await ctx.followup.send(f"Playing (mime_type={part.mime_type}).")
    await done.wait()
    await vc.disconnect()


bot.run(os.environ["DISCORD_BOT_TOKEN"])
