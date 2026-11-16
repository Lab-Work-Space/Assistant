import { escapeMarkdown } from 'discord.js';
import { ephemeral, type InteractionLike, type Reply } from '../commands/types.js';
import type { Handler } from './commands.js';
import type { PrawCommandDeps } from './context.js';

const NO_PING = { parse: [] } as { parse: [] };
const UNAVAILABLE = 'Music is not available right now.';

/**
 * Music replies are public (others in the channel hear it too), except refusals and the queue listing (P15). The text carries the
 * invoker's own request, so markdown is escaped (no formatting or masked links from a query); mentions never ping.
 */
const publicReply = (text: string): Reply => ({ content: escapeMarkdown(text).slice(0, 2000), ephemeral: false, allowedMentions: NO_PING });

/**
 * `/play`, `/skip`, `/queue`, `/stop`, `/volume` (Task 36): run straight on Praw's music player, never through the model. They pass
 * the Praw guard first (bots and other guilds dropped, denylist, one rate-limit slot per interaction). The requester is the
 * invoker (P14): `/play` needs them in a voice channel. Each change is audited without the query text.
 */
function musicCmd(action: 'play' | 'skip' | 'stop' | 'volume', run: (i: InteractionLike, m: NonNullable<PrawCommandDeps['music']>) => Promise<{ ok: boolean; text: string }>, check?: Handler['check']): Handler {
  return {
    privateRefusals: true, // a refusal after the public defer goes to the invoker alone (ephemeral follow-up)
    ...(check ? { check } : {}),
    async run(i, deps) {
      if (!deps.music) return ephemeral(UNAVAILABLE);
      const r = await run(i, deps.music);
      await deps.audit({ actor: `user:${i.userId}`, action: `music.${action}`, outcome: r.ok ? 'ok' : 'refused' });
      return r.ok ? publicReply(r.text) : ephemeral(r.text);
    },
  };
}

export const playCmd = musicCmd('play', (i, m) => m.play(i.userId, i.options.string('query') ?? ''),
  (i) => ((i.options.string('query') ?? '').trim() ? null : ephemeral('Tell me what to play (a song name or a YouTube link).')));
export const skipCmd = musicCmd('skip', (_i, m) => m.skip());
export const stopCmd = musicCmd('stop', (_i, m) => m.stop());
export const volumeCmd = musicCmd('volume', (i, m) => m.setVolume(i.options.integer('percent') ?? -1));

export const queueCmd: Handler = {
  ephemeral: true,
  async run(_i, deps) {
    return ephemeral((deps.music ? deps.music.list().text : UNAVAILABLE).slice(0, 2000));
  },
};
