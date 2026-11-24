"""Online backup (spec §11.8). `python -m core.db.backup` writes a daily backup of DATABASE_PATH.
Exit 0 ok, 2 refusal (code on stderr)."""
import os
import re
import shutil
import logging
import sqlite3
import stat
import sys
import tarfile
import tempfile
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

from core.migration import retention
from core.db.sqlite import DbError, _private, connect

log = logging.getLogger(__name__)
BACKUP_KEEP = 14


def backup_to(conn: sqlite3.Connection, dir_: str, prefix: str, keep: int = BACKUP_KEEP) -> str:
    """VACUUM INTO a new 0600 file in a 0700 dir, verify integrity, keep the newest `keep` files of this prefix."""
    os.makedirs(dir_, mode=0o700, exist_ok=True)
    if os.path.islink(dir_) or not _private(dir_, True):
        raise DbError("backup_dir_invalid")
    out = os.path.join(dir_, f"{prefix}-{datetime.now(timezone.utc):%Y%m%dT%H%M%S%fZ}.db")
    os.close(os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600))
    try:
        conn.execute("VACUUM INTO ?", (out,))
        chk = sqlite3.connect(f"file:{quote(out)}?mode=ro", uri=True)
        try:
            ok = chk.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        finally:
            chk.close()
    except sqlite3.Error:
        ok = False
    if not ok:
        os.unlink(out)
        raise DbError("backup_failed")
    names = sorted(n for n in os.listdir(dir_) if n.startswith(prefix + "-") and n.endswith(".db"))
    for n in names[:-keep]:
        os.unlink(os.path.join(dir_, n))
    _prune_old(dir_, keep)
    return out


def _prune_old(dir_: str, days: int) -> None:
    """S11-03: erased/expired rows must not outlive `days` in any backup, whatever its prefix."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    for n in os.listdir(dir_):
        m = re.fullmatch(r"(?:daily|pre-migrate|knowledge)-(\d{8}T\d{12}Z)\.(?:db|tar\.gz)", n)
        if m and datetime.strptime(m[1], "%Y%m%dT%H%M%S%fZ").replace(tzinfo=timezone.utc) < cutoff:
            os.unlink(os.path.join(dir_, n))


def backup_knowledge(src: str, dir_: str, days: int = BACKUP_KEEP) -> str:
    """Archive `src` as knowledge-<ts>.tar.gz (0600, relative paths). Symlinks/special files are skipped (count logged)."""
    if not os.path.isdir(src) or os.path.islink(src):
        raise DbError("knowledge_dir_invalid")
    os.makedirs(dir_, mode=0o700, exist_ok=True)
    if os.path.islink(dir_) or not _private(dir_, True):
        raise DbError("backup_dir_invalid")
    out = os.path.join(dir_, f"knowledge-{datetime.now(timezone.utc):%Y%m%dT%H%M%S%fZ}.tar.gz")
    fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        want, skipped = 0, 0
        with os.fdopen(fd, "wb") as f, tarfile.open(fileobj=f, mode="w:gz") as t:
            for root, dirs, files in os.walk(src):  # followlinks=False; symlinked dirs are listed in dirs
                dirs[:] = [n for n in dirs if not n.startswith(".tmp-")]  # S1119-06: in-flight writes
                for n in dirs + [f for f in files if not f.startswith(".tmp-")]:
                    p = os.path.join(root, n)
                    st = os.lstat(p)
                    if not (stat.S_ISREG(st.st_mode) or stat.S_ISDIR(st.st_mode)):
                        skipped += 1
                        if n in dirs:
                            dirs.remove(n)
                        continue
                    t.add(p, arcname=os.path.relpath(p, src), recursive=False)
                    want += 1
        with tarfile.open(out) as t:
            if len(t.getnames()) != want:
                raise DbError("backup_failed")
    except (OSError, tarfile.TarError, DbError):
        os.unlink(out)
        raise DbError("backup_failed") from None
    if skipped:
        log.warning("backup.knowledge_skipped count=%d", skipped)
    _prune_old(dir_, days)
    return out


def restore_knowledge(archive: str, dest: str) -> None:
    """Extract into a fresh 0700 sibling temp dir (links/absolute/.. rejected), then swap; the old dir is deleted on success (erased data must not outlive the bound), renamed back on failure."""
    dest = dest.rstrip("/")
    tmp = tempfile.mkdtemp(prefix=os.path.basename(dest) + ".restore-", dir=os.path.dirname(dest))
    try:
        with tarfile.open(archive) as t:
            for m in t.getmembers():
                parts = m.name.split("/")
                if m.name.startswith("/") or ".." in parts or not (m.isfile() or m.isdir()):
                    raise DbError("restore_failed")
            t.extractall(tmp, filter="data")
        old = None
        if os.path.lexists(dest):
            old = f"{dest}.old-{datetime.now(timezone.utc):%Y%m%dT%H%M%S%fZ}"
            os.rename(dest, old)
        try:
            os.rename(tmp, dest)
        except OSError:
            if old:
                os.rename(old, dest)  # S1119-02: never leave dest missing
            raise
        if old:
            shutil.rmtree(old, ignore_errors=True)
    except (OSError, tarfile.TarError, DbError):
        shutil.rmtree(tmp, ignore_errors=True)
        raise DbError("restore_failed") from None


def consent_gap_path(database_path: str) -> str:
    """Single definition of the consent_gap marker location (writer here, reader in core.voice.notice)."""
    return os.path.join(os.path.dirname(database_path), "consent_gap")


def restore(backup: str, path: str, tasks_days: int, allow_optout_gap: bool = False) -> None:
    """S11-03 restore (service stopped), all-or-nothing: verify a private copy, re-apply the current opt-outs
    into it, and only then replace the live DB. OQ-9: an unreadable/missing current DB refuses unless
    `allow_optout_gap`, which writes the `consent_gap` marker (voice must stay off until the owner clears it)."""
    optouts, gap = [], False
    try:
        cur = connect(path)
        try:
            optouts = cur.execute("SELECT guild_id, user_id, source, opted_out_at FROM voice_optouts").fetchall()
        finally:
            cur.close()
    except (sqlite3.Error, DbError):
        gap = True
    if gap and not allow_optout_gap:
        raise DbError("restore_export_failed")  # never restore over an unreadable opt-out list
    tmp = path + ".restore"
    marker = consent_gap_path(path)
    try:
        with open(backup, "rb") as src, os.fdopen(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
                                                       | os.O_CLOEXEC, 0o600), "wb") as dst:
            shutil.copyfileobj(src, dst)
        conn = connect(tmp)
        try:
            if conn.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise DbError("restore_failed")
            conn.executemany("INSERT OR IGNORE INTO voice_optouts (guild_id, user_id, source, opted_out_at) "
                             "VALUES (?1, ?2, ?3, ?4)", optouts)
            if conn.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise DbError("restore_failed")
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        finally:
            conn.close()
        if gap:
            fd = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
            with os.fdopen(fd, "w") as f:
                f.write(datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z\n")
            log.warning("restore.optout_gap")
        for ext in ("-wal", "-shm"):  # S11-01 order: drop the old WAL first, so a crash cannot replay it into the restored file
            if os.path.lexists(path + ext):
                os.unlink(path + ext)
        os.replace(tmp, path)
    except (sqlite3.Error, OSError, DbError) as e:
        for x in ("", "-wal", "-shm"):
            if os.path.lexists(tmp + x):
                os.unlink(tmp + x)
        raise e if isinstance(e, DbError) else DbError("restore_failed") from None
    conn = connect(path)
    try:
        retention.sweep_sync(conn, tasks_days)
    finally:
        conn.close()


if __name__ == "__main__":
    try:
        path = os.environ.get("DATABASE_PATH", "")
        kdir = os.environ.get("KNOWLEDGE_DIR", "/var/lib/employee/knowledge")
        if sys.argv[1:2] == ["restore-knowledge"]:
            if len(sys.argv) != 3 or not re.fullmatch(r"knowledge-\d{8}T\d{12}Z\.tar\.gz", sys.argv[2]):
                raise DbError("bad_backup_name")
            restore_knowledge(os.path.join(os.path.dirname(path), "backups", sys.argv[2]), kdir)
            sys.exit(0)
        if sys.argv[1:2] == ["restore"]:
            args = sys.argv[2:]
            flag = "--allow-optout-gap" in args
            names = [a for a in args if a != "--allow-optout-gap"]
            if len(names) != 1 or "/" in names[0] or not names[0]:
                raise DbError("bad_backup_name")
            days = int(os.environ.get("TASKS_RETENTION_DAYS", "180"))
            if not 1 <= days <= 3650:  # same bound as Config and retention_main; 0 would delete every finished task
                raise DbError("bounds:TASKS_RETENTION_DAYS")
            restore(os.path.join(os.path.dirname(path), "backups", names[0]), path, days, allow_optout_gap=flag)
            sys.exit(0)
        c = connect(path)
        try:
            print(backup_to(c, os.path.join(os.path.dirname(path), "backups"), "daily"))
        finally:
            c.close()
        print(backup_knowledge(kdir, os.path.join(os.path.dirname(path), "backups")))
    except DbError as e:
        print(e.code, file=sys.stderr)
        sys.exit(2)
    except (sqlite3.Error, OSError, ValueError) as e:  # rule 16: type only, never the message or a traceback
        print(f"backup_error:{type(e).__name__}", file=sys.stderr)
        sys.exit(2)
