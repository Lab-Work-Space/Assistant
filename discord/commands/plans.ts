import { GOAL_FORUM_CHANNEL_ID, GOAL_TEXT_CHANNEL_ID, NEVER_MAPPED_CHANNEL_IDS } from '../../company/channels.js';
import { isDeniedCategory, isExcludedChannel } from '../../company/exclusion.js';
import { FOUNDER_ROLE_ID, isDenied } from '../../company/denylist.js';
import { CompanyProfileSchema } from '../../company/profile.js';
import { SEED_DEPARTMENTS } from '../../company/seed.js';
import { localDay, parseWeekdays, weekdayNames } from '../../company/calendar.js';
import { ConfigSchema, Holiday, isCalendarDate, SPEND_MAX_USD, type ConfigKey, type ConfigValue } from '../../config/schema.js';
import type { ConfigWrite } from '../../config/store.js';
import { DEPT_IDS, type DeptId } from '../../core/index.js';
import { githubName } from '../../services/ids.js';
import { workspaceLabelText, type CuListInfo } from '../../tools/plugins/clickup/client.js';
import { GithubError } from '../../tools/plugins/github/auth.js';
import { DENIED, cleanRepoSpec, isDeniedRepo, normalizeRepoSpec } from '../../tools/plugins/github/deny.js';
import { AI_WARROOM_CHANNEL_ID, BOT_LOG_CHANNEL_ID, DIRECT_LOG_CHANNEL_ID, TASK_LOG_CHANNEL_ID } from '../port.js';
import { LOCAL_MODELS, PROVIDER_ID as LOCAL_PROVIDER_ID } from '../../providers/claude-code-local/protocol.js';
import { spendRisk } from '../../admin/keys.js';
import { escapeCardText } from '../embeds/approval.js';
import { changeReply, CONFIG_CHANNEL_ID, ephemeral, fmt, type CommandDeps, type Reply } from './types.js';

/**
 * Gate 1 C2: the checks and the computed change of every admin operation, in one place. The slash handlers and the admin console both
 * call these, so a rule added here (a denied channel, the GitHub owner check, a registered plugin tool, selectionError) holds on both
 * paths. A plan is pure until `run`/`writes` are executed: the slash path executes it at once, the console stores the op and executes a
 * freshly built plan after the confirm click (and refuses when `before` no longer matches what was proposed).
 */

export const PERSONA_BODY_MAX = 4000;
/** R8 PV-F01: the registered id of the Gemini provider (providers/gemini). */
const GEMINI_PROVIDER = 'gemini';
/** R8 PV-F01: the registered id of the metered Claude API provider (providers/claude). */
const METERED_CLAUDE_PROVIDER = 'claude';

export type Ref = { kind: 'channel' | 'role' | 'user'; id: string };
/** One line of a confirmation card: `label: old -> new`. `refs` are ids shown as a mention plus the raw id (C8). */
export interface Item {
  label: string;
  old: string;
  neu: string;
  refs?: Ref[];
  /** What the slash reply calls this change when that differs from `label`. */
  slash?: string;
  /** Longer text the card shows in full under the change (never the slash reply): a prompt body. */
  detail?: string;
  /** SK7/SK14: a one-value card field (label = name, `plain` = value, no `old → neu`): used for text written earlier or by a model that the admin must read whole. */
  plain?: string;
}

export interface PlanOk {
  /** Canonical live input the plan was computed from; apply refuses when a fresh plan's `before` differs (C7). */
  before: unknown;
  items: Item[];
  /** Config writes with the value each must still hold (database compare-and-swap on the console path). */
  writes: ConfigWrite[];
  /** Effects outside the config table (repositories, org reload); run after the writes. */
  run?: () => Promise<void>;
  audit: { action: string; tool: string; provider?: string; model?: string };
  /** `⚠`: raises spend or reach (the card flags it). */
  risk: boolean;
}
/** `audit` on a refusal lets a handler keep its refusal audit rows. */
export interface PlanError {
  error: string;
  audit?: { outcome: string; tool: string };
}
export type Plan = PlanOk | PlanError;
export const isError = (p: Plan): p is PlanError => 'error' in p;

/** The slice of the command deps the tool-list plan reads (GROW-1 builds it without a full CommandDeps). */
export type PlanDeps = { org: Pick<CommandDeps['org'], 'dept'>; cfg: { get: CommandDeps['cfg']['get'] }; tools: CommandDeps['tools'] };
const set = <K extends ConfigKey>(key: K, value: ConfigValue<K>, deps: { cfg: { get: CommandDeps['cfg']['get'] } }): ConfigWrite => ({ key, value, expect: deps.cfg.get(key) });
const show = (v: unknown): string => fmt(v);

/** Gate 1 D4: only models with a pricing entry may be selected. */
export const hasPrice = (deps: CommandDeps, model: string) => Object.hasOwn(deps.cfg.get('pricing'), model);

// claude-code-local models (R-L1) are counted, not priced, so they need no pricing entry (Gate 1 L7, L8).

/**
 * Gate 1 L9 + D4: the provider must be registered in this process; a local provider takes only its local model ids,
 * any other provider only a priced model. Returns the refusal text, or null when the selection is allowed.
 */
export function selectionError(deps: CommandDeps, provider: string, model: string): string | null {
  if (!deps.providers.has(provider)) return `Provider ${provider.slice(0, 64)} is not available in this process.`;
  if (provider === LOCAL_PROVIDER_ID)
    return LOCAL_MODELS.includes(model) ? null : `Provider ${LOCAL_PROVIDER_ID} takes only ${LOCAL_MODELS.join(' or ')}.`;
  return hasPrice(deps, model) ? null : `Model ${model.slice(0, 80)} has no pricing entry; add one to pricing first.`;
}


// ---- budget, limits, approval threshold ----

export const BUDGET_SCOPES: Record<string, ConfigKey> = { daily: 'budget.companyDailyUsd', bot: 'budget.botDailyUsd', task: 'budget.taskUsd' };
export const LIMIT_KEYS: Record<string, ConfigKey> = {
  turns: 'limits.turnsPerTask', depth: 'limits.depth', concurrency: 'limits.concurrency', children: 'limits.childrenPerTask', open_tasks: 'limits.openTasks',
  human_runs: 'limits.humanRunsPer10Min', 'praw-per-user-10min': 'limits.prawPerUser10Min', 'praw-concurrency': 'limits.prawConcurrency',
  vision_day: 'limits.visionPerUserDay', local_calls_day: 'limits.localCallsPerDay', local_calls_task: 'limits.localCallsPerTask', context: 'context.messages',
};

/** One numeric config key; ConfigSchema rejects NaN, +-Infinity, 1e308 and negatives (Gate 1 D4). Raising it is a risk. */
export function planNumber(key: ConfigKey, value: number | null, deps: Pick<CommandDeps, 'cfg'>, audit = { action: 'config.set', tool: key as string }): Plan {
  if (value === null || !Number.isFinite(value)) return { error: 'Invalid value.' };
  if (!ConfigSchema[key].safeParse(value).success) return { error: `Invalid value for ${key}.` };
  const old = deps.cfg.get(key) as number;
  return { before: old, items: [{ label: key, old: show(old), neu: show(value) }], writes: [set(key, value as never, deps)], audit, risk: value > old };
}

/** SPEND-1: the scalar spend.* keys (all HANDLER_KEYS: slash only, never a tool; Gate 1 S1, S19). */
export const SPEND_SCALAR_KEYS = ['spend.warnPct', 'spend.anomalyMultiplier', 'spend.anomalyMinUsd', 'spend.alertsEnabled', 'spend.weeklySummary', 'spend.weeklySummaryTime', 'spend.overrideStepPct', 'spend.retentionDays'] as const satisfies readonly ConfigKey[];

/** One scalar spend.* key from `/settings set`: the schema decides validity (finite, bounded, no NaN or 1e308), `spendRisk` decides whether the change loosens control. */
export function planSpendKey(key: ConfigKey, text: string, deps: Pick<CommandDeps, 'cfg'>): Plan {
  const candidates: unknown[] = [];
  try { candidates.push(JSON.parse(text.trim())); } catch { /* plain text below */ }
  candidates.push(text.trim());
  const ok = candidates.map((c) => ConfigSchema[key].safeParse(c)).find((r) => r.success);
  if (!ok?.success) return { error: `Invalid value for ${key}.` };
  const old = deps.cfg.get(key);
  if (JSON.stringify(old) === JSON.stringify(ok.data)) return { error: 'No change: the key already has that value.' };
  return { before: old, items: [{ label: key, old: show(old), neu: show(ok.data) }], writes: [set(key, ok.data as never, deps)], audit: { action: 'config.set', tool: key }, risk: spendRisk(key, old, ok.data) };
}

/**
 * OT-1 (OT-C1, OT-C7): `ot.enabled` is the only overtime key with a `/settings` path (the caps are the owner's, in the database). Switching it OFF also
 * revokes every live grant (reason `admin`); the consume path reads the switch live regardless, so a failed revoke still stops work.
 */
export function planOtEnabled(text: string, userId: string, deps: Pick<CommandDeps, 'cfg' | 'ot'>): Plan {
  const v = /^(true|on|yes|1)$/i.test(text.trim()) ? true : /^(false|off|no|0)$/i.test(text.trim()) ? false : null;
  if (v === null) return { error: 'Give true or false.' };
  const old = deps.cfg.get('ot.enabled');
  if (old === v) return { error: 'No change: the key already has that value.' };
  return {
    before: old, items: [{ label: 'ot.enabled', old: show(old), neu: show(v) }], writes: [set('ot.enabled', v, deps)],
    ...(v === false && deps.ot ? { run: async () => void (await deps.ot!.revokeAll('admin', userId)) } : {}),
    audit: { action: 'config.set', tool: 'ot.enabled' }, risk: v === true,
  };
}

/**
 * HEAL-1 (HL-C17): `heal.enabled` is the only heal key with a `/settings` path (the caps are the owner's, in the database). Turning it on loosens control (bots act without a person), so it is a risk.
 */
export function planHealEnabled(text: string, deps: Pick<CommandDeps, 'cfg'>): Plan {
  const v = /^(true|on|yes|1)$/i.test(text.trim()) ? true : /^(false|off|no|0)$/i.test(text.trim()) ? false : null;
  if (v === null) return { error: 'Give true or false.' };
  const old = deps.cfg.get('heal.enabled');
  if (old === v) return { error: 'No change: the key already has that value.' };
  return { before: old, items: [{ label: 'heal.enabled', old: show(old), neu: show(v) }], writes: [set('heal.enabled', v, deps)], audit: { action: 'config.set', tool: 'heal.enabled' }, risk: v === true };
}

/** WS-1 (SA-1 5.5): `ws.enabled` is the only ws key with a `/settings` path (the run caps are the owner's, in the database). Turning it on lets the software team run code in a sandbox, so it is a risk. */
export function planWsEnabled(text: string, deps: Pick<CommandDeps, 'cfg'>): Plan {
  const v = /^(true|on|yes|1)$/i.test(text.trim()) ? true : /^(false|off|no|0)$/i.test(text.trim()) ? false : null;
  if (v === null) return { error: 'Give true or false.' };
  const old = deps.cfg.get('ws.enabled');
  if (old === v) return { error: 'No change: the key already has that value.' };
  return { before: old, items: [{ label: 'ws.enabled', old: show(old), neu: show(v) }], writes: [set('ws.enabled', v, deps)], audit: { action: 'config.set', tool: 'ws.enabled' }, risk: v === true };
}

/** R8 PROV-FALLBACK (spec 3.7): `provider.fallback.enabled` has a `/settings` path (a clone of `planWsEnabled`). Turning it on lets non-praw work run on the metered Claude API while the subscription quota is held, so it is a risk. No AdminOp reaches it. */
export function planFallbackEnabled(text: string, deps: Pick<CommandDeps, 'cfg'>): Plan {
  const v = /^(true|on|yes|1)$/i.test(text.trim()) ? true : /^(false|off|no|0)$/i.test(text.trim()) ? false : null;
  if (v === null) return { error: 'Give true or false.' };
  const old = deps.cfg.get('provider.fallback.enabled');
  if (old === v) return { error: 'No change: the key already has that value.' };
  return { before: old, items: [{ label: 'provider.fallback.enabled', old: show(old), neu: show(v) }], writes: [set('provider.fallback.enabled', v, deps)], audit: { action: 'config.set', tool: 'provider.fallback.enabled' }, risk: v === true };
}

/** R6 MCP-1 (spec 5.9): `mcp.enabled` is the only mcp key with a `/settings` path (the call caps are the owner's, in the database). Turning it on lets bots call outside programs in a sandbox, so it is a risk. */
export function planMcpEnabled(text: string, deps: Pick<CommandDeps, 'cfg'>): Plan {
  const v = /^(true|on|yes|1)$/i.test(text.trim()) ? true : /^(false|off|no|0)$/i.test(text.trim()) ? false : null;
  if (v === null) return { error: 'Give true or false.' };
  const old = deps.cfg.get('mcp.enabled');
  if (old === v) return { error: 'No change: the key already has that value.' };
  return { before: old, items: [{ label: 'mcp.enabled', old: show(old), neu: show(v) }], writes: [set('mcp.enabled', v, deps)], audit: { action: 'config.set', tool: 'mcp.enabled' }, risk: v === true };
}

/** R7 PLUGIN-FORGE (spec 5.10): `forge.enabled` has a `/settings` path. Turning it on lets code build a plugin image from a workspace a Bot Admin approved, so it is a risk. */
export function planForgeEnabled(text: string, deps: Pick<CommandDeps, 'cfg'>): Plan {
  const v = /^(true|on|yes|1)$/i.test(text.trim()) ? true : /^(false|off|no|0)$/i.test(text.trim()) ? false : null;
  if (v === null) return { error: 'Give true or false.' };
  const old = deps.cfg.get('forge.enabled');
  if (old === v) return { error: 'No change: the key already has that value.' };
  return { before: old, items: [{ label: 'forge.enabled', old: show(old), neu: show(v) }], writes: [set('forge.enabled', v, deps)], audit: { action: 'config.set', tool: 'forge.enabled' }, risk: v === true };
}

/** SEARCH-1 (SR-C9): `web.search.openSources` lets web_search send an approved query to Wikipedia, Hacker News, Stack Exchange, npm and GitHub when DuckDuckGo refuses. Turning it on is a risk. */
export function planOpenSourcesEnabled(text: string, deps: Pick<CommandDeps, 'cfg'>): Plan {
  const v = /^(true|on|yes|1)$/i.test(text.trim()) ? true : /^(false|off|no|0)$/i.test(text.trim()) ? false : null;
  if (v === null) return { error: 'Give true or false.' };
  const old = deps.cfg.get('web.search.openSources');
  if (old === v) return { error: 'No change: the key already has that value.' };
  return { before: old, items: [{ label: 'web.search.openSources', old: show(old), neu: show(v) }], writes: [set('web.search.openSources', v, deps)], audit: { action: 'config.set', tool: 'web.search.openSources' }, risk: v === true };
}

/** AI-APPROVE-1 (AA-C17): `approval.ai.enabled` is the only AI approval key with a `/settings` path (the caps are the owner's, in the database). Turning it on loosens control (a model approves low-risk calls), so it is a risk. */
export function planAiApprovalEnabled(text: string, deps: Pick<CommandDeps, 'cfg'>): Plan {
  const v = /^(true|on|yes|1)$/i.test(text.trim()) ? true : /^(false|off|no|0)$/i.test(text.trim()) ? false : null;
  if (v === null) return { error: 'Give true or false.' };
  const old = deps.cfg.get('approval.ai.enabled');
  if (old === v) return { error: 'No change: the key already has that value.' };
  return { before: old, items: [{ label: 'approval.ai.enabled', old: show(old), neu: show(v) }], writes: [set('approval.ai.enabled', v, deps)], audit: { action: 'config.set', tool: 'approval.ai.enabled' }, risk: v === true };
}

/** GROW-1: `skills.ai.enabled` is the only AI skill review key with a `/settings` path (the caps are the owner's, in the database). Turning it on lets a model apply a team skill without a person reading it first, so it is a risk. */
export function planSkillsAiEnabled(text: string, deps: Pick<CommandDeps, 'cfg'>): Plan {
  const v = /^(true|on|yes|1)$/i.test(text.trim()) ? true : /^(false|off|no|0)$/i.test(text.trim()) ? false : null;
  if (v === null) return { error: 'Give true or false.' };
  const old = deps.cfg.get('skills.ai.enabled');
  if (old === v) return { error: 'No change: the key already has that value.' };
  return { before: old, items: [{ label: 'skills.ai.enabled', old: show(old), neu: show(v) }], writes: [set('skills.ai.enabled', v, deps)], audit: { action: 'config.set', tool: 'skills.ai.enabled' }, risk: v === true };
}

/** GROW-1: `grow.retro.enabled` is the only retro key with a `/settings` path (weekday and hour are the owner's, in the database). Turning it on starts a model run per department each week, so it is a risk. */
export function planGrowRetroEnabled(text: string, deps: Pick<CommandDeps, 'cfg'>): Plan {
  const v = /^(true|on|yes|1)$/i.test(text.trim()) ? true : /^(false|off|no|0)$/i.test(text.trim()) ? false : null;
  if (v === null) return { error: 'Give true or false.' };
  const old = deps.cfg.get('grow.retro.enabled');
  if (old === v) return { error: 'No change: the key already has that value.' };
  return { before: old, items: [{ label: 'grow.retro.enabled', old: show(old), neu: show(v) }], writes: [set('grow.retro.enabled', v, deps)], audit: { action: 'config.set', tool: 'grow.retro.enabled' }, risk: v === true };
}

/**
 * TREEGRANT-1 (TG-C8): `taskGrant.enabled` is the only task-grant key with a `/settings` path (the caps and hours are the owner's, in the database).
 * Switching it OFF also revokes every live grant (reason `disabled`); the consume gate reads the switch live regardless, and the app also revokes on any flip seen by the config watcher.
 */
export function planTaskGrantEnabled(text: string, userId: string, deps: Pick<CommandDeps, 'cfg' | 'taskGrants'>): Plan {
  const v = /^(true|on|yes|1)$/i.test(text.trim()) ? true : /^(false|off|no|0)$/i.test(text.trim()) ? false : null;
  if (v === null) return { error: 'Give true or false.' };
  const old = deps.cfg.get('taskGrant.enabled');
  if (old === v) return { error: 'No change: the key already has that value.' };
  return {
    before: old, items: [{ label: 'taskGrant.enabled', old: show(old), neu: show(v) }], writes: [set('taskGrant.enabled', v, deps)],
    ...(v === false && deps.taskGrants?.revokeAll ? { run: async () => void (await deps.taskGrants!.revokeAll!('disabled', userId)) } : {}),
    audit: { action: 'config.set', tool: 'taskGrant.enabled' }, risk: v === true,
  };
}

/** AUTO-1: `autopilot.enabled`, the switch of project autopilot, set only with `/settings` by a person (a HANDLER_KEY: no tool writes it). Read live; turning it on is a risk (cards stop inside approved projects). */
export function planAutopilotEnabled(text: string, deps: Pick<CommandDeps, 'cfg'>): Plan {
  const v = /^(true|on|yes|1)$/i.test(text.trim()) ? true : /^(false|off|no|0)$/i.test(text.trim()) ? false : null;
  if (v === null) return { error: 'Give true or false.' };
  const old = deps.cfg.get('autopilot.enabled');
  if (old === v) return { error: 'No change: the key already has that value.' };
  return { before: old, items: [{ label: 'autopilot.enabled', old: show(old), neu: show(v) }], writes: [set('autopilot.enabled', v, deps)], audit: { action: 'config.set', tool: 'autopilot.enabled' }, risk: v === true };
}

/** AUTO-2 (AC-C4): `autopilot.scope`, project or company, set only with `/settings` by a person (a HANDLER_KEY: no tool writes it). Read live; `company` is a risk (cards stop outside projects too). */
export function planAutopilotScope(text: string, deps: Pick<CommandDeps, 'cfg'>): Plan {
  const v = text.trim().toLowerCase();
  if (v !== 'project' && v !== 'company') return { error: 'Give project or company.' };
  const old = deps.cfg.get('autopilot.scope');
  if (old === v) return { error: 'No change: the key already has that value.' };
  return { before: old, items: [{ label: 'autopilot.scope', old: show(old), neu: show(v) }], writes: [set('autopilot.scope', v, deps)], audit: { action: 'config.set', tool: 'autopilot.scope' }, risk: v === 'company' };
}

/** REROUTE-1 (RR-C20): `reroute.enabled`, the kill switch of the mention reroute, set only with `/settings` by a person (a HANDLER_KEY: no tool writes it). Read live by the scheduler. */
export function planRerouteEnabled(text: string, deps: Pick<CommandDeps, 'cfg'>): Plan {
  const v = /^(true|on|yes|1)$/i.test(text.trim()) ? true : /^(false|off|no|0)$/i.test(text.trim()) ? false : null;
  if (v === null) return { error: 'Give true or false.' };
  const old = deps.cfg.get('reroute.enabled');
  if (old === v) return { error: 'No change: the key already has that value.' };
  return { before: old, items: [{ label: 'reroute.enabled', old: show(old), neu: show(v) }], writes: [set('reroute.enabled', v, deps)], audit: { action: 'config.set', tool: 'reroute.enabled' }, risk: v === true };
}

/**
 * SPEND-1: one department's monthly cap (`usd` null = clear). A human set or clear ends that month's raise overrides (SP-05, audited by the supersede),
 * so the new figure is the one enforced. `out.superseded` receives how many override rows ended.
 */
export function planDeptBudget(dept: string, usd: number | null, userId: string, deps: Pick<CommandDeps, 'cfg' | 'spend' | 'cards'>, out: { superseded: number } = { superseded: 0 }): Plan {
  if (!(DEPT_IDS as readonly string[]).includes(dept)) return { error: 'Unknown department.' };
  if (usd !== null && (!Number.isFinite(usd) || usd < 0 || usd > SPEND_MAX_USD)) return { error: `The budget must be between 0 and ${SPEND_MAX_USD}.` };
  const old = deps.cfg.get('spend.deptMonthlyUsd') as Record<string, number>;
  const neu: Record<string, number> = { ...old };
  if (usd === null) Reflect.deleteProperty(neu, dept);
  else neu[dept] = usd;
  if (!ConfigSchema['spend.deptMonthlyUsd'].safeParse(neu).success) return { error: 'Invalid value for spend.deptMonthlyUsd.' };
  const label = `spend.deptMonthlyUsd[${dept}]`;
  return {
    before: old, items: [{ label, old: old[dept] === undefined ? '(none)' : `$${old[dept]}`, neu: usd === null ? '(none)' : `$${usd}` }],
    writes: [set('spend.deptMonthlyUsd', neu as never, deps)], audit: { action: 'config.set', tool: label },
    risk: spendRisk('spend.deptMonthlyUsd', old, neu),
    run: async () => {
      const r = await deps.spend?.supersede(dept, userId);
      out.superseded = r?.count ?? 0;
      for (const c of r?.cards ?? []) await deps.cards?.close(c.channelId, c.messageId, 'Superseded: a Bot Admin changed this department budget.').catch(() => undefined);
    },
  };
}

/**
 * RFMD P3 / Gate 1 RF20 + OD-2: the company profile (name, address, 13-digit tax ID with the Thai checksum). Only a member who holds the Founder role
 * RIGHT NOW (the roles of this very interaction) may set it, and only from /settings (never a tool, never `config_propose`). `none` clears it,
 * which turns money and tax documents off again. The value is one JSON object, validated by CompanyProfileSchema.
 */
export function planCompanyProfile(text: string, roleIds: readonly string[], deps: Pick<CommandDeps, 'cfg'>): Plan {
  const audit = { outcome: 'refused: not founder', tool: 'company.profile' };
  if (!roleIds.includes(FOUNDER_ROLE_ID)) return { error: 'Only the Founder can set the company profile.', audit };
  const t = text.trim();
  let value: unknown = null;
  if (!/^(none|null)$/i.test(t)) {
    try {
      value = JSON.parse(t);
    } catch {
      return { error: 'Give the profile as JSON: {"name":"...","address":"...","taxId":"13 digits","branch":"00000","phone":"...","email":"..."} or none.' };
    }
    const r = CompanyProfileSchema.safeParse(value);
    if (!r.success) return { error: `Invalid company profile: ${(r.error.issues[0]?.path.join('.') || 'value')}: ${r.error.issues[0]?.message ?? 'invalid'}`.slice(0, 300) };
    value = r.data;
  }
  const old = deps.cfg.get('company.profile');
  return { before: old, items: [{ label: 'company.profile', old: show(old), neu: show(value) }], writes: [set('company.profile', value as never, deps)], audit: { action: 'config.set', tool: 'company.profile' }, risk: true };
}

// ---- holidays and weekdays ----

const MAX_HOLIDAYS = 100;
const MAX_HOLIDAY_NAME = 60;
const holidayLabel = (h: { date: string; name?: string }) => (h.name ? `${h.date} ${h.name}` : h.date);
export const dateOf = (s: string | null): string | null => {
  const d = (s ?? '').trim();
  return isCalendarDate(d) ? d : null;
};

export function planHolidayAdd(dateIn: string | null, nameIn: string | null, deps: Pick<CommandDeps, 'cfg'>): Plan {
  const date = dateOf(dateIn);
  if (!date) return { error: 'Give the date as YYYY-MM-DD, for example 2026-12-31.' };
  const name = (nameIn ?? '').trim();
  if (name.length > MAX_HOLIDAY_NAME) return { error: `The name can be at most ${MAX_HOLIDAY_NAME} characters.` };
  if (name && !Holiday.shape.name.safeParse(name).success) return { error: 'The name must be plain text (no line breaks).' };
  const old = deps.cfg.get('schedule.holidays');
  const entry = { date, ...(name ? { name } : {}) };
  const next = old.some((h) => h.date === date) ? old.map((h) => (h.date === date ? entry : h)) : [...old, entry].sort((a, b) => a.date.localeCompare(b.date));
  if (next.length > MAX_HOLIDAYS) return { error: `Refused: at most ${MAX_HOLIDAYS} holidays can be listed; remove past ones first.` };
  return {
    before: old, items: [{ label: 'Holidays', old: old.map(holidayLabel).join(', ') || '(none)', neu: next.map(holidayLabel).join(', ') }],
    writes: [set('schedule.holidays', next, deps)], audit: { action: 'holiday.add', tool: date }, risk: false,
  };
}

export function planHolidayRemove(dateIn: string | null, deps: Pick<CommandDeps, 'cfg'>): Plan {
  const date = dateOf(dateIn);
  if (!date) return { error: 'Give the date as YYYY-MM-DD, for example 2026-12-31.' };
  const old = deps.cfg.get('schedule.holidays');
  const next = old.filter((h) => h.date !== date);
  if (next.length === old.length) return { error: `${date} is not a listed holiday.` };
  return {
    before: old, items: [{ label: 'Holidays', old: old.map(holidayLabel).join(', '), neu: next.map(holidayLabel).join(', ') || '(none)' }],
    writes: [set('schedule.holidays', next, deps)], audit: { action: 'holiday.remove', tool: date }, risk: false,
  };
}

const MAX_WORKDAYS = 50;

/** `/holiday workday [date] [remove]`: an extra working date (default today in schedule.timezone); past dates are refused on add. */
export function planWorkday(dateIn: string | null, remove: boolean, deps: Pick<CommandDeps, 'cfg' | 'now'>): Plan {
  const today = localDay((deps.now?.() ?? new Date()).getTime(), deps.cfg.get('schedule.timezone')).date;
  const date = dateIn === null || dateIn.trim() === '' ? today : dateOf(dateIn);
  if (!date) return { error: 'Give the date as YYYY-MM-DD, for example 2026-12-31, or leave it empty for today.' };
  const old = deps.cfg.get('schedule.workDays');
  let next: string[];
  if (remove) {
    next = old.filter((d) => d !== date);
    if (next.length === old.length) return { error: `${date} is not a listed workday.` };
  } else {
    if (date < today) return { error: `${date} is in the past.` };
    if (old.includes(date)) return { error: `${date} is already a workday.` };
    next = [...old.filter((d) => d >= today), date].sort();
    if (next.length > MAX_WORKDAYS) return { error: `Refused: at most ${MAX_WORKDAYS} extra workdays can be listed.` };
  }
  return {
    before: old, items: [{ label: 'Extra workdays', old: old.join(', ') || '(none)', neu: next.join(', ') || '(none)' }],
    writes: [set('schedule.workDays', next, deps)], audit: { action: remove ? 'holiday.workday_remove' : 'holiday.workday', tool: date }, risk: false,
  };
}

export function planWeekdays(days: string | null, deps: Pick<CommandDeps, 'cfg'>): Plan {
  const parsed = parseWeekdays(days ?? '');
  if (!parsed) return { error: 'Use day names mon, tue, wed, thu, fri, sat, sun separated by commas (for example sat,sun), or none.' };
  const old = deps.cfg.get('schedule.offDays');
  return {
    before: old, items: [{ label: 'Weekly off days', old: weekdayNames(old), neu: weekdayNames(parsed) }],
    writes: [set('schedule.offDays', parsed, deps)], audit: { action: 'holiday.weekdays', tool: parsed.join(',') }, risk: false,
  };
}

// ---- channel map ----

/** TW10: the goals text channel and forum are added, so a goals forum can never become a department forum and route twice. */
const PROTECTED = [CONFIG_CHANNEL_ID, TASK_LOG_CHANNEL_ID, DIRECT_LOG_CHANNEL_ID, BOT_LOG_CHANNEL_ID, AI_WARROOM_CHANNEL_ID, ...NEVER_MAPPED_CHANNEL_IDS];
/** `type` is the Discord channel type when known (15 = forum). */
export type ChannelArg = { id: string; parentId: string | null; type?: number };
const FORUM_TYPE = 15;

export function channelTargetError(ch: ChannelArg | null): string | null {
  if (!ch) return 'Pick a channel.';
  if (isDenied(ch.id, ch.parentId)) return 'That channel is off limits.';
  if (PROTECTED.includes(ch.id) || (ch.parentId !== null && PROTECTED.includes(ch.parentId))) return 'The log, bot-log, ai-warroom, company-goals and config channels cannot be mapped.';
  return null;
}

const isSeeded = (dept: string) => SEED_DEPARTMENTS.some((d) => d.id === dept && d.workChannelId !== null);
type MapDeps = Pick<CommandDeps, 'org' | 'repos'>;

/** R1: release a department's work channel when it is this one and was set by /channel map (never a seeded one). */
async function releaseWork(deps: MapDeps, dept: string, channelId: string): Promise<void> {
  const d = await deps.repos.departments.get(dept);
  if (d && d.workChannelId === channelId && !isSeeded(dept)) await deps.repos.departments.upsert({ ...d, workChannelId: null });
}

export async function planChannelMap(ch: ChannelArg | null, dept: string, isWork: boolean, deps: MapDeps): Promise<Plan> {
  const bad = channelTargetError(ch);
  if (bad) return { error: bad };
  const id = ch!.id;
  if (!deps.org.dept(dept)) return { error: 'Unknown department.' };
  // A forum cannot be a work channel: a task thread there would need a starter post (the work channel holds task threads).
  if (isWork && ch!.type === FORUM_TYPE) return { error: 'A forum cannot be a work channel; map it without work.' };
  const old = await deps.repos.channelMap.get(id);
  return {
    before: old ? { dept: old.deptId, work: old.isWork } : null,
    items: [{ label: 'Channel map', slash: `<#${id}>`, refs: [{ kind: 'channel', id }], old: old ? `${old.deptId}${old.isWork ? ' (work)' : ''}` : '(unmapped)', neu: `${dept}${isWork ? ' (work)' : ''}` }],
    writes: [], audit: { action: 'channel.map', tool: id }, risk: false,
    run: async () => {
      await deps.repos.channelMap.upsert({ channelId: id, deptId: dept, isWork });
      if (old && old.deptId !== dept) await releaseWork(deps, old.deptId, id);
      // R1: work:true gives a department without a work channel (praw) one; an existing work channel is never replaced.
      if (isWork) {
        const d = await deps.repos.departments.get(dept);
        if (d && d.workChannelId === null) await deps.repos.departments.upsert({ ...d, workChannelId: id });
      }
      await deps.org.reload();
    },
  };
}

export async function planChannelUnmap(ch: ChannelArg | null, deps: MapDeps): Promise<Plan> {
  const bad = channelTargetError(ch);
  if (bad) return { error: bad };
  const id = ch!.id;
  const old = await deps.repos.channelMap.get(id);
  if (!old) return { error: 'That channel is not mapped.' };
  return {
    before: { dept: old.deptId, work: old.isWork },
    items: [{ label: 'Channel map', slash: `<#${id}>`, refs: [{ kind: 'channel', id }], old: old.deptId, neu: '(unmapped)' }],
    writes: [], audit: { action: 'channel.unmap', tool: id }, risk: false,
    run: async () => {
      await deps.repos.channelMap.delete(id);
      await releaseWork(deps, old.deptId, id);
      await deps.org.reload();
    },
  };
}

// ---- bots ----

export async function planBotToggle(id: string, enabled: boolean, deps: Pick<CommandDeps, 'org' | 'repos'>): Promise<Plan> {
  const d = await deps.repos.departments.get(id);
  if (!d) return { error: 'Unknown department.' };
  if (id === 'hq' && !enabled) return { error: 'The hq bot cannot be disabled (it serves these commands).' };
  return {
    before: d.enabled, items: [{ label: `${id} enabled`, old: show(d.enabled), neu: show(enabled) }], writes: [],
    audit: { action: enabled ? 'bot.enable' : 'bot.disable', tool: id }, risk: false,
    run: async () => {
      await deps.repos.departments.upsert({ ...d, enabled });
      await deps.org.reload();
    },
  };
}

export async function planBotModel(id: string, provider: string, model: string, deps: CommandDeps): Promise<Plan> {
  const d = await deps.repos.departments.get(id);
  if (!d) return { error: 'Unknown department.' };
  if (!provider || !model || provider.length > 64 || model.length > 128) return { error: 'Invalid provider or model.' };
  // R8 PV-F01: only the department praw uses Gemini (owner rule), whoever proposes the card.
  if (provider === GEMINI_PROVIDER && id !== 'praw') return { error: 'Only the praw department uses Gemini.' };
  const refused = selectionError(deps, provider, model);
  if (refused) return { error: refused };
  return {
    before: { provider: d.provider, model: d.model, priced: Object.keys(deps.cfg.get('pricing')).includes(model) },
    items: [{ label: `${id} model`, old: `${d.provider ?? '(default)'}/${d.model ?? '(default)'}`, neu: `${provider}/${model}` }], writes: [],
    // R8 PV-F01: the claude target is metered, so it needs the LW Admin confirm card (risk) like other spend increases.
    audit: { action: 'bot.model', tool: id, provider, model }, risk: provider === METERED_CLAUDE_PROVIDER,
    run: async () => {
      await deps.repos.departments.upsert({ ...d, provider, model });
      await deps.org.reload();
    },
  };
}

/** R6 MCP-1 (spec 5.8, MC-C14): the one fixed text for every refusal of an external tool grant (tool_request, /bot tools, /tool cards, admin_op bot_tools). */
export const MCP_GRANT_TEXT = 'MCP tools are granted with /mcp depts.';

/** Per-department plugin allowlist (`tools.byDept`). Heads run delegated, so a write tool added here still needs approval. */
export function planBotTools(dept: string, action: string, tool: string, deps: PlanDeps): Plan {
  if (!deps.org.dept(dept)) return { error: 'Unknown department.' };
  if (action !== 'add' && action !== 'remove') return { error: 'Action must be add or remove.' };
  if (tool.startsWith('mcp_')) return { error: MCP_GRANT_TEXT };
  const all = deps.cfg.get('tools.byDept');
  const old = Object.hasOwn(all, dept) ? all[dept]! : [];
  if (action === 'add' && !deps.tools.plugins().includes(tool)) return { error: 'Unknown tool; it must be a registered plugin tool.' };
  if (action === 'remove' && !old.includes(tool)) return { error: 'That tool is not in the department list.' };
  const next = action === 'add' ? [...new Set([...old, tool])] : old.filter((t) => t !== tool);
  return {
    before: old, items: [{ label: `${dept} tools`, old: show(old), neu: show(next) }], writes: [set('tools.byDept', { ...all, [dept]: next }, deps)],
    audit: { action: `bot.tools.${action}`, tool }, risk: action === 'add',
  };
}

export function planProviderDefault(provider: string, model: string, deps: CommandDeps): Plan {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(provider) || !model || model.length > 128) return { error: 'Invalid provider or model.' };
  // Gate 2 G2-PV-03 (sibling of PV-F01): the default serves every department without its own row, so Gemini there would move non-praw work to Gemini.
  if (provider === GEMINI_PROVIDER) return { error: 'Only the praw department uses Gemini; set it with /bot model praw, never as the company default.' };
  const refused = selectionError(deps, provider, model);
  if (refused) return { error: refused };
  const old = deps.cfg.get('provider.default');
  return {
    before: old, items: [{ label: 'provider.default', old: `${old.provider}/${old.model}`, neu: `${provider}/${model}` }],
    writes: [set('provider.default', { provider, model }, deps)], audit: { action: 'provider.default', tool: 'provider.default', provider, model }, risk: true,
  };
}

// ---- channel-valued config (denied channels refused) ----

function planChannelKey(key: 'ocr.autoChannelId' | 'clickup.notifyChannelId', label: string, action: string, ch: ChannelArg | null, deps: Pick<CommandDeps, 'cfg'>): Plan {
  if (ch && isDenied(ch.id, ch.parentId)) return { error: 'That channel is off limits.' };
  const old = deps.cfg.get(key);
  const next = ch ? ch.id : null;
  return {
    before: old, writes: [set(key, next, deps)], audit: { action, tool: next ?? 'clear' }, risk: false,
    items: [{ label, old: old ?? '(none)', neu: next ?? '(none)', refs: [...(old ? [{ kind: 'channel' as const, id: old }] : []), ...(next ? [{ kind: 'channel' as const, id: next }] : [])] }],
  };
}
export const planAutoOcr = (ch: ChannelArg | null, deps: Pick<CommandDeps, 'cfg'>) => planChannelKey('ocr.autoChannelId', 'Auto-OCR channel', 'autoocr.channel', ch, deps);
/**
 * Work-style §5 (Gate 1 WS10, WS11): the channel of the daily goal / evening report or of the pinned dashboard. It becomes a POST-ONLY room (never read or routed),
 * so it must be a plain text or announcement channel that is not a thread, not DENIED, not a system or mod room, not the warroom or the goals channels
 * (that would blank the CEO's input), not an approvals room and not the other rhythm/dashboard channel. Anything else is refused; null switches the feature off.
 */
export function planRhythmChannel(key: 'rhythm.dailyGoalChannelId' | 'dashboard.channelId', ch: ChannelArg | null, deps: Pick<CommandDeps, 'cfg'>): Plan {
  const label = key === 'dashboard.channelId' ? 'Dashboard channel' : 'Daily goal channel';
  if (ch) {
    if (isDenied(ch.id, ch.parentId) || isDeniedCategory(ch.parentId)) return { error: 'That channel is off limits.' };
    // G2WS-01: `parentId` of a text channel is its CATEGORY (discord.js), so it is not a thread test; the type is (threads are 10-12).
    if (ch.type !== 0 && ch.type !== 5) return { error: 'Use a text or announcement channel (not a thread, forum or voice channel).' };
    const other = deps.cfg.get(key === 'dashboard.channelId' ? 'rhythm.dailyGoalChannelId' : 'dashboard.channelId');
    const taken = [AI_WARROOM_CHANNEL_ID, GOAL_TEXT_CHANNEL_ID, GOAL_FORUM_CHANNEL_ID, ...Object.values(deps.cfg.get('approvals.channelByCategory')), ...(other ? [other] : [])];
    if (isExcludedChannel(ch.id, ch.parentId, { modRoomId: deps.cfg.get('roles.modRoomId') }) || taken.includes(ch.id)) return { error: 'That channel is a system, mod, goals, warroom or approvals channel, or already used for another purpose.' };
  }
  const old = deps.cfg.get(key);
  const next = ch ? ch.id : null;
  return {
    before: old, writes: [set(key, next, deps)], audit: { action: key === 'dashboard.channelId' ? 'dashboard.channel' : 'rhythm.channel', tool: next ?? 'clear' }, risk: false,
    items: [{ label, old: old ?? '(none)', neu: next ?? '(none)', refs: [...(old ? [{ kind: 'channel' as const, id: old }] : []), ...(next ? [{ kind: 'channel' as const, id: next }] : [])] }],
  };
}

export const planClickupChannel = (ch: ChannelArg | null, deps: Pick<CommandDeps, 'cfg'>) => planChannelKey('clickup.notifyChannelId', 'ClickUp notification channel', 'clickup.channel', ch, deps);

/** CLICKUP-ALL-1 (C9, C11): the daily cap on ClickUp writes (workspace mode). 0 = writes off. Raising it widens what a tricked bot can change, so it is a risk change (reroute.enabled pattern). */
export function planClickupWritesPerDay(text: string, deps: Pick<CommandDeps, 'cfg'>): Plan {
  const t = text.trim();
  if (!/^\d{1,3}$/.test(t)) return { error: 'Give a whole number from 0 to 500 (0 turns ClickUp writes off).' };
  const n = Number(t);
  if (!ConfigSchema['clickup.writesPerDay'].safeParse(n).success) return { error: 'Give a whole number from 0 to 500 (0 turns ClickUp writes off).' };
  const old = deps.cfg.get('clickup.writesPerDay');
  if (old === n) return { error: 'No change: the key already has that value.' };
  return { before: old, items: [{ label: 'clickup.writesPerDay', old: show(old), neu: show(n) }], writes: [set('clickup.writesPerDay', n, deps)], audit: { action: 'config.set', tool: 'clickup.writesPerDay' }, risk: n > old };
}

export const CLICKUP_WATCH_MAX = 10;
/**
 * CLICKUP-MULTI-1 (all-workspaces mode only): each watched list id with its workspace label next to it. The label is vendor text (R7), so it is cut, hashed and escaped
 * like any card text; the team id itself is never shown. A list that cannot be read now keeps its bare id. At most 10 ids per call, none outside all mode. The caller labels both the old and the new list (up to 10 ids each), so a command makes at most about 20 lookups (bounded by the shared request bucket).
 */
async function labelledLists(ids: readonly string[], deps: Pick<CommandDeps, 'clickup'>, known?: CuListInfo): Promise<string> {
  if (deps.clickup?.teamScope !== 'all') return show(ids);
  const out: string[] = [];
  for (const x of ids) {
    let l: CuListInfo | undefined = known?.id === x ? known : undefined;
    if (!l) {
      try {
        l = await deps.clickup.listInScope(x);
      } catch {
        l = undefined;
      }
    }
    out.push(l?.teamId !== undefined ? `${x} (workspace ${escapeCardText(workspaceLabelText(l.teamId, l.teamName ?? '?'), 80)})` : x);
  }
  return show(out);
}
/**
 * CLICKUP-ALL-1 (C11): `/clickup watch list_id:<id> action:add|remove`, the only way to change `clickup.pollListIds` (no AdminOp, no config_propose). Workspace mode only.
 * Add checks that the list is in the workspace (listInScope: the space id must be one of the workspace's) and caps the list at 10. The error texts are fixed.
 */
export async function planClickupWatch(listId: string, action: string, deps: Pick<CommandDeps, 'cfg' | 'clickup' | 'clickupSeen'>): Promise<Plan> {
  if (action !== 'add' && action !== 'remove') return { error: 'Action must be add or remove.' };
  const id = listId.trim();
  if (!/^[a-z0-9]{1,32}$/.test(id)) return { error: 'Give the list id exactly as clickup_list_projects shows it.' };
  if (!deps.clickup || deps.clickup.mode !== 'workspace') return { error: 'ClickUp workspace mode is not on (set CLICKUP_TEAM_ID, or CLICKUP_TEAM_ID=all, and clear CLICKUP_LIST_ID); in list mode the one configured list is watched already.' };
  const old = deps.cfg.get('clickup.pollListIds');
  const audit = { action: 'clickup.watch', tool: `${action}:${id}` };
  if (action === 'remove') {
    if (!old.includes(id)) return { error: 'That list is not watched.', audit: { ...audit, outcome: 'refused' } };
    const next = old.filter((x) => x !== id);
    return { before: old, items: [{ label: 'ClickUp watched lists', old: await labelledLists(old, deps), neu: await labelledLists(next, deps) }], writes: [set('clickup.pollListIds', next, deps)], audit, risk: false, ...(deps.clickupSeen ? { run: async () => void (await deps.clickupSeen!.forgetBaseline(id)) } : {}) };
  }
  if (old.includes(id)) return { error: 'That list is watched already.', audit: { ...audit, outcome: 'refused' } };
  if (old.length >= CLICKUP_WATCH_MAX) return { error: `At most ${CLICKUP_WATCH_MAX} lists can be watched; remove one first.`, audit: { ...audit, outcome: 'refused' } };
  let info: CuListInfo | undefined;
  try {
    info = await deps.clickup.listInScope(id);
  } catch {
    return { error: 'That list is not in the ClickUp workspace.', audit: { ...audit, outcome: 'refused' } }; // one text for "foreign", "missing" and "ClickUp down": no existence oracle
  }
  const next = [...old, id];
  // all-workspaces mode: the workspace of each list is shown next to its id (the label cuts the name and carries a hash; the team id itself is never shown)
  return { before: old, items: [{ label: 'ClickUp watched lists', old: await labelledLists(old, deps), neu: await labelledLists(next, deps, info) }], writes: [set('clickup.pollListIds', next, deps)], audit, risk: true };
}

// ---- media allowlist ----

const MAX_HOST = 253;
export function planMediaAllowlist(action: string | null, hostIn: string | null, deps: Pick<CommandDeps, 'cfg'>): Plan {
  const host = (hostIn ?? '').trim().toLowerCase();
  if ((action !== 'add' && action !== 'remove') || !host || host.length > MAX_HOST) return { error: 'Use action add or remove with a host name such as m.youtube.com.' };
  const old = deps.cfg.get('media.ytHostAllowlist');
  const next = action === 'add' ? (old.includes(host) ? old : [...old, host]) : old.filter((h) => h !== host);
  if (action === 'remove' && next.length === old.length) return { error: `${host} is not on the list.` };
  if (!ConfigSchema['media.ytHostAllowlist'].safeParse(next).success) return { error: 'Refused: the list needs 1 to 20 lower-case host names (no IP addresses, no ports or paths).' };
  return {
    before: old, items: [{ label: 'Music host allowlist', old: show(old), neu: show(next) }], writes: [set('media.ytHostAllowlist', next, deps)],
    audit: { action: 'media.allowlist', tool: `${action}:${host}` }, risk: action === 'add',
  };
}

// ---- GitHub write allowlist ----

const GH_ALLOW_MAX = 200;
const ghShow = (l: readonly { id: number; fullName: string }[]) => l.map((e) => `${e.fullName}#${e.id}`);

/**
 * `owner/repo[#id]`: the write allowlist. Add resolves the repository through the API (id + canonical full_name), requires the installation
 * account as owner and refuses anything on the hard denylist, then stores `{id, fullName}`. Remove prefers the id (renamed repos) and works
 * without the API (deleted repos). An error carries the audit row the slash handler writes for it.
 */
export async function planGithubAllow(action: string, rawIn: string, deps: Pick<CommandDeps, 'cfg' | 'github'>): Promise<Plan> {
  const raw = rawIn.trim();
  const pinned = /#(\d{1,16})$/.exec(raw);
  const given = cleanRepoSpec(pinned ? raw.slice(0, pinned.index) : raw);
  const spec = given.toLowerCase();
  if (action !== 'add' && action !== 'remove') return { error: 'Action must be add or remove.' };
  const [owner, repo, ...rest] = given.split('/');
  try {
    if (rest.length) throw new Error('shape');
    githubName(owner); githubName(repo);
  } catch {
    return { error: 'Give the repository as owner/repo.' };
  }
  const all = deps.cfg.get('github.repoAllowlist');
  const audit = (tool: string) => ({ action: `github.allow.${action}`, tool });
  if (action === 'remove') {
    let drop = pinned ? all.filter((e) => e.id === Number(pinned[1])) : [];
    if (!pinned && deps.github) {
      const t = await deps.github.resolveRepo(owner!, repo!).catch(() => null);
      if (t) drop = all.filter((e) => e.id === t.id);
    }
    if (!pinned && !drop.length) {
      const byName = all.filter((e) => normalizeRepoSpec(e.fullName) === spec);
      if (byName.length > 1) return { error: `Several entries are stored under that name: remove one with owner/repo#id (${ghShow(byName).join(', ')}).` };
      drop = byName;
    }
    if (!drop.length) return { error: 'That repository is not on the GitHub write allowlist.' };
    const next = all.filter((e) => !drop.includes(e));
    return { before: all, items: [{ label: 'GitHub write allowlist', old: show(ghShow(all)), neu: show(ghShow(next)) }], writes: [set('github.repoAllowlist', next, deps)], audit: audit(ghShow(drop).join(',')), risk: false };
  }
  if (!deps.github) return { error: 'GitHub is not configured (GITHUB_APP_ID / GITHUB_INSTALLATION_ID / key).' };
  if (isDeniedRepo({ fullName: spec, id: -1 })) return { error: `${DENIED}.`, audit: { outcome: 'refused', tool: spec } };
  let t;
  let account;
  let deniedIds;
  try {
    account = await deps.github.installationAccount();
    deniedIds = await deps.github.deniedIds();
    t = await deps.github.resolveRepo(owner!, repo!);
  } catch (err) {
    return { error: err instanceof GithubError ? err.message : 'GitHub request failed.', audit: { outcome: 'failed', tool: spec } };
  }
  const id = `${t.fullName}#${t.id}`;
  if (t.owner.toLowerCase() !== account.toLowerCase()) return { error: 'That repository is not owned by the account the GitHub App is installed on.', audit: { outcome: 'refused', tool: id } };
  if (isDeniedRepo(t, deniedIds)) return { error: `${DENIED}.`, audit: { outcome: 'refused', tool: id } };
  if (!all.some((e) => e.id === t.id) && all.length >= GH_ALLOW_MAX) return { error: `The GitHub write allowlist is full (${GH_ALLOW_MAX} repositories); remove one first.` };
  const next = [...all.filter((e) => e.id !== t.id), { id: t.id, fullName: t.fullName }];
  return { before: all, items: [{ label: 'GitHub write allowlist', old: show(ghShow(all)), neu: show(ghShow(next)) }], writes: [set('github.repoAllowlist', next, deps)], audit: audit(id), risk: true };
}

// ---- personas ----

export async function planPersonaToggle(personaId: string, enabled: boolean, deps: Pick<CommandDeps, 'org' | 'repos'>): Promise<Plan> {
  const p = await deps.repos.personas.get(personaId);
  if (!p) return { error: 'Unknown persona.' };
  return {
    before: p.enabled, items: [{ label: `persona ${p.id} enabled`, old: show(p.enabled), neu: show(enabled) }], writes: [],
    audit: { action: enabled ? 'persona.enable' : 'persona.disable', tool: p.id }, risk: false,
    run: async () => {
      await deps.repos.personas.upsert({ ...p, enabled });
      await deps.org.reload();
    },
  };
}

/** A prompt override for a persona. The console path limits the body so the whole text fits on the card (never truncated). */
export async function planPersonaEdit(personaId: string, bodyIn: string, deps: CommandDeps, by: string | null, maxBody = PERSONA_BODY_MAX): Promise<Plan> {
  const p = await deps.repos.personas.get(personaId);
  if (!p) return { error: 'Unknown persona.' };
  const body = bodyIn.trim();
  if (body.length < 10 || body.length > maxBody) return { error: `Prompt must be 10-${maxBody} characters.` };
  const old = await deps.repos.overrides.getActive(p.promptRef);
  return {
    before: old ? { version: old.version } : null,
    items: [{ label: `${p.name} prompt`, old: old ? `override v${old.version}` : 'file default', neu: `new override (${body.length} chars)`, detail: body }], writes: [],
    audit: { action: 'persona.edit', tool: p.id }, risk: true,
    run: async () => {
      await deps.repos.overrides.upsert(p.promptRef, body, by);
      await deps.org.reload();
    },
  };
}

export const knownDept = (id: string): boolean => (DEPT_IDS as readonly string[]).includes(id);
export type { DeptId };

// ---- executing a plan on the slash path ----

/**
 * The slash path: write now (plain `set`), run the effects, audit, answer `old -> new` for the plan's first item. Errors propagate to
 * handleInteraction (masked, generic reply). `setBy` is what the config row records as the writer.
 */
export async function applyPlan(plan: PlanOk, userId: string, deps: CommandDeps, setBy = `user:${userId}`): Promise<Reply> {
  for (const w of plan.writes) await deps.cfg.set(w.key as 'budget.taskUsd', w.value as number, setBy);
  await plan.run?.();
  await deps.audit({ actor: `user:${userId}`, ...plan.audit, outcome: 'ok' });
  const it = plan.items[0]!;
  return changeReply(it.slash ?? it.label, it.old === '(none)' ? null : it.old, it.neu === '(none)' ? null : it.neu);
}

export const refusal = (p: PlanError): Reply => ephemeral(p.error);
