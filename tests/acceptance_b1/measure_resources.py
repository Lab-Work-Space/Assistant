"""RSS / thread-count measurement for N fake persona clients in ONE process (S1210-09: MemoryMax=1G, TasksMax=100).
Run: .venv/bin/python -m tests.acceptance_b1.measure_resources [N=20] [MESSAGES=400]
Method and limits: see docs/test-reports/phase1-sliceB1.md section 6. Prints one JSON object."""
import asyncio
import collections
import json
import os
import resource
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

import pytest

from tests.acceptance_b1.harness import ALLOWED, CAT, HUMAN, PERSONA_IDS, launch


def rss_mb() -> float:
    return int(subprocess.check_output(["ps", "-o", "rss=", "-p", str(os.getpid())]).split()[0]) / 1024


def peak_mb() -> float:
    v = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return v / (1024 * 1024) if sys.platform == "darwin" else v / 1024      # macOS reports bytes, Linux KiB


def snap(tag, out):
    out[tag] = {"rss_mb": round(rss_mb(), 1), "threads": threading.active_count(), "peak_rss_mb": round(peak_mb(), 1)}


async def main(n: int, messages: int) -> dict:
    out = {"python": sys.version.split()[0], "platform": sys.platform, "clients": n, "messages": messages}
    snap("0_baseline_imported", out)
    tmp = Path(tempfile.mkdtemp(prefix="b1-res-"))
    mp = pytest.MonkeyPatch()
    max_threads = [0]
    names = collections.Counter()

    async def sampler():
        while True:
            c = threading.active_count()
            if c > max_threads[0]:
                max_threads[0], snapshot = c, collections.Counter(t.name.split("_")[0] for t in threading.enumerate())
                names.clear(); names.update(snapshot)
            await asyncio.sleep(0.01)
    s = asyncio.ensure_future(sampler())
    personas = PERSONA_IDS[:n]
    r = await launch(tmp, mp, personas)
    assert r.app is not None and r.app.ready.is_set() and len(r.app.bots) == n, (r.app and len(r.app.bots))
    snap("1_after_start_N_clients", out)
    ch = [ALLOWED, CAT + 1]                                   # ALLOWED plus nothing else allowlisted as a message channel
    for i in range(0, messages, n):                           # n concurrent addressed messages (one per persona) per wave
        await asyncio.gather(*(r.say(ALLOWED, f"hello {i + j}", uid=HUMAN + 1000 + (i + j), to=personas[j % len(personas)]) for j in range(min(n, messages - i))))
    snap("2_after_messages", out)
    out["replies_posted"] = sum(len(r.ch(ALLOWED, p).sent) for p in personas)
    out["provider_stream_calls"] = r.prov.stream_calls
    await asyncio.sleep(0.2)
    s.cancel()
    out["thread_max_during_run"], out["thread_names_at_max"] = max_threads[0], dict(names)
    await r.stop()
    snap("3_after_stop", out)
    mp.undo()
    # real py-cord objects (no login, no gateway): what the library itself holds per client
    from core.config import Config
    from core.discord.client import make_bot
    cfg = Config.load(r.env)
    before = rss_mb()
    bots = [make_bot(cfg, i == 0) for i in range(n)]
    out["real_discord_bot_objects"] = {"count": n, "rss_delta_mb": round(rss_mb() - before, 1), "threads": threading.active_count()}
    del bots
    out["limits"] = {"MemoryMax_mb": 1024, "TasksMax": 100}
    return out


if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 20
    m = int(sys.argv[2]) if len(sys.argv) > 2 else 400
    print(json.dumps(asyncio.run(main(n, m)), indent=1, ensure_ascii=False))
