"""SQLite access (spec §11.3). One connection on one worker thread behind one asyncio.Lock, so every
statement and every transaction is serialized. The API mirrors a small async DB API subset the repos used."""
import asyncio
import json
import os
import re
import sqlite3
import stat
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
VERSIONS_DIR = PROJECT_ROOT / "core" / "migration" / "versions"
VERSION_RE = re.compile(r"^(\d{4})_[a-z0-9_]{1,60}\.sql$")
MIN_SQLITE = (3, 37, 0)  # RETURNING needs 3.35, STRICT tables 3.37
JSON_COLS = frozenset({"participants", "access", "payload", "result", "other_depts"})
NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"
_DENY = frozenset(getattr(sqlite3, n) for n in (
    "SQLITE_CREATE_INDEX", "SQLITE_CREATE_TABLE", "SQLITE_CREATE_TEMP_INDEX", "SQLITE_CREATE_TEMP_TABLE",
    "SQLITE_CREATE_TEMP_TRIGGER", "SQLITE_CREATE_TEMP_VIEW", "SQLITE_CREATE_TRIGGER", "SQLITE_CREATE_VIEW",
    "SQLITE_CREATE_VTABLE", "SQLITE_DROP_INDEX", "SQLITE_DROP_TABLE", "SQLITE_DROP_TEMP_INDEX",
    "SQLITE_DROP_TEMP_TABLE", "SQLITE_DROP_TEMP_TRIGGER", "SQLITE_DROP_TEMP_VIEW", "SQLITE_DROP_TRIGGER",
    "SQLITE_DROP_VIEW", "SQLITE_DROP_VTABLE", "SQLITE_ALTER_TABLE", "SQLITE_ATTACH", "SQLITE_DETACH",
    "SQLITE_REINDEX", "SQLITE_ANALYZE"))


class DbError(Exception):
    """Startup refusal; .code is the stable string printed on exit."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _private(p: str, want_dir: bool) -> bool:
    st = os.lstat(p)
    kind_ok = stat.S_ISDIR(st.st_mode) if want_dir else stat.S_ISREG(st.st_mode)
    return kind_ok and st.st_uid == os.geteuid() and not st.st_mode & 0o077


def validate_db_path(path: str, forbidden=()) -> str:
    """Absolute, not a symlink, outside PROJECT_ROOT and `forbidden`, in a 0700 dir owned by the euid;
    the db, -wal and -shm files (when present) are regular, owned by the euid, mode & 0o077 == 0."""
    bad = DbError("db_path_invalid")
    if not path or not os.path.isabs(path) or os.path.islink(path) or os.path.islink(os.path.dirname(path)):
        raise bad
    real = os.path.realpath(path)
    for base in (PROJECT_ROOT, *forbidden):
        b = os.path.realpath(base)
        if real == b or real.startswith(b + os.sep):
            raise bad
    d = os.path.dirname(path)
    os.makedirs(d, mode=0o700, exist_ok=True)
    if not _private(d, True):
        raise bad
    for f in (path, path + "-wal", path + "-shm"):
        if os.path.lexists(f) and not _private(f, False):
            raise bad
    return path


def connect(path: str, create: bool = False) -> sqlite3.Connection:
    """Configured connection WITHOUT the authorizer (migration, backup, and the base of open_database)."""
    if sqlite3.sqlite_version_info < MIN_SQLITE:
        raise DbError("sqlite_too_old")
    validate_db_path(path)
    if create and not os.path.lexists(path):
        os.close(os.open(path, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600))
    try:
        conn = sqlite3.connect(f"file:{quote(path)}?mode=rw", uri=True, autocommit=True)
    except sqlite3.OperationalError:
        raise DbError("db_path_invalid") from None
    try:
        # S11-09: the target's SQLite build options differ; do not rely on compile-time defaults.
        conn.setconfig(sqlite3.SQLITE_DBCONFIG_DEFENSIVE, True)
        conn.setconfig(sqlite3.SQLITE_DBCONFIG_ENABLE_FTS3_TOKENIZER, False)
        mode = conn.execute("PRAGMA journal_mode=WAL").fetchone()[0]
        for p in ("foreign_keys=ON", "busy_timeout=5000", "synchronous=FULL", "secure_delete=ON",
                  "trusted_schema=OFF", "temp_store=MEMORY"):
            conn.execute("PRAGMA " + p)
        ok = (conn.getconfig(sqlite3.SQLITE_DBCONFIG_DEFENSIVE)
              and not conn.getconfig(sqlite3.SQLITE_DBCONFIG_ENABLE_FTS3_TOKENIZER)
              and mode == "wal" and conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1
              and conn.execute("SELECT json_valid('[]')").fetchone()[0] == 1)
    except sqlite3.Error:
        ok = False
    if not ok:
        conn.close()
        raise DbError("db_pragma_failed")
    validate_db_path(path)  # -wal/-shm may exist now: same owner and private mode
    return conn


def head_version(versions_dir: Path = VERSIONS_DIR) -> int:
    nums = []
    for p in versions_dir.glob("*.sql"):
        m = VERSION_RE.match(p.name)
        if not m:
            raise DbError("migration_name_invalid")
        nums.append(int(m.group(1)))
    nums.sort()
    if nums != list(range(1, len(nums) + 1)):
        raise DbError("migration_gap")
    return len(nums)


def current_version(conn: sqlite3.Connection) -> int:
    if conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_version'").fetchone() is None:
        return 0
    return conn.execute("SELECT coalesce(max(version), 0) FROM schema_version").fetchone()[0]


def _authorizer(action, arg1, arg2, dbname, source):
    if action in _DENY:
        return sqlite3.SQLITE_DENY
    if action in (sqlite3.SQLITE_INSERT, sqlite3.SQLITE_UPDATE, sqlite3.SQLITE_DELETE) and arg1 == "schema_version":
        return sqlite3.SQLITE_DENY  # G2S11-04: only the migration connection may touch it
    if action == sqlite3.SQLITE_PRAGMA and (arg1 or "").lower() != "wal_checkpoint":
        return sqlite3.SQLITE_DENY
    return sqlite3.SQLITE_OK


def _open_runtime(path: str) -> sqlite3.Connection:
    conn = connect(path)
    try:
        if current_version(conn) != head_version():
            raise DbError("schema_not_head")
        conn.set_authorizer(_authorizer)
    except BaseException:
        conn.close()
        raise
    return conn


def _row(names, values) -> dict[str, Any]:
    d = dict(zip(names, values))
    for k in JSON_COLS.intersection(d):
        if isinstance(d[k], str):
            d[k] = json.loads(d[k])
    return d


def utc_text(dt: datetime) -> str:
    """Python-side timestamp in the exact NOW format. dt must be timezone-aware."""
    if dt.tzinfo is None:
        raise ValueError("naive_datetime")
    u = dt.astimezone(timezone.utc)
    return u.strftime("%Y-%m-%dT%H:%M:%S.") + f"{u.microsecond // 1000:03d}Z"


class _Api:
    async def _exec(self, sql: str, args: tuple):  # -> (rowcount, rows)
        raise NotImplementedError

    async def execute(self, sql: str, *args) -> int:
        return (await self._exec(sql, args))[0]

    async def fetch(self, sql: str, *args) -> list[dict[str, Any]]:
        return (await self._exec(sql, args))[1]

    async def fetchrow(self, sql: str, *args) -> dict[str, Any] | None:
        rows = (await self._exec(sql, args))[1]
        return rows[0] if rows else None

    async def fetchval(self, sql: str, *args) -> Any:
        row = await self.fetchrow(sql, *args)
        return next(iter(row.values())) if row else None


class Database(_Api):
    def __init__(self, conn: sqlite3.Connection, ex: ThreadPoolExecutor):
        self._conn, self._ex, self._lock = conn, ex, asyncio.Lock()

    def _run(self, fn, *a):
        return asyncio.get_running_loop().run_in_executor(self._ex, fn, *a)

    def _q(self, sql, args):  # db thread only
        cur = self._conn.execute(sql, args)
        try:
            rows = cur.fetchall()  # drain: a RETURNING statement completes only when stepped to the end
            if cur.description is None:
                return cur.rowcount, []
            names = [c[0] for c in cur.description]
            return cur.rowcount, [_row(names, r) for r in rows]
        finally:
            cur.close()

    def _rollback(self):  # db thread only
        if self._conn.in_transaction:
            self._conn.execute("ROLLBACK")

    async def _exec(self, sql, args):
        async with self._lock:
            return await self._run(self._q, sql, args)

    @asynccontextmanager
    async def transaction(self):
        """BEGIN IMMEDIATE ... COMMIT under the lock. Inside, use only the yielded handle (self.* deadlocks)
        and await nothing but the handle (no provider, Discord, presenter or sleep calls)."""
        async with self._lock:
            try:
                await asyncio.shield(self._run(self._conn.execute, "BEGIN IMMEDIATE"))
                yield _Tx(self)
                await asyncio.shield(self._run(self._conn.execute, "COMMIT"))
            except BaseException:
                await asyncio.shield(self._run(self._rollback))
                raise

    async def close(self) -> None:
        async with self._lock:
            await self._run(self._conn.close)
        self._ex.shutdown(wait=True)


class _Tx(_Api):
    def __init__(self, db: Database):
        self._db = db

    async def _exec(self, sql, args):
        return await self._db._run(self._db._q, sql, args)


async def open_database(path: str) -> Database:
    """Runtime connection: PRAGMAs, schema at head, authorizer on. Raises DbError(code)."""
    ex = ThreadPoolExecutor(max_workers=1, thread_name_prefix="emp-db")
    try:
        conn = await asyncio.get_running_loop().run_in_executor(ex, _open_runtime, path)
    except BaseException:
        ex.shutdown(wait=False)
        raise
    return Database(conn, ex)
