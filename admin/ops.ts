import { z } from 'zod';
import { isDenied } from '../company/denylist.js';
import {
  BUDGET_SCOPES, LIMIT_KEYS, planAutoOcr, planBotModel, planBotToggle, planBotTools, planChannelMap, planChannelUnmap, planClickupChannel,
  planGithubAllow, planHolidayAdd, planHolidayRemove, planMediaAllowlist, planNumber, planPersonaEdit, planPersonaToggle, planProviderDefault,
  planWeekdays, channelTargetError, type ChannelArg, type Plan,
} from '../discord/commands/plans.js';
import type { CommandDeps } from '../discord/commands/types.js';
import { ConfigSchema } from '../config/schema.js';
import type { ConfigWrite } from '../config/store.js';
import { planSkillAttach, planSkillDetach, planSkillRollback, planSkillToggle } from '../skills/plans.js';

const skillSlug = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/, 'a skill id');
const snowflake = z.string().regex(/^\d{17,20}$/, 'must be a Discord id (digits only)');
const text = (max: number) => z.string().min(1).max(max);
const dept = text(32);
/** A prompt body that has to fit on the card in full (the slash command still takes up to 4000). */
export const ADMIN_PERSONA_BODY_MAX = 900;

/**
 * The admin operations Praw may propose (spec A, Gate 1 C2). One op per card. Every op is a thin, validated name for a plan in
 * discord/commands/plans.ts; the checks (denied channels, the GitHub owner/denylist, registered plugin tools, priced models, ...) are those functions'.
 */
export const AdminOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('holiday_add'), date: text(10), name: z.string().max(60).optional() }).strict(),
  z.object({ op: z.literal('holiday_remove'), date: text(10) }).strict(),
  z.object({ op: z.literal('holiday_weekdays'), days: z.string().max(60) }).strict(),
  z.object({ op: z.literal('channel_map'), channel: snowflake, dept, work: z.boolean().optional() }).strict(),
  z.object({ op: z.literal('channel_unmap'), channel: snowflake }).strict(),
  z.object({ op: z.literal('bot_toggle'), dept, enabled: z.boolean() }).strict(),
  z.object({ op: z.literal('bot_model'), dept, provider: text(64), model: text(128) }).strict(),
  z.object({ op: z.literal('bot_tools'), dept, action: z.enum(['add', 'remove']), tool: text(64) }).strict(),
  z.object({ op: z.literal('persona_toggle'), persona: text(64), enabled: z.boolean() }).strict(),
  z.object({ op: z.literal('persona_edit'), persona: text(64), body: z.string().min(10).max(ADMIN_PERSONA_BODY_MAX) }).strict(),
  z.object({ op: z.literal('budget_set'), scope: z.enum(['daily', 'bot', 'task']), usd: z.number().finite() }).strict(),
  z.object({ op: z.literal('limits_set'), limit: z.enum(Object.keys(LIMIT_KEYS) as [string, ...string[]]), value: z.number().finite() }).strict(),
  z.object({ op: z.literal('approval_set'), usd: z.number().finite() }).strict(),
  z.object({ op: z.literal('clickup_channel'), channel: snowflake.nullable() }).strict(),
  z.object({ op: z.literal('autoocr_channel'), channel: snowflake.nullable() }).strict(),
  z.object({ op: z.literal('media_allowlist'), action: z.enum(['add', 'remove']), host: text(253) }).strict(),
  z.object({ op: z.literal('github_allow'), action: z.enum(['add', 'remove']), repo: text(260) }).strict(),
  z.object({ op: z.literal('provider_default'), provider: text(64), model: text(128) }).strict(),
  // SKILLS-1 (SK14): Praw may attach, detach, enable/disable and roll back skills; there is NO create or edit op (skill text is written by a Bot Admin only).
  z.object({ op: z.literal('skill_attach'), skill: skillSlug, target: text(70), priority: z.number().int().min(0).max(1000).optional() }).strict(),
  z.object({ op: z.literal('skill_detach'), skill: skillSlug, target: text(70) }).strict(),
  z.object({ op: z.literal('skill_toggle'), skill: skillSlug, enabled: z.boolean() }).strict(),
  z.object({ op: z.literal('skill_rollback'), skill: skillSlug, version: z.number().int().positive() }).strict(),
  // Gate 1 S14: the welcome flow's settings; roles and channel are checked live by the executor at propose and again at apply.
  z.object({
    op: z.literal('welcome_set'), enabled: z.boolean().optional(), roleIds: z.array(snowflake).max(5).optional(), message: z.string().max(500).optional(),
    channelId: snowflake.nullable().optional(), raidPerMinute: z.number().int().optional(),
  }).strict(),
]);
export type AdminOp = z.infer<typeof AdminOp>;

export interface OpDeps {
  cmd: CommandDeps;
  /** The guild's channels as the live guild cache knows them (denied channels already left out); a thread or unknown id is not in it. */
  channels(): Promise<{ id: string; parentId: string | null; type?: number }[]>;
  /** The id recorded as `created_by` for a prompt override. */
  by: string;
  /** S14: live checks of the welcome roles (executor) and channel (executor + Praw's own send right); null = acceptable. Absent = the executor is not available. */
  welcome?: { check(roleIds: readonly string[], channelId: string | null): Promise<string | null> };
}

/** Resolves a channel id against the live guild list; a denied, unknown or thread id gives a refusal text instead (fail closed). */
async function channelOf(id: string, d: OpDeps): Promise<ChannelArg | string> {
  if (isDenied(id, null)) return 'That channel is off limits.';
  const found = (await d.channels()).find((c) => c.id === id);
  if (!found) return 'That channel was not found in the guild (threads and unknown ids cannot be used).';
  const ch: ChannelArg = { id: found.id, parentId: found.parentId, ...(found.type !== undefined ? { type: found.type } : {}) };
  return channelTargetError(ch) ?? ch;
}

/**
 * Builds the plan for an op against the live state. Called at propose (to validate and show old -> new) and again at apply (so a stale
 * or newly refused op never runs). Never executes anything.
 */
export async function planOp(op: AdminOp, d: OpDeps): Promise<Plan> {
  const { cmd } = d;
  const withChannel = async (id: string | null, f: (ch: ChannelArg | null) => Plan | Promise<Plan>): Promise<Plan> => {
    if (id === null) return f(null);
    const ch = await channelOf(id, d);
    return typeof ch === 'string' ? { error: ch } : f(ch);
  };
  switch (op.op) {
    case 'holiday_add': return planHolidayAdd(op.date, op.name ?? null, cmd);
    case 'holiday_remove': return planHolidayRemove(op.date, cmd);
    case 'holiday_weekdays': return planWeekdays(op.days, cmd);
    case 'channel_map': return withChannel(op.channel, (ch) => planChannelMap(ch, op.dept, op.work ?? false, cmd));
    case 'channel_unmap': return withChannel(op.channel, (ch) => planChannelUnmap(ch, cmd));
    case 'bot_toggle': return planBotToggle(op.dept, op.enabled, cmd);
    case 'bot_model': return planBotModel(op.dept, op.provider, op.model, cmd);
    case 'bot_tools': return planBotTools(op.dept, op.action, op.tool, cmd);
    case 'persona_toggle': return planPersonaToggle(op.persona, op.enabled, cmd);
    case 'persona_edit': return planPersonaEdit(op.persona, op.body, cmd, d.by, ADMIN_PERSONA_BODY_MAX);
    case 'budget_set': return planNumber(BUDGET_SCOPES[op.scope]!, op.usd, cmd, { action: 'config.set', tool: BUDGET_SCOPES[op.scope]! });
    case 'limits_set': return planNumber(LIMIT_KEYS[op.limit]!, op.value, cmd, { action: 'config.set', tool: LIMIT_KEYS[op.limit]! });
    case 'approval_set': return planNumber('approval.thresholdUsd', op.usd, cmd);
    case 'clickup_channel': return withChannel(op.channel, (ch) => planClickupChannel(ch, cmd));
    case 'autoocr_channel': return withChannel(op.channel, (ch) => planAutoOcr(ch, cmd));
    case 'media_allowlist': return planMediaAllowlist(op.action, op.host, cmd);
    case 'github_allow': return planGithubAllow(op.action, op.repo, cmd);
    case 'provider_default': return planProviderDefault(op.provider, op.model, cmd);
    case 'welcome_set': return planWelcome(op, d);
    case 'skill_attach': return planSkillAttach(op.skill, op.target, op.priority, cmd, d.by);
    case 'skill_detach': return planSkillDetach(op.skill, op.target, cmd, d.by);
    case 'skill_toggle': return planSkillToggle(op.skill, op.enabled, cmd, d.by);
    case 'skill_rollback': return planSkillRollback(op.skill, op.version, cmd, d.by);
  }
}

const WELCOME_KEYS = { enabled: 'welcome.enabled', roleIds: 'welcome.roleIds', message: 'welcome.message', channelId: 'welcome.channelId', raidPerMinute: 'welcome.raidPerMinute' } as const;

/** S14: validates each field with the config schema, then roles and channel live (executor). Everything shown in full on the card. */
async function planWelcome(op: Extract<AdminOp, { op: 'welcome_set' }>, d: OpDeps): Promise<Plan> {
  const writes: ConfigWrite[] = [];
  const items: { label: string; old: string; neu: string }[] = [];
  const before: Record<string, unknown> = {};
  let risk = false;
  for (const [field, key] of Object.entries(WELCOME_KEYS) as [keyof typeof WELCOME_KEYS, (typeof WELCOME_KEYS)[keyof typeof WELCOME_KEYS]][]) {
    const v = op[field];
    if (v === undefined) continue;
    const parsed = ConfigSchema[key].safeParse(v);
    if (!parsed.success) return { error: `Refused: ${key}: ${parsed.error.issues[0]?.message ?? 'invalid'}` };
    const cur = d.cmd.cfg.get(key);
    if (JSON.stringify(cur) === JSON.stringify(parsed.data)) continue;
    before[key] = cur;
    writes.push({ key, value: parsed.data, expect: cur });
    items.push({ label: key, old: JSON.stringify(cur), neu: JSON.stringify(parsed.data) });
    if (key === 'welcome.enabled' || key === 'welcome.roleIds') risk = true;
  }
  if (!writes.length) return { error: 'Nothing would change.' };
  const roleIds = op.roleIds ?? d.cmd.cfg.get('welcome.roleIds');
  const channelId = op.channelId !== undefined ? op.channelId : d.cmd.cfg.get('welcome.channelId');
  const enabledAfter = op.enabled ?? d.cmd.cfg.get('welcome.enabled');
  if (enabledAfter && (!channelId || !(op.message ?? d.cmd.cfg.get('welcome.message')))) return { error: 'Refused: welcome needs a message and a channel before it can be enabled.' };
  if (!d.welcome) return { error: 'The welcome setup needs the executor (LW Admin), which is not available in this process.' };
  const problem = await d.welcome.check(roleIds, channelId);
  if (problem) return { error: `Refused: ${problem}` };
  return { before, items, writes, audit: { action: 'config.set', tool: 'welcome.set' }, risk };
}
