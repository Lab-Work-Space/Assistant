"""T-DB-1, T-DB-1b, T-DB-2, T-DB-3, T-DB-9 (spec 11.14.2). Temp SQLite files only."""
import os
import re
import sqlite3
import stat
import uuid

import pytest

from core.db.sqlite import VERSIONS_DIR, DbError, connect
from core.migration import retention as r
from core.migration.runner import migrate

HEAD = len(list(VERSIONS_DIR.glob("[0-9][0-9][0-9][0-9]_*.sql")))  # latest migration number

TABLES = {"code_counters", "settings", "audit_log", "tasks", "brainstorm_threads", "jobs", "approvals", "usage_events", "budgets", "budget_notices",
          "voice_optouts", "voice_sessions", "voice_notice_deliveries", "conversation_state", "schema_version"}


def mkpath(tmp_path) -> str:
    d = tmp_path / "data"
    d.mkdir(mode=0o700, exist_ok=True)
    return str(d / "emp.db")


@pytest.fixture
def conn(tmp_path):
    p = mkpath(tmp_path)
    migrate(p)
    c = connect(p)
    yield c
    c.close()


def test_fresh_and_idempotent(tmp_path):
    p = mkpath(tmp_path)
    assert migrate(p) == HEAD
    c = connect(p)
    assert c.execute("SELECT max(version) FROM schema_version").fetchone()[0] == HEAD
    assert {x[0] for x in c.execute("SELECT name FROM sqlite_master WHERE type='table'")} >= TABLES
    assert c.execute("PRAGMA foreign_key_check").fetchall() == []
    c.close()
    assert migrate(p) == HEAD
    assert not os.path.exists(tmp_path / "data" / "backups")


def test_file_guards(tmp_path):
    v = tmp_path / "v"
    v.mkdir()
    (v / "0001_a.sql").write_text("CREATE TABLE a (x INTEGER);")
    (v / "0003_b.sql").write_text("CREATE TABLE b (x INTEGER);")
    with pytest.raises(DbError, match="migration_gap"):
        migrate(mkpath(tmp_path), v)
    (v / "0003_b.sql").rename(v / "1_a.sql")
    with pytest.raises(DbError, match="migration_name_invalid"):
        migrate(mkpath(tmp_path), v)


def test_failing_migration_keeps_version_and_backs_up(tmp_path):
    v = tmp_path / "v"
    v.mkdir()
    (v / "0001_a.sql").write_text("CREATE TABLE a (x INTEGER);")
    p = mkpath(tmp_path)
    assert migrate(p, v) == 1
    (v / "0002_bad.sql").write_text("CREATE TABLE b (x INTEGER); SELECT * FROM nope;")
    with pytest.raises(DbError, match=r"migration_failed:0002"):
        migrate(p, v)
    c = connect(p)
    assert c.execute("SELECT max(version) FROM schema_version").fetchone()[0] == 1
    assert c.execute("SELECT 1 FROM sqlite_master WHERE name='b'").fetchone() is None  # whole step rolled back
    c.close()
    bk = [f for f in os.listdir(tmp_path / "data" / "backups") if f.startswith("pre-migrate-")]
    assert len(bk) == 1
    assert stat.S_IMODE(os.stat(tmp_path / "data" / "backups" / bk[0]).st_mode) == 0o600


def test_schema_ahead(tmp_path):
    v = tmp_path / "v"
    v.mkdir()
    (v / "0001_a.sql").write_text("CREATE TABLE a (x INTEGER);")
    p = mkpath(tmp_path)
    migrate(p, v)
    c = connect(p)
    c.execute("INSERT INTO schema_version (version, name) VALUES (2, '0002_x')")
    c.close()
    with pytest.raises(DbError, match="schema_ahead"):
        migrate(p, v)


def test_no_forbidden_words_in_sql():
    for f in VERSIONS_DIR.glob("*.sql"):
        assert not re.search(r"\b(BEGIN|COMMIT|ROLLBACK|PRAGMA|ATTACH|VACUUM)\b", re.sub(r"'[^']*'", "", f.read_text()), re.I), f.name  # string literals may name audit actions


def _ins(c, sql, *a):
    c.execute(sql, a)


def ok(c, sql, *a):
    c.execute("SAVEPOINT s")
    try:
        c.execute(sql, a)
    finally:
        c.execute("ROLLBACK TO s")
        c.execute("RELEASE s")


def bad(c, sql, *a):
    with pytest.raises(sqlite3.IntegrityError):
        ok(c, sql, *a)


@pytest.fixture
def tx(conn):
    conn.execute("BEGIN")
    yield conn
    conn.execute("ROLLBACK")


@pytest.mark.parametrize("ts,good", [("2026-11-23T10:00:00.123Z", True), ("2026-11-23 10:00:00", False),
                                     ("2026-11-23T10:00:00+00:00", False), ("2026-11-23T10:00:00.1234Z", False)])
def test_timestamp_check(tx, ts, good):
    (ok if good else bad)(tx, "INSERT INTO conversation_state VALUES (1,1,'a',?1)", ts)


@pytest.mark.parametrize("d,good", [("2026-11-23", True), ("2026-11-23T00:00:00", False)])
def test_day_check(tx, d, good):
    (ok if good else bad)(tx, "INSERT INTO budget_notices (agent_id, day, level) VALUES ('a', ?1, 'warn80')", d)


@pytest.mark.parametrize("k,good", [("a", True), ("a" + "b" * 63, True), ("A1", False), ("1a", False),
                                    ("a-b", False), ("a" * 65, False)])
def test_kind_check(tx, k, good):
    (ok if good else bad)(tx, "INSERT INTO jobs (kind, timeout_s, created_by) VALUES (?1, 5, 'x')", k)


@pytest.mark.parametrize("v,good", [("discord:" + "1" * 17, True), ("discord:" + "1" * 20, True), ("cli:a", True),
                                    ("cli:a-b_1", True), ("cli:" + "a" * 32, True), ("discord:" + "1" * 16, False),
                                    ("discord:" + "1" * 21, False), ("discord:12345678901234567x", False),
                                    ("cli:Admin", False), ("cli:1a", False), ("cli:" + "a" * 33, False),
                                    ("cli:", False)])
def test_actor_checks(tx, v, good):
    f = ok if good else bad
    f(tx, "INSERT INTO budgets (agent_id, daily_limit_micro_usd, updated_by) VALUES ('a', 1, ?1)", v)
    f(tx, "INSERT INTO approvals (code,level,dept,route_reason,kind,title,summary,requested_by,origin,origin_channel_id,status,decided_by,expires_at)"
          " VALUES ('APR-HQ-0001','hq','HQ','legacy','generic','t','s','a','cli',1,'approved',?1,'2026-11-23T10:00:00.000Z')", v)


BT = ("INSERT INTO brainstorm_threads (kind,guild_id,parent_channel_id,topic,owner_agent,participants,token_budget,"
      "initiated_by_kind,initiated_by_id) VALUES (?1,1,1,'t','a',?2,10,'human','1')")


def test_participants(tx):
    bad(tx, BT, "task", '["b"]')  # owner missing
    ok(tx, BT, "task", '["a"]')
    bad(tx, BT, "brainstorm", '["a"]')
    ok(tx, BT, "brainstorm", '["a","b"]')
    bad(tx, BT, "brainstorm", '["a","b","c","d","e","f","g"]')
    bad(tx, BT, "brainstorm", "not json")


def test_json_cols_strict_and_misc(tx):
    J = "INSERT INTO jobs (kind, timeout_s, created_by, payload) VALUES ('k', 5, 'x', ?1)"
    bad(tx, J, "[]")
    ok(tx, J, "{}")
    A = "INSERT INTO approvals (code,level,dept,route_reason,kind,title,summary,access,requested_by,origin,origin_channel_id,expires_at) " \
        "VALUES ('APR-HQ-0001','hq','HQ','legacy','generic','t','s',?1,'a','cli',1,'2026-11-23T10:00:00.000Z')"
    bad(tx, A, "{}")
    ok(tx, A, "[]")
    bad(tx, "INSERT INTO jobs (kind, timeout_s, created_by, cancel_requested) VALUES ('k',5,'x',2)")
    bad(tx, "INSERT INTO tasks (guild_id,origin_channel_id,title,created_by_kind,created_by_id,assignee_agent) "
            "VALUES ('abc',1,'t','human','1','a')")
    bad(tx, "INSERT INTO approvals (code,level,dept,route_reason,kind,title,summary,requested_by,origin,origin_channel_id,status,expires_at)"
            " VALUES ('APR-HQ-0001','hq','HQ','legacy','generic','t','s','a','cli',1,'approved','2026-11-23T10:00:00.000Z')")


def test_uuid_defaults(conn):
    ins = {"tasks": "INSERT INTO tasks (guild_id,origin_channel_id,title,created_by_kind,created_by_id,assignee_agent) "
                    "VALUES (1,1,'t','human','1','a') RETURNING id",
           "brainstorm_threads": BT.replace("?1", "'task'").replace("?2", "'[\"a\"]'") + " RETURNING id",
           "jobs": "INSERT INTO jobs (kind,timeout_s,created_by) VALUES ('k',5,'x') RETURNING id",
           "approvals": "INSERT INTO approvals (code,level,dept,route_reason,kind,title,summary,requested_by,origin,origin_channel_id,expires_at) "
                        "VALUES ('APR-HQ-0001','hq','HQ','legacy','generic','t','s','a','cli',1,'2026-11-23T10:00:00.000Z') RETURNING id",
           "voice_sessions": "INSERT INTO voice_sessions (guild_id,voice_channel_id,text_channel_id,started_by) "
                             "VALUES (1,1,1,1) RETURNING id"}
    for sql in ins.values():
        i = conn.execute(sql).fetchone()[0]
        assert str(uuid.UUID(i)) == i and uuid.UUID(i).version == 4


def test_retention(conn):
    old, new = "strftime('%Y-%m-%dT%H:%M:%fZ','now','-100 days')", "strftime('%Y-%m-%dT%H:%M:%fZ','now')"
    conn.execute(f"""INSERT INTO tasks(guild_id,origin_channel_id,title,created_by_kind,created_by_id,assignee_agent,status,updated_at)
        VALUES (1,1,'old','human','1','a','done',{old}),(1,1,'new','human','1','a','done',{new}),
               (1,1,'open-old','human','1','a','open',{old})""")
    conn.execute(f"""INSERT INTO jobs(kind,timeout_s,created_by,status,finished_at)
        VALUES ('k',5,'x','succeeded',strftime('%Y-%m-%dT%H:%M:%fZ','now','-31 days')),('k',5,'x','succeeded',{new})""")
    conn.execute(f"""INSERT INTO conversation_state VALUES (1,1,'a',strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days')),(1,2,'a',{new})""")
    conn.execute(f"""INSERT INTO brainstorm_threads(kind,guild_id,parent_channel_id,topic,owner_agent,participants,token_budget,status,initiated_by_kind,initiated_by_id,closed_at)
        VALUES ('brainstorm',1,1,'t','a','["a","b"]',10,'closed','human','1',{old})""")
    assert r.sweep_sync(conn, 30) is True
    assert sorted(x[0] for x in conn.execute("SELECT title FROM tasks")) == ["new", "open-old"]
    assert conn.execute("SELECT count(*) FROM jobs").fetchone()[0] == 1
    assert conn.execute("SELECT count(*) FROM conversation_state").fetchone()[0] == 1
    assert conn.execute("SELECT count(*) FROM brainstorm_threads").fetchone()[0] == 0
