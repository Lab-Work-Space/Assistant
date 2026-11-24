"""Consent notices (spec 12.12.6, S1212-01/05/10): embeds, consent_gap helper and re-ask, late-joiner text."""
import os
import time
import uuid

import discord

from core.discord import strings
from core.discord.buttons import build_view, make_custom_id
from core.db.backup import consent_gap_path
from core.discord.embeds import build_embed

REASK_EVERY_S = 600.0
NONE = discord.AllowedMentions.none()


def consent_gap_present(database_path: str) -> bool:
    """S1212-01: only FileNotFoundError means absent; any other error fails closed (present)."""
    try:
        os.lstat(consent_gap_path(database_path))
        return True
    except FileNotFoundError:
        return False
    except OSError:
        return True


def notice_embed(cfg, sid: str, title="Voice transcription notice / ประกาศการถอดเสียง", text=None):
    e = build_embed(title, text or strings.voice_notice_text(cfg.stt_provider, cfg.knowledge_meetings_retention_days),
                    color=0xFFB300)
    v = build_view([("Opt out", make_custom_id("rec", "optout", sid), None, discord.ButtonStyle.danger),
                    ("Opt in", make_custom_id("rec", "optin", sid), None, discord.ButtonStyle.success)])
    return e, v


def jump_url(guild_id: int, channel_id: int, message_id: int | None) -> str:
    return f"https://discord.com/channels/{guild_id}/{channel_id}" + (f"/{message_id}" if message_id else "")


def late_joiner_text(uid: int, cfg, url: str) -> str:
    """S1212-05: the full disclosure, not only a link."""
    return f"<@{uid}> " + strings.voice_notice_text(cfg.stt_provider, cfg.knowledge_meetings_retention_days) + f"\n{url}"


def late_mentions(uid: int) -> discord.AllowedMentions:
    """S1212-09: the one mention exception, that user only."""
    return discord.AllowedMentions(users=[discord.Object(id=uid)], everyone=False, roles=False)


class Reask:
    """consent_gap re-ask notice, at most once per channel per 10 minutes (S1212-10)."""

    def __init__(self, ctx, clock=time.monotonic):
        self.ctx, self.clock = ctx, clock
        self._last: dict[int, float] = {}

    async def post(self, guild_id: int, voice_channel, started_by: int) -> None:
        now, cid = self.clock(), voice_channel.id
        last = self._last.get(cid)
        if last is not None and now - last < REASK_EVERY_S:
            return
        self._last[cid] = now
        sid = str(uuid.uuid4())
        db = self.ctx.db
        await db.execute("INSERT INTO voice_sessions(id, guild_id, voice_channel_id, text_channel_id, started_by, recording, status, ended_at) "
                         "VALUES(?1,?2,?3,?3,?4,0,'done',strftime('%Y-%m-%dT%H:%M:%fZ','now'))", sid, guild_id, cid, started_by)
        e, v = notice_embed(self.ctx.config, sid, "Voice recording is off / การบันทึกเสียงปิดอยู่", strings.REASK_TEXT)
        try:
            m = await voice_channel.send(embed=e, view=v, allowed_mentions=NONE)
            await db.execute("UPDATE voice_sessions SET notice_message_id=?1 WHERE id=?2", m.id, sid)
        except Exception as ex:
            self.ctx.log.write_log("voice", "voice.reask_failed", "WARNING", error=type(ex).__name__)
