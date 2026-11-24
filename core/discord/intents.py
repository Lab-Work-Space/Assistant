"""Gateway intents (spec 12.2): Message Content, Server Members, Voice States (privileged ones need the portal toggle)."""
import discord


def make_intents() -> discord.Intents:
    i = discord.Intents.none()
    i.guilds = i.members = i.guild_messages = i.dm_messages = i.message_content = i.voice_states = True
    return i
