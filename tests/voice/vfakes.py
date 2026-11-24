"""Fakes for the voice tests (no network, no real tokens, no real voice connection)."""
import asyncio
import types
from types import SimpleNamespace as NS

from core.discord.allowlist import Gate
from core.interfaces import AgentResult, Usage
from core.knowledge.store import KnowledgeStore
from tests.discord_fakes import ALLOWED, APPROVER_ROLE, G, Bot, FakeLog, Guild, Member, Msg, Perms, persona

CAT = 555555555555555501
VC_ID, VC_OTHER, VC_OUT = 222222222222222210, 222222222222222211, 222222222222222299
U1, U2, U3, U4 = 444444444444444401, 444444444444444411, 444444444444444412, 444444444444444413
BOT = 900


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


class VC:
    def __init__(self):
        self.connected, self.played, self.stopped, self.sink, self.after, self.recording = True, [], 0, None, None, False

    def is_connected(self): return self.connected
    def start_recording(self, sink, after): self.sink, self.after, self.recording = sink, after, True
    def stop_recording(self): self.stopped += 1; self.recording = False

    def play(self, src, after=None):
        self.played.append(src)
        if after:
            after(None)

    async def disconnect(self): self.connected = False


class VChan:
    def __init__(self, cid=VC_ID, category_id=CAT, guild=None):
        self.id, self.category_id, self.parent, self.parent_id, self.name = cid, category_id, None, None, "voice"
        self.guild, self.members, self.sent, self.vc, self.fail_send = guild or NS(id=G), [], [], VC(), False

    async def send(self, content=None, embed=None, view=None, allowed_mentions=None, **kw):
        if self.fail_send:
            raise RuntimeError("send failed")
        m = Msg(self, content, embed)
        m.view, m.mentions = view, allowed_mentions
        self.sent.append(m)
        return m

    async def connect(self):
        return self.vc

    def permissions_for(self, member): return Perms(True)


class Mem:
    def __init__(self, uid, name="n", chan=None, bot=False, roles=()):
        self.id, self.display_name, self.bot, self.voice, self.roles = uid, name, bot, NS(channel=chan), list(roles)


class FakeBudget:
    def __init__(self):
        self.levels, self.records, self.on_level = {}, [], None

    async def level(self, agent_id):
        if self.on_level:
            await self.on_level()
        return self.levels.get(agent_id, "ok")

    async def record(self, agent_id, provider, model, usage, purpose, units=0, ref=None):
        self.records.append(dict(agent=agent_id, provider=provider, model=model, purpose=purpose, units=units, ref=ref))


class FakeStt:
    def __init__(self):
        self.calls, self.script, self.err = [], {}, None

    async def transcribe(self, pcm):
        self.calls.append(len(pcm))
        if self.err:
            raise self.err
        return self.script.pop(0) if self.script else "hello", max(1, len(pcm) // 32000)


class FakeEngine:
    def __init__(self, text="One line summary\n## Heading\n### Decisions\n- d\n### Action items\n- a"):
        self.reqs, self.text, self.ok = [], text, True

    async def run(self, req):
        self.reqs.append(req)
        return AgentResult(self.ok, self.text if self.ok else "", [], Usage(), [], "run-1")


class Policy:
    surface = "discord"

    def __init__(self, ids=()):
        self.ids = set(ids)

    async def is_approver(self, actor): return int(actor.user_id) in self.ids


class DmSink:
    def __init__(self, log): self.log = log
    async def send_embed(self, e, v=None): self.log.append(e); return 1


def make_world(tmp_path, db, **env):
    """Returns a namespace with a VoiceManager wired to fakes. Requires an allowlisted voice channel VC_ID (category CAT)."""
    from core.config import Config
    from core.voice.session import VoiceManager
    from tests.test_discord_layer import denv
    cfg = Config.load(denv(tmp_path, VOICE_ENABLED="true", VOICE_LIVE_CAPTURE="true", STT_PROVIDER="gemini", GEMINI_PAID_TIER_CONFIRMED="true",
                           STT_MODEL="google/gemini-3.8-flash", **env))
    (tmp_path / "k" / "meetings").mkdir(parents=True, exist_ok=True)
    log, clock, budget, engine = FakeLog(), Clock(), FakeBudget(), FakeEngine()
    guild_ns = NS(id=G)
    vch = VChan(guild=guild_ns)
    mem = {u: Mem(u, f"user{u % 100}", vch) for u in (U1, U2)}
    vch.members = list(mem.values())
    guild = NS(id=G, get_member=lambda uid: mem.get(uid))
    vch.guild = guild
    bot = Bot(BOT, 11, Guild(channels=[vch]))
    dms = []
    ctx = NS(config=cfg, log=log, db=db, budget=budget, engine=engine, personas=NS(get=lambda pid: persona()),
             knowledge=KnowledgeStore(tmp_path / "k"), approver_policy=Policy(), providers={},
             sinks=NS(null=lambda: None, for_dm=lambda uid, p: DmSink(dms)), voice=None)
    admin = []

    async def admin_line(t): admin.append(t)
    gate = Gate(bot, cfg, log)
    gate.approver_role_id = APPROVER_ROLE
    app = NS(gate=gate, intake=NS(user=NS(id=BOT)), _admin_line=admin_line, ctx=ctx, cfg=cfg, log=log, ready=asyncio.Event())

    async def sleep(s):
        if s == 1:
            await asyncio.Event().wait()  # flusher: tests drive session.tick() by hand
        await asyncio.sleep(0)
    mgr = VoiceManager(ctx, clock=clock, sleep=sleep)
    mgr.app, mgr.opus_ok, mgr._stt = app, True, FakeStt()
    ctx.voice_manager = mgr
    return NS(mgr=mgr, ctx=ctx, cfg=cfg, log=log, clock=clock, budget=budget, engine=engine, stt=mgr._stt, vch=vch, vc=vch.vc,
              mem=mem, guild=guild, app=app, admin=admin, dms=dms, db=db, tmp=tmp_path)


def speak(sink, uid, seconds):
    """Feed `seconds` of 48 kHz stereo PCM through the sink (becomes 32000 B/s)."""
    sink.write(NS(pcm=bytes(3840 * 50 * seconds)), NS(id=uid))


async def started(w, member=U1):
    """record_start, then let the delayed start run; returns the session."""
    assert await w.mgr.record_start(w.mem[member]) is None
    s = w.mgr.session
    await asyncio.gather(*s.tasks)
    return s
