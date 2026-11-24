"""conversation_state (channel, user) -> last agent that replied; backs the active-conversation window."""
from datetime import datetime, timedelta, timezone

from core.db.sqlite import utc_text


class Conversation:
    def __init__(self, db):
        self.db = db

    async def touch(self, channel_id: int, user_id: int, agent_id: str) -> None:
        await self.db.execute(
            "INSERT INTO conversation_state (channel_id, user_id, agent_id, last_reply_at) VALUES (?1,?2,?3,?4) "
            "ON CONFLICT(channel_id, user_id) DO UPDATE SET agent_id=?3, last_reply_at=?4",
            channel_id, user_id, agent_id, utc_text(datetime.now(timezone.utc)))

    async def active_agent(self, channel_id: int, user_id: int, window_s: int) -> str | None:
        cut = utc_text(datetime.now(timezone.utc) - timedelta(seconds=window_s))
        return await self.db.fetchval(
            "SELECT agent_id FROM conversation_state WHERE channel_id=?1 AND user_id=?2 AND last_reply_at>=?3",
            channel_id, user_id, cut)
