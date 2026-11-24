"""B2 acceptance (spec 12.12.18 items 2, 3; S1212-01/02/05/10): consent on fakes, black-box through VoiceManager + ConsentSink."""
import asyncio
import os
from types import SimpleNamespace as NS

from core.voice.notice import Reask
from tests.voice.vfakes import G, U1, U2, U3, FakeStt, Mem, speak, started


async def spin(n=8):
    for _ in range(n):
        await asyncio.sleep(0)


def note_text(w):
    d = w.cfg.knowledge_dir + "/meetings"
    fs = [f for f in os.listdir(d) if f.endswith(".md") and f != "_index.md"]
    return [w.ctx.knowledge.read_entry("meetings", f) for f in fs]


class GateStt(FakeStt):
    def __init__(self):
        super().__init__()
        self.gate, self.entered = asyncio.Event(), asyncio.Event()

    async def transcribe(self, pcm):
        self.calls.append(len(pcm))
        self.entered.set()
        await self.gate.wait()
        return "secret words", 1


async def test_notice_posted_before_any_capture(w):
    snap = []
    orig = w.vc.start_recording
    w.vc.start_recording = lambda sink, after: (snap.append([m.embed is not None for m in w.vch.sent]), orig(sink, after))
    await started(w)
    assert snap == [[True]]                                   # exactly one notice already posted when capture began
    await w.mgr.stop("command")


async def test_opted_out_user_absent_from_buffers_segments_note(w, db):
    await db.execute("INSERT INTO voice_optouts(guild_id, user_id, source) VALUES(?1,?2,'command')", G, U2)
    s = await started(w)
    speak(w.vc.sink, U1, 30)
    speak(w.vc.sink, U2, 30)
    assert U2 not in s.buffers
    await s.tick()
    await spin()
    await w.mgr.stop("command")
    assert len(w.stt.calls) == 1                              # only U1's audio ever reached STT
    (t,) = note_text(w)
    assert str(U2) not in t and f"members:{U1}" in t


async def test_optout_mid_session_with_inflight_and_queued_chunk_s1212_02(w):
    gs = w.mgr._stt = GateStt()
    s = await started(w)
    speak(w.vc.sink, U2, 30); await s.tick()                  # chunk 1 -> in flight (blocked inside STT)
    await asyncio.wait_for(gs.entered.wait(), 2)
    speak(w.vc.sink, U2, 30); speak(w.vc.sink, U1, 30)
    await s.tick()                                            # chunk 2 (U2) and 3 (U1) queued
    assert len(s.pending) == 2
    await w.mgr.optout(G, U2, "button")
    assert [c.uid for c in s.pending] == [U1] and U2 not in s.buffers
    gs.gate.set()
    await spin(20)
    await w.mgr.stop("command")
    assert len(gs.calls) == 2                                 # chunk1 was already on the wire (cannot be recalled); chunk 2 never sent
    (t,) = note_text(w)
    assert str(U2) not in t and "members:" + str(U1) in t


async def test_optout_between_dequeue_and_request_is_rechecked(w):
    s = await started(w)

    async def hook():                                          # runs inside _process, after dequeue, before STT
        w.budget.on_level = None
        s.drop_user(U2)
    w.budget.on_level = hook
    speak(w.vc.sink, U2, 30)
    await s.tick(); await spin()
    assert w.stt.calls == [] and s.segments == []
    await w.mgr.stop("command")


async def test_consent_gap_present_refuses_reasks_ratelimited(w, tmp_path):
    open(tmp_path / "data" / "consent_gap", "w").close()
    for _ in range(3):
        assert await w.mgr.record_start(w.mem[U1]) == "consent_gap"
    assert w.vc.sink is None and w.mgr.session is None and len(w.vch.sent) == 1   # one re-ask in the window
    assert w.vch.sent[0].view is not None and w.vch.sent[0].mentions.users is not True
    w.clock.t += 601
    assert await w.mgr.record_start(w.mem[U1]) == "consent_gap" and len(w.vch.sent) == 2


async def test_consent_gap_unreadable_fails_closed(w, monkeypatch):
    real = os.lstat

    def lstat(p, *a, **k):
        if str(p).endswith("consent_gap"):
            raise PermissionError(13, "denied")
        return real(p, *a, **k)
    monkeypatch.setattr(os, "lstat", lstat)
    assert await w.mgr.record_start(w.mem[U1]) == "consent_gap" and w.vc.sink is None


async def test_failed_notice_post_means_no_capture(w):
    w.vch.fail_send = True
    assert await w.mgr.record_start(w.mem[U1]) == "notice_failed"
    await spin()
    assert w.vc.sink is None and not w.vc.recording and w.mgr.session.allowed == set()


async def test_late_joiner_full_text_mention_then_delay_then_captured(w):
    s = await started(w)
    gate, real = asyncio.Event(), w.mgr.sleep
    w.mgr.sleep = lambda sec: gate.wait() if sec != 1 else real(sec)
    late = Mem(U3, "late", w.vch); w.mem[U3] = late; w.vch.members.append(late)
    await w.mgr.on_voice_state(late, NS(channel=None), NS(channel=w.vch))
    speak(w.vc.sink, U3, 2)
    assert U3 not in s.buffers                                # before the delay: not captured
    m = w.vch.sent[-1]
    assert f"<@{U3}>" in m.content and "Gemini API" in m.content and "optout" in m.content
    assert [u.id for u in m.mentions.users] == [U3] and not m.mentions.everyone and not m.mentions.roles
    gate.set(); await asyncio.gather(*s.tasks)
    speak(w.vc.sink, U3, 2)
    assert U3 in s.buffers
    await w.mgr.stop("command")


async def test_late_joiner_post_failure_never_captured(w):
    s = await started(w)
    late = Mem(U3, "late", w.vch); w.mem[U3] = late; w.vch.members.append(late)
    w.vch.fail_send = True
    await w.mgr.on_voice_state(late, NS(channel=None), NS(channel=w.vch))
    await spin()
    speak(w.vc.sink, U3, 2)
    assert U3 not in s.buffers and U3 not in s.allowed
    await w.mgr.stop("command")


async def test_optedout_user_leaving_and_rejoining_is_not_readmitted(w):
    s = await started(w)
    await w.mgr.optout(G, U2, "command")
    await w.mgr.on_voice_state(w.mem[U2], NS(channel=w.vch), NS(channel=None))
    await w.mgr.on_voice_state(w.mem[U2], NS(channel=None), NS(channel=w.vch))
    await asyncio.gather(*s.tasks); await spin()
    speak(w.vc.sink, U2, 2)
    assert U2 not in s.buffers and U2 not in s.allowed
    await w.mgr.stop("command")
