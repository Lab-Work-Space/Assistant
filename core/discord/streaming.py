"""StreamWriter (spec 3.3, 10.13): progressive edits at most every `interval` s, one edit at a time, 429 backoff."""
import asyncio
import time

import discord

from core.discord import strings
from core.discord.split import split_message
from core.functions.logs.masking import mask_secrets

MAX_INTERVAL_S, RESET_AFTER_OK, HOLD_BACK = 5.0, 10, 100
FINAL_ATTEMPTS, FINAL_BUDGET_S = 3, 10.0


class StreamWriter:
    """send(content) -> msg, edit(msg, content), delete(msg). Masks the full accumulated text on every flush,
    so a secret split across deltas never reaches Discord."""

    def __init__(self, send, edit, delete, *, interval: float, max_messages: int, prefix: str = "",
                 mask=mask_secrets, clock=time.monotonic, on_error=None, on_deleted=None, live: bool = True):
        self.live = live  # False: buffer everything, send once on finish (owner: typing indicator instead of edits)
        self.send, self.edit, self.delete = send, edit, delete
        self.base = self.interval = interval
        self.max, self.prefix, self.mask, self.clock, self.on_error = max_messages, prefix, mask, clock, on_error
        self.on_deleted, self.deleted = on_deleted, False
        self.text, self.msgs, self.sent = "", [], []
        self.last, self.ok, self.stopped = float("-inf"), 0, False
        self._lock = asyncio.Lock()
        self.failed, self.chunks = None, []

    def adopt(self, msg, content: str) -> None:
        self.msgs.append(msg)
        self.sent.append(content)

    async def write(self, delta: str) -> None:
        if self.stopped:
            return
        self.text += delta
        if self.live and self.clock() - self.last >= self.interval:
            await self.flush()

    async def flush(self, final: bool = False) -> None:
        async with self._lock:  # one edit in flight; text that arrived meanwhile is picked up by this pass
            if self.deleted:
                return
            self.last = self.clock()
            text = self.text
            if not final:  # withhold an unfinished trailing word: a secret cut mid-token is not yet maskable
                tail = len(text) - max(text.rfind(" "), text.rfind("\n")) - 1
                text = text[:len(text) - min(tail, HOLD_BACK)]
            if not text.strip():
                return
            chunks = self.chunks = split_message(self.mask(self.prefix + text))
            self.failed = None
            if len(chunks) > self.max:
                chunks = chunks[:self.max]
                cut = 2000 - len(strings.TRUNCATED) - 1
                chunks[-1] = chunks[-1][:cut] + "\n" + strings.TRUNCATED
                self.stopped = True
            for i, c in enumerate(chunks):
                if i < len(self.msgs) and self.sent[i] == c:
                    continue
                try:
                    await self._put(i, c)
                except discord.HTTPException as e:
                    if e.status == 429:
                        self.interval, self.ok = min(self.interval * 2, MAX_INTERVAL_S), 0
                    self.failed = e
                    if self.on_error:
                        self.on_error(e)
                    return  # retry on the next flush

    async def _put(self, i: int, c: str) -> None:
        if i >= len(self.msgs):
            self.adopt(await self.send(c), c)
            return
        try:
            await self.edit(self.msgs[i], c)
        except discord.NotFound:  # G2B1-02: a moderator deleted it; respect that, stop this run's stream
            self.stopped = self.deleted = True
            if self.on_deleted:
                self.on_deleted()
            return
        self.sent[i] = c
        self.ok += 1
        if self.ok >= RESET_AFTER_OK:
            self.interval, self.ok = self.base, 0

    async def finish(self) -> list[int]:
        end = self.clock() + FINAL_BUDGET_S
        for attempt in range(FINAL_ATTEMPTS):
            await self.flush(final=True)
            if self.failed is None or self.deleted:
                break
            if attempt < FINAL_ATTEMPTS - 1:  # honour retry_after (default 0.2 s), bounded by the total budget
                await asyncio.sleep(max(0.0, min(getattr(self.failed, "retry_after", None) or 0.2, end - self.clock())))
        if self.failed is not None and not self.deleted:  # never leave a partial final text: post what is not shown yet
            for i, c in enumerate(self.chunks):
                if i >= len(self.sent) or self.sent[i] != c:
                    try:
                        self.adopt(await self.send(c), c)
                    except discord.HTTPException as e:
                        if self.on_error:
                            self.on_error(e)
                        break
        if not self.text.strip():
            for m in self.msgs:
                try:
                    await self.delete(m)
                except discord.HTTPException:
                    pass
            self.msgs, self.sent = [], []
        return [m.id for m in self.msgs]
