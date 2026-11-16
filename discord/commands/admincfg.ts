import { ADMIN_CARD_ID } from '../embeds/approval.js';
import { ephemeral, type Handler } from './types.js';

/**
 * `admincfg:<cardId>:confirm|cancel` (Gate 1 C4-C7). The guard (decide) already checked guild, channel and the Bot Admin role of this click;
 * the console checks them again with the click payload and then the card itself: proposer, message, newest, unexpired, single use.
 * The custom id carries only the opaque card id: the ops come from the stored row.
 */
export const adminCardButton: Handler = async (i, deps) => {
  const m = ADMIN_CARD_ID.exec(i.customId);
  if (!m || !deps.admin) return ephemeral('Unknown action.');
  return deps.admin.click({
    cardId: m[1]!, action: m[2] as 'confirm' | 'cancel', guildId: i.guildId, channelId: i.channelId, userId: i.userId,
    memberRoleIds: i.memberRoleIds, messageId: i.messageId ?? null, messageAuthorId: i.messageAuthorId ?? null,
  });
};
