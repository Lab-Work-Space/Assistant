import { z } from 'zod';

/**
 * The server-management operations (phase 2, spec "New op families"; Gate 1 S15-S29). Like PermOp they travel as validated JSON, are shown on a
 * card by code, and run only in the executor ("LW Admin") after discord/server/server-limits.ts re-validated them against live data.
 * Every schema is strict: an unknown key is refused (S23). Not here, on purpose: images (icon, banner, emoji, sticker), onboarding,
 * deleting roles, verification/MFA/vanity/widget settings.
 */
const snowflake = z.string().regex(/^\d{17,20}$/, 'must be a Discord id (digits only)');
/** S22: the audit-log reason of a moderation action: short, no mention syntax; the secret-pattern identity check runs in the limits. */
const reason = z.string().min(1).max(200).optional();
const channelName = z.string().min(1).max(100);
const text = (max: number) => z.string().min(1).max(max);

export const CHANNEL_MAKE_TYPES = ['text', 'voice', 'forum', 'stage', 'announcement', 'category'] as const;

const AutoModTrigger = z.discriminatedUnion('type', [
  z.object({ type: z.literal('keyword'), keywords: z.array(text(60)).max(100), regex: z.array(text(260)).max(10).optional(), allow: z.array(text(60)).max(100).optional() }).strict(),
  z.object({ type: z.literal('spam') }).strict(),
  z.object({ type: z.literal('preset'), presets: z.array(z.number().int().min(1).max(3)).min(1).max(3), allow: z.array(text(60)).max(100).optional() }).strict(),
  z.object({ type: z.literal('mentionSpam'), mentionLimit: z.number().int().min(1).max(50) }).strict(),
]);
export type AutoModTrigger = z.infer<typeof AutoModTrigger>;
const AutoModActions = z.object({
  /** BlockMessage; the optional custom text is checked in the limits (S28: <= 150 characters, no URL or mention syntax). */
  block: z.object({ customMessage: z.string().max(150).optional() }).strict().optional(),
  /** SendAlertMessage; the channel is fixed by code to #🧾-bot-log (S28). */
  alert: z.boolean().optional(),
  /** Timeout, seconds; at most 1 day (S28). */
  timeoutSeconds: z.number().int().min(1).max(86_400).optional(),
}).strict();
const exempt = { exemptRoles: z.array(snowflake).max(20).optional(), exemptChannels: z.array(snowflake).max(50).optional() };

export const ServerOp = z.discriminatedUnion('kind', [
  // ---- channels (S15-S17)
  z.object({ kind: z.literal('channel.edit'), channel: snowflake, name: channelName.optional(), topic: z.string().max(1024).optional(), slowmode: z.number().int().min(0).max(21_600).optional(), nsfw: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal('channel.move'), channel: snowflake, category: snowflake.nullable(), position: z.number().int().min(0).max(500).optional() }).strict(),
  z.object({ kind: z.literal('channel.make'), name: channelName, type: z.enum(CHANNEL_MAKE_TYPES), category: snowflake.nullable(), topic: z.string().max(1024).optional() }).strict(),
  z.object({ kind: z.literal('channel.archive'), channel: snowflake }).strict(),
  z.object({ kind: z.literal('channel.delete'), channel: snowflake }).strict(),
  z.object({ kind: z.literal('thread.archive'), thread: snowflake }).strict(),
  z.object({ kind: z.literal('thread.lock'), thread: snowflake }).strict(),
  z.object({ kind: z.literal('thread.unlock'), thread: snowflake }).strict(),
  z.object({ kind: z.literal('thread.delete'), thread: snowflake }).strict(),
  // ---- members (S20, S25)
  z.object({ kind: z.literal('member.nick'), member: snowflake, nick: z.string().max(32).nullable() }).strict(),
  z.object({ kind: z.literal('invite.create'), channel: snowflake, maxAgeSeconds: z.number().int().min(3600).max(604_800), maxUses: z.number().int().min(1).max(25) }).strict(),
  z.object({ kind: z.literal('invite.revoke'), code: z.string().regex(/^[A-Za-z0-9-]{2,32}$/) }).strict(),
  // ---- moderation (S18-S22)
  z.object({ kind: z.literal('msg.delete'), channel: snowflake, message: snowflake, reason }).strict(),
  /** `ids` is filled in by code at propose (N2); a proposal names only a count and an optional author. Apply deletes the stored ids and never selects again. */
  z.object({ kind: z.literal('msg.bulk'), channel: snowflake, count: z.number().int().min(1).max(100), author: snowflake.optional(), ids: z.array(snowflake).min(1).max(100).optional(), reason }).strict(),
  z.object({ kind: z.literal('msg.pin'), channel: snowflake, message: snowflake }).strict(),
  z.object({ kind: z.literal('msg.unpin'), channel: snowflake, message: snowflake }).strict(),
  z.object({ kind: z.literal('member.timeout'), member: snowflake, minutes: z.number().int().min(1).max(40_320), reason }).strict(),
  z.object({ kind: z.literal('member.untimeout'), member: snowflake, reason }).strict(),
  z.object({ kind: z.literal('member.kick'), member: snowflake, reason }).strict(),
  z.object({ kind: z.literal('member.ban'), member: snowflake, deleteDays: z.number().int().min(0).max(7).default(0), reason }).strict(),
  z.object({ kind: z.literal('member.unban'), user: snowflake, reason }).strict(),
  // ---- AutoMod (S28, S29)
  z.object({ kind: z.literal('automod.create'), name: text(100), trigger: AutoModTrigger, actions: AutoModActions, enabled: z.boolean().default(true), ...exempt }).strict(),
  z.object({ kind: z.literal('automod.edit'), rule: snowflake, name: text(100).optional(), trigger: AutoModTrigger.optional(), actions: AutoModActions.optional(), ...exempt }).strict(),
  z.object({ kind: z.literal('automod.enable'), rule: snowflake }).strict(),
  z.object({ kind: z.literal('automod.disable'), rule: snowflake }).strict(),
  z.object({ kind: z.literal('automod.delete'), rule: snowflake }).strict(),
  // ---- server and events (S23, S26)
  z.object({ kind: z.literal('guild.edit'), name: z.string().min(2).max(100).optional(), description: z.string().max(120).nullable().optional(), systemChannel: snowflake.nullable().optional(), rulesChannel: snowflake.nullable().optional() }).strict(),
  z.object({ kind: z.literal('event.create'), name: text(100), description: z.string().max(1000).optional(), type: z.enum(['voice', 'stage', 'external']), channel: snowflake.optional(), location: z.string().max(100).optional(), start: z.string().datetime(), end: z.string().datetime().optional() }).strict(),
  z.object({ kind: z.literal('event.edit'), event: snowflake, name: text(100).optional(), description: z.string().max(1000).optional(), start: z.string().datetime().optional(), end: z.string().datetime().optional() }).strict(),
  z.object({ kind: z.literal('event.cancel'), event: snowflake }).strict(),
  // ---- welcome (S13): the only way a raid pause ends
  z.object({ kind: z.literal('welcome.resume') }).strict(),
]);
export type ServerOp = z.infer<typeof ServerOp>;

/** S31: at most 20 ops per card; ban and kick at most 5 targets (checked in the limits). */
export const SERVER_BATCH_MAX = 20;
export const BAN_KICK_MAX = 5;
export const ServerProposal = z.object({ ops: z.array(ServerOp).min(1).max(SERVER_BATCH_MAX), note: z.string().max(300).optional() }).strict();

/** The ops that count as destructive for the S30 hourly cap. */
export const DESTRUCTIVE_KINDS: readonly ServerOp['kind'][] = ['member.ban', 'member.kick', 'msg.bulk', 'channel.delete', 'automod.disable', 'automod.delete'];
