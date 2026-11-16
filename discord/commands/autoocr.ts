import { applyPlan, isError, planAutoOcr, refusal } from './plans.js';
import type { Handler } from './types.js';

/**
 * `/autoocr channel [channel]` (Task 34): the channel whose image posts Praw reads automatically (`ocr.autoChannelId`). No channel
 * switches it off. The channel must also be mapped to Praw (`/channel map`); otherwise the scheduler does nothing and alerts once.
 * Named apart from Praw's own `/ocr` so the two applications' commands never share a name. Bot Admin in #setting only (decide());
 * the value goes through ConfigStore.set (validated, versioned) and is audited. Takes effect without a restart.
 */
export const autoOcrChannel: Handler = async (i, deps) => {
  const p = planAutoOcr(i.options.channel('channel'), deps);
  return isError(p) ? refusal(p) : applyPlan(p, i.userId, deps);
};
