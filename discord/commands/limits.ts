import { LIMIT_KEYS } from './plans.js';
import { setNumber } from './budget.js';
import { ephemeral, type Handler } from './types.js';

export { LIMIT_KEYS };

export const limitsSet: Handler = (i, deps) => {
  const key = LIMIT_KEYS[i.options.string('limit') ?? ''];
  return key ? setNumber(key, i.options.integer('value'), i.userId, deps) : Promise.resolve(ephemeral('Unknown limit.'));
};

export const approvalSet: Handler = (i, deps) => setNumber('approval.thresholdUsd', i.options.number('usd'), i.userId, deps);
