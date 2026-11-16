import { applyPlan, isError, planGithubAllow, refusal } from './plans.js';
import type { Handler } from './types.js';


/**
 * `/github allow action:add|remove repo:<owner/repo>` (Task 30, P6): the write allowlist. Add resolves the repository through the API
 * (id + canonical full_name), requires the installation account as owner and refuses anything on the hard denylist, then stores
 * `{id, fullName}`. Remove prefers the id (renamed repos) and works without the API (deleted repos). Bot Admin in #⚙️-setting only (decide()); audited.
 */
export const githubAllow: Handler = async (i, deps) => {
  const action = i.options.string('action') ?? '';
  const p = await planGithubAllow(action, i.options.string('repo') ?? '', deps);
  if (!isError(p)) return applyPlan(p, i.userId, deps);
  if (p.audit) await deps.audit({ actor: `user:${i.userId}`, action: `github.allow.${action}`, tool: p.audit.tool, outcome: p.audit.outcome });
  return refusal(p);
};
