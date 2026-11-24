"""TASK-033 AT-1: migration 0004 on a v3 DB keeps rows; CHECKs refuse bad values (incl. G033-12 reserved ids)."""
import shutil
import sqlite3

import pytest

from core.db.sqlite import VERSIONS_DIR, connect
from core.growth import OVERLAY_HARD_MAX_CHARS, GrowthError
from core.migration.runner import migrate


def v3_db(tmp_path) -> str:
    v = tmp_path / "v3"
    v.mkdir()
    for f in sorted(VERSIONS_DIR.glob("000[1-3]_*.sql")):
        shutil.copy(f, v)
    d = tmp_path / "data"
    d.mkdir(mode=0o700)
    p = str(d / "emp.db")
    assert migrate(p, v) == 3
    c = connect(p)
    c.execute("INSERT INTO audit_log (scope,ref,action,actor) VALUES ('task','TASK-1','edit','cli:a')")
    c.execute("INSERT INTO code_counters (kind,dept,last) VALUES ('task','ENG',7)")
    c.close()
    return p


@pytest.fixture
def db(tmp_path):
    p = v3_db(tmp_path)
    assert migrate(p) == 5
    c = connect(p)
    yield c
    c.close()


def test_upgrade_preserves_rows_and_integrity(tmp_path):
    p = v3_db(tmp_path)
    assert migrate(p) == 5
    assert migrate(p) == 5  # idempotent
    c = connect(p)
    assert c.execute("SELECT scope,ref,action,actor FROM audit_log").fetchall() == [("task", "TASK-1", "edit", "cli:a")]
    assert c.execute("SELECT kind,dept,last FROM code_counters ORDER BY kind").fetchall() == [("approval", "HQ", 0), ("task", "ENG", 7)]
    assert c.execute("SELECT max(version) FROM schema_version").fetchone()[0] == 5
    assert c.execute("PRAGMA integrity_check").fetchall() == [("ok",)]
    assert c.execute("PRAGMA foreign_key_check").fetchall() == []
    c.close()


def lesson(**o):
    r = dict(id="x" * 36, code="LSN-ENG-0001", dept="ENG", proposed_by="praw", scope_kind="persona", scope_id="praw",
             category="method", body="b" * 25)
    r.update(o)
    return r


def ins_lesson(c, **o):
    r = lesson(**o)
    c.execute(f"INSERT INTO lessons ({','.join(r)}) VALUES ({','.join('?' * len(r))})", list(r.values()))


def test_valid_lesson_and_new_audit_scope(db):
    ins_lesson(db)
    db.execute("INSERT INTO audit_log (scope,ref,action,actor) VALUES ('lesson','LSN-ENG-0001','propose','agent:praw')")
    db.execute("INSERT INTO code_counters (kind,dept,last) VALUES ('lesson','ENG',1)")


@pytest.mark.parametrize("o", [
    dict(scope_kind="team"),                       # bad scope
    dict(code="LSN-ENG-12"),                       # bad code
    dict(scope_kind="dept", scope_id="OPS"),       # scope_id/dept mismatch
    dict(body="line one\nline two is here"),       # newline
    dict(body="short"),
])
def test_lesson_checks_refuse(db, o):
    with pytest.raises(sqlite3.IntegrityError):
        ins_lesson(db, **o)


def test_audit_refuses_bad_scope(db):
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("INSERT INTO audit_log (scope,ref,action,actor) VALUES ('nope','x','edit','cli:a')")


def persona(pid):
    db_ = "INSERT INTO personas_runtime (id,kind,updated_by) VALUES (?, 'override', 'cli:a')"
    return db_, (pid,)


@pytest.mark.parametrize("pid", ["system", "praw", "admin", "hq", "everyone", "here"])
def test_reserved_persona_ids_refused(db, pid):
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(*persona(pid))


def test_persona_ok_and_dept_reserved_code(db):
    db.execute(*persona("zoe"))
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("INSERT INTO departments (code,slug,name,created_by) VALUES ('HQ','hq','x','cli:a')")


def test_growth_error_and_cap():
    assert GrowthError("bad").code == "bad"
    assert OVERLAY_HARD_MAX_CHARS >= 2 * 6500 + 2 + 200
