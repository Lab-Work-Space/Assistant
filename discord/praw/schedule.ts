import { CapError } from '../../db/repos/praw.js';
import { capMessage, describeJob, PROMPT_MAX } from '../../tools/plugins/schedule/index.js';
import { planJob } from '../../tools/plugins/schedule/time.js';
import { ephemeral, type InteractionLike } from '../commands/types.js';
import type { Handler } from './commands.js';
import { prawListReply } from './context.js';

const promptOf = (i: InteractionLike) => (i.options.string('prompt') ?? '').trim();

/**
 * `/schedule add|list|remove`. The owner is the invoker, from the interaction (P14). Exactly one of `daily` (HH:MM), `every`
 * (minutes, 15 or more) or `at` (ISO date-time) picks the kind. Replies are ephemeral. A Bot Admin may remove any job (audited).
 */
export const scheduleCmd: Handler = {
  subs: true,
  ephemeral: true,
  check(i: InteractionLike) {
    if (i.subcommand !== 'add') return null;
    if (!promptOf(i)) return ephemeral('Tell me what to run.');
    const given = [i.options.string('daily'), i.options.integer('every'), i.options.string('at')].filter((v) => v !== null && v !== undefined).length;
    return given === 1 ? null : ephemeral('Give exactly one of daily, every or at.');
  },
  async run(i, deps) {
    if (i.subcommand === 'add') {
      const daily = i.options.string('daily'), every = i.options.integer('every'), at = i.options.string('at');
      const plan = planJob(
        daily != null ? { kind: 'daily', hhmm: daily.trim() } : every != null ? { kind: 'interval', intervalMinutes: every } : { kind: 'once', at: (at ?? '').trim() },
        deps.clock(), deps.cfg.get('schedule.timezone'));
      if ('error' in plan || !i.channelId) return ephemeral('error' in plan ? `Could not save that schedule: ${plan.error}.` : 'Not available here.');
      try {
        const j = await deps.schedules.add({
          guildId: deps.guildId, channelId: i.parentChannelId ?? i.channelId, userId: i.userId, prompt: promptOf(i).slice(0, PROMPT_MAX), origin: 'schedule', ...plan,
        }, { perUser: deps.cfg.get('limits.schedulesPerUser'), total: deps.cfg.get('limits.schedulesTotal') });
        return ephemeral(j ? `Schedule #${j.id} saved; first run ${plan.nextRunAt.toISOString()}.` : 'Could not save that schedule.');
      } catch (err) {
        if (err instanceof CapError) return ephemeral(capMessage(err));
        throw err;
      }
    }
    if (i.subcommand === 'list') {
      const rows = await deps.schedules.list(i.userId);
      return prawListReply(rows.length ? rows.map(describeJob).join('\n') : 'You have no scheduled jobs.');
    }
    const id = i.options.integer('id') ?? 0;
    if (await deps.schedules.remove(id, i.userId)) return ephemeral(`Schedule #${id} removed.`);
    if (deps.isBotAdmin(i) && (await deps.schedules.removeAny(id))) {
      await deps.audit({ actor: `user:${i.userId}`, action: 'schedule.remove_any', tool: String(id), outcome: 'ok' });
      return ephemeral(`Schedule #${id} removed (admin).`);
    }
    return ephemeral(`No schedule #${id} of yours.`);
  },
};
