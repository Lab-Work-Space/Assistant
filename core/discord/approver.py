"""Discord ApproverPolicy (spec 10.7.3), the 'appr' button handler (10.7.4) and the actor helper for G2-07."""
import discord

from core.discord import strings
from core.discord.buttons import CUSTOM_ID  # noqa: F401  (re-exported for 018B)
from core.interfaces import Actor


class DiscordRoleApproverPolicy:
    """Fresh fetch_member on every call; cached roles are never used (G1-14.4). Any failure is False."""
    surface = "discord"

    def __init__(self, guild_fn, role_id_fn, log):
        self._guild, self._role, self.log = guild_fn, role_id_fn, log

    async def is_approver(self, actor: Actor) -> bool:
        if actor.kind != "discord":
            return False
        try:
            role_id, guild = self._role(), self._guild()
            if role_id is None or guild is None:
                return False
            member = await guild.fetch_member(int(actor.user_id))
            return any(r.id == role_id for r in member.roles)
        except Exception as e:  # NotFound, HTTPException, anything: fail closed
            self.log.write_log("approvals", "approval.policy_error", "WARNING", error=type(e).__name__)
            return False


def actor_from_interaction(app, interaction) -> Actor | None:
    """The only place a surface=discord Actor is built from an event (G2-07): a real component/command interaction from
    a non-bot guild user in the configured guild and an allowlisted channel. None means refuse."""
    if getattr(interaction, "type", None) not in (discord.InteractionType.component, discord.InteractionType.application_command):
        return None
    user = getattr(interaction, "user", None)
    uid = getattr(user, "id", None)
    if not isinstance(uid, int) or getattr(user, "bot", False) or getattr(interaction, "guild_id", None) != app.cfg.discord_guild_id:
        return None
    cid = getattr(interaction, "channel_id", None)
    ch = getattr(interaction, "channel", None) or app.intake.get_channel(cid)
    if ch is None or not app.gate.channel_ok(ch):
        return None
    return Actor("discord", str(uid), str(getattr(user, "display_name", "") or ""))


_OUTCOME = {"approved": strings.APPROVED, "rejected": strings.REJECTED, "not_approver": strings.NOT_APPROVER,
            "expired": strings.EXPIRED, "already_decided": strings.ALREADY_DECIDED, "not_found": strings.BUTTON_INACTIVE}


def make_approval_button_handler(app):
    async def handler(interaction, action: str, approval_id: str) -> None:
        actor = actor_from_interaction(app, interaction)
        out = "not_approver" if actor is None else (await app.ctx.approvals.decide(approval_id, action, actor)).outcome
        await interaction.followup.send(_OUTCOME.get(out, strings.INTERNAL_ERROR), ephemeral=True)
    return handler
