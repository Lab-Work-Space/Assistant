import { applyPlan, isError, planClickupChannel, planClickupWatch, refusal } from './plans.js';
import type { Handler } from './types.js';

/**
 * `/clickup channel [channel]` (Task 31): where the ClickUp poller posts notices (`clickup.notifyChannelId`). No channel clears it
 * (Praw's mapped work channel is used then). Bot Admin in #⚙️-setting only (decide()); the value goes through ConfigStore.set
 * (validated, versioned, notified) and is audited. Takes effect without a restart.
 */
export const clickupChannel: Handler = async (i, deps) => {
  const p = planClickupChannel(i.options.channel('channel'), deps);
  return isError(p) ? refusal(p) : applyPlan(p, i.userId, deps);
};

/**
 * `/clickup watch list_id action` (CLICKUP-ALL-1, C11): which lists the poller watches in workspace mode (`clickup.pollListIds`, at most 10).
 * Bot Admin in #⚙️-setting only (decide(), like /clickup channel); add checks the list is in the workspace; every outcome is audited.
 */
export const clickupWatch: Handler = async (i, deps) => {
  const action = i.options.string('action') ?? '';
  const p = await planClickupWatch(i.options.string('list_id') ?? '', action, deps);
  if (!isError(p)) return applyPlan(p, i.userId, deps);
  if (p.audit) await deps.audit({ actor: `user:${i.userId}`, action: 'clickup.watch', tool: p.audit.tool, outcome: p.audit.outcome });
  return refusal(p);
};
