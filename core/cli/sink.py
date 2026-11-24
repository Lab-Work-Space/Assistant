"""CliReplySink / CliSinkFactory (spec 10.15, G1-09). Output: strip control chars, then mask, then print."""
import os
import re
import sys
import tempfile

from core.functions.logs.masking import mask_secrets
from core.interfaces import Persona, TargetError

_CTRL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")
_NAME = re.compile(r"^[A-Za-z0-9._-]{1,100}$")


def clean(s: str) -> str:
    return mask_secrets(_CTRL.sub("", s))  # strip first so a secret cannot hide behind control chars


class Out:
    """Single output channel; keeps a capture buffer for /expect."""

    def __init__(self, stream=None):
        self.stream, self.buf, self._ids, self._dir = stream, [], 0, None

    def line(self, s: str, capture: bool = True) -> None:
        s = clean(s)
        if capture:  # script echo must not be matchable by its own /expect
            self.buf.append(s + "\n")
        print(s, file=self.stream or sys.stdout, flush=True)

    def next_id(self) -> int:
        self._ids += 1
        return 9000 + self._ids

    def tmp_dir(self) -> str:
        if self._dir is None:
            self._dir = tempfile.mkdtemp(prefix="emp-cli-")  # 0700
        return self._dir

    def take(self) -> str:
        s, self.buf = "".join(self.buf), []
        return s


class NullSink:
    async def start(self): pass
    async def write(self, delta): pass
    async def finish(self): return []
    async def fail(self, user_text): pass
    async def send_embed(self, embed, view=None): return 0
    async def send_file(self, filename, data, content=""): return 0


class CliReplySink:
    def __init__(self, out: Out, label: str, record=None):
        self.out, self.label, self.record, self._buf, self._all = out, label, record, "", []

    def _flush(self, rest: bool) -> None:
        if rest:
            text, self._buf = self._buf, ""
            if not text:
                return
        else:  # print complete lines only, so a secret split across deltas is masked whole
            text, nl, tail = self._buf.rpartition("\n")
            if not nl:
                return
            self._buf = tail
        for ln in text.split("\n"):
            self.out.line(f"{self.label}{ln}")

    async def start(self): pass
    async def write(self, delta): pass
    async def finish(self): return []
    async def fail(self, user_text): pass
    async def send_embed(self, embed, view=None): return 0
    async def send_file(self, filename, data, content=""): return 0


class CliReplySink:
    def __init__(self, out: Out, label: str, record=None):
        self.out, self.label, self.record, self._buf, self._all = out, label, record, "", []

    def _flush(self, rest: bool) -> None:
        head, nl, tail = self._buf.rpartition("\n")
        text, self._buf = (self._buf, "") if rest else (head, tail)
        if (text if rest else nl) and text:
            for ln in text.split("\n"):
                self.out.line(f"{self.label}{ln}")

    async def start(self) -> None:
        self._buf = ""

    async def write(self, delta: str) -> None:
        self._buf += delta
        self._all.append(delta)
        self._flush(False)

    async def finish(self) -> list[int]:
        self._flush(True)
        had = bool(self._all)
        if self.record and had:
            self.record("".join(self._all))
        self._all = []
        return [self.out.next_id()] if had else []

    async def fail(self, user_text: str) -> None:
        self._flush(True)
        self.out.line(f"{self.label}[error] {user_text}")

    async def send_embed(self, embed, view=None) -> int:
        self._flush(True)
        parts = [embed.title or "", embed.description or "", *(f"{f.name}: {f.value}" for f in embed.fields)]
        for p in parts:
            for ln in str(p).split("\n") if p else []:
                self.out.line(f"{self.label}[embed] {ln}")
        return self.out.next_id()

    async def send_file(self, filename: str, data: bytes, content: str = "") -> int:
        mid = self.out.next_id()
        name = os.path.basename(filename)
        name = name if _NAME.fullmatch(name) else f"file-{mid}.bin"
        path = os.path.join(self.out.tmp_dir(), name)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)  # FileExistsError surfaces
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        if content:
            self.out.line(f"{self.label}{content}")
        self.out.line(f"{self.label}[file] {path}")
        return mid


class CliSinkFactory:
    def __init__(self, out: Out, threads=None):
        self.out, self.threads = out, threads

    def for_channel(self, channel, persona: Persona) -> CliReplySink:
        if self.threads is not None and isinstance(channel, int):
            return self.threads.sink_for(channel, persona)
        return CliReplySink(self.out, f"[{persona.id}] ")

    def for_dm(self, user, persona: Persona) -> CliReplySink:
        return CliReplySink(self.out, f"[{persona.id}] ")

    def null(self) -> NullSink:
        return NullSink()

    async def for_target(self, kind, target_id: int, persona: Persona, ctx):
        if kind != "thread":
            raise TargetError("dm_unavailable")
        return self.for_channel(target_id, persona)
