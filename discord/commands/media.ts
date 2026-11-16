import { applyPlan, isError, planMediaAllowlist, refusal } from './plans.js';
import type { Handler } from './types.js';

/**
 * `/media allowlist action:add|remove host:<name>` (Task 38): edits `media.ytHostAllowlist`, the exact hosts a music link may name (P7).
 * Bot Admin in #setting only (decide()); the new list goes through ConfigStore.set (schema: lower-case host names, no IP literals, 1 to
 * 20 entries; versioned, live without a restart) and is audited. A stored list replaces the default, so this is how a deployment that
 * stored its own list gets a host added later (for example m.youtube.com).
 */
export const mediaAllowlist: Handler = async (i, deps) => {
  const p = planMediaAllowlist(i.options.string('action'), i.options.string('host'), deps);
  return isError(p) ? refusal(p) : applyPlan(p, i.userId, deps);
};
