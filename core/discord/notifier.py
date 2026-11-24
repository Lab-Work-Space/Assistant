"""Budget notifier + /budget commands + weekly-scan alert (spec 3.11, 10.7.7, 12.5, OQ-8; TASK-018B).
Every post goes to ADMIN_NOTIFY_CHANNEL_ID with fixed text; only the approver role may be pinged."""
import asyncio
import json
import re
import sys
import urllib.request
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation
from zoneinfo import ZoneInfo

import discord

from core.budget import repo
from core.budget.guard import GATE
from core.discord.allowlist import refuse
from core.functions.logs.masking import mask_secrets
from core.interfaces import Actor

_TEXT = {"warn80": "reached 80% of its daily budget", "fallback100": "reached 100% of its daily budget (cheap model)",
         "stop120": "reached 120% of its daily budget (stopped)"}
NOT_APPROVER = "Only the approver role can set budgets. / เฉพาะผู้อนุมัติเท่านั้น"
REFUSED = "Refused. / ปฏิเสธคำสั่ง"
_AGENT = re.compile(r"^[A-Za-z0-9_-]{1,32}$")


def _usd(micro: int) -> str:
    return f"${Decimal(micro) / 1_000_000:.2f}"


def make_notifier(app):
    """Guard.notifier: (agent_id, level, spent_micro, limit_micro). Raises on failure; Guard logs it."""
    async def notify(agent_id: str, level: str, spent: int, limit: int) -> None:
        ch = app.system_channel  # 12.14.6: only System posts here; no Praw fallback
        rid = app.gate.approver_role_id
        if ch is None or rid is None or level not in _TEXT:
            raise RuntimeError("notify_unavailable")
        who = agent_id if _AGENT.fullmatch(agent_id) else "unknown"
        await ch.send(content=mask_secrets(f"<@&{rid}> budget: {who} {_TEXT[level]} ({_usd(spent)} / {_usd(limit)})"),
                      allowed_mentions=discord.AllowedMentions(roles=[discord.Object(id=rid)], users=False,
                                                               everyone=False, replied_user=False))
    return notify


# -- /budget -------------------------------------------------------------------------------------------------
async def _say(interaction, text: str) -> None:
    await interaction.response.send_message(mask_secrets(text)[:2000], ephemeral=True)


def _origin_ok(app, interaction) -> bool:
    """G2-07: a real guild slash-command interaction, and the policy is the Discord one."""
    u = getattr(interaction, "user", None)
    return (getattr(interaction, "type", None) == discord.InteractionType.application_command
            and isinstance(getattr(u, "id", None), int) and not getattr(u, "bot", False)
            and getattr(interaction, "guild_id", None) == app.cfg.discord_guild_id
            and getattr(app.ctx.approver_policy, "surface", None) == "discord")


async def budget_view(app, interaction, agent: str | None = None) -> None:
    ctx, c = app.ctx, app.cfg
    ids = [p.id for p in ctx.personas.all()] + [GATE]
    if agent is not None:
        if agent not in ids:
            return await _say(interaction, "Unknown agent. / ไม่พบเอเจนต์")
        ids = [agent]
    now = datetime.now(ZoneInfo(c.app_timezone))
    day = now.date()
    lines = []
    for a in ids:
        lim = await repo.limit(ctx.db, a)
        if lim is None:
            lim = int((c.budget_gate_daily_usd if a == GATE else c.budget_default_daily_usd) * 1_000_000)
        sp = await repo.spent(ctx.db, a, day)
        pct = sp * 100 // lim if lim else 0
        lines.append(f"{a}: {_usd(sp)} / {_usd(lim)} ({pct}%)")
    reset = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    await _say(interaction, "\n".join(lines) + f"\nresets {reset:%Y-%m-%d %H:%M} {c.app_timezone}")


async def budget_set(app, interaction, agent: str, usd: str) -> None:
    if not _origin_ok(app, interaction):
        app.log.write_log("budget", "budget.set_refused", "WARNING", reason="origin")
        return await refuse(interaction)
    try:
        amount = Decimal(usd.strip())
        if not amount.is_finite():
            raise InvalidOperation
    except (InvalidOperation, AttributeError):
        return await _say(interaction, "Invalid amount. / จำนวนเงินไม่ถูกต้อง")
    u = interaction.user
    out = await app.ctx.budget.set_limit(agent, amount, Actor("discord", str(u.id), getattr(u, "display_name", "")))
    await _say(interaction, {"ok": f"Budget for {agent} set to {_usd(int(amount * 1_000_000))}. / ตั้งงบแล้ว",
                             "not_approver": NOT_APPROVER, "invalid_agent": "Unknown agent. / ไม่พบเอเจนต์",
                             "out_of_range": "Amount must be 0.01 to 1000. / จำนวนต้องอยู่ระหว่าง 0.01 ถึง 1000"}[out])


def register_budget(app) -> None:
    """Guild-scoped on the intake client only (12.2). Call once from setup_discord; sets ctx.budget.notifier."""
    g = discord.SlashCommandGroup("budget", "Agent daily budgets")

    @g.command(name="view", description="Show spend and limits")
    async def view(ctx, agent: discord.Option(str, "agent id", required=False) = None):  # noqa: F821
        await budget_view(app, ctx.interaction, agent)

    @g.command(name="set", description="Set an agent's daily limit (approver role)")
    async def set_(ctx, agent: discord.Option(str, "agent id"), usd: discord.Option(str, "USD, 0.01-1000")):  # noqa: F821
        await budget_set(app, ctx.interaction, agent, usd)

    app.intake.add_application_command(g)
    if hasattr(app.ctx.budget, "notifier"):
        app.ctx.budget.notifier = make_notifier(app)


# -- weekly scan alert (OQ-8) --------------------------------------------------------------------------------
_UNIT, _STATUS = re.compile(r"^[A-Za-z0-9_.@-]{1,64}$"), re.compile(r"^[A-Za-z0-9_-]{1,16}$")


def scan_text(unit: str, status: str) -> str:
    """Only the unit name and exit status, validated; nothing else from scan output (10.4)."""
    if not _UNIT.fullmatch(unit or "") or not _STATUS.fullmatch(status or ""):
        raise ValueError("invalid_scan_alert")
    return f"weekly scan failed: {unit} (exit {status})"


def _http_post(token: str, channel_id: int, text: str) -> None:
    req = urllib.request.Request(
        f"https://discord.com/api/v10/channels/{channel_id}/messages", method="POST",
        data=json.dumps({"content": text, "allowed_mentions": {"parse": []}}).encode(),
        headers={"Authorization": f"Bot {token}", "Content-Type": "application/json", "User-Agent": "employee-audit (0)"})
    urllib.request.urlopen(req, timeout=10).close()


def post_scan_alert(config, unit: str, status: str, post=_http_post) -> None:
    token = config.system_token
    if not token:
        raise RuntimeError("missing_system_token")
    post(token, config.admin_notify_channel_id, scan_text(unit, status))


def main(argv=None) -> int:
    """python -m core.discord.notifier scan-failed <unit> <exit-status> --env-file PATH. Exit 0 sent, 1 failed (code only)."""
    from core.config import Config, parse_env_file
    a = list(sys.argv[1:] if argv is None else argv)
    try:
        if len(a) != 5 or a[0] != "scan-failed" or a[3] != "--env-file":
            raise ValueError("usage")
        post_scan_alert(Config.load(parse_env_file(a[4])), a[1], a[2])
        return 0
    except Exception as e:
        print(f"scan_alert_failed:{type(e).__name__}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
