import { createHash } from 'node:crypto';
import {
  AutoModerationActionType, AutoModerationRuleEventType, AutoModerationRuleTriggerType, ChannelType, GuildScheduledEventEntityType, GuildScheduledEventPrivacyLevel,
  GuildScheduledEventStatus, PermissionFlagsBits, type Client, type Guild, type GuildBasedChannel, type GuildTextBasedChannel,
} from 'discord.js';
import type { ApplyReport } from '../perm/perm-apply.js';
import { makeTypeCode, type ResolvedServerOp } from './server-limits.js';
import type { ServerOp } from './server-ops.js';
import type { AutoModWrite, EventWrite, ServerWriter } from './server-world.js';

/**
 * THE second executor (Gate 1 S7): with discord/perm/perm-apply.ts, the only module that calls Discord guild write APIs. It runs only inside the
 * executor process ("LW Admin"), from a card the executor claimed and whose ops server-limits.ts re-validated on live data. Also the one
 * place the welcome flow adds a default role (S12 checks run first, in the executor's welcome handler).
 * Image uploads (icon, banner, emoji, sticker) are not implemented in this phase (Gate 1 S24, S27).
 */

const F = PermissionFlagsBits;
const MAKE = { text: ChannelType.GuildText, voice: ChannelType.GuildVoice, forum: ChannelType.GuildForum, stage: ChannelType.GuildStageVoice, announcement: ChannelType.GuildAnnouncement, category: ChannelType.GuildCategory } as const;
const TRIGGER = { 1: AutoModerationRuleTriggerType.Keyword, 3: AutoModerationRuleTriggerType.Spam, 4: AutoModerationRuleTriggerType.KeywordPreset, 5: AutoModerationRuleTriggerType.MentionSpam } as const;

void makeTypeCode;

function metadataOf(r: Partial<AutoModWrite>) {
  return {
    ...(r.keywords ? { keywordFilter: r.keywords } : {}), ...(r.regex ? { regexPatterns: r.regex } : {}), ...(r.allow ? { allowList: r.allow } : {}),
    ...(r.presets ? { presets: r.presets as never } : {}), ...(r.mentionLimit !== undefined ? { mentionTotalLimit: r.mentionLimit } : {}),
  };
}
function actionsOf(r: Partial<AutoModWrite>) {
  const a: { type: AutoModerationActionType; metadata?: { channel?: string; durationSeconds?: number; customMessage?: string } }[] = [];
  if (r.block) a.push({ type: AutoModerationActionType.BlockMessage, ...(r.blockCustomMessage ? { metadata: { customMessage: r.blockCustomMessage } } : {}) });
  if (r.alertChannelId) a.push({ type: AutoModerationActionType.SendAlertMessage, metadata: { channel: r.alertChannelId } });
  if (r.timeoutSeconds !== undefined) a.push({ type: AutoModerationActionType.Timeout, metadata: { durationSeconds: r.timeoutSeconds } });
  return a;
}

/** The Discord write calls, over the executor's own client. Fresh fetches only (never a cached object for a write). */
export function createServerWriter(o: { client: () => Client | undefined; guildId: string }): ServerWriter {
  const guild = async (): Promise<Guild> => {
    const c = o.client();
    if (!c) throw new Error('the executor client is offline');
    return c.guilds.cache.get(o.guildId) ?? (await c.guilds.fetch(o.guildId));
  };
  const chan = async (g: Guild, id: string): Promise<GuildBasedChannel> => {
    const ch = await g.channels.fetch(id, { force: true });
    if (!ch) throw new Error(`channel ${id} not found`);
    return ch;
  };
  const textChan = async (g: Guild, id: string): Promise<GuildTextBasedChannel> => {
    const ch = await chan(g, id);
    if (!ch.isTextBased() || ch.isDMBased()) throw new Error(`channel ${id} has no messages`);
    return ch as GuildTextBasedChannel;
  };
  const member = async (g: Guild, id: string) => g.members.fetch({ user: id, force: true });
  return {
    async editChannel(id, e, reason) {
      const g = await guild();
      const ch = await chan(g, id);
      if (ch.isThread()) throw new Error('a thread is not edited as a channel');
      await ch.edit({ ...(e.name !== undefined ? { name: e.name } : {}), ...(e.topic !== undefined ? { topic: e.topic } : {}), ...(e.slowmode !== undefined ? { rateLimitPerUser: e.slowmode } : {}), ...(e.nsfw !== undefined ? { nsfw: e.nsfw } : {}), reason } as never);
    },
    async moveChannel(id, m, reason) {
      const g = await guild();
      const ch = await chan(g, id);
      if (ch.isThread() || !('setParent' in ch)) throw new Error('this channel cannot be moved');
      if (m.parentId !== (ch.parentId ?? null)) await ch.setParent(m.parentId, { lockPermissions: false, reason });
      if (m.position !== undefined) await ch.setPosition(m.position, { reason });
    },
    async makeChannel(m, reason) {
      const g = await guild();
      const made = await g.channels.create({ name: m.name, type: MAKE[m.type] as never, ...(m.parentId ? { parent: m.parentId } : {}), ...(m.topic ? { topic: m.topic } : {}), reason } as never);
      return made.id;
    },
    async archiveChannel(id, a, reason) {
      const g = await guild();
      const ch = await chan(g, id);
      if (ch.isThread() || !('setParent' in ch) || !('permissionOverwrites' in ch)) throw new Error('this channel cannot be archived');
      await ch.setParent(a.archiveCategoryId, { lockPermissions: false, reason });
      await ch.permissionOverwrites.edit(a.everyoneRoleId, { SendMessages: false, SendMessagesInThreads: false }, { reason });
      for (const w of [...ch.permissionOverwrites.cache.values()]) {
        if (w.id !== a.everyoneRoleId && (w.allow.has(F.SendMessages) || w.allow.has(F.SendMessagesInThreads))) await w.edit({ SendMessages: null, SendMessagesInThreads: null }, reason);
      }
    },
    async deleteChannel(id, reason) {
      const g = await guild();
      await g.channels.delete(id, reason);
    },
    async setThread(id, action, reason) {
      const g = await guild();
      const t = await chan(g, id);
      if (!t.isThread()) throw new Error(`${id} is not a thread`);
      if (action === 'delete') await g.channels.delete(id, reason);
      else if (action === 'archive') await t.setArchived(true, reason);
      else await t.setLocked(action === 'lock', reason);
    },
    async setNick(memberId, nick, reason) {
      const g = await guild();
      await (await member(g, memberId)).setNickname(nick, reason);
    },
    async createInvite(channelId, i, reason) {
      const g = await guild();
      const inv = await g.invites.create(channelId, { maxAge: i.maxAgeSeconds, maxUses: i.maxUses, unique: true, reason });
      return inv.code;
    },
    async revokeInvite(code, reason) {
      const g = await guild();
      await g.invites.delete(code, reason);
    },
    async deleteMessage(channelId, messageId) {
      const g = await guild();
      await (await textChan(g, channelId)).messages.delete(messageId); // the API takes no audit-log reason for a single delete here
    },
    async bulkDelete(channelId, ids) {
      const g = await guild();
      const ch = await textChan(g, channelId);
      if (!('bulkDelete' in ch)) throw new Error('this channel does not support bulk delete');
      const done = await ch.bulkDelete(ids, true);
      return done.size;
    },
    async pin(channelId, messageId, on, reason) {
      const g = await guild();
      const ch = await textChan(g, channelId);
      if (on) await ch.messages.pin(messageId, reason);
      else await ch.messages.unpin(messageId, reason);
    },
    async timeout(memberId, until, reason) {
      const g = await guild();
      await (await member(g, memberId)).disableCommunicationUntil(until, reason);
    },
    async kick(memberId, reason) {
      const g = await guild();
      await g.members.kick(memberId, reason);
    },
    async ban(userId, deleteDays, reason) {
      const g = await guild();
      await g.members.ban(userId, { deleteMessageSeconds: deleteDays * 86_400, reason });
    },
    async unban(userId, reason) {
      const g = await guild();
      await g.members.unban(userId, reason);
    },
    async createAutoMod(r, reason) {
      const g = await guild();
      const rule = await g.autoModerationRules.create({
        name: r.name, eventType: AutoModerationRuleEventType.MessageSend, triggerType: TRIGGER[r.triggerType], triggerMetadata: metadataOf(r),
        actions: actionsOf(r), enabled: r.enabled, exemptRoles: r.exemptRoles, exemptChannels: r.exemptChannels, reason,
      });
      return rule.id;
    },
    async editAutoMod(id, r, reason) {
      const g = await guild();
      await g.autoModerationRules.edit(id, {
        ...(r.name !== undefined ? { name: r.name } : {}), ...(r.enabled !== undefined ? { enabled: r.enabled } : {}),
        ...(r.keywords || r.regex || r.allow || r.presets || r.mentionLimit !== undefined ? { triggerMetadata: metadataOf(r) } : {}),
        ...(r.block || r.alertChannelId || r.timeoutSeconds !== undefined ? { actions: actionsOf(r) } : {}),
        ...(r.exemptRoles ? { exemptRoles: r.exemptRoles } : {}), ...(r.exemptChannels ? { exemptChannels: r.exemptChannels } : {}), reason,
      });
    },
    async deleteAutoMod(id, reason) {
      const g = await guild();
      await g.autoModerationRules.delete(id, reason);
    },
    async editGuild(e, reason) {
      const g = await guild();
      await g.edit({
        ...(e.name !== undefined ? { name: e.name } : {}), ...(e.description !== undefined ? { description: e.description } : {}),
        ...(e.systemChannelId !== undefined ? { systemChannel: e.systemChannelId } : {}), ...(e.rulesChannelId !== undefined ? { rulesChannel: e.rulesChannelId } : {}), reason,
      });
    },
    async createEvent(ev: EventWrite, reason) {
      const g = await guild();
      const made = await g.scheduledEvents.create({
        name: ev.name, scheduledStartTime: ev.start, ...(ev.end ? { scheduledEndTime: ev.end } : {}), privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
        entityType: ev.type === 'voice' ? GuildScheduledEventEntityType.Voice : ev.type === 'stage' ? GuildScheduledEventEntityType.StageInstance : GuildScheduledEventEntityType.External,
        ...(ev.channelId ? { channel: ev.channelId } : {}), ...(ev.location ? { entityMetadata: { location: ev.location } } : {}), ...(ev.description ? { description: ev.description } : {}), reason,
      });
      return made.id;
    },
    async editEvent(id, ev, reason) {
      const g = await guild();
      await g.scheduledEvents.edit(id, {
        ...(ev.name !== undefined ? { name: ev.name } : {}), ...(ev.description !== undefined ? { description: ev.description } : {}),
        ...(ev.start ? { scheduledStartTime: ev.start } : {}), ...(ev.end ? { scheduledEndTime: ev.end } : {}),
        ...(ev.cancel ? { status: GuildScheduledEventStatus.Canceled } : {}), reason,
      });
    },
    async addRole(memberId, roleId, reason) {
      const g = await guild();
      await (await member(g, memberId)).roles.add(roleId, reason);
    },
  };
}

export const MESSAGE_OPS: readonly ServerOp['kind'][] = ['msg.delete', 'msg.bulk', 'msg.pin', 'msg.unpin'];

const hash8 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 8);
/** What the audit row names as the target of an op: ids only (S33). */
export function serverTarget(op: ServerOp): string {
  switch (op.kind) {
    case 'channel.edit': case 'channel.move': case 'channel.archive': case 'channel.delete': return op.channel;
    case 'channel.make': return op.category ?? 'top';
    case 'thread.archive': case 'thread.lock': case 'thread.unlock': case 'thread.delete': return op.thread;
    case 'member.nick': case 'member.timeout': case 'member.untimeout': case 'member.kick': case 'member.ban': return op.member;
    case 'member.unban': return op.user;
    case 'invite.create': return op.channel;
    case 'invite.revoke': return `code#${hash8(op.code)}`; // S25: the audit row keeps a hash, never the code
    case 'msg.delete': case 'msg.pin': case 'msg.unpin': return `${op.channel}:${op.message}`;
    case 'msg.bulk': return `${op.channel}:${op.ids?.length ?? 0}`;
    case 'automod.edit': case 'automod.enable': case 'automod.disable': case 'automod.delete': return op.rule;
    case 'automod.create': return 'new rule';
    case 'guild.edit': return 'guild';
    case 'event.create': return 'new event';
    case 'event.edit': case 'event.cancel': return op.event;
    case 'welcome.resume': return 'welcome';
  }
}

export interface ServerApplyHooks {
  everyoneRoleId: string;
  archiveCategoryId: () => string | null;
  botLogChannelId: string;
  /** S16: the executor's own archive record. */
  archived(channelId: string): Promise<void>;
  /** S13: ends the raid pause. */
  resumeWelcome(): Promise<void>;
  /** The ids a bulk op may still delete: the stored list minus what the limits dropped on the live re-check (gone, too old, pinned, now-protected author). Never a new selection. */
  bulkIds(r: ResolvedServerOp): string[];
}

export interface ServerApplyOutcome {
  /** Extra audit rows (message ids and authors for a bulk delete, S21). */
  detail: string[];
}

/**
 * Runs the resolved ops one after the other and STOPS at the first failure (C21). `audit` is called after each op with its outcome.
 * The text of a Discord error is never shown (only its numeric code). An invite link is returned only in the report lines (shown to the
 * confirming admin alone, S25) and never audited.
 */
export async function executeServerOps(
  resolved: readonly ResolvedServerOp[], w: ServerWriter, hooks: ServerApplyHooks, reason: string,
  audit: (r: ResolvedServerOp, outcome: string, o: ServerApplyOutcome) => Promise<void>,
): Promise<ApplyReport> {
  const lines: string[] = [];
  let applied = 0;
  for (const r of resolved) {
    const op = r.op;
    const out: ServerApplyOutcome = { detail: [] };
    try {
      switch (op.kind) {
        case 'channel.edit': await w.editChannel(op.channel, { ...(op.name !== undefined ? { name: op.name.trim() } : {}), ...(op.topic !== undefined ? { topic: op.topic } : {}), ...(op.slowmode !== undefined ? { slowmode: op.slowmode } : {}), ...(op.nsfw !== undefined ? { nsfw: op.nsfw } : {}) }, reason); break;
        case 'channel.move': await w.moveChannel(op.channel, { parentId: op.category, ...(op.position !== undefined ? { position: op.position } : {}) }, reason); break;
        case 'channel.make': await w.makeChannel({ name: op.name.trim(), type: op.type, parentId: op.category, ...(op.topic ? { topic: op.topic } : {}) }, reason); break;
        case 'channel.archive': {
          const cat = hooks.archiveCategoryId();
          if (!cat) throw new Error('no archive category');
          await w.archiveChannel(op.channel, { archiveCategoryId: cat, everyoneRoleId: hooks.everyoneRoleId }, reason);
          await hooks.archived(op.channel);
          break;
        }
        case 'channel.delete': await w.deleteChannel(op.channel, reason); break;
        case 'thread.archive': case 'thread.lock': case 'thread.unlock': case 'thread.delete': await w.setThread(op.thread, op.kind.slice(7) as 'archive' | 'lock' | 'unlock' | 'delete', reason); break;
        case 'member.nick': await w.setNick(op.member, op.nick === null ? null : op.nick.trim(), reason); break;
        case 'invite.create': {
          const code = await w.createInvite(op.channel, { maxAgeSeconds: op.maxAgeSeconds, maxUses: op.maxUses }, reason);
          lines.push(`invite link (shown only to you, not stored): https://discord.gg/${code}`);
          break;
        }
        case 'invite.revoke': await w.revokeInvite(op.code, reason); break;
        case 'msg.delete': await w.deleteMessage(op.channel, op.message, withReason(reason, op.reason)); break;
        case 'msg.bulk': {
          const ids = hooks.bulkIds(r);
          const n = ids.length ? await w.bulkDelete(op.channel, ids) : 0;
          if (n < (op.ids?.length ?? 0)) lines.push(`bulk delete: ${n} of ${op.ids?.length ?? 0} stored messages were deleted; the rest no longer exist, were too old or are protected`);
          for (let i = 0; i < ids.length; i += 8) out.detail.push(`ids ${ids.slice(i, i + 8).join(',')}`);
          break;
        }
        case 'msg.pin': await w.pin(op.channel, op.message, true, reason); break;
        case 'msg.unpin': await w.pin(op.channel, op.message, false, reason); break;
        case 'member.timeout': await w.timeout(op.member, new Date(Date.now() + op.minutes * 60_000), withReason(reason, op.reason)); break;
        case 'member.untimeout': await w.timeout(op.member, null, withReason(reason, op.reason)); break;
        case 'member.kick': await w.kick(op.member, withReason(reason, op.reason)); break;
        case 'member.ban': await w.ban(op.member, op.deleteDays, withReason(reason, op.reason)); break;
        case 'member.unban': await w.unban(op.user, withReason(reason, op.reason)); break;
        case 'automod.create': await w.createAutoMod(toAutoModWrite(op, hooks.botLogChannelId), reason); break;
        case 'automod.edit': await w.editAutoMod(op.rule, toAutoModPatch(op, hooks.botLogChannelId), reason); break;
        case 'automod.enable': await w.editAutoMod(op.rule, { enabled: true }, reason); break;
        case 'automod.disable': await w.editAutoMod(op.rule, { enabled: false }, reason); break;
        case 'automod.delete': await w.deleteAutoMod(op.rule, reason); break;
        case 'guild.edit': await w.editGuild({ ...(op.name !== undefined ? { name: op.name.trim() } : {}), ...(op.description !== undefined ? { description: op.description } : {}), ...(op.systemChannel !== undefined ? { systemChannelId: op.systemChannel } : {}), ...(op.rulesChannel !== undefined ? { rulesChannelId: op.rulesChannel } : {}) }, reason); break;
        case 'event.create': await w.createEvent({ name: op.name.trim(), type: op.type, start: new Date(op.start), ...(op.end ? { end: new Date(op.end) } : {}), ...(op.description ? { description: op.description } : {}), ...(op.channel ? { channelId: op.channel } : {}), ...(op.location ? { location: op.location } : {}) }, reason); break;
        case 'event.edit': await w.editEvent(op.event, { ...(op.name ? { name: op.name.trim() } : {}), ...(op.description !== undefined ? { description: op.description } : {}), ...(op.start ? { start: new Date(op.start) } : {}), ...(op.end ? { end: new Date(op.end) } : {}) }, reason); break;
        case 'event.cancel': await w.editEvent(op.event, { cancel: true }, reason); break;
        case 'welcome.resume': await hooks.resumeWelcome(); break;
      }
      applied++;
      lines.push(`done: ${r.item.label}`);
      await audit(r, 'ok', out);
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      const why = typeof code === 'number' ? `Discord error ${code}` : 'error';
      lines.push(`FAILED: ${r.item.label} (${why}). The remaining ${resolved.length - applied - 1} operation(s) were not run.`);
      await audit(r, `failed ${why}`, out);
      return { applied, total: resolved.length, ok: false, lines };
    }
  }
  return { applied, total: resolved.length, ok: true, lines };
}

const withReason = (base: string, r: string | undefined): string => (r ? `${base} | ${r}` : base).slice(0, 480);

function toAutoModWrite(op: Extract<ServerOp, { kind: 'automod.create' }>, botLog: string): AutoModWrite {
  const t = op.trigger;
  return {
    name: op.name.trim(), enabled: op.enabled, triggerType: t.type === 'keyword' ? 1 : t.type === 'spam' ? 3 : t.type === 'preset' ? 4 : 5,
    ...(t.type === 'keyword' ? { keywords: t.keywords, regex: t.regex ?? [], allow: t.allow ?? [] } : {}),
    ...(t.type === 'preset' ? { presets: t.presets, allow: t.allow ?? [] } : {}), ...(t.type === 'mentionSpam' ? { mentionLimit: t.mentionLimit } : {}),
    exemptRoles: op.exemptRoles ?? [], exemptChannels: op.exemptChannels ?? [], block: !!op.actions.block,
    ...(op.actions.block?.customMessage ? { blockCustomMessage: op.actions.block.customMessage } : {}),
    ...(op.actions.alert ? { alertChannelId: botLog } : {}), ...(op.actions.timeoutSeconds !== undefined ? { timeoutSeconds: op.actions.timeoutSeconds } : {}),
  };
}
function toAutoModPatch(op: Extract<ServerOp, { kind: 'automod.edit' }>, botLog: string): Partial<AutoModWrite> {
  const t = op.trigger;
  return {
    ...(op.name ? { name: op.name.trim() } : {}),
    ...(t?.type === 'keyword' ? { keywords: t.keywords, regex: t.regex ?? [], allow: t.allow ?? [] } : {}),
    ...(t?.type === 'preset' ? { presets: t.presets, allow: t.allow ?? [] } : {}), ...(t?.type === 'mentionSpam' ? { mentionLimit: t.mentionLimit } : {}),
    ...(op.actions ? { block: !!op.actions.block, ...(op.actions.block?.customMessage ? { blockCustomMessage: op.actions.block.customMessage } : {}), ...(op.actions.alert ? { alertChannelId: botLog } : {}), ...(op.actions.timeoutSeconds !== undefined ? { timeoutSeconds: op.actions.timeoutSeconds } : {}) } : {}),
    ...(op.exemptRoles ? { exemptRoles: op.exemptRoles } : {}), ...(op.exemptChannels ? { exemptChannels: op.exemptChannels } : {}),
  };
}
