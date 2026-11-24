import asyncio
import os
from types import SimpleNamespace as NS

import discord

from core.discord.buttons import Router
from core.voice import notice
from core.voice.ext import make_button_handler
from core.voice.sink import ConsentSink
from tests.voice.vfakes import BOT, U1, U2, U3, Mem, speak, started
from tests.voice.test_session import idle, settle


async def test_opted_out_user_never_buffered(w, db):
    await db.execute("INSERT INTO voice_optouts(guild_id, user_id, source) VALUES(?1,?2,'command')", 111111111111111111, U2)
    s = await started(w)
    assert s.allowed == {U1}
    speak(w.vc.sink, U2, 2)
    assert U2 not in s.buffers
    await w.mgr.stop("command")


async def test_optout_mid_session_removes_buffer_queue_segments_and_inflight(w):
    s = await started(w)
    sink = w.vc.sink
    s.segments.append(__import__("core.voice.session", fromlist=["Segment"]).Segment(U2, "u2", 1, "old text"))
    speak(sink, U2, 3)
    speak(sink, U1, 3)
    from core.voice.session import Chunk
    s.pending.append(Chunk(U2, "u2", 0, b"x" * 64000, 99))
    await w.mgr.optout(111111111111111111, U2, "command")
    assert U2 not in s.allowed and U2 not in s.buffers and all(c.uid != U2 for c in s.pending)
    assert all(x.user_id != U2 for x in s.segments)
    # in-flight result discarded: opt-out lands while STT is running
    async def slow(pcm):
        await w.mgr.optout(111111111111111111, U1, "button")
        return "late text", 3
    w.stt.transcribe = slow
    w.clock.t += 5
    await s.tick()
    await settle(w, s)
    assert s.segments == []
    await w.mgr.stop("command")


async def test_s1212_02_queued_chunk_dropped_after_optout_and_recheck_before_request(w):
    s = await started(w)
    speak(w.vc.sink, U1, 30)
    await s.tick()          # chunk queued
    assert len(s.pending) == 1
    s.drop_user(U1)         # opt-out removes the queued chunk
    assert not s.pending
    from core.voice.session import Chunk
    s.enqueue(Chunk(U1, "u1", 0, b"x" * 64000, 7))  # a chunk that slipped in: _process re-checks `allowed`
    await settle(w, s)
    assert w.stt.calls == []
    # opt-out arrives during the budget check, right before the request
    s2 = s
    async def during_level():
        w.budget.on_level = None
        await w.mgr.optout(111111111111111111, U2, "command")
    s2.allowed.add(U2)
    w.budget.on_level = during_level
    s2.enqueue(Chunk(U2, "u2", 0, b"x" * 64000, 5))
    await settle(w, s2)
    assert w.stt.calls == []
    await w.mgr.stop("command")


async def test_late_joiner_captured_only_after_notice_and_delay(w, db):
    s = await started(w)
    late = Mem(U3, "late", w.vch)
    w.mem[U3] = late
    w.vch.members.append(late)
    gate = asyncio.Event()
    real = w.mgr.sleep

    async def slow(sec):
        if sec != 1:
            await gate.wait()
        else:
            await real(sec)
    w.mgr.sleep = slow
    await w.mgr.on_voice_state(late, NS(channel=None), NS(channel=w.vch))
    assert U3 not in s.allowed
    m = w.vch.sent[-1]
    assert f"<@{U3}>" in m.content and "Gemini API" in m.content and "/voice optout" in m.content   # S1212-05 full disclosure
    assert "discord.com/channels" in m.content and m.view is None
    assert m.mentions.users[0].id == U3 and len(m.mentions.users) == 1 and not m.mentions.everyone and not m.mentions.roles  # S1212-09
    assert await db.fetchval("SELECT count(*) FROM voice_notice_deliveries WHERE session_id=?1 AND user_id=?2", s.id, U3) == 1
    gate.set()
    await asyncio.gather(*s.tasks)
    assert U3 in s.allowed
    await w.mgr.stop("command")


async def test_late_joiner_failed_channel_post_never_captured(w):
    s = await started(w)
    late = Mem(U3, "late", w.vch)
    w.mem[U3] = late
    w.vch.members.append(late)
    w.vch.fail_send = True
    await w.mgr.on_voice_state(late, NS(channel=None), NS(channel=w.vch))
    assert U3 not in s.allowed and w.log.events("voice.notice_failed")
    await asyncio.sleep(0)
    assert U3 not in s.allowed
    await w.mgr.stop("command")


async def test_late_joiner_dm_only_via_dm_ok_and_rejoin_readds(w, db):
    s = await started(w)
    late = Mem(U3, "late", w.vch)
    w.mem[U3] = late
    w.vch.members.append(late)
    await w.mgr.on_voice_state(late, NS(channel=None), NS(channel=w.vch))
    assert w.dms == []  # coexist, not an approver: no DM
    w.app.gate.dm_ok = lambda uid: asyncio.sleep(0, result=True)
    other = Mem(U3 + 1, "o", w.vch)
    w.mem[U3 + 1] = other
    await w.mgr.on_voice_state(other, NS(channel=None), NS(channel=w.vch))
    assert len(w.dms) == 1
    # rejoin: leave then join again re-adds at once
    await asyncio.gather(*s.tasks)
    w.vch.members.remove(late)
    await w.mgr.on_voice_state(late, NS(channel=w.vch), NS(channel=None))
    assert U3 not in s.allowed
    w.vch.members.append(late)
    await w.mgr.on_voice_state(late, NS(channel=None), NS(channel=w.vch))
    assert U3 in s.allowed
    await w.mgr.stop("command")


async def test_notice_post_failure_means_capture_never_starts(w, db):
    w.vch.fail_send = True
    assert await w.mgr.record_start(w.mem[U1]) == "notice_failed"
    assert f"voice.notice_failed channel={w.vch.id}" in w.admin
    assert w.vc.sink is None and not w.vc.recording
    assert await db.fetchval("SELECT status FROM voice_sessions") == "failed"


async def test_consent_gap_refuses_and_posts_reask_with_binding_buttons(w, db, tmp_path):
    open(tmp_path / "data" / "consent_gap", "w").close()
    assert await w.mgr.record_start(w.mem[U1]) == "consent_gap"
    assert w.vc.sink is None and w.mgr.session is None
    assert f"voice.consent_gap channel={w.vch.id}" in w.admin
    m = w.vch.sent[0]
    assert "restore" in m.embed.description and m.view is not None
    row = await db.fetchrow("SELECT recording, status, notice_message_id, id FROM voice_sessions")
    assert (row["recording"], row["status"], row["notice_message_id"]) == (0, "done", m.id)
    # S1210-02 binding: the re-ask buttons bind to the stored message
    r = Router(w.log, db, lambda: BOT)
    cid = f"emp:rec:optout:{row['id']}"
    inter = NS(message=NS(id=m.id, author=NS(id=BOT)), client=NS(user=NS(id=BOT)))
    assert await r._bound(inter, "rec", row["id"])
    inter.message.id = m.id + 1
    assert not await r._bound(inter, "rec", row["id"])
    assert cid in [c.custom_id for c in m.view.children]
    # S1212-10: once per channel per 10 minutes
    assert await w.mgr.record_start(w.mem[U1]) == "consent_gap"
    assert len(w.vch.sent) == 1
    w.mgr.reask.clock = lambda: 10**9
    assert await w.mgr.record_start(w.mem[U1]) == "consent_gap"
    assert len(w.vch.sent) == 2


def test_s1212_01_helper_fails_closed(tmp_path, monkeypatch):
    db = str(tmp_path / "data" / "emp.db")
    os.makedirs(tmp_path / "data", exist_ok=True)
    assert notice.consent_gap_present(db) is False
    (tmp_path / "data" / "consent_gap").write_text("")
    assert notice.consent_gap_present(db) is True
    (tmp_path / "data" / "consent_gap").unlink()

    def deny(p):
        raise PermissionError("no")
    monkeypatch.setattr(os, "lstat", deny)
    assert notice.consent_gap_present(db) is True   # any other OSError: present


async def test_unreadable_consent_marker_refuses(w, monkeypatch):
    def deny(p):
        raise PermissionError("no")
    monkeypatch.setattr(os, "lstat", deny)
    assert await w.mgr.record_start(w.mem[U1]) == "consent_gap"
    assert w.vc.sink is None


async def test_button_handler_acts_only_on_clicker(w, db):
    s = await started(w)
    h = make_button_handler(w.app, w.mgr)
    sent = []
    inter = NS(guild_id=111111111111111111, user=NS(id=U2), followup=NS(send=lambda t, ephemeral: sent.append(t) or asyncio.sleep(0)))
    await h(inter, "optout", s.id)
    assert s.allowed == {U1} and "ok_optout" in sent[0]
    row = await db.fetchrow("SELECT user_id, source FROM voice_optouts")
    assert (row["user_id"], row["source"]) == (U2, "button")
    await h(inter, "optin", s.id)
    assert s.allowed == {U1, U2} and await db.fetchval("SELECT count(*) FROM voice_optouts") == 0
    inter.guild_id = 5
    await h(inter, "optout", s.id)
    assert await db.fetchval("SELECT count(*) FROM voice_optouts") == 0   # wrong guild ignored
    await w.mgr.stop("command")


async def test_optin_requires_delivery_row(w, db):
    s = await started(w)
    outsider = Mem(U3, "x", w.vch)
    w.vch.members.append(outsider)
    await w.mgr.optout(111111111111111111, U3, "command")
    await w.mgr.optin(111111111111111111, U3)
    assert U3 not in s.allowed  # never noticed in this session
    await w.mgr.stop("command")


# ---- S1212-07 sink caps --------------------------------------------------------------------------------
async def test_sink_per_user_and_total_caps(w):
    s = await started(w)
    sink = w.vc.sink
    speak(sink, U1, 60)  # exactly user_cap = 2 x chunk
    assert len(s.buffers[U1]) == s.user_cap
    speak(sink, U1, 1)   # over the cap: dropped, gap counted
    assert len(s.buffers[U1]) == s.user_cap and s.overflow[U1] == 1
    await s.tick()
    assert any("overflow" in x.text for x in s.segments)
    s.buffers.clear()
    s.total_cap = 100_000
    speak(sink, U1, 3)   # 96000 B
    speak(sink, U2, 1)   # total would exceed the session cap
    assert U2 not in s.buffers or not s.buffers[U2]
    await w.mgr.stop("command")


async def test_optout_db_error_still_drops_user(w, db, monkeypatch):
    # Gate 2 B2: the in-memory removal runs before the DB upsert (S1212-02)
    s = await started(w)

    async def boom(*a):
        raise RuntimeError("db down")
    monkeypatch.setattr(w.mgr.ctx.db, "execute", boom)
    try:
        await w.mgr.optout(111111111111111111, U2, "command")
    except RuntimeError:
        pass
    assert U2 not in s.allowed and U2 in s.optedout
    monkeypatch.undo()
    await w.mgr._late_join(s, w.mem[U2])  # rejoin after the failed DB write: still excluded
    assert U2 not in s.allowed
    await w.mgr.stop("command")
