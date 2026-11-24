"""Voice extension (spec 12.12). Intake client only (Praw). Everything is behind VOICE_ENABLED and the S12-03 gate."""
import asyncio
import ctypes.util
import sys
import types

import discord

from core.discord import strings
from core.interfaces import Actor
from core.voice.session import VoiceManager
from core.voice.tts import Speaker


def init(ctx) -> None:
    if not ctx.config.voice_enabled:
        ctx.voice = None
        return
    ctx.voice_manager = VoiceManager(ctx)
    ctx.voice = Speaker(ctx, ctx.voice_manager)


def load_opus() -> bool:
    """12.12.11: on failure voice is disabled for the process; text keeps running."""
    try:
        if not discord.opus.is_loaded():
            # S1212-10: on Linux load the soname directly; find_library spawns ldconfig/gcc through PATH
            discord.opus.load_opus("libopus.so.0" if sys.platform.startswith("linux") else ctypes.util.find_library("opus") or "libopus.so.0")
        return bool(discord.opus.is_loaded())
    except Exception:
        return False


class Commands:
    """Handlers take the interaction. The global intake check (S12-03) has already run for the text channel."""

    def __init__(self, app, mgr):
        self.app, self.mgr = app, mgr

    async def _say(self, i, code: str) -> None:
        await i.response.send_message(strings.voice_reply(code), ephemeral=True)

    async def _is_approver(self, i) -> bool:
        try:
            return await self.app.ctx.approver_policy.is_approver(Actor("discord", str(i.user.id), getattr(i.user, "display_name", "")))
        except Exception:
            return False

    async def _guard(self, i, fn):
        try:
            return await fn()
        except Exception as e:  # voice errors never reach the intake client
            self.mgr.log("voice.command_failed", "ERROR", error=type(e).__name__)
            try:
                await self._say(i, "internal_error")
            except Exception:
                pass

    async def join(self, i) -> None:
        async def run():
            await self._say(i, await self.mgr.join(i.user) or "ok_join")
        await self._guard(i, run)

    async def _member_or_approver(self, i) -> bool:
        s = self.mgr.session
        vc = getattr(getattr(i.user, "voice", None), "channel", None)
        return s is not None and (getattr(vc, "id", None) == s.voice_channel.id or await self._is_approver(i))

    async def leave(self, i) -> None:
        async def run():
            if self.mgr.session is None:
                return await self._say(i, "no_session")
            if not await self._member_or_approver(i):
                return await self._say(i, "not_allowed")
            await self._say(i, "ok_leave")
            self.mgr.request_stop("command", leave=True)
        await self._guard(i, run)

    async def record_start(self, i) -> None:
        async def run():
            await self._say(i, await self.mgr.record_start(i.user) or "ok_record_start")
        await self._guard(i, run)

    async def record_stop(self, i) -> None:
        async def run():
            s = self.mgr.session
            if s is None or not s.recording:
                return await self._say(i, "no_session")
            if not await self._member_or_approver(i):
                return await self._say(i, "not_allowed")
            await self._say(i, "ok_record_stop")
            self.mgr.request_stop("command")
        await self._guard(i, run)

    async def optout(self, i) -> None:
        async def run():
            await self.mgr.optout(i.guild_id, i.user.id, "command")
            await self._say(i, "ok_optout")
        await self._guard(i, run)

    async def optin(self, i) -> None:
        async def run():
            await self.mgr.optin(i.guild_id, i.user.id)
            await self._say(i, "ok_optin")
        await self._guard(i, run)


def make_button_handler(app, mgr):
    async def handler(interaction, action: str, _sid: str) -> None:
        """S1212-08: acts only on the clicking user."""
        if interaction.guild_id != app.cfg.discord_guild_id or action not in ("optout", "optin"):
            return
        uid = interaction.user.id
        if action == "optout":
            await mgr.optout(interaction.guild_id, uid, "button")
        else:
            await mgr.optin(interaction.guild_id, uid)
        await interaction.followup.send(strings.voice_reply("ok_" + action), ephemeral=True)
    return handler


def _probe(mgr):
    def probe(member, before, after):
        s = mgr.session
        ch = next((x for x in (after.channel, before.channel) if x is not None and s is not None and x.id == s.voice_channel.id),
                  after.channel or before.channel)
        return types.SimpleNamespace(channel=ch, guild=getattr(ch, "guild", None), author=member)
    return probe


def register(app, mgr) -> Commands:
    cmds = Commands(app, mgr)
    g = discord.SlashCommandGroup("voice", "Voice channel")
    rec = g.create_subgroup("record", "Live transcription")

    @g.command(name="join", description="Join your voice channel (speech replies only)")
    async def join(ctx):
        await cmds.join(ctx.interaction)

    @g.command(name="leave", description="Leave the voice channel")
    async def leave(ctx):
        await cmds.leave(ctx.interaction)

    @rec.command(name="start", description="Start live transcription (a notice is posted first)")
    async def start(ctx):
        await cmds.record_start(ctx.interaction)

    @rec.command(name="stop", description="Stop transcription and write the note")
    async def stop(ctx):
        await cmds.record_stop(ctx.interaction)

    @g.command(name="optout", description="Never record my voice")
    async def optout(ctx):
        await cmds.optout(ctx.interaction)

    @g.command(name="optin", description="Allow recording my voice again")
    async def optin(ctx):
        await cmds.optin(ctx.interaction)

    app.intake.add_application_command(g)
    return cmds


def setup_discord(app) -> None:
    mgr = app.ctx.voice_manager
    mgr.app = app
    mgr.opus_ok = load_opus()
    register(app, mgr)
    app.router.register("rec", make_button_handler(app, mgr))
    app.listen("on_voice_state_update", mgr.on_voice_state, probe=_probe(mgr))

    async def startup() -> None:
        try:
            await app.ready.wait()
            await mgr.recover()
            if not mgr.opus_ok:
                mgr.log("voice.disabled", "ERROR", reason="opus_not_loaded")
                await mgr.admin("voice_disabled:opus_not_loaded")
        except Exception as e:
            mgr.log("voice.startup_failed", "ERROR", error=type(e).__name__)
    mgr._spawn(startup())
