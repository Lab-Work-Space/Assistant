"""python -m core.migration.retention_main — one-shot retention sweep (OQ-6, run after a restore, before start).
Reads DATABASE_PATH and TASKS_RETENTION_DAYS (default 180, 1..3650) from the env. Exit 0 ok, 2 refusal/failure."""
import os
import sqlite3
import sys

from core.db.sqlite import DbError, connect
from core.migration.retention import sweep_sync


def main() -> int:
    try:
        days = int(os.environ.get("TASKS_RETENTION_DAYS", "180"))
        if not 1 <= days <= 3650:
            raise DbError("bounds:TASKS_RETENTION_DAYS")
        conn = connect(os.environ.get("DATABASE_PATH", ""))
        try:
            if not sweep_sync(conn, days):
                raise DbError("wal_checkpoint_busy")
        finally:
            conn.close()
    except ValueError:
        print("bounds:TASKS_RETENTION_DAYS", file=sys.stderr)
        return 2
    except DbError as e:
        print(e.code, file=sys.stderr)
        return 2
    except (sqlite3.Error, OSError) as e:
        print(f"sweep_failed:{type(e).__name__}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
