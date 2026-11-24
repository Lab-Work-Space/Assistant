"""Channel allowlist and the single inbound gate (spec 12.3, S12-01, S12-03, S12-05)."""
import time

from core.discord import strings

LOG_EVERY_S = 60.0


def channel_ids(ch) -> set[int]:
    """Ids that can admit a channel: itself, its thread parent, its category (a category admits children and threads)."""
    parent = getattr(ch, "parent", None)
    got = (getattr(ch, "id", None), getattr(ch, "parent_id", None), getattr(ch, "category_id", None),
           getattr(parent, "category_id", None))
    return {i for i in got if isinstance(i, int)}


class Gate:
    def __init__(self, bot, config, log, clock=time.monotonic):
        self.bot, self.cfg, self.log, self.clock = bot, config, log, clock
        self.ids = set(config.channel_allowlist)
        self.full = config.rollout_mode == "full"
        self.approver_role_id: int | None = None  # set at on_ready
        self._seen: dict[int, list] = {}  # channel id -> [last log time, suppressed count]

    def excluded(self, ch) -> bool:
        """12.14.5 / S1214-01: #bot-log and its threads are never a Praw channel, in any mode, for any caller."""
        return self.cfg.admin_notify_channel_id in (getattr(ch, "id", None), getattr(ch, "parent_id", None))

    def channel_ok(self, ch) -> bool:
        if self.excluded(ch):
            return False
        if self.full and not self.ids:
            return True
        return bool(self.ids & channel_ids(ch))

    async def member(self, user_id: int):
        """Fresh guild member on every call, never stored (10.13.5). None on any failure."""
        g = self.bot.get_guild(self.cfg.discord_guild_id)
        if g is None:
            return None
        try:
            return g.get_member(user_id) or await g.fetch_member(user_id)
        except Exception:
            return None

    async def dm_ok(self, user_id: int) -> bool:
        """S12-01: a DM goes only to a non-bot guild member; in coexist only to approver-role holders."""
        m = await self.member(user_id)
        if m is None or getattr(m, "bot", False):
            return False
        if self.full:
            return True
        return self.approver_role_id is not None and any(r.id == self.approver_role_id for r in m.roles)

    def _note(self, cid) -> None:
        now = self.clock()
        rec = self._seen.get(cid)
        if rec is not None and now - rec[0] < LOG_EVERY_S:
            rec[1] += 1
            return
        if len(self._seen) > 1000:
            self._seen.clear()
        self._seen[cid] = [now, 0]
        # channel id and suppressed count only, never content (12.3)
        self.log.write_log("gate", "gate.outside_allowlist", "INFO", channel=cid, suppressed=rec[1] if rec else 0)

    async def allowed_channel(self, ev) -> bool:
        """S12-03: runs first in every listener. ev: message, interaction, raw payload or reaction."""
        msg = getattr(ev, "message", None)
        src = ev if getattr(ev, "channel", None) or getattr(ev, "channel_id", None) else msg
        cid = getattr(src, "channel_id", None)
        ch = getattr(src, "channel", None)
        if ch is not None:
            cid = ch.id
        elif cid is not None:
            ch = self.bot.get_channel(cid)
        gid = getattr(src, "guild_id", None) or getattr(getattr(src, "guild", None), "id", None)
        user = getattr(src, "author", None) or getattr(src, "user", None)
        uid = getattr(user, "id", None) or getattr(src, "user_id", None)
        if gid is None:  # direct message
            ok = uid is not None and await self.dm_ok(uid)
        else:
            ok = gid == self.cfg.discord_guild_id and ch is not None and self.channel_ok(ch)
        if not ok:
            self._note(cid)
        return ok


async def refuse(ev) -> None:
    """Interactions get an ephemeral refusal (S12-03); everything else stays silent."""
    resp = getattr(ev, "response", None)
    if resp is None:
        return
    try:
        if not resp.is_done():
            await resp.send_message(strings.NOT_ALLOWED, ephemeral=True)
    except Exception:
        pass
