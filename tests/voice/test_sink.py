import threading
from types import SimpleNamespace as NS
from core.voice.pcm import FRAME_BYTES
from core.voice.sink import ConsentSink


class Guild:
    def __init__(self, members): self.members = set(members)
    def get_member(self, uid): return NS(id=uid) if uid in self.members else None


def session(allowed, members):
    return NS(lock=threading.Lock(), allowed=set(allowed), guild=Guild(members),
              buffers={}, first_ts={}, last_ts={}, clock=lambda: 7.0)


def data(n=1):
    return NS(pcm=bytes(FRAME_BYTES * n))


def test_contract():
    s = ConsentSink(session([], []))
    assert s.is_opus() is False and s.walk_children() == [] and s.walk_children(True) == [s]
    assert s.__sink_listeners__ == ()


def test_allowed_member_buffered_16k_mono():
    ss = session({1}, {1}); sink = ConsentSink(ss)
    sink.write(data(), NS(id=1)); sink.write(data(), NS(id=1))
    assert len(ss.buffers[1]) == 1280 and ss.first_ts[1] == ss.last_ts[1] == 7.0


def test_never_buffered():
    ss = session({1}, {1, 2}); sink = ConsentSink(ss)
    sink.write(data(), NS(id=2))      # opted-out / not in allowed
    ss.allowed.add(3)
    sink.write(data(), NS(id=3))      # allowed but not a guild member
    sink.write(data(), None)          # unknown speaker
    sink.write(data(), NS(id=None))
    sink.write(NS(pcm=b""), NS(id=1))  # empty frame
    assert ss.buffers == {}


def test_thread_safety():
    ss = session({1, 2}, {1, 2}); sink = ConsentSink(ss)
    def run(uid):
        for _ in range(200): sink.write(data(), NS(id=uid))
    ts = [threading.Thread(target=run, args=(u,)) for u in (1, 2, 1, 2)]
    [t.start() for t in ts]; [t.join() for t in ts]
    assert len(ss.buffers[1]) == len(ss.buffers[2]) == 400 * 640


def test_lock_held_during_write():
    ss = session({1}, {1}); sink = ConsentSink(ss)
    done = threading.Event()
    with ss.lock:
        t = threading.Thread(target=lambda: (sink.write(data(), NS(id=1)), done.set()))
        t.start()
        assert not done.wait(0.2) and ss.buffers == {}
    t.join(2)
    assert len(ss.buffers[1]) == 640


def test_cleanup():
    s = ConsentSink(session([], [])); s.cleanup(); assert s.finished
