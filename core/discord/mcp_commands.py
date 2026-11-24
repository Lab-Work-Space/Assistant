"""/mcp status (spec 3.13): settings channel + fresh approver via _setting_gate, ephemeral. Output carries service
names, states and counts plus sanitised tool names only; never env, tokens or args."""
import datetime as dt

import discord

from core.discord.commands import _deny_log, _say, _setting_gate

_UNAVAILABLE = "MCP is not available. / MCP ยังไม่พร้อม"
_MAX = 1900


async def mcp_status(app, interaction) -> None:
    actor = await _setting_gate(app, interaction, "mcp_status", None)
    if actor is None:
        return
    mcp = getattr(app.ctx, "mcp", None)
    host = getattr(mcp, "host", mcp)  # ctx.mcp is the Gateway; it may expose the host, or be the host in tests
    try:
        rows = host.status() if host is not None else None
    except Exception:  # noqa: BLE001 - a broken host must not leak a traceback to Discord
        rows = None
    if not rows:
        _deny_log(app, "mcp_status", actor, "mcp_unavailable")
        return await _say(interaction, _UNAVAILABLE)
    since = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    lines = []
    for r in rows:
        svc = str(r["service"])
        n = await app.ctx.db.fetchval("SELECT count(*) FROM audit_log WHERE scope='mcp' AND action='call' AND ref LIKE ?1 AND at > ?2",
                                      svc + ":%", since)
        line = f"{svc}: {r['state']} | tools {r['active']} active, {r['blocked']} blocked | restarts {r['restarts']} | calls 24h {n or 0}"
        if r.get("unclassified"):
            line += " | unclassified: " + ", ".join(r["unclassified"])
        lines.append(line)
    await _say(interaction, "\n".join(lines)[:_MAX])


def register_mcp_commands(app) -> None:
    g = discord.SlashCommandGroup("mcp", "MCP services")

    @g.command(name="status", description="MCP service status (settings channel, approver role)")
    async def _ms(ctx):
        await mcp_status(app, ctx.interaction)

    app.intake.add_application_command(g)
