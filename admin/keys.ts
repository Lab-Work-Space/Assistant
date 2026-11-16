import { CONFIG_DEFAULTS } from '../config/defaults.js';
import { ConfigSchema, type ConfigKey } from '../config/schema.js';

/**
 * Gate 1 C1/C2 (narrowing N1): which config keys the admin console may touch. Code-defined, never derived from the schema alone.
 *
 * - `halted` is never settable here: /halt and /resume stay slash-only.
 * - HANDLER_KEYS have a slash handler with checks beyond zod (a denied channel, a GitHub repo resolved through the API, a registered
 *   plugin tool, a priced model, ...). They change only through `admin_op_propose`, which runs the same plan functions as the handlers.
 * - ADMIN_CONFIG_KEYS is everything else: the keys `config_propose` may write.
 */
export const HANDLER_KEYS: readonly ConfigKey[] = [
  'github.repoAllowlist', 'ocr.autoChannelId', 'clickup.notifyChannelId', 'tools.byDept', 'media.ytHostAllowlist',
  'schedule.holidays', 'schedule.offDays', 'schedule.workDays', 'provider.default',
  // R8 PROV-FALLBACK (PV-C08): whether work may run on the metered Claude API during a quota hold is the owner's; no AdminOp, no config_propose. It has a /settings path (risk when turned on).
  'provider.fallback.enabled',
  // Work-style §5 (WS10, WS11): these become post-only rooms, so they change only through their plan function (/settings set), never a raw config_propose write.
  'rhythm.dailyGoalChannelId', 'dashboard.channelId',
  // Self-code: the switch, the budget, the per-job cap and who confirms are the owner's; no model-reachable path writes them.
  'devjob.enabled', 'devjob.budgetUsd', 'devjob.jobCapUsd', 'devjob.ownerUserId',
  // RF20: the company profile (name, address, tax ID) is owner-only: /settings checks the Founder role live; no model-reachable path writes it.
  'company.profile',
  // Gate 1 S14: roles and channel are checked live by the executor, so the welcome keys change only through admin_op_propose `welcome_set`.
  'welcome.enabled', 'welcome.roleIds', 'welcome.message', 'welcome.channelId', 'welcome.raidPerMinute',
  // SEARCH-1: sending an approved query to up to five more third parties is the owner's decision; only the switch has a /settings path.
  'web.search.openSources',
  // WEBGRANT-1: how much a tricked bot could read and send out through urls is the owner's decision; no model-reachable path writes these caps.
  'web.taskGrant.enabled', 'web.taskGrant.hours', 'web.taskGrant.maxFetches', 'web.taskGrant.maxHosts', 'web.taskGrant.maxUrlChars',
  // TREEGRANT-1: how many internal writes run unseen after one click is the owner's decision; no model-reachable path writes these. Only taskGrant.enabled has a /settings path.
  'taskGrant.enabled', 'taskGrant.hours', 'taskGrant.conversationHours', 'taskGrant.maxCalls', 'taskGrant.allowTainted',
  // OT-1 (OT-C1): overtime on off days is the owner's call; no model-reachable path writes the switch or the caps. Only ot.enabled has a /settings path.
  'ot.enabled', 'ot.hours', 'ot.maxRuns', 'ot.maxUsd', 'ot.requestsPerRootPerDay', 'ot.requestsPerDay', 'ot.requestsPerPersonPerDay',
  // HEAL-1 (HL-C2, HL-C17): whether bots retry, wake and lift the warroom stall on their own, and the caps on that, are the owner's; no model-reachable path writes them. Only heal.enabled has a /settings path.
  'heal.enabled', 'heal.maxRetries', 'heal.maxWakesPerTask', 'heal.maxWakesPerDeciderDay', 'warroom.stallQuietMinutes', 'warroom.quietLiftsPerDay', 'warroom.personLiftsPerDay',
  // OPS-HOLD: closing a stale review task by code is the owner's call; psql only, no model-reachable path.
  'review.autoCloseHours',
  // WS-1 (Gate 1 WS-C24): whether workspaces are on and how many sandbox runs a task or a day may take are the owner's; no model-reachable path writes them.
  'ws.enabled', 'ws.maxRunsPerTree', 'ws.maxRunsPerDay',
  // R5 (RL-C13): the release kill switch is the owner's; psql only, no model-reachable path writes it.
  'release.enabled',
  // R6 MCP-1 (MC-C14): outside programs are the owner's; no model-reachable path writes the switch or the caps. Only mcp.enabled has a /settings path.
  'mcp.enabled', 'mcp.maxCallsPerTree', 'mcp.maxCallsPerDay',
  // R7 PLUGIN-FORGE (PF-C13): whether bots may have code build their own tools is the owner's; no model-reachable path writes the switch. It has a /settings path (risk when turned on).
  'forge.enabled',
  // AUTO-1 (AP-C10): whether bots may run approved calls with no card inside an approved project, and how many, is the owner's; no model-reachable path writes them. Only autopilot.enabled has a /settings path.
  'autopilot.enabled', 'autopilot.maxApprovalsPerProject',
  // AUTO-2 (AC-C4): the company scope and its caps are the owner's too; only autopilot.scope has a /settings path.
  'autopilot.scope', 'autopilot.company.maxApprovalsPerDay', 'autopilot.company.maxApprovalsPerTree', 'autopilot.company.maxApprovalsPerPersonDay',
  // AI-APPROVE-1 (AA-C17): whether the AI approves tool cards and its caps are the owner's; no model-reachable path writes them. Only approval.ai.enabled has a /settings path (BE2).
  'approval.ai.enabled', 'approval.ai.maxPerTree', 'approval.ai.maxPerDay',
  // GROW-1 (GW-C27): the weekly retro and the AI skill review are the owner's; no model-reachable path writes them. The two switches have /settings paths; the rest are psql only.
  'grow.retro.enabled', 'grow.retro.weekday', 'grow.retro.hour', 'skills.ai.enabled', 'skills.ai.maxPerDeptWeek', 'skills.ai.maxPerWeek',
  // LEARN-1 (LL-C9): the incident log, the incident-retro threshold and the seed switch are the owner's; psql only.
  'grow.incidents.enabled', 'grow.retro.incidentThreshold', 'skills.seed.enabled',
  // SPEND-1 (Gate 1 S1): department budgets and the alert settings are the owner's; a model can neither lift a cap nor silence an alert.
  // REROUTE-1 (RR-C20): turning mention rerouting on or off is the owner's call; no model-reachable path writes it.
  'reroute.enabled',
  // ASKBACK-1 (AB10): whether a bot may ask its requester a question, how long it waits and the question caps are the owner's; no model-reachable path writes them.
  'ask.enabled', 'ask.timeoutHours', 'ask.perRoot', 'ask.perDay',
  // CLICKUP-ALL-1 (C11): how many ClickUp writes a day and which lists the poller watches are the owner's; no model-reachable path (no AdminOp, no config_propose) writes them.
  'clickup.writesPerDay', 'clickup.pollListIds',
  'spend.deptMonthlyUsd', 'spend.warnPct', 'spend.anomalyMultiplier', 'spend.anomalyMinUsd', 'spend.alertsEnabled', 'spend.weeklySummary', 'spend.weeklySummaryTime', 'spend.overrideStepPct', 'spend.retentionDays',
];

const NEVER: readonly ConfigKey[] = ['halted'];

export const ADMIN_CONFIG_KEYS: readonly ConfigKey[] = (Object.keys(ConfigSchema) as ConfigKey[]).filter((k) => !NEVER.includes(k) && !HANDLER_KEYS.includes(k));

/**
 * What `config_get` may read: the writable keys plus the handler-guarded ones (an admin must see a list to edit it). ConfigSchema holds no
 * secrets (tokens and API keys live in env and the encrypted provider_keys table, which this never touches; C13). `halted` is excluded.
 */
export const ADMIN_READ_KEYS: readonly ConfigKey[] = [...ADMIN_CONFIG_KEYS, ...HANDLER_KEYS];

export const isAdminConfigKey = (k: string): k is ConfigKey => (ADMIN_CONFIG_KEYS as readonly string[]).includes(k);
export const isAdminReadKey = (k: string): k is ConfigKey => (ADMIN_READ_KEYS as readonly string[]).includes(k);

type Price = { inPerMTok: number; outPerMTok: number; cacheReadPerMTok?: number | undefined };

/** A lower price raises effective spend (the budget guard multiplies tokens by price), so any decrease is flagged (C1). */
function priceDecreased(old: Record<string, Price>, neu: Record<string, Price>): boolean {
  for (const [model, o] of Object.entries(old)) {
    const n = neu[model];
    if (!n) continue; // a removed entry stops the model being selectable; not a spend risk
    if (n.inPerMTok < o.inPerMTok || n.outPerMTok < o.outPerMTok) return true;
    if (o.cacheReadPerMTok !== undefined && (n.cacheReadPerMTok ?? 0) < o.cacheReadPerMTok) return true;
  }
  return false;
}

const asMap = (o: unknown): Record<string, number> => (o && typeof o === 'object' ? (o as Record<string, number>) : {});

/** SPEND-1 S19: a spend.* change that loosens control (a cap raised or cleared, a threshold raised, an alert switched off, retention shortened). */
export function spendRisk(key: string, old: unknown, neu: unknown): boolean {
  if (key === 'spend.deptMonthlyUsd') {
    const o = asMap(old);
    const n = asMap(neu);
    return Object.entries(o).some(([d, v]) => !Object.hasOwn(n, d) || n[d]! > v); // a cap raised or cleared; a new cap is tightening
  }
  if (key === 'spend.alertsEnabled' || key === 'spend.weeklySummary') return old === true && neu === false;
  if (key === 'spend.retentionDays') return typeof old === 'number' && typeof neu === 'number' && neu < old;
  if (key === 'spend.weeklySummaryTime') return false;
  return typeof old === 'number' && typeof neu === 'number' && neu > old; // warnPct, anomalyMultiplier, anomalyMinUsd, overrideStepPct
}

/** `⚠` for a config_propose item: spend or reach goes up (spec: budgets, approval threshold, limits raised; pricing lowered; ports opened). */
export function configRisk(key: ConfigKey, old: unknown, neu: unknown): boolean {
  if (key === 'mcp.enabled') return old === false && neu === true; // R6: outside programs on is a card
  if (key === 'forge.enabled') return old === false && neu === true; // R7: bots building their own tools on is a card
  if (key === 'provider.fallback.enabled') return old === false && neu === true; // R8: metered API spend during a quota hold on is a card
  if (key === 'limits.localUnlimited') return old === false && neu === true; // WS9: turning the local lift on is a card
  if (key === 'schedule.timezone') return old !== neu; // SPEND-1 SP-09: a new zone moves the department month and the rollup day
  if (key.startsWith('spend.')) return spendRisk(key, old, neu);
  if (key === 'net.extraPorts' || key.startsWith('roles.') || key.startsWith('approvals.')) return true; // WS7/WS8: where approval cards land is high risk // T10: tier roles and the mod room are always high risk
  if (key === 'duties.byDept') return JSON.stringify(old) !== JSON.stringify(neu); // RF36: duties carry tools; moving one grants capabilities, so any change is high risk
  if (key.startsWith('media.') && key !== 'media.ytHostAllowlist') { // RF28: a lowered media price or a raised media cap
    if (typeof old !== 'number' || typeof neu !== 'number') return false;
    return /^media\.(image|video)\./.test(key) ? neu < old : neu > old; // prices: lowered is risk; caps: raised is risk
  }
  if (key === 'pricing') return priceDecreased(old as Record<string, Price>, neu as Record<string, Price>);
  const raised = typeof old === 'number' && typeof neu === 'number' && neu > old;
  if (key.startsWith('budget.') || key === 'approval.thresholdUsd' || key.startsWith('limits.')) return raised;
  if (key.startsWith('warroom.') || key === 'meetings.adHocPerDay') return raised; // more bot-to-bot spend or more meetings
  if (key === 'meetings.weekly') return Array.isArray(old) && Array.isArray(neu) && neu.length > old.length;
  if (key === 'lessons.promptChars' || key === 'approval.expiryHours') return raised;
  return false;
}

export const defaultOf = (k: ConfigKey): unknown => CONFIG_DEFAULTS[k];

/**
 * Gate 1 WS9: `/settings set` writes a key directly unless this is true; then it makes a card (the console path, with the LW Admin second
 * confirmation where one exists). `roles.*`, `approvals.*`, `net.extraPorts`, `pricing`, the provider/model keys, and `limits.localUnlimited` false -> true.
 */
export function requiresCard(key: ConfigKey, old: unknown, neu: unknown): boolean {
  if (key.startsWith('roles.') || key.startsWith('approvals.') || (key.startsWith('media.') && key !== 'media.ytHostAllowlist') || key === 'net.extraPorts' || key === 'pricing' || key === 'provider.default') return true;
  // G2WS-02 (Gate 1 WS3): raising the stall threshold loosens the only automatic bound on local bot talk, so it is a card, never a direct set.
  if (key === 'warroom.stallTurns') return typeof old === 'number' && typeof neu === 'number' && neu > old;
  return key === 'limits.localUnlimited' && old === false && neu === true;
}
