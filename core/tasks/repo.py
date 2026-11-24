"""SQLite queries for tasks and brainstorm_threads (spec §11.7). Parameterised only."""
import json
from datetime import datetime
from zoneinfo import ZoneInfo

from core.db.sqlite import utc_text

TERMINAL = ("closed", "aborted")


class Repo:
    def __init__(self, pool):
        self.db = pool

    async def insert_task(self, *, guild_id, channel_id, title, description, kind, by_id, assignee, dept="HQ",
                           priority=None, due=None, value_thb=None):
        """Allocates <DEPT>-<NNNN> from the per-department counter in the same transaction as the INSERT."""
        async with self.db.transaction() as tx:
            n = await tx.fetchval("INSERT INTO code_counters (kind, dept, last) VALUES ('task', ?1, 1) "
                                  "ON CONFLICT (kind, dept) DO UPDATE SET last = last + 1 RETURNING last", dept)
            return await tx.fetchrow(
                "INSERT INTO tasks (guild_id, origin_channel_id, title, description, created_by_kind, created_by_id,"
                " assignee_agent, code, dept, priority, due, value_thb) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)"
                " RETURNING *", guild_id, channel_id, title, description, kind, by_id, assignee, f"{dept}-{n:04d}",
                dept, priority, due, value_thb)

    async def task_by_code(self, code):
        return await self.db.fetchrow("SELECT * FROM tasks WHERE code=?1", code)

    async def link_task_thread(self, task, *, thread_id, embed_message_id, kind, by_id, turn_limit, token_budget):
        """Set tasks.thread_id and insert the thread control row in one transaction."""
        async with self.db.transaction() as c:
            await c.execute("UPDATE tasks SET thread_id=?2, embed_message_id=?3, "
                            "updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1",
                            task["id"], thread_id, embed_message_id)
            return await c.fetchrow(
                "INSERT INTO brainstorm_threads (kind, task_id, guild_id, parent_channel_id, thread_id, topic,"
                " owner_agent, participants, turn_limit, token_budget, initiated_by_kind, initiated_by_id)"
                " VALUES ('task',?1,?2,?3,?4,?5,?6,json_array(?6),?7,?8,?9,?10) RETURNING *",
                task["id"], task["guild_id"], task["origin_channel_id"], thread_id, task["title"],
                task["assignee_agent"], turn_limit, token_budget, kind, by_id)

    async def set_task(self, task_id, status, report=None, *, only_from=("open", "in_progress")):
        return await self.db.fetchrow(
            "UPDATE tasks SET status=?2, report=COALESCE(?3, report), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')"
            " WHERE id=?1 AND status IN (SELECT value FROM json_each(?4)) RETURNING *",
            task_id, status, report, json.dumps(list(only_from)))

    async def task_by_thread(self, thread_id):
        return await self.db.fetchrow("SELECT * FROM tasks WHERE thread_id=?1", thread_id)

    async def task_by_id(self, task_id):
        return await self.db.fetchrow("SELECT * FROM tasks WHERE id=?1", task_id)

    async def get(self, row_id):
        return await self.db.fetchrow("SELECT * FROM brainstorm_threads WHERE id=?1", row_id)

    async def by_thread(self, thread_id):
        return await self.db.fetchrow("SELECT * FROM brainstorm_threads WHERE thread_id=?1", thread_id)

    async def create_brainstorm(self, *, guild_id, channel_id, topic, owner, participants, turn_limit, token_budget,
                                kind, by_id, daily_max, tz, task_id=None):
        """Returns the row, or None when an agent-initiated brainstorm hits the daily cap (BEGIN IMMEDIATE)."""
        async with self.db.transaction() as c:
            if kind == "agent":
                start = datetime.now(ZoneInfo(tz)).replace(hour=0, minute=0, second=0, microsecond=0)
                n = await c.fetchval(
                    "SELECT count(*) FROM brainstorm_threads WHERE kind='brainstorm' AND initiated_by_kind='agent'"
                    " AND created_at >= ?1", utc_text(start))
                if n >= daily_max:
                    return None
            return await c.fetchrow(
                "INSERT INTO brainstorm_threads (kind, task_id, guild_id, parent_channel_id, topic, owner_agent,"
                " participants, turn_limit, token_budget, initiated_by_kind, initiated_by_id)"
                " VALUES ('brainstorm',?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) RETURNING *",
                task_id, guild_id, channel_id, topic, owner, json.dumps(list(participants)), turn_limit,
                token_budget, kind, by_id)

    async def set_thread(self, row_id, thread_id):
        await self.db.execute("UPDATE brainstorm_threads SET thread_id=?2 WHERE id=?1", row_id, thread_id)

    async def add_turn(self, row_id, tokens):
        return await self.db.fetchrow(
            "UPDATE brainstorm_threads SET turns_used=turns_used+1, tokens_used=tokens_used+?2"
            " WHERE id=?1 AND status IN ('open','summarising') RETURNING *", row_id, tokens)

    async def reserve_turn(self, row_id):
        """Atomically take one turn if the thread is open and under its cap; None otherwise."""
        return await self.db.fetchrow(
            "UPDATE brainstorm_threads SET turns_used=turns_used+1 WHERE id=?1 AND status='open'"
            " AND turns_used < turn_limit RETURNING *", row_id)

    async def add_tokens(self, row_id, tokens):
        return await self.db.fetchrow(
            "UPDATE brainstorm_threads SET tokens_used=tokens_used+?2"
            " WHERE id=?1 AND status IN ('open','summarising') RETURNING *", row_id, tokens)

    async def begin_summary(self, row_id, reason):
        """open -> summarising (atomic: exactly one caller wins)."""
        return await self.db.fetchrow(
            "UPDATE brainstorm_threads SET status='summarising', close_reason=?2 WHERE id=?1 AND status='open'"
            " RETURNING *", row_id, reason)

    async def close(self, row_id, summary_message_id=None):
        await self.db.execute(
            "UPDATE brainstorm_threads SET status='closed', closed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),"
            " summary_message_id=?2 WHERE id=?1 AND status='summarising'", row_id, summary_message_id)

    async def abort(self, row_id, reason):
        return await self.db.fetchrow(
            "UPDATE brainstorm_threads SET status='aborted', close_reason=?2, closed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')"
            " WHERE id=?1 AND status IN ('open','summarising') RETURNING *", row_id, reason)
