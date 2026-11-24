"""In-memory only channel context (spec 3.1): never persisted, never logged."""
import time
from collections import deque


class ContextBuffer:
    def __init__(self, size: int, ttl_s: int, clock=time.monotonic):
        self.size, self.ttl, self.clock = size, ttl_s, clock
        self._d: dict[int, deque] = {}

    def push(self, channel_id: int, author_id, author_name: str, text: str) -> None:
        if len(self._d) > 500:  # bound memory: drop channels whose newest entry is expired
            now = self.clock()
            self._d = {k: v for k, v in self._d.items() if v and now - v[-1][0] <= self.ttl}
        self._d.setdefault(channel_id, deque(maxlen=self.size)).append((self.clock(), author_id, author_name, text[:500]))

    def read(self, channel_id: int) -> list[tuple[str, str]]:
        """(author_name, text) oldest first, expired entries dropped."""
        d = self._d.get(channel_id)
        if not d:
            return []
        now = self.clock()
        while d and now - d[0][0] > self.ttl:
            d.popleft()
        return [(n, t) for _, _, n, t in d]
