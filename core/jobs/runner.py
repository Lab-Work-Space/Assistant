"""DB-backed subprocess job runner (spec 3.10 as amended by 10.4, 10.6 and 11.12).

Isolation limit (11.12.1): jobs receive no secrets except `kind.env_secrets` (never DISCORD_BOT_TOKEN or
DATABASE_PATH), never touch the database (the parent alone reads and writes job rows; workers speak JSON on
stdin/stdout), and inherit the systemd sandbox of employee.service. A worker runs under the bot's uid, so it
can still read the bot's environment (/proc/<ppid>/environ), open DATABASE_PATH and its -wal/-shm and
backups/ (read and write), and read/write KNOWLEDGE_DIR and LOG_DIR. That is acceptable only while every job
kind is first-party code and parses no untrusted container or codec format. Any kind that decodes
user-supplied containers/codecs/attachments, fetches URLs, or runs third-party or agent-chosen code must run in
the phase-2 isolated unit (spec 11.12.3) before merge; a uid change from the bot is impossible
(CapabilityBoundingSet= empty, NoNewPrivileges). Checklist item for every PR adding a file to core/jobs/kinds/.
"""
import asyncio
import hashlib
import json
import logging
import os
import re
import shutil
import signal
import sys
import tempfile
from typing import Any, Awaitable, Callable

from core.config import PROJECT_ROOT
from core.interfaces import JobKind
from core.jobs import repo
from core.migration import retention

log = logging.getLogger(__name__)
KIND_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
PROGRESS_RE = re.compile(r"^[a-z_]{1,40}$")
ERROR_RE = re.compile(r"^(?:[A-Za-z_][A-Za-z0-9_]{0,80}:[a-z_]{1,40}|kind_not_allowed)$")
STDERR_CAP = 64 * 1024
SWEEP_INTERVAL_S = 86400


def _rm_job_dir(path: str) -> None:
    """rmtree only a direct emp-job-* child of the mkdtemp base."""
    real = os.path.realpath(path)
    if os.path.dirname(real) == os.path.realpath(tempfile.gettempdir()) and os.path.basename(real).startswith("emp-job-"):
        shutil.rmtree(real, ignore_errors=True)


class PgJobRunner:
    def __init__(self, pool, config, sweep_interval_s: float = SWEEP_INTERVAL_S):
        self.pool, self.cfg = pool, config
        self._kinds: dict[str, JobKind] = {}
        self._procs: dict[str, asyncio.subprocess.Process] = {}
        self._cancelled: set[str] = set()
        self._tasks: set[asyncio.Task] = set()
        self._loops: list[asyncio.Task] = []
        self._sweeps: list[Callable[[], Awaitable[Any]]] = []
        self._sweep_interval = sweep_interval_s
        self._stopping = False

    # --- JobRunner protocol ---
    def register_kind(self, kind: JobKind) -> None:
        if not KIND_RE.match(kind.name):
            raise ValueError("kind_invalid")
        if {"DATABASE_PATH", "DISCORD_BOT_TOKEN"} & set(kind.env_secrets):
            raise ValueError("kind_invalid")
        self._kinds[kind.name] = kind

    def add_sweep(self, fn: Callable[[], Awaitable[Any]]) -> None:
        """Extra daily sweep (e.g. TASK-014 meetings purge via KnowledgeStore.purge_older_than)."""
        self._sweeps.append(fn)

    async def enqueue(self, kind: str, payload: dict[str, Any], created_by: str, timeout_s: int | None = None) -> str:
        if kind not in self._kinds:
            raise ValueError("kind_not_allowed")
        t = timeout_s or self._kinds[kind].timeout_s or self.cfg.job_default_timeout_s
        return await repo.insert(self.pool, kind, payload, created_by, max(1, min(3600, int(t))))

    async def cancel(self, job_id: str) -> bool:
        return await repo.cancel(self.pool, job_id)

    async def wait(self, job_id: str, timeout_s: float | None = None) -> dict[str, Any]:
        async def poll():
            while True:
                row = await repo.get(self.pool, job_id)
                if row is None:
                    raise KeyError("job_not_found")
                if row["status"] in repo.TERMINAL:
                    return row
                await asyncio.sleep(0.1)
        return await asyncio.wait_for(poll(), timeout_s)

    # --- lifecycle ---
    async def start(self) -> None:
        n = await repo.orphan_running(self.pool)  # single bot process: leftovers of a crashed bot
        if n:
            log.warning("job.orphaned count=%d", n)
        self._loops = [asyncio.create_task(self._claim_loop()), asyncio.create_task(self._cancel_watch()),
                       asyncio.create_task(self._sweeper())]

    async def stop(self) -> None:
        self._stopping = True  # loops may see a closing pool: not an error from here on
        for t in self._loops:
            t.cancel()
        await asyncio.gather(*self._loops, return_exceptions=True)
        for jid in list(self._procs):
            self._cancelled.add(jid)
            await self._kill(self._procs[jid])
        await asyncio.gather(*self._tasks, return_exceptions=True)

    # --- loops ---
    async def _claim_loop(self) -> None:
        while True:
            try:
                if len(self._tasks) < self.cfg.job_max_concurrency:
                    row = await repo.claim(self.pool)
                    if row:
                        t = asyncio.create_task(self._run(row))
                        self._tasks.add(t)
                        t.add_done_callback(self._tasks.discard)
                        continue
            except asyncio.CancelledError:
                raise
            except Exception as e:
                if not self._stopping:
                    log.error("job.claim_error exc_type=%s", type(e).__name__)
            await asyncio.sleep(self.cfg.job_poll_interval_s)

    async def _cancel_watch(self) -> None:
        while True:
            await asyncio.sleep(1)
            try:
                for jid in await repo.cancel_requested_ids(self.pool):
                    if jid in self._procs:
                        self._cancelled.add(jid)
                        await self._kill(self._procs[jid])
            except asyncio.CancelledError:
                raise
            except Exception as e:
                log.error("job.cancel_watch_error exc_type=%s", type(e).__name__)

    async def sweep_once(self) -> None:
        c = self.cfg
        stmts = [(retention.CONVERSATION_STATE, ()), (retention.JOBS, ()), (retention.USAGE_EVENTS, ()),
                 (retention.TASKS, (c.tasks_retention_days,)), (retention.BRAINSTORM_THREADS, (c.tasks_retention_days,))]
        for sql, args in stmts:
            try:
                await self.pool.execute(sql, *args)
            except Exception as e:
                if not self._stopping:
                    log.error("job.sweep_error exc_type=%s", type(e).__name__)
        try:
            if not await retention.checkpoint(self.pool):
                log.error("job.sweep_error exc_type=wal_checkpoint_busy")
        except Exception as e:
            if not self._stopping:
                log.error("job.sweep_error exc_type=%s", type(e).__name__)
        for fn in self._sweeps:
            try:
                await fn()
            except Exception as e:
                if not self._stopping:
                    log.error("job.sweep_error exc_type=%s", type(e).__name__)

    async def _sweeper(self) -> None:
        while True:
            await self.sweep_once()
            await asyncio.sleep(self._sweep_interval)

    # --- one job ---
    def _env(self, kind: JobKind | None) -> dict[str, str]:
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": os.environ.get("LANG", "C.UTF-8"),
               "TZ": os.environ.get("TZ", "UTC"), "PYTHONPATH": str(PROJECT_ROOT),
               "JOB_MEMORY_LIMIT_MB": str(self.cfg.job_memory_limit_mb)}
        if os.environ.get("LOG_LEVEL"):
            env["LOG_LEVEL"] = os.environ["LOG_LEVEL"]
        for k in (kind.env_secrets if kind else ()):
            if k in os.environ:
                env[k] = os.environ[k]
        return env

    async def _kill(self, proc) -> None:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
            try:
                await asyncio.wait_for(proc.wait(), 5)
            except asyncio.TimeoutError:
                pass
            os.killpg(proc.pid, signal.SIGKILL)  # also reaps stragglers in the group
        except (ProcessLookupError, PermissionError):
            pass

    async def _run(self, row: dict) -> None:
        jid = str(row["id"])
        kind = self._kinds.get(row["kind"])
        status, error, code, result = "failed", "internal_error", None, None
        cwd = tempfile.mkdtemp(prefix="emp-job-")
        proc = None
        try:
            env = self._env(kind)
            env["JOB_CPU_LIMIT_S"] = str(row["timeout_s"] + 5)
            proc = await asyncio.create_subprocess_exec(
                sys.executable, "-m", "core.jobs.worker_entry", stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, cwd=cwd, env=env,
                start_new_session=True)
            self._procs[jid] = proc
            await repo.set_pid(self.pool, jid, proc.pid)
            payload = row["payload"]
            payload = json.loads(payload) if isinstance(payload, str) else payload
            proc.stdin.write((json.dumps({"job_id": jid, "kind": row["kind"], "payload": payload,
                                          "allowed_kinds": sorted(self._kinds)}) + "\n").encode())
            try:
                await proc.stdin.drain()
                proc.stdin.close()
            except (BrokenPipeError, ConnectionResetError):
                pass
            out = await self._supervise(jid, proc, row["timeout_s"])
            status, error, code, result = out
        except asyncio.CancelledError:
            status, error = "cancelled", None
        except Exception as e:
            log.error("job.run_error job_id=%s exc_type=%s", jid, type(e).__name__)
        finally:
            if proc is not None:
                await self._kill(proc)
            self._procs.pop(jid, None)
            self._cancelled.discard(jid)
            _rm_job_dir(cwd)
        try:
            done = await repo.finish(self.pool, jid, status, error, code, result)
        except Exception as e:
            log.error("job.finish_error job_id=%s exc_type=%s", jid, type(e).__name__)
            return
        if kind and kind.on_done:
            try:
                await kind.on_done(done)
            except Exception as e:
                log.error("job.on_done_error job_id=%s exc_type=%s", jid, type(e).__name__)

    async def _supervise(self, jid: str, proc, timeout_s: int):
        cap = self.cfg.job_output_cap_bytes
        buf, over = bytearray(), False

        async def read_out():
            nonlocal over
            while chunk := await proc.stdout.read(65536):
                buf.extend(chunk)
                if len(buf) > cap:
                    over = True
                    await self._kill(proc)
                    return

        err = {"n": 0, "h": hashlib.sha256()}

        async def read_err():
            while chunk := await proc.stderr.read(65536):
                room = STDERR_CAP - err["n"]  # bytes beyond the cap are drained and discarded
                if room > 0:
                    err["n"] += len(chunk[:room])
                    err["h"].update(chunk[:room])

        timed_out = False
        try:
            await asyncio.wait_for(asyncio.gather(read_out(), read_err(), proc.wait()), timeout_s)
        except asyncio.TimeoutError:
            timed_out = True
            await self._kill(proc)
        if err["n"]:
            log.warning("job.stderr job_id=%s bytes=%d sha256=%s", jid, err["n"], err["h"].hexdigest())
        code = proc.returncode
        if jid in self._cancelled:
            return "cancelled", None, code, None
        if timed_out:
            return "timed_out", None, code, None
        if over:
            return "failed", "output_cap_exceeded", code, None
        res, dropped = None, 0
        for line in bytes(buf).splitlines():
            try:
                o = json.loads(line)
            except ValueError:
                continue
            if not isinstance(o, dict):
                continue
            if o.get("type") == "result":
                res = o
            elif o.get("type") == "progress" and not (isinstance(o.get("msg"), str) and PROGRESS_RE.match(o["msg"])):
                dropped += 1
        if dropped:
            log.warning("job.progress_dropped job_id=%s count=%d", jid, dropped)
        if res is not None:
            if res.get("ok") is True and code == 0:
                data = res.get("data")
                return "succeeded", None, code, data if isinstance(data, dict) else {}
            e = res.get("error")
            return "failed", e if isinstance(e, str) and ERROR_RE.match(e) else "worker_error", code, None
        if code is not None and code < 0:
            return "failed", f"signal:{-code}", code, None
        return "failed", f"exit:{code}" if code else "no_result", code, None
