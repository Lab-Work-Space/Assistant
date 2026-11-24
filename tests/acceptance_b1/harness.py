"""B1 acceptance harness (TASK-021B-T): the REAL core (Config, SQLite, 20 personas, ReplyGate, engine, sinks, router,
approvals, tasks, budget, pulluser) driven through `core.__main__.amain` with FAKE Discord clients and FAKE providers.
No token, no network. Fake client i has bot user id 9000+i and app id 1000+i."""
import asyncio
import itertools
import json
import types
from pathlib import Path

import discord

from core.agents.persona import FilePersonaRegistry
from core.cli.fakes import FAKE_ENV, FakeProv
from core.config import PROJECT_ROOT
from core.discord import client as C
from core.interfaces import StreamEvent, ToolCall, Usage
from tests.conftest import make_db_path
from tests.discord_fakes import (SYS_UID, ADMIN, ALLOWED, APPROVAL, APPROVER_ROLE, G, HUMAN, OTHER, TASKS, Bot, Channel, Guild, Member, Msg,
                                 Role)

CAT = 555555555555555501
OUTSIDE = OTHER + 20                       # not in the allowlist, not under CAT
CHANS = [(ALLOWED, None), (OUTSIDE, None), (TASKS, CAT), (ADMIN, CAT), (APPROVAL, CAT), (CAT, None)]
NF = types.SimpleNamespace(status=404, reason="")
PERSONA_IDS = [p.id for p in FilePersonaRegistry.load(str(PROJECT_ROOT / "prompts"), "praw", "google/x").all()]


# ---------------------------------------------------------------- fake Discord ------------------------------------------------
class EMsg(Msg):
    def __init__(self, ch, content=None, embed=None):
        super().__init__(ch, content, embed)
        self.history = [content]              # every content ever shown (placeholder, partial edits, final)

    async def edit(self, content=None, **kw):
        w = self.channel.world
        w.edit_no += 1
        if w.fail_edits > 0 or w.edit_no in w.fail_at:
            w.fail_edits = max(0, w.fail_edits - 1)
            raise discord.HTTPException(types.SimpleNamespace(status=429, reason=""), "rate limited")
        await super().edit(content=content, **kw)
        self.history.append(content)


class World:
    def __init__(self):
        self.ids, self.msgs, self.threads, self.all, self.fail_edits = itertools.count(5000), {}, {}, [], 0
        self.members, self.clients, self.dms = {}, {}, {}
        self.edit_no, self.fail_at = 0, set()   # fail_at: 1-based indices of edit calls that get a 429

    def add_member(self, m):
        self.members[m.id] = m
        return m

    def texts(self, cid=None):
        """Every content and embed text ever shown (including intermediate edits), optionally for one channel."""
        out = []
        for uid, c, m in self.all:
            if cid is None or c == cid:
                out += [h for h in m.history if h]
                if m.embed is not None:
                    out += [str(m.embed.title), str(m.embed.description), *[f"{f.name} {f.value}" for f in m.embed.fields]]
        return out


class Chan(Channel):
    """One per (client, channel): message ids are global so the router can tell who authored a message."""
    def __init__(self, cid, uid, world, **kw):
        super().__init__(cid, **kw)
        self.uid, self.world, self.edits = uid, world, []

    async def send(self, content=None, embed=None, view=None, file=None, allowed_mentions=None):
        m = EMsg(self, content, embed)
        m.id, m.file, m.view, m.mentions = next(self.world.ids), file, view, allowed_mentions
        m.author = types.SimpleNamespace(id=self.uid)
        self.sent.append(m)
        self.world.msgs[m.id] = (self.uid, m)
        self.world.all.append((self.uid, self.id, m))
        return m

    async def create_thread(self, name, type=None):
        return await self.get_partial_message(0).create_thread(name=name)

    async def history(self, limit, oldest_first=False):
        for m in [x for x in self.sent if x.content][::-1][:limit]:
            yield types.SimpleNamespace(content=m.content, author=types.SimpleNamespace(id=self.uid, display_name="x"))

    async def fetch_message(self, mid):
        return types.SimpleNamespace(author=types.SimpleNamespace(id=self.world.msgs[mid][0]))

    def get_partial_message(self, mid):
        ch = self

        class P:
            async def create_thread(self, name):
                th = Chan(next(ch.world.ids) + 10**17, ch.uid, ch.world, parent=ch)
                th.name = name
                ch.world.threads[th.id] = ch.id
                ch.world.threads_obj = getattr(ch.world, "threads_obj", {})
                ch.world.threads_obj[th.id] = th
                return th

            async def edit(self, embed=None, view=None):
                ch.edits.append((mid, embed, view))
                rec = ch.world.msgs.get(mid)
                if rec:
                    rec[1].embed, rec[1].view = embed, view
        return P()


class HGuild(Guild):
    async def fetch_member(self, i):
        m = self._m.get(i)
        if m is None:
            raise discord.NotFound(NF, "x")
        return m


class HMember(Member):
    def __init__(self, world, uid, roles=(), bot=False):
        super().__init__(uid, roles, bot)
        self.world = world

    async def create_dm(self):
        return self.world.dms.setdefault(self.id, Chan(self.id + 10**6, 9001, self.world))


class FClient(Bot):
    def __init__(self, world, uid, app_id):
        guild = HGuild(channels=[Chan(i, uid, world, category_id=c) for i, c in CHANS], members=list(world.members.values()))
        super().__init__(uid, app_id, guild)
        guild.me = types.SimpleNamespace(id=uid)
        self.world, self.stop_ev, self.threads, self.token_seen = world, asyncio.Event(), {}, None
        world.clients[uid] = self

    def get_channel(self, i):
        if i in self.guild._ch:
            return self.guild._ch[i]
        if i in self.world.threads and i not in self.threads:
            self.threads[i] = Chan(i, self.user.id, self.world, parent=self.guild._ch[self.world.threads[i]])
        return self.threads.get(i)

    def thread_texts(self, tid):
        t = self.threads.get(tid)
        return [m.content for m in (t.sent if t else []) if m.content]

    async def start(self, token):
        self.token_seen = bool(token)           # never keep or print the value
        for fn in self.fire("on_ready"):
            await fn()
        await self.stop_ev.wait()

    async def close(self):
        self.closed = True
        self.stop_ev.set()


# ---------------------------------------------------------------- fake provider -----------------------------------------------
class Prov(FakeProv):
    """FakeProv plus probe markers in the user text. stream_calls/complete_calls count provider traffic (never keep content)."""
    SECRET_PATTERN = "sk-ant-api03-PLANTED0123456789abcdef"
    CODE = "\n```python\n" + "".join(f"x{i} = {i}  # บรรทัดที่ {i}\n" for i in range(150)) + "```\n"
    THAI = "สวัสดีครับ วันนี้อากาศดีมาก เราจะคุยเรื่องแผนงานไตรมาสหน้ากัน " * 25

    def __init__(self, tier2="no", secret_exact="", gate=None):
        super().__init__("[fake] ")
        self.stream_calls, self.complete_calls, self.tier2, self.secret_exact, self.gate = 0, 0, tier2, secret_exact, gate
        self.active = self.peak = 0

    async def complete(self, **kw):
        self.complete_calls += 1
        return self.tier2, Usage(5, 1)

    async def stream(self, *, model, system, messages, tools, **kw):
        self.stream_calls += 1
        last = messages[-1]
        whole = next((m.content for m in reversed(messages) if m.role == "user"), messages[0].content)
        first = whole[whole.rfind("<untrusted"):]       # the engine packs context + current text in ONE user message: take the last block
        self.active += 1
        self.peak = max(self.peak, self.active)
        try:
            if self.gate is not None and "SLOWQ" in first:
                await self.gate.wait()
            if last.role != "tool" and "PULLDM:" in first:
                uid = first.split("PULLDM:")[1].split()[0]
                yield StreamEvent("tool_call", tool_call=ToolCall("p1", "pull_user", {"user_id": uid, "reason": "join us", "destination": "dm"}))
            elif last.role == "tool" and "PULLDM:" in first:
                yield StreamEvent("text", text="invite " + last.content[:40])
            elif "PLANTQ" in first:
                s, p = self.secret_exact, self.SECRET_PATTERN
                for t in ("here is the key: ", s[:7], s[7:], " and ", p[:11], p[11:], " end\n"):
                    yield StreamEvent("text", text=t)
            elif "CODEQ" in first:
                body = "ก่อนโค้ด " + self.THAI + self.CODE + " หลังโค้ด " + self.THAI
                for i in range(0, len(body), 37):         # odd chunk size: cuts inside Thai clusters and fences
                    yield StreamEvent("text", text=body[i:i + 37])
            else:
                async for e in super().stream(model=model, system=system, messages=messages, tools=tools, **kw):
                    if e.kind != "usage":
                        yield e
            yield StreamEvent("usage", usage=Usage(5, 5))
        finally:
            self.active -= 1


# ---------------------------------------------------------------- running app -------------------------------------------------
def suffix(pid):
    return C.env_suffix(pid)


def build_env(tmp_path, personas=None, **over):
    ids = personas or PERSONA_IDS
    ids = ["praw"] + [p for p in ids if p != "praw"]
    (tmp_path / "k").mkdir(exist_ok=True)
    for a in ("notes", "meetings", "memory", "rules"):
        (tmp_path / "k" / a).mkdir(exist_ok=True)
        (tmp_path / "k" / a / "_index.md").write_text("")
    env = {**FAKE_ENV, "DATABASE_PATH": make_db_path(tmp_path), "LOG_DIR": str(tmp_path / "logs"),
           "VOICE_TMP_DIR": str(tmp_path / "voice"), "KNOWLEDGE_DIR": str(tmp_path / "k"),
           "DEFAULT_CHEAP_MODEL": "google/x", "REPLY_TIER2_MODEL": "google/x", "IMAGE_MODEL": "google/i", "TTS_MODEL": "google/t",
           "TTS_VOICE": "v", "STT_PROVIDER": "google", "STT_MODEL": "s",
           "DISCORD_GUILD_ID": str(G), "TASKS_CHANNEL_ID": str(TASKS), "ADMIN_NOTIFY_CHANNEL_ID": str(ADMIN),
           "APPROVAL_CHANNEL_ID": str(APPROVAL), "CHANNEL_ALLOWLIST": f"{ALLOWED},{CAT}", "APPROVER_ROLE_ID": str(APPROVER_ROLE),
           "USER_MAX_RUNS_PER_HOUR": "1000", "BRAINSTORM_TURN_LIMIT": "3", "JOB_POLL_INTERVAL_S": "30"}
    for i, pid in enumerate(ids):
        env[f"DISCORD_BOT_TOKEN_{suffix(pid)}"] = f"tok-{pid}-{'x' * 8}{i:02d}ABCDEFGH"
        env[f"DISCORD_APP_ID_{suffix(pid)}"] = str(1000 + i)
    env.update({k: str(v) for k, v in over.items() if v is not None})
    return {k: v for k, v in env.items() if k not in over or over[k] is not None}


class Run:
    """A started app: .app (DiscordApp), .world, .prov. await run.stop() returns the exit code."""
    def __init__(self):
        self.app = self.task = self.prov = self.tmp = None
        self.world = World()

    @property
    def ctx(self):
        return self.app.ctx

    def ch(self, cid, pid="praw"):
        return self.world.clients[self.uid(pid)].get_channel(cid)

    def uid(self, pid):
        for u, p in self.app.persona_by_user_id.items():
            if p == pid:
                return u
        return 9001 + list(self.app.bots).index(pid)   # creation order == bots order

    def msg(self, ch, text, uid=HUMAN, mentions=(), ref=None, dm=False):
        guild = None if dm else types.SimpleNamespace(id=G)
        return types.SimpleNamespace(
            id=next(self.world.ids), channel=ch, guild=guild, guild_id=None if dm else G, webhook_id=None, content=text, reference=ref,
            type=None, mentions=list(mentions), author=types.SimpleNamespace(id=uid, bot=False, display_name=f"human{uid % 100}"))

    async def say(self, cid, text, uid=HUMAN, to=None, ref=None, dm=False, ch=None):
        """A human posts text in channel cid (intake's view); to=persona id mentions that persona's bot account."""
        ch = ch or self.ch(cid)
        mentions = [types.SimpleNamespace(id=self.uid(to), bot=True)] if to else []
        await self.app.listeners["on_message@praw"](self.msg(ch, text, uid, mentions, ref, dm))

    def log_text(self):
        return "".join(p.read_text() for p in sorted((self.tmp / "logs").glob("*.jsonl")))

    def log_events(self, name):
        rows = (json.loads(x) for x in self.log_text().splitlines() if x.strip())
        return [{**r.get("fields", {}), "level": r["level"]} for r in rows if r["event"] == name]

    async def stop(self):
        await self.app.shutdown()
        return await asyncio.wait_for(self.task, 30)

    # interactions ---------------------------------------------------------------------------------------------
    def interaction(self, *, ch, user_id=HUMAN, roles=(), message=None, custom_id=None, client_pid="praw", kind="component", bot=False):
        out = []

        async def send_message(text, **k): out.append(("resp", text, k)); resp.done = True
        async def defer(**k): out.append(("defer", None, k)); resp.done = True
        async def followup(text, **k): out.append(("follow", text, k))
        resp = types.SimpleNamespace(done=False, send_message=send_message, defer=defer, is_done=lambda: resp.done)
        cl = self.world.clients[self.uid(client_pid)]
        user = types.SimpleNamespace(id=user_id, bot=bot, display_name="h", roles=[Role(r) for r in roles])
        t = discord.InteractionType.component if kind == "component" else discord.InteractionType.application_command
        return types.SimpleNamespace(
            type=t, data={"custom_id": custom_id}, response=resp, followup=types.SimpleNamespace(send=followup), user=user,
            client=cl, message=message, channel=ch, channel_id=ch.id, guild_id=G, guild=types.SimpleNamespace(id=G), out=out)

    async def click(self, i, pid="praw"):
        await self.app.listeners[f"on_interaction@{pid}"](i)
        return i.out


async def launch(tmp_path, monkeypatch, personas=None, tier2="no", secret="", gate=None, ready=True, prov=None, **over):
    """Start amain with fake clients. Returns Run once the intake is ready and every client settled (or rc set on refusal)."""
    from core.__main__ import amain
    import core.__main__ as M
    monkeypatch.delenv("EMP_CLI_DEV", raising=False)
    monkeypatch.setattr(C, "STAGGER_S", 0)
    r = Run()
    r.tmp = tmp_path
    env = build_env(tmp_path, personas, **over)
    r.env = env
    r.prov = prov or Prov(tier2, secret, gate)
    ids = ["praw"] + [p for p in (personas or PERSONA_IDS) if p != "praw"]
    for u in (HUMAN, HUMAN + 1, HUMAN + 3):
        r.world.add_member(HMember(r.world, u, [APPROVER_ROLE] if u == HUMAN else []))
    r.world.add_member(HMember(r.world, HUMAN + 2, bot=True))
    made = itertools.count()
    real = M.setup_discord

    def spy(ctx, bots, system=None):
        r.app = real(ctx, bots, system)
        return r.app
    monkeypatch.setattr(M, "setup_discord", spy)

    def factory(config, intake):
        n = next(made)
        if n >= len(config.persona_tokens):   # the 21st client: System (12.14)
            c = FClient(r.world, SYS_UID, config.system_app_id)
            r.system_client = c
            return c
        suf = list(config.persona_tokens)[n]
        c = FClient(r.world, 9001 + n, config.persona_app_ids[suf])
        r.override(c, suf) if hasattr(r, "override") else None
        return c
    provs = {"google": r.prov, "anthropic": r.prov}
    r.task = asyncio.ensure_future(amain(env, bot_factory=factory, install_signals=False, providers=provs))
    if ready:
        for _ in range(600):
            if r.task.done() or (r.app is not None and r.app._all_settled.is_set()):
                break
            await asyncio.sleep(0.01)
        await asyncio.sleep(0.05)
    return r
