import { SPEND_OVERRIDE_ID } from '../embeds/approval.js';
import { ephemeral, type Handler } from './types.js';

/**
 * `spendovr:<id>:approve|reject` (SPEND-1, Gate 1 S2). decide() already checked the guild, #⚙️-setting and this click's live Bot Admin role, and route()
 * sends only this exact id shape here. SpendOverrides.decide() then checks the stored card (its message id and channel) and runs the single conditional
 * UPDATE: one click wins, an expired or already decided card changes nothing. The custom id carries a random token and no amount.
 */
export const spendOverrideButton: Handler = async (i, deps) => {
  const m = SPEND_OVERRIDE_ID.exec(i.customId);
  if (!m || !deps.spend) return ephemeral('Unknown action.');
  const action = m[2] as 'approve' | 'reject';
  const r = await deps.spend.decide({ id: m[1]!, action, userId: i.userId, channelId: i.channelId, messageId: i.messageId ?? null });
  if (!r.ok) return ephemeral(r.text);
  const row = r.row;
  const month = row.month.slice(0, 7);
  const note = action === 'approve'
    ? `Approved by <@${i.userId}>: the cap of ${row.deptId} for ${month} is raised from $${row.oldCapUsd.toFixed(2)} to $${row.newCapUsd.toFixed(2)}. It falls back at month end.`
    : `Rejected by <@${i.userId}>: the cap of ${row.deptId} for ${month} stays at $${row.oldCapUsd.toFixed(2)}.`;
  if (deps.cards && i.channelId && i.messageId) await deps.cards.close(i.channelId, i.messageId, note).catch((err: unknown) => deps.log.error({ err: err instanceof Error ? err.name : 'error' }, 'spend card close failed'));
  return ephemeral(action === 'approve' ? `Raised: ${row.deptId} may spend up to $${row.newCapUsd.toFixed(2)} in ${month}.` : 'Rejected. No new raise card will be made for this department this month.');
};
