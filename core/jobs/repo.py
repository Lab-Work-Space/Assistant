"""jobs table access (SQLite, spec §11.7). No free text is ever written to `error` (spec 10.4)."""
import json
from typing import Any

CLAIM = ("UPDATE jobs SET status='running', started_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), attempts=attempts+1 "
         "WHERE id = (SELECT id FROM jobs WHERE status='queued' AND run_after <= strftime('%Y-%m-%dT%H:%M:%fZ','now') "
         "ORDER BY created_at, rowid LIMIT 1) RETURNING *")
TERMINAL = ("succeeded", "failed", "timed_out", "cancelled")


async def insert(pool, kind: str, payload: dict, created_by: str, timeout_s: int) -> str:
    return await pool.fetchval(
        "INSERT INTO jobs (kind, payload, created_by, timeout_s) VALUES (?1, ?2, ?3, ?4) RETURNING id",
        kind, json.dumps(payload), created_by, timeout_s)


async def claim(pool) -> dict[str, Any] | None:
    return await pool.fetchrow(CLAIM)


async def set_pid(pool, job_id, pid: int) -> None:
    await pool.execute("UPDATE jobs SET pid=?2 WHERE id=?1", job_id, pid)


async def finish(pool, job_id, status: str, error: str | None, exit_code: int | None, result: dict | None) -> dict | None:
    return await pool.fetchrow(
        "UPDATE jobs SET status=?2, error=?3, exit_code=?4, result=?5, "
        "finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), pid=NULL WHERE id=?1 RETURNING *",
        job_id, status, error, exit_code, None if result is None else json.dumps(result))


async def cancel(pool, job_id: str) -> bool:
    """queued -> cancelled directly; running -> cancel_requested. True if the job was found (spec 3.10)."""
    async with pool.transaction() as tx:
        if await tx.fetchval("SELECT 1 FROM jobs WHERE id=?1", job_id) is None:
            return False
        await tx.execute("UPDATE jobs SET status='cancelled', finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') "
                         "WHERE id=?1 AND status='queued'", job_id)
        await tx.execute("UPDATE jobs SET cancel_requested=1 WHERE id=?1 AND status='running'", job_id)
    return True


async def cancel_requested_ids(pool) -> set[str]:
    return {r["id"] for r in await pool.fetch("SELECT id FROM jobs WHERE status='running' AND cancel_requested=1")}


async def get(pool, job_id: str) -> dict | None:
    return await pool.fetchrow("SELECT * FROM jobs WHERE id=?1", job_id)


async def orphan_running(pool) -> int:
    return await pool.execute("UPDATE jobs SET status='failed', error='orphaned', "
                              "finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), pid=NULL WHERE status='running'")
