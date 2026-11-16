import type { ConfigKey } from '../../config/schema.js';
import { applyPlan, BUDGET_SCOPES, isError, planDeptBudget, planNumber, refusal } from './plans.js';
import { configReply, ephemeral, type CommandDeps, type Handler, type Reply } from './types.js';

/** Writes one numeric config key; ConfigSchema rejects NaN, +-Infinity, 1e308 and negatives (Gate 1 D4). */
export async function setNumber(key: ConfigKey, value: number | null, by: string, deps: Parameters<Handler>[1]) {
  const p = planNumber(key, value, deps);
  if (isError(p)) return refusal(p);
  return applyPlan(p, by, deps, by); // store errors are logged (masked) and answered generically by handleInteraction
}

export const budgetSet: Handler = (i, deps) => {
  const key = BUDGET_SCOPES[i.options.string('scope') ?? ''];
  return key ? setNumber(key, i.options.number('usd'), i.userId, deps) : Promise.resolve(ephemeral('Unknown scope.'));
};

const usdText = (n: number | undefined): string => (n === undefined || !Number.isFinite(n) ? '(none)' : `$${n.toFixed(2)}`);

/**
 * `/budget dept` and `/settings set spend.deptMonthlyUsd <dept> <usd|none>` (SPEND-1, Gate 1 S8): the same plan. It writes the cap, ends this month's raise overrides
 * (SP-05, audited) and answers with the cap that is enforced now. A raised or cleared cap also posts the settings risk notice.
 */
export async function deptBudget(dept: string, usd: number | null, userId: string, deps: CommandDeps): Promise<Reply> {
  const out = { superseded: 0 };
  const p = planDeptBudget(dept, usd, userId, deps, out);
  if (isError(p)) return refusal(p);
  await applyPlan(p, userId, deps);
  if (p.risk && deps.settings) await deps.settings.notice(`⚠ spend.deptMonthlyUsd for ${dept} was changed by <@${userId}>.`).catch((err: unknown) => deps.log.error({ err: err instanceof Error ? err.name : 'error' }, 'settings risk notice failed'));
  const eff = deps.spend ? await deps.spend.effectiveCap(dept) : usd ?? Infinity;
  const it = p.items[0]!;
  return configReply('Department budget', `**${dept}** monthly cap: ${it.old} → ${it.neu}\nEnforced now: ${usdText(eff)}${out.superseded ? `\nThis month's ${out.superseded} raise override(s) ended.` : ''}`);
}

export const budgetDept: Handler = (i, deps) => {
  const dept = i.options.string('dept') ?? '';
  const clear = i.options.boolean('clear') === true;
  const usd = i.options.number('usd');
  if (clear === (usd !== null)) return Promise.resolve(ephemeral('Give usd or clear:true, not both and not neither.'));
  return deptBudget(dept, clear ? null : usd, i.userId, deps);
};
