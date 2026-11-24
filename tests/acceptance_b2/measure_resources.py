"""RSS / thread measurement: 5 fake speakers, 10 simulated minutes of 20 ms packets (48 kHz stereo fake PCM), fake STT/clock.
Run: .venv/bin/python -m tests.acceptance_b2.measure_resources [SPEAKERS=5] [MINUTES=10]. Prints one JSON object. Limits: see report."""
import asyncio
import json
import os
import resource
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from types import SimpleNamespace as NS

from core.db.sqlite import open_database
from tests.conftest import make_db_path
from tests.voice.vfakes import Mem, make_world, started

PKT = bytes(3840)  # 20 ms, silence-valued but copied/decimated like real audio


def rss_mb() -> float:
    return int(subprocess.check_output(["ps", "-o", "rss=", "-p", str(os.getpid())]).split()[0]) / 1024


def peak_mb() -> float:
    v = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return v / (1024 * 1024) if sys.platform == "darwin" else v / 1024


async def main(n: int, minutes: int) -> dict:
    out = {"python": sys.version.split()[0], "platform": sys.platform, "speakers": n, "sim_minutes": minutes}
    tmp = Path(tempfile.mkdtemp(prefix="b2-res-"))
    db = await open_database(make_db_path(tmp))
    w = make_world(tmp, db)
    users = [800000000000000000 + k for k in range(n)]
    for u in users:
        w.mem[u] = Mem(u, f"s{u % 100}", w.vch); w.vch.members.append(w.mem[u])
    cpu0, t0 = time.process_time(), time.time()
    s = await started(w, users[0])
    out["baseline"] = {"rss_mb": round(rss_mb(), 1), "threads": threading.active_count()}
    maxthr, rss_series = 0, []
    sink = w.vc.sink
    for sec in range(minutes * 60):
        for u in users:                      # every speaker talks continuously (worst case): 50 packets / s
            for _ in range(50):
                sink.write(NS(pcm=PKT), NS(id=u))
        w.clock.t += 1
        await s.tick()
        await asyncio.sleep(0)
        maxthr = max(maxthr, threading.active_count())
        if sec % 60 == 59:
            rss_series.append(round(rss_mb(), 1))
    await s.drain()
    out["end_of_capture"] = {"rss_mb": round(rss_mb(), 1), "threads": threading.active_count()}
    await w.mgr.stop("command")
    out.update(rss_per_sim_minute_mb=rss_series, peak_rss_mb=round(peak_mb(), 1), max_threads=maxthr,
               stt_calls=len(w.stt.calls), stt_bytes_total=sum(w.stt.calls), pending_at_end=len(s.pending),
               after_stop={"rss_mb": round(rss_mb(), 1)}, process_cpu_s=round(time.process_time() - cpu0, 2),
               wall_s=round(time.time() - t0, 2), sim_audio_s=n * minutes * 60,
               tmp_files_left=sorted(os.listdir(w.cfg.voice_tmp_dir)) if os.path.exists(w.cfg.voice_tmp_dir) else [])
    await db.close()
    return out


if __name__ == "__main__":
    print(json.dumps(asyncio.run(main(int(sys.argv[1]) if len(sys.argv) > 1 else 5, int(sys.argv[2]) if len(sys.argv) > 2 else 10)), indent=1))
