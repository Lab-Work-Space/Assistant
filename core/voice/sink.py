import threading  # noqa: F401  (session.lock is a threading.Lock)
import discord
from core.voice.pcm import to_stt_pcm

DEFAULT_USER_CAP = 30 * 32000 * 2  # VOICE_CHUNK_S default x 16 kHz mono s16le x 2 (S1212-07)


class ConsentSink(discord.sinks.Sink):
    """py-cord 2.8.1 receive contract (router.py / opus.py): is_opus, walk_children, __sink_listeners__, write(VoiceData, source)."""
    __sink_listeners__ = ()

    def __init__(self, session):
        super().__init__()
        self.session = session  # holds .lock (threading.Lock), .allowed (set[int]), .guild, .buffers, .first_ts, .last_ts, .clock

    def is_opus(self) -> bool:
        return False  # py-cord decodes Opus to 48 kHz stereo PCM with libopus

    def walk_children(self, with_self: bool = False):
        return [self] if with_self else []

    def write(self, data, user):  # runs on py-cord's packet-router thread
        uid = getattr(user, "id", None)
        if uid is None or not data.pcm:
            return  # unknown speaker: dropped (10.12.4)
        s = self.session
        with s.lock:
            if uid not in s.allowed or s.guild.get_member(uid) is None:
                return  # opted-out / not-noticed / non-member audio is never copied
            pcm = to_stt_pcm(data.pcm)
            buf = s.buffers.setdefault(uid, bytearray())
            total_cap = getattr(s, "total_cap", None)
            if (len(buf) + len(pcm) > getattr(s, "user_cap", DEFAULT_USER_CAP)
                    or total_cap and sum(map(len, s.buffers.values())) + len(pcm) > total_cap):
                ov = getattr(s, "overflow", None)  # S1212-07: over the cap the audio is dropped; the flusher marks a gap
                if ov is not None:
                    ov[uid] = ov.get(uid, 0) + 1
                return
            if not buf:
                s.first_ts[uid] = s.clock()
            buf += pcm
            s.last_ts[uid] = s.clock()

    def cleanup(self):
        self.finished = True  # nothing on disk; the session drops buffers
