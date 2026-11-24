"""Discord clients, listener registry and startup checks (spec 12.3, 12.7, 12.10).
One intake client (Message Content + Members) reads messages behind the allowlist gate; every other persona client
only posts (Intents.guilds). All clients share one asyncio loop, one Gate and one ButtonRouter."""
import asyncio
import os
import re
import socket
import subprocess

import discord

from core.config import PROJECT_ROOT
from core.discord import strings
from core.discord.allowlist import Gate, refuse
from core.discord.approver import DiscordRoleApproverPolicy, make_approval_button_handler
from core.discord.buttons import Router
from core.discord.embeds import DiscordApprovalPresenter
from core.discord.intents import make_intents
from core.discord.sinks import DiscordSinkFactory
from core.discord.syslog import Forwarder
from core.functions.logs.masking import mask_secrets
from core.interfaces import Actor, AgentRequest

STAGGER_S = 0.5
SETTLE_TIMEOUT_S = 120
UNGATED = {"on_ready", "on_application_command_error"}  # no channel in the event; everything else goes through listen()


class Refusal(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class DenyAllApproverPolicy:
    """Fail closed until 013B wires DiscordApproverPolicy (replace in setup_discord)."""
    surface = "discord"

    async def is_approver(self, actor) -> bool:
        return False


def env_suffix(persona_id: str) -> str:
    return re.sub(r"[^A-Z0-9]", "_", persona_id.upper())


def make_bot(config, intake: bool):
    if intake:
        return discord.Bot(intents=make_intents(), debug_guilds=[config.discord_guild_id],
                           allowed_mentions=discord.AllowedMentions.none())  # guild-scoped commands (12.2)
    return discord.Bot(intents=discord.Intents(guilds=True), member_cache_flags=discord.MemberCacheFlags.none(),
                       chunk_guilds_at_startup=False, max_messages=10, allowed_mentions=discord.AllowedMentions.none())


def version() -> str:
    v = os.environ.get("EMP_VERSION")
    if v:
        return v
    try:
        r = subprocess.run(["git", "describe", "--tags", "--always", "--dirty"], cwd=PROJECT_ROOT, capture_output=True,
                           text=True, timeout=3)
        return r.stdout.strip() or "unknown"
    except Exception:
        return "unknown"


class DiscordApp:
    def __init__(self, ctx, bots: dict[str, object], intake_persona: str, system=None):
        self.ctx, self.cfg, self.log = ctx, ctx.config, ctx.log
        self.bots, self.intake_persona = bots, intake_persona      # persona id -> client
        self.intake = bots[intake_persona]
        self.gate = Gate(self.intake, self.cfg, self.log)
        self.router = Router(self.log, ctx.db, lambda: self.intake.user.id)
        self.listeners: dict[str, object] = {}
        self.persona_by_user_id: dict[int, str] = {}                # Tier 0 hook for 009 (12.10)
        self.disabled: set[str] = set(p.id for p in ctx.personas.all() if p.id not in bots) if ctx.personas else set()
        self.settled: set[str] = set()
        self.system, self.system_channel, self._fwd_task = system, None, None  # 12.14: never part of `bots`
        self.forwarder = Forwarder(self.log) if system is not None else None
        self._expect = set(bots) | ({"@system"} if system is not None else set())
        self.exit_code, self.refusal, self.ready, self._all_settled = 0, None, asyncio.Event(), asyncio.Event()
        self.message_handler = default_message_handler

    def client_for(self, persona_id: str):
        return None if persona_id in self.disabled else self.bots.get(persona_id)

    # -- listeners ---------------------------------------------------------------------------------------
    def listen(self, name: str, handler, persona_id: str | None = None, probe=None) -> None:
        """The only way to register a channel-carrying listener: allowed_channel() runs first (S12-03).
        probe(*event args) builds the object the gate inspects, for events that carry no channel themselves."""
        pid = persona_id or self.intake_persona

        async def gated(ev, *rest):
            gev = probe(ev, *rest) if probe else ev
            if not await self.gate.allowed_channel(gev):
                await refuse(gev)
                return
            try:
                await handler(ev, *rest)
            except Exception as e:  # type only: text may carry secrets
                self.log.write_log("discord", "listener.failed", "ERROR", event=name, error=type(e).__name__)
        self.listeners[f"{name}@{pid}"] = gated
        self.bots[pid].add_listener(gated, name)

    def _ungated(self, name: str, fn, pid: str) -> None:
        assert name in UNGATED
        (self.system if pid == "@system" else self.bots[pid]).add_listener(fn, name)

    # -- startup -----------------------------------------------------------------------------------------
    async def _admin_line(self, text: str) -> None:
        """12.14.6: only System posts here; without it the line goes to the file log (never Praw, never a persona)."""
        ch = self.system_channel
        if ch is not None:
            try:
                await ch.send(content=mask_secrets(text), allowed_mentions=discord.AllowedMentions.none())
                return
            except discord.HTTPException:
                pass
        self.log.write_log("discord", "admin.line", "INFO", text=text)

    def _fail(self, code: str) -> None:
        self.log.write_log("discord", "startup.refused", "ERROR", code=code)
        self.exit_code, self.refusal = 2, code

    async def _common_ready(self, pid: str) -> discord.Guild:
        bot = self.bots[pid]
        self.persona_by_user_id[bot.user.id] = pid  # before refusals: an @mention of a disabled persona still routes to Praw (OBS-1)
        if bot.application_id != self.cfg.persona_app_ids[env_suffix(pid)]:  # S12-07 per bot
            raise Refusal(f"app_id_mismatch:{pid}")
        for g in list(bot.guilds):
            if g.id != self.cfg.discord_guild_id:
                self.log.write_log("discord", "guild.left", "WARNING", guild=g.id, persona=pid)
                await g.leave()
        g = bot.get_guild(self.cfg.discord_guild_id)
        if g is None:
            raise Refusal("guild_not_found")
        return g

    async def _intake_ready(self) -> None:
        c, pid = self.cfg, self.intake_persona
        g = await self._common_ready(pid)
        role = g.get_role(c.approver_role_id) if c.approver_role_id else discord.utils.get(g.roles, name=c.approver_role_name)
        if role is None or role.id == g.id or role.managed:  # 10.13.6
            raise Refusal("approver_role_invalid")
        self.gate.approver_role_id = role.id
        for cid in c.channel_allowlist:  # S12-05
            if g.get_channel(cid) is None and g.get_thread(cid) is None:
                raise Refusal("allowlist_unresolved")
        sid = getattr(c, "settings_channel_id", None)
        if sid is not None:  # optional: /setting is refused while unset
            sch = g.get_channel(sid)
            if sch is None or not self.gate.channel_ok(sch):
                raise Refusal("settings_channel_invalid")
        for cid in (c.tasks_channel_id, c.approval_channel_id):  # S12-02 as amended by 12.14.10: #bot-log is System's to check
            ch = g.get_channel(cid)
            if ch is None:
                raise Refusal("channel_not_found")
            if not self.gate.channel_ok(ch):
                raise Refusal("channel_not_allowlisted")
        adm = g.get_channel(c.admin_notify_channel_id)
        if adm is not None and adm.permissions_for(g.me).view_channel:  # D3: Praw should not see #bot-log
            self.log.write_log("discord", "intake.sees_admin_channel", "WARNING", guild=g.id)
        self.log.write_log("discord", "gate.allowlist_applied", "INFO", count=len(c.channel_allowlist), mode=c.rollout_mode)
        self.ready.set()
        if getattr(self.ctx, "approvals", None) is not None:  # T031-09: presenter can post now
            asyncio.ensure_future(self.ctx.approvals.recover())
        self.settle(pid)
        asyncio.ensure_future(self._summary())

    def settle(self, pid: str) -> None:
        self.settled.add(pid)
        if self.settled >= self._expect:
            self._all_settled.set()

    async def _summary(self) -> None:
        """S1210-10: one online line per process (single-instance signal, 12.9), then one line per disabled persona."""
        try:
            await asyncio.wait_for(self._all_settled.wait(), SETTLE_TIMEOUT_S)
        except asyncio.TimeoutError:
            pass
        up = [p for p in self.bots if p not in self.disabled]
        await self._admin_line(f"online: {socket.gethostname()} {await asyncio.to_thread(version)} clients={len(up)}/{len(self.bots)}")
        for pid in sorted(self.disabled):
            await self._admin_line(f"persona_disabled:{pid}")

    def _on_ready(self, pid: str):
        async def on_ready():
            try:
                if pid == self.intake_persona:
                    await self._intake_ready()
                else:
                    await self._common_ready(pid)
                    self.settle(pid)
            except Refusal as r:
                await self._persona_failed(pid, r.code)

        return on_ready

    async def _persona_failed(self, pid: str, code: str) -> None:
        if pid == self.intake_persona:  # intake failure is fatal
            self._fail(code)
            await self.shutdown()
            return
        if self.exit_code:
            return
        self.disabled.add(pid)  # S1210-07: no webhook fallback; the summary line names it
        self.log.write_log("discord", "persona.disabled", "WARNING", persona=pid, reason=code.split(":")[0])
        self.settle(pid)
        try:
            await self.bots[pid].close()
        except Exception:
            pass

    # -- System (12.14.3) --------------------------------------------------------------------------------
    def _on_system_ready(self):
        async def on_ready():
            if self.system_channel is not None or self._fwd_task is not None:
                return  # idempotent: on_ready fires again after a reconnect
            try:
                await self._system_ready()
            except Refusal as r:
                await self._system_failed(r.code)
        return on_ready

    async def _system_ready(self) -> None:
        bot, c = self.system, self.cfg
        if bot.application_id != c.system_app_id:  # S12-07
            raise Refusal("app_id_mismatch:system")
        for g in list(bot.guilds):
            if g.id != c.discord_guild_id:
                self.log.write_log("discord", "guild.left", "WARNING", guild=g.id, persona="system")
                await g.leave()
        g = bot.get_guild(c.discord_guild_id)
        if g is None:
            raise Refusal("guild_not_found")
        ch = g.get_channel(c.admin_notify_channel_id)
        if ch is None or getattr(ch, "type", None) != discord.ChannelType.text:  # S1214-04
            raise Refusal("channel_not_found")
        p = ch.permissions_for(g.me)
        if not (p.view_channel and p.send_messages):
            raise Refusal("system_no_access")
        if p.administrator or p.mention_everyone:  # S1214-05 least privilege, fail closed
            raise Refusal("system_over_privileged")
        self.system_channel = ch
        self.forwarder.on_stop = lambda: setattr(self.log, "tap", None)
        self._fwd_task = asyncio.ensure_future(self.forwarder.run(ch))
        self.settle("@system")

    async def _system_failed(self, code: str) -> None:
        self.log.tap = None  # D4: log file only; no fallback to Praw
        self.system_channel = None
        self.forwarder.clear()
        self.log.write_log("discord", "system.disabled", "WARNING", reason=code.split(":")[0])
        self.settle("@system")
        try:
            await self.system.close()
        except Exception:
            pass

    async def shutdown(self) -> None:
        self.log.tap = None
        if self._fwd_task is not None:
            self._fwd_task.cancel()
        if self.system is not None:
            try:
                await self.system.close()
            except Exception:
                pass
        for b in self.bots.values():
            try:
                await b.close()
            except Exception:
                pass

    async def run(self, tokens: dict[str, str], system_token: str | None = None) -> int:
        """Start every client on this loop, staggered. Returns the exit code (2 = refusal / intake failure)."""
        async def start_system(delay: float):
            await asyncio.sleep(delay)
            try:
                await self.system.start(system_token)
            except Exception as e:  # login failure: type only, never fatal
                self.log.write_log("discord", "client.failed", "ERROR", persona="system", error=type(e).__name__)
                await self._system_failed("login_failed")

        async def start(pid: str, delay: float):
            await asyncio.sleep(delay)
            try:
                await self.bots[pid].start(tokens[pid])
            except Exception as e:  # login failure etc.: type only
                self.log.write_log("discord", "client.failed", "ERROR", persona=pid, error=type(e).__name__)
                await self._persona_failed(pid, "login_failed")
        order = [self.intake_persona] + [p for p in tokens if p != self.intake_persona]
        jobs = [start(p, (i + (1 if self.system is not None and i else 0)) * STAGGER_S) for i, p in enumerate(order)]
        if self.system is not None:
            jobs.append(start_system(STAGGER_S))  # intake at 0 s, System at 0.5 s, then personas
        await asyncio.gather(*jobs)
        return self.exit_code


async def default_message_handler(app: DiscordApp, message) -> None:
    """B1 placeholder until the 009 reply gate: DMs, @mentions of a persona bot and replies to one. Same engine path as the CLI."""
    if message.author.bot or message.webhook_id:
        return
    pid = None
    for u in message.mentions:
        pid = app.persona_by_user_id.get(u.id) or pid
    ref = getattr(message, "reference", None)
    if pid is None and ref is not None and getattr(ref, "resolved", None) is not None:
        pid = app.persona_by_user_id.get(getattr(ref.resolved.author, "id", None))
    if pid is None and message.guild is None:
        pid = app.cfg.default_agent_id
    if pid in app.disabled:  # work for a disabled persona goes to Praw
        pid = app.intake_persona
    persona = app.ctx.personas.get(pid) if pid else None
    if persona is None:
        return
    ch = message.channel
    is_thread = getattr(ch, "parent_id", None) is not None
    await app.ctx.engine.run(AgentRequest(
        agent_id=persona.id, trigger="human_message", guild_id=message.guild.id if message.guild else None,
        channel_id=ch.id, thread_id=ch.id if is_thread else None, human_user_id=message.author.id, text=message.content,
        origin="discord", human_actor=Actor("discord", str(message.author.id), message.author.display_name),
        author_name=message.author.display_name, sink=app.ctx.sinks.for_channel(ch, persona)))


def setup_discord(ctx, bots: dict[str, object], system=None) -> DiscordApp:
    """Wire the Discord side after init_core. bots: persona id -> client (intake = config.intake_persona).
    system: optional 21st client (12.14); only on_ready is registered on it and it takes the log tap."""
    app = DiscordApp(ctx, bots, ctx.config.intake_persona, system)
    if system is not None:
        app._ungated("on_ready", app._on_system_ready(), "@system")
        ctx.log.tap = app.forwarder.offer
    ctx.bot, ctx.sinks, ctx.buttons = app.intake, DiscordSinkFactory(app), app.router
    if getattr(ctx, "threads", None) is not None:
        ctx.threads.attach()  # registers the task cancel button at boot
    ctx.approval_presenter = DiscordApprovalPresenter(app)
    policy = DiscordRoleApproverPolicy(lambda: app.intake.get_guild(ctx.config.discord_guild_id),
                                       lambda: app.gate.approver_role_id, ctx.log)
    ctx.approver_policy = policy  # replaces DenyAllApproverPolicy (G1-06)
    if ctx.approvals is not None:
        ctx.approvals.policy = policy
    app.router.register("appr", make_approval_button_handler(app))
    if ctx.approvals is not None:
        ctx.approvals.set_presenter(ctx.approval_presenter)
    handler = getattr(ctx, "discord_message_handler", None) or app.message_handler  # 009 sets ctx.discord_message_handler
    app.listen("on_message", lambda m: handler(app, m))
    for pid in bots:  # one shared router on every client (12.10)
        app.listen("on_interaction", app.router.dispatch, pid)
        app._ungated("on_ready", app._on_ready(pid), pid)

    async def cmd_gate(c) -> bool:  # slash commands (registered on the intake client only)
        ok = await app.gate.allowed_channel(c.interaction)
        if not ok:
            await refuse(c.interaction)
        return ok
    app.intake.add_check(cmd_gate)
    from core.discord.notifier import register_budget
    register_budget(app)
    from core.discord.commands import register_commands
    register_commands(app)

    async def on_cmd_error(c, e):
        if not isinstance(e, discord.CheckFailure):
            app.log.write_log("discord", "command.failed", "ERROR", error=type(e).__name__)
    app._ungated("on_application_command_error", on_cmd_error, app.intake_persona)
    if getattr(ctx, "voice_manager", None) is not None:  # B2: only when VOICE_ENABLED
        from core.voice.ext import setup_discord as setup_voice
        setup_voice(app)
    return app
