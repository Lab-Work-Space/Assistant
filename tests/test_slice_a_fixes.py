"""Slice A fix-pass regressions (no DB needed)."""
import asyncio
import logging
import types

import pytest

from core.budget import prices
from core.cli.script import run_script
from core.cli.sink import Out
from core.functions.logs import masking
from core.functions.logs.logsystem import Log
from core.jobs.runner import PgJobRunner


class _S:
    quit = failed = False

    def __init__(self):
        self.out = Out()

    async def handle(self, line):
        pass

    async def _wait_idle(self, rest):
        pass


@pytest.mark.asyncio
async def test_script_echo_is_masked(tmp_path, capsys):
    masking.set_exact(["planted-secret-value-123"])
    p = tmp_path / "s.txt"
    p.write_text("say planted-secret-value-123\n")
    assert await run_script(_S(), str(p)) == 0
    out = capsys.readouterr().out
    assert "> say" in out and "planted-secret-value-123" not in out


@pytest.mark.asyncio
async def test_stopping_runner_logs_no_error_for_closed_pool(caplog):
    class Pool:
        async def execute(self, *a):
            raise RuntimeError("closed")

        async def fetchrow(self, *a):
            raise RuntimeError("closed")

        async def fetch(self, *a):
            raise RuntimeError("closed")

    r = PgJobRunner(Pool(), types.SimpleNamespace(job_max_concurrency=1, job_poll_interval_s=0.05,
                                                  tasks_retention_days=1))
    r._stopping = True
    with caplog.at_level(logging.ERROR):
        await r.sweep_once()
        t = asyncio.create_task(r._claim_loop())
        await asyncio.sleep(0.1)
        t.cancel()
    assert not [x for x in caplog.records if x.levelno >= logging.ERROR]


def test_rmtree_refuses_path_outside_tmp(tmp_path):
    from core.jobs.runner import _rm_job_dir
    d = tmp_path / "emp-job-x"
    d.mkdir()
    _rm_job_dir(str(d))  # not under the mkdtemp base: kept
    assert d.exists()
    import tempfile
    t = tempfile.mkdtemp(prefix="emp-job-")
    _rm_job_dir(t)
    import os
    assert not os.path.exists(t)


def test_log_stdout_off(tmp_path, capsys):
    lg = Log(str(tmp_path / "a.jsonl"), stdout=False)
    lg.write_log("s", "e")
    assert capsys.readouterr().out == "" and "\"e\"" in (tmp_path / "a.jsonl").read_text()


def test_prices_cover_all_models():
    for m in ("claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5", "gemini-3.8-flash"):
        assert prices.token_price(m)[1]
    assert prices.unit_price("image", "gemini-3.1-flash-image")[1]
    assert prices.unit_price("tts", "gemini-3.8-flash-tts")[1]
    assert prices.unit_price("stt", "gemini-3.8-flash")[1]

