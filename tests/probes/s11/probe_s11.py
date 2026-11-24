"""S11 probes P1-P6 (throwaway). Run: .venv/bin/python -W error::DeprecationWarning tests/probes/s11/probe_s11.py"""
import os, sqlite3, sys, tempfile, warnings

print("python", sys.version.split()[0], "sqlite", sqlite3.sqlite_version)
TS = "strftime('%Y-%m-%dT%H:%M:%fZ', {0})"


def p1():
    warnings.simplefilter("error")  # any DeprecationWarning becomes an exception
    c = sqlite3.connect(":memory:", autocommit=True)
    c.execute("CREATE TABLE t(a TEXT, b TEXT)")
    c.execute("INSERT INTO t VALUES (?1, ?2)", ("x", "y"))
    r = c.execute("SELECT a FROM t WHERE b=?2 AND a=?1 AND ?1=?1", ("x", "y")).fetchall()  # reuse
    print("P1", "CONFIRMED (py%d.%d only)" % sys.version_info[:2], r)
    try:  # control: a mismatched style must be what warns/fails, proving the filter works
        c.execute("SELECT :a", ("x",))
    except Exception as e:
        print("P1 control (:name + tuple):", type(e).__name__, e)


def p2_p3():
    c = sqlite3.connect(":memory:")
    ck = lambda col: f"{col} = {TS.format(col)}"
    c.execute(f"CREATE TABLE ts(v TEXT CHECK ({ck('v')}))")
    for v, ok in [("2026-11-23T10:00:00.123Z", 1), ("2026-11-23 10:00:00", 0),
                  ("2026-11-23T10:00:00+00:00", 0), ("2026-11-23T10:00:00.1234Z", 0)]:
        try:
            c.execute("INSERT INTO ts VALUES (?)", (v,)); got = 1
        except sqlite3.IntegrityError:
            got = 0
        print("P2 ts", repr(v), "accepted" if got else "rejected", "OK" if got == ok else "MISMATCH")
    # DEFAULT output passes its own CHECK
    c.execute(f"CREATE TABLE d(v TEXT NOT NULL DEFAULT ({TS.format(chr(39)+'now'+chr(39))}) CHECK ({ck('v')}))")
    c.execute("INSERT INTO d DEFAULT VALUES"); print("P2 default-now self-accept:", c.execute("SELECT v FROM d").fetchone())
    c.execute("CREATE TABLE dy(v TEXT CHECK (v = date(v)))")
    for v, ok in [("2026-11-23", 1), ("2026-11-23T00:00:00", 0)]:
        try:
            c.execute("INSERT INTO dy VALUES (?)", (v,)); got = 1
        except sqlite3.IntegrityError:
            got = 0
        print("P2 day", repr(v), "accepted" if got else "rejected", "OK" if got == ok else "MISMATCH")
    # P3 + the real cli: / kind CHECKs
    c.execute("CREATE TABLE b(v TEXT CHECK (v GLOB 'cli:[a-z]*' AND length(v) BETWEEN 5 AND 36 AND substr(v,5) NOT GLOB '*[^a-z0-9_-]*'))")
    cases = [("cli:a-b", 1), ("cli:a-b_1", 1), ("cli:" + "a" * 32, 1), ("cli:Admin", 0), ("cli:1a", 0),
             ("cli:" + "a" * 33, 0), ("cli:", 0), ("cli:a b", 0), ("cli:a.b", 0)]
    for v, ok in cases:
        try:
            c.execute("INSERT INTO b VALUES (?)", (v,)); got = 1
        except sqlite3.IntegrityError:
            got = 0
        print("P3 cli", repr(v[:12]), "accepted" if got else "rejected", "OK" if got == ok else "MISMATCH")
    d = "discord:"
    c.execute("CREATE TABLE dc(v TEXT CHECK (v GLOB 'discord:*' AND length(v) BETWEEN 25 AND 28 AND substr(v,9) NOT GLOB '*[^0-9]*'))")
    for v, ok in [(d + "1" * 17, 1), (d + "1" * 20, 1), (d + "1" * 16, 0), (d + "1" * 21, 0), (d + "1" * 16 + "x", 0)]:
        try:
            c.execute("INSERT INTO dc VALUES (?)", (v,)); got = 1
        except sqlite3.IntegrityError:
            got = 0
        print("P2 discord len", len(v), "accepted" if got else "rejected", "OK" if got == ok else "MISMATCH")


def mode(p): return oct(os.stat(p).st_mode & 0o777)


def p4_p5_p6():
    old = os.umask(0o077)
    d = tempfile.mkdtemp(); os.chmod(d, 0o700)
    db = os.path.join(d, "e.db")
    os.close(os.open(db, os.O_RDWR | os.O_CREAT | os.O_EXCL | 0o0, 0o600))
    c = sqlite3.connect(f"file:{db}?mode=rw", uri=True, autocommit=True)
    c.execute("PRAGMA journal_mode=WAL"); c.execute("CREATE TABLE t(x)"); c.execute("INSERT INTO t VALUES (1)")
    print("P5 files:", {f: mode(os.path.join(d, f)) for f in sorted(os.listdir(d))})
    # P5 also with permissive umask: does -wal follow DB mode (0600) or umask?
    os.umask(0o022)
    d2 = tempfile.mkdtemp(); db2 = os.path.join(d2, "e.db")
    os.close(os.open(db2, os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600))
    c2 = sqlite3.connect(db2, autocommit=True); c2.execute("PRAGMA journal_mode=WAL"); c2.execute("CREATE TABLE t(x)")
    print("P5 (umask 022, db 0600):", {f: mode(os.path.join(d2, f)) for f in sorted(os.listdir(d2))})
    os.umask(0o077)
    # P4
    bd = tempfile.mkdtemp(); os.chmod(bd, 0o700); out = os.path.join(bd, "b.db")
    os.close(os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600))
    try:
        c.execute("VACUUM INTO ?", (out,))
        k = sqlite3.connect(f"file:{out}?mode=ro", uri=True)
        print("P4 VACUUM INTO empty 0600 file: ok, mode", mode(out), "integrity", k.execute("PRAGMA integrity_check").fetchone()[0],
              "rows", k.execute("SELECT count(*) FROM t").fetchone()[0])
    except sqlite3.Error as e:
        print("P4 REFUTED:", type(e).__name__, e)
    # P4 control: 0600 file vs umask 022 with VACUUM INTO on non-existent path
    os.umask(0o022); out2 = os.path.join(bd, "c.db"); c.execute("VACUUM INTO ?", (out2,))
    print("P4 control (nonexistent path, umask 022) mode", mode(out2))
    # P6
    seen = []
    def auth(a, a1, a2, db_, src):
        if a == sqlite3.SQLITE_PRAGMA: seen.append((a1, a2))
        return sqlite3.SQLITE_OK
    c.set_authorizer(auth)
    for sql in ("PRAGMA wal_checkpoint(TRUNCATE)", "PRAGMA WAL_CHECKPOINT(PASSIVE)", "PRAGMA wal_checkpoint", "PRAGMA journal_mode"):
        c.execute(sql).fetchall()
    print("P6 authorizer PRAGMA (arg1,arg2):", seen)
    os.umask(old)


for f in (p1, p2_p3, p4_p5_p6): f()
