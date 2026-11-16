import { CapError } from '../../db/repos/praw.js';
import { capMessage, describeReminder, planReminder } from '../../tools/plugins/reminders/index.js';
import { ephemeral, type InteractionLike } from '../commands/types.js';
import type { Handler } from './commands.js';
import { prawListReply } from './context.js';

/**
 * `/remind add|list|cancel`. The owner is the invoker, from the interaction (P14). Replies are ephemeral (the guard defers
 * ephemerally for this command). A Bot Admin may cancel any reminder; that is audited.
 */
export const remindCmd: Handler = {
  subs: true,
  ephemeral: true,
  check(i: InteractionLike) {
    if (i.subcommand === 'add' && !(i.options.string('text')?.trim())) return ephemeral('Tell me what to remind you about.');
    return null;
  },
  async run(i, deps) {
    if (i.subcommand === 'add') {
      const plan = planReminder({
        text: i.options.string('text') ?? '',
        when: { inMinutes: i.options.integer('minutes') ?? 0 },
        everyMinutes: i.options.integer('every') ?? undefined,
        advanceMinutes: i.options.integer('advance') ?? undefined,
        notifyVia: i.options.boolean('dm') ? 'dm' : 'channel',
      }, deps.clock(), deps.cfg.get('schedule.timezone'));
      if ('error' in plan || !i.channelId) return ephemeral('error' in plan ? `Could not set that reminder: ${plan.error}.` : 'Not available here.');
      try {
        const r = await deps.reminders.add({ guildId: deps.guildId, channelId: i.channelId, userId: i.userId, text: (i.options.string('text') ?? '').trim().slice(0, 500), ...plan },
          { perUser: deps.cfg.get('limits.remindersPerUser'), total: deps.cfg.get('limits.remindersTotal') });
        return ephemeral(r ? `Reminder #${r.id} set for ${plan.remindAt.toISOString()}.` : 'Could not save that reminder.');
      } catch (err) {
        if (err instanceof CapError) return ephemeral(capMessage(err));
        throw err;
      }
    }
    if (i.subcommand === 'list') {
      const rows = await deps.reminders.list(i.userId);
      return prawListReply(rows.length ? rows.map(describeReminder).join('\n') : 'You have no pending reminders.');
    }
    const id = i.options.integer('id') ?? 0;
    if (await deps.reminders.cancel(id, i.userId)) return ephemeral(`Reminder #${id} cancelled.`);
    if (deps.isBotAdmin(i) && (await deps.reminders.cancelAny(id))) {
      await deps.audit({ actor: `user:${i.userId}`, action: 'remind.cancel_any', tool: String(id), outcome: 'ok' });
      return ephemeral(`Reminder #${id} cancelled (admin).`);
    }
    return ephemeral(`No reminder #${id} of yours.`);
  },
};
