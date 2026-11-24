"""System log forwarder (spec 12.14.4, Gate 1 S1214-02/03/05): WARNING+ records -> #bot-log via the System client.
offer() runs on the logging thread; the lock guards only deque/dict work and nothing logs or awaits under it."""
import asyncio
import json
import threading
import time
from collections import deque

import discord

from core.functions.logs.masking import mask_secrets

QUEUE_MAX, FLUSH_S, MSG_MAX, LINE_MAX, VALUE_MAX = 200, 5.0, 1900, 300, 64
DEDUP_S, FAIL_STOP, MAP_MAX, SEND_MAX = 60.0, 3, 1000, 2000
SKIP_EVENTS, SKIP_SYSTEMS = {"lib.log"}, {"logforward"}
# S1214-02: allowlist, extend only through spec edits
FORWARD_KEYS = {"error", "reason", "code", "status", "persona", "agent", "id", "run", "session", "user", "by", "count",
                "guild", "kind", "level", "size", "exc_type", "model", "provider", "task", "event", "on_deleted",
                "service", "tool"}


# Gate 2 G2S1214-01: json.loads restores escaped line breaks and bidi controls; fold each 1:1 so a value cannot forge a line
_FOLD = {ord(c): " " for c in "\n\r\v\f\x1c\x1d\x1e\x85  "} | {ord(c): "?" for c in "‎‏‪‫‬‭‮⁦⁧⁨⁩"}


def _clean(v) -> str:
    return str(v).translate(_FOLD)[:VALUE_MAX].replace("`", "'")


def format_line(level: str, line: str) -> tuple[tuple, str] | None:
    """Pure: (dedup key, text) for a rendered log line, or None when it must not be forwarded."""
    rec = json.loads(line)
    if not isinstance(rec, dict) or rec.get("event") in SKIP_EVENTS or rec.get("system") in SKIP_SYSTEMS:
        return None
    system, event = _clean(rec.get("system", "")), _clean(rec.get("event", ""))
    fields = rec.get("fields") if isinstance(rec.get("fields"), dict) else {}
    kv = [f"{k}={_clean(v)}" for k, v in fields.items()
          if k in FORWARD_KEYS and (v is None or isinstance(v, (str, int, float, bool)))]
    text = f"{str(rec.get('ts', ''))[11:19]}Z {level} {system} {event} {' '.join(kv)}".rstrip()
    if len(text) > LINE_MAX:
        text = text[:LINE_MAX - 1] + "…"
    return (level, system, event), text


class Forwarder:
    def __init__(self, log, clock=time.monotonic):
        self.log, self.clock, self.flush_s = log, clock, FLUSH_S
        self._lock = threading.Lock()
        self._q, self._last, self._supp, self._dropped = deque(), {}, {}, 0
        self._fails = 0
        self.on_stop = None  # called (no lock held) after FAIL_STOP consecutive Forbidden/NotFound

    def offer(self, level: str, line: str) -> None:
        try:
            got = format_line(level, line)  # json + filters before the lock (S1214-03)
        except Exception:
            return
        if got is None:
            return
        key, text = got
        now = self.clock()
        with self._lock:
            last = self._last.get(key)
            if last is not None and now - last < DEDUP_S:
                self._supp[key] = self._supp.get(key, 0) + 1
                return
            if len(self._last) > MAP_MAX or len(self._supp) > MAP_MAX:  # S1214-05
                self._last.clear()
                self._supp.clear()
            self._last[key] = now
            n = self._supp.pop(key, 0)
            if len(self._q) >= QUEUE_MAX:
                self._dropped += 1
            else:
                self._q.append(text + (f" (+{n})" if n else ""))

    def take(self) -> str | None:
        """Next message body, or None when nothing is queued. Masked again and capped (S1214-05)."""
        with self._lock:
            lines = [f"dropped={self._dropped}"] if self._dropped else []
            self._dropped = 0
            size = 12 + sum(len(x) + 1 for x in lines)  # 12 = code fence wrapper; the whole message stays <= MSG_MAX
            while self._q and size + len(self._q[0]) + 1 <= MSG_MAX:
                lines.append(self._q.popleft())
                size += len(lines[-1]) + 1
        if not lines:
            return None
        body = mask_secrets("```text\n" + "\n".join(lines) + "\n```")
        return body if len(body) <= SEND_MAX else body[:SEND_MAX - 4] + "\n```"

    def clear(self) -> None:
        with self._lock:
            self._q.clear()
            self._dropped = 0

    async def run(self, ch) -> None:
        while True:
            await asyncio.sleep(self.flush_s)
            body = self.take()
            if body is None:
                continue
            try:
                await ch.send(content=body, allowed_mentions=discord.AllowedMentions.none())
                self._fails = 0
            except asyncio.CancelledError:
                raise
            except Exception as e:  # the batch is discarded; the file log keeps it
                status = getattr(e, "status", None)
                self.log.write_log("logforward", "logforward.send_failed", "WARNING", status=status, error=type(e).__name__)
                if isinstance(e, (discord.Forbidden, discord.NotFound)):
                    self._fails += 1
                    if self._fails >= FAIL_STOP:
                        self.log.write_log("logforward", "logforward.stopped", "WARNING", count=self._fails)
                        if self.on_stop:
                            self.on_stop()
                        return
