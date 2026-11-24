"""Bounded-memory smoke on fakes (5 speakers, 3 simulated minutes). Full 10-minute run: python -m tests.acceptance_b2.measure_resources."""
from tests.acceptance_b2.measure_resources import main


async def test_five_speakers_rss_growth_and_threads_bounded():
    o = await main(5, 3)
    assert o["end_of_capture"]["rss_mb"] - o["baseline"]["rss_mb"] < 64      # caps: total_cap ~ 31 chunks x 0.96 MB = 30 MB
    assert o["max_threads"] <= o["baseline"]["threads"] + 3 and o["pending_at_end"] == 0 and o["tmp_files_left"] == []
    assert o["stt_calls"] == 5 * 6
