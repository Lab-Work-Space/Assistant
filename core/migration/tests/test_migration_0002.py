"""TASK-031 A1 / T031-09: migration 0002 on a populated legacy DB (integrity + foreign keys), counters, defaults."""
import os
import shutil

from core.db.sqlite import VERSIONS_DIR, connect
from core.migration.runner import migrate

HEAD = len(list(VERSIONS_DIR.glob("[0-9][0-9][0-9][0-9]_*.sql")))  # latest migration number


def legacy(tmp_path) -> str:
    v1 = tmp_path / "v1"
    v1.mkdir()
    shutil.copy(VERSIONS_DIR / "0001_phase1.sql", v1)
    d = tmp_path / "data"
    d.mkdir(mode=0o700)
    p = str(d / "emp.db")
    assert migrate(p, v1) == 1
    c = connect(p)
    for i, (ts, status, by) in enumerate([("2026-11-01T10:00:00.000Z", "approved", "cli:admin"), ("2026-11-02T10:00:00.000Z", "pending", None),
                                          ("2026-11-01T09:00:00.000Z", "expired", None)]):
        c.execute("INSERT INTO approvals (kind,title,summary,requested_by,origin,origin_channel_id,status,decided_by,decided_at,expires_at,created_at)"
                  " VALUES ('generic',?1,'s','praw','cli',1,?2,?3,?4,'2030-01-01T00:00:00.000Z',?5)",
                  (f"t{i}", status, by, ts if by else None, ts))
    c.execute("INSERT INTO tasks (guild_id,origin_channel_id,title,created_by_kind,created_by_id,assignee_agent) VALUES (1,1,'old task','human','1','a')")
    tid = c.execute("SELECT id FROM tasks").fetchone()[0]
    c.execute("INSERT INTO brainstorm_threads (kind,task_id,guild_id,parent_channel_id,thread_id,topic,owner_agent,participants,token_budget,"
              "initiated_by_kind,initiated_by_id) VALUES ('task',?1,1,1,5,'t','a','[\"a\"]',10,'human','1')", (tid,))
    c.close()
    return p


def test_legacy_db_migrates_with_backfill_counters_and_integrity(tmp_path):
    p = legacy(tmp_path)
    assert migrate(p) == HEAD
    assert [f for f in os.listdir(tmp_path / "data" / "backups") if f.startswith("pre-migrate-")]  # pre-migration backup
    c = connect(p)
    assert c.execute("PRAGMA integrity_check").fetchall() == [("ok",)]
    assert c.execute("PRAGMA foreign_key_check").fetchall() == []
    rows = c.execute("SELECT title, code, level, dept, route_reason, status, value_thb FROM approvals ORDER BY code").fetchall()
    assert rows == [("t2", "APR-HQ-0001", "hq", "HQ", "legacy", "expired", None), ("t0", "APR-HQ-0002", "hq", "HQ", "legacy", "approved", None),
                    ("t1", "APR-HQ-0003", "hq", "HQ", "legacy", "pending", None)]  # by created_at; no value -> never AI-decidable
    assert c.execute("SELECT kind, dept, last FROM code_counters").fetchall() == [("approval", "HQ", 3)]
    assert c.execute("SELECT code, dept, priority, due, value_thb FROM tasks").fetchall() == [("TASK-1", None, None, None, None)]
    assert c.execute("SELECT count(*) FROM brainstorm_threads").fetchone()[0] == 1  # FK target kept
    assert c.execute("SELECT max(version) FROM schema_version").fetchone()[0] == HEAD
    n = c.execute("INSERT INTO code_counters (kind, dept, last) VALUES ('approval','HQ',1) ON CONFLICT (kind, dept) DO UPDATE SET last=last+1 RETURNING last").fetchone()[0]
    assert n == 4  # new approvals continue after the backfill
    names = {r[0] for r in c.execute("SELECT name FROM sqlite_master")}
    assert {"settings", "audit_log", "code_counters", "approvals_pending_idx", "approvals_agent_decided_idx", "audit_actor_idx", "tasks_code_idx"} <= names
    c.close()
    assert migrate(p) == HEAD  # idempotent


def test_0003_keeps_audit_rows_and_allows_decide(tmp_path):
    import sqlite3

    import pytest
    p = legacy(tmp_path)
    v2 = tmp_path / "v2"
    v2.mkdir()
    for f in ("0001_phase1.sql", "0002_approvals_routing.sql"):
        shutil.copy(VERSIONS_DIR / f, v2)
    assert migrate(p, v2) == 2
    c = connect(p)
    with pytest.raises(sqlite3.IntegrityError):
        c.execute("INSERT INTO audit_log (scope,ref,action,actor) VALUES ('approval','APR-HQ-0001','decide','cli:a')")
    c.execute("INSERT INTO audit_log (scope,ref,action,field,old_value,new_value,actor) VALUES ('approval','APR-HQ-0001','override','decided_by','agent:x','cli:a','cli:a')")
    before = c.execute("SELECT * FROM audit_log").fetchall()
    c.close()
    assert migrate(p) == HEAD
    c = connect(p)
    assert c.execute("SELECT * FROM audit_log").fetchall() == before
    assert c.execute("PRAGMA integrity_check").fetchall() == [("ok",)]
    assert c.execute("PRAGMA foreign_key_check").fetchall() == []
    assert {"audit_ref_idx", "audit_actor_idx"} <= {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='index'")}
    c.execute("INSERT INTO audit_log (scope,ref,action,actor) VALUES ('approval','APR-HQ-0001','decide','cli:a')")
    c.close()
