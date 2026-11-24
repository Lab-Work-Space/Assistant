"""Voice session state and manager (spec 12.12.6-12.12.8, 12.12.11; S1212-02/04/05/07).
One session per process. Audio lives only in memory; chunks are dropped right after each STT call.
Every voice exception is caught here: it stops the session and never reaches the intake client."""
import asyncio
import re
import threading
import time
import unicodedata
import uuid
from collections import deque
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import discord

from core.config import PROJECT_ROOT
from core.discord import strings
from core.discord.embeds import build_embed, mask_embed
from core.interfaces import AgentRequest, ProviderError, Usage
from core.voice import notice
from core.voice.sink import ConsentSink
from core.voice.stt import BYTES_PER_S, make_stt, seconds_of

STT_TIMEOUT_S, DRAIN_TIMEOUT_S, GUARD_S, MAX_DROPS, SPEAKER_SLOTS = 60, 120, 60, 3, 25
_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"
_HEAD = re.compile(r"^## ", re.M)
_LEAD = re.compile(r"^[#\s]+")


# -- sanitising (spec 12.12.8, S1212-04) ---------------------------------------------------------------
def sanitize_name(name) -> str:
    n = "".join(ch for ch in str(name) if ch not in "[]:  " and not unicodedata.category(ch).startswith("C"))
    return _LEAD.sub("", n).strip()[:32].strip() or "user"


def sanitize_text(text: str) -> str:
    """Folds every str.splitlines() separator, so no line can forge the `[<user_id>]:` erasure token."""
    return " ".join(str(text).splitlines()).replace("[", "(").replace("]", ")").strip()


def sanitize_summary(text: str) -> str:
    """Model output: unusual separators become newlines, then `## ` headings are demoted to `### `."""
    return _HEAD.sub("### ", "\n".join(str(text).splitlines()))


def mmss(s: float) -> str:
    s = max(0, int(s))
    return f"{s // 60:02d}:{s % 60:02d}"


@dataclass
class Segment:
    user_id: int | None  # None = gap marker
    name: str
    offset_s: float
    text: str


@dataclass
class Chunk:
    uid: int
    name: str
    offset_s: float
    pcm: bytes
    n: int


def build_body(summary: str, segs: list[Segment], ids: set[int]) -> str:
    names = {s.user_id: s.name for s in segs if s.user_id in ids}
    lines = [f"{s.name} [{s.user_id}]: {s.text}" if s.user_id is not None else s.text for s in segs
             if s.user_id is None or s.user_id in ids]
    return ("## Summary\n" + sanitize_summary(summary).strip() + "\n## Participants\n"
            + "\n".join(f"- {names[u]} [{u}]" for u in sorted(names)) + "\n## Transcript\n" + "\n".join(lines))


class VoiceSession:
    def __init__(self, mgr, guild, voice_channel, started_by: int):
        c = mgr.ctx.config
        self.mgr, self.guild, self.voice_channel, self.started_by, self.clock = mgr, guild, voice_channel, started_by, mgr.clock
        self.vc = None
        self.chunk_bytes = c.voice_chunk_s * BYTES_PER_S
        self.user_cap, self.total_cap = self.chunk_bytes * 2, (c.voice_max_pending_chunks + SPEAKER_SLOTS) * self.chunk_bytes  # S1212-07
        self.tasks: list[asyncio.Task] = []  # starter and late-joiner timers
        self.flush_task = self.work_task = None
        self.reset_capture()

    def reset_capture(self) -> None:
        self.lock = threading.Lock()
        self.id = self.notice_message_id = self.start_ts = None
        self.allowed: set[int] = set()
        self.optedout: set[int] = set()
        self.buffers: dict[int, bytearray] = {}
        self.first_ts: dict[int, float] = {}
        self.last_ts: dict[int, float] = {}
        self.overflow: dict[int, int] = {}
        self.pending: deque[Chunk] = deque()
        self.segments: list[Segment] = []
        self.inflight, self.recording, self.stopping, self.drops, self.n = False, False, False, 0, 0
        self._wake, self._idle = asyncio.Event(), asyncio.Event()
        self._idle.set()

    def cancel_tasks(self, all_: bool = False) -> None:
        me = asyncio.current_task()
        ts = [*self.tasks, self.flush_task] + ([self.work_task] if all_ else [])
        for t in ts:
            if t is not None and t is not me:
                t.cancel()
        self.tasks = []
        self.flush_task = None
        if all_:
            self.work_task = None

    def connected(self) -> bool:
        return self.vc is not None and self.vc.is_connected()

    def present(self) -> list:
        return [m for m in self.voice_channel.members if not getattr(m, "bot", False)]

    async def play(self, source) -> None:
        done = asyncio.Event()
        loop = asyncio.get_running_loop()
        self.vc.play(source, after=lambda e: loop.call_soon_threadsafe(done.set))
        await asyncio.wait_for(done.wait(), 300)

    def is_allowed(self, uid: int) -> bool:
        with self.lock:
            return uid in self.allowed

    def drop_user(self, uid: int) -> None:
        """Opt-out (spec 12.12.6): buffer, queued chunks and transcribed segments of this user are removed."""
        with self.lock:
            self.allowed.discard(uid)
            self.buffers.pop(uid, None)
            self.optedout.add(uid)
        self.pending = deque(c for c in self.pending if c.uid != uid)
        self.segments = [s for s in self.segments if s.user_id != uid]

    # -- flusher ---------------------------------------------------------------------------------------
    def _gap(self, a: float, b: float, why: str) -> None:
        self.segments.append(Segment(None, "", a, f"(gap {mmss(a)}-{mmss(b)}: {why})"))

    def collect(self, force: bool = False) -> list[Chunk]:
        c, now, out = self.mgr.ctx.config, self.clock(), []
        min_bytes = c.voice_min_segment_ms * BYTES_PER_S // 1000
        with self.lock:
            ov, self.overflow = self.overflow, {}
            for uid, buf in list(self.buffers.items()):
                if not buf:
                    continue
                quiet = now - self.last_ts.get(uid, now) >= c.voice_silence_flush_ms / 1000
                if not (force or quiet or len(buf) >= self.chunk_bytes):
                    continue
                data, off = bytes(buf), self.first_ts.get(uid, now) - self.start_ts
                buf.clear()
                if len(data) < min_bytes:
                    continue  # shorter than VOICE_MIN_SEGMENT_MS: never sent
                m = self.guild.get_member(uid)
                self.n += 1
                out.append(Chunk(uid, getattr(m, "display_name", "user"), off, data, self.n))
        for uid in ov:
            self._gap(now - self.start_ts, now - self.start_ts, "overflow")
            self.mgr.log("voice.chunk_dropped", "WARNING", session=self.id, user=uid, reason="overflow")
        return out

    def enqueue(self, ch: Chunk) -> bool:
        """False when dropped (backlog)."""
        if len(self.pending) >= self.mgr.ctx.config.voice_max_pending_chunks:
            self._gap(ch.offset_s, ch.offset_s + len(ch.pcm) / BYTES_PER_S, "backlog")
            self.mgr.log("voice.chunk_dropped", "WARNING", session=self.id, user=ch.uid, reason="backlog")
            self.drops += 1
            if self.drops >= MAX_DROPS and not self.stopping:
                self.mgr.request_stop("backlog")
            return False
        self.pending.append(ch)
        self._idle.clear()
        self._wake.set()
        return True

    async def tick(self) -> None:
        if self.stopping:
            return
        for ch in self.collect():
            self.enqueue(ch)
        el = self.clock() - self.start_ts
        if el >= self.mgr.ctx.config.voice_max_session_min * 60:
            self.mgr.request_stop("max_length")
        elif not self.last_ts and el >= GUARD_S and any(m.id in self.allowed for m in self.present()):
            await self.mgr.receive_failed()  # runtime DAVE guard (12.12.11)

    async def flusher(self) -> None:
        while True:
            await self.mgr.sleep(1)
            try:
                await self.tick()
            except Exception as e:
                self.mgr.log("voice.flusher_failed", "ERROR", error=type(e).__name__)

    # -- STT worker ------------------------------------------------------------------------------------
    async def worker(self) -> None:
        while True:
            await self._wake.wait()
            while self.pending:
                ch = self.pending.popleft()
                self.inflight = True
                try:
                    await self._process(ch)
                except Exception as e:
                    self.mgr.log("voice.stt_failed", "ERROR", session=self.id, error=type(e).__name__)
                finally:
                    self.inflight = False
                    ch.pcm = b""
            self._wake.clear()
            if not self.pending:
                self._idle.set()

    async def _process(self, ch: Chunk) -> None:
        m, c = self.mgr, self.mgr.ctx.config
        if not self.is_allowed(ch.uid):
            return  # S1212-02: queued before an opt-out, never sent
        if await m.ctx.budget.level(c.note_agent_id) == "stop":
            m.request_stop("budget")
            return
        if c.stt_provider == "gemini" and not c.gemini_paid_tier_confirmed:  # 12.12.23: never send audio
            m.request_stop("paid_tier_not_confirmed")
            return
        text = secs = err = None
        for attempt in (0, 1):
            if not self.is_allowed(ch.uid):  # S1212-02: re-check immediately before every request, the retry included
                if not attempt:
                    return
                err = text = None  # attempt 0 may be billed: fall through to budget.record, keep no text
                break
            err = None
            try:
                text, secs = await asyncio.wait_for(m.stt.transcribe(ch.pcm), STT_TIMEOUT_S)
                break
            except asyncio.TimeoutError:
                err = ProviderError("timeout", retryable=True)
            except ProviderError as e:
                err = e
            if not err.retryable:
                break
        prov, model = "google", "cloud-stt-v1" if c.stt_provider == "google-stt" else c.stt_model.split("/", 1)[-1]
        await m.ctx.budget.record(c.note_agent_id, prov, model, Usage(), "stt", units=secs or seconds_of(ch.pcm),
                                  ref=f"{self.id}:{ch.n}")
        ch.pcm = b""
        if err is not None:
            self._gap(ch.offset_s, ch.offset_s, "stt_failed")
            m.log("voice.stt_failed", "WARNING", session=self.id, user=ch.uid, provider=c.stt_provider, code=err.code)
            self.drops += 1
            if self.drops >= MAX_DROPS:
                m.request_stop("stt_failed")
            return
        self.drops = 0
        if text and self.is_allowed(ch.uid):  # opt-out while in flight: result discarded
            self.segments.append(Segment(ch.uid, sanitize_name(ch.name), ch.offset_s, sanitize_text(text)))

    async def drain(self, timeout: float | None = None) -> bool:
        timeout = DRAIN_TIMEOUT_S if timeout is None else timeout
        try:
            await asyncio.wait_for(self._idle.wait(), timeout)
            return True
        except asyncio.TimeoutError:
            return False


class VoiceManager:
    def __init__(self, ctx, clock=time.monotonic, sleep=asyncio.sleep):
        self.ctx, self.clock, self.sleep, self.app = ctx, clock, sleep, None
        self.session: VoiceSession | None = None
        self.live_capture = ctx.config.voice_live_capture
        self.opus_ok = False
        self._stt = None
        self.reask = notice.Reask(ctx, clock)
        self.bg: list[asyncio.Task] = []

    @property
    def stt(self):
        if self._stt is None:
            self._stt = make_stt(self.ctx)
        return self._stt

    def log(self, event: str, level: str = "INFO", **f) -> None:
        self.ctx.log.write_log("voice", event, level, **f)

    def _spawn(self, coro) -> asyncio.Task:
        t = asyncio.ensure_future(coro)
        self.bg.append(t)
        t.add_done_callback(lambda x: self.bg.remove(x) if x in self.bg else None)
        return t

    def request_stop(self, reason: str, leave: bool = False) -> None:
        self._spawn(self.stop(reason, leave))

    async def admin(self, text: str) -> None:
        if self.app is not None:
            await self.app._admin_line(text)

    # -- recovery (12.12.7) ----------------------------------------------------------------------------
    async def recover(self) -> int:
        n = await self.ctx.db.execute(f"UPDATE voice_sessions SET status='failed', ended_at={_NOW} "
                                      "WHERE status IN ('active','processing')")
        if n:
            self.log("voice.recovered", "WARNING", count=n)
            await self.admin(f"voice.recovered sessions={n} status=failed")
        return n

    # -- commands --------------------------------------------------------------------------------------
    def _vchan(self, member):
        return getattr(getattr(member, "voice", None), "channel", None)

    def _check_channel(self, vch) -> str | None:
        if getattr(getattr(vch, "guild", None), "id", None) != self.ctx.config.discord_guild_id or not self.app.gate.channel_ok(vch):
            return "target_not_allowed"
        return None

    async def join(self, member) -> str | None:
        vch = self._vchan(member)
        if vch is None:
            return "not_in_voice"
        if (e := self._check_channel(vch)):
            return e
        if self.session is not None:
            return "voice_busy"
        if not self.opus_ok:
            return "opus_not_loaded"
        s = self.session = VoiceSession(self, vch.guild, vch, member.id)
        try:
            s.vc = await vch.connect()
        except Exception as ex:
            self.session = None
            self.log("voice.connect_failed", "ERROR", error=type(ex).__name__)
            return "internal_error"
        return None

    async def record_start(self, member) -> str | None:
        """Pre-conditions in spec order; the first failure wins. The slow part (notice delay, start_recording) runs in the background."""
        vch, c = self._vchan(member), self.ctx.config
        if vch is None:
            return "not_in_voice"
        if (e := self._check_channel(vch)):
            return e
        if not self.live_capture:
            return "live_capture_disabled"
        if not self.opus_ok:
            return "opus_not_loaded"
        if c.stt_provider == "gemini" and not c.gemini_paid_tier_confirmed:  # 12.12.23: free tier trains on audio
            return "paid_tier_not_confirmed"
        if notice.consent_gap_present(c.database_path):  # S1212-01: fail closed
            await self.reask.post(vch.guild.id, vch, member.id)
            await self.admin(f"voice.consent_gap channel={vch.id}")
            return "consent_gap"
        if await self.ctx.budget.level(c.note_agent_id) == "stop":
            return "budget_exhausted"
        s = self.session
        if s is not None and (s.recording or s.voice_channel.id != vch.id):
            return "voice_busy"
        if s is None and (e := await self.join(member)):
            return e
        s = self.session
        s.started_by = member.id
        db, sid = self.ctx.db, str(uuid.uuid4())
        await db.execute("INSERT INTO voice_sessions(id, guild_id, voice_channel_id, text_channel_id, started_by, recording, status) "
                         "VALUES(?1,?2,?3,?3,?4,1,'active')", sid, vch.guild.id, vch.id, member.id)
        s.id, s.recording = sid, True
        present = s.present()
        try:
            e, v = notice.notice_embed(c, sid)
            m = await vch.send(embed=mask_embed(e), view=v, allowed_mentions=notice.NONE)
        except Exception as ex:  # S1212-05: no notice, no capture
            self.log("voice.notice_failed", "ERROR", session=sid, error=type(ex).__name__)
            await db.execute(f"UPDATE voice_sessions SET status='failed', ended_at={_NOW} WHERE id=?1", sid)
            s.reset_capture()
            await self.admin(f"voice.notice_failed channel={vch.id}")
            return "notice_failed"
        s.notice_message_id = m.id
        await db.execute("UPDATE voice_sessions SET notice_message_id=?1 WHERE id=?2", m.id, sid)
        for p in present:
            await db.execute("INSERT OR IGNORE INTO voice_notice_deliveries(session_id, user_id, method) VALUES(?1,?2,'channel')", sid, p.id)
        out = {r["user_id"] for r in await db.fetch("SELECT user_id FROM voice_optouts WHERE guild_id=?1", vch.guild.id)}
        s.allowed = {p.id for p in present} - out
        s.optedout = out & {p.id for p in present}
        s.start_ts = self.clock()
        self.log("voice.record_started", session=sid, channel=vch.id, members=len(present))
        s.tasks.append(self._spawn(self._begin(s)))
        return None

    async def _begin(self, s: VoiceSession) -> None:
        try:
            await self.sleep(self.ctx.config.voice_notice_delay_s)
            if self.session is not s or s.stopping:
                return
            loop = asyncio.get_running_loop()
            s.start_ts = self.clock()
            s.vc.start_recording(ConsentSink(s), lambda err: loop.call_soon_threadsafe(self._after, s, err))
            s.flush_task, s.work_task = asyncio.ensure_future(s.flusher()), asyncio.ensure_future(s.worker())
        except Exception as e:
            self.log("voice.start_failed", "ERROR", session=s.id, error=type(e).__name__)
            await self.stop("start_failed")

    def _after(self, s, err) -> None:
        if err is not None and self.session is s and not s.stopping:
            self._spawn(self.receive_failed())

    async def receive_failed(self) -> None:
        """Runtime DAVE guard (12.12.11): capture off until restart."""
        self.live_capture = False
        self.log("voice.capture_disabled", "ERROR", reason="receive_failed")
        await self.admin("voice.capture_disabled reason=receive_failed")
        s = self.session
        if s is not None:
            try:
                await s.voice_channel.send(content=strings.LIVE_UNAVAILABLE, allowed_mentions=notice.NONE)
            except Exception:
                pass
        await self.stop("receive_failed")

    async def optout(self, guild_id: int, uid: int, source: str) -> None:
        s = self.session
        if s is not None and s.guild.id == guild_id:
            s.drop_user(uid)  # S1212-02: in memory first, no await before it; a DB error still keeps the user out
        await self.ctx.db.execute("INSERT INTO voice_optouts(guild_id, user_id, source) VALUES(?1,?2,?3) "
                                  f"ON CONFLICT(guild_id, user_id) DO UPDATE SET source=?3, opted_out_at={_NOW}", guild_id, uid, source)

    async def optin(self, guild_id: int, uid: int) -> None:
        await self.ctx.db.execute("DELETE FROM voice_optouts WHERE guild_id=?1 AND user_id=?2", guild_id, uid)
        s = self.session
        if s is None or s.id is None or s.guild.id != guild_id or not s.recording:
            return
        row = await self.ctx.db.fetchrow("SELECT 1 AS x FROM voice_notice_deliveries WHERE session_id=?1 AND user_id=?2", s.id, uid)
        if row is not None and any(p.id == uid for p in s.present()):
            with s.lock:
                s.allowed.add(uid)
                s.optedout.discard(uid)

    # -- listeners -------------------------------------------------------------------------------------
    async def on_voice_state(self, member, before, after) -> None:
        s = self.session
        if s is None:
            return
        vid = s.voice_channel.id
        was, now = getattr(before.channel, "id", None) == vid, getattr(after.channel, "id", None) == vid
        if was == now:
            return
        me = getattr(getattr(self.app.intake, "user", None), "id", None)
        if member.id == me:
            if was and not now:
                await self.stop("disconnected", leave=True)
            return
        if getattr(member, "bot", False):
            return
        if now:
            if s.recording and not s.stopping:
                await self._late_join(s, member)
            return
        with s.lock:
            s.allowed.discard(member.id)
        if not s.present():
            await self.stop("empty", leave=True)

    async def _late_join(self, s: VoiceSession, member) -> None:
        uid, db, c = member.id, self.ctx.db, self.ctx.config
        if await db.fetchrow("SELECT 1 AS x FROM voice_optouts WHERE guild_id=?1 AND user_id=?2", s.guild.id, uid):
            return
        if await db.fetchrow("SELECT 1 AS x FROM voice_notice_deliveries WHERE session_id=?1 AND user_id=?2", s.id, uid):
            with s.lock:
                if uid not in s.optedout:
                    s.allowed.add(uid)  # rejoin: already noticed
            return
        text = notice.late_joiner_text(uid, c, notice.jump_url(s.guild.id, s.voice_channel.id, s.notice_message_id))
        try:
            await s.voice_channel.send(content=text[:2000], allowed_mentions=notice.late_mentions(uid))  # S1212-05/09
        except Exception as ex:
            self.log("voice.notice_failed", "WARNING", user=uid, error=type(ex).__name__)
            return  # never captured
        await db.execute("INSERT OR IGNORE INTO voice_notice_deliveries(session_id, user_id, method) VALUES(?1,?2,'channel')", s.id, uid)
        try:  # extra, never the only notice (S12-01: DM only via dm_ok)
            if await self.app.gate.dm_ok(uid):
                persona = self.ctx.personas.get(c.intake_persona)
                await self.ctx.sinks.for_dm(uid, persona).send_embed(
                    build_embed("Voice transcription notice / ประกาศการถอดเสียง", text.split("\n", 1)[0].replace(f"<@{uid}> ", "") +
                                "\n" + strings.voice_notice_text(c.stt_provider)[:3000], color=0xFFB300))
        except Exception:
            pass
        s.tasks.append(self._spawn(self._admit_later(s, uid)))

    async def _admit_later(self, s: VoiceSession, uid: int) -> None:
        await self.sleep(self.ctx.config.voice_notice_delay_s)
        if self.session is not s or s.stopping or not any(p.id == uid for p in s.present()):
            return
        if await self.ctx.db.fetchrow("SELECT 1 AS x FROM voice_optouts WHERE guild_id=?1 AND user_id=?2", s.guild.id, uid):
            return
        with s.lock:
            if uid not in s.optedout:
                s.allowed.add(uid)

    # -- stop ------------------------------------------------------------------------------------------
    async def stop(self, reason: str, leave: bool = False) -> None:
        s = self.session
        if s is None or s.stopping:
            return
        s.stopping = True
        try:
            if s.recording:
                await self._stop_recording(s, reason)
        except Exception as e:
            self.log("voice.stop_failed", "ERROR", session=s.id, error=type(e).__name__)
        finally:
            leave = leave or not s.connected()
            s.cancel_tasks(all_=True)
            if leave:
                self.session = None
                try:
                    if s.vc is not None:
                        await s.vc.disconnect()
                except Exception:
                    pass
            else:
                s.reset_capture()  # stays connected for TTS

    async def _set(self, s, status: str, note_path: str | None = None) -> None:
        end = f", ended_at={_NOW}" if status in ("done", "failed") else ""
        await self.ctx.db.execute(f"UPDATE voice_sessions SET status=?1, note_path=COALESCE(?2, note_path){end} WHERE id=?3",
                                  status, note_path, s.id)

    async def _say(self, s, title: str, text: str = "") -> None:
        try:
            await s.voice_channel.send(embed=build_embed(title, text, color=0x808080), allowed_mentions=notice.NONE)
        except Exception:
            pass

    async def _stop_recording(self, s: VoiceSession, reason: str) -> None:
        sid = s.id
        try:
            s.vc.stop_recording()
        except Exception:
            pass
        s.cancel_tasks()  # starter, late-joiner timers and the flusher; the worker stays for the drain
        if s.start_ts is not None:
            for ch in s.collect(force=True):
                s.enqueue(ch)
        if not await s.drain():
            self.log("voice.drain_timeout", "WARNING", session=sid)
        await self._set(s, "processing")
        try:
            path = await self._note(s)
        except Exception as e:
            self.log("voice.note_failed", "ERROR", session=sid, error=type(e).__name__)
            await self._set(s, "failed")
            await self._say(s, "Meeting note failed / สรุปบันทึกล้มเหลว", f"reason={reason}")
            return
        await self._set(s, "done", path)
        await self._say(s, "Recording stopped / หยุดบันทึกแล้ว", f"reason={reason}" + ("" if path else f"\n{strings.NO_SPEECH}"))
        self.log("voice.record_done", session=sid, reason=reason, note=bool(path))

    async def _note(self, s: VoiceSession) -> str | None:
        segs = sorted(s.segments, key=lambda x: x.offset_s)
        ids = {x.user_id for x in segs if x.user_id is not None} - s.optedout
        if not ids:
            return None  # zero segments: no note
        c, ctx = self.ctx.config, self.ctx
        root = Path(c.prompts_dir) if Path(c.prompts_dir).is_absolute() else PROJECT_ROOT / c.prompts_dir
        prompt = (root / "_system" / "meeting-note.md").read_text(encoding="utf-8")
        text = "\n".join(f"[{mmss(x.offset_s)}] {x.name}: {x.text}" if x.user_id is not None else x.text for x in segs
                         if x.user_id is None or x.user_id in ids)
        res = await ctx.engine.run(AgentRequest(  # engine wraps the text in <untrusted> (S1212-11); no tools
            agent_id=c.note_agent_id, trigger="voice_note", guild_id=s.guild.id, channel_id=s.voice_channel.id, thread_id=None,
            human_user_id=None, origin="discord", text=text, sink=ctx.sinks.null(), tools_override=(), system_extra=prompt))
        summary = res.text if res.ok and res.text.strip() else "Summary unavailable (the note agent failed)."
        first = next((ln.strip("# -*") for ln in sanitize_summary(summary).splitlines() if ln.strip("# -*")), "Meeting")[:120]
        vis = "members:" + ",".join(str(i) for i in sorted(ids))
        file = await ctx.knowledge.write_entry(
            "meetings", title="Meeting " + datetime.now().strftime("%Y-%m-%d %H:%M"), hook=first, tags=["meeting", "voice"],
            body=build_body(summary, segs, ids), author_agent=c.note_agent_id, run_id=getattr(res, "run_id", "") or str(uuid.uuid4()),
            trigger="voice_note", human_user_id=s.started_by, visibility=vis)  # B2-D5: always members-only
        return f"meetings/{file}"
