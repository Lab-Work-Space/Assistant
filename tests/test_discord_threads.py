"""TASK-012B: Discord ThreadPort against fakes (own clients, allowlist, task button, follow-ups)."""
import itertools
import types

import pytest

from core.config import Config
from core.discord import client as C
from core.discord.sinks import DiscordSinkFactory
from core.discord.threads import on_task_click
from core.interfaces import AgentResult, Persona, ToolContext, Usage
from core.tasks import ext
from core.interfaces import TargetError
from tests.conftest import base_env
from tests.conftest import task_card
from tests.discord_fakes import (ADMIN, ALLOWED, APPROVAL, APPROVER_ROLE, G, HUMAN, OTHER, TASKS, TOK_PRAW, Channel, FakeLog,
                                 Guild, Member)

CAT = 555555555555555501
IDS, MSGS, THREADS = itertools.count(5000), {}, {}   # message id -> (author uid, owner channel); thread id -> shared thread


class Chan(Channel):
    """One per client view; message ids are global so the intake client can look up who posted."""
    def __init__(self, cid, uid, **kw):
        super().__init__(cid, **kw)
        self.uid, self.edits = uid, []

    async def send(self, content=None, embed=None, view=None, file=None, allowed_mentions=None):
        m = await super().send(content, embed, view, file, allowed_mentions)
        m.id = next(IDS)
        MSGS[m.id] = self.uid
        m.embed_view = view
        return m

    async def history(self, limit, oldest_first=False):
        for m in [x for x in self.sent if x.content][::-1][:limit]:
            yield types.SimpleNamespace(content=m.content, author=types.SimpleNamespace(id=self.uid, display_name="x"))

    async def fetch_message(self, mid):
        return types.SimpleNamespace(author=types.SimpleNamespace(id=MSGS[mid]))

    def get_partial_message(self, mid):
        ch = self

        class P:
            async def create_thread(self, name):
                th = Chan(next(IDS) + 10**17, 0, parent=ch)
                th.name = name
                THREADS[th.id] = th
                return th

            async def edit(self, embed=None, view=None):
                ch.edits.append((mid, embed, view))
        return P()


class FBot:
    def __init__(self, uid, app_id, chans):
        self.user, self.application_id, self.uid = types.SimpleNamespace(id=uid), app_id, uid
        self.guild = Guild(channels=[Chan(i, uid, category_id=c) for i, c in chans])
        self.guilds, self.threads = [self.guild], {}

    def get_guild(self, i): return self.guild
    def get_channel(self, i):
        th = THREADS.get(i)
        if th is not None and i not in self.threads:
            self.threads[i] = Chan(i, self.uid, parent=self.guild._ch[th.parent_id])
        return self.guild._ch.get(i) or self.threads.get(i)

    async def fetch_channel(self, i): raise TargetError("discord_not_found")
    def get_user(self, i): return None
    def add_listener(self, fn, name): pass
    def add_check(self, fn): pass


def persona(pid, name):
    return Persona(pid, name, (), "r", "d", "m", "c", "low", ("*",), (), 0x123456, None, (), "", "p")


class Engine:
    def __init__(self): self.reqs = []

    async def run(self, req):
        self.reqs.append(req)
        await req.sink.start()
        await req.sink.write(f"{req.agent_id}:{req.trigger}")
        ids = await req.sink.finish()
        return AgentResult(True, f"{req.agent_id}:{req.trigger}", ids, Usage(100, 0), [], "r")


CHANS = [(ALLOWED, None), (OTHER + 20, None), (TASKS, CAT), (ADMIN, CAT), (APPROVAL, CAT), (CAT, None)]


@pytest.fixture
def w(tmp_path, db):
    cfg = Config.load({**base_env(tmp_path), "DISCORD_GUILD_ID": str(G), "TASKS_CHANNEL_ID": str(TASKS),
                       "ADMIN_NOTIFY_CHANNEL_ID": str(ADMIN), "APPROVAL_CHANNEL_ID": str(APPROVAL),
                       "DISCORD_BOT_TOKEN_PRAW": TOK_PRAW, "DISCORD_APP_ID_PRAW": "11", "CHANNEL_ALLOWLIST": f"{ALLOWED},{CAT}"})
    ps = {i: persona(i, i.title()) for i in ("praw", "tek")}
    praw, tek = FBot(900, 11, CHANS), FBot(901, 12, CHANS)
    ctx = types.SimpleNamespace(config=cfg, log=FakeLog(), db=db, surface="discord", threads=None, approvals=None, engine=Engine(),
                                personas=types.SimpleNamespace(get=ps.get, all=lambda: list(ps.values())))
    app = C.DiscordApp(ctx, {"praw": praw, "tek": tek}, "praw")
    app.gate.approver_role_id = APPROVER_ROLE
    app.persona_by_user_id.update({900: "praw", 901: "tek"})
    ctx.sinks = DiscordSinkFactory(app)
    ctx.buttons = app.router
    ext.init(ctx)
    return types.SimpleNamespace(ctx=ctx, app=app, praw=praw, tek=tek, ps=ps, cfg=cfg)


def tctx(w, thread=None):
    return ToolContext(agent=w.ps["praw"], run_id="r", guild_id=G, channel_id=ALLOWED, thread_id=thread, trigger="human_message",
                       human_user_id=HUMAN, sink=w.ctx.sinks.null(), origin="discord")


def texts(chan):
    return [m.content for m in chan.sent if m.content]


async def delegate(w):
    r = await w.ctx.task_service.create(tctx(w), {"assignee_agent_id": "tek", "title": "Fix it", **task_card()})
    await w.ctx.task_service.orch.wait_idle()
    return r


async def test_delegation_embed_by_delegator_reply_by_assignee(w):
    r = await delegate(w)
    tid = r["thread_id"]
    embeds = [m for m in w.praw.guild._ch[ALLOWED].sent if m.embed]
    assert len(embeds) == 1 and not [m for m in w.tek.guild._ch[ALLOWED].sent if m.embed]   # embed by the delegating persona's client
    assert texts(w.tek.threads[tid]) == ["tek:task_assigned"] and not w.praw.threads.get(tid)  # assignee replies via its own client
    t = await w.ctx.db.fetchrow("SELECT * FROM tasks WHERE thread_id=?1", tid)
    assert t["embed_message_id"] == embeds[0].id and t["status"] == "in_progress"
    # embed edit goes through the author client (praw) and carries the cancel button bound to the stored message id
    mid, _, view = w.praw.guild._ch[ALLOWED].edits[-1]
    assert mid == t["embed_message_id"] and any(c.custom_id == f"emp:task:cancel:{t['id']}" for c in view.children)
    assert w.ctx.config.channel_allowlist and THREADS[tid].parent_id == ALLOWED


async def test_thread_refused_under_non_allowlisted_parent(w):
    p = w.ctx.threads
    with pytest.raises(TargetError) as e:
        await p.create_thread(OTHER + 20, 1, "x")
    assert e.value.code == "target_not_allowed"
    with pytest.raises(TargetError):
        p.sink_for(OTHER + 20, w.ps["praw"])


async def test_brainstorm_alternates_clients_and_posts_summary(w):
    orch = w.ctx.task_service.orch
    r = await orch.start(guild_id=G, channel_id=ALLOWED, topic="Topic", participants=["praw", "tek"], turn_limit=2,
                         caller="praw", kind="human", by_id=str(HUMAN))
    await orch.wait_idle()
    th = r["thread_id"]
    assert [q.agent_id for q in w.ctx.engine.reqs] == ["praw", "tek", "praw"]   # turn 1 praw, turn 2 tek, summary by the owner
    assert texts(w.tek.threads[th]) == ["tek:brainstorm_turn"]
    assert texts(w.praw.threads[th]) == ["praw:brainstorm_turn", "praw:brainstorm_summary"]
    b = await w.ctx.db.fetchrow("SELECT status, close_reason FROM brainstorm_threads WHERE thread_id=?1", th)
    assert (b["status"], b["close_reason"]) == ("closed", "turn_limit")


async def test_disabled_persona_routed_to_praw_with_note(w):
    w.app.disabled.add("tek")
    r = await delegate(w)
    assert not w.tek.threads and texts(w.praw.threads[r["thread_id"]]) == ["**Tek:** tek:task_assigned"]


async def test_human_followup_in_task_thread_counts_a_turn(w):
    # end to end through the real routing path: ReplyGate (009) delegates open task threads to task_followup
    from core.gate.ext import init as gate_init
    r = await delegate(w)
    th = THREADS[r["thread_id"]]
    gate_init(w.ctx)
    w.ctx.config = w.cfg
    m = types.SimpleNamespace(channel=th, guild=types.SimpleNamespace(id=G), webhook_id=None, mentions=[], content="more please",
                              type=None, reference=None, author=types.SimpleNamespace(id=HUMAN, bot=False, display_name="h"))
    await w.ctx.discord_message_handler(w.app, m)
    assert [q.agent_id for q in w.ctx.engine.reqs][-1] == "tek" and w.ctx.engine.reqs[-1].trigger == "human_message"
    assert texts(w.tek.threads[th.id])[-1] == "tek:human_message"
    b = await w.ctx.db.fetchrow("SELECT turns_used, tokens_used FROM brainstorm_threads WHERE thread_id=?1", th.id)
    assert (b["turns_used"], b["tokens_used"]) == (2, 200)  # counted exactly once


async def test_setup_registers_budget_group_and_task_cancel_at_boot(w):
    w.ctx.discord_message_handler = w.ctx.approvals = w.ctx.bot = None
    w.ctx.budget = None
    w.ctx.threads = None
    ext.init(w.ctx)
    cmds = []
    bots = {"praw": w.praw}
    w.praw.add_application_command = cmds.append
    app = C.setup_discord(w.ctx, bots)
    assert [c.name for c in cmds] == ["budget", "task", "approval", "setting"] and "task" in app.router._h


async def test_cancel_button_creator_or_approver_only(w):
    import discord
    r = await delegate(w)
    t = await w.ctx.db.fetchrow("SELECT * FROM tasks WHERE thread_id=?1", r["thread_id"])
    out = []
    fu = types.SimpleNamespace(send=lambda *a, **k: out.append(a[0]) or _noop())
    ch = w.praw.guild._ch[ALLOWED]

    class Pol:  # fresh policy: only this id is an approver (cached roles on the interaction are ignored)
        surface = "discord"

        async def is_approver(self, a):
            return a.user_id == str(HUMAN + 9)
    w.ctx.approver_policy = Pol()

    def click(uid):
        return types.SimpleNamespace(type=discord.InteractionType.component, guild_id=G, channel=ch, channel_id=ch.id, followup=fu,
                                     user=types.SimpleNamespace(id=uid, bot=False, display_name="x", roles=[types.SimpleNamespace(id=APPROVER_ROLE)]))
    await on_task_click(w.app, click(HUMAN + 1), "cancel", t["id"])  # stale role on the interaction does not help
    assert out and (await w.ctx.db.fetchval("SELECT status FROM tasks WHERE id=?1", t["id"])) == "in_progress"
    await on_task_click(w.app, click(HUMAN), "cancel", t["id"])
    assert (await w.ctx.db.fetchval("SELECT status FROM tasks WHERE id=?1", t["id"])) == "cancelled"
    b = await w.ctx.db.fetchrow("SELECT status, close_reason FROM brainstorm_threads WHERE thread_id=?1", r["thread_id"])
    assert (b["status"], b["close_reason"]) == ("aborted", "cancelled")
    assert w.praw.guild._ch[ALLOWED].edits[-1][2] is None     # button removed
    a = await w.ctx.db.fetchrow("SELECT actor, action FROM audit_log WHERE scope='task' AND ref=?1", t["code"])
    assert (a["actor"], a["action"]) == (f"discord:{HUMAN}", "cancel")
    r2 = await delegate(w)  # an approver who is not the creator may cancel
    t2 = await w.ctx.db.fetchrow("SELECT * FROM tasks WHERE thread_id=?1", r2["thread_id"])
    await on_task_click(w.app, click(HUMAN + 9), "cancel", t2["id"])
    assert (await w.ctx.db.fetchval("SELECT status FROM tasks WHERE id=?1", t2["id"])) == "cancelled"


async def test_task_click_is_registered_on_router(w):
    w.ctx.threads.attach()
    assert "task" in w.app.router._h


async def _noop():
    return None


async def test_concurrent_followups_cannot_exceed_turn_limit(w):
    import asyncio
    from core.discord.threads import task_followup
    w.ctx.config = w.cfg
    r = await delegate(w)                              # turn 1 (turn_limit from cfg)
    th = THREADS[r["thread_id"]]
    limit = w.cfg.brainstorm_turn_limit
    base = len(w.ctx.engine.reqs)
    orig = w.ctx.engine.run

    async def slow(req):
        await asyncio.sleep(0.01)
        return await orig(req)
    w.ctx.engine.run = slow
    mk = lambda i: types.SimpleNamespace(channel=th, guild=types.SimpleNamespace(id=G), webhook_id=None, mentions=[], content=f"m{i}",
                                         author=types.SimpleNamespace(id=HUMAN, bot=False, display_name="h"))
    await asyncio.gather(*[task_followup(w.app, mk(i)) for i in range(40)])
    runs = [q for q in w.ctx.engine.reqs[base:] if q.trigger == "human_message"]
    assert len(runs) == limit - 1
    b = await w.ctx.db.fetchrow("SELECT status, turns_used FROM brainstorm_threads WHERE thread_id=?1", th.id)
    assert (b["status"], b["turns_used"]) == ("closed", limit)


async def test_history_labels_humans_by_marker_not_persona_name(w):
    tid = (await delegate(w))["thread_id"]
    th = await w.ctx.threads._channel(w.app, tid)
    me = types.SimpleNamespace(id=HUMAN, display_name="Tek")        # human impersonating persona name
    async def hist(limit, oldest_first=False):
        yield types.SimpleNamespace(content="hi", author=me)
        yield types.SimpleNamespace(content="real", author=types.SimpleNamespace(id=901, display_name="whatever"))
    th.history = hist
    out = await w.ctx.threads.history(th.id, 10)
    assert ("human:Tek", "hi") in out
    assert ("Tek", "real") in out
