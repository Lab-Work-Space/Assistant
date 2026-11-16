import { applyPlan, isError, planChannelMap, planChannelUnmap, refusal } from './plans.js';
import type { Handler } from './types.js';

export const channelMap: Handler = async (i, deps) => {
  const p = await planChannelMap(i.options.channel('channel'), i.options.string('dept') ?? '', i.options.boolean('work') ?? false, deps);
  if (isError(p)) return refusal(p);
  return applyPlan(p, i.userId, deps);
};

export const channelUnmap: Handler = async (i, deps) => {
  const p = await planChannelUnmap(i.options.channel('channel'), deps);
  if (isError(p)) return refusal(p);
  return applyPlan(p, i.userId, deps);
};
