"""Surface abstraction for task/brainstorm threads. Discord (TASK-012B) and the CLI (TASK-025) implement it."""
from typing import Any, Protocol

from core.interfaces import Persona, ReplySink


class ThreadPort(Protocol):
    def sink_for(self, channel_or_thread_id: int, persona: Persona) -> ReplySink: ...  # speaks as the persona
    async def create_thread(self, channel_id: int, message_id: int, name: str) -> int: ...  # raises on failure
    async def edit_embed(self, channel_id: int, message_id: int, embed: Any) -> None: ...
    async def history(self, thread_id: int, limit: int) -> list[tuple[str, str]]: ...  # oldest first (name, text)


def default_embed(title: str, description: str, fields: list[tuple[str, str]], color: int = 0x808080):
    import discord  # lazy: the core imports without py-cord
    e = discord.Embed(title=title[:256], description=description[:4000], colour=color)
    for n, v in fields:
        e.add_field(name=n[:256], value=v[:1024], inline=True)
    return e
