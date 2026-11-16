import { OverwriteType, type Client, type Guild, type GuildBasedChannel, type GuildMember } from 'discord.js';
import type { ChannelInfo, MemberInfo, PermWorld, RoleInfo } from './perm/perm-world.js';

/** Unknown Channel, Missing Access, Missing Permissions: the channel is gone or off-limits to the bot (same codes as the boot check). */
const HIDDEN_CODES = new Set([10003, 50001, 50013]);

/**
 * Reads the guild through Praw's own client, always fresh (never the gateway cache for a decision), and never needing the Server Members
 * intent: members are fetched one id at a time. Read-only; the writes live in perm-apply.ts and nowhere else (Gate 1 C14).
 */
export function createPermWorld(o: { client: () => Client | undefined; guildId: string; knownBotIds: () => string[] | Promise<string[]> }): PermWorld {
  const guild = async (): Promise<Guild | null> => {
    const c = o.client();
    if (!c) return null;
    return c.guilds.cache.get(o.guildId) ?? (await c.guilds.fetch(o.guildId).catch(() => null));
  };
  const memberInfo = (g: Guild, m: GuildMember): MemberInfo => ({
    id: m.id, isBot: m.user.bot, roleIds: [...m.roles.cache.keys()], isOwner: g.ownerId === m.id, username: m.user.username, nick: m.nickname,
    timeoutUntil: m.communicationDisabledUntilTimestamp ?? null,
  });
  const channelInfo = (ch: GuildBasedChannel): ChannelInfo => ({
    id: ch.id, name: ch.name, type: ch.type, parentId: ch.parentId, isThread: ch.isThread(),
    ...('topic' in ch ? { topic: ch.topic ?? null } : {}), ...('rateLimitPerUser' in ch ? { slowmode: ch.rateLimitPerUser ?? 0 } : {}), ...('nsfw' in ch ? { nsfw: !!ch.nsfw } : {}),
    ...('rawPosition' in ch ? { position: ch.rawPosition } : {}), ...(ch.isThread() ? { archived: !!ch.archived, locked: !!ch.locked } : {}),
    overwrites: 'permissionOverwrites' in ch
      ? [...ch.permissionOverwrites.cache.values()].map((w) => ({ id: w.id, type: w.type === OverwriteType.Role ? ('role' as const) : ('member' as const), allow: w.allow.bitfield, deny: w.deny.bitfield }))
      : [],
  });
  return {
    guildId: o.guildId,
    knownBotIds: o.knownBotIds,
    async me() {
      const g = await guild();
      if (!g) return null;
      const m = await g.members.fetchMe({ force: true }).catch(() => null);
      return m ? { ...memberInfo(g, m), topPosition: m.roles.highest.position } : null;
    },
    async roles() {
      const g = await guild();
      if (!g) return null;
      try {
        const roles = await g.roles.fetch();
        return [...roles.values()].map((r): RoleInfo => ({ id: r.id, name: r.name, position: r.position, managed: r.managed, botId: r.tags?.botId ?? null, permissions: r.permissions.bitfield }));
      } catch {
        return null;
      }
    },
    async channel(id) {
      const g = await guild();
      if (!g) return null;
      try {
        const ch = await g.channels.fetch(id, { force: true });
        return ch ? channelInfo(ch) : null;
      } catch {
        return null;
      }
    },
    async channels() {
      const g = await guild();
      if (!g) return null;
      try {
        return [...(await g.channels.fetch()).values()].flatMap((c) => (c ? [channelInfo(c)] : []));
      } catch {
        return null;
      }
    },
    async member(id) {
      const g = await guild();
      if (!g) return null;
      try {
        return memberInfo(g, await g.members.fetch({ user: id, force: true }));
      } catch {
        return null;
      }
    },
    async probeChannel(id) {
      const c = o.client();
      if (!c) return 'error';
      try {
        await c.channels.fetch(id, { force: true });
        return 'visible';
      } catch (e) {
        return HIDDEN_CODES.has((e as { code?: number }).code ?? -1) ? 'hidden' : 'error';
      }
    },
  };
}
