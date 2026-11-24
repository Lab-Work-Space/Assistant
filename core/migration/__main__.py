"""python -m core.migration — reads DATABASE_PATH from the process env only. Exit 0 ok, 2 refusal (code on stderr)."""
import os
import sqlite3
import sys

from core.db.sqlite import DbError
from core.migration.runner import migrate

try:
    v = migrate(os.environ.get("DATABASE_PATH", ""))
except DbError as e:
    print(e.code, file=sys.stderr)
    sys.exit(2)
except (sqlite3.Error, OSError) as e:  # rule 16: type only, never a traceback in the journal
    print(f"migration_error:{type(e).__name__}", file=sys.stderr)
    sys.exit(2)
print(f"schema_version={v}")
