import types

import discord
import pytest

from core.discord.split import split_message
from core.discord.streaming import StreamWriter
from core.functions.logs import masking


def test_split_fence_and_limits():
    code = "```python\n" + "\n".join(f"x{i} = {i}" for i in range(600)) + "\n```\nafter"
    chunks = split_message(code)
    assert len(chunks) > 1 and all(len(c) <= 2000 for c in chunks)
    for c in chunks:  # every chunk has balanced fences
        assert sum(1 for ln in c.split("\n") if ln.startswith("```")) % 2 == 0
    assert chunks[1].startswith("```python\n") and chunks[0].endswith("\n```")


def test_split_prefix_stable_and_thai():
    text = ("สวัสดีครับ วันนี้อากาศดี " * 300) + "\n\n" + "ก็" * 1500
    full = split_message(text)
    assert all(len(c) <= 2000 for c in full)
    for n in range(0, len(text), 157):
        p = split_message(text[:n])
        assert p[:-1] == full[:len(p) - 1]
    assert not any(c[0] in "ั็่" for c in full)  # no chunk starts with a Thai mark


def test_split_short_and_hard_cut():
    assert split_message("hi") == ["hi"]
    assert all(len(c) <= 2000 for c in split_message("a" * 6000))


class Clock:
    t = 0.0

    def __call__(self):
        return self.t


def make(**kw):
    log = {"sent": [], "edits": [], "deleted": []}

    async def send(c):
        log["sent"].append(c)
        return types.SimpleNamespace(id=len(log["sent"]))

    async def edit(m, c):
        if kw.get("err"):
            raise kw["err"]
        log["edits"].append((m.id, c))

    async def delete(m):
        log["deleted"].append(m.id)
    clk = Clock()
    w = StreamWriter(send, edit, delete, interval=1.0, max_messages=kw.get("max", 6), clock=clk)
    return w, log, clk


async def test_edits_progressively_at_interval():
    w, log, clk = make()
    w.adopt(types.SimpleNamespace(id=1), "...")
    await w.write("a ")
    await w.write("b ")           # inside the interval: coalesced
    assert log["edits"] == [(1, "a ")]
    clk.t = 1.1
    await w.write("c ")
    assert log["edits"][-1] == (1, "a b c ")
    await w.write("tail")         # unfinished word is withheld until finish
    clk.t = 3
    await w.write("")
    assert log["edits"][-1] == (1, "a b c ")
    await w.finish()
    assert log["edits"][-1] == (1, "a b c tail") and log["deleted"] == []


async def test_masks_secret_split_across_deltas():
    masking.set_exact(["supersecret-token-123"])
    w, log, clk = make()
    await w.write("x supersecret-")
    clk.t = 5
    await w.write("token-123 y")
    await w.finish()
    assert all("supersecret" not in c for c in log["sent"] + [e[1] for e in log["edits"]])


async def test_empty_deletes_placeholder_and_429_backoff():
    w, log, clk = make()
    w.adopt(types.SimpleNamespace(id=1), "...")
    assert await w.finish() == [] and log["deleted"] == [1]
    resp = types.SimpleNamespace(status=429, reason="x")
    w, log, clk = make(err=discord.HTTPException(resp, "slow"))
    w.adopt(types.SimpleNamespace(id=1), "...")
    await w.write("a ")
    assert w.interval == 2.0
    clk.t = 100
    await w.write("b ")
    assert w.interval == 4.0


async def test_truncates_past_max_messages():
    w, log, clk = make(max=2)
    await w.write("word " * 2000)
    assert w.stopped and len(log["sent"]) == 2 and log["sent"][-1].endswith("[output truncated]")


async def test_deleted_message_stops_stream_no_repost():
    gone = []
    resp = types.SimpleNamespace(status=404, reason="x")
    w, log, clk = make(err=discord.NotFound(resp, "gone"))
    w.on_deleted = lambda: gone.append(1)
    w.adopt(types.SimpleNamespace(id=1), "...")
    await w.write("a ")
    clk.t = 10
    await w.write("b ")
    await w.finish()
    assert log["sent"] == [] and w.stopped and gone == [1]   # moderator delete is respected: nothing re-posted
