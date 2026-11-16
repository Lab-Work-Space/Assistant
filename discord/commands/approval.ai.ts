import { ephemeral, type Handler } from './types.js';

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');

/**
 * AI-APPROVE-1 (AA-C18): `/approval ai action:pause|resume`. Reached only through index.ts `decide()` (guild, channel, live Bot Admin role).
 * The state is an audit row (`approval.ai.pause|resume`, actor `user:<id>`); the newest row of the day in schedule.timezone wins.
 */
export const approvalAi: Handler = async (i, deps) => {
  const action = i.options.string('action');
  if (action !== 'pause' && action !== 'resume') return ephemeral('Unknown action.');
  const repo = deps.aiApprover;
  if (!repo) return ephemeral('AI approvals are not available in this process.');
  const tz = deps.cfg.get('schedule.timezone');
  const fail = (err: unknown): ReturnType<typeof ephemeral> => {
    deps.log.error({ errName: errName(err) }, 'ai approval pause failed');
    return ephemeral('Nothing changed: the pause could not be saved.');
  };
  let paused: boolean;
  try {
    paused = await repo.pausedToday(tz);
  } catch (err) {
    return fail(err);
  }
  const on = action === 'pause';
  if (paused === on) return ephemeral('No change.');
  try {
    await repo.setPause(i.userId, on);
  } catch (err) {
    return fail(err);
  }
  return ephemeral(on ? `AI approvals are paused until midnight (${tz}).` : 'AI approvals are on again.');
};
