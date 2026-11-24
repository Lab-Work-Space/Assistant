"""Fake Discord objects: no network, no real token."""
import types

import discord

from core.interfaces import Persona

G = 111111111111111111          # guild
ALLOWED, OTHER, TASKS, ADMIN, APPROVAL = (222222222222222201, 222222222222222202, 222222222222222203,
                                          222222222222222204, 222222222222222205)
APPROVER_ROLE, HUMAN = 333333333333333301, 444444444444444401
TOK_PRAW, TOK_TEK = "tok-praw-aaaaaaaaaaaaaaaa", "tok-tek-bbbbbbbbbbbbbbbbbb"
TOK_SYSTEM = "tok-system-dddddddddddddddd"
SYS_UID = 950


class FakeLog:
    def __init__(self):
        self.rows = []

    def write_log(self, system, message, level="INFO", **f):
        self.rows.append((message, f))

    def events(self, name):
        return [f for m, f in self.rows if m == name]


class Msg:
    def __init__(self, ch, content=None, embed=None):
        self.id, self.channel, self.content, self.embed, self.deleted = len(ch.sent) + 1000, ch, content, embed, False

    async def edit(self, content=None, **kw):
        self.content = content

    async def delete(self):
        self.deleted = True


class Perms:
    def __init__(self, ok=True):
        self.view_channel = self.send_messages = self.send_messages_in_threads = ok
        self.administrator = self.mention_everyone = False


class Channel:
    type = discord.ChannelType.text

    def __init__(self, cid, category_id=None, parent=None, guild_id=G, owner="praw"):
        self.id, self.category_id, self.parent, self.owner = cid, category_id, parent, owner
        self.parent_id = parent.id if parent else None
        self.guild = types.SimpleNamespace(id=guild_id)
        self.sent, self.denied, self.hooks, self.created = [], set(), [], []

    async def send(self, content=None, embed=None, view=None, file=None, allowed_mentions=None):
        m = Msg(self, content, embed)
        m.file, m.view, m.mentions = file, view, allowed_mentions
        self.sent.append(m)
        return m

    def permissions_for(self, member):
        return Perms(member.id not in self.denied)

    async def webhooks(self):
        return self.hooks

    async def create_webhook(self, name):
        w = Hook(name, types.SimpleNamespace(id=1), "hook-token-cccccccccccccc")
        self.created.append(w)
        return w


class Hook:
    id = 5

    def __init__(self, name, user, token):
        self.name, self.user, self.token, self.sent = name, user, token, []

    async def send(self, **kw):
        self.sent.append(kw)
        return types.SimpleNamespace(id=77)


class Role:
    def __init__(self, rid, managed=False):
        self.id, self.managed, self.name = rid, managed, "AI-Admin"


class Member:
    def __init__(self, uid, roles=(), bot=False):
        self.id, self.roles, self.bot = uid, [Role(r) for r in roles], bot

    async def create_dm(self):
        return Channel(self.id + 1)


class Guild:
    def __init__(self, gid=G, channels=(), members=(), roles=None):
        self.id, self._ch = gid, {c.id: c for c in channels}
        self._m = {m.id: m for m in members}
        self.roles = roles if roles is not None else [Role(APPROVER_ROLE)]
        self.left = False
        self.me = types.SimpleNamespace(id=SYS_UID)

    def get_channel(self, i): return self._ch.get(i)
    def get_thread(self, i): return None
    def get_member(self, i): return self._m.get(i)
    def get_role(self, i): return next((r for r in self.roles if r.id == i), None)

    async def fetch_member(self, i):
        raise discord.NotFound(types.SimpleNamespace(status=404, reason=""), "x")

    async def leave(self): self.left = True


class Bot:
    def __init__(self, uid=900, app_id=None, guild=None, others=()):
        self.user, self.application_id = types.SimpleNamespace(id=uid), app_id
        self.guild, self.guilds = guild, [g for g in (guild, *others) if g]
        self.listeners, self.checks, self.closed, self.commands = [], [], False, []

    def get_guild(self, i): return self.guild if self.guild and self.guild.id == i else None
    def get_channel(self, i): return self.guild._ch.get(i) if self.guild else None

    async def fetch_channel(self, i):
        raise discord.NotFound(types.SimpleNamespace(status=404, reason=""), "x")

    def get_user(self, i): return self.guild.get_member(i)
    def add_listener(self, fn, name): self.listeners.append((name, fn))
    def add_check(self, fn): self.checks.append(fn)
    def add_application_command(self, cmd): self.commands.append(cmd)

    async def close(self): self.closed = True

    def fire(self, name):
        return [fn for n, fn in self.listeners if n == name]


def persona(pid="praw", name="Praw"):
    return Persona(pid, name, (), "r", "d", "m", "c", "low", (), (), 0x123456, None, (), "", "p")
