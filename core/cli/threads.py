"""Terminal ThreadPort: a "thread" is a labelled section of the output plus an in-memory history."""
from core.cli.sink import CliReplySink, Out

MAIN_CHANNEL = 1001


class CliThreads:
    def __init__(self, out: Out):
        self.out, self._next, self.names, self.hist = out, 2001, {}, {}

    def sink_for(self, cid: int, persona):
        label = f"[{persona.id}] " if cid == MAIN_CHANNEL else f"[thread {cid} {persona.id}] "
        return CliReplySink(self.out, label, lambda text: self.hist.setdefault(cid, []).append((persona.name, text)))

    async def create_thread(self, channel_id: int, message_id: int, name: str) -> int:
        tid, self._next = self._next, self._next + 1
        self.names[tid] = name
        self.out.line(f"--- thread {tid}: {name} ---")
        return tid

    async def edit_embed(self, channel_id, message_id, embed) -> None:
        return None

    async def history(self, thread_id: int, limit: int) -> list[tuple[str, str]]:
        return self.hist.get(thread_id, [])[-limit:]
