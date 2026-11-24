"""DiscordReplySink and SinkFactory (spec 3.3, 10.11.2, 12.7 S12-01, 12.10).
A persona speaks through its own client; a disabled persona (no token, login failed) is routed through the intake client (S1210-07, no webhooks)."""
import asyncio
import io
import os
import re

import discord

from core.discord import strings
from core.discord.embeds import mask_embed
from core.discord.streaming import StreamWriter
from core.functions.logs.masking import mask_secrets
from core.interfaces import Persona, TargetError

NONE = discord.AllowedMentions.none()
_FILE = re.compile(r"[^A-Za-z0-9._-]")


class _Bot:
    def __init__(self, channel):
        self.channel = channel

    async def send(self, content):
        return await self.channel.send(content=content, allowed_mentions=NONE)

    async def edit(self, m, content):
        await m.edit(content=content)

    async def delete(self, m):
        await m.delete()

    async def typing(self):
        await self.channel.trigger_typing()


class DiscordReplySink:
    """open: async () -> (transport, bot_channel, prefix). Resolved lazily so for_* stay synchronous."""

    def __init__(self, open_, cfg, log=None):
        self._log = log
        self._open, self.cfg, self._t, self._w = open_, cfg, None, None
        self._typing = None

    async def _ensure(self):
        if self._t is None:
            self._t, self._chan, self._prefix = await self._open()
        return self._t

    async def start(self) -> None:
        t = await self._ensure()
        live = getattr(self.cfg, "stream_mode", "typing") == "edit"
        self._w = StreamWriter(t.send, t.edit, t.delete, interval=self.cfg.stream_edit_interval_s,
                               max_messages=self.cfg.stream_max_messages, prefix=self._prefix, live=live,
                               on_deleted=lambda: self._log and self._log.write_log("discord", "stream.target_deleted", "WARNING"))
        if live:
            self._w.adopt(await t.send(strings.PLACEHOLDER), strings.PLACEHOLDER)
        elif hasattr(t, "typing"):
            self._typing = asyncio.ensure_future(self._keep_typing(t))

    async def _keep_typing(self, t) -> None:
        """Discord shows 'X is typing…' for ~10 s per trigger; renew until the reply is sent."""
        while True:
            try:
                await t.typing()
            except Exception:  # cosmetic only: never break a reply over the indicator
                pass
            await asyncio.sleep(8)

    def _stop_typing(self) -> None:
        if self._typing is not None:
            self._typing.cancel()
            self._typing = None

    async def write(self, delta: str) -> None:
        if self._w is None:
            await self.start()
        await self._w.write(delta)

    async def finish(self) -> list[int]:
        self._stop_typing()
        return await self._w.finish() if self._w else []

    async def fail(self, user_text: str) -> None:
        if self._w is None:
            await self.start()
        self._stop_typing()
        await self._w.finish()
        text = mask_secrets(user_text)[:2000]
        if self._w.msgs and not self._w.text.strip():
            await self._t.edit(self._w.msgs[0], text)
        else:
            await self._t.send(text)

    async def send_embed(self, embed, view=None) -> int:
        await self._ensure()
        m = await self._chan.send(embed=mask_embed(embed), view=view, allowed_mentions=NONE)  # components: bot account only
        return m.id

    async def send_file(self, filename: str, data: bytes, content: str = "") -> int:
        await self._ensure()
        name = _FILE.sub("_", os.path.basename(filename))[:100] or "file.bin"
        m = await self._chan.send(content=mask_secrets(content)[:2000], file=discord.File(io.BytesIO(data), filename=name),
                                  allowed_mentions=NONE)
        return m.id


class NullSink:
    async def start(self): pass
    async def write(self, delta): pass
    async def finish(self): return []
    async def fail(self, user_text): pass
    async def send_embed(self, embed, view=None): return 0
    async def send_file(self, filename, data, content=""): return 0


class DiscordSinkFactory:
    def __init__(self, app):
        self.app = app

    # -- opening -----------------------------------------------------------------------------------------
    async def _channel_for(self, client, cid: int):
        ch = client.get_channel(cid)
        if ch is None:
            try:
                ch = await client.fetch_channel(cid)
            except Exception:
                raise TargetError("discord_not_found") from None
        return ch

    def _open_channel(self, channel_id: int, persona: Persona):
        async def open_():
            app = self.app
            client = app.client_for(persona.id)
            if client is not None:
                ch = await self._channel_for(client, channel_id)
                return _Bot(ch), ch, ""
            # S1210-07: disabled persona (no token / login failed) is routed through Praw's client, name shown in text
            ch = await self._channel_for(app.intake, channel_id)
            return _Bot(ch), ch, f"**{persona.name}:** "
        return open_

    def _open_dm(self, user_id: int, persona: Persona):
        async def open_():
            app = self.app
            if not await app.gate.dm_ok(user_id):  # S12-01
                raise TargetError("target_not_allowed")
            client = app.client_for(persona.id) or app.intake  # only intake can reach a DM for a disabled persona
            try:
                u = client.get_user(user_id) or await client.fetch_user(user_id)
                ch = await u.create_dm()
            except Exception:
                raise TargetError("discord_not_found") from None
            return _Bot(ch), ch, "" if client is not app.intake or persona.id == app.intake_persona else f"**{persona.name}:** "
        return open_

    # -- SinkFactory -------------------------------------------------------------------------------------
    def for_channel(self, channel, persona: Persona) -> DiscordReplySink:
        cid = channel if isinstance(channel, int) else channel.id
        obj = self.app.intake.get_channel(cid) if isinstance(channel, int) else channel
        if obj is None or not self.app.gate.channel_ok(obj):  # S12-01
            raise TargetError("target_not_allowed")
        return DiscordReplySink(self._open_channel(cid, persona), self.app.cfg, self.app.log)

    def for_dm(self, user, persona: Persona) -> DiscordReplySink:
        uid = user if isinstance(user, int) else user.id
        return DiscordReplySink(self._open_dm(uid, persona), self.app.cfg, self.app.log)

    def null(self) -> NullSink:
        return NullSink()

    async def for_target(self, kind, target_id: int, persona: Persona, ctx):
        app, c = self.app, self.app.cfg
        if ctx.human_user_id is None:
            raise TargetError("target_not_allowed")
        human = await app.gate.member(ctx.human_user_id)
        if human is None:
            raise TargetError("target_not_allowed")
        if kind == "dm":
            m = await app.gate.member(target_id)
            if m is None or getattr(m, "bot", False) or not await app.gate.dm_ok(target_id):
                raise TargetError("target_not_allowed")
            return self.for_dm(target_id, persona)
        ch = app.intake.get_channel(target_id)
        if ch is None:
            try:
                ch = await app.intake.fetch_channel(target_id)
            except Exception:
                raise TargetError("discord_not_found") from None
        if getattr(getattr(ch, "guild", None), "id", None) != c.discord_guild_id or not app.gate.channel_ok(ch):
            raise TargetError("target_not_allowed")
        if {c.approval_channel_id, c.admin_notify_channel_id} & ({ch.id, getattr(ch, "parent_id", None)}):
            raise TargetError("target_not_allowed")
        perms = ch.permissions_for(human)
        need = perms.send_messages_in_threads if getattr(ch, "parent_id", None) else perms.send_messages
        if not (perms.view_channel and need):
            raise TargetError("target_not_allowed")
        return self.for_channel(ch, persona)
