"""JSON logger with secret masking (spec 5.4 as amended by 10.3, 10.9.5, 10.13.4)."""
import json
import logging
import os
import stat
import sys
import threading
from datetime import datetime, timezone

from core.functions.logs import masking

LIBRARY_LOGGERS = ("httpx", "httpcore", "discord", "discord.gateway", "discord.http", "aiohttp", "mcp")


class LogDirError(Exception):
    pass


def debug_bodies() -> bool:
    """Message-body logging is on only when the PROCESS env says LOG_LEVEL=DEBUG (re-read each call; RC-3)."""
    return os.environ.get("LOG_LEVEL") == "DEBUG"


def prepare_log_dir(path: str) -> str:
    """Create LOG_DIR 0700; refuse symlink, foreign owner or group/other access (10.9.5)."""
    if os.path.islink(path):
        raise LogDirError("log_dir_symlink")
    os.makedirs(path, mode=0o700, exist_ok=True)
    if os.path.islink(path):
        raise LogDirError("log_dir_symlink")
    st = os.stat(path)
    if st.st_uid != os.geteuid() or st.st_mode & 0o077:
        raise LogDirError("log_dir_insecure")
    return path


def _open_log(path: str) -> int:
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode) or st.st_uid != os.geteuid() or st.st_nlink != 1:
        os.close(fd)
        raise LogDirError("log_file_insecure")
    return fd


class Log:
    def __init__(self, log_file: str, stdout: bool = True):
        self.log_file, self.stdout = log_file, stdout  # stdout=False: file only (CLI); True stays default for containers
        self._lock = threading.Lock()
        self.tap = None  # 12.14.4: (level, rendered line) hook for the System forwarder; set only by core/__main__
        self._fd = _open_log(log_file)  # startup may fail; writes never raise

    def _render(self, system: str, message: str, level: str, fields: dict) -> str:
        def failure() -> str:
            return json.dumps({"event": "log.masking_failure", "system": masking.mask_secrets(str(system))})
        try:
            rec = {"ts": datetime.now(timezone.utc).isoformat(), "level": str(level),
                   "system": masking.mask_secrets(str(system)), "event": masking.mask_secrets(str(message)),
                   "fields": masking.mask_obj(fields)}
            line = json.dumps(rec, ensure_ascii=True)
            if any(v in line for v in masking.exact_values()):
                return failure()
            json.loads(line)
            return line
        except Exception:
            return failure()

    def write_log(self, system: str, message: str, level: str = "INFO", **fields) -> None:
        try:
            line = self._render(system, message, level, fields)
            data = (line + "\n").encode()
            with self._lock:
                if self.stdout:
                    sys.stdout.write(data.decode())
                    sys.stdout.flush()
                if self._fd is not None:
                    os.write(self._fd, data)
        except Exception:
            return
        tap, lv = self.tap, str(level).upper()  # S1214-03: after _lock is released, tap read once
        if tap and lv in ("WARNING", "ERROR", "CRITICAL"):
            try:
                tap(lv, line)
            except Exception:
                pass

    def close(self) -> None:
        with self._lock:
            if self._fd is not None:
                os.close(self._fd)
                self._fd = None


class MaskingHandler(logging.Handler):
    """Routes library/root log records through Log with the same masking. No traceback text, type only."""

    def __init__(self, log: Log):
        super().__init__()
        self.log = log

    def emit(self, record: logging.LogRecord) -> None:
        try:
            args = record.args
            if isinstance(args, (dict, tuple)):
                args = masking.mask_obj(args)
            msg = masking.mask_secrets(str(record.msg))
            try:
                text = msg % args if args else msg
            except Exception:
                text = msg
            fields = {"msg": text}
            if record.exc_info and record.exc_info[0]:
                fields["exc_type"] = record.exc_info[0].__name__
            self.log.write_log(record.name, "lib.log", record.levelname, **fields)
        except Exception:
            pass


def install_logging(log: Log, level: str = "INFO") -> MaskingHandler:
    """Startup step 2: masking handler on the root logger, library loggers pinned to WARNING."""
    root = logging.getLogger()
    for h in list(root.handlers):
        if isinstance(h, MaskingHandler):
            root.removeHandler(h)
    h = MaskingHandler(log)
    root.addHandler(h)
    root.setLevel(getattr(logging, str(level).upper(), logging.INFO))
    for n in LIBRARY_LOGGERS:
        logging.getLogger(n).setLevel(logging.WARNING)
    return h
