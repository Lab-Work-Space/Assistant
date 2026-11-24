"""Pull-user (spec 3.8, 10.11.2-4, 12.7 S12-01, 12.12.15): thread mention or DM invite; destination=voice adds a link to the
requester's allowlisted voice channel (never a move).
Every channel check goes through sinks.for_target (guild, allowlist, approval/admin exclusion, human permissions)."""
import time
from collections import defaultdict, deque

import discord

from core.discord.embeds import pull_invite_embed
from core.functions.logs.masking import mask_secrets
from core.interfaces import TargetError

WINDOW_S = 600.0


class PullUserService:
    def __init__(self, ctx, clock=time.monotonic):
        self.ctx, self.clock, self._hits = ctx, clock, defaultdict(deque)

    def _rate_ok(self, target_id: int) -> bool:
        q, now = self._hits[target_id], self.clock()
        while q and now - q[0] > WINDOW_S:
            q.popleft()
        if len(q) >= self.ctx.config.pull_max_per_target:
            return False
        q.append(now)
        return True

    async def pull(self, tc, a: dict) -> tuple[str, str | None]:
        """Returns (method, None) or ("", error_code)."""
        app = getattr(self.ctx.sinks, "app", None)
        voice = a.get("destination") == "voice"
        if voice and (app is None or not getattr(self.ctx.config, "voice_enabled", False)):
            return "", "voice_not_available"
        if app is None:
            return "", "target_not_allowed"
        uid = int(a["user_id"])
        member = await app.gate.member(uid)
        if member is None or getattr(member, "bot", False):
            return "", "user_not_found"
        if uid == tc.human_user_id:
            return "", "invalid_target"  # no self-pull
        cid = tc.thread_id or tc.channel_id
        link = cid
        if voice:  # the requester's own voice channel, in the guild and allowlisted (B2-D6)
            me = await app.gate.member(tc.human_user_id) if tc.human_user_id else None
            vch = getattr(getattr(me, "voice", None), "channel", None)
            if vch is None or getattr(getattr(vch, "guild", None), "id", None) != app.cfg.discord_guild_id \
                    or not app.gate.channel_ok(vch) or not vch.permissions_for(member).view_channel:
                return "", "voice_not_available"
            link = vch.id
        try:
            await self.ctx.sinks.for_target("thread", cid, tc.agent, tc)
        except TargetError as e:
            return "", e.code
        if not self._rate_ok(uid):
            return "", "rate_limited"
        ch = app.intake.get_channel(cid) or await app.intake.fetch_channel(cid)
        reason = mask_secrets(a["reason"])[:300]
        pre = "voice_" if voice else ""
        if a.get("destination") in ("dm", "voice") and await app.gate.dm_ok(uid):  # coexist: approver-role holders only
            e, v = pull_invite_embed(tc.agent, reason, app.cfg.discord_guild_id, link)
            try:
                await self.ctx.sinks.for_dm(uid, tc.agent).send_embed(e, v)
                return pre + "dm_invite", None
            except (discord.Forbidden, TargetError):
                pass  # DM closed: fall back to the thread mention
        if not ch.permissions_for(member).view_channel:
            return "", "target_not_allowed"
        client = app.client_for(tc.agent.id) or app.intake
        pch = await self.ctx.sinks._channel_for(client, cid)
        try:
            thread = pch if getattr(pch, "parent_id", None) else await pch.create_thread(
                name=f"{tc.agent.name} invite"[:100], type=discord.ChannelType.public_thread)
        except discord.Forbidden:
            return "", "missing_permission:create_threads"
        # the one allowed mention: the target only (G1-11)
        url = f" https://discord.com/channels/{app.cfg.discord_guild_id}/{link}" if voice else ""
        await thread.send(content=mask_secrets(f"<@{uid}> {tc.agent.name} asks you to join: {reason}")[:1900] + url,
                          allowed_mentions=discord.AllowedMentions(users=[discord.Object(id=uid)], everyone=False, roles=False))
        return ("voice_invite_thread" if voice else "thread_mention"), None
