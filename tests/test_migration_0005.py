"""TASK-040 MCP-01 AT-1: migration 0005 on a v4 DB keeps rows (incl. lesson->approval FK); widened CHECKs; runner FK handling."""
import shutil
import sqlite3

import pytest

from core.db.sqlite import VERSIONS_DIR, connect
from core.migration.runner import migrate

APR = "11111111-1111-4111-8111-111111111111"


def v4_db(tmp_path) -> str:
    v = tmp_path / "v4"
    v.mkdir()
    for f in sorted(VERSIONS_DIR.glob("000[1-4]_*.sql")):
        shutil.copy(f, v)
    d = tmp_path / "data"
    d.mkdir(mode=0o700)
    p = str(d / "emp.db")
    assert migrate(p, v) == 4
    c = connect(p)
    ins_approval(c, APR, "APR-ENG-0001", "generic")
    c.execute("INSERT INTO lessons (id,code,dept,proposed_by,scope_kind,scope_id,category,body,approval_id) "
              "VALUES (?,?,?,?,?,?,?,?,?)", ("x" * 36, "LSN-ENG-0001", "ENG", "praw", "persona", "praw", "method", "b" * 25, APR))
    c.execute("INSERT INTO audit_log (scope,ref,action,actor) VALUES ('task','TASK-1','edit','cli:a')")
    c.close()
    return p


def ins_approval(c, id_, code, kind):
    c.execute("INSERT INTO approvals (id,code,level,dept,kind,title,summary,route_reason,requested_by,origin,origin_channel_id,expires_at) "
              "VALUES (?,?,'hq','ENG',?,'t','s','kind_dangerous','agent:praw','cli',1,'2030-01-01T00:00:00.000Z')", (id_, code, kind))


@pytest.fixture
def db(tmp_path):
    p = v4_db(tmp_path)
    assert migrate(p) == 5
    c = connect(p)
    yield c
    c.close()


def test_upgrade_keeps_rows_and_integrity(db):
    assert db.execute("SELECT code,kind FROM approvals").fetchall() == [("APR-ENG-0001", "generic")]
    assert db.execute("SELECT approval_id FROM lessons").fetchall() == [(APR,)]
    assert db.execute("SELECT scope,ref FROM audit_log").fetchall() == [("task", "TASK-1")]
    assert db.execute("PRAGMA integrity_check").fetchall() == [("ok",)]
    assert db.execute("PRAGMA foreign_key_check").fetchall() == []
    assert db.execute("PRAGMA foreign_keys").fetchone()[0] == 1  # restored by the runner


def test_idempotent(tmp_path):
    p = v4_db(tmp_path)
    assert migrate(p) == 5 and migrate(p) == 5


def test_new_values_accepted_bad_refused(db):
    ins_approval(db, "22222222-2222-4222-8222-222222222222", "APR-ENG-0002", "mcp_irreversible")
    for a in ("call", "refuse", "request", "replay"):
        db.execute("INSERT INTO audit_log (scope,ref,action,actor) VALUES ('mcp','github',?,'agent:praw')", (a,))
    with pytest.raises(sqlite3.IntegrityError):
        ins_approval(db, "33333333-3333-4333-8333-333333333333", "APR-ENG-0003", "bogus")
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("INSERT INTO audit_log (scope,ref,action,actor) VALUES ('mcp','x','nope','cli:a')")
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("INSERT INTO audit_log (scope,ref,action,actor) VALUES ('nope','x','call','cli:a')")


def test_fk_still_enforced_after_migration(db):
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("UPDATE lessons SET approval_id=? ", ("9" * 36,))


def test_runner_rolls_back_and_restores_fk(tmp_path):
    p = v4_db(tmp_path)
    v = tmp_path / "bad"
    v.mkdir()
    for f in sorted(VERSIONS_DIR.glob("000[1-4]_*.sql")):
        shutil.copy(f, v)
    (v / "0005_bad.sql").write_text("-- migrate: foreign_keys=off\nCREATE TABLE zz (a INTEGER);\nDROP TABLE nonexistent;\n")
    from core.db.sqlite import DbError
    with pytest.raises(DbError, match="migration_failed:0005"):
        migrate(p, v)
    c = connect(p)
    assert c.execute("SELECT name FROM sqlite_master WHERE name='zz'").fetchall() == []
    assert c.execute("SELECT max(version) FROM schema_version").fetchone()[0] == 4
    assert c.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    c.close()
