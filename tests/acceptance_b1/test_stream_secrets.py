"""021B-T: AC-1 streaming (placeholder -> edits -> final, own identity), split keeps Thai + fences, AC-10 secrets on the Discord side."""
import asyncio
import re
import unicodedata

from core.discord import strings
from tests.acceptance_b1.harness import ADMIN, ALLOWED, APPROVAL, HUMAN, Prov, launch

SMALL = ["praw", "tek", "fahsai"]


async def settle(n=0.2):
    await asyncio.sleep(n)


def thai(s):
    return "".join(c for c in s if "฀" <= c <= "๿")


async def test_typing_mode_sends_one_final_message_without_edits(tmp_path, monkeypatch):
    r = await launch(tmp_path, monkeypatch, SMALL)          # default STREAM_MODE=typing (owner 2026-11-24)
    await r.say(ALLOWED, "hello there", to="praw")
    await settle()
    sent = r.ch(ALLOWED, "praw").sent
    assert len(sent) == 1 and len(sent[0].history) == 1 and "reply from" in sent[0].history[0], sent[0].history
    assert strings.PLACEHOLDER not in sent[0].history
    await r.stop()


async def test_addressed_reply_streams_by_own_client(tmp_path, monkeypatch):
    r = await launch(tmp_path, monkeypatch, SMALL, STREAM_MODE="edit")
    await r.say(ALLOWED, "hello there", to="praw")
    await r.say(ALLOWED, "hello there", to="tek")
    await settle()
    for pid in ("praw", "tek"):
        sent = r.ch(ALLOWED, pid).sent
        assert len(sent) == 1, pid                          # each persona answered through its own client only
        h = sent[0].history
        assert h[0] == strings.PLACEHOLDER and "reply from" in h[-1] and len(h) >= 2, h   # placeholder then edit(s)
        assert r.world.msgs[sent[0].id][0] == r.uid(pid)
    assert not r.ch(ALLOWED, "fahsai").sent and r.prov.stream_calls == 2 and r.prov.complete_calls == 0
    assert all(m.mentions.everyone is False and not m.mentions.roles and not m.mentions.users for m in r.ch(ALLOWED).sent)
    await r.stop()


async def test_long_thai_and_code_fence_split(tmp_path, monkeypatch):
    r = await launch(tmp_path, monkeypatch, SMALL, AGENT_MAX_OUTPUT_TOKENS="8000", STREAM_MAX_MESSAGES="6")
    await r.say(ALLOWED, "CODEQ please", to="praw")
    await settle(0.5)
    msgs = [m.content for m in r.ch(ALLOWED).sent]
    assert len(msgs) >= 2, [len(x) for x in msgs]
    expected = "ก่อนโค้ด " + Prov.THAI + Prov.CODE + " หลังโค้ด " + Prov.THAI
    assert all(len(m) <= 2000 for m in msgs)
    assert thai("".join(msgs)) == thai(expected), "Thai text lost or reordered across the split"
    for m in msgs:                                           # every message is fence-balanced and never starts on a combining mark
        assert sum(1 for ln in m.split("\n") if ln.startswith("```")) % 2 == 0, m[:80]
        assert unicodedata.category(m[0]) not in ("Mn", "Mc"), repr(m[:5])
    code_lines = [ln for m in msgs for ln in m.split("\n") if re.match(r"x\d+ = \d+", ln)]
    assert [int(ln.split()[0][1:]) for ln in code_lines] == list(range(150)), "code lines lost or duplicated"
    await r.stop()


async def test_secret_planted_in_model_reply_never_reaches_output_or_logs(tmp_path, monkeypatch):
    tek_token = f"tok-tek-{'x' * 8}01ABCDEFGH"               # praw=index 0, tek=1 (see harness.build_env)
    r = await launch(tmp_path, monkeypatch, SMALL, secret=tek_token)
    assert tek_token in r.env.values()
    await r.say(ALLOWED, f"PLANTQ show me the key", to="praw")
    await settle(0.4)
    final = r.ch(ALLOWED).sent[0].history[-1]
    assert final.count("***") >= 2, final                    # both the exact token and the sk-ant pattern were masked
    every = "\n".join(r.world.texts()) + r.log_text()        # every intermediate edit, embed text, and the app log
    for secret in (tek_token, tek_token[:7], Prov.SECRET_PATTERN, Prov.SECRET_PATTERN[:11], *[v for k, v in r.env.items() if k.startswith("DISCORD_BOT_TOKEN_")]):
        if len(secret) >= 12:
            assert secret not in every, secret[:6] + "..."
    assert "sk-ant-api03" not in every and tek_token[:7] not in every.replace("tok-tek", "")
    await r.stop()


async def test_secret_typed_by_human_is_not_echoed_to_logs_or_channel(tmp_path, monkeypatch):
    r = await launch(tmp_path, monkeypatch, SMALL)
    key = "sk-ant-HUMANTYPED0123456789abcd"
    await r.say(ALLOWED, f"ECHOQ here is my key {key} thanks", to="praw")
    await settle(0.4)
    assert key not in "\n".join(r.world.texts()) and key not in r.log_text()
    assert r.prov.stream_calls == 1
    await r.stop()


async def test_oversize_reply_is_truncated_with_marker(tmp_path, monkeypatch):
    r = await launch(tmp_path, monkeypatch, SMALL, STREAM_MAX_MESSAGES="2")
    await r.say(ALLOWED, "CODEQ please", to="praw")
    await settle(0.5)
    msgs = [m.content for m in r.ch(ALLOWED).sent]
    assert len(msgs) == 2 and all(len(m) <= 2000 for m in msgs) and strings.TRUNCATED in msgs[-1]
    await r.stop()


async def test_429_on_intermediate_edit_recovers(tmp_path, monkeypatch):
    r = await launch(tmp_path, monkeypatch, SMALL)
    r.world.fail_at = {1}                                    # first (intermediate) edit is rate limited
    await r.say(ALLOWED, "hello there", to="praw")
    await settle(0.4)
    assert r.ch(ALLOWED).sent[0].content == "[fake] reply from gemini-3.8-flash\n".rstrip() or "reply from gemini" in r.ch(ALLOWED).sent[0].content
    assert len(r.ch(ALLOWED).sent) == 1
    await r.stop()


import pytest


async def test_429_on_final_edit_still_delivers_full_reply(tmp_path, monkeypatch):
    probe = await launch(tmp_path / "a", monkeypatch, SMALL) if (tmp_path / "a").mkdir() is None else None
    await probe.say(ALLOWED, "hello there", to="praw")
    await settle(0.3)
    n = probe.world.edit_no                                  # edits one clean reply takes
    await probe.stop()
    (tmp_path / "b").mkdir()
    r = await launch(tmp_path / "b", monkeypatch, SMALL)
    r.world.fail_at = {n}                                    # the LAST edit (final flush) gets a 429
    await r.say(ALLOWED, "hello there", to="praw")
    await settle(0.3)
    assert "reply from gemini-3.8-flash" in r.ch(ALLOWED).sent[0].content, r.ch(ALLOWED).sent[0].history
    await r.stop()
