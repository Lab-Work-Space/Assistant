import asyncio
import os
from types import SimpleNamespace as NS

from core.interfaces import ProviderError
from core.voice import session
from tests.voice.vfakes import BOT, U1, U2, U3, VC_ID, Mem, speak, started


async def idle(w):
    await asyncio.sleep(0)
    await asyncio.gather(*list(w.mgr.bg))


async def settle(w, s):
    for _ in range(3):
        await asyncio.sleep(0)
    await s.drain()


async def test_start_posts_notice_before_capture_and_sets_allowed(w, db):
    assert await w.mgr.record_start(w.mem[U1]) is None
    s = w.mgr.session
    assert w.vch.sent and w.vch.sent[0].embed is not None and w.vc.sink is None  # notice first, capture not yet
    assert "Gemini API" in w.vch.sent[0].embed.description and s.allowed == {U1, U2}
    await asyncio.gather(*s.tasks)
    assert w.vc.sink is not None and w.vc.recording
    row = await db.fetchrow("SELECT status, recording, notice_message_id FROM voice_sessions WHERE id=?1", s.id)
    assert (row["status"], row["recording"], row["notice_message_id"]) == ("active", 1, w.vch.sent[0].id)
    n = await db.fetchval("SELECT count(*) FROM voice_notice_deliveries WHERE session_id=?1", s.id)
    assert n == 2
    await w.mgr.stop("command")


async def test_flush_on_size_and_on_silence_and_min_segment(w):
    s = await started(w)
    sink = w.vc.sink
    speak(sink, U1, 30)  # a full VOICE_CHUNK_S
    await s.tick()
    await settle(w, s)
    assert w.stt.calls == [30 * 32000] and not s.buffers[U1]
    speak(sink, U2, 2)                      # 2 s, then silence for the flush window
    await s.tick()
    assert U2 in s.buffers and len(s.buffers[U2]) == 2 * 32000   # not yet quiet
    w.clock.t += 2
    await s.tick()
    await settle(w, s)
    assert w.stt.calls[-1] == 2 * 32000
    speak(sink, U1, 0)
    sink.write(NS(pcm=bytes(3840 * 5)), NS(id=U1))  # 100 ms: below VOICE_MIN_SEGMENT_MS
    w.clock.t += 2
    await s.tick()
    await settle(w, s)
    assert len(w.stt.calls) == 2 and not s.buffers[U1]  # discarded, never sent
    await w.mgr.stop("command")


async def test_budget_records_stt_with_stripped_model_and_drops_bytes(w):
    s = await started(w)
    speak(w.vc.sink, U1, 30)
    await s.tick()
    await settle(w, s)
    r = w.budget.records[0]
    assert (r["agent"], r["purpose"], r["units"], r["model"]) == ("praw", "stt", 30, "gemini-3.8-flash")
    assert r["ref"].startswith(s.id + ":") and not s.pending and not s.buffers[U1]
    await w.mgr.stop("command")


async def test_backlog_drop_marker_and_stop_after_three(w, monkeypatch):
    monkeypatch.setattr(session, "DRAIN_TIMEOUT_S", 0.05)
    s = await started(w)
    s._wake.clear()
    s.work_task.cancel()  # worker stalled: the queue fills
    w.cfg.voice_max_pending_chunks = 1
    for i in range(4):
        speak(w.vc.sink, U1, 30)
        await s.tick()
    assert len(s.pending) == 1 and s.drops == 3
    assert any("backlog" in x.text for x in s.segments)
    assert w.log.events("voice.chunk_dropped")
    await idle(w)
    assert w.mgr.session is not None and not w.vc.recording  # capture stopped (session stays for TTS)


async def test_three_failed_stt_chunks_stop_capture(w):
    s = await started(w)
    w.stt.err = ProviderError("unavailable", retryable=False)
    for _ in range(3):
        speak(w.vc.sink, U1, 30)
        await s.tick()
        await settle(w, s)
    await idle(w)
    assert not w.vc.recording and w.log.events("voice.stt_failed")


async def test_retry_once_on_retryable_error(w):
    s = await started(w)
    calls = []
    real = w.stt.transcribe

    async def flaky(pcm):
        calls.append(1)
        if len(calls) == 1:
            raise ProviderError("rate_limited", retryable=True)
        return await real(pcm)
    w.stt.transcribe = flaky
    speak(w.vc.sink, U1, 30)
    await s.tick()
    await settle(w, s)
    assert len(calls) == 2 and s.segments and s.segments[0].text == "hello"
    await w.mgr.stop("command")


async def test_max_session_length_stops(w):
    s = await started(w)
    w.clock.t += w.cfg.voice_max_session_min * 60
    await s.tick()
    await idle(w)
    assert not w.vc.recording


async def test_last_human_leaving_stops_and_leaves(w):
    s = await started(w)
    for u in (U1, U2):
        w.vch.members.remove(w.mem[u])
    before, after = NS(channel=w.vch), NS(channel=None)
    await w.mgr.on_voice_state(w.mem[U2], before, after)
    assert w.mgr.session is None and not w.vc.connected and not w.vc.recording


async def test_praw_disconnected_stops(w):
    await started(w)
    praw = Mem(BOT, "praw", None, bot=True)
    await w.mgr.on_voice_state(praw, NS(channel=w.vch), NS(channel=None))
    assert w.mgr.session is None


async def test_budget_stop_midmeeting(w):
    s = await started(w)
    w.budget.levels["praw"] = "stop"
    speak(w.vc.sink, U1, 30)
    await s.tick()
    await settle(w, s)
    await idle(w)
    assert w.stt.calls == [] and not w.vc.recording
    pending = await w.db.fetchval("SELECT status FROM voice_sessions")
    assert pending == "done"


async def test_busy_and_second_start(w):
    await started(w)
    assert await w.mgr.record_start(w.mem[U2]) == "voice_busy"
    await w.mgr.stop("command")


async def test_startup_recovery_marks_rows_failed(w, db):
    for st in ("active", "processing", "done"):
        await db.execute("INSERT INTO voice_sessions(guild_id, voice_channel_id, text_channel_id, started_by, status) VALUES(1,2,2,3,?1)", st)
    assert await w.mgr.recover() == 2
    rows = {r["status"] for r in await db.fetch("SELECT status FROM voice_sessions")}
    assert rows == {"failed", "done"} and w.admin == ["voice.recovered sessions=2 status=failed"]
    assert await db.fetchval("SELECT count(*) FROM voice_sessions WHERE status='failed' AND ended_at IS NOT NULL") == 2


async def test_runtime_dave_guard_no_pcm(w):
    s = await started(w)
    w.clock.t += 61
    await s.tick()
    await idle(w)
    assert w.mgr.live_capture is False and "voice.capture_disabled reason=receive_failed" in w.admin
    assert any("unavailable" in (m.content or "") for m in w.vch.sent)
    assert await w.mgr.record_start(w.mem[U1]) == "live_capture_disabled"


async def test_after_error_trips_guard(w):
    s = await started(w)
    w.vc.after(RuntimeError("x"))
    await idle(w)
    assert w.mgr.live_capture is False and not w.vc.recording


async def test_live_capture_off_by_default_and_gates(w):
    w.mgr.live_capture = False
    assert await w.mgr.record_start(w.mem[U1]) == "live_capture_disabled"
    w.mgr.live_capture = True
    w.mem[U1].voice.channel = None
    assert await w.mgr.record_start(w.mem[U1]) == "not_in_voice"
    w.mem[U1].voice.channel = w.vch
    w.vch.category_id = 1  # not allowlisted
    assert await w.mgr.record_start(w.mem[U1]) == "target_not_allowed"
    w.vch.category_id = 555555555555555501
    w.mgr.opus_ok = False
    assert await w.mgr.record_start(w.mem[U1]) == "opus_not_loaded"
    w.mgr.opus_ok = True
    w.budget.levels["praw"] = "stop"
    assert await w.mgr.record_start(w.mem[U1]) == "budget_exhausted"


async def test_join_and_errors(w):
    assert await w.mgr.join(w.mem[U1]) is None and w.mgr.session.connected()
    assert await w.mgr.join(w.mem[U2]) == "voice_busy"
    await w.mgr.stop("command", leave=True)
    w.mgr.opus_ok = False
    assert await w.mgr.join(w.mem[U1]) == "opus_not_loaded"


async def test_nothing_written_to_disk(w):
    before = set()
    for root, _, files in os.walk(w.tmp):
        before |= {os.path.join(root, f) for f in files}
    s = await started(w)
    speak(w.vc.sink, U1, 30)
    await s.tick()
    await settle(w, s)
    await w.mgr.stop("command")
    after = set()
    for root, _, files in os.walk(w.tmp):
        after |= {os.path.join(root, f) for f in files}
    new = {p for p in after - before if not p.endswith(("-wal", "-shm")) and "/k/meetings/" not in p and "emp.db" not in p}
    assert not new, new
    assert os.listdir(w.cfg.voice_tmp_dir) == []


async def test_exception_in_voice_is_isolated(w):
    async def boom():
        raise RuntimeError("x")
    w.vch.connect = boom
    assert await w.mgr.join(w.mem[U1]) == "internal_error" and w.mgr.session is None


async def test_optout_between_retries_sends_no_second_request(w):
    # Gate 2 B2 (S1212-02): the retry re-checks consent; attempt 0 is still recorded for the budget
    s = await started(w)
    calls = []

    async def flaky(pcm):
        calls.append(1)
        await w.mgr.optout(111111111111111111, U1, "command")
        raise ProviderError("rate_limited", retryable=True)
    w.stt.transcribe = flaky
    speak(w.vc.sink, U1, 30)
    await s.tick()
    await settle(w, s)
    assert len(calls) == 1 and not s.segments and any(r["purpose"] == "stt" for r in w.budget.records)
    await w.mgr.stop("command")


async def test_paid_tier_interlock(w):
    w.cfg.gemini_paid_tier_confirmed = False
    assert await w.mgr.record_start(w.mem[U1]) == "paid_tier_not_confirmed"
    w.cfg.gemini_paid_tier_confirmed = True
    assert await w.mgr.record_start(w.mem[U1]) is None


def test_notice_text_terms():
    from core.discord import strings
    en, th = strings.voice_notice_text("gemini").split("\n")
    for k in ("delete our copy", "paid tier", "not used to train", "limited time only to detect abuse", "outside Thailand"):
        assert k in en
    for k in ("ลบสำเนาของเรา", "ไม่ถูกใช้ฝึกโมเดล", "ชั่วคราว", "นอกประเทศไทย", "Opt out"):
        assert k in th
    g = strings.voice_notice_text("google-stt")
    assert "Google Cloud terms" in g and "train" not in g
