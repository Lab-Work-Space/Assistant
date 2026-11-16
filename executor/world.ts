import { AuditLogEvent, type Client, type Guild } from 'discord.js';
import type { Pool } from '../db/pool.js';
import { createPermWorld } from '../discord/guild-read.js';
import type { MemberInfo } from '../discord/perm/perm-world.js';
import type { AutoModInfo, EventInfo, GuildInfo, InviteInfo, MessageInfo, ServerWorld, UserInfo } from '../discord/server/server-world.js';

/**
 * The executor's reads (Gate 1 S1: fresh from Discord on every call, never trusting anything the main application passed). Built on the
 * phase-1 PermWorld reader, over the executor's own client; the bot set comes from LIVE member data (managed roles with a bot id plus every
 * member whose user is a bot), never from a list sent over IPC.
 */
export function createServerWorld(o: { client: () => Client | undefined; guildId: string; pool: Pool }): ServerWorld {
  const guild = async (): Promise<Guild | null> => {
    const c = o.client();
    if (!c) return null;
    return c.guilds.cache.get(o.guildId) ?? (await c.guilds.fetch(o.guildId).catch(() => null));
  };
  // REST paging, not the gateway member request: Discord rate-limits that opcode per guild, so `members.fetch()` failed with
  // GatewayRateLimitError. The page already carries each bot's roles, so the limits need no per-bot fetch. Still fresh on every call (S1).
  const botMembers = async (): Promise<MemberInfo[]> => {
    const g = await guild();
    if (!g) return [];
    const out: MemberInfo[] = [];
    let after: string | undefined;
    for (let page = 0; page < 50; page++) {
      const batch = await g.members.list({ limit: 1000, after, cache: false });
      for (const m of batch.values()) {
        if (m.user.bot) out.push({ id: m.id, isBot: true, roleIds: [...m.roles.cache.keys()], isOwner: g.ownerId === m.id, username: m.user.username, nick: m.nickname,
          timeoutUntil: m.communicationDisabledUntilTimestamp ?? null });
      }
      if (batch.size < 1000) return out;
      after = batch.lastKey();
    }
    throw new Error('member list too large');
  };
  const bots = async (): Promise<string[]> => (await botMembers()).map((m) => m.id);
  const perm = createPermWorld({ client: o.client, guildId: o.guildId, knownBotIds: bots });
  const toMsg = (m: { id: string; author: { id: string; bot: boolean }; createdTimestamp: number; pinned: boolean }): MessageInfo => ({ id: m.id, authorId: m.author.id, authorBot: m.author.bot, createdAt: m.createdTimestamp, pinned: m.pinned });
  const textChannel = async (g: Guild, id: string) => {
    const ch = await g.channels.fetch(id, { force: true });
    return ch && ch.isTextBased() && !ch.isDMBased() ? ch : null;
  };
  return {
    ...perm,
    knownBotMembers: botMembers,
    async guild(): Promise<GuildInfo | null> {
      const g = await guild();
      if (!g) return null;
      try {
        const fresh = await g.fetch();
        return { id: fresh.id, name: fresh.name, description: fresh.description, systemChannelId: fresh.systemChannelId, rulesChannelId: fresh.rulesChannelId, ownerId: fresh.ownerId };
      } catch {
        return null;
      }
    },
    async messages(channelId, limit) {
      const g = await guild();
      if (!g) return null;
      try {
        const ch = await textChannel(g, channelId);
        if (!ch) return null;
        return [...(await ch.messages.fetch({ limit: Math.min(100, limit) })).values()].map(toMsg);
      } catch {
        return null;
      }
    },
    async message(channelId, id) {
      const g = await guild();
      if (!g) return null;
      try {
        const ch = await textChannel(g, channelId);
        return ch ? toMsg(await ch.messages.fetch({ message: id, force: true })) : null;
      } catch {
        return null;
      }
    },
    async channelEmpty(id) {
      const g = await guild();
      if (!g) return null;
      try {
        const ch = await g.channels.fetch(id, { force: true });
        if (!ch) return null;
        if (ch.type === 4) return !(await g.channels.fetch()).some((c) => c?.parentId === id);
        if ('threads' in ch && ch.type === 15) {
          const [act, arch] = await Promise.all([ch.threads.fetchActive(), ch.threads.fetchArchived({ limit: 1 })]);
          return act.threads.size === 0 && arch.threads.size === 0;
        }
        if (ch.isTextBased() && !ch.isDMBased()) return (await ch.messages.fetch({ limit: 1 })).size === 0;
        return true; // a voice channel without text chat: nothing to keep
      } catch {
        return null;
      }
    },
    async user(id): Promise<UserInfo | null> {
      const c = o.client();
      if (!c) return null;
      try {
        const u = await c.users.fetch(id, { force: true });
        return { id: u.id, isBot: u.bot, username: u.username };
      } catch {
        return null;
      }
    },
    async isMember(id) {
      const g = await guild();
      if (!g) return null;
      try {
        await g.members.fetch({ user: id, force: true });
        return true;
      } catch (e) {
        return (e as { code?: number }).code === 10007 ? false : null;
      }
    },
    async banned(userId) {
      const g = await guild();
      if (!g) return null;
      try {
        await g.bans.fetch({ user: userId, force: true });
        return true;
      } catch (e) {
        return (e as { code?: number }).code === 10026 ? false : null;
      }
    },
    async autoModRules() {
      const g = await guild();
      if (!g) return null;
      try {
        return [...(await g.autoModerationRules.fetch()).values()].map((r): AutoModInfo => ({
          id: r.id, name: r.name, enabled: r.enabled, triggerType: r.triggerType,
          keywords: [...r.triggerMetadata.keywordFilter], regex: [...r.triggerMetadata.regexPatterns], allow: [...r.triggerMetadata.allowList], presets: [...r.triggerMetadata.presets] as number[],
          mentionLimit: r.triggerMetadata.mentionTotalLimit, exemptRoles: [...r.exemptRoles.keys()], exemptChannels: [...r.exemptChannels.keys()],
          blockMessage: r.actions.some((a) => a.type === 1), blockCustomMessage: r.actions.find((a) => a.type === 1)?.metadata.customMessage ?? null,
          alertChannelId: r.actions.find((a) => a.type === 2)?.metadata.channelId ?? null, timeoutSeconds: r.actions.find((a) => a.type === 3)?.metadata.durationSeconds ?? null,
        }));
      } catch {
        return null;
      }
    },
    async events() {
      const g = await guild();
      if (!g) return null;
      try {
        return [...(await g.scheduledEvents.fetch()).values()].map((e): EventInfo => ({
          id: e.id, name: e.name, description: e.description, status: e.status, entityType: e.entityType, channelId: e.channelId,
          location: e.entityMetadata?.location ?? null, start: e.scheduledStartTimestamp ?? 0, end: e.scheduledEndTimestamp,
        }));
      } catch {
        return null;
      }
    },
    async invites() {
      const g = await guild();
      if (!g) return null;
      try {
        return [...(await g.invites.fetch()).values()].map((i): InviteInfo => ({ code: i.code, channelId: i.channelId, uses: i.uses ?? 0, maxUses: i.maxUses ?? 0, inviterId: i.inviterId }));
      } catch {
        return null;
      }
    },
    async mappedChannelIds() {
      return (await o.pool.query<{ channel_id: string }>('SELECT channel_id FROM channel_map')).rows.map((r) => r.channel_id);
    },
    async archivedAt(channelId) {
      const r = await o.pool.query<{ t: Date }>('SELECT archived_at AS t FROM server_archives WHERE channel_id = $1', [channelId]);
      return r.rows[0] ? r.rows[0].t.getTime() : null;
    },
    async auditLog(limit) {
      const g = await guild();
      if (!g) return null;
      try {
        const logs = await g.fetchAuditLogs({ limit: Math.min(50, limit) });
        return [...logs.entries.values()].map((e) => ({
          action: AuditLogEvent[e.action] ?? String(e.action), executorId: e.executorId, targetId: e.targetId, at: e.createdTimestamp, reason: e.reason,
        }));
      } catch {
        return null;
      }
    },
    async memberList(limit) {
      const g = await guild();
      if (!g) return null;
      try {
        const list = await g.members.fetch({ limit: Math.min(50, limit) });
        return [...list.values()].map((m) => ({
          id: m.id, isBot: m.user.bot, roleIds: [...m.roles.cache.keys()], isOwner: g.ownerId === m.id, joinedAt: m.joinedTimestamp, displayName: m.displayName,
        }));
      } catch {
        return null;
      }
    },
  };
}
