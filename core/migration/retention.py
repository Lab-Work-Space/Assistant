"""Retention sweeper SQL (spec §11.8; 5.3 + 10.10.6). TASK-011 schedules it daily. Params are SQLite ?N."""

CONVERSATION_STATE = "DELETE FROM conversation_state WHERE last_reply_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')"
JOBS = "DELETE FROM jobs WHERE finished_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days')"
USAGE_EVENTS = "DELETE FROM usage_events WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-400 days')"
# ?1 = TASKS_RETENTION_DAYS
TASKS = ("DELETE FROM tasks WHERE status IN ('done','failed','cancelled') "
         "AND updated_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-' || ?1 || ' days')")
BRAINSTORM_THREADS = ("DELETE FROM brainstorm_threads WHERE status IN ('closed','aborted') "
                      "AND closed_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-' || ?1 || ' days')")
# Last: copy freed (secure_delete-zeroed) pages from the WAL into the main file and truncate the WAL.
WAL_CHECKPOINT = "PRAGMA wal_checkpoint(TRUNCATE)"
# Voice audit tables (voice_sessions, voice_optouts, voice_notice_deliveries): kept 400 days, no sweep SQL in phase 1.

# S11-03: row 0 of the checkpoint result is `busy`; 1 means a reader (e.g. a backup) blocked the truncate.
import logging
import sqlite3
import time

CHECKPOINT_RETRIES, CHECKPOINT_DELAY_S = 5, 2.0
log = logging.getLogger(__name__)


def sweep_sync(conn: sqlite3.Connection, tasks_days: int, delay: float = CHECKPOINT_DELAY_S) -> bool:
    """Blocking sweep on a plain connection (restore path). Returns False when the checkpoint stayed busy."""
    for sql, args in ((CONVERSATION_STATE, ()), (JOBS, ()), (USAGE_EVENTS, ()),
                      (TASKS, (tasks_days,)), (BRAINSTORM_THREADS, (tasks_days,))):
        conn.execute(sql, args)
    for _ in range(CHECKPOINT_RETRIES):
        if conn.execute(WAL_CHECKPOINT).fetchone()[0] == 0:
            return True
        time.sleep(delay)
    log.error("wal_checkpoint_busy")
    return False


async def checkpoint(db, delay: float = CHECKPOINT_DELAY_S) -> bool:
    """Async checkpoint for the scheduled sweep: retry while busy, else log `wal_checkpoint_busy` and return False."""
    import asyncio
    for _ in range(CHECKPOINT_RETRIES):
        if (await db.fetchrow(WAL_CHECKPOINT))["busy"] == 0:
            return True
        await asyncio.sleep(delay)
    log.error("wal_checkpoint_busy")
    return False
