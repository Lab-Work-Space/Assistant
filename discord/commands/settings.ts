import { ADMIN_READ_KEYS, HANDLER_KEYS, configRisk, requiresCard } from '../../admin/keys.js';
import { canonical } from '../../config/store.js';
import { ConfigSchema, type ConfigKey } from '../../config/schema.js';
import { redactText } from '../../core/logger.js';
import { deptBudget } from './budget.js';
import {
  applyPlan, isError, planSpendKey, SPEND_SCALAR_KEYS, planAutoOcr, planCompanyProfile, planBotTools, planClickupChannel, planClickupWritesPerDay, planGithubAllow, planMediaAllowlist, planOtEnabled, planHealEnabled, planWsEnabled, planFallbackEnabled, planMcpEnabled, planForgeEnabled, planOpenSourcesEnabled, planAiApprovalEnabled, planGrowRetroEnabled, planSkillsAiEnabled, planTaskGrantEnabled, planAutopilotEnabled, planAutopilotScope, planRerouteEnabled, planRhythmChannel, planWeekdays, refusal,
  type ChannelArg, type Plan, type PlanOk,
} from './plans.js';
import { ephemeral, fmt, type CommandDeps, type Handler, type InteractionLike, type Reply } from './types.js';

/**
 * `/settings list [prefix] | get key | set key value` (spec §4, Gate 1 WS9). Slash only: never a tool, never reachable from a model.
 * The Bot Admin role is checked here on this call's live roles (decide() checks it as well). Reads cover ADMIN_READ_KEYS only: ConfigSchema
 * holds no secret (C13) and the provider key table and the environment are never touched. Writes, by class:
 *  - NEVER (`halted`): refused; /halt and /resume stay their own commands.
 *  - HANDLER_KEYS: only through their plan functions (denylist, GitHub resolution, registered tools, ...), never a raw schema write.
 *  - card keys (`requiresCard`: roles.*, approvals.*, net.extraPorts, pricing, provider.default, limits.localUnlimited false -> true, a warroom.stallTurns raise): a card.
 *  - every other key: a direct set (validated, versioned by ConfigStore, audited), with a risk notice in #bot-log when configRisk says so.
 */

const VALUE_MAX_BYTES = 4096;
const REPLY_MAX = 1800;
const PREFIX = /^[A-Za-z0-9.]{0,64}$/;
const NEVER: readonly string[] = ['halted'];
const isReadKey = (k: string): k is ConfigKey => (ADMIN_READ_KEYS as readonly string[]).includes(k);
const isHandlerKey = (k: string): boolean => (HANDLER_KEYS as readonly string[]).includes(k);

/** One masked, single-line, bounded rendering of a value. */
function show(v: unknown, max: number): string {
  const t = redactText(JSON.stringify(v) ?? 'null').replace(/[`\u0000-\u001f]/g, ' ');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const clip = (s: string): string => (s.length > REPLY_MAX ? `${s.slice(0, REPLY_MAX - 1)}…` : s);

function list(i: InteractionLike, deps: CommandDeps): Reply {
  const prefix = (i.options.string('prefix') ?? '').trim();
  if (!PREFIX.test(prefix)) return ephemeral('The prefix can hold letters, digits and dots only.');
  const keys = ADMIN_READ_KEYS.filter((k) => k.startsWith(prefix)).sort();
  if (!keys.length) return ephemeral('No key starts with that prefix.');
  return fitLines(keys.map((k) => `${k} = ${show(deps.cfg.get(k), 80)}`), keys.length);
}

function fitLines(lines: string[], total: number): Reply {
  const out: string[] = [];
  let size = 0;
  for (const l of lines) {
    if (size + l.length + 1 > REPLY_MAX) break;
    out.push(l);
    size += l.length + 1;
  }
  const more = total - out.length;
  return ephemeral(`${out.join('\n')}${more > 0 ? `\n(+${more} more; narrow with a prefix)` : ''}`);
}

function get(i: InteractionLike, deps: CommandDeps): Reply {
  const key = (i.options.string('key') ?? '').trim();
  if (NEVER.includes(key)) return ephemeral('That key is not shown here: use /halt and /resume.');
  if (!isReadKey(key)) return ephemeral('Unknown key. Use /settings list to see the keys.');
  const v = JSON.stringify(deps.cfg.get(key), null, 2) ?? 'null';
  return ephemeral(clip(`**${key}**\n\`\`\`json\n${redactText(v).replace(/`/g, "'")}\n\`\`\``));
}

/** The value text as the key's schema reads it: JSON first (numbers, booleans, null, arrays, objects), else the text itself as a string. */
function parseValue(key: ConfigKey, text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const schema = ConfigSchema[key];
  const candidates: unknown[] = [];
  try {
    candidates.push(JSON.parse(text));
  } catch {
    /* not JSON: try the plain text below */
  }
  candidates.push(text);
  let first: string | null = null;
  for (const c of candidates) {
    const r = schema.safeParse(c);
    if (r.success) return { ok: true, value: r.data };
    first ??= r.error.issues[0]?.message ?? 'invalid';
  }
  return { ok: false, error: `Invalid value for ${key}: ${redactText(first ?? 'invalid').slice(0, 160)}` };
}

const ID = /\d{17,20}/;

async function channelArg(raw: string, deps: CommandDeps): Promise<ChannelArg | null | 'unknown'> {
  const t = raw.trim().toLowerCase();
  if (t === 'none' || t === 'null' || t === '') return null;
  const id = ID.exec(t)?.[0];
  if (!id) return 'unknown';
  const found = (await deps.settings?.channels().catch(() => []) ?? []).find((c) => c.id === id);
  return found ? { id, parentId: found.parentId, type: found.type } : 'unknown';
}

/** HANDLER_KEYS: each goes through its plan function; what has no scalar form is refused with the command that edits it. */
async function handlerSet(key: ConfigKey, text: string, i: InteractionLike, deps: CommandDeps): Promise<Reply> {
  const run = async (p: Plan, audit?: { action: string }): Promise<Reply> => {
    if (isError(p)) {
      if (p.audit) await deps.audit({ actor: `user:${i.userId}`, action: audit?.action ?? 'settings.set', tool: p.audit.tool, outcome: p.audit.outcome });
      return refusal(p);
    }
    const reply = await applyPlan(p, i.userId, deps);
    // D-02: a risky handler plan posts the same risk notice as the generic set path (the key and who only: the value, such as a tax ID, never goes to the log room)
    if (p.risk && deps.settings) await deps.settings.notice(`⚠ ${key} was changed by <@${i.userId}> with /settings.`).catch((err: unknown) => deps.log.error({ err: redactText(err instanceof Error ? err.message : 'error') }, 'settings risk notice failed'));
    return reply;
  };
  const words = text.trim().split(/\s+/);
  switch (key) {
    case 'ocr.autoChannelId':
    case 'clickup.notifyChannelId': {
      const ch = await channelArg(text, deps);
      if (ch === 'unknown') return ephemeral('Give a channel mention or id the bot can see, or none.');
      return run(key === 'ocr.autoChannelId' ? planAutoOcr(ch, deps) : planClickupChannel(ch, deps));
    }
    case 'rhythm.dailyGoalChannelId':
    case 'dashboard.channelId': {
      const ch = await channelArg(text, deps);
      if (ch === 'unknown') return ephemeral('Give a channel mention or id the bot can see, or none.');
      return run(planRhythmChannel(key, ch, deps));
    }
    case 'company.profile': return run(planCompanyProfile(text, i.memberRoleIds, deps), { action: 'settings.set' });
    case 'autopilot.enabled': return run(planAutopilotEnabled(text, deps)); // AUTO-1: the switch only; the approval cap is the owner's, in the database
    case 'autopilot.scope': return run(planAutopilotScope(text, deps)); // AUTO-2: project or company; the caps are the owner's, in the database
    case 'reroute.enabled': return run(planRerouteEnabled(text, deps)); // REROUTE-1: the kill switch, a person's call
    case 'clickup.writesPerDay': return run(planClickupWritesPerDay(text, deps)); // CLICKUP-ALL-1 (C11): the daily write cap, raised only by a person (risk)
    case 'clickup.pollListIds': return ephemeral('The watched ClickUp lists change only with /clickup watch (it checks that the list is in the workspace).');
    case 'taskGrant.enabled': return run(planTaskGrantEnabled(text, i.userId, deps)); // TREEGRANT-1: the switch only; the other taskGrant.* keys are the owner's, in the database
    case 'ot.enabled': return run(planOtEnabled(text, i.userId, deps)); // OT-1: the switch only; the ot.* caps are the owner's, in the database
    case 'heal.enabled': return run(planHealEnabled(text, deps)); // HEAL-1: the switch only; the heal caps and the warroom quiet settings are the owner's, in the database
    case 'web.search.openSources': return run(planOpenSourcesEnabled(text, deps)); // SEARCH-1: the switch only
    case 'mcp.enabled': return run(planMcpEnabled(text, deps)); // R6 MCP-1: the switch only; the call caps are the owner's, in the database
    case 'forge.enabled': return run(planForgeEnabled(text, deps)); // R7 PLUGIN-FORGE: the switch only
    case 'provider.fallback.enabled': return run(planFallbackEnabled(text, deps)); // R8 PROV-FALLBACK: the switch only; the budget rows are the owner's, in the database
    case 'ws.enabled': return run(planWsEnabled(text, deps)); // WS-1: the switch only; the ws run caps are the owner's, in the database
    case 'skills.ai.enabled': return run(planSkillsAiEnabled(text, deps)); // GROW-1: the switch only; the caps are the owner's, in the database
    case 'grow.retro.enabled': return run(planGrowRetroEnabled(text, deps)); // GROW-1: the switch only; weekday and hour are the owner's, in the database
    case 'approval.ai.enabled': return run(planAiApprovalEnabled(text, deps)); // AI-APPROVE-1: the switch only; the caps are the owner's, in the database
    case 'schedule.offDays': return run(planWeekdays(text.trim(), deps));
    case 'media.ytHostAllowlist': return run(planMediaAllowlist(words[0] ?? null, words[1] ?? null, deps));
    case 'github.repoAllowlist': return run(await planGithubAllow(words[0] ?? '', words.slice(1).join(' '), deps), { action: 'github.allow' });
    case 'tools.byDept': return run(planBotTools(words[0] ?? '', words[1] ?? '', words[2] ?? '', deps));
    case 'provider.default': {
      if (!deps.admin?.proposeOp) return ephemeral('Cards are not available in this process.');
      if (words.length !== 2) return ephemeral('Give the value as: <provider> <model>.');
      // WS9: the provider and model keys always need a card; the card runs the same plan function (planProviderDefault) after the confirm click.
      const r = await deps.admin.proposeOp({ userId: i.userId, tainted: false, via: 'panel' }, { op: 'provider_default', provider: words[0]!, model: words[1]! });
      return ephemeral(r.ok ? `${r.text}` : r.error);
    }
    case 'schedule.holidays': return ephemeral('Use /holiday add and /holiday remove for the holiday list.');
    case 'spend.deptMonthlyUsd': {
      // SPEND-1 (Gate 1 S8): `<dept> <usd|none>`, the same plan as /budget dept (it ends this month's raise overrides).
      if (words.length !== 2) return ephemeral('Give the value as: <dept> <usd|none>.');
      const usd = /^(none|null)$/i.test(words[1]!) ? null : Number(words[1]);
      if (usd !== null && !Number.isFinite(usd)) return ephemeral('Invalid value for spend.deptMonthlyUsd.');
      return deptBudget(words[0]!, usd, i.userId, deps);
    }
    default:
      if ((SPEND_SCALAR_KEYS as readonly string[]).includes(key)) return run(planSpendKey(key, text, deps));
      return ephemeral(`This key is not set with /settings: it has its own administration path (${key.startsWith('welcome.') ? 'the welcome setup in the Praw console or the panel' : key.startsWith('devjob.') ? 'the owner-only self-code switches' : key.startsWith('web.taskGrant.') ? 'the owner sets the web grant caps in the database' : key.startsWith('taskGrant.') ? 'the owner sets the task grant caps in the database' : key.startsWith('ot.') ? 'the owner sets the OT caps in the database' : key.startsWith('mcp.') ? 'the owner sets the MCP caps in the database' : key.startsWith('approval.ai.') ? 'the owner sets the AI approval caps in the database' : key.startsWith('grow.') || key.startsWith('skills.ai.') || key.startsWith('release.') ? 'the owner sets it in the database' : key.startsWith('ws.') ? 'the owner sets the ws caps in the database' : key.startsWith('heal.') || key === 'warroom.stallQuietMinutes' || key === 'warroom.quietLiftsPerDay' || key === 'warroom.personLiftsPerDay' ? 'the owner sets the heal caps in the database' : 'its own command'}).`);
  }
}

async function set(i: InteractionLike, deps: CommandDeps): Promise<Reply> {
  const key = (i.options.string('key') ?? '').trim();
  const text = i.options.string('value') ?? '';
  if (NEVER.includes(key)) {
    await deps.audit({ actor: `user:${i.userId}`, action: 'settings.set', tool: key, outcome: 'refused: never' });
    return ephemeral('That key cannot be set here: use /halt and /resume.');
  }
  if (!isReadKey(key)) return ephemeral('Unknown key. Use /settings list to see the keys.');
  if (Buffer.byteLength(text, 'utf8') > VALUE_MAX_BYTES) return ephemeral(`The value is too long (at most ${VALUE_MAX_BYTES} bytes).`);
  if (isHandlerKey(key)) return handlerSet(key, text, i, deps);

  const parsed = parseValue(key, text);
  if (!parsed.ok) return ephemeral(parsed.error);
  const old = deps.cfg.get(key);
  if (canonical(old) === canonical(parsed.value)) return ephemeral('No change: the key already has that value.');

  if (requiresCard(key, old, parsed.value)) {
    if (!deps.admin?.proposeConfig) return ephemeral('Cards are not available in this process.');
    const r = await deps.admin.proposeConfig({ userId: i.userId, tainted: false, via: 'panel' }, { changes: [{ key, value: parsed.value }] });
    return ephemeral(r.ok ? r.text : r.error);
  }

  const risk = configRisk(key, old, parsed.value);
  const plan: PlanOk = {
    before: old, items: [{ label: key, old: fmt(old), neu: fmt(parsed.value) }],
    writes: [{ key, value: parsed.value as never, expect: old as never }], audit: { action: 'config.set', tool: key }, risk,
  };
  const reply = await applyPlan(plan, i.userId, deps);
  if (risk && deps.settings) {
    // A risk notice, best effort: the change is already stored, versioned and audited.
    await deps.settings.notice(`⚠ ${key} was changed by <@${i.userId}> with /settings: ${show(old, 120)} → ${show(parsed.value, 120)}.`).catch((err: unknown) => deps.log.error({ err: redactText(err instanceof Error ? err.message : 'error') }, 'settings risk notice failed'));
  }
  return reply;
}

export const settingsCmd: Handler = async (i, deps) => {
  if (!deps.adminRoleId || !i.memberRoleIds.includes(deps.adminRoleId)) return ephemeral('Only Bot Admins can do this.');
  switch (i.subcommand) {
    case 'list': return list(i, deps);
    case 'get': return get(i, deps);
    case 'set': return set(i, deps);
    default: return ephemeral('Unknown command.');
  }
};
