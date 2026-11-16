import { CapError } from '../../db/repos/praw.js';
import { capMessage, describeWatch, planWatch } from '../../tools/plugins/watch/index.js';
import { ephemeral, type InteractionLike } from '../commands/types.js';
import type { Handler } from './commands.js';
import { prawListReply } from './context.js';

/**
 * `/watch add|list|remove`. The owner is the invoker, from the interaction (P14). The same planWatch as the tool: interval 15 or
 * more, and a url must pass the SSRF check now. Replies are ephemeral. A Bot Admin may remove any watch (audited).
 */
export const watchCmd: Handler = {
  subs: true,
  ephemeral: true,
  check(i: InteractionLike) {
    if (i.subcommand === 'add' && !(i.options.string('target')?.trim())) return ephemeral('Tell me what to watch.');
    return null;
  },
  async run(i, deps) {
    const repo = deps.watches;
    if (!repo || !deps.watchNet) return ephemeral('Watches are not available right now.');
    if (i.subcommand === 'add') {
      const plan = await planWatch({ kind: i.options.string('kind') ?? '', target: i.options.string('target') ?? '', intervalMinutes: i.options.integer('every') ?? 0 }, deps.watchNet);
      if ('error' in plan || !i.channelId) return ephemeral('error' in plan ? `Could not save that watch: ${plan.error}.` : 'Not available here.');
      try {
        const w = await repo.add({ guildId: deps.guildId, channelId: i.parentChannelId ?? i.channelId, userId: i.userId, ...plan },
          { perUser: deps.cfg.get('limits.watchesPerUser'), total: deps.cfg.get('limits.watchesTotal') });
        return ephemeral(w ? `Watch #${w.id} saved; the first check is the baseline and posts nothing.` : 'Could not save that watch.');
      } catch (err) {
        if (err instanceof CapError) return ephemeral(capMessage(err));
        throw err;
      }
    }
    if (i.subcommand === 'list') {
      const rows = await repo.list(i.userId);
      return prawListReply(rows.length ? rows.map(describeWatch).join('\n') : 'You have no watches.');
    }
    const id = i.options.integer('id') ?? 0;
    if (await repo.remove(id, i.userId)) return ephemeral(`Watch #${id} removed.`);
    if (deps.isBotAdmin(i) && (await repo.removeAny(id))) {
      await deps.audit({ actor: `user:${i.userId}`, action: 'watch.remove_any', tool: String(id), outcome: 'ok' });
      return ephemeral(`Watch #${id} removed (admin).`);
    }
    return ephemeral(`No watch #${id} of yours.`);
  },
};
