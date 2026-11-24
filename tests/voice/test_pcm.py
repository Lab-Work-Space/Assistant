import array
import pytest
from core.voice.pcm import FRAME_BYTES, MonoPcmSource, to_stt_pcm


def frames(src):
    out = []
    while (f := src.read()):
        out.append(f)
    return out


@pytest.mark.parametrize("rate", [8000, 12000, 16000, 24000, 48000])
def test_frame_sizes(rate):
    step = 2 * 960 // (48000 // rate)
    fs = frames(MonoPcmSource(bytes(step * 3), rate))
    assert len(fs) == 3 and all(len(f) == FRAME_BYTES for f in fs)


def test_short_final_frame_padded():
    fs = frames(MonoPcmSource(bytes(960 * 2 + 10), 48000))
    assert len(fs) == 2 and all(len(f) == FRAME_BYTES for f in fs)


def test_upsample_duplicates_to_stereo():
    pcm = array.array("h", [1, 2] + [0] * 318).tobytes()  # 16 kHz: 320 samples/20 ms
    out = array.array("h")
    out.frombytes(MonoPcmSource(pcm, 16000).read())
    assert list(out[:12]) == [1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2]


def test_bad_rate():
    for r in (0, 44100, -1):
        with pytest.raises(ValueError, match="tts_format_unsupported"):
            MonoPcmSource(b"", r)


def test_to_stt_pcm_3840_to_640():
    assert len(to_stt_pcm(bytes(FRAME_BYTES))) == 640


def test_to_stt_pcm_picks_left_of_every_third_frame():
    a = array.array("h", [i for f in range(6) for i in (f + 1, -(f + 1))])  # 6 stereo frames
    out = array.array("h")
    out.frombytes(to_stt_pcm(a.tobytes()))
    assert list(out) == [1, 4]


def test_to_stt_pcm_ignores_trailing_partial_frame():
    assert len(to_stt_pcm(bytes(FRAME_BYTES + 3))) == 640
