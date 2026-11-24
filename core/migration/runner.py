"""Numbered-SQL migration runner (spec §11.6). Forward only; the rollback is the pre-migration backup."""
import os
import sqlite3
from pathlib import Path

from core.db.backup import backup_to
from core.db.sqlite import VERSION_RE, VERSIONS_DIR, DbError, connect, current_version, head_version

SCHEMA_VERSION_DDL = (
    "CREATE TABLE IF NOT EXISTS schema_version ("
    " version INTEGER PRIMARY KEY CHECK (version > 0),"
    " name TEXT NOT NULL,"
    " applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))) STRICT")


def migrate(path: str, versions_dir: Path = VERSIONS_DIR) -> int:
    """Apply every pending NNNN_name.sql, one transaction each; returns the version reached."""
    head = head_version(versions_dir)
    conn = connect(path, create=True)
    try:
        conn.execute(SCHEMA_VERSION_DDL)
        cur = current_version(conn)
        if cur > head:
            raise DbError("schema_ahead")
        if 0 < cur < head:
            backup_to(conn, os.path.join(os.path.dirname(path), "backups"), "pre-migrate")
        for f in sorted(versions_dir.glob("*.sql")):
            n = int(VERSION_RE.match(f.name).group(1))
            if n <= cur:
                continue
            script = (f"BEGIN IMMEDIATE;\n{f.read_text()}\n"
                      f"INSERT INTO schema_version (version, name) VALUES ({n}, '{f.stem}');\nCOMMIT;")
            try:
                conn.executescript(script)
            except sqlite3.Error:
                if conn.in_transaction:
                    conn.execute("ROLLBACK")
                raise DbError(f"migration_failed:{n:04d}") from None
        return head
    finally:
        conn.close()
