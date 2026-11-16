import { TOOL_REQUEST_ID } from '../embeds/approval.js';
import { ephemeral, type Handler } from './types.js';

/**
 * `toolreq:<token>:approve|reject` (GROW-1, Gate 1 GW-C17, C19). decide() already checked the guild, #⚙️-setting and this click's live Bot Admin role, and route()
 * sends only this exact id shape here. ToolRequestService.decide() then checks the stored card (channel and message id), the row's status and expiry, re-runs
 * rule G, and does the one conditional claim: one click wins. It also closes the card and tells the head. The custom id carries a random token and no tool name.
 */
export const toolRequestButton: Handler = async (i, deps) => {
  const m = TOOL_REQUEST_ID.exec(i.customId);
  if (!m || !deps.grow) return ephemeral('Unknown action.');
  const action = m[2] as 'approve' | 'reject';
  const r = await deps.grow.requests.decide({ token: m[1]!, action, userId: i.userId, channelId: i.channelId, messageId: i.messageId ?? null });
  if (!r.ok) return ephemeral(r.text);
  return ephemeral(action === 'reject' ? 'Rejected. Nothing changed.' : `Approved: ${r.row.deptId} may use ${r.row.tool} from its next run.`);
};
