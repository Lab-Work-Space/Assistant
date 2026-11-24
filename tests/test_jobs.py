"""Jobs repo + runner against a temp SQLite file (spec 11.14)."""
import asyncio
import os
import types

import pytest
import pytest_asyncio

from core.db.sqlite import open_database
from core.interfaces import JobKind
from core.jobs.runner import PgJobRunner
from tests.conftest import make_db_path

pytestmark = pytest.mark.asyncio(loop_scope="module")


def cfg(**kw):
    d = dict(job_max_concurrency=2, job_poll_interval_s=0.1, job_output_cap_bytes=1048576, job_memory_limit_mb=1024,
             job_default_timeout_s=30, tasks_retention_days=180, knowledge_meetings_retention_days=90)
    return types.SimpleNamespace(**{**d, **kw})


@pytest_asyncio.fixture(loop_scope="module")
async def pool(tmp_path_factory):
    p = await open_database(make_db_path(tmp_path_factory.mktemp("db")))
    await p.execute("DELETE FROM jobs")
    yield p
    await p.close()


@pytest_asyncio.fixture(loop_scope="module")
async def runner(pool):
    r = PgJobRunner(pool, cfg(), sweep_interval_s=3600)
    r.register_kind(JobKind("selftest_crash", 30))
    r.register_kind(JobKind("selftest_sleep", 60))
    await r.start()
    yield r
    await r.stop()


async def test_crash_isolated_then_ok(runner):
    row = await runner.wait(await runner.enqueue("selftest_crash", {}, "t"), 20)
    assert row["status"] == "failed" and row["error"] == "signal:6", row
    ok = await runner.wait(await runner.enqueue("selftest_sleep", {"seconds": 0.1}, "t"), 20)
    assert ok["status"] == "succeeded"


async def test_hang_times_out(runner):
    row = await runner.wait(await runner.enqueue("selftest_sleep", {"seconds": 60}, "t", timeout_s=1), 20)
    assert row["status"] == "timed_out" and row["pid"] is None


async def test_cancel_running_and_queued(runner, pool):
    jid = await runner.enqueue("selftest_sleep", {"seconds": 60}, "t")
    for _ in range(50):
        if (await pool.fetchval("SELECT status FROM jobs WHERE id=?1", jid)) == "running":
            break
        await asyncio.sleep(0.1)
    assert await runner.cancel(jid) is True
    assert (await runner.wait(jid, 20))["status"] == "cancelled"
    assert await runner.cancel("00000000-0000-0000-0000-000000000000") is False
    assert await runner.cancel("not-a-uuid") is False
    q = await pool.fetchval("INSERT INTO jobs (kind, created_by, timeout_s, run_after) VALUES ('selftest_sleep','t',5, strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour')) RETURNING id")
    assert await runner.cancel(q) is True
    assert (await runner.wait(q, 5))["status"] == "cancelled"


async def test_kind_allowlist(runner, pool):
    with pytest.raises(ValueError, match="kind_not_allowed"):
        await runner.enqueue("nope", {}, "t")
    r2 = PgJobRunner(pool, cfg())  # no selftest kinds registered: worker must refuse a row inserted directly
    jid = await pool.fetchval("INSERT INTO jobs (kind, created_by, timeout_s, run_after) VALUES ('selftest_sleep','t',5, strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour')) RETURNING id")
    await pool.execute("UPDATE jobs SET run_after=strftime('%Y-%m-%dT%H:%M:%fZ','now'), status='running' WHERE id=?1", jid)
    row = (await pool.fetchrow("SELECT * FROM jobs WHERE id=?1", jid))
    await r2._run(row)
    done = await r2.wait(jid, 5)
    assert done["status"] == "failed" and done["error"] == "kind_not_allowed"


async def test_cwd_not_project_root_and_env_scrubbed(runner, pool, tmp_path, monkeypatch):
    from core.config import PROJECT_ROOT
    k = tmp_path / "kinds"
    monkeypatch.setenv("DATABASE_PATH", "/x")
    monkeypatch.setenv("DISCORD_BOT_TOKEN", "tok")
    env = runner._env(None)
    assert "DATABASE_PATH" not in env and "DISCORD_BOT_TOKEN" not in env and env["PYTHONPATH"] == str(PROJECT_ROOT)
    import core.jobs.kinds as kinds_pkg
    mod = os.path.join(os.path.dirname(kinds_pkg.__file__), "selftest_probe.py")
    open(mod, "w").write("import os\ndef run(p, progress):\n    return {'cwd': os.getcwd(), 'db': 'DATABASE_PATH' in os.environ, 'tok': 'DISCORD_BOT_TOKEN' in os.environ}\n")
    try:
        runner.register_kind(JobKind("selftest_probe", 30))
        row = await runner.wait(await runner.enqueue("selftest_probe", {}, "t"), 20)
    finally:
        os.unlink(mod)
        runner._kinds.pop("selftest_probe")
    res = row["result"] if isinstance(row["result"], dict) else __import__("json").loads(row["result"])
    assert row["status"] == "succeeded" and res["cwd"] != str(PROJECT_ROOT) and not res["db"] and not res["tok"]
    assert not os.path.exists(res["cwd"])  # mkdtemp removed after exit


async def test_no_stderr_or_free_text_persisted(runner, pool, caplog):
    import core.jobs.kinds as kinds_pkg
    mod = os.path.join(os.path.dirname(kinds_pkg.__file__), "selftest_leak.py")
    open(mod, "w").write("import sys\ndef run(p, progress):\n    sys.stderr.write('SECRET-STDERR-TEXT')\n    raise ValueError('SECRET-MSG-TEXT')\n")
    caplog.set_level("DEBUG")
    try:
        runner.register_kind(JobKind("selftest_leak", 30))
        row = await runner.wait(await runner.enqueue("selftest_leak", {}, "t"), 20)
    finally:
        os.unlink(mod)
        runner._kinds.pop("selftest_leak")
    assert row["error"] == "ValueError:worker_exception"
    assert "SECRET" not in str(row) and "SECRET" not in caplog.text and "job.stderr" in caplog.text


async def test_output_cap(pool):
    import core.jobs.kinds as kinds_pkg
    mod = os.path.join(os.path.dirname(kinds_pkg.__file__), "selftest_big.py")
    open(mod, "w").write("def run(p, progress):\n    return {'x': 'a' * 100000}\n")
    r = PgJobRunner(pool, cfg(job_output_cap_bytes=1000))
    r.register_kind(JobKind("selftest_big", 30))
    await r.start()
    try:
        row = await r.wait(await r.enqueue("selftest_big", {}, "t"), 20)
    finally:
        os.unlink(mod)
        await r.stop()
    assert row["status"] == "failed" and row["error"] == "output_cap_exceeded"


async def test_sweeper_deletes_old_and_runs_hooks(pool):
    await pool.execute("DELETE FROM jobs")
    await pool.execute("INSERT INTO jobs (kind,created_by,timeout_s,status,finished_at) VALUES ('selftest_sleep','t',5,'succeeded', strftime('%Y-%m-%dT%H:%M:%fZ','now','-31 days'))")
    await pool.execute("INSERT INTO jobs (kind,created_by,timeout_s,status,finished_at) VALUES ('selftest_sleep','t',5,'succeeded', strftime('%Y-%m-%dT%H:%M:%fZ','now'))")
    called = []

    async def meetings():
        called.append(1)
    r = PgJobRunner(pool, cfg())
    r.add_sweep(meetings)
    await r.sweep_once()
    assert await pool.fetchval("SELECT count(*) FROM jobs") == 1 and called == [1]


async def test_register_kind_refuses_db_path_and_bot_token(pool):
    r = PgJobRunner(pool, cfg())
    for s in ("DATABASE_PATH", "DISCORD_BOT_TOKEN"):
        with pytest.raises(ValueError, match="kind_invalid"):
            r.register_kind(JobKind("x", 5, env_secrets=(s,)))


async def test_claim_50_concurrent_gives_10_distinct(pool):
    from core.jobs import repo
    await pool.execute("DELETE FROM jobs")
    for _ in range(10):
        await repo.insert(pool, "selftest_sleep", {}, "t", 5)
    rows = await asyncio.gather(*[repo.claim(pool) for _ in range(50)])
    got = [r["id"] for r in rows if r]
    assert len(got) == 10 and len(set(got)) == 10


async def test_sweep_checkpoint_busy_is_reported(pool, monkeypatch, caplog):
    from core.migration import retention

    async def busy(db, delay=0):
        return False
    monkeypatch.setattr(retention, "checkpoint", busy)
    caplog.set_level("ERROR")
    await PgJobRunner(pool, cfg()).sweep_once()
    assert "wal_checkpoint_busy" in caplog.text
