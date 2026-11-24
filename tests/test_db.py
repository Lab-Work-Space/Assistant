"""T-DB-4..8, 11..13 + S11-03 / S11-09 (spec 11.14.2). Temp SQLite files; no Docker."""
import asyncio
import os
import sqlite3
import stat
from datetime import datetime, timedelta, timezone

import pytest

import core.db.sqlite as sq
import tarfile

from core.db.backup import backup_knowledge, backup_to, restore, restore_knowledge
from core.db.sqlite import DbError, connect, open_database, utc_text
from core.migration import retention
from core.migration.runner import migrate


def mkdb(base) -> str:
    d = os.path.join(str(base), "data")
    os.makedirs(d, mode=0o700, exist_ok=True)
    os.chmod(d, 0o700)
    p = os.path.join(d, "emp.db")
    migrate(p)
    return p


@pytest.fixture
async def db(tmp_path):
    d = await open_database(mkdb(tmp_path))
    yield d
    await d.close()


BUDGET = "INSERT INTO budgets (agent_id, daily_limit_micro_usd, updated_by) VALUES ('a', 1, 'cli:dev')"


def test_pragmas(tmp_path, monkeypatch):
    c = connect(mkdb(tmp_path))
    g = lambda n: c.execute("PRAGMA " + n).fetchone()[0]
    assert (g("journal_mode"), g("foreign_keys"), g("synchronous"), g("secure_delete"), g("trusted_schema")) \
        == ("wal", 1, 2, 1, 0)
    assert c.getconfig(sqlite3.SQLITE_DBCONFIG_DEFENSIVE) is True
    assert c.getconfig(sqlite3.SQLITE_DBCONFIG_ENABLE_FTS3_TOKENIZER) is False
    c.close()
    monkeypatch.setattr(sq, "MIN_SQLITE", (99, 0, 0))
    with pytest.raises(DbError, match="sqlite_too_old"):
        connect(mkdb(tmp_path))


async def test_authorizer(db, tmp_path):
    x = str(tmp_path / "x.db")
    for sql in ("CREATE TABLE x(a)", "CREATE TEMP TABLE y(a)", "DROP TABLE budgets", "ALTER TABLE budgets ADD COLUMN z",
                "ATTACH DATABASE ':memory:' AS m", "PRAGMA foreign_keys=OFF",
                # S11-09 vectors
                "SELECT fts3_tokenizer('simple', x'00')", f"VACUUM INTO '{x}'",
                "SELECT * FROM pragma_table_info('budgets')", "SELECT load_extension('x')",
                # G2S11-04
                "DELETE FROM schema_version", "UPDATE schema_version SET version=0", "INSERT INTO schema_version(version) VALUES (999)"):
        with pytest.raises(sqlite3.DatabaseError):
            await db.execute(sql)
    assert not os.path.exists(x)
    assert await db.execute(BUDGET) == 1
    r = await db.fetchrow("PRAGMA wal_checkpoint(TRUNCATE)")
    assert r["busy"] == 0
    assert await retention.checkpoint(db) is True


def test_connect_hardening(tmp_path):
    c = connect(mkdb(tmp_path))
    assert c.getconfig(sqlite3.SQLITE_DBCONFIG_DEFENSIVE) is True
    assert c.getconfig(sqlite3.SQLITE_DBCONFIG_ENABLE_FTS3_TOKENIZER) is False
    c.close()


async def test_files_and_path_rules(tmp_path):
    p = mkdb(tmp_path)
    d = await open_database(p)
    await d.execute(BUDGET)
    for f in (p, p + "-wal", p + "-shm"):
        assert stat.S_IMODE(os.stat(f).st_mode) == 0o600
    assert stat.S_IMODE(os.stat(os.path.dirname(p)).st_mode) == 0o700
    await d.close()

    async def refused(path, code="db_path_invalid"):
        with pytest.raises(DbError) as e:
            await open_database(path)
        assert e.value.code == code

    await refused("data/emp.db")
    link = tmp_path / "lnk.db"
    link.symlink_to(p)
    await refused(str(link))
    pl = tmp_path / "pl"
    pl.symlink_to(os.path.dirname(p))
    await refused(str(pl / "emp.db"))
    await refused(os.path.join(os.path.dirname(p), "missing.db"))
    os.chmod(p, 0o644)
    await refused(p)
    os.chmod(p, 0o600)
    os.chmod(os.path.dirname(p), 0o755)
    await refused(p)
    os.chmod(os.path.dirname(p), 0o700)
    await refused(os.path.join(sq.PROJECT_ROOT, "x.db"))
    c = connect(p)
    c.execute("DELETE FROM schema_version")
    c.close()
    await refused(p, "schema_not_head")


async def test_rows_and_serialization(db):
    assert await db.execute(BUDGET) == 1
    row = await db.fetchrow("SELECT * FROM budgets")
    assert isinstance(row, dict) and await db.fetchval("SELECT count(*) FROM budgets") == 1
    await db.execute("INSERT INTO jobs (kind,timeout_s,created_by,payload) VALUES ('k',5,'x','{\"a\":1}')")
    assert (await db.fetchrow("SELECT payload FROM jobs"))["payload"] == {"a": 1}
    with pytest.raises(sqlite3.ProgrammingError):
        await db.execute("DELETE FROM jobs; DELETE FROM budgets")

    order = []

    async def a():
        with pytest.raises(RuntimeError):
            async with db.transaction() as tx:
                await tx.execute("INSERT INTO budgets VALUES ('A', 1, 'cli:dev', strftime('%Y-%m-%dT%H:%M:%fZ','now'))")
                await asyncio.sleep(0)
                raise RuntimeError
        order.append("a")

    async def b():
        await asyncio.sleep(0)
        await db.execute("INSERT INTO budgets (agent_id, daily_limit_micro_usd, updated_by) VALUES ('B', 1, 'cli:dev')")
        order.append("b")

    await asyncio.gather(a(), b())
    assert order == ["a", "b"]
    assert {r["agent_id"] for r in await db.fetch("SELECT agent_id FROM budgets")} == {"a", "B"}


async def test_cancellation(db):
    started = asyncio.Event()

    async def t():
        async with db.transaction() as tx:
            await tx.execute("INSERT INTO budgets (agent_id, daily_limit_micro_usd, updated_by) VALUES ('C', 1, 'cli:dev')")
            started.set()
            await asyncio.sleep(30)

    task = asyncio.create_task(t())
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert db._conn.in_transaction is False
    assert await db.fetchval("SELECT count(*) FROM budgets") == 0
    assert await db.execute(BUDGET) == 1


def test_utc_text(tmp_path):
    dt = datetime(2026, 11, 23, 10, 0, 0, 123456, tzinfo=timezone(timedelta(hours=7)))
    c = connect(mkdb(tmp_path))
    assert utc_text(dt) == c.execute("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', ?1)", ("2026-11-23T03:00:00.123456Z",)).fetchone()[0]
    c.close()
    with pytest.raises(ValueError):
        utc_text(datetime(2026, 1, 1))


def test_backup(tmp_path):
    c = connect(mkdb(tmp_path))
    bd = os.path.join(tmp_path, "data", "backups")
    out = backup_to(c, bd, "daily")
    assert stat.S_IMODE(os.stat(out).st_mode) == 0o600 and stat.S_IMODE(os.stat(bd).st_mode) == 0o700
    for _ in range(15):
        backup_to(c, bd, "daily")
    assert len(os.listdir(bd)) == 14
    os.chmod(bd, 0o755)
    with pytest.raises(DbError, match="backup_dir_invalid"):
        backup_to(c, bd, "daily")
    c.close()


def test_backup_prunes_by_age(tmp_path):
    c = connect(mkdb(tmp_path))
    bd = os.path.join(tmp_path, "data", "backups")
    backup_to(c, bd, "daily")
    f = lambda d: (datetime.now(timezone.utc) - timedelta(days=d)).strftime("%Y%m%dT%H%M%S%fZ")
    old, new = f(15), f(13)
    for n in (f"daily-{old}.db", f"pre-migrate-{old}.db", f"daily-{new}.db", "notes.txt"):
        open(os.path.join(bd, n), "w").close()
    backup_to(c, bd, "daily")
    left = os.listdir(bd)
    assert all(old not in n for n in left) and f"daily-{new}.db" in left and "notes.txt" in left and len(left) == 4
    c.close()


def test_restore_keeps_newer_optouts_and_sweeps(tmp_path):
    p = mkdb(tmp_path)
    c = connect(p)
    c.execute("INSERT INTO voice_optouts (guild_id,user_id,source) VALUES (1,1,'button')")
    bk = backup_to(c, os.path.join(tmp_path, "data", "backups"), "daily")
    c.execute("INSERT INTO voice_optouts (guild_id,user_id,source) VALUES (1,2,'command')")  # newer than backup
    c.execute("INSERT INTO conversation_state VALUES (1,1,'a','2020-01-01T00:00:00.000Z')")
    c.close()
    restore(bk, p, 30)
    c = connect(p)
    assert c.execute("SELECT count(*) FROM voice_optouts").fetchone()[0] == 2
    c.close()
    assert not os.path.exists(p + ".restore")


def _bk(tmp_path):
    p = mkdb(tmp_path)
    c = connect(p)
    c.execute("INSERT INTO voice_optouts (guild_id,user_id,source) VALUES (1,1,'button')")
    bk = backup_to(c, os.path.join(tmp_path, "data", "backups"), "daily")
    c.close()
    return p, bk


def _snap(p):
    c = connect(p)
    try:
        return c.execute("SELECT guild_id,user_id FROM voice_optouts").fetchall(), c.execute(
            "SELECT sql FROM sqlite_master ORDER BY name").fetchall()
    finally:
        c.close()


def _clean(p):
    d = os.path.dirname(p)
    assert not [n for n in os.listdir(d) if n.endswith((".restore", ".restore-wal", ".restore-shm"))]


def test_restore_column_mismatch_leaves_live_untouched(tmp_path):
    p, bk = _bk(tmp_path)
    c = connect(p)
    c.execute("INSERT INTO voice_optouts (guild_id,user_id,source) VALUES (1,2,'command')")
    c.close()
    b = sqlite3.connect(bk)
    b.execute("DROP TABLE voice_optouts")
    b.execute("CREATE TABLE voice_optouts (guild_id INTEGER, user_id INTEGER)")
    b.commit()
    b.close()
    before = _snap(p)
    with pytest.raises(DbError):
        restore(bk, p, 30)
    assert _snap(p) == before
    _clean(p)


def test_restore_corrupt_backup_leaves_live_untouched(tmp_path):
    p, bk = _bk(tmp_path)
    before = _snap(p)
    with open(bk, "r+b") as f:
        f.write(b"x" * 200)
    with pytest.raises(DbError):
        restore(bk, p, 30)
    assert _snap(p) == before
    _clean(p)


def test_restore_unreadable_current_refused_then_gap(tmp_path):
    p, bk = _bk(tmp_path)
    with open(p, "wb") as f:
        f.write(b"not a database" * 50)
    gap = os.path.join(os.path.dirname(p), "consent_gap")
    with pytest.raises(DbError, match="restore_export_failed"):
        restore(bk, p, 30)
    assert not os.path.exists(gap)
    restore(bk, p, 30, allow_optout_gap=True)
    assert stat.S_IMODE(os.stat(gap).st_mode) == 0o600
    assert open(gap).read().strip().endswith("Z")
    assert _snap(p)[0] == [(1, 1)]


def test_restore_missing_current_is_gap(tmp_path):
    p, bk = _bk(tmp_path)
    os.unlink(p)
    for e in ("-wal", "-shm"):
        if os.path.lexists(p + e):
            os.unlink(p + e)
    with pytest.raises(DbError, match="restore_export_failed"):
        restore(bk, p, 30)
    restore(bk, p, 30, allow_optout_gap=True)
    assert os.path.exists(os.path.join(os.path.dirname(p), "consent_gap"))


def test_restore_readable_current_writes_no_gap(tmp_path):
    p, bk = _bk(tmp_path)
    restore(bk, p, 30)
    assert not os.path.exists(os.path.join(os.path.dirname(p), "consent_gap"))


def test_checkpoint_busy_is_reported(tmp_path, caplog):
    p = mkdb(tmp_path)
    c, reader = connect(p), connect(p)
    c.execute(BUDGET)
    c.execute("PRAGMA busy_timeout=0")
    reader.execute("BEGIN")
    reader.execute("SELECT * FROM budgets").fetchall()  # holds a read mark
    c.execute("INSERT INTO budgets (agent_id, daily_limit_micro_usd, updated_by) VALUES ('b', 1, 'cli:dev')")
    assert retention.sweep_sync(c, 30, delay=0) is False
    assert "wal_checkpoint_busy" in caplog.text
    reader.close()
    c.close()


def test_retention_main(tmp_path, monkeypatch):
    import subprocess, sys
    p = mkdb(tmp_path)
    c = connect(p)
    c.execute("INSERT INTO conversation_state VALUES (1,1,'a','2020-01-01T00:00:00.000Z')")
    c.close()
    env = {**os.environ, "DATABASE_PATH": p}
    run = lambda e: subprocess.run([sys.executable, "-m", "core.migration.retention_main"], env=e,
                                   capture_output=True, text=True, cwd=sq.PROJECT_ROOT)
    assert run(env).returncode == 0
    c = connect(p)
    assert c.execute("SELECT count(*) FROM conversation_state").fetchone()[0] == 0
    c.close()
    r = run({**env, "TASKS_RETENTION_DAYS": "0"})
    assert r.returncode == 2 and "bounds" in r.stderr
    r = run({**env, "DATABASE_PATH": str(tmp_path / "nope" / "x.db")})
    assert r.returncode == 2


def mkkb(base):
    k = os.path.join(str(base), "knowledge")
    os.makedirs(os.path.join(k, "sub"))
    open(os.path.join(k, "a.md"), "w").write("alpha")
    open(os.path.join(k, "sub", "b.md"), "w").write("beta")
    return k


def test_knowledge_backup_roundtrip_and_skips_symlink(tmp_path):
    k, bd = mkkb(tmp_path), os.path.join(tmp_path, "backups")
    os.symlink("/etc/passwd", os.path.join(k, "link"))
    out = backup_knowledge(k, bd)
    assert os.path.basename(out).startswith("knowledge-") and out.endswith(".tar.gz")
    assert stat.S_IMODE(os.stat(out).st_mode) == 0o600 and stat.S_IMODE(os.stat(bd).st_mode) == 0o700
    with tarfile.open(out) as t:
        files = sorted(m.name for m in t.getmembers() if m.isfile())
        assert files == ["a.md", "sub/b.md"] and "link" not in t.getnames()
        assert t.extractfile("sub/b.md").read() == b"beta"


def test_knowledge_backup_prunes_by_age(tmp_path):
    k, bd = mkkb(tmp_path), os.path.join(tmp_path, "backups")
    backup_knowledge(k, bd)
    f = lambda d: (datetime.now(timezone.utc) - timedelta(days=d)).strftime("%Y%m%dT%H%M%S%fZ")
    old, new = f"knowledge-{f(15)}.tar.gz", f"knowledge-{f(13)}.tar.gz"
    for n in (old, new, "notes.txt"):
        open(os.path.join(bd, n), "w").close()
    backup_knowledge(k, bd)
    left = os.listdir(bd)
    assert old not in left and new in left and "notes.txt" in left


def test_knowledge_restore_swaps_and_removes_old(tmp_path):
    k, bd = mkkb(tmp_path), os.path.join(tmp_path, "backups")
    out = backup_knowledge(k, bd)
    open(os.path.join(k, "a.md"), "w").write("changed")
    restore_knowledge(out, k)
    assert open(os.path.join(k, "a.md")).read() == "alpha" and stat.S_IMODE(os.stat(k).st_mode) == 0o700
    assert sorted(os.listdir(tmp_path)) == ["backups", "knowledge"]  # old + restore temp dirs gone (S1119-01)


def test_knowledge_restore_second_rename_failure_keeps_dest(tmp_path, monkeypatch):
    k, bd = mkkb(tmp_path), os.path.join(tmp_path, "backups")
    out = backup_knowledge(k, bd)
    open(os.path.join(k, "a.md"), "w").write("changed")
    real, calls = os.rename, []

    def flaky(a, b):
        calls.append(1)
        if len(calls) == 2:
            raise OSError("boom")
        return real(a, b)
    monkeypatch.setattr(os, "rename", flaky)
    with pytest.raises(DbError):
        restore_knowledge(out, k)
    assert open(os.path.join(k, "a.md")).read() == "changed"
    assert sorted(os.listdir(tmp_path)) == ["backups", "knowledge"]


def test_knowledge_backup_excludes_inflight_tmp(tmp_path):
    k, bd = mkkb(tmp_path), os.path.join(tmp_path, "backups")
    open(os.path.join(k, ".tmp-abc"), "w").write("partial")
    with tarfile.open(backup_knowledge(k, bd)) as t:
        assert ".tmp-abc" not in t.getnames() and "a.md" in t.getnames()


def test_restore_knowledge_cli_name_pattern(tmp_path):
    import subprocess, sys
    p = mkdb(tmp_path)
    env = {**os.environ, "DATABASE_PATH": p, "KNOWLEDGE_DIR": mkkb(tmp_path)}
    for n in ("daily-20260101T000000000000Z.db", "evil.tar.gz", "knowledge-1.tar.gz"):
        r = subprocess.run([sys.executable, "-m", "core.db.backup", "restore-knowledge", n], env=env,
                           capture_output=True, text=True, cwd=sq.PROJECT_ROOT)
        assert r.returncode == 2 and r.stderr.strip() == "bad_backup_name"


@pytest.mark.parametrize("bad", ["../evil", "/abs/evil"])
def test_knowledge_restore_rejects_traversal(tmp_path, bad):
    k = mkkb(tmp_path)
    arc = os.path.join(tmp_path, "evil.tar.gz")
    with tarfile.open(arc, "w:gz") as t:
        ti = tarfile.TarInfo(bad)
        ti.size = 1
        import io
        t.addfile(ti, io.BytesIO(b"x"))
    with pytest.raises((DbError, tarfile.TarError)):
        restore_knowledge(arc, k)
    assert open(os.path.join(k, "a.md")).read() == "alpha"
    assert sorted(os.listdir(tmp_path)) == ["evil.tar.gz", "knowledge"]


def test_consent_gap_path_single_helper(tmp_path):
    from core.db.backup import consent_gap_path
    from core.voice.notice import consent_gap_present
    db = str(tmp_path / "e.db")
    assert consent_gap_path(db) == str(tmp_path / "consent_gap") and not consent_gap_present(db)
    open(consent_gap_path(db), "w").close()
    assert consent_gap_present(db)
