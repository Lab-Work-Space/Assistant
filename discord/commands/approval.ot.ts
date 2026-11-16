import type { OpenDay, OtDecideError } from '../../governance/spend/ot.js';
import { applyPlan, isError, planWorkday } from './plans.js';
import { CONFIG_CHANNEL_ID, ephemeral, type CommandDeps, type Handler, type InteractionLike, type Reply } from './types.js';

/** OT-1: fixed replies (the spec's error table). Nothing here echoes the custom id or any stored text. */
const OT_ERRORS: Record<Exclude<OtDecideError, 'day_failed'>, string> = {
  not_found: 'That button does not belong to this card.',
  wrong_card: 'That button does not belong to this card.',
  not_pending: 'Already decided.',
  expired: 'The day this request was for has ended.',
  halted: 'The company is halted; approve after /resume.',
  halted_after_commit: 'Approved, but a halt landed; OT was revoked.',
  root_ended: 'The task tree has ended.',
  moot: 'Today is already a workday.',
  disabled: 'OT requests are switched off.',
  ended: 'Already ended.',
};
const errorText = (e: OtDecideError): string => OT_ERRORS[e === 'day_failed' ? 'wrong_card' : e];

/** The whole-day path (OT-C6): the same plan and audit as `/holiday workday <date>`, for the request's own day. "Already a workday" is success. */
const openDayWith = (deps: CommandDeps): OpenDay => async (date, userId) => {
  const p = planWorkday(date, false, deps);
  if (isError(p)) return { ok: false, error: p.error, already: /already a workday/.test(p.error) };
  await applyPlan(p, userId, deps);
  return { ok: true };
};

/**
 * `approval:ot:<id>:<digest>:approve|deny|day|revoke`. decide() in index.ts already checked the guild and this click's live Bot Admin role; the
 * service then checks the STORED card (channel and message), the digest and the status, so a button in a category approvals room (WS7), a forged id
 * or a copied digest changes nothing. A null message or channel is refused here, before any lookup (OT-C16).
 */
export async function otButton(i: InteractionLike, deps: CommandDeps, c: { id: number; digest: string; action: 'approve' | 'deny' | 'day' | 'revoke' }): Promise<Reply> {
  if (!deps.ot) return ephemeral('Unknown action.');
  if (!i.messageId || !i.channelId) return ephemeral(OT_ERRORS.wrong_card);
  const click = { id: c.id, digest: c.digest, userId: i.userId, channelId: i.channelId, messageId: i.messageId };
  try {
    if (c.action === 'day') {
      const r = await deps.ot.decideDay(click, openDayWith(deps));
      if (!r.ok) {
        if (r.error === 'day_failed') return ephemeral(`The workday could not be opened: ${r.text ?? 'use /holiday workday'}`);
        return ephemeral(r.error === 'wrong_card' && i.channelId !== CONFIG_CHANNEL_ID ? 'Use this in #⚙️-setting.' : errorText(r.error));
      }
      // OT-C17: the reply says it opens everything, not only this task tree
      return ephemeral('Today is now a workday for ALL held work (every task tree, schedules, watches and bot talk), not only this task tree. Held work starts within a minute.');
    }
    if (c.action === 'revoke') {
      const r = await deps.ot.revoke(click);
      return ephemeral(r.ok ? 'OT revoked. A run already started finishes; /halt aborts it.' : errorText(r.error));
    }
    const r = await deps.ot.decide({ ...click, action: c.action });
    if (!r.ok) return ephemeral(errorText(r.error));
    if (c.action === 'deny') return ephemeral('OT request denied. The work starts on the next workday.');
    return ephemeral(`OT approved for this task tree: up to ${r.row.maxRuns} runs and $${(r.row.maxUsd ?? 0).toFixed(2)} until <t:${Math.floor(r.row.grantExpiresAt!.getTime() / 1000)}:t>. Held work starts now.`);
  } catch (err) {
    deps.log.error({ errName: err instanceof Error ? err.name : 'error' }, 'overtime decision failed');
    return ephemeral('That could not be done now; nothing was changed.');
  }
}

export type { Handler };
