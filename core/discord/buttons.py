"""ButtonRouter (spec 5.5): one global interaction path, ids survive restarts. Handlers are registered by feature tasks."""
import re

import discord

from core.discord import strings

CUSTOM_ID = re.compile(r"^emp:(task|appr|rec):[a-z]{2,10}:[0-9a-f-]{36}$")


def make_custom_id(kind: str, action: str, uid: str) -> str:
    cid = f"emp:{kind}:{action}:{uid}"
    if len(cid) > 100 or not CUSTOM_ID.fullmatch(cid):
        raise ValueError("invalid_custom_id")
    return cid


async def _noop(_interaction) -> None:  # the router handles clicks; View items just need a callback
    return None


def build_view(buttons) -> discord.ui.View:
    """buttons: (label, custom_id | None, url | None[, style]). Link buttons carry a url instead of a custom_id."""
    v = discord.ui.View(timeout=None)
    for label, cid, url, *style in buttons:
        b = discord.ui.Button(label=label, custom_id=cid, url=url, style=style[0] if style else discord.ButtonStyle.secondary)
        b.callback = _noop
        v.add_item(b)
    return v


_RECORD = {"appr": "SELECT message_id AS m FROM approvals WHERE id=?1",
           "task": "SELECT embed_message_id AS m FROM tasks WHERE id=?1",
           "rec": "SELECT notice_message_id AS m FROM voice_sessions WHERE id=?1"}


class Router:
    def __init__(self, log, db=None, intake_user_id=lambda: None):
        self.log, self.db, self.intake_user_id, self._h = log, db, intake_user_id, {}

    async def _bound(self, interaction, kind: str, uid: str) -> bool:
        """S1210-02: the click belongs to the stored message, posted by the client that received it."""
        msg, me = getattr(interaction, "message", None), getattr(getattr(interaction, "client", None), "user", None)
        if msg is None or me is None or getattr(msg.author, "id", None) != me.id:
            return False
        if kind == "appr" and me.id != self.intake_user_id():  # only the intake client posts approval cards
            return False
        if kind not in _RECORD or self.db is None:
            return False
        row = await self.db.fetchrow(_RECORD[kind], uid)
        return row is not None and row["m"] == msg.id

    def register(self, kind: str, handler) -> None:
        self._h[kind] = handler

    async def dispatch(self, interaction) -> None:
        """Gated listener body. Component clicks only; slash commands are handled by py-cord."""
        if getattr(interaction, "type", None) != discord.InteractionType.component:
            return
        cid = (getattr(interaction, "data", None) or {}).get("custom_id", "")
        m = CUSTOM_ID.fullmatch(cid) if isinstance(cid, str) and len(cid) <= 100 else None
        h = self._h.get(cid.split(":")[1]) if m else None
        if h is None or not await self._bound(interaction, cid.split(":")[1], cid.split(":", 3)[3]):
            await interaction.response.send_message(strings.BUTTON_INACTIVE, ephemeral=True)
            return
        _, kind, action, uid = cid.split(":", 3)
        await interaction.response.defer(ephemeral=True)  # within 3 s; handlers answer through interaction.followup
        try:
            await h(interaction, action, uid)
        except Exception as e:
            self.log.write_log("buttons", "button.handler_failed", "ERROR", kind=kind, error=type(e).__name__)
            try:
                await interaction.followup.send(strings.INTERNAL_ERROR, ephemeral=True)
            except Exception:
                pass
