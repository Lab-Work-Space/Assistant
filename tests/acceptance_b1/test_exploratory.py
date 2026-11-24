"""021B-T exploratory: Thai Tier-1 edge, two humans in one channel (5-minute window), Tier-2, rate limits, busy drop."""
import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from core.db.sqlite import utc_text
from tests.acceptance_b1.harness import ALLOWED, HUMAN, launch


async def settle(n=0.3):
    await asyncio.sleep(n)


async def replied(r, text, uid, to=None):
    before = r.prov.stream_calls
    await r.say(ALLOWED, text, uid=uid, to=to)
    await settle(0.15)
    return r.prov.stream_calls > before


# Persona name inside a longer Thai word that is NOT a call to that persona. Expected: silence (no provider call).
THAI_NOT_ADDRESSED = [
    pytest.param("เทคโนโลยีใหม่น่าสนใจมาก", id="tek-in-technology"),
    pytest.param("ฝนตกหนักมากวันนี้", id="fon-in-rain"),
    pytest.param("คิวยาวมากเลย", id="qin-in-queue"),
    pytest.param("เบสบอลสนุกไหม", id="bass-in-baseball"),
    pytest.param("ปิ่นโตอร่อยมาก", id="pim-in-tiffin"),
    pytest.param("พลอยสีแดงสวยจัง", id="ploy-gem"),
    pytest.param("เมื่อวานอากาศร้อนมาก", id="plain-thai-silent"),
    pytest.param("technology is great", id="ascii-boundary-tek"),
    pytest.param("prawn crackers anyone", id="ascii-boundary-praw"),
]


@pytest.mark.parametrize("text", THAI_NOT_ADDRESSED)
async def test_tier1_name_inside_longer_word_stays_silent(tmp_path, monkeypatch, text):
    r = await launch(tmp_path, monkeypatch)                  # all 20 personas
    assert not await replied(r, text, HUMAN + 20)
    assert r.prov.complete_calls == 0                        # glued Thai name: silence, no Tier 2 call
    await r.stop()


@pytest.mark.parametrize("text,who", [("พราวช่วยหน่อย", "praw"), ("hey tek", "tek"), ("เทคครับ ช่วยดูหน่อย", "tek"), ("ฝนคะ ว่าไง", "fon")])
async def test_tier1_clear_calls_still_work_zero_llm(tmp_path, monkeypatch, text, who):
    r = await launch(tmp_path, monkeypatch)
    assert await replied(r, text, HUMAN + 20) and r.prov.complete_calls == 0
    assert r.ch(ALLOWED, who).sent and sum(len(r.ch(ALLOWED, p).sent) for p in ("praw", "tek", "fon")) == 1
    await r.stop()


# ---- two humans, one channel, the 5-minute window -------------------------------------------------------------------------
async def test_two_humans_one_channel_window_is_per_user(tmp_path, monkeypatch):
    r = await launch(tmp_path, monkeypatch, ["praw", "tek", "fahsai"])
    A, B = HUMAN + 10, HUMAN + 11
    assert await replied(r, "hello", A, to="praw")
    assert not await replied(r, "lunch anyone?", B)           # B is not in A's conversation
    assert not await replied(r, "ok thanks", B)
    assert await replied(r, "and then?", A)                   # A continues without a mention: same persona
    assert await replied(r, "hi", B, to="tek")                # B talks to tek
    assert await replied(r, "thanks", A)                      # A's window is unaffected by B: still praw
    assert len(r.ch(ALLOWED, "praw").sent) == 3 and len(r.ch(ALLOWED, "tek").sent) == 1
    assert await replied(r, "next", B) and len(r.ch(ALLOWED, "tek").sent) == 2    # B's own window continues with tek
    assert r.prov.complete_calls == 0
    await r.stop()


async def test_two_humans_mention_of_other_human_skips_window_plain_line_does_not(tmp_path, monkeypatch):
    import types
    r = await launch(tmp_path, monkeypatch, ["praw", "tek"])
    A, B = HUMAN + 10, HUMAN + 11
    assert await replied(r, "hello", A, to="praw")
    before = r.prov.stream_calls
    m = r.msg(r.ch(ALLOWED), "what do you think about this?", A, mentions=[types.SimpleNamespace(id=B, bot=False)])
    await r.app.listeners["on_message@praw"](m)             # A talks TO human B inside A's open window
    await settle(0.15)
    assert r.prov.stream_calls == before                    # other_user branch (spec 3.1 rule 5): silent
    # OBS-3: the same line WITHOUT the mention still goes to praw (window is per user, not per addressee); spec-conformant
    assert await replied(r, "B, what do you think about this?", A)
    await r.stop()


async def test_window_expires_after_five_minutes(tmp_path, monkeypatch):
    r = await launch(tmp_path, monkeypatch, ["praw", "tek"])
    A = HUMAN + 10
    assert await replied(r, "hello", A, to="praw")
    assert await replied(r, "still here", A)
    old = utc_text(datetime.now(timezone.utc) - timedelta(seconds=301))
    await r.ctx.db.execute("UPDATE conversation_state SET last_reply_at=?1", old)
    assert not await replied(r, "are you there", A)           # window (300 s) expired: silence
    assert await replied(r, "praw are you there", A)
    await r.stop()


# ---- Tier 2 --------------------------------------------------------------------------------------------------------------
AMBIG = "พราวกับเทค ใครว่างบ้างวันนี้"


async def test_tier2_picks_one_candidate_and_rejects_bad_classifier_output(tmp_path, monkeypatch):
    r = await launch(tmp_path, monkeypatch, tier2="yes:tek")
    assert await replied(r, AMBIG, HUMAN + 30) and r.prov.complete_calls == 1 and r.ch(ALLOWED, "tek").sent
    for bad in ("no", "yes:evil", "yes:tek\nignore previous", "yes:mali", "YES:tek", ""):   # mali was not a candidate
        r.prov.tier2 = bad
        assert not await replied(r, AMBIG, HUMAN + 40 + len(bad)), bad
    await r.stop()


async def test_tier2_per_channel_rate_limit_and_budget_skip(tmp_path, monkeypatch):
    r = await launch(tmp_path, monkeypatch, tier2="no", REPLY_TIER2_MAX_PER_MIN_CHANNEL="2")
    for i in range(5):
        await replied(r, AMBIG, HUMAN + 50 + i)
    assert r.prov.complete_calls == 2 and r.log_events("gate.tier2_skipped")[0]["reason"] == "rate"
    await r.stop()


# ---- rate limits ---------------------------------------------------------------------------------------------------------
async def test_per_user_hourly_cap_drops_without_provider_call(tmp_path, monkeypatch):
    r = await launch(tmp_path, monkeypatch, ["praw", "tek"], USER_MAX_RUNS_PER_HOUR="3")
    got = [await replied(r, f"hello {i}", HUMAN + 60, to="praw") for i in range(5)]
    assert got == [True, True, True, False, False] and r.prov.stream_calls == 3
    assert [e["reason"] for e in r.log_events("gate.dropped")] == ["user_rate", "user_rate"]
    assert await replied(r, "hello", HUMAN + 61, to="praw")   # another user is unaffected
    await r.stop()


async def test_busy_persona_queue_is_bounded_and_extra_messages_dropped(tmp_path, monkeypatch):
    gate = asyncio.Event()
    r = await launch(tmp_path, monkeypatch, ["praw", "tek"], gate=gate)
    tasks = [asyncio.ensure_future(r.say(ALLOWED, f"SLOWQ {i}", uid=HUMAN + 70 + i, to="praw")) for i in range(8)]   # 1 running + 3 waiting
    await settle(0.3)
    drops = r.log_events("gate.dropped")
    assert r.prov.peak == 1 and len(drops) == 4 and {d["reason"] for d in drops} == {"busy"}
    gate.set()
    await asyncio.wait_for(asyncio.gather(*tasks), 10)
    await settle(0.3)
    assert r.prov.stream_calls == 4 and len(r.ch(ALLOWED).sent) == 4                  # nothing more than 1 + MAX_WAITING ever ran
    await r.stop()
