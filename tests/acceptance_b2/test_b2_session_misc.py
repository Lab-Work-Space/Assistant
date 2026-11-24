"""B2 acceptance: DAVE guard, single session, fault isolation, no files, ffmpeg grep, pull_user voice; exploratory caps and long session."""
import asyncio
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace as NS

import pytest

from core.voice.ext import Commands
from core.voice.session import SPEAKER_SLOTS, Segment
from tests.voice.vfakes import G, U1, U2, FakeStt, Mem, speak, started

ROOT = Path(__file__).resolve().parents[2]


async def spin(n=10):
    for _ in range(n):
        await asyncio.sleep(0)


# -- DAVE guard -------------------------------------------------------------------------------------------
async def test_runtime_dave_guard_trips_at_60s_without_frames(w):
    s = await started(w)
    w.clock.t += 59
    await s.tick()
    assert w.mgr.live_capture and w.mgr.session.recording                 # 59 s: still waiting
    w.clock.t += 1
    await s.tick(); await spin()
    assert not w.mgr.live_capture and not s.recording and w.admin and "receive_failed" in w.admin[-1]
    assert await w.mgr.record_start(w.mem[U1]) == "live_capture_disabled"
    assert any("unavailable" in (m.content or "").lower() or m.content for m in w.vch.sent[1:])   # users told in channel


async def test_dave_guard_does_not_trip_when_frames_arrive(w):
    s = await started(w)
    speak(w.vc.sink, U1, 1)
    w.clock.t += 120
    await s.tick(); await spin()
    assert w.mgr.live_capture and s.recording
    await w.mgr.stop("command")


# -- one session, fault isolation ---------------------------------------------------------------------------
async def test_only_one_session(w):
    await started(w)
    other = NS(id=222222222222222299)
    m3 = Mem(U1 + 99, "x", w.vch)
    assert await w.mgr.record_start(w.mem[U2]) == "voice_busy"            # second start in same channel while recording
    assert await w.mgr.join(m3) == "voice_busy"
    await w.mgr.stop("command")


@pytest.mark.parametrize("where", ["stt", "engine", "start_recording", "connect", "tts_adapter"])
async def test_voice_exception_never_escapes(w, where):
    from core.voice.tts import Speaker
    if where == "stt":
        w.mgr._stt = FakeStt(); w.mgr._stt.err = RuntimeError("boom")
    if where == "engine":
        async def bad(req): raise RuntimeError("boom")
        w.engine.run = bad
    if where == "start_recording":
        w.vc.start_recording = lambda *a: (_ for _ in ()).throw(RuntimeError("boom"))
    if where == "connect":
        async def bad(): raise RuntimeError("boom")
        w.vch.connect = bad
    if where == "tts_adapter":
        class A:
            async def synthesize_speech(self, **k): raise RuntimeError("boom")
        w.ctx.providers = {"google": A()}
    if where == "connect":
        assert await w.mgr.record_start(w.mem[U1]) == "internal_error"
        return
    assert await w.mgr.record_start(w.mem[U1]) is None
    s = w.mgr.session
    await asyncio.gather(*s.tasks, return_exceptions=True)
    if s.recording and w.vc.sink is not None:
        speak(w.vc.sink, U1, 30)
        await s.tick(); await spin()
    sp = Speaker(w.ctx, w.mgr)
    await sp.after_reply(G, U1, NS(id="praw"), "hello", w.vch.id)           # must not raise
    if sp._task: await sp._task
    await w.mgr.stop("command")                                           # must not raise
    # intake keeps working: a command handler still answers
    cmds = Commands(w.app, w.mgr)
    sent = []
    i = NS(user=w.mem[U1], response=NS(send_message=lambda *a, **k: _rec(sent, a)))
    await cmds.record_start(i)
    assert sent


async def _rec(sent, a):
    sent.append(a)


async def test_command_handler_swallows_internal_error(w):
    async def bad(member): raise RuntimeError("boom")
    w.mgr.record_start = bad
    sent = []
    i = NS(user=w.mem[U1], response=NS(send_message=lambda *a, **k: _rec(sent, a)))
    await Commands(w.app, w.mgr).record_start(i)
    assert len(sent) == 1


# -- no file anywhere ---------------------------------------------------------------------------------------
async def test_no_file_created_during_session(w):
    opened = []
    on = [False]

    def hook(event, args):
        if on[0] and event == "open":
            path, mode, flags = args
            if isinstance(path, int):
                return  # fd from os.fdopen (mkstemp); the mkstemp open itself is audited with its path
            m = mode or ""
            wr = any(c in str(m) for c in "wax+") or (isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT))
            if wr and not str(path).endswith(("-wal", "-shm", "-journal")) and "emp.db" not in str(path):
                opened.append(str(path))
    sys.addaudithook(hook)
    snap = lambda d: {os.path.join(r, f) for r, _, fs in os.walk(d) for f in fs}
    vt = w.cfg.voice_tmp_dir
    s = await started(w)
    on[0] = True
    for u in (U1, U2):
        speak(w.vc.sink, u, 30)
    await s.tick(); await s.drain()
    speak(w.vc.sink, U1, 5)
    pre_stop_opened = list(opened)
    assert pre_stop_opened == [], pre_stop_opened                         # nothing at all while capturing / transcribing
    await w.mgr.stop("command")
    on[0] = False
    kdir = w.cfg.knowledge_dir
    assert opened, 'audit hook must see the note write (proves the hook works)'
    assert all(p.startswith(kdir) for p in opened), opened                # at stop only the note (knowledge dir) is written
    assert not os.path.exists(vt) or os.listdir(vt) == []
    assert not [p for p in snap(w.tmp) if "voice" in p and p != vt]


# -- ffmpeg / process / move grep -------------------------------------------------------------------------------
def test_repo_code_has_no_ffmpeg_subprocess_or_move():
    hits, moves = [], []
    for base in ("core", "deploy", "scripts", "tools", "pyproject.toml", "requirements.txt", "requirements.lock"):
        p = ROOT / base
        files = [p] if p.is_file() else [f for f in p.rglob("*") if f.is_file() and f.suffix in (".py", ".sh", ".service", ".toml", ".txt", ".cfg", ".md")] if p.exists() else []
        for f in files:
            if "__pycache__" in f.parts or "/tests/" in str(f) or f.name.startswith("test_"):
                continue
            t = f.read_text(errors="ignore")
            for ln in t.splitlines():   # a mention is fine only as a negation ("no ffmpeg", "without ffmpeg")
                if re.search(r"ffmpeg|libav|pydub|ffprobe", ln, re.I) and not re.search(r"\b(no|without)\s+ffmpeg", ln, re.I):
                    hits.append(f"{f.relative_to(ROOT)}: {ln.strip()[:80]}")
            if f.suffix == ".py" and re.search(r"\.move_to\(|voice_channel\s*=|move_members", t) and "voice" in str(f) + t[:0]:
                moves.append(str(f.relative_to(ROOT)))
    assert hits == [], hits
    assert not [m for m in moves if "pulluser" in m or "voice" in m], moves
    voice_src = "".join(f.read_text() for f in (ROOT / "core" / "voice").glob("*.py"))
    assert "subprocess" not in voice_src and "os.system" not in voice_src and "tempfile" not in voice_src


# -- pull_user voice -------------------------------------------------------------------------------------------
async def test_pull_user_voice_sends_invite_link_never_moves(tmp_path):
    from tests.test_pulluser import voice_world, run
    from tests.discord_fakes import HUMAN
    w = voice_world(tmp_path)
    moved = []
    target = w.g._m[HUMAN + 1]
    for name in ("move_to", "edit"):
        setattr(target, name, lambda *a, _n=name, **k: moved.append(_n))
    r = await run(w, {"user_id": str(HUMAN + 1), "reason": "join us", "destination": "voice"})
    assert r.ok and r.data["method"].startswith("voice_") and moved == []
    msg = w.ch["allowed"].threads[0].sent[0]
    assert f"discord.com/channels/{w.cfg.discord_guild_id}/{w.ch['kid'].id}" in msg.content


# -- exploratory ---------------------------------------------------------------------------------------------------
async def test_25_plus_speakers_memory_bounded_by_caps_s1212_07(tmp_path, db):
    from tests.voice.vfakes import make_world
    w = make_world(tmp_path, db)
    for k in range(40):
        u = 700000000000000000 + k
        w.mem[u] = Mem(u, f"u{k}", w.vch); w.vch.members.append(w.mem[u])
    s = await started(w)
    assert len(s.allowed) == 42
    for _ in range(3):
        for u in list(w.mem):
            speak(w.vc.sink, u, 40)                    # far more than a user cap / total cap, no ticks in between
    held = sum(len(b) for b in s.buffers.values())
    assert held <= s.total_cap and all(len(b) <= s.user_cap for b in s.buffers.values())
    assert s.total_cap == (w.cfg.voice_max_pending_chunks + SPEAKER_SLOTS) * 30 * 32000
    assert s.overflow                                   # overflow recorded for a gap marker
    await s.tick(); await spin()
    assert len(s.pending) <= w.cfg.voice_max_pending_chunks
    assert any(sg.user_id is None and "overflow" in sg.text for sg in s.segments) or s.drops
    await w.mgr.stop("command")


@pytest.mark.parametrize("minutes", [5, 120])
async def test_max_session_length_stops_and_keeps_note(tmp_path, db, minutes):
    from tests.voice.vfakes import make_world
    w = make_world(tmp_path, db, VOICE_MAX_SESSION_MIN=str(minutes))
    s = await started(w)
    speak(w.vc.sink, U1, 30); await s.tick(); await s.drain()
    w.clock.t += minutes * 60 - 1
    speak(w.vc.sink, U1, 1)
    await s.tick(); await spin()
    assert s.recording and not s.stopping
    w.clock.t += 1
    await s.tick()
    await asyncio.gather(*w.mgr.bg)
    assert w.mgr.session is not None and not w.mgr.session.recording     # stopped capturing, stays connected for TTS
    d = w.cfg.knowledge_dir + "/meetings"
    assert [f for f in os.listdir(d) if f.endswith(".md") and f != "_index.md"]
    assert "max_length" in w.vch.sent[-1].embed.description
