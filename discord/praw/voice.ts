import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { JOIN_NOTICE, OPT_IN_PREFIX } from '../../voice/chat/index.js';
import { ephemeral, type InteractionLike, type Reply } from '../commands/types.js';
import type { Handler } from './commands.js';
import type { PrawCommandDeps } from './context.js';

const NO_PING = { parse: [] } as { parse: [] };
const UNAVAILABLE = 'Voice chat is not available right now.';
const NONCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The opt-in button: its custom id carries the session nonce, so a button from an earlier session opts nobody in. */
const optInRow = (nonce: string) =>
  new ActionRowBuilder<ButtonBuilder>()
    .addComponents(new ButtonBuilder().setCustomId(`${OPT_IN_PREFIX}${nonce}`).setLabel('ให้พราวฟังเสียงฉันด้วย (opt in)').setStyle(ButtonStyle.Primary))
    .toJSON();

/**
 * `/voice join` (P20): joins only the invoker's own voice channel (never a denied one), posts the notice publicly in this text
 * channel with the opt-in button. `/voice leave` works from anywhere, for anyone, like /stop. Both are audited without content;
 * the guard already dropped bots, other guilds and denied channels and took one Praw rate-limit slot.
 */
export const voiceCmd: Handler = {
  subs: true,
  privateRefusals: true,
  async run(i, deps) {
    const chat = deps.voiceChat;
    if (!chat) return ephemeral(UNAVAILABLE);
    if (i.subcommand === 'leave') {
      const r = await chat.leave();
      await deps.audit({ actor: `user:${i.userId}`, action: 'voice.leave', outcome: r.ok ? 'ok' : 'refused' });
      return r.ok ? { content: r.text, ephemeral: false, allowedMentions: NO_PING } : ephemeral(r.text);
    }
    if (i.subcommand !== 'join') return ephemeral('Unknown command.');
    const r = await chat.join({ userId: i.userId, channelId: i.channelId ?? '', parentChannelId: i.parentChannelId ?? null });
    await deps.audit({ actor: `user:${i.userId}`, action: 'voice.join', outcome: r.ok ? 'ok' : 'refused' });
    if (!r.ok) return ephemeral(r.text);
    return { content: `${JOIN_NOTICE}\n<#${r.channelId}>`, components: [optInRow(r.nonce)], ephemeral: false, allowedMentions: NO_PING };
  },
};

export const isVoiceButton = (i: InteractionLike): boolean => i.isButton() && i.customId.startsWith(OPT_IN_PREFIX);

/** The opt-in button press: answered to the presser alone. No model call and no rate-limit slot (it only adds them to a set). */
export async function voiceButton(i: InteractionLike, deps: PrawCommandDeps): Promise<Reply> {
  const nonce = i.customId.slice(OPT_IN_PREFIX.length);
  const text = !deps.voiceChat ? UNAVAILABLE : NONCE.test(nonce) ? await deps.voiceChat.optIn(nonce, i.userId) : 'This voice session has ended.';
  const r = ephemeral(text);
  await i.reply(r);
  return r;
}
