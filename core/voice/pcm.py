import array
import sys

assert sys.byteorder == "little"  # array('h') is native-endian; Discord/Gemini PCM is s16le
FRAME_BYTES = 3840  # 20 ms of 48 kHz stereo s16le (discord.opus.Encoder.FRAME_SIZE)


def to_stt_pcm(pcm48s: bytes) -> bytes:
    """48 kHz stereo s16le -> 16 kHz mono s16le: left channel of every 3rd frame. C-speed slicing.
    shortcut: decimation without a low-pass filter; TASK-002 scores CER on exactly this output, upgrade to a 3-tap average if CER fails on aliasing."""
    a = array.array("h")
    a.frombytes(pcm48s[: len(pcm48s) - len(pcm48s) % 4])
    return a[0::6].tobytes()


class MonoPcmSource:
    """s16le mono at `rate` (48000 % rate == 0) -> 20 ms frames of 48 kHz stereo s16le, built per read() (no full-size copy).
    Subclass of discord.AudioSource in core/voice/tts.py; kept import-free here for tests."""

    def __init__(self, pcm: bytes, rate: int):
        if rate <= 0 or 48000 % rate:
            raise ValueError("tts_format_unsupported")
        self._k, self._pos, self._pcm = 48000 // rate, 0, pcm
        self._step = 2 * 960 // self._k  # input bytes per 20 ms

    def read(self) -> bytes:
        chunk = self._pcm[self._pos:self._pos + self._step]
        self._pos += self._step
        if not chunk:
            return b""
        a = array.array("h")
        a.frombytes(chunk.ljust(self._step, b"\x00"))  # pad the final partial frame
        n = 2 * self._k  # k time copies x 2 channels
        out = array.array("h", bytes(len(a) * n * 2))
        for i in range(n):
            out[i::n] = a
        return out.tobytes()

    def is_opus(self) -> bool:
        return False
